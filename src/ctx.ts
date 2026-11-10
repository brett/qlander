// Shared bookkeeping helpers for machine.ts and ops.ts. Pure: they only edit
// the cloned state inside a Ctx.

import type { LivePr } from "./admission";
import type { CiClass } from "./classify";
import type { Config } from "./config";
import type { Active, Baseline, HistoryItem, Notice, Parked, SeenRun, State } from "./state";
import { BUDGET_WARN_SHARE, type HookBatch, type HookPr, type LifecycleEvent, prOf } from "./hooks";
import type { FailedJob } from "./types";
import type { Command } from "./validate";
import { queueRef } from "./validate";

export interface Snapshot {
  now: Date;
  paused: boolean;
  main: string;
  policyHash: string;
  /** Live reads for every PR in state, plus every open PR labelled ready. */
  prs: Record<string, LivePr>;
  /** For `state.active` (the batch running when the snapshot was read). */
  ci: CiClass | null;
  /** The manifest runs seen this tick for each running batch whose CI was read, by batch number: decide() adds them to its `seen`. */
  ciSeen?: Record<string, SeenRun[]>;
  /** For state.parked (queue.strategy.reuseGreen, DESIGN.md §5.7): its CI on main, read only while unpaused and main is its base. */
  parkedCi?: CiClass | null;
  /** For every running batch, by batch number (optional; present only while more than one batch runs, DESIGN.md §5.6). */
  cis?: Record<string, CiClass>;
  /** For state.baseline (queue.strategy.mainBaseline), while its run is going: its CI, and failing test ids once it is red. */
  baselineCi?: CiClass;
  baselineTests?: Record<string, string[]>;
  /** Failing test ids of running batches' red jobs, by job id, read only while main is known or just seen to be red. */
  redTests?: Record<string, string[]>;
  /** Job names that failed in main's own latest completed push run (null: unknown). */
  mainFailedJobs: string[] | null;
  /** Reachability of each verify pin from main. */
  pinReachable: Record<string, boolean>;
  /** Operator commands (PR labels), oldest first (DESIGN.md §10). */
  commands?: Command[];
  /** When a rerun turned a red batch green: failing test ids parsed from each first-attempt job log, by job id (only logs that could be read). */
  flakyTests?: Record<string, string[]>;
  /** operatorSolo PRs that have left the queue, and why (src/snapshot.ts soloLeft); absent when none. */
  soloLeft?: Record<string, string>;
  /**
   * The open PRs GitHub's pull listing showed with the ready label, ascending
   * (src/snapshot.ts). Reporting only: decide() reads it for the per-PR
   * verdicts, never to admit. Absent in snapshots built without it.
   */
  readyListed?: number[];
  /**
   * Open PRs read carrying the ready label while reading operator commands,
   * but missing from the ready listing and so never described this tick.
   * Reporting only, as readyListed; absent when none.
   */
  readyUnlisted?: number[];
}

/** Why a PR that is ready this tick was not admitted (src/machine.ts verdicts). */
export interface Verdict {
  pr: number;
  reason: string;
}

export interface Decision {
  state: State;
  log: string[];
  /** Set when fresh selection chose to keep filling: its deadline (ms). Drives the fill wake. */
  fillUntil?: number;
  /** Lifecycle events for hooks (src/hooks.ts); present only when something was emitted. */
  events?: LifecycleEvent[];
  /** Set when a ready or admitted PR is held on unknown mergeability: the newest hold's start (ms). Drives the re-tick wake. */
  holdSince?: number;
  /** Every ready PR that is not admitted after this decision, and why; present only when there is one. */
  ignored?: Verdict[];
}

export interface Ctx {
  s: State;
  snap: Snapshot;
  cfg: Config;
  log: string[];
  now: string;
  pausing: boolean;
  /** PRs removed or unreadied this tick: the snapshot is stale for them, so they are not readmitted or selected. */
  excluded: Set<number>;
  /** Fresh selection decided to keep filling until then (ms). */
  fillUntil?: number;
  /** PRs held this tick on unknown mergeability (key → head, since); becomes state.held. */
  held: Map<string, { head: string; since: string }>;
  /** Lifecycle events emitted this decision, for hooks. The runner decides who hears them. */
  events: LifecycleEvent[];
  /** The batch `snap.ci` describes: the one in `active` when the decision began. */
  ciFor: number | null;
  /** Why each PR was skipped or refused this tick, first reason kept (src/machine.ts verdicts). Reporting only. */
  why: Map<number, string>;
}

export function makeCtx(s: State, snap: Snapshot, cfg: Config): Ctx {
  return { s, snap, cfg, log: [], now: snap.now.toISOString(), pausing: false, excluded: new Set(), held: new Map(), events: [], ciFor: s.active?.n ?? null, why: new Map() };
}

/** Record why a PR is not admitted this tick, unless an earlier reason was recorded. Reporting only. */
export function because(c: Ctx, pr: number, reason: string): void {
  if (!c.why.has(pr)) c.why.set(pr, reason);
}

/** Emit a lifecycle event (src/hooks.ts). Pure: it only records it; hooks are not policy and are not in Config. */
export function emit(c: Ctx, ev: Omit<LifecycleEvent, "at">): void {
  if (!c.events.some((e) => e.key === ev.key)) c.events.push({ ...ev, at: c.now });
}

/** The PR as hooks report it: the authorised head and the author recorded at admission. */
export function hookPr(c: Ctx, pr: number, mergeSha?: string): HookPr {
  const a = c.s.auth[String(pr)];
  return prOf(pr, a?.head ?? "", a?.author, mergeSha);
}

/** The `dequeued` hook event for an admitted PR, emitted before its auth record goes. */
export function emitDequeued(c: Ctx, pr: number, kind: string, reason: string): void {
  const auth = c.s.auth[String(pr)];
  if (!auth) return;
  emit(c, { event: "dequeued", key: `dequeued:${pr}:${auth.head}:${auth.admittedAt}`, batch: null, prs: [hookPr(c, pr)], details: { kind, reason } });
}

export const hookBatch = (a: Active): HookBatch => ({ n: a.n, base: a.base, head: a.head, depth: a.depth });

/** Events go on the decision only when there are some, so decisions without them are unchanged. */
export function withEvents(c: Ctx, d: Decision): Decision {
  return c.events.length > 0 ? { ...d, events: c.events } : d;
}

export function notify(c: Ctx, n: Notice): void {
  if (!c.s.outbox.some((o) => o.id === n.id)) c.s.outbox.push(n);
}

export function comment(c: Ctx, pr: number, tag: string, body: string): void {
  notify(c, { id: `c:${pr}:${tag}`, kind: "comment", pr, body });
}

export function unready(c: Ctx, pr: number, tag: string): void {
  because(c, pr, "its `ready` label is being removed");
  c.excluded.add(pr);
  notify(c, { id: `u:${pr}:${tag}`, kind: "unready", pr });
}

export function pause(c: Ctx, reason: string): void {
  c.pausing = true;
  c.log.push(`pause: ${reason}`);
  notify(c, { id: `p:${c.s.seq}`, kind: "pause", reason });
}

export function record(c: Ctx, item: Omit<HistoryItem, "at">): void {
  c.s.history.push({ ...item, at: c.now });
  const over = c.s.history.length - c.cfg.historyLimit;
  if (over > 0) c.s.history.splice(0, over);
}

/** The batch is over: its queue ref can go (DESIGN.md §3.2 retention). */
export function retire(c: Ctx, a: Active): void {
  notify(c, { id: `d:${a.n}`, kind: "deleteRef", ref: queueRef(c.cfg.names, a.n) });
  setActives(c.s, actives(c.s).filter((x) => x.n !== a.n));
}

/**
 * Every running batch, in batch-number order (DESIGN.md §5.6): `active` and
 * `concurrent` together. With one batch (always, without
 * queue.concurrency), just `active`.
 */
export function actives(s: State): Active[] {
  return [...(s.active ? [s.active] : []), ...(s.concurrent ?? [])].sort((x, y) => x.n - y.n);
}

/**
 * Store the running batches: `focus` (default: the one in `active` now, if
 * still running, else the first) goes in `active`, the rest in `concurrent`,
 * which is absent when empty. A non-build journalled op always concerns
 * `active` (focus() before journalling it), so ops and recovery read it as
 * they always have.
 */
export function setActives(s: State, list: Active[], focusN?: number): void {
  const sorted = [...list].sort((x, y) => x.n - y.n);
  const want = focusN ?? s.active?.n;
  const head = sorted.find((a) => a.n === want) ?? sorted[0] ?? null;
  s.active = head;
  const rest = sorted.filter((a) => a !== head);
  if (rest.length > 0) s.concurrent = rest;
  else delete s.concurrent;
}

/** The CI class of a running batch this tick (null: not read). */
export function ciOf(c: Ctx, a: Active): CiClass | null {
  return c.snap.cis?.[String(a.n)] ?? (a.n === c.ciFor ? c.snap.ci : null);
}

/** Batches whose CI may run at once (queue.concurrency; 1 without it). */
export const maxActive = (cfg: Config) => cfg.concurrency?.maxActive ?? 1;

/** The history note that stops pipelining on batch n (DESIGN.md §5.6): a PR would not merge on top of it. */
export const speculationRefused = (n: number) => `speculation on batch ${n} refused:`;

/** A parked batch (queue.strategy.reuseGreen) as a running batch, at this depth and lineage: for reading its CI, and for landing it. */
export function parkedBatch(p: Parked, depth = p.depth, lineage = p.lineage): Active {
  return { n: p.n, base: p.base, head: p.head, depth, prs: p.pins.map((x) => x.pr), lineage, rerun: null, rerunAt: null, cancels: [], builtAt: p.builtAt, ...(p.stack ? { stack: p.stack } : {}), ...(p.seen ? { seen: p.seen } : {}) };
}

/** A main baseline as a running batch with no PRs: for reading its CI. */
export function baselineBatch(b: Baseline): Active {
  return { n: b.n, base: b.base, head: b.base, depth: 0, prs: [], lineage: 0, rerun: null, rerunAt: null, cancels: [], builtAt: b.builtAt };
}

/**
 * queue.strategy.adaptive (DESIGN.md §5.7): the fresh batch size limit now,
 * from state.adaptive (absent: queue.batch.max), kept within
 * [max(1, queue.batch.min), ceiling]. Only called with the key on.
 */
export function adaptiveLimit(cfg: Config, s: State): number {
  const ceiling = cfg.strategy?.adaptive?.ceiling ?? cfg.maxBatch;
  return Math.min(ceiling, Math.max(1, cfg.minBatch, s.adaptive?.size ?? cfg.maxBatch));
}

/** Make `a` the batch in `active`, for the op about to be journalled for it. */
export function focus(s: State, a: Active): void {
  setActives(s, actives(s), a.n);
}

export function reserve(c: Ctx, lineage: number): void {
  const key = String(lineage);
  c.s.lineages[key] = { ...c.s.lineages[key], runs: (c.s.lineages[key]?.runs ?? 0) + 1 };
  const before = c.s.window.reduce((n, w) => n + w.cost, 0);
  c.s.window.push({ at: c.now, cost: 1 });
  const threshold = BUDGET_WARN_SHARE * c.cfg.windowBudget;
  if (before < threshold && before + 1 >= threshold) {
    emit(c, {
      event: "budget_warning",
      key: `budget_warning:${c.now}`,
      batch: null,
      prs: [],
      details: { used: before + 1, budget: c.cfg.windowBudget, windowHours: c.cfg.windowHours, share: BUDGET_WARN_SHARE },
    });
  }
}

export function refund(s: State, lineage: number, at: string): void {
  const key = String(lineage);
  const cur = s.lineages[key];
  if (cur) s.lineages[key] = { ...cur, runs: Math.max(0, cur.runs - 1) };
  const i = s.window.findIndex((w) => w.at === at);
  if (i >= 0) s.window.splice(i, 1);
}

export function jobsList(jobs: FailedJob[]): string {
  return jobs.length === 0
    ? "(no failed job recorded; see the batch's runs)"
    : jobs.map((j) => `- [${j.name}](${j.url})`).join("\n");
}
