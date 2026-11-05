// Self-chaining (DESIGN.md §11.1). After a live queue tick has released its
// lease, decide whether the next tick should start now instead of on the
// (often late) cron, and if so dispatch tick.yml@main with the job's own
// GITHUB_TOKEN: a workflow_dispatch is the one GITHUB_TOKEN-created event
// that starts a run. The cron stays the fallback: a lost or refused dispatch
// ends the chain, and the queue is then no slower than without chaining.
//
// Bounded four ways, none of which needs state (a mergeability re-tick is
// also bounded by its hold's age, RETICK_WINDOW_MINUTES):
//   - only an `acted` tick with more work, or a batch whose CI is running,
//     chains; busy, paused, retry-later, lost-lock, stale and idle never do,
//     nor does a tick whose op was aborted, refunded or dropped (it made no
//     progress, and retrying at once could loop without spending a budget);
//   - a CI watch ends early only on progress it saw happen (a run that was
//     already completed when the watch began never counts), so a tick that
//     cannot act yet on a finished run still waits out the whole watch;
//   - at most MAX_DISPATCHES_PER_HOUR dispatched tick runs per rolling hour,
//     read from GitHub (an unreadable count means no dispatch).
// Every network call after the tick runs against a deadline from process
// start, so the chain never pushes the job past its timeout; and while a cron
// release job waits for the runner, the queue yields to it (the same cron run
// queued a queue job, which continues the chain).
//
// These are timing constants, not policy: they are not in Config, so the
// policy hash (and every admission bound to it) is unchanged.

import type { Config } from "./config";
import type { TargetApi } from "./github/api";
import type { State } from "./state";
import { actives } from "./ctx";
import { queueRef } from "./validate";

/** The CI watch ends this long after the process started (not after the watch started). */
export const WATCH_MINUTES = 3;
export const WATCH_POLL_SECONDS = 20;
/** About 13 an hour while a batch is in flight; the cap only stops a runaway. */
export const MAX_DISPATCHES_PER_HOUR = 30;
/** The dispatch (cap read, release check, POST) must be done this long after the watch deadline, or is skipped. */
export const DISPATCH_SECONDS = 30;

/**
 * A ready or admitted PR held on unknown mergeability (null: GitHub is still
 * computing it against a main that just moved) re-ticks this soon instead of
 * waiting for the cron, but only while the newest hold is younger than
 * RETICK_WINDOW_MINUTES; after that the cron runs the next tick, so a GitHub
 * that never computes mergeability cannot keep the chain going.
 */
export const RETICK_SECONDS = 60;
export const RETICK_WINDOW_MINUTES = 4;

/** When to re-tick for a hold that started at `holdSince` (ms), or null for no re-tick. */
export function retickAt(holdSince: number | undefined, now: number): number | null {
  if (holdSince === undefined || now - holdSince >= RETICK_WINDOW_MINUTES * 60_000) return null;
  return now + RETICK_SECONDS * 1000;
}

/** Op results that made no progress: chaining straight after them could loop without spending a budget. */
const NO_PROGRESS = new Set(["buildAborted", "buildFailed", "opAbandoned", "opDropped", "landRejected", "targetMissing"]);

/** The tick dispatch through the workflow token (src/github/state-repo.ts): the only Actions write it can make. */
export interface ChainApi {
  dispatchTick(): Promise<void>;
  /** Dispatched tick.yml runs created at or after `since`. */
  recentDispatches(since: Date): Promise<number>;
  /** A cron release job is waiting for the runner. */
  releaseWaiting(): Promise<boolean>;
}

export type Wake =
  | { kind: "none" }
  | { kind: "now"; reason: string }
  /** Watch batch n's CI (and, while several batches run, each of `more`'s too, DESIGN.md §5.6). */
  | { kind: "ci"; n: number; head: string; more?: { n: number; head: string }[] }
  /** Fresh candidates are filling: tick again at the fill deadline (ms), or at the end of the watch if that comes first. */
  | { kind: "fill"; at: number }
  /** A PR is held on unknown mergeability: tick again at `at` (ms), or at the end of the watch if that comes first. */
  | { kind: "retick"; at: number };

type Outcome = "acted" | "idle" | "waiting" | "stale" | "busy" | "lost-lock" | "retry-later" | "paused";

/**
 * What the next tick should wait for, from this tick's outcome, its final
 * (released) state, the kind of its last op result, and this tick's re-tick
 * time for a mergeability hold (retickAt). A re-tick only replaces a wake
 * that would have left the next tick to the cron, or a later fill deadline.
 */
export function wakeFor(outcome: Outcome, s: State, lastResult: string | null = null, fillUntil: number | null = null, retick: number | null = null, maxActive = 1): Wake {
  if (outcome !== "acted" && outcome !== "idle" && outcome !== "waiting") return { kind: "none" };
  if (lastResult !== null && NO_PROGRESS.has(lastResult)) return { kind: "none" };
  if (s.outbox.some((n) => n.kind === "pause")) return { kind: "none" };
  const w = progressWake(outcome, s, fillUntil, maxActive);
  if (retick !== null && !s.journal && (w.kind === "none" || (w.kind === "fill" && w.at > retick))) return { kind: "retick", at: retick };
  return w;
}

function progressWake(outcome: Outcome, s: State, fillUntil: number | null, maxActive: number): Wake {
  const a = s.active;
  if (a && (!s.journal || s.journal.op.kind === "rerun")) {
    const all = actives(s);
    // A free slot and work that may fill it (queue.concurrency, DESIGN.md §5.6): the next tick starts it now.
    const waiting = s.pending.length > 0 || s.solo.length > 0 || Object.keys(s.auth).some((k) => !all.some((x) => x.prs.includes(Number(k))));
    if (outcome === "acted" && !s.journal && all.length < maxActive && waiting) return { kind: "now", reason: "a batch slot is free and work is waiting" };
    const more = all.filter((x) => x.n !== a.n).map((x) => ({ n: x.n, head: x.head }));
    return { kind: "ci", n: a.n, head: a.head, ...(more.length > 0 ? { more } : {}) };
  }
  // Filling: this tick's fresh selection chose to wait (never after a pause, a
  // build or recovery work). Chain toward the deadline; once it passes the next
  // tick builds, so the chain ends. Waiting notices still get an immediate tick.
  if (fillUntil !== null && !a && !s.journal && s.pending.length === 0 && s.solo.length === 0) {
    const notices = s.outbox.some((n) => n.kind !== "cancelRuns");
    if (!(outcome === "acted" && notices)) return { kind: "fill", at: fillUntil };
  }
  if (outcome !== "acted") return { kind: "none" };
  if (s.journal) return { kind: "now", reason: `a journalled ${s.journal.op.kind} is outstanding` };
  if (s.pending.length > 0 || s.solo.length > 0) return { kind: "now", reason: "split halves or solo PRs are waiting" };
  if (Object.keys(s.auth).length > 0) return { kind: "now", reason: "admitted PRs are waiting" };
  // cancelRuns waits on the target's CI to finish, so it does not need a prompt tick.
  if (s.outbox.some((n) => n.kind !== "cancelRuns")) return { kind: "now", reason: "notices are waiting" };
  return { kind: "none" };
}

export interface ChainDeps {
  target: Pick<TargetApi, "listRuns">;
  chain: ChainApi;
  cfg: Pick<Config, "preLanding" | "names">;
  /** When this process started, in ms. */
  startedAt: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type Seen = Map<number, { attempt: number; done: boolean }>;

const TIMED_OUT = Symbol("timed out");

/** `p`, or TIMED_OUT once `ms` has passed (the request is abandoned, not awaited). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) {
    p.catch(() => {});
    return TIMED_OUT;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof TIMED_OUT>((r) => (timer = setTimeout(() => r(TIMED_OUT), ms)));
  try {
    return await Promise.race([p, late]);
  } finally {
    clearTimeout(timer);
    p.catch(() => {});
  }
}

async function readRuns(d: ChainDeps, w: Extract<Wake, { kind: "ci" }>, budgetMs: number): Promise<Seen | null> {
  const paths = new Set(d.cfg.preLanding.map((e) => e.path));
  const out: Seen = new Map();
  for (const b of [{ n: w.n, head: w.head }, ...(w.more ?? [])]) {
    const ref = queueRef(d.cfg.names, b.n);
    try {
      const l = await within(d.target.listRuns({ headSha: b.head, branch: ref, event: "push" }), budgetMs);
      // A late or incomplete listing is no evidence: neither a baseline nor progress.
      if (l === TIMED_OUT || l.truncated) return null;
      for (const r of l.items) {
        if (r.head_branch !== ref || r.head_sha !== b.head || !paths.has(r.path)) continue;
        out.set(r.id, { attempt: r.run_attempt, done: r.status === "completed" });
      }
    } catch {
      return null; // only a hint: the deadline still ends the watch
    }
  }
  return out;
}

/** Progress: a run that completed since the baseline (newly seen, was running, or a newer attempt). */
export function progressed(base: Seen, now: Seen): boolean {
  for (const [id, r] of now) {
    if (!r.done) continue;
    const b = base.get(id);
    if (!b || !b.done || r.attempt > b.attempt) return true;
  }
  return false;
}

/** Watch the batch's pre-landing runs, holding no lease, until progress or the deadline. */
export async function watchCi(w: Extract<Wake, { kind: "ci" }>, d: ChainDeps): Promise<"progress" | "deadline"> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = d.startedAt + WATCH_MINUTES * 60_000;
  let base: Seen | null = null;
  for (;;) {
    const seen = await readRuns(d, w, deadline - now());
    if (seen) {
      if (base === null) base = seen; // the first good read is the baseline, never progress
      else if (progressed(base, seen)) return "progress";
    }
    const left = deadline - now();
    if (left <= 0) return "deadline";
    await sleep(Math.min(WATCH_POLL_SECONDS * 1000, left));
  }
}

/** Never throws: any failure ends the chain and leaves the cron to run the next tick. */
export async function dispatch(d: ChainDeps): Promise<string> {
  const now = d.now ?? Date.now;
  const end = d.startedAt + WATCH_MINUTES * 60_000 + DISPATCH_SECONDS * 1000;
  const late = "chain: not dispatched: too close to the job timeout; the cron runs the next tick";
  try {
    const recent = await within(d.chain.recentDispatches(new Date(now() - 3_600_000)), end - now());
    if (recent === TIMED_OUT) return late;
    if (recent >= MAX_DISPATCHES_PER_HOUR) return `chain: not dispatched: ${recent} dispatched ticks in the last hour (cap ${MAX_DISPATCHES_PER_HOUR}); the cron runs the next tick`;
    const release = await within(d.chain.releaseWaiting(), end - now());
    if (release === TIMED_OUT) return late;
    if (release) return "chain: not dispatched: a release job is waiting for the runner; the cron's own queue job continues";
    if ((await within(d.chain.dispatchTick(), end - now())) === TIMED_OUT) return "chain: the dispatch did not answer in time; it may or may not have been made";
    return "chain: dispatched the next queue tick";
  } catch (e) {
    return `chain: dispatch failed (${String(e)}); the cron runs the next tick`;
  }
}

/** After a live queue tick: watch if a batch's CI is running, then dispatch, or do nothing. */
export async function afterTick(wake: Wake | undefined, d: ChainDeps): Promise<string[]> {
  if (!wake || wake.kind === "none") return ["chain: none; the cron runs the next tick"];
  const log: string[] = [];
  if (wake.kind === "now") log.push(`chain: now (${wake.reason})`);
  else if (wake.kind === "fill" || wake.kind === "retick") {
    const now = d.now ?? Date.now;
    const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const until = Math.min(wake.at, d.startedAt + WATCH_MINUTES * 60_000);
    if (until > now()) await sleep(until - now());
    log.push(
      wake.kind === "fill"
        ? `chain: filling; waited until ${new Date(until).toISOString()} (deadline ${new Date(wake.at).toISOString()})`
        : `chain: re-tick for a PR held on unknown mergeability; waited until ${new Date(until).toISOString()}`,
    );
  } else log.push(`chain: watched batch ${[wake.n, ...(wake.more ?? []).map((b) => b.n)].join(", ")}'s CI until ${await watchCi(wake, d)}`);
  log.push(await dispatch(d));
  return log;
}
