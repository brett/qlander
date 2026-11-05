// Lifecycle event hooks (docs/hooks.md). The pure layer (machine.ts, ops.ts)
// emits typed LifecycleEvents for what happened to the queue; it does not know
// which hooks exist. The runner turns each event into one delivery per
// subscribed hook, in the same state write as the transition that produced it
// (enqueueHooks), and sends the deliveries as `repository_dispatch` events to
// the target repo at the end of the tick (deliverHooks).
//
// Hooks are notifications only. They are not policy: they are not part of
// Config, so they never change the policy hash, and nothing about admission
// or landing waits on them. A delivery failure is recorded in state (and so in
// the status issue) and never thrown out of the tick.
//
// Delivery is at least once. A delivery is removed from state, and its id
// remembered, only after GitHub accepts it, so a tick that dies in between
// sends it again; receivers dedupe by idempotencyKey.

import type { TargetApi } from "./github/api";
import { GitHubError } from "./github/http";
import type { FailedJob } from "./types";

export const HOOK_EVENTS = ["admitted", "dequeued", "batch_started", "landed", "bounced", "flaky", "approval_needed", "budget_warning"] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** One configured hook: which events, dispatched as which repository_dispatch event_type. */
export interface Hook {
  events: HookEventName[];
  eventType: string;
}

export interface HookPr {
  number: number;
  /** The head SHA qlander tested (the pin). */
  head: string;
  /** landed only: the main commit the PR landed in. */
  mergeSha?: string;
  /** The PR author's login, when qlander recorded it. */
  author?: string;
}

export interface HookBatch {
  n: number;
  /** The main commit the batch was built on. */
  base: string;
  /** The queue/<n> commit CI tested (for landed, the commit main now points at). */
  head: string;
  depth: number;
}

/** What the pure layer emits. `key` is stable for the event: re-emitting the same event gives the same key. */
export interface LifecycleEvent {
  event: HookEventName;
  key: string;
  at: string;
  batch: HookBatch | null;
  prs: HookPr[];
  details: Record<string, unknown>;
}

/** The client_payload of every dispatch: 7 top-level keys (GitHub allows 10). */
export interface ClientPayload {
  v: 1;
  event: HookEventName;
  idempotencyKey: string;
  at: string;
  batch: HookBatch | null;
  prs: HookPr[];
  details: Record<string, unknown>;
}

export interface HookDelivery {
  /** `<eventType>|<idempotencyKey>`: unique per hook and event. */
  id: string;
  eventType: string;
  payload: ClientPayload;
  /** Failed attempts so far. */
  tries: number;
  firstAt: string;
  lastError?: string;
}

export interface HookFailure {
  id: string;
  event: HookEventName;
  eventType: string;
  at: string;
  error: string;
}

/** Optional in State: absent until a hook is configured and an event matches one. */
export interface HooksState {
  outbox: HookDelivery[];
  /** Ids of recently delivered (or given up) deliveries, hashed, newest last: a re-emitted event is not sent again. */
  sent: string[];
  /** The most recent failures, newest last; shown in the status issue. */
  failed: HookFailure[];
}

/** The status issue's budget warning uses the same share (src/watchdog-render.ts). */
export const BUDGET_WARN_SHARE = 0.75;
/** GitHub: event_type is at most 100 characters. */
export const EVENT_TYPE_RE = /^[A-Za-z0-9_.:-]{1,100}$/;
/**
 * One payload is kept under this (GitHub allows a body under 64 KB). Kept far
 * lower so waiting deliveries cannot bloat the state document, which is read
 * through the contents API and mirrored into an issue body (65,536 characters).
 */
export const MAX_PAYLOAD_BYTES = 8_000;
/** All waiting deliveries together stay under this; past it the oldest are dropped and recorded as failed. */
export const OUTBOX_BYTES = 32_000;
export const SENT_LIMIT = 200;
export const FAILED_LIMIT = 20;
/** A delivery that keeps failing transiently is retried on later ticks for this long, then recorded as failed. */
export const GIVE_UP_HOURS = 24;
/** At most this many dispatches per tick. */
export const PER_TICK = 10;
/** No new dispatch starts once delivery has run this long in a tick (each dispatch can take up to the 45 s write timeout). */
export const DELIVERY_BUDGET_MS = 20_000;

const hashId = (id: string) => new Bun.CryptoHasher("sha256").update(id).digest("hex").slice(0, 16);
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x)).length;

/**
 * Fit a payload under MAX_PAYLOAD_BYTES: first the failed-job list is cut,
 * then the details are dropped, then the PR list is cut (details then say how
 * many PRs there were). The receiver sees `details.truncated: true`.
 */
export function fitPayload(p: ClientPayload): ClientPayload {
  if (bytes(p) <= MAX_PAYLOAD_BYTES) return p;
  const jobs = p.details.failedJobs;
  if (Array.isArray(jobs)) {
    let keep = jobs.length;
    while (keep > 0) {
      keep = Math.floor(keep / 2);
      const q = { ...p, details: { ...p.details, failedJobs: jobs.slice(0, keep), truncated: true } };
      if (bytes(q) <= MAX_PAYLOAD_BYTES) return q;
    }
  }
  const bare: ClientPayload = { ...p, details: { truncated: true } };
  if (bytes(bare) <= MAX_PAYLOAD_BYTES) return bare;
  let keep = p.prs.length;
  for (;;) {
    keep = Math.floor(keep / 2);
    const q: ClientPayload = { ...bare, idempotencyKey: p.idempotencyKey.slice(0, 500), prs: p.prs.slice(0, keep), details: { truncated: true, prsTotal: p.prs.length } };
    if (keep === 0 || bytes(q) <= MAX_PAYLOAD_BYTES) return q;
  }
}

const record = <T>(list: T[], item: T, limit: number): T[] => [...list, item].slice(-limit);

/**
 * Pure: add one delivery per (event, subscribed hook) to the hook outbox. An
 * event already pending, recently delivered or recently failed is skipped. No
 * hooks, or no subscriber, leaves the state untouched (no `hooks` key appears).
 */
export function enqueueHooks<S extends { hooks?: HooksState }>(state: S, events: LifecycleEvent[] | undefined, hooks: Hook[] | undefined, now: Date): { state: S; log: string[] } {
  const log: string[] = [];
  if (!events?.length || !hooks?.length) return { state, log };
  let h: HooksState | undefined = state.hooks;
  for (const ev of events) {
    for (const hook of hooks) {
      if (!hook.events.includes(ev.event)) continue;
      const id = `${hook.eventType}|${ev.key}`;
      h ??= { outbox: [], sent: [], failed: [] };
      const hid = hashId(id);
      if (h.outbox.some((d) => d.id === id) || h.sent.includes(hid) || h.failed.some((f) => f.id === id)) continue;
      const payload = fitPayload({ v: 1, event: ev.event, idempotencyKey: ev.key, at: ev.at, batch: ev.batch, prs: ev.prs, details: ev.details });
      let outbox = [...h.outbox, { id, eventType: hook.eventType, payload, tries: 0, firstAt: now.toISOString() }];
      let failed = h.failed;
      // Bounded, so a backlog can never threaten the state document: the queue's state matters more than a notification.
      while (outbox.length > 1 && bytes(outbox) > OUTBOX_BYTES) {
        const dropped = outbox[0]!;
        outbox = outbox.slice(1);
        failed = record(failed, { id: dropped.id, event: dropped.payload.event, eventType: dropped.eventType, at: now.toISOString(), error: `dropped undelivered: the waiting deliveries exceeded ${OUTBOX_BYTES} bytes` }, FAILED_LIMIT);
        log.push(`hook: dropped ${dropped.id}: backlog over ${OUTBOX_BYTES} bytes`);
      }
      h = { ...h, outbox, failed };
      log.push(`hook: queued ${ev.event} ${ev.key} as ${hook.eventType}`);
    }
  }
  return h === state.hooks ? { state, log } : { state: { ...state, hooks: h }, log };
}

const transient = (e: unknown) => e instanceof GitHubError && (e.kind === "server" || e.kind === "network" || e.kind === "rate_limit");

/**
 * Send waiting deliveries, oldest first. Never throws for a delivery failure:
 * a transient failure is retried on later ticks (for GIVE_UP_HOURS), anything
 * else is recorded as failed. `stop` names errors that end delivery for this
 * tick without counting against the delivery (the lease fence refusing: the
 * runner then releases or loses the lease as usual); `rethrow` names errors
 * that propagate (an injected crash). Delivery stops starting dispatches once
 * it has run for DELIVERY_BUDGET_MS, so hooks cannot run a tick out of time.
 */
export async function deliverHooks(
  h: HooksState,
  d: { target: TargetApi; now: Date; rethrow: (e: unknown) => boolean; stop?: (e: unknown) => boolean; clock?: () => number },
): Promise<{ hooks: HooksState; log: string[]; changed: boolean }> {
  const log: string[] = [];
  let outbox = [...h.outbox];
  let sent = h.sent;
  let failed = h.failed;
  let changed = false;
  const at = d.now.toISOString();
  const clock = d.clock ?? Date.now;
  const started = clock();
  for (const del of h.outbox.slice(0, PER_TICK)) {
    if (clock() - started >= DELIVERY_BUDGET_MS) {
      log.push(`hook: delivery time budget used; ${outbox.length} left for the next tick`);
      break;
    }
    const fail = (error: string) => {
      outbox = outbox.filter((x) => x.id !== del.id);
      failed = record(failed, { id: del.id, event: del.payload.event, eventType: del.eventType, at, error }, FAILED_LIMIT);
      log.push(`hook: ${del.payload.event} ${del.payload.idempotencyKey} to ${del.eventType} failed: ${error}`);
    };
    changed = true;
    try {
      await d.target.dispatch(del.eventType, del.payload);
      outbox = outbox.filter((x) => x.id !== del.id);
      sent = record(sent, hashId(del.id), SENT_LIMIT);
      log.push(`hook: sent ${del.payload.event} ${del.payload.idempotencyKey} as ${del.eventType}`);
    } catch (e) {
      if (d.rethrow(e)) throw e;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      if (d.stop?.(e)) {
        log.push(`hook: delivery stopped: ${msg}`);
        break;
      }
      const expired = d.now.getTime() - Date.parse(del.firstAt) >= GIVE_UP_HOURS * 3_600_000;
      if (transient(e) && !expired) {
        outbox = outbox.map((x) => (x.id === del.id ? { ...x, tries: x.tries + 1, lastError: msg } : x));
        log.push(`hook: ${del.payload.event} ${del.payload.idempotencyKey} deferred: ${msg}`);
        break; // GitHub is struggling: try the rest next tick
      }
      fail(transient(e) ? `gave up after ${GIVE_UP_HOURS}h (${del.tries + 1} tries): ${msg}` : msg);
    }
  }
  return { hooks: { outbox, sent, failed }, log, changed };
}

// ---------------------------------------------------------------- event builders (pure)

export const prOf = (number: number, head: string, author: string | undefined, mergeSha?: string): HookPr => ({
  number,
  head,
  ...(mergeSha ? { mergeSha } : {}),
  ...(author ? { author } : {}),
});

export const jobsOf = (jobs: FailedJob[]) => jobs.map((j) => ({ name: j.name, url: j.url }));

// ---------------------------------------------------------------- strict parse of State.hooks

type O = Record<string, unknown>;
const isObj = (x: unknown): x is O => typeof x === "object" && x !== null && !Array.isArray(x);

/** Checks the shape of State.hooks; returns the problem, or null. */
export function hooksStateProblem(x: unknown): string | null {
  if (!isObj(x)) return "hooks: not an object";
  for (const k of Object.keys(x)) if (!["outbox", "sent", "failed"].includes(k)) return `hooks: unexpected key '${k}'`;
  const { outbox, sent, failed } = x;
  if (!Array.isArray(outbox) || !Array.isArray(sent) || !Array.isArray(failed)) return "hooks: outbox, sent and failed must be arrays";
  for (const [i, d] of outbox.entries()) {
    if (!isObj(d) || typeof d.id !== "string" || typeof d.eventType !== "string" || !EVENT_TYPE_RE.test(d.eventType)) return `hooks.outbox[${i}]: bad delivery`;
    if (!Number.isSafeInteger(d.tries) || (d.tries as number) < 0 || typeof d.firstAt !== "string") return `hooks.outbox[${i}]: bad tries or firstAt`;
    if (d.lastError !== undefined && typeof d.lastError !== "string") return `hooks.outbox[${i}].lastError: not a string`;
    const p = d.payload;
    if (!isObj(p) || p.v !== 1 || !HOOK_EVENTS.includes(p.event as HookEventName) || typeof p.idempotencyKey !== "string" || !Array.isArray(p.prs) || !isObj(p.details)) {
      return `hooks.outbox[${i}].payload: bad payload`;
    }
  }
  if (!sent.every((s) => typeof s === "string" && /^[0-9a-f]{16}$/.test(s))) return "hooks.sent: bad id";
  for (const [i, f] of failed.entries()) {
    if (!isObj(f) || typeof f.id !== "string" || typeof f.eventType !== "string" || typeof f.at !== "string" || typeof f.error !== "string" || !HOOK_EVENTS.includes(f.event as HookEventName)) {
      return `hooks.failed[${i}]: bad failure`;
    }
  }
  return null;
}
