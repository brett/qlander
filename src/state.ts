// The state document held in qlander's state issue (DESIGN.md §3). Pure:
// types, an empty state, a strict parser and a serialiser.

import type { Cancel } from "./classify";
import { type HooksState, hooksStateProblem } from "./hooks";
import type { FailedJob, RunRef } from "./types";
import type { Names } from "./config";
import { BRANCH_NAME_RE, isCommandLabel, isGitBranchName, isPrNumber, isSha, isWritableRef } from "./validate";

export interface Pin {
  pr: number;
  head: string;
}

export interface Auth {
  head: string;
  baseRepoId: number;
  policy: string; // config hash at admission
  policyPr: boolean;
  admittedAt: string;
  labelledAt: string;
  evidence: string[]; // human-readable proof references (run ids, check ids, comment ids)
  /** The review run that proved this head (job@main), re-checked first on every revalidation. */
  reviewRun: number | null;
  /** The PR author's login at admission (optional; for hook payloads only). */
  author?: string;
  /** Optional (absent in older documents): admitted under a trusted-automation waiver (src/automation.ts). */
  waiver?: Waiver;
  /**
   * Optional (absent while it does not carry the priority label, DESIGN.md
   * §4.4): who applied the label, and when. Refreshed from the PR on every
   * tick, so removing the label returns the PR to its FIFO place.
   */
  priority?: { by: string; at: string };
  /**
   * Linear landing only (optional; absent in merge mode, DESIGN.md §7.4):
   * the PR's head branch at admission. The landing moves exactly this branch,
   * and only from `head`; revalidation drops the PR if it changes.
   */
  headRef?: string;
}

/** How many squashed commits a state keeps, and how many one PR may carry in linear mode (DESIGN.md §7.4). */
export const SQUASHED_MAX = 1000;
export const OWN_MAX = 250;

/**
 * One commit of a linear stack (DESIGN.md §7.4): PR `pr`'s changes squashed
 * onto `parent` (the previous stack commit, or the batch's base), with the
 * tree of the build's merge commit for it. Its sha binds both.
 */
export interface StackCommit {
  pr: number;
  commit: string;
  parent: string;
  tree: string;
  /** The commits the PR carries beyond the batch's base and the entries before this one, as commitPrefix: what state.squashed gains if it lands. */
  own: string[];
}

/** What a trusted automation was let skip, recorded at admission. */
export interface Waiver {
  rule: "trusted-automation";
  login: string;
  id: number;
  /** Its own `ready` counted (no writer applied it). */
  readyByBot: boolean;
  /** A CI-policy change landed without an approval comment. */
  policyWaived: boolean;
  files: string[];
  globs: string[];
}

export interface Active {
  n: number;
  base: string;
  head: string;
  depth: number;
  prs: number[];
  lineage: number;
  rerun: RunRef[] | null;
  /** When the rerun was requested: the attempt barrier is bounded from here. */
  rerunAt: string | null;
  cancels: Cancel[];
  builtAt: string;
  /**
   * The failed jobs of the red run that was rerun (optional): if the rerun
   * passes they were flaky, reported by the `flaky` hook event and recorded
   * by flaky tracking (src/flaky.ts). Cleared once recorded.
   */
  redJobs?: FailedJob[];
  /**
   * Speculative (optional; absent for a batch built on main): this batch was
   * built on top of batch `on`'s head while that batch's CI ran (DESIGN.md
   * §5.6). It lands only after batch `on` has landed, by a fast-forward from
   * that head; if batch `on` ends any other way it is discarded.
   */
  on?: number;
  /** Linear landing only (optional, DESIGN.md §7.4): the stack, one commit per PR in `prs` order; `head` is the last. */
  stack?: StackCommit[];
  /**
   * The manifest runs seen for this batch (optional; absent until one is
   * seen, DESIGN.md §6.2): a run once seen is read again by id when a later
   * run listing leaves it out, so a gap in the listing never reads as no run.
   */
  seen?: SeenRun[];
}

/** A pre-landing run seen at a batch's head on its queue branch: its id and workflow path. */
export interface SeenRun {
  runId: number;
  path: string;
}

export interface Pending {
  prs: number[];
  depth: number;
  lineage: number;
}

export interface Solo {
  pr: number;
  lineage: number;
  reason: "split" | "policy" | "operator";
}

export interface VerifyItem {
  pr: number;
  pin: string;
  landedIn: string;
  since: string;
  ticks: number;
  notified: boolean;
  /**
   * Linear landing only (optional, DESIGN.md §7.4): the head the PR was
   * admitted at. `pin` is then its stack commit, the commit its branch was
   * moved to and that main contains.
   */
  admitted?: string;
}

export interface BuildRecord {
  survivors: Pin[];
  /** `squashed`: refused for commits that landed squashed (DESIGN.md §7.4); `commit` is the newest such commit it carries, absent when it has too many commits to tell. */
  dropped: { pr: number; pin: string; outcome: "conflict" | "noop" | "squashed"; commit?: string }[];
  chainHead: string | null; // null when nothing survived
  /** Linear landing only (optional, DESIGN.md §7.4): one stack commit per survivor, in order; chainHead is the last. */
  stack?: StackCommit[];
}

export type BuildSource =
  | { kind: "pending"; item: Pending }
  | { kind: "solo"; item: Solo }
  | { kind: "candidates" };

export type Op =
  | { kind: "build"; n: number; base: string; pins: Pin[]; depth: number; lineage: number; source: BuildSource; rebuild: boolean }
  | { kind: "rerun"; runs: RunRef[]; done?: RunRef[]; requested?: RerunRequest[]; everSent?: boolean }
  /** `heads`: linear landing only (DESIGN.md §7.4), each PR branch the landing moves from its admitted head to its stack commit, just before main. */
  | { kind: "land"; before: string; after: string; heads?: HeadMove[]; refused?: number }
  | { kind: "cancel"; runs: RunRef[]; cause: "timeout" | "starved" };

/** One PR head branch a linear landing moves (DESIGN.md §7.4): `ref` from `before` (the admitted head) to `after` (its stack commit), and back if the landing does not complete. */
export interface HeadMove {
  pr: number;
  ref: string;
  before: string;
  after: string;
}

/** A rerun request that was (or may have been) sent, awaiting confirmation that its attempt advanced. */
export interface RerunRequest extends RunRef {
  at: string;
}

export interface Journal {
  seq: number;
  op: Op;
  reserved: boolean;
  at: string;
  checkpoint: BuildRecord | null;
  /** How many times recovery has re-executed this op; bounded by config.maxOpTries. */
  tries: number;
}

/** Durable, idempotent side effects drained by the runner (comment markers carry `id`). */
export type Notice =
  | { id: string; kind: "comment"; pr: number; body: string; sentAt?: string; commentId?: number }
  | { id: string; kind: "unready"; pr: number }
  /** Remove an operator command label once the command is applied (DESIGN.md §10). */
  | { id: string; kind: "unlabel"; pr: number; label: string }
  | { id: string; kind: "pause"; reason: string }
  | { id: string; kind: "cancelRuns"; ref: string; head: string; until: string; giveUpAt: string; seen?: number[] }
  | { id: string; kind: "deleteRef"; ref: string }
  | { id: string; kind: "createRef"; ref: string; head: string }
  /** Open or update one `flaky` issue per item key in this repo (src/flaky.ts). Best effort: never pauses. */
  | { id: string; kind: "flaky"; n: number; at: string; giveUpAt: string; runs: RunRef[]; items: FlakyItem[]; done?: string[] }
  /**
   * Close the issues in the target that a landed PR says it closes, with a
   * comment naming the PR (src/outbox.ts, `linkedIssues.close`). Best effort:
   * never pauses. `sent`: issues whose comment may have been posted (never
   * posted again); `done`: issues finished.
   */
  | { id: string; kind: "closeIssues"; pr: number; landedIn: string; giveUpAt: string; sent?: number[]; done?: number[] };

/** One flaky failure: a test id parsed from the job log, or the job name when none was. */
export interface FlakyItem {
  key: string;
  byJob: boolean;
  job: string;
  url: string;
}

/** A batch whose rerun passed, kept for the weekly count on the status issue. */
export interface FlakeMark {
  at: string;
  n: number;
  /** How many flaky items (tests, or jobs) the batch had. */
  count: number;
  /** The first few of their keys, short, for the status issue. */
  keys: string[];
}

export interface HistoryItem {
  n: number;
  at: string;
  outcome: "landed" | "split" | "bounced" | "solo" | "abandoned" | "rebuilt" | "paused" | "empty" | "flaky";
  prs: number[];
  head: string | null;
  note: string;
  failedJobs?: FailedJob[];
  /** flaky: the first attempt's failed runs (the rerun is the next attempt of each). */
  runs?: RunRef[];
}

export interface Executor {
  runId: number;
  attempt: number;
  job: string;
}

export interface Lease {
  owner: string;
  until: string;
  /** When the lease was taken, by GitHub's clock. */
  acquiredAt?: string;
  /** The Actions job holding it: takeover waits until that job is completed (DESIGN.md §15). */
  executor?: Executor | null;
}

export interface State {
  v: 5;
  /** The runner that holds the whole-tick lease, and until when (DESIGN.md §15). */
  lease: Lease | null;
  seq: number;
  nextLineage: number;
  journal: Journal | null;
  /** The batch a non-build journalled op concerns, or the only one running. */
  active: Active | null;
  auth: Record<string, Auth>;
  pending: Pending[];
  solo: Solo[];
  operatorSolo: number[];
  /** Run counters per lineage. `preempted` (optional): its batch was cancelled once for a priority PR (DESIGN.md §4.4), and is not cancelled again. */
  lineages: Record<string, { runs: number; preempted?: true }>;
  window: { at: string; cost: number }[];
  redStreak: number;
  bounceStreak: number;
  lastLandedAt: string | null;
  verify: VerifyItem[];
  outbox: Notice[];
  history: HistoryItem[];
  /**
   * Fill timer (optional; absent in older documents, read as empty): when each
   * ready PR first became eligible at this head and ready label. It survives a
   * revalidation drop that deletes its auth (unknown mergeability is a hold),
   * so admission churn cannot restart the clock. Pruned once the PR is no
   * longer ready at that head.
   */
  eligibleSince?: Record<string, { head: string; labelledAt: string; since: string }>;
  /** An operator `go` waiting for the next fresh selection (optional; absent means none). */
  go?: true;
  /**
   * Mergeability holds (optional; absent while there are none): each ready PR
   * whose mergeability GitHub had not computed (null) at the last unpaused
   * tick, and since when at this head. An admitted PR is held, not dropped,
   * for up to HOLD_MINUTES (src/machine.ts); a young hold makes the tick
   * re-tick soon (src/wake.ts). Rewritten by every unpaused decision.
   */
  held?: Record<string, { head: string; since: string }>;
  /** When GitHub's generic GraphQL error ended a recent tick (optional; absent while there are none). src/queue.ts. */
  internalErrors?: string[];
  /** Lifecycle hook deliveries (optional; absent while no hook has matched an event). src/hooks.ts. */
  hooks?: HooksState;
  /**
   * Further running batches (optional; absent while at most one batch runs,
   * so a queue without queue.concurrency never writes it), in batch-number
   * order, beside `active` (DESIGN.md §5.6). Never present while `active` is null.
   */
  concurrent?: Active[];
  /**
   * Flaky batches of the last FLAKE_DAYS days. Absent until the first flake,
   * so state without it (written before flaky tracking) loads unchanged.
   */
  flakes?: FlakeMark[];
  /**
   * The epoch branch the last lease holder fenced its ref writes on
   * (docs/deployment.md §3.4). Absent: it wrote without the epoch fence. It
   * outlives the lease, because a holder can still hold authority on its
   * branch after its lease is released (a successor's epoch advance failed,
   * or a write was still in flight), so a successor whose own branch differs
   * voids this one first.
   */
  epochBranch?: string;
  /**
   * queue.strategy (DESIGN.md §5.7), each absent unless its key is on and it
   * has something to hold. They were staged (§8.1.1): a reader first, then
   * each key's writer. skipSeenRed writes seenRed (src/machine.ts, src/ops.ts),
   * reuseGreen writes parked (src/machine.ts), adaptive writes adaptive
   * (src/machine.ts, src/ops.ts).
   *
   * seenRed (queue.strategy.skipSeenRed): multi-PR compositions seen red on
   * the current main, each as the PRs still to land on top of `base`.
   */
  seenRed?: SeenRed[];
  /**
   * The commits PRs carried when they landed squashed (optional; absent until
   * a linear landing, DESIGN.md §7.4), as commitPrefix, newest last, at most
   * SQUASHED_MAX. A fact about main's history, so switching to merge mode keeps
   * it, and the build refuses a PR carrying any of them in either mode.
   */
  squashed?: string[];
  /** queue.strategy.reuseGreen: the last batch abandoned as the queue paused, so a later tick may land its run if that went green. */
  parked?: Parked;
  /** queue.strategy.adaptive: the fresh batch size limit now, and the green landings counted towards growing it. */
  adaptive?: { size: number; greens: number };
  /** queue.strategy.mainBaseline: a run of the suite on main alone, and the PRs set aside because they fail only what it fails. */
  baseline?: Baseline;
  /** queue.strategy.mainBaseline: PRs that failed alone on this main while main's own run did not, and those given a second test for it (DESIGN.md §5.7). */
  aloneRed?: AloneRed;
}

/** What a run of main alone showed. `byJob`: jobs that can match by name only (src/baseline.ts). */
export interface BaselineResult {
  red: boolean;
  jobs: string[];
  tests: string[];
  byJob: string[];
}

/** The most PRs remembered in each list of aloneRed: the newest. */
export const ALONE_RED_MAX = 8;

/**
 * queue.strategy.mainBaseline (DESIGN.md §5.7), on main `base`: what each PR
 * failed alone (after its rerun) while main's own run with no PR in it was
 * not red, and the pins tested alone a second time because another PR failed
 * the same tests. A pin is retried once.
 */
export interface AloneRed {
  base: string;
  seen: { pr: number; n: number; result: BaselineResult }[];
  /** Each retried pin, with the other PR and the failures the two shared, as they were when it was retried. */
  retried: AloneRetry[];
}

export interface AloneRetry {
  pr: number;
  head: string;
  /** The PR that failed the same alone first. */
  other: number;
  /** The shared failures: test ids, or job names where none compare. */
  failing: string[];
}

/** queue.strategy.mainBaseline (DESIGN.md §5.7): queue/<n> at main's own commit `base`, with no PR in it. */
export interface Baseline {
  n: number;
  base: string;
  builtAt: string;
  /** The batch this run was started for: it uses a result that isn't red. */
  forBatch: number;
  /** Absent while its run is going. */
  result?: BaselineResult;
  /** PRs that fail only what main fails, still admitted, and not built again until main moves or the queue resumes. */
  held: Pin[];
  /** It paused the queue: a resume ends it, so a person's retry is a real retry. */
  stopped?: true;
}

/** A batch seen red, reduced to the PRs (pinned heads, in order) whose merge on top of `base` gives that batch's tree. */
export interface SeenRed {
  /** The red batch it comes from. */
  n: number;
  base: string;
  pins: Pin[];
}

/** A batch abandoned as the queue paused (queue.strategy.reuseGreen). */
export interface Parked {
  n: number;
  base: string;
  head: string;
  pins: Pin[];
  depth: number;
  lineage: number;
  builtAt: string;
  /** Linear landing only (optional): the parked batch's stack, landed with it. */
  stack?: StackCommit[];
}

/** How long a flake counts towards the weekly figure. */
export const FLAKE_DAYS = 7;

export function emptyState(): State {
  return {
    v: 5,
    lease: null,
    seq: 0,
    nextLineage: 1,
    journal: null,
    active: null,
    auth: {},
    pending: [],
    solo: [],
    operatorSolo: [],
    lineages: {},
    window: [],
    redStreak: 0,
    bounceStreak: 0,
    lastLandedAt: null,
    verify: [],
    outbox: [],
    history: [],
  };
}

/**
 * Is a build record consistent with its op and the authorisations? Survivors
 * and dropped PRs must partition the pins exactly, each with its pinned head,
 * every pin must be the authorised head, and chainHead is null exactly when
 * nothing survived. Returns the problem, or null. Used by the parser, by
 * applyOpResult (checkpoint and built) and by recovery.
 */
export function buildRecordProblem(
  op: { pins: Pin[]; base?: string },
  rec: BuildRecord,
  auth: Record<string, Auth> | undefined,
): string | null {
  const pinned = new Map(op.pins.map((p) => [p.pr, p.head]));
  const seen = new Set<number>();
  for (const s of rec.survivors) {
    if (pinned.get(s.pr) !== s.head) return `survivor #${s.pr} head ${s.head} does not match its pin`;
    if (seen.has(s.pr)) return `#${s.pr} recorded twice`;
    seen.add(s.pr);
  }
  for (const d of rec.dropped) {
    if (pinned.get(d.pr) !== d.pin) return `dropped #${d.pr} pin ${d.pin} does not match its pin`;
    if (seen.has(d.pr)) return `#${d.pr} recorded twice`;
    seen.add(d.pr);
  }
  if (seen.size !== pinned.size) return "the record does not account for every pinned PR";
  if ((rec.chainHead === null) !== (rec.survivors.length === 0)) return "chainHead and survivors disagree";
  if (rec.stack !== undefined) {
    const problem = stackProblem(rec.stack, rec.survivors.map((p) => p.pr), op.base);
    if (problem) return problem;
    if (rec.stack.at(-1)?.commit !== (rec.chainHead ?? undefined)) return "the stack's last commit is not chainHead";
  }
  if (auth) {
    for (const p of op.pins) {
      if (auth[String(p.pr)]?.head !== p.head) return `pin #${p.pr} ${p.head} is not the authorised head`;
    }
  }
  return null;
}

/**
 * Is a linear stack (DESIGN.md §7.4) one commit per PR, in order, each on the
 * one before, the first on `base` (when given)? Returns the problem, or null.
 */
export function commitPrefix(commit: string): string {
  return commit.slice(0, 12);
}

export function stackProblem(stack: StackCommit[], prs: number[], base?: string): string | null {
  if (stack.length !== prs.length || stack.some((x, i) => x.pr !== prs[i])) return "the stack does not have one commit per PR, in order";
  for (let i = 0; i < stack.length; i++) {
    const want = i === 0 ? base : stack[i - 1]!.commit;
    if (want !== undefined && stack[i]!.parent !== want) return `stack commit for #${stack[i]!.pr} is not on ${i === 0 ? "the base" : "the commit before it"}`;
  }
  if (new Set(stack.map((x) => x.commit)).size !== stack.length) return "a stack commit twice";
  return null;
}

// ---------------------------------------------------------------- strict parser

function fail(msg: string): never {
  throw new Error(`state: ${msg}`);
}

type O = Record<string, unknown>;

function obj(x: unknown, where: string, keys: string[], optional: string[] = []): O {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(`${where}: not an object`);
  const o = x as O;
  for (const k of Object.keys(o)) if (!keys.includes(k) && !optional.includes(k)) fail(`${where}: unexpected key '${k}'`);
  for (const k of keys) if (!(k in o)) fail(`${where}: missing '${k}'`);
  return o;
}

/** A string-keyed map (keys checked by the caller). */
function map(x: unknown, where: string): O {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(`${where}: not an object`);
  return x as O;
}

function arr(x: unknown, where: string): unknown[] {
  if (!Array.isArray(x)) fail(`${where}: not an array`);
  return x;
}

function int(x: unknown, where: string, min = 0): number {
  if (typeof x !== "number" || !Number.isSafeInteger(x) || x < min) fail(`${where}: not an integer >= ${min}`);
  return x;
}

function str(x: unknown, where: string): string {
  if (typeof x !== "string") fail(`${where}: not a string`);
  return x;
}

function bool(x: unknown, where: string): boolean {
  if (typeof x !== "boolean") fail(`${where}: not a boolean`);
  return x;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
function iso(x: unknown, where: string): string {
  if (typeof x !== "string" || !ISO_RE.test(x) || Number.isNaN(Date.parse(x))) fail(`${where}: not a UTC timestamp`);
  return x;
}

function sha(x: unknown, where: string): string {
  if (!isSha(x)) fail(`${where}: bad sha`);
  return x;
}

function pr(x: unknown, where: string): number {
  if (!isPrNumber(x)) fail(`${where}: bad PR number`);
  return x;
}

function oneOf<T extends string>(x: unknown, where: string, values: readonly T[]): T {
  if (typeof x !== "string" || !values.includes(x as T)) fail(`${where}: not one of ${values.join("|")}`);
  return x as T;
}

function prList(x: unknown, where: string): number[] {
  const a = arr(x, where).map((p, i) => pr(p, `${where}[${i}]`));
  if (a.length === 0) fail(`${where}: empty`);
  if (new Set(a).size !== a.length) fail(`${where}: duplicate PR`);
  return a;
}

function runRefs(x: unknown, where: string, nonEmpty: boolean): void {
  const a = arr(x, where);
  if (nonEmpty && a.length === 0) fail(`${where}: empty`);
  a.forEach((r, i) => {
    const o = obj(r, `${where}[${i}]`, ["runId", "attempt"]);
    int(o.runId, `${where}[${i}].runId`, 1);
    int(o.attempt, `${where}[${i}].attempt`, 1);
  });
}

function pins(x: unknown, where: string, nonEmpty: boolean): number[] {
  const a = arr(x, where);
  if (nonEmpty && a.length === 0) fail(`${where}: empty`);
  return a.map((p, i) => {
    const o = obj(p, `${where}[${i}]`, ["pr", "head"]);
    sha(o.head, `${where}[${i}].head`);
    return pr(o.pr, `${where}[${i}].pr`);
  });
}

function prefixes(x: unknown, where: string): void {
  arr(x, where).forEach((p, i) => {
    if (typeof p !== "string" || !/^[0-9a-f]{12}$/.test(p)) fail(`${where}[${i}]: not a commit prefix`);
  });
}

function stackList(x: unknown, where: string, prs: number[], base: string): void {
  const list = arr(x, where);
  list.forEach((e, i) => {
    const o = obj(e, `${where}[${i}]`, ["pr", "commit", "parent", "tree", "own"]);
    pr(o.pr, `${where}[${i}].pr`);
    prefixes(o.own, `${where}[${i}].own`);
    sha(o.commit, `${where}[${i}].commit`);
    sha(o.parent, `${where}[${i}].parent`);
    sha(o.tree, `${where}[${i}].tree`);
  });
  const problem = stackProblem(list as StackCommit[], prs, base);
  if (problem) fail(`${where}: ${problem}`);
}

function pendingItem(x: unknown, where: string): number[] {
  const o = obj(x, where, ["prs", "depth", "lineage"]);
  int(o.depth, `${where}.depth`);
  int(o.lineage, `${where}.lineage`, 1);
  return prList(o.prs, `${where}.prs`);
}

function soloItem(x: unknown, where: string): number {
  const o = obj(x, where, ["pr", "lineage", "reason"]);
  int(o.lineage, `${where}.lineage`, 1);
  oneOf(o.reason, `${where}.reason`, ["split", "policy", "operator"] as const);
  return pr(o.pr, `${where}.pr`);
}

function checkOp(x: unknown, where: string): string {
  const kind = oneOf((x as O)?.kind, `${where}.kind`, ["build", "rerun", "land", "cancel"] as const);
  if (kind === "build") {
    const o = obj(x, where, ["kind", "n", "base", "pins", "depth", "lineage", "source", "rebuild"]);
    int(o.n, `${where}.n`, 1);
    sha(o.base, `${where}.base`);
    pins(o.pins, `${where}.pins`, true);
    int(o.depth, `${where}.depth`);
    int(o.lineage, `${where}.lineage`, 1);
    bool(o.rebuild, `${where}.rebuild`);
    const src = o.source as O;
    const sk = oneOf(src?.kind, `${where}.source.kind`, ["pending", "solo", "candidates"] as const);
    if (sk === "pending") pendingItem(obj(src, `${where}.source`, ["kind", "item"]).item, `${where}.source.item`);
    else if (sk === "solo") soloItem(obj(src, `${where}.source`, ["kind", "item"]).item, `${where}.source.item`);
    else obj(src, `${where}.source`, ["kind"]);
  } else if (kind === "rerun") {
    const o = obj(x, where, ["kind", "runs"], ["done", "requested", "everSent"]);
    if (o.everSent !== undefined) bool(o.everSent, `${where}.everSent`);
    runRefs(o.runs, `${where}.runs`, false);
    if (o.done !== undefined) runRefs(o.done, `${where}.done`, false);
    if (o.requested !== undefined) {
      arr(o.requested, `${where}.requested`).forEach((r, i) => {
        const q = obj(r, `${where}.requested[${i}]`, ["runId", "attempt", "at"]);
        int(q.runId, `${where}.requested[${i}].runId`, 1);
        int(q.attempt, `${where}.requested[${i}].attempt`, 1);
        iso(q.at, `${where}.requested[${i}].at`);
      });
    }
    const total = (o.runs as unknown[]).length + ((o.done as unknown[] | undefined)?.length ?? 0) + ((o.requested as unknown[] | undefined)?.length ?? 0);
    if (total === 0) fail(`${where}: a rerun of nothing`);
  } else if (kind === "land") {
    const o = obj(x, where, ["kind", "before", "after"], ["heads", "refused"]);
    if (o.refused !== undefined && (int(o.refused, `${where}.refused`, 1), o.heads === undefined)) fail(`${where}.refused: only on a linear landing`);
    sha(o.before, `${where}.before`);
    sha(o.after, `${where}.after`);
    if (o.heads !== undefined) {
      const heads = arr(o.heads, `${where}.heads`);
      if (heads.length === 0) fail(`${where}.heads: empty (absent in merge mode)`);
      heads.forEach((h, i) => {
        const m = obj(h, `${where}.heads[${i}]`, ["pr", "ref", "before", "after"]);
        pr(m.pr, `${where}.heads[${i}].pr`);
        if (!isGitBranchName(str(m.ref, `${where}.heads[${i}].ref`))) fail(`${where}.heads[${i}].ref: bad`);
        sha(m.before, `${where}.heads[${i}].before`);
        sha(m.after, `${where}.heads[${i}].after`);
      });
    }
  } else {
    const o = obj(x, where, ["kind", "runs", "cause"]);
    runRefs(o.runs, `${where}.runs`, true);
    oneOf(o.cause, `${where}.cause`, ["timeout", "starved"] as const);
  }
  return kind;
}

function checkNotice(x: unknown, where: string, names: Names): void {
  const kind = oneOf((x as O)?.kind, `${where}.kind`, ["comment", "unready", "unlabel", "pause", "cancelRuns", "deleteRef", "createRef", "flaky", "closeIssues"] as const);
  if (kind === "flaky") return checkFlakyNotice(x, where);
  if (kind === "closeIssues") return checkCloseIssuesNotice(x, where);
  const fields: Record<typeof kind, string[]> = {
    comment: ["id", "kind", "pr", "body"],
    unready: ["id", "kind", "pr"],
    unlabel: ["id", "kind", "pr", "label"],
    pause: ["id", "kind", "reason"],
    cancelRuns: ["id", "kind", "ref", "head", "until", "giveUpAt"],
    deleteRef: ["id", "kind", "ref"],
    createRef: ["id", "kind", "ref", "head"],
  };
  const o = obj(x, where, fields[kind], kind === "comment" ? ["sentAt", "commentId"] : kind === "cancelRuns" ? ["seen"] : []);
  if ("giveUpAt" in o) iso(o.giveUpAt, `${where}.giveUpAt`);
  if (o.seen !== undefined) arr(o.seen, `${where}.seen`).forEach((r, i) => int(r, `${where}.seen[${i}]`, 1));
  str(o.id, `${where}.id`);
  if (o.sentAt !== undefined) iso(o.sentAt, `${where}.sentAt`);
  if (o.commentId !== undefined) int(o.commentId, `${where}.commentId`, 1);
  if ("until" in o) iso(o.until, `${where}.until`);
  if ("pr" in o) pr(o.pr, `${where}.pr`);
  if ("body" in o) str(o.body, `${where}.body`);
  if ("reason" in o) str(o.reason, `${where}.reason`);
  if ("label" in o && !isCommandLabel(names, str(o.label, `${where}.label`))) fail(`${where}.label: not a command label`);
  if ("head" in o) sha(o.head, `${where}.head`);
  if ("ref" in o && !isWritableRef(names, str(o.ref, `${where}.ref`), "queue")) fail(`${where}.ref: not a qlander ref`);
}

function failedJobs(x: unknown, where: string): void {
  arr(x, where).forEach((j, i) => {
    const o = obj(j, `${where}[${i}]`, ["name", "url"], ["id", "tests"]);
    str(o.name, `${where}[${i}].name`);
    str(o.url, `${where}[${i}].url`);
    if (o.id !== undefined) int(o.id, `${where}[${i}].id`, 1);
    if (o.tests !== undefined) arr(o.tests, `${where}[${i}].tests`).forEach((t, k) => str(t, `${where}[${i}].tests[${k}]`));
  });
}

function checkCloseIssuesNotice(x: unknown, where: string): void {
  const o = obj(x, where, ["id", "kind", "pr", "landedIn", "giveUpAt"], ["sent", "done"]);
  str(o.id, `${where}.id`);
  pr(o.pr, `${where}.pr`);
  sha(o.landedIn, `${where}.landedIn`);
  iso(o.giveUpAt, `${where}.giveUpAt`);
  for (const k of ["sent", "done"] as const) if (o[k] !== undefined) arr(o[k], `${where}.${k}`).forEach((n, i) => pr(n, `${where}.${k}[${i}]`));
}

function checkFlakyNotice(x: unknown, where: string): void {
  const o = obj(x, where, ["id", "kind", "n", "at", "giveUpAt", "runs", "items"], ["done"]);
  if (o.done !== undefined) arr(o.done, `${where}.done`).forEach((k, i) => str(k, `${where}.done[${i}]`));
  str(o.id, `${where}.id`);
  int(o.n, `${where}.n`, 1);
  iso(o.at, `${where}.at`);
  iso(o.giveUpAt, `${where}.giveUpAt`);
  runRefs(o.runs, `${where}.runs`, false);
  arr(o.items, `${where}.items`).forEach((it, i) => {
    const t = obj(it, `${where}.items[${i}]`, ["key", "byJob", "job", "url"]);
    if (str(t.key, `${where}.items[${i}].key`).length === 0) fail(`${where}.items[${i}].key: empty`);
    bool(t.byJob, `${where}.items[${i}].byJob`);
    str(t.job, `${where}.items[${i}].job`);
    str(t.url, `${where}.items[${i}].url`);
  });
}

/**
 * Strict parse (DESIGN.md §3.1, §11): the whole nested schema, numeric bounds,
 * timestamps, op variants, and the relationships between parts. Any failure
 * throws; the runner pauses rather than act on corrupt state (loadState).
 */
/** A state document's epochBranch: a branch name git accepts. Shared by the queue's and the release job's state. */
export function checkEpochBranch(x: unknown): string {
  const b = str(x, "epochBranch");
  if (!BRANCH_NAME_RE.test(b) || b.split("/").some((c) => c.endsWith(".lock"))) fail("epochBranch: bad");
  return b;
}

/** The whole-tick lease, strictly; shared by the queue's and the release job's state documents. */
export function checkLease(x: unknown): Lease {
  const l = obj(x, "lease", ["owner", "until"], ["acquiredAt", "executor"]);
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(str(l.owner, "lease.owner"))) fail("lease.owner: bad");
  iso(l.until, "lease.until");
  if (l.acquiredAt !== undefined) iso(l.acquiredAt, "lease.acquiredAt");
  if (l.executor !== undefined && l.executor !== null) {
    const e = obj(l.executor, "lease.executor", ["runId", "attempt", "job"]);
    int(e.runId, "lease.executor.runId", 1);
    int(e.attempt, "lease.executor.attempt", 1);
    if (!/^[A-Za-z0-9 ._:-]{1,80}$/.test(str(e.job, "lease.executor.job"))) fail("lease.executor.job: bad");
  }
  return l as unknown as Lease;
}

/** One running batch, strictly (state.active, or an entry of state.concurrent). */
function checkActive(x: unknown, where: string): O {
  const a = obj(x, where, ["n", "base", "head", "depth", "prs", "lineage", "rerun", "rerunAt", "cancels", "builtAt"], ["redJobs", "on", "stack", "seen"]);
  if (a.redJobs !== undefined) failedJobs(a.redJobs, `${where}.redJobs`);
  if (a.seen !== undefined) {
    const seen = arr(a.seen, `${where}.seen`);
    if (seen.length === 0) fail(`${where}.seen: empty (absent when no run was seen)`);
    seen.forEach((x, i) => {
      const o = obj(x, `${where}.seen[${i}]`, ["runId", "path"]);
      int(o.runId, `${where}.seen[${i}].runId`, 1);
      if (str(o.path, `${where}.seen[${i}].path`) === "") fail(`${where}.seen[${i}].path: empty`);
    });
    if (new Set(seen.map((x) => (x as O).runId)).size !== seen.length) fail(`${where}.seen: duplicate run`);
  }
  if (a.on !== undefined && int(a.on, `${where}.on`, 1) >= int(a.n, `${where}.n`, 1)) fail(`${where}.on: not an earlier batch`);
  if (a.rerunAt !== null) iso(a.rerunAt, `${where}.rerunAt`);
  int(a.n, `${where}.n`, 1);
  sha(a.base, `${where}.base`);
  sha(a.head, `${where}.head`);
  int(a.depth, `${where}.depth`);
  int(a.lineage, `${where}.lineage`, 1);
  if (a.rerun !== null) runRefs(a.rerun, `${where}.rerun`, true);
  arr(a.cancels, `${where}.cancels`).forEach((c, i) => {
    const o = obj(c, `${where}.cancels[${i}]`, ["runId", "attempt", "cause"]);
    int(o.runId, `${where}.cancels[${i}].runId`, 1);
    int(o.attempt, `${where}.cancels[${i}].attempt`, 1);
    oneOf(o.cause, `${where}.cancels[${i}].cause`, ["timeout", "starved"] as const);
  });
  iso(a.builtAt, `${where}.builtAt`);
  const prs = prList(a.prs, `${where}.prs`);
  if (a.stack !== undefined) {
    stackList(a.stack, `${where}.stack`, prs, a.base as string);
    if ((a.stack as StackCommit[]).at(-1)!.commit !== a.head) fail(`${where}.stack: its last commit is not the head`);
  }
  return a;
}

/** Pins with distinct PRs, at least `min` of them. */
function distinctPins(x: unknown, where: string, min: number): void {
  const prs = pins(x, where, true);
  if (prs.length < min) fail(`${where}: fewer than ${min}`);
  if (new Set(prs).size !== prs.length) fail(`${where}: duplicate PR`);
}

/** queue.strategy's optional fields (DESIGN.md §5.7): read and kept as they are. */
function checkStrategyState(s: O): void {
  if (s.squashed !== undefined) {
    prefixes(s.squashed, "squashed");
    if ((s.squashed as string[]).length === 0) fail("squashed: empty (absent when there is none)");
    if ((s.squashed as string[]).length > SQUASHED_MAX) fail(`squashed: more than ${SQUASHED_MAX}`);
  }
  if (s.seenRed !== undefined) {
    const list = arr(s.seenRed, "seenRed");
    if (list.length === 0) fail("seenRed: empty (absent when there is none)");
    list.forEach((x, i) => {
      const o = obj(x, `seenRed[${i}]`, ["n", "base", "pins"]);
      int(o.n, `seenRed[${i}].n`, 1);
      sha(o.base, `seenRed[${i}].base`);
      distinctPins(o.pins, `seenRed[${i}].pins`, 2);
    });
  }
  if (s.parked !== undefined) {
    const o = obj(s.parked, "parked", ["n", "base", "head", "pins", "depth", "lineage", "builtAt"], ["stack"]);
    int(o.n, "parked.n", 1);
    sha(o.base, "parked.base");
    sha(o.head, "parked.head");
    distinctPins(o.pins, "parked.pins", 1);
    int(o.depth, "parked.depth");
    int(o.lineage, "parked.lineage", 1);
    iso(o.builtAt, "parked.builtAt");
    if (o.stack !== undefined) {
      stackList(o.stack, "parked.stack", (o.pins as Pin[]).map((p) => p.pr), o.base as string);
      if ((o.stack as StackCommit[]).at(-1)!.commit !== o.head) fail("parked.stack: its last commit is not the head");
    }
  }
  if (s.adaptive !== undefined) {
    const o = obj(s.adaptive, "adaptive", ["size", "greens"]);
    int(o.size, "adaptive.size", 1);
    int(o.greens, "adaptive.greens");
  }
  if (s.baseline !== undefined) {
    const o = obj(s.baseline, "baseline", ["n", "base", "builtAt", "forBatch", "held"], ["result", "stopped"]);
    int(o.n, "baseline.n", 1);
    int(o.forBatch, "baseline.forBatch", 1);
    sha(o.base, "baseline.base");
    iso(o.builtAt, "baseline.builtAt");
    if (arr(o.held, "baseline.held").length > 0) distinctPins(o.held, "baseline.held", 1);
    if ("stopped" in o && o.stopped !== true) fail("baseline.stopped: must be true when present");
    if (o.result !== undefined) baselineResultOk(o.result, "baseline.result");
  }
  if (s.aloneRed !== undefined) {
    const o = obj(s.aloneRed, "aloneRed", ["base", "seen", "retried"]);
    sha(o.base, "aloneRed.base");
    const seen = arr(o.seen, "aloneRed.seen");
    if (seen.length < 1 || seen.length > ALONE_RED_MAX) fail(`aloneRed.seen: must hold 1 to ${ALONE_RED_MAX} entries`);
    seen.forEach((e, i) => {
      const x = obj(e, `aloneRed.seen[${i}]`, ["pr", "n", "result"]);
      int(x.pr, `aloneRed.seen[${i}].pr`, 1);
      int(x.n, `aloneRed.seen[${i}].n`, 1);
      if (baselineResultOk(x.result, `aloneRed.seen[${i}].result`).red !== true) fail(`aloneRed.seen[${i}].result.red: must be true`);
    });
    if (new Set(seen.map((e) => (e as O).pr)).size !== seen.length) fail("aloneRed.seen: a PR is listed twice");
    const retried = arr(o.retried, "aloneRed.retried");
    if (retried.length > ALONE_RED_MAX) fail(`aloneRed.retried: more than ${ALONE_RED_MAX} entries`);
    retried.forEach((e, i) => {
      const x = obj(e, `aloneRed.retried[${i}]`, ["pr", "head", "other", "failing"]);
      int(x.pr, `aloneRed.retried[${i}].pr`, 1);
      sha(x.head, `aloneRed.retried[${i}].head`);
      int(x.other, `aloneRed.retried[${i}].other`, 1);
      arr(x.failing, `aloneRed.retried[${i}].failing`).forEach((v, j) => str(v, `aloneRed.retried[${i}].failing[${j}]`));
    });
    if (new Set(retried.map((e) => (e as O).pr)).size !== retried.length) fail("aloneRed.retried: duplicate PR");
  }
}

function baselineResultOk(x: unknown, where: string): O {
  const r = obj(x, where, ["red", "jobs", "tests", "byJob"]);
  if (typeof r.red !== "boolean") fail(`${where}.red: not a boolean`);
  for (const k of ["jobs", "tests", "byJob"]) arr(r[k], `${where}.${k}`).forEach((v, i) => str(v, `${where}.${k}[${i}]`));
  return r;
}

/** Refs and labels are checked against the config's names. */
export function parseState(json: string, names: Names): State {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    fail("not JSON");
  }
  raw = migrate(raw);
  if ((raw as O)?.v !== 5) fail(`unknown version ${JSON.stringify((raw as O | null)?.v)}`);
  const s = obj(raw, "state", Object.keys(emptyState()), ["eligibleSince", "go", "hooks", "held", "concurrent", "flakes", "epochBranch", "seenRed", "squashed", "parked", "adaptive", "baseline", "aloneRed", "internalErrors"]);
  if ("go" in s && s.go !== true) fail("go: must be true when present");
  if ("internalErrors" in s) {
    const times = arr(s.internalErrors, "internalErrors");
    if (times.length === 0) fail("internalErrors: absent when empty");
    times.forEach((t, i) => iso(t, `internalErrors[${i}]`));
  }
  if ("hooks" in s) {
    const problem = hooksStateProblem(s.hooks);
    if (problem) fail(problem);
  }
  if ("eligibleSince" in s) {
    for (const [k, v] of Object.entries(map(s.eligibleSince, "eligibleSince"))) {
      if (!/^[1-9][0-9]{0,7}$/.test(k)) fail(`eligibleSince: bad key ${k}`);
      const e = obj(v, `eligibleSince.${k}`, ["head", "labelledAt", "since"]);
      sha(e.head, `eligibleSince.${k}.head`);
      iso(e.labelledAt, `eligibleSince.${k}.labelledAt`);
      iso(e.since, `eligibleSince.${k}.since`);
    }
  }
  if ("held" in s) {
    for (const [k, v] of Object.entries(map(s.held, "held"))) {
      if (!/^[1-9][0-9]{0,7}$/.test(k)) fail(`held: bad key ${k}`);
      const e = obj(v, `held.${k}`, ["head", "since"]);
      sha(e.head, `held.${k}.head`);
      iso(e.since, `held.${k}.since`);
    }
  }
  if (s.flakes !== undefined) {
    arr(s.flakes, "flakes").forEach((f, i) => {
      const o = obj(f, `flakes[${i}]`, ["at", "n", "count", "keys"]);
      iso(o.at, `flakes[${i}].at`);
      int(o.n, `flakes[${i}].n`, 1);
      int(o.count, `flakes[${i}].count`);
      arr(o.keys, `flakes[${i}].keys`).forEach((k, j) => str(k, `flakes[${i}].keys[${j}]`));
    });
  }
  int(s.seq, "seq");
  if (s.lease !== null) checkLease(s.lease);
  if (s.epochBranch !== undefined) checkEpochBranch(s.epochBranch);
  checkStrategyState(s);
  int(s.nextLineage, "nextLineage", 1);
  int(s.redStreak, "redStreak");
  int(s.bounceStreak, "bounceStreak");
  if (s.lastLandedAt !== null) iso(s.lastLandedAt, "lastLandedAt");

  const auth = map(s.auth, "auth");
  for (const [k, v] of Object.entries(auth)) {
    if (!/^[1-9][0-9]{0,7}$/.test(k)) fail(`auth: bad key ${k}`);
    const a = obj(v, `auth.${k}`, ["head", "baseRepoId", "policy", "policyPr", "admittedAt", "labelledAt", "evidence", "reviewRun"], ["author", "waiver", "priority", "headRef"]);
    if (a.headRef !== undefined && !isGitBranchName(str(a.headRef, `auth.${k}.headRef`))) fail(`auth.${k}.headRef: bad`);
    if (a.author !== undefined) str(a.author, `auth.${k}.author`);
    if (a.priority !== undefined) {
      const p = obj(a.priority, `auth.${k}.priority`, ["by", "at"]);
      str(p.by, `auth.${k}.priority.by`);
      iso(p.at, `auth.${k}.priority.at`);
    }
    sha(a.head, `auth.${k}.head`);
    int(a.baseRepoId, `auth.${k}.baseRepoId`, 1);
    str(a.policy, `auth.${k}.policy`);
    bool(a.policyPr, `auth.${k}.policyPr`);
    iso(a.admittedAt, `auth.${k}.admittedAt`);
    iso(a.labelledAt, `auth.${k}.labelledAt`);
    arr(a.evidence, `auth.${k}.evidence`).forEach((e, i) => str(e, `auth.${k}.evidence[${i}]`));
    if (a.reviewRun !== null) int(a.reviewRun, `auth.${k}.reviewRun`, 1);
    if (a.waiver !== undefined) {
      const w = obj(a.waiver, `auth.${k}.waiver`, ["rule", "login", "id", "readyByBot", "policyWaived", "files", "globs"]);
      if (w.rule !== "trusted-automation") fail(`auth.${k}.waiver.rule: unknown rule`);
      str(w.login, `auth.${k}.waiver.login`);
      int(w.id, `auth.${k}.waiver.id`, 1);
      bool(w.readyByBot, `auth.${k}.waiver.readyByBot`);
      bool(w.policyWaived, `auth.${k}.waiver.policyWaived`);
      arr(w.files, `auth.${k}.waiver.files`).forEach((e, i) => str(e, `auth.${k}.waiver.files[${i}]`));
      arr(w.globs, `auth.${k}.waiver.globs`).forEach((e, i) => str(e, `auth.${k}.waiver.globs[${i}]`));
    }
  }

  const placed: number[] = [];
  let active: O | null = null;
  const batches: O[] = [];
  if (s.active !== null) {
    active = checkActive(s.active, "active");
    batches.push(active);
  }
  if ("concurrent" in s) {
    if (active === null) fail("concurrent: present while no batch is active");
    const more = arr(s.concurrent, "concurrent");
    if (more.length === 0) fail("concurrent: empty (absent when no further batch runs)");
    more.forEach((x, i) => batches.push(checkActive(x, `concurrent[${i}]`)));
    const ns = more.map((x) => (x as O).n as number);
    for (let i = 1; i < ns.length; i++) if (ns[i]! <= ns[i - 1]!) fail("concurrent: not in batch-number order");
  }
  if (new Set(batches.map((b) => b.n)).size !== batches.length) fail("two running batches share a number");
  for (const b of batches) placed.push(...(b.prs as number[]));
  arr(s.pending, "pending").forEach((p, i) => placed.push(...pendingItem(p, `pending[${i}]`)));
  arr(s.solo, "solo").forEach((p, i) => placed.push(soloItem(p, `solo[${i}]`)));
  if (new Set(placed).size !== placed.length) fail("a PR is in more than one of the running batches, pending and solo");
  for (const p of placed) if (!(String(p) in auth)) fail(`#${p} is queued without an authorisation record`);
  arr(s.operatorSolo, "operatorSolo").forEach((p, i) => pr(p, `operatorSolo[${i}]`));

  for (const [k, v] of Object.entries(map(s.lineages, "lineages"))) {
    if (!/^[1-9][0-9]{0,8}$/.test(k)) fail(`lineages: bad key ${k}`);
    const l = obj(v, `lineages.${k}`, ["runs"], ["preempted"]);
    int(l.runs, `lineages.${k}.runs`);
    if (l.preempted !== undefined && l.preempted !== true) fail(`lineages.${k}.preempted: must be true when present`);
  }
  arr(s.window, "window").forEach((w, i) => {
    const o = obj(w, `window[${i}]`, ["at", "cost"]);
    iso(o.at, `window[${i}].at`);
    int(o.cost, `window[${i}].cost`, 1);
  });
  arr(s.verify, "verify").forEach((v, i) => {
    const o = obj(v, `verify[${i}]`, ["pr", "pin", "landedIn", "since", "ticks", "notified"], ["admitted"]);
    if (o.admitted !== undefined) sha(o.admitted, `verify[${i}].admitted`);
    pr(o.pr, `verify[${i}].pr`);
    sha(o.pin, `verify[${i}].pin`);
    sha(o.landedIn, `verify[${i}].landedIn`);
    iso(o.since, `verify[${i}].since`);
    int(o.ticks, `verify[${i}].ticks`);
    bool(o.notified, `verify[${i}].notified`);
  });
  arr(s.outbox, "outbox").forEach((n, i) => checkNotice(n, `outbox[${i}]`, names));
  arr(s.history, "history").forEach((h, i) => {
    const o = obj(h, `history[${i}]`, ["n", "at", "outcome", "prs", "head", "note"], ["failedJobs", "runs"]);
    int(o.n, `history[${i}].n`, 1);
    iso(o.at, `history[${i}].at`);
    oneOf(o.outcome, `history[${i}].outcome`, ["landed", "split", "bounced", "solo", "abandoned", "rebuilt", "paused", "empty", "flaky"] as const);
    if (o.runs !== undefined) runRefs(o.runs, `history[${i}].runs`, false);
    arr(o.prs, `history[${i}].prs`).forEach((p, j) => pr(p, `history[${i}].prs[${j}]`));
    if (o.head !== null) sha(o.head, `history[${i}].head`);
    str(o.note, `history[${i}].note`);
  });

  if (s.journal !== null) {
    const j = obj(s.journal, "journal", ["seq", "op", "reserved", "at", "checkpoint", "tries"]);
    int(j.tries, "journal.tries");
    int(j.seq, "journal.seq");
    bool(j.reserved, "journal.reserved");
    iso(j.at, "journal.at");
    const kind = checkOp(j.op, "journal.op");
    const op = j.op as O;
    if (kind === "build") {
      // A build may run beside running batches (queue.concurrency, DESIGN.md §5.6), but never with a PR one of them, pending or solo holds.
      for (const p of op.pins as Pin[]) if (placed.includes(p.pr)) fail(`journal: a build pins #${p.pr}, which is already placed`);
      for (const p of op.pins as Pin[]) {
        if ((auth[String(p.pr)] as { head?: string } | undefined)?.head !== p.head) fail(`journal: pin #${p.pr} is not the authorised head`);
      }
      if (j.checkpoint !== null) {
        const c = obj(j.checkpoint, "journal.checkpoint", ["survivors", "dropped", "chainHead"], ["stack"]);
        if (c.stack !== undefined) arr(c.stack, "journal.checkpoint.stack").forEach((e, i) => {
          const o = obj(e, `journal.checkpoint.stack[${i}]`, ["pr", "commit", "parent", "tree", "own"]);
          pr(o.pr, `journal.checkpoint.stack[${i}].pr`);
          prefixes(o.own, `journal.checkpoint.stack[${i}].own`);
          for (const f of ["commit", "parent", "tree"]) sha(o[f], `journal.checkpoint.stack[${i}].${f}`);
        });
        pins(c.survivors, "journal.checkpoint.survivors", false);
        arr(c.dropped, "journal.checkpoint.dropped").forEach((d, i) => {
          const o = obj(d, `journal.checkpoint.dropped[${i}]`, ["pr", "pin", "outcome"], ["commit"]);
          sha(o.pin, `journal.checkpoint.dropped[${i}].pin`);
          if (o.commit !== undefined) sha(o.commit, `journal.checkpoint.dropped[${i}].commit`);
          oneOf(o.outcome, `journal.checkpoint.dropped[${i}].outcome`, ["conflict", "noop", "squashed"] as const);
          pr(o.pr, `journal.checkpoint.dropped[${i}].pr`);
        });
        if (c.chainHead !== null) sha(c.chainHead, "journal.checkpoint.chainHead");
        const problem = buildRecordProblem(op as unknown as { pins: Pin[] }, c as unknown as BuildRecord, undefined);
        if (problem) fail(`journal.checkpoint: ${problem}`);
      }
    } else {
      if (active === null) fail(`journal: a ${kind} with no active batch`);
      if (j.checkpoint !== null) fail("journal: checkpoint on a non-build op");
      if (kind === "land" && (op.before !== active.base || op.after !== active.head)) fail("journal: land does not match the active batch");
      // Linear landing (DESIGN.md §7.4): exactly the active batch's PRs, each to its own stack commit.
      if (kind === "land" && (op.heads !== undefined) !== (active.stack !== undefined)) fail("journal: land and the active batch disagree on linear landing");
      if (kind === "land" && op.heads !== undefined) {
        const stack = active.stack as StackCommit[];
        const heads = op.heads as HeadMove[];
        if (heads.length !== stack.length || heads.some((h, i) => h.pr !== stack[i]!.pr || h.after !== stack[i]!.commit)) fail("journal: land heads do not match the active batch's stack");
        for (const h of heads) if ((auth[String(h.pr)] as { head?: string; headRef?: string } | undefined)?.head !== h.before || (auth[String(h.pr)] as { headRef?: string } | undefined)?.headRef !== h.ref) fail(`journal: land moves #${h.pr} from other than its admitted head and branch`);
      }
    }
  }
  // Every lineage that can still spend runs needs a counter (else the budget reads 0).
  const counters = map(s.lineages, "lineages");
  const lineages: number[] = [];
  for (const b of batches) lineages.push(b.lineage as number);
  (s.pending as { lineage: number }[]).forEach((p) => lineages.push(p.lineage));
  (s.solo as { lineage: number }[]).forEach((p) => lineages.push(p.lineage));
  const jop = (s.journal as { op?: { kind: string; lineage?: number } } | null)?.op;
  if (jop?.kind === "build") lineages.push(jop.lineage as number);
  for (const l of lineages) if (!(String(l) in counters)) fail(`lineage ${l} has no run counter`);
  return raw as State;
}

/**
 * Explicit, one-way migrations. v2 → v3 added Auth.reviewRun: a v2 record has
 * none, which becomes null ("rediscover the review run"). Any other version
 * is left alone and refused by the parser.
 */
function migrate(raw: unknown): unknown {
  return migrateV4(migrateV3(migrateV2(raw)));
}

/**
 * v4 → v5 added active.rerunAt (the rerun barrier's start) and cancelRuns
 * giveUpAt (how long cancellation reconciles). A v4 document gets rerunAt
 * null (no bound has started) and giveUpAt equal to its until.
 */
function migrateV4(raw: unknown): unknown {
  const s = raw as O | null;
  if (typeof s !== "object" || s === null || s.v !== 4) return raw;
  const active = s.active && typeof s.active === "object" && !("rerunAt" in (s.active as O)) ? { ...(s.active as O), rerunAt: null } : s.active;
  const outbox = Array.isArray(s.outbox)
    ? s.outbox.map((n) => {
        const o = n as O;
        return o && typeof o === "object" && o.kind === "cancelRuns" && !("giveUpAt" in o) ? { ...o, giveUpAt: o.until } : n;
      })
    : s.outbox;
  return { ...s, v: 5, active, outbox };
}

/**
 * v3 → v4 added the whole-tick lease, journal.tries, rerun request receipts,
 * comment delivery records and the cancellation window. A v3 document gets
 * no lease, tries 0, and cancellation windows that have already closed.
 */
function migrateV3(raw: unknown): unknown {
  const s = raw as O | null;
  if (typeof s !== "object" || s === null || s.v !== 3) return raw;
  const journal = s.journal && typeof s.journal === "object" ? { ...(s.journal as O), tries: 0 } : s.journal;
  const outbox = Array.isArray(s.outbox)
    ? s.outbox.map((n) => (n && typeof n === "object" && (n as O).kind === "cancelRuns" && !("until" in (n as O)) ? { ...(n as O), until: "1970-01-01T00:00:00.000Z" } : n))
    : s.outbox;
  return { ...s, v: 4, lease: null, journal, outbox };
}

function migrateV2(raw: unknown): unknown {
  const s = raw as O | null;
  if (typeof s !== "object" || s === null || s.v !== 2) return raw;
  const auth = s.auth;
  const migrated: O = {};
  if (typeof auth === "object" && auth !== null && !Array.isArray(auth)) {
    for (const [k, a] of Object.entries(auth as O)) {
      migrated[k] = typeof a === "object" && a !== null && !("reviewRun" in a) ? { ...(a as O), reviewRun: null } : a;
    }
  }
  return { ...s, v: 3, auth: typeof auth === "object" && auth !== null && !Array.isArray(auth) ? migrated : auth };
}

/** For the runner: corrupt state is reported, not thrown, so it can pause. */
export function loadState(issueBody: string, names: Names): { ok: true; state: State } | { ok: false; reason: string } {
  try {
    return { ok: true, state: stateFromIssueBody(issueBody, names) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const FENCE = "```json qlander-state";

export function renderState(s: State): string {
  return `Qlander state. Edited by the qlander workflow; do not edit by hand.\n\n${FENCE}\n${JSON.stringify(s, null, 1)}\n\`\`\`\n`;
}

export function stateFromIssueBody(body: string, names: Names): State {
  const start = body.indexOf(FENCE);
  if (start < 0) fail("no state block");
  const from = start + FENCE.length;
  const end = body.indexOf("\n```", from);
  if (end < 0) fail("unterminated state block");
  return parseState(body.slice(from, end), names);
}
