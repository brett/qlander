// The release job's state document (DESIGN.md §3.1, §3.2), held on its own
// protected branch, qlander-release-state, with its own lease. Pure: types, an
// empty state, and a strict parser.

import type { Receipt } from "./release";
import { checkEpochBranch, checkLease, type Lease } from "./state";
import type { StateCodec } from "./store";
import type { StateRepoApi } from "./github/api";
import { isSha } from "./validate";

/** The intent of `advance(R → C)`, persisted before the CAS (§3.2). */
export interface AdvanceJournal {
  seq: number;
  op: "advance";
  before: string;
  after: string;
  receipt: Receipt;
  at: string;
}

/**
 * The intent of one workflow dispatch (release.mode dispatch, DESIGN.md
 * §8.1), persisted with its budget reservation before the request. Its
 * receipt is the candidate's DispatchRecord, written in the same state write
 * that drops the journal. A journal left by a crash is never resent: it
 * becomes a record whose `sent` is "unknown", and the run is looked for.
 */
export interface DispatchJournal {
  seq: number;
  op: "dispatch";
  kind: DispatchKind;
  sha: string;
  /** The dispatch id the run's name must echo. */
  id: string;
  at: string;
}

export type ReleaseJournal = AdvanceJournal | DispatchJournal;

export type DispatchKind = "dry" | "real";

/** One dispatched run: its intent's id and time, the receipt, and what was seen of it. */
export interface DispatchRecord {
  kind: DispatchKind;
  id: string;
  /** When the intent was recorded: runs created before it (less a margin) are never matched. */
  at: string;
  /** yes: GitHub answered 204. unknown: the response was lost (or the job crashed), so the run may or may not exist. */
  sent: "yes" | "unknown";
  /** The authenticated run (DESIGN.md §8.1), with GitHub's created_at: the evidence that it started. */
  run: { id: number; url: string; createdAt: string } | null;
  /** The run's conclusion once completed, or what qlander concluded: never-appeared, stuck. Null while in flight. */
  conclusion: string | null;
  /** When the run completed, from its latest attempt's jobs (GitHub's clock); qlander's own clock only for a conclusion it drew itself. */
  concludedAt: string | null;
}

/** The commit being promoted: its qualification receipt, its two runs, and its approval. */
export interface DispatchCandidate {
  sha: string;
  receipt: Receipt;
  since: string;
  dry: DispatchRecord | null;
  /** The status-issue report of its green dry run. */
  reported: { issue: number; comment: number; at: string } | null;
  approval: { comment: number; login: string; id: number; at: string } | null;
  real: DispatchRecord | null;
  /** Dispatches GitHub refused outright (a 4xx: nothing was started); retried while below DISPATCH_REFUSALS. */
  refused: number;
  /** A re-arm (DESIGN.md §8.1): one more attempt for a sha already dispatched, granted by an approver for the incident `incident` (that attempt's dispatch id). */
  rearm: { comment: number; login: string; id: number; incident: string; at: string } | null;
}

export type DispatchOutcome = "released" | "superseded" | "dry-failed" | "expired" | "real-failed" | "not-observed" | "incomplete" | "released-elsewhere";

export interface DispatchHistoryItem {
  at: string;
  sha: string;
  outcome: DispatchOutcome;
  note: string;
  dryRun: number | null;
  realRun: number | null;
}

/** The dispatch mode's document; absent in advance mode, so an advance state is unchanged. */
export interface DispatchState {
  candidate: DispatchCandidate | null;
  /**
   * The newest sha ever dispatched, dry or real, set in the dispatch's intent.
   * A new candidate must be a strict descendant of it, so no sha is dispatched
   * twice however much of `history` is pruned (main only moves forward).
   */
  highWater: string | null;
  /**
   * The last dispatch made (its sha and dispatch id, set in its intent) and
   * when its candidate closed. A re-arm names this id, so it authorises one
   * new attempt after exactly this incident; the new attempt's intent
   * replaces it, which spends the re-arm.
   */
  last: { sha: string; id: string; closedAt: string | null } | null;
  /** When each dispatch was reserved, for release.dispatch.budget. */
  window: string[];
  history: DispatchHistoryItem[];
}

/** Where a candidate is, in words (the status view and the mirror). */
export function candidateStage(c: DispatchCandidate): string {
  const run = (r: DispatchRecord) => (r.run ? `run ${r.run.id}` : r.sent === "unknown" ? "run not found yet, request unconfirmed" : "run not found yet");
  if (c.real) return c.real.conclusion === null ? `real run in flight (${run(c.real)})` : `real run ${c.real.conclusion}; waiting to see release at the commit`;
  if (!c.dry) return c.refused > 0 ? `dry run refused ${c.refused} time(s); retrying` : "dry run not dispatched yet";
  if (c.dry.conclusion === null) return `dry run in flight (${run(c.dry)})`;
  if (c.dry.conclusion !== "success") return `dry run ${c.dry.conclusion}; waiting for a newer candidate`;
  return c.approval ? `approved by ${c.approval.login}; real run not dispatched yet` : `dry run green; waiting for an approval${c.rearm ? ` (re-armed by ${c.rearm.login})` : ""}`;
}

export const emptyDispatchState = (): DispatchState => ({ candidate: null, highWater: null, last: null, window: [], history: [] });

export type ReleaseHistoryOutcome = "advanced" | "not-applied" | "moved" | "rejected";

export interface ReleaseHistoryItem {
  at: string;
  outcome: ReleaseHistoryOutcome;
  from: string;
  to: string;
  note: string;
  receipt: Receipt | null;
}

export interface LastCheck {
  at: string;
  kind: "advance" | "none" | "alert";
  reason: string;
  release: string | null;
  main: string | null;
}

export interface ReleaseState {
  v: 1;
  lease: Lease | null;
  seq: number;
  journal: ReleaseJournal | null;
  /** A pause that must be applied (its issue opened). Pending counts as paused. */
  pausePending: { id: string; reason: string } | null;
  last: LastCheck | null;
  history: ReleaseHistoryItem[];
  /** As State.epochBranch: the branch the last holder fenced on; absent when it wrote without the fence. */
  epochBranch?: string;
  /** The dispatch mode's document (DESIGN.md §8.1); absent until a dispatch-mode tick writes it. */
  dispatch?: DispatchState;
}

export function emptyReleaseState(): ReleaseState {
  return { v: 1, lease: null, seq: 0, journal: null, pausePending: null, last: null, history: [] };
}

class Bad extends Error {}
const fail = (m: string): never => {
  throw new Bad(m);
};
const obj = (x: unknown, w: string, keys: string[]): Record<string, unknown> => {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(`${w}: not an object`);
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${w}: unknown field ${k}`);
  for (const k of keys) if (!(k in o)) fail(`${w}: missing ${k}`);
  return o;
};
const str = (x: unknown, w: string): string => (typeof x === "string" ? x : fail(`${w}: not a string`));
const sha = (x: unknown, w: string): string => (isSha(x) ? x : fail(`${w}: not a sha`));
const int = (x: unknown, w: string): number => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : fail(`${w}: not a non-negative integer`));
const time = (x: unknown, w: string): string => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? x : fail(`${w}: not a time`));
const oneOf = <T extends string>(x: unknown, w: string, vals: readonly T[]): T => (vals.includes(x as T) ? (x as T) : fail(`${w}: not one of ${vals.join(", ")}`));

function epochBranchOf(x: unknown): string {
  try {
    return checkEpochBranch(x);
  } catch (e) {
    return fail(e instanceof Error ? e.message.replace(/^state: /, "") : String(e));
  }
}

/** The shared lease check (owner, until, and the executor that holds it), as a release-state failure. */
function leaseOf(x: unknown): Lease {
  try {
    return checkLease(x);
  } catch (e) {
    return fail(e instanceof Error ? e.message.replace(/^state: /, "") : String(e));
  }
}

function receipt(x: unknown, w: string): Receipt {
  const o = obj(x, w, ["from", "to", "policyBlob", "proofRun", "evidence"]);
  if (!Array.isArray(o.evidence)) fail(`${w}.evidence: not an array`);
  return {
    from: sha(o.from, `${w}.from`),
    to: sha(o.to, `${w}.to`),
    policyBlob: sha(o.policyBlob, `${w}.policyBlob`),
    proofRun: o.proofRun === null ? null : int(o.proofRun, `${w}.proofRun`),
    evidence: (o.evidence as unknown[]).map((e, i) => {
      const ew = `${w}.evidence[${i}]`;
      if (typeof e !== "object" || e === null) fail(`${ew}: not an object`);
      const r = e as Record<string, unknown>;
      for (const k of Object.keys(r)) if (!["workflow", "branch", "run_id", "run_attempt"].includes(k)) fail(`${ew}: unknown field ${k}`);
      return {
        workflow: str(r.workflow, `${ew}.workflow`),
        branch: r.branch === null ? null : str(r.branch, `${ew}.branch`),
        run_id: r.run_id === null ? null : int(r.run_id, `${ew}.run_id`),
        ...(r.run_attempt === undefined ? {} : { run_attempt: int(r.run_attempt, `${ew}.run_attempt`) }),
      };
    }),
  };
}

const KINDS = ["dry", "real"] as const;
const OUTCOMES = ["released", "superseded", "dry-failed", "expired", "real-failed", "not-observed", "incomplete", "released-elsewhere"] as const;
/** The dispatch id format (src/release-dispatch.ts dispatchIdFor). */
export const DISPATCH_ID_RE = /^qlr-(dry|real)-[0-9a-f]{12}-[0-9a-f]{12}$/;
const dispatchId = (x: unknown, w: string): string => (typeof x === "string" && DISPATCH_ID_RE.test(x) ? x : fail(`${w}: not a dispatch id`));
const nullable = <T>(x: unknown, f: (x: unknown) => T): T | null => (x === null ? null : f(x));
const posInt = (x: unknown, w: string): number => (int(x, w) > 0 ? (x as number) : fail(`${w}: not a positive integer`));

function dispatchRecord(x: unknown, w: string): DispatchRecord {
  const o = obj(x, w, ["kind", "id", "at", "sent", "run", "conclusion", "concludedAt"]);
  return {
    kind: oneOf(o.kind, `${w}.kind`, KINDS),
    id: dispatchId(o.id, `${w}.id`),
    at: time(o.at, `${w}.at`),
    sent: oneOf(o.sent, `${w}.sent`, ["yes", "unknown"] as const),
    run: nullable(o.run, (r) => {
      const ro = obj(r, `${w}.run`, ["id", "url", "createdAt"]);
      return { id: posInt(ro.id, `${w}.run.id`), url: str(ro.url, `${w}.run.url`), createdAt: time(ro.createdAt, `${w}.run.createdAt`) };
    }),
    conclusion: nullable(o.conclusion, (c) => str(c, `${w}.conclusion`)),
    concludedAt: nullable(o.concludedAt, (c) => time(c, `${w}.concludedAt`)),
  };
}

function dispatchState(x: unknown): DispatchState {
  const o = obj(x, "dispatch", ["candidate", "highWater", "last", "window", "history"]);
  const candidate = nullable(o.candidate, (c) => {
    const w = "dispatch.candidate";
    const co = obj(c, w, ["sha", "receipt", "since", "dry", "reported", "approval", "real", "refused", "rearm"]);
    const out: DispatchCandidate = {
      sha: sha(co.sha, `${w}.sha`),
      receipt: receipt(co.receipt, `${w}.receipt`),
      since: time(co.since, `${w}.since`),
      dry: nullable(co.dry, (d) => dispatchRecord(d, `${w}.dry`)),
      reported: nullable(co.reported, (r) => {
        const ro = obj(r, `${w}.reported`, ["issue", "comment", "at"]);
        return { issue: posInt(ro.issue, `${w}.reported.issue`), comment: posInt(ro.comment, `${w}.reported.comment`), at: time(ro.at, `${w}.reported.at`) };
      }),
      approval: nullable(co.approval, (a) => {
        const ao = obj(a, `${w}.approval`, ["comment", "login", "id", "at"]);
        return { comment: posInt(ao.comment, `${w}.approval.comment`), login: str(ao.login, `${w}.approval.login`), id: posInt(ao.id, `${w}.approval.id`), at: time(ao.at, `${w}.approval.at`) };
      }),
      real: nullable(co.real, (d) => dispatchRecord(d, `${w}.real`)),
      refused: int(co.refused, `${w}.refused`),
      rearm: nullable(co.rearm, (a) => {
        const ao = obj(a, `${w}.rearm`, ["comment", "login", "id", "incident", "at"]);
        return { comment: posInt(ao.comment, `${w}.rearm.comment`), login: str(ao.login, `${w}.rearm.login`), id: posInt(ao.id, `${w}.rearm.id`), incident: dispatchId(ao.incident, `${w}.rearm.incident`), at: time(ao.at, `${w}.rearm.at`) };
      }),
    };
    if (out.receipt.to !== out.sha) fail(`${w}: receipt does not match the candidate`);
    if (out.dry && out.dry.kind !== "dry") fail(`${w}.dry: not a dry run`);
    if (out.real && out.real.kind !== "real") fail(`${w}.real: not a real run`);
    if (out.real && !(out.dry && out.dry.conclusion === "success" && out.approval)) fail(`${w}: a real run without a green dry run and an approval`);
    return out;
  });
  if (!Array.isArray(o.window)) fail("dispatch.window: not an array");
  const window = (o.window as unknown[]).map((t, i) => time(t, `dispatch.window[${i}]`));
  if (!Array.isArray(o.history)) fail("dispatch.history: not an array");
  const history = (o.history as unknown[]).map((h, i) => {
    const w = `dispatch.history[${i}]`;
    const x = obj(h, w, ["at", "sha", "outcome", "note", "dryRun", "realRun"]);
    return {
      at: time(x.at, `${w}.at`),
      sha: sha(x.sha, `${w}.sha`),
      outcome: oneOf(x.outcome, `${w}.outcome`, OUTCOMES),
      note: str(x.note, `${w}.note`),
      dryRun: nullable(x.dryRun, (r) => posInt(r, `${w}.dryRun`)),
      realRun: nullable(x.realRun, (r) => posInt(r, `${w}.realRun`)),
    };
  });
  const highWater = nullable(o.highWater, (h) => sha(h, "dispatch.highWater"));
  const last = nullable(o.last, (l) => {
    const lo = obj(l, "dispatch.last", ["sha", "id", "closedAt"]);
    return { sha: sha(lo.sha, "dispatch.last.sha"), id: dispatchId(lo.id, "dispatch.last.id"), closedAt: nullable(lo.closedAt, (t) => time(t, "dispatch.last.closedAt")) };
  });
  if (last && last.sha !== highWater) fail("dispatch: the last dispatch is not the high-water mark");
  if (candidate && (candidate.dry || candidate.real) && highWater !== candidate.sha) fail("dispatch: a dispatched candidate that is not the high-water mark");
  return { candidate, highWater, last, window, history };
}

/** Strict: unknown fields, wrong types, a bad sha or another version are refused. */
export function parseReleaseState(text: string): ReleaseState {
  try {
    const raw = JSON.parse(text);
    const optional = raw !== null && typeof raw === "object" ? (["epochBranch", "dispatch"] as const).filter((k) => k in raw) : [];
    const o = obj(raw, "state", ["v", "lease", "seq", "journal", "pausePending", "last", "history", ...optional]);
    if (o.v !== 1) fail(`state: version ${String(o.v)} is not 1`);
    const lease = o.lease === null ? null : leaseOf(o.lease);
    const journal: ReleaseJournal | null = o.journal === null ? null : (o.journal as { op?: unknown }).op === "dispatch" ? (() => {
      const j = obj(o.journal, "journal", ["seq", "op", "kind", "sha", "id", "at"]);
      return { seq: int(j.seq, "journal.seq"), op: "dispatch" as const, kind: oneOf(j.kind, "journal.kind", KINDS), sha: sha(j.sha, "journal.sha"), id: dispatchId(j.id, "journal.id"), at: time(j.at, "journal.at") };
    })() : (() => {
      const j = obj(o.journal, "journal", ["seq", "op", "before", "after", "receipt", "at"]);
      const out: AdvanceJournal = {
        seq: int(j.seq, "journal.seq"),
        op: oneOf(j.op, "journal.op", ["advance"] as const),
        before: sha(j.before, "journal.before"),
        after: sha(j.after, "journal.after"),
        receipt: receipt(j.receipt, "journal.receipt"),
        at: time(j.at, "journal.at"),
      };
      if (out.receipt.from !== out.before || out.receipt.to !== out.after) fail("journal: receipt does not match the op");
      return out;
    })();
    const pausePending = o.pausePending === null ? null : (() => {
      const p = obj(o.pausePending, "pausePending", ["id", "reason"]);
      return { id: str(p.id, "pausePending.id"), reason: str(p.reason, "pausePending.reason") };
    })();
    const last = o.last === null ? null : (() => {
      const l = obj(o.last, "last", ["at", "kind", "reason", "release", "main"]);
      return {
        at: time(l.at, "last.at"),
        kind: oneOf(l.kind, "last.kind", ["advance", "none", "alert"] as const),
        reason: str(l.reason, "last.reason"),
        release: l.release === null ? null : sha(l.release, "last.release"),
        main: l.main === null ? null : sha(l.main, "last.main"),
      };
    })();
    if (!Array.isArray(o.history)) fail("history: not an array");
    const history = (o.history as unknown[]).map((h, i) => {
      const x = obj(h, `history[${i}]`, ["at", "outcome", "from", "to", "note", "receipt"]);
      return {
        at: time(x.at, `history[${i}].at`),
        outcome: oneOf(x.outcome, `history[${i}].outcome`, ["advanced", "not-applied", "moved", "rejected"] as const),
        from: sha(x.from, `history[${i}].from`),
        to: sha(x.to, `history[${i}].to`),
        note: str(x.note, `history[${i}].note`),
        receipt: x.receipt === null ? null : receipt(x.receipt, `history[${i}].receipt`),
      };
    });
    const epochBranch = o.epochBranch === undefined ? {} : { epochBranch: epochBranchOf(o.epochBranch) };
    const dispatch = o.dispatch === undefined ? {} : { dispatch: dispatchState(o.dispatch) };
    return { v: 1, lease, seq: int(o.seq, "seq"), journal, pausePending, last, history, ...epochBranch, ...dispatch };
  } catch (e) {
    if (e instanceof Bad || e instanceof SyntaxError) throw new Error(`release state: ${e.message}`);
    throw e;
  }
}

export function renderReleaseState(s: ReleaseState): string {
  return `<!-- qlander-release-state -->\n\`\`\`json\n${JSON.stringify({ ...s, lease: null }, null, 1)}\n\`\`\``;
}

export const releaseCodec = (mirrorLabel: string): StateCodec<ReleaseState> => ({
  empty: emptyReleaseState,
  parse: parseReleaseState,
  /**
   * The ref is missing. If a mirror issue is open, the ref existed and was
   * lost: do not start from empty (that could forget an unreconciled
   * advance). An operator decides.
   */
  refuseInit: async (repo: StateRepoApi) => {
    const open = await repo.listOpenIssues(mirrorLabel);
    if (open.issues.length > 0) return `the release state branch is missing but release state issue #${open.issues[0]!.number} exists; refusing to initialise`;
    if (!open.complete) return "the release state branch is missing and the release state issues could not all be listed; refusing to initialise";
    return null;
  },
});
