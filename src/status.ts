// The operator's view of a live queue (docs/operating.md, "Watching the queue"): one typed
// Status object projected from what the tick itself treats as authoritative.
// Pure: no I/O. src/status-cli.ts reads the sources and prints the result
// (text through src/status-render.ts, or JSON); a web page or the watchdog
// could render the same Status object without reading anything else.
//
// The sources, and only these:
//   - the queue and release state documents (`state.json` on each state
//     branch), parsed by the tick's own strict parsers;
//   - the open control-repo issues with the pause, release-pause,
//     release-blocked and watchdog-alert labels;
//   - tick.yml's recent runs and its workflow state (control repo Actions);
//   - the active batch's CI runs on its queue ref, and recent completed CI
//     runs on queue refs for the usual duration (target repo Actions);
//   - each queued PR's title (target pulls), for display only.
// Never the mirror issues, the status issue or PR comments.

import type { Names } from "./config";
import { candidateStage, type ReleaseState } from "./release-state";
import type { HistoryItem, State } from "./state";
import type { Run } from "./types";
import { type IssueInfo, isTickRun, type TickRun } from "./watchdog-core";

/** One state document as read: parsed, absent (its branch does not exist), corrupt, or unreadable. */
export type DocRead<S> =
  | { kind: "ok"; state: S; version: string }
  | { kind: "absent" }
  | { kind: "corrupt"; reason: string }
  | { kind: "error"; reason: string };

/** An issue listing as read: `complete` false means some may be missing (the tick then counts itself paused). */
export type IssuesRead = { issues: IssueInfo[]; complete: boolean } | { error: string };

/** A completed CI run on a queue ref: when its attempt started and when it finished. */
export interface CiSpan {
  startedAt: string;
  finishedAt: string;
}

/** Everything the projection reads, gathered by src/status-cli.ts (or a test). */
export interface StatusInput {
  /** GitHub's clock at the queue state read when there was one, else the reader's. */
  now: Date;
  names: Names;
  /** Base URL for links (https://github.com). */
  serverUrl: string;
  windowBudget: number;
  windowHours: number;
  queue: DocRead<State>;
  release: DocRead<ReleaseState>;
  /** false: release advance is off, so a bad release state document is shown but doesn't make the view incomplete. */
  releaseEnabled?: boolean;
  issues: { pause: IssuesRead; releasePause: IssuesRead; releaseBlocked: IssuesRead; alert: IssuesRead };
  /** tick.yml's state ("active", "disabled_manually", ...), or the read error. */
  tickWorkflow: { state: string } | { error: string };
  /** tick.yml's newest runs, or the read error. */
  ticks: { runs: TickRun[] } | { error: string };
  /** The active batch's CI runs on its queue ref (absent when there is no active batch). */
  batchRuns?: { runs: Run[]; truncated: boolean } | { error: string };
  /** Recent completed, successful CI runs on queue refs, for the usual duration. */
  ciSpans: { spans: CiSpan[] } | { error: string };
  /** PR titles by number (untrusted text; display only). Missing ones are shown without a title. */
  titles: Record<string, string>;
}

export interface PrLine {
  pr: number;
  title: string | null;
  /** When the queue admitted it (its auth), if it is still admitted. */
  admittedAt: string | null;
  /** Time since admission: the queue wait. */
  waitMs: number | null;
  /** Who applied the priority label, when it carries it. */
  priorityBy: string | null;
}

export interface IssueLine {
  number: number;
  title: string;
  url: string;
  ageMs: number | null;
}

export interface IssueGroup {
  /** The label listed. */
  label: string;
  issues: IssueLine[];
  /** false: the listing was incomplete or failed; the tick treats that as paused. */
  complete: boolean;
  error: string | null;
}

export interface CiRunLine {
  id: number;
  path: string;
  attempt: number;
  status: string;
  conclusion: string | null;
  url: string;
}

export interface Status {
  at: string;
  control: string;
  target: string;
  /** One word for the queue: paused, landing, testing, waiting (work queued, no batch yet), idle, or unknown (state unreadable). */
  queueSummary: "paused" | "landing" | "testing" | "waiting" | "idle" | "unknown";
  /** The queue state document: ok, or why it could not be used. */
  queueState: { kind: "ok"; seq: number; version: string } | { kind: "absent" | "corrupt" | "error"; reason: string };
  lease: null | {
    owner: string;
    acquiredAt: string | null;
    ageMs: number | null;
    until: string;
    /** Negative once it has expired. */
    expiresInMs: number;
    executor: { runId: number; attempt: number; job: string; url: string } | null;
  };
  /** The op in flight (the journal), if any. */
  op: null | { kind: string; at: string; ageMs: number; tries: number };
  active: null | {
    n: number;
    ref: string;
    head: string;
    prs: PrLine[];
    depth: number;
    lineage: number;
    builtAt: string;
    elapsedMs: number;
    /** Median duration of recent successful CI runs on queue refs, and how many it is over. */
    usualMs: number | null;
    usualOver: number;
    rerunRequested: boolean;
    runs: CiRunLine[];
    runsNote: string | null;
  };
  /** Further running batches (queue.concurrency, DESIGN.md §5.6), in batch-number order; empty while at most one runs. */
  concurrent: { n: number; ref: string; head: string; prs: PrLine[]; depth: number; lineage: number; on: number | null; elapsedMs: number; rerunRequested: boolean }[];
  pending: { prs: PrLine[]; depth: number; lineage: number }[];
  solo: { pr: PrLine; reason: string }[];
  /** Admitted PRs not yet in a pending group, a solo slot or the active batch (the FIFO), oldest first. */
  queued: PrLine[];
  operatorSolo: number[];
  held: { pr: number; sinceMs: number | null }[];
  verifying: { pr: number; landedIn: string; ageMs: number | null }[];
  outbox: { id: string; kind: string; pr: number | null }[];
  bounces: { n: number; at: string; ageMs: number | null; outcome: string; prs: number[]; note: string; failedJobs: { name: string; url: string }[] }[];
  counters: null | { windowUsed: number; windowBudget: number; windowHours: number; redStreak: number; bounceStreak: number; lastLandedAt: string | null; lastLandedAgeMs: number | null };
  /** true: an open issue (or a pause the queue has decided on) says so; false: a complete listing found none; null: unknown, which the tick counts as paused. */
  paused: { queue: boolean | null; release: boolean | null };
  issues: { pause: IssueGroup; releasePause: IssueGroup; releaseBlocked: IssueGroup; alert: IssueGroup };
  release:
    | { kind: "absent" | "corrupt" | "error"; reason: string }
    | {
        kind: "ok";
        seq: number;
        lease: { owner: string; until: string; expiresInMs: number } | null;
        op: null | { before: string; after: string; at: string; ageMs: number | null };
        /** release.mode dispatch: a dispatch in flight (its journal), and the candidate's stage; absent otherwise. */
        dispatch?: { op: null | { kind: string; sha: string; at: string; ageMs: number | null }; candidate: null | { sha: string; stage: string } };
        pausePending: string | null;
        last: null | { at: string; ageMs: number | null; kind: string; reason: string; release: string | null; main: string | null };
        lastHistory: null | { at: string; outcome: string; from: string; to: string; note: string };
      };
  ticks: {
    workflow: string | null;
    error: string | null;
    recent: { id: number; url: string; event: string; status: string; conclusion: string | null; createdAt: string; ageMs: number | null }[];
  };
  /** Reads that failed or were incomplete, in words; also a queue state branch that does not exist. */
  problems: string[];
  /** Every read the view depends on worked and came back whole. PR titles are display only, and a queue state branch that does not exist is an answer (no live tick yet), so neither makes this false. */
  complete: boolean;
}

/** How many recent ticks, bounces and CI spans the projection keeps. */
export const RECENT_TICKS = 5;
export const RECENT_BOUNCES = 5;
export const USUAL_OVER = 20;
const BOUNCE_OUTCOMES: readonly HistoryItem["outcome"][] = ["bounced"];

const ms = (iso: string | null | undefined): number | null => {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};

const since = (now: number, iso: string | null | undefined): number | null => {
  const t = ms(iso);
  return t === null ? null : now - t;
};

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The usual batch duration: the median of the newest USUAL_OVER spans (finish minus start). */
export function usualDuration(spans: CiSpan[]): { ms: number | null; over: number } {
  const d = spans
    .map((s) => ({ end: ms(s.finishedAt), start: ms(s.startedAt) }))
    .filter((x): x is { end: number; start: number } => x.end !== null && x.start !== null && x.end >= x.start)
    .sort((a, b) => b.end - a.end)
    .slice(0, USUAL_OVER)
    .map((x) => x.end - x.start);
  return { ms: median(d), over: d.length };
}

function issueGroup(label: string, r: IssuesRead, now: number): IssueGroup {
  if ("error" in r) return { label, issues: [], complete: false, error: r.error };
  return {
    label,
    complete: r.complete,
    error: null,
    issues: r.issues.map((i) => ({ number: i.number, title: i.title, url: i.url, ageMs: since(now, i.createdAt) })),
  };
}

/**
 * Paused: an open issue says so (true); a complete, empty listing says not
 * (false), but only when the state document was read too, since it can hold a
 * pause decided but not yet opened as an issue; otherwise unknown (the tick
 * counts that as paused).
 */
function pausedBy(g: IssueGroup, stateRead: boolean): boolean | null {
  if (g.issues.length > 0) return true;
  return g.complete && stateRead ? false : null;
}

function projectRelease(r: DocRead<ReleaseState>, now: number): Status["release"] {
  if (r.kind === "absent") return { kind: "absent", reason: "release state branch absent" };
  if (r.kind !== "ok") return { kind: r.kind, reason: r.reason };
  const s = r.state;
  const h = s.history.at(-1);
  return {
    kind: "ok",
    seq: s.seq,
    lease: s.lease ? { owner: s.lease.owner, until: s.lease.until, expiresInMs: (ms(s.lease.until) ?? now) - now } : null,
    op: s.journal?.op === "advance" ? { before: s.journal.before, after: s.journal.after, at: s.journal.at, ageMs: since(now, s.journal.at) } : null,
    ...(s.dispatch || s.journal?.op === "dispatch"
      ? {
          dispatch: {
            op: s.journal?.op === "dispatch" ? { kind: s.journal.kind, sha: s.journal.sha, at: s.journal.at, ageMs: since(now, s.journal.at) } : null,
            candidate: s.dispatch?.candidate ? { sha: s.dispatch.candidate.sha, stage: candidateStage(s.dispatch.candidate) } : null,
          },
        }
      : {}),
    pausePending: s.pausePending?.reason ?? null,
    last: s.last ? { at: s.last.at, ageMs: since(now, s.last.at), kind: s.last.kind, reason: s.last.reason, release: s.last.release, main: s.last.main } : null,
    lastHistory: h ? { at: h.at, outcome: h.outcome, from: h.from, to: h.to, note: h.note } : null,
  };
}

/** Project the gathered sources onto a Status. Pure. */
export function projectStatus(input: StatusInput): Status {
  const now = input.now.getTime();
  const N = input.names;
  const slug = (r: { owner: string; name: string }) => `${r.owner}/${r.name}`;
  const control = slug(N.control);
  const target = slug(N.target);
  const problems: string[] = [];

  const issues = {
    pause: issueGroup(N.controlLabels.pause, input.issues.pause, now),
    releasePause: issueGroup(N.releaseLabels.pause, input.issues.releasePause, now),
    releaseBlocked: issueGroup(N.releaseLabels.alert, input.issues.releaseBlocked, now),
    alert: issueGroup(N.watchdogLabels.alert, input.issues.alert, now),
  };
  for (const g of Object.values(issues)) {
    if (g.error) problems.push(`could not list the open '${g.label}' issues: ${g.error}`);
    else if (!g.complete) problems.push(`the open '${g.label}' issues were listed incompletely`);
  }

  const ticks: Status["ticks"] = { workflow: null, error: null, recent: [] };
  if ("error" in input.tickWorkflow) problems.push(`could not read the tick workflow: ${input.tickWorkflow.error}`);
  else if (typeof input.tickWorkflow.state !== "string") problems.push("could not read the tick workflow: the response has no state");
  else ticks.workflow = input.tickWorkflow.state;
  if ("error" in input.ticks) {
    ticks.error = input.ticks.error;
    problems.push(`could not list the tick runs: ${input.ticks.error}`);
  } else {
    ticks.recent = input.ticks.runs
      .filter(isTickRun)
      .sort((a, b) => (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0))
      .slice(0, RECENT_TICKS)
      .map((r) => ({ id: r.id, url: r.url, event: r.event, status: r.status, conclusion: r.conclusion, createdAt: r.createdAt, ageMs: since(now, r.createdAt) }));
  }

  const release = projectRelease(input.release, now);
  if (release.kind === "corrupt" || release.kind === "error") problems.push(`release state: ${release.reason}`);
  const shownOnly = input.releaseEnabled === false && (release.kind === "corrupt" || release.kind === "error") ? 1 : 0;
  // An absent release state branch holds no pending pause; a corrupt or unreadable one might.
  const releasePaused = release.kind === "ok" && release.pausePending ? true : pausedBy(issues.releasePause, release.kind === "ok" || release.kind === "absent");

  const base: Status = {
    at: input.now.toISOString(),
    control,
    target,
    queueSummary: "unknown",
    queueState: { kind: "error", reason: "" },
    lease: null,
    op: null,
    active: null,
    concurrent: [],
    pending: [],
    solo: [],
    queued: [],
    operatorSolo: [],
    held: [],
    verifying: [],
    outbox: [],
    bounces: [],
    counters: null,
    paused: { queue: pausedBy(issues.pause, input.queue.kind === "ok" || input.queue.kind === "absent"), release: releasePaused },
    issues,
    release,
    ticks,
    problems,
    complete: false,
  };

  const q = input.queue;
  if (q.kind !== "ok") {
    const reason = q.kind === "absent" ? `the ${N.stateBranch} branch does not exist` : q.reason;
    const complete = q.kind === "absent" && problems.length === shownOnly;
    problems.unshift(`queue state: ${reason}`);
    return { ...base, complete, queueState: { kind: q.kind, reason } };
  }
  const s = q.state;

  const line = (pr: number): PrLine => {
    const a = s.auth[String(pr)];
    return {
      pr,
      title: input.titles[String(pr)] ?? null,
      admittedAt: a?.admittedAt ?? null,
      waitMs: a ? since(now, a.admittedAt) : null,
      priorityBy: a?.priority?.by ?? null,
    };
  };

  const lease: Status["lease"] = s.lease
    ? {
        owner: s.lease.owner,
        acquiredAt: s.lease.acquiredAt ?? null,
        ageMs: since(now, s.lease.acquiredAt),
        until: s.lease.until,
        expiresInMs: (ms(s.lease.until) ?? now) - now,
        executor: s.lease.executor
          ? { ...s.lease.executor, url: `${input.serverUrl}/${control}/actions/runs/${s.lease.executor.runId}/attempts/${s.lease.executor.attempt}` }
          : null,
      }
    : null;

  let active: Status["active"] = null;
  if (s.active) {
    const a = s.active;
    const spans = input.ciSpans;
    const usual = "error" in spans ? { ms: null, over: 0 } : usualDuration(spans.spans);
    if ("error" in spans) problems.push(`could not list recent queue CI runs: ${spans.error}`);
    let runs: CiRunLine[] = [];
    let runsNote: string | null = null;
    const br = input.batchRuns;
    if (!br) runsNote = "not read";
    else if ("error" in br) {
      runsNote = `could not list: ${br.error}`;
      problems.push(`could not list batch ${a.n}'s CI runs: ${br.error}`);
    } else {
      runs = br.runs
        .filter((r) => r.head_sha === a.head)
        .sort((x, y) => x.path.localeCompare(y.path) || y.id - x.id)
        .map((r) => ({ id: r.id, path: r.path, attempt: r.run_attempt, status: r.status, conclusion: r.conclusion, url: `${input.serverUrl}/${target}/actions/runs/${r.id}` }));
      if (br.truncated) {
        runsNote = "the run listing was incomplete";
        problems.push(`batch ${a.n}'s CI run listing was incomplete`);
      }
      else if (runs.length === 0) runsNote = "no CI runs yet";
    }
    active = {
      n: a.n,
      ref: `${N.queuePrefix}${a.n}`,
      head: a.head,
      prs: a.prs.map(line),
      depth: a.depth,
      lineage: a.lineage,
      builtAt: a.builtAt,
      elapsedMs: since(now, a.builtAt) ?? 0,
      usualMs: usual.ms,
      usualOver: usual.over,
      rerunRequested: a.rerun !== null,
      runs,
      runsNote,
    };
  }

  const concurrent: Status["concurrent"] = (s.concurrent ?? []).map((a) => ({
    n: a.n,
    ref: `${N.queuePrefix}${a.n}`,
    head: a.head,
    prs: a.prs.map(line),
    depth: a.depth,
    lineage: a.lineage,
    on: a.on ?? null,
    elapsedMs: since(now, a.builtAt) ?? 0,
    rerunRequested: a.rerun !== null,
  }));

  const placed = new Set<number>([...(s.active?.prs ?? []), ...(s.concurrent ?? []).flatMap((a) => a.prs), ...s.pending.flatMap((p) => p.prs), ...s.solo.map((x) => x.pr)]);
  const queued = Object.keys(s.auth)
    .map(Number)
    .filter((pr) => !placed.has(pr))
    .map(line)
    .sort((x, y) => (ms(x.admittedAt) ?? 0) - (ms(y.admittedAt) ?? 0) || x.pr - y.pr);

  const windowStart = now - input.windowHours * 3_600_000;
  const windowUsed = s.window.filter((w) => (ms(w.at) ?? -Infinity) > windowStart).reduce((t, w) => t + w.cost, 0);

  const bounces = s.history
    .filter((h) => BOUNCE_OUTCOMES.includes(h.outcome))
    .sort((x, y) => (ms(y.at) ?? 0) - (ms(x.at) ?? 0))
    .slice(0, RECENT_BOUNCES)
    .map((h) => ({ n: h.n, at: h.at, ageMs: since(now, h.at), outcome: h.outcome, prs: h.prs, note: h.note, failedJobs: (h.failedJobs ?? []).map((j) => ({ name: j.name, url: j.url })) }));

  const queuePaused = s.outbox.some((o) => o.kind === "pause") ? true : base.paused.queue;
  const op = s.journal ? { kind: s.journal.op.kind, at: s.journal.at, ageMs: since(now, s.journal.at) ?? 0, tries: s.journal.tries } : null;
  const queueSummary: Status["queueSummary"] =
    queuePaused !== false ? "paused" : op?.kind === "land" ? "landing" : s.active ? "testing" : s.pending.length || s.solo.length || queued.length ? "waiting" : "idle";

  return {
    ...base,
    complete: problems.length === shownOnly,
    queueSummary,
    queueState: { kind: "ok", seq: s.seq, version: q.version },
    lease,
    op,
    active,
    concurrent,
    pending: s.pending.map((p) => ({ prs: p.prs.map(line), depth: p.depth, lineage: p.lineage })),
    solo: s.solo.map((x) => ({ pr: line(x.pr), reason: x.reason })),
    queued,
    operatorSolo: [...s.operatorSolo],
    held: Object.entries(s.held ?? {}).map(([pr, h]) => ({ pr: Number(pr), sinceMs: since(now, h.since) })),
    verifying: s.verify.map((v) => ({ pr: v.pr, landedIn: v.landedIn, ageMs: since(now, v.since) })),
    outbox: s.outbox.map((o) => ({ id: o.id, kind: o.kind, pr: "pr" in o ? o.pr : null })),
    bounces,
    counters: {
      windowUsed,
      windowBudget: input.windowBudget,
      windowHours: input.windowHours,
      redStreak: s.redStreak,
      bounceStreak: s.bounceStreak,
      lastLandedAt: s.lastLandedAt,
      lastLandedAgeMs: since(now, s.lastLandedAt),
    },
    paused: { queue: queuePaused, release: releasePaused },
  };
}

/** The PRs a Status shows with a title: the active batch, pending, solo and queued (every admitted PR). */
export function prsToTitle(s: State): number[] {
  return [...new Set([...(s.active?.prs ?? []), ...(s.concurrent ?? []).flatMap((a) => a.prs), ...s.pending.flatMap((p) => p.prs), ...s.solo.map((x) => x.pr), ...Object.keys(s.auth).map(Number)])].sort((a, b) => a - b);
}
