// Operator controls (DESIGN.md §10): the pieces the control commands in
// src/control-cli.ts are built from. Every control goes through a surface
// the tick already reads, with the operator's own token, and needs no App
// and no new permission:
//
//   - pause and resume open and close `pause` / `release-pause` issues in the
//     control repo. An issue a control opens carries OPERATOR_MARKER; resume
//     and unquiesce close only those unless --all is given.
//   - remove, requeue and prioritise put the bounce, ready and priority
//     labels (queue.labels) on the target PR; the tick applies them.
//   - approve-policy posts the approval comment the tick looks for.
//   - quiesce and unquiesce are the procedure of docs/deployment.md §8.1.

import type { Config } from "./config";
import type { PullRequest, StateRefApi } from "./github/api";
import type { HttpOptions } from "./github/http";
import { CONTROL_BRANCH, QUEUE_JOB_NAME } from "./job-names";
import { type OperatorIo, why } from "./operator";
import type { ReleaseState } from "./release-state";
import type { State } from "./state";
import type { DocRead } from "./status";
import type { IssueInfo, TickJob, TickRun } from "./watchdog-core";
import { extractTickReport } from "./watchdog-render";

/** Marks an issue a control opened, so resume and unquiesce close only their own. */
export const OPERATOR_MARKER = "<!-- qlander-operator -->";
/** After re-enabling tick.yml, wait this long before dispatching: a dispatch straight after the enable can leave a ghost run. */
export const ENABLE_SETTLE_MS = 5_000;
export const POLL_MS = 10_000;
/** How long quiesce waits for tick runs to finish, and unquiesce for each dispatched tick. */
export const WAIT_MS = 15 * 60_000;

/** What the controls read and write. The real one is src/github/control-client.ts; tests pass a fake. */
export interface ControlApi {
  queueState: Pick<StateRefApi, "read">;
  releaseState: Pick<StateRefApi, "read">;
  /** The token's account. */
  whoami(): Promise<{ login: string; id: number }>;
  /** tick.yml's state ("active", "disabled_manually", ...). */
  workflowState(): Promise<string>;
  setTickEnabled(enabled: boolean): Promise<void>;
  /** workflow_dispatch tick.yml on the control branch. */
  dispatchTick(): Promise<void>;
  /** tick.yml's newest runs (one page). */
  listRecentRuns(): Promise<TickRun[]>;
  listUnfinishedRuns(): Promise<{ runs: TickRun[]; truncated: boolean }>;
  listJobs(runId: number): Promise<TickJob[]>;
  jobLog(jobId: number): Promise<string>;
  /** Open control-repo issues with the label, oldest first; complete is false if some may be missing. */
  listOpenIssues(label: string): Promise<{ issues: IssueInfo[]; complete: boolean }>;
  createIssue(title: string, body: string, labels: string[]): Promise<IssueInfo>;
  closeIssue(n: number): Promise<void>;
  /** A comment on a control-repo issue. */
  comment(n: number, body: string): Promise<void>;
  getPr(n: number): Promise<PullRequest>;
  addPrLabel(n: number, label: string): Promise<void>;
  commentPr(n: number, body: string): Promise<void>;
}

export type ControlConfig = Pick<Config, "names" | "humans"> & {
  /**
   * The config lets the release job write its state branch: release is
   * enabled and not held in dry run (ReleaseConfig.dryRun). Otherwise the job
   * makes no writes, and an absent release state branch is idle with nothing
   * to roll back, unless releaseAbsenceProblem finds it held state once.
   */
  releaseWritesState: boolean;
};

/** How an absent release state branch reads when the release job never writes state. */
export const RELEASE_NEVER_WROTE = "(absent: release job has never written state)";

export class Refused extends Error {}

/** One control run: prints each step, acts unless dry, and records what it changed for the status-issue log. */
export class Run {
  readonly acted: string[] = [];
  constructor(
    readonly api: ControlApi,
    readonly cfg: ControlConfig,
    readonly io: OperatorIo,
    readonly dry: boolean,
    readonly sleep: (ms: number) => Promise<void>,
    readonly now: () => Date,
    readonly pollMs: number,
    readonly waitMs: number,
  ) {}

  say(line: string): void {
    this.io.out(line);
  }

  /** Do a step, or print that it would be done. */
  async step(what: string, fn: () => Promise<unknown>): Promise<void> {
    if (this.dry) return this.say(`would: ${what}`);
    this.say(what);
    await fn();
    this.acted.push(what);
  }

  refuse(reason: string): never {
    throw new Refused(reason);
  }

  /** Poll `check` until it returns a value, for at most waitMs. */
  async until<T>(what: string, check: () => Promise<T | null>): Promise<T> {
    const deadline = this.now().getTime() + this.waitMs;
    for (;;) {
      const v = await check();
      if (v !== null) return v;
      if (this.now().getTime() >= deadline) this.refuse(`timed out after ${Math.round(this.waitMs / 60_000)} minutes waiting for ${what}`);
      await this.sleep(this.pollMs);
    }
  }
}

export interface ControlDeps {
  env: Record<string, string | undefined>;
  connect?: (cfg: ControlConfig, http: HttpOptions) => Promise<ControlApi>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  pollMs?: number;
  waitMs?: number;
}

// ---- pause issues ---------------------------------------------------------

export const isOurs = (i: IssueInfo) => i.body.includes(OPERATOR_MARKER);

/** Open a `label` issue unless one a control opened is already open. A failed listing opens one anyway: a second pause is harmless. */
export async function openPause(r: Run, label: string, login: string, cmd: string): Promise<void> {
  let listed: { issues: IssueInfo[] } | null = null;
  try {
    listed = await r.api.listOpenIssues(label);
  } catch (e) {
    r.say(`(could not list the open ${label} issues: ${why(e)}; opening one anyway)`);
  }
  const mine = listed?.issues.find(isOurs);
  if (mine) return r.say(`a ${label} issue a control opened is already open: #${mine.number} ${mine.url}`);
  const title = `qlander ${label}: opened by ${login} (${cmd})`;
  const body = `${OPERATOR_MARKER}\nOpened by \`qlander ${cmd}\` as ${login} at ${r.now().toISOString()}.\n\nWhile this issue is open, the job it pauses lands or advances nothing. Close it, or run \`qlander resume\` or \`qlander unquiesce\`, to resume.`;
  await r.step(`open a ${label} issue`, async () => {
    const i = await r.api.createIssue(title, body, [label]);
    r.say(`  opened #${i.number} ${i.url}`);
  });
}

/** Close the label's open issues a control opened (every one with `all`); returns those left open. Refuses on an incomplete listing. */
export async function closePauses(r: Run, label: string, all: boolean): Promise<IssueInfo[]> {
  const listed = await r.api.listOpenIssues(label);
  if (!listed.complete) r.refuse(`the open ${label} issues could not all be listed; nothing closed`);
  const close = listed.issues.filter((i) => all || isOurs(i));
  if (!close.length) r.say(`no open ${label} issue${all ? "" : " opened by a control"} to close`);
  for (const i of close) await r.step(`close ${label} issue #${i.number} (${i.title})`, () => r.api.closeIssue(i.number));
  return listed.issues.filter((i) => !close.includes(i));
}

// ---- state ----------------------------------------------------------------

/** What in the two state documents is not idle, in words; empty when quiesced (docs/deployment.md §8.1 step 4). */
export function notIdle(docs: { queue: DocRead<State>; release: DocRead<ReleaseState> }, cfg: ControlConfig): string[] {
  const bad: string[] = [];
  const N = cfg.names;
  const q = docs.queue;
  if (q.kind === "error" || q.kind === "corrupt") bad.push(`${N.stateBranch}: ${q.kind}: ${q.reason}`);
  else if (q.kind === "absent") bad.push(`${N.stateBranch}: absent, so there is no commit to roll back to`);
  else {
    const s = q.state;
    if (s.journal !== null) bad.push(`${N.stateBranch}: journal is not null (${s.journal.op.kind})`);
    if (s.active !== null) bad.push(`${N.stateBranch}: batch #${s.active.n} is active (${s.active.prs.join(", ")})`);
    if (s.baseline && !s.baseline.result) bad.push(`${N.stateBranch}: a run of main with no PR in it is going (batch ${s.baseline.n})`);
    if (s.concurrent?.length) bad.push(`${N.stateBranch}: concurrent holds ${s.concurrent.length} running batch(es)`);
    if (s.pending.length) bad.push(`${N.stateBranch}: pending holds ${s.pending.length} batch(es) (${s.pending.map((p) => p.prs.join("+")).join(", ")})`);
    if (s.solo.length) bad.push(`${N.stateBranch}: solo holds ${s.solo.length} PR(s) (${s.solo.map((x) => x.pr).join(", ")})`);
    if (s.verify.length) bad.push(`${N.stateBranch}: verify holds ${s.verify.length} landed PR(s) (${s.verify.map((v) => v.pr).join(", ")})`);
    if (s.outbox.length) bad.push(`${N.stateBranch}: outbox holds ${s.outbox.length} undelivered notice(s) (${s.outbox.map((o) => o.kind).join(", ")})`);
    if (s.lease !== null) bad.push(`${N.stateBranch}: the lease is held by ${s.lease.owner} until ${s.lease.until}`);
  }
  const rl = docs.release;
  if (rl.kind === "error" || rl.kind === "corrupt") bad.push(`${N.releaseStateBranch}: ${rl.kind}: ${rl.reason}`);
  else if (rl.kind === "absent") {
    // An absent release state is judged by releaseAbsenceProblem, which reads more than the documents.
  }
  else {
    const s = rl.state;
    if (s.journal !== null) bad.push(`${N.releaseStateBranch}: journal is not null`);
    if (s.pausePending !== null) bad.push(`${N.releaseStateBranch}: a release pause is pending (${s.pausePending.reason})`);
    if (s.lease !== null) bad.push(`${N.releaseStateBranch}: the lease is held by ${s.lease.owner} until ${s.lease.until}`);
  }
  return bad;
}

/**
 * Why an absent release state branch cannot be taken as "never written", or
 * null when it can: the config lets the release job write state, the branch
 * existed at the pre-check (it vanished), or the release mirror issue is open
 * or could not all be listed (the release job's own initialisation guard,
 * src/release-state.ts refuseInit).
 */
export async function releaseAbsenceProblem(r: Run, preRelease: DocRead<unknown>): Promise<string | null> {
  const N = r.cfg.names;
  if (r.cfg.releaseWritesState) return `${N.releaseStateBranch}: absent, so there is no commit to roll back to`;
  if (preRelease.kind !== "absent") return `${N.releaseStateBranch}: it was there at the pre-check and is gone now`;
  try {
    const open = await r.api.listOpenIssues(N.releaseLabels.mirror);
    if (open.issues.length) return `${N.releaseStateBranch}: absent, but release state issue #${open.issues[0]!.number} is open, so it held state once`;
    if (!open.complete) return `${N.releaseStateBranch}: absent, and the release state issues could not all be listed`;
  } catch (e) {
    return `${N.releaseStateBranch}: absent, and the release state issues could not be listed (${why(e)})`;
  }
  return null;
}

export const docVersion = (d: DocRead<unknown>) => (d.kind === "ok" ? d.version : d.kind === "absent" ? "(absent)" : "(unreadable)");

// ---- tick runs ------------------------------------------------------------

/** A run queued with no jobs never starts, and the API refuses to cancel it: it counts as gone. */
export const isGhost = (run: TickRun, jobs: TickJob[]) => run.status === "queued" && jobs.length === 0;

/**
 * Unfinished tick runs that still count (every one but ghosts); null if they
 * could not all be read. The per-status listings are read one after another,
 * so a run that moves from one status to another between them can be missed:
 * the newest runs of every status are read as well, and a caller takes "none"
 * only when two passes in a row agree.
 */
export async function liveRuns(r: Run, ghosts: Set<number>): Promise<TickRun[] | null> {
  const runs = new Map<number, TickRun>();
  try {
    const listed = await r.api.listUnfinishedRuns();
    if (listed.truncated) return null;
    for (const x of [...listed.runs, ...(await r.api.listRecentRuns())]) if (x.status !== "completed") runs.set(x.id, x);
  } catch (e) {
    r.say(`  (could not list tick runs: ${why(e)})`);
    return null;
  }
  const live: TickRun[] = [];
  for (const run of runs.values()) {
    let jobs: TickJob[];
    try {
      jobs = await r.api.listJobs(run.id);
    } catch {
      live.push(run); // its jobs are unknown: it still counts
      continue;
    }
    if (!isGhost(run, jobs)) live.push(run);
    else if (!ghosts.has(run.id)) {
      ghosts.add(run.id);
      r.say(`  run ${run.id} is a ghost (queued with no jobs), counted as gone: ${run.url}`);
    }
  }
  return live;
}

export interface Dispatched {
  run: TickRun;
  job: TickJob | null;
  /** The outcome the queue job's report states (src/main.ts), or null if it could not be read. */
  outcome: string | null;
}

/** Dispatch a tick and wait for the run it started to finish. Null on a dry run. */
export async function dispatchAndWait(r: Run, what: string): Promise<Dispatched | null> {
  const before = new Set((await r.api.listRecentRuns()).map((x) => x.id));
  await r.step(`dispatch a tick (${what})`, () => r.api.dispatchTick());
  if (r.dry) return null;
  const fresh = async () => (await r.api.listRecentRuns()).filter((x) => !before.has(x.id) && x.event === "workflow_dispatch" && x.branch === CONTROL_BRANCH);
  // GitHub does not say which run a dispatch started. Take the one new dispatched run, after one more read, and refuse if anyone else's dispatch could be it.
  await r.until("the dispatched tick to appear", async () => ((await fresh()).length ? true : null));
  await r.sleep(r.pollMs);
  const seen = await fresh();
  if (seen.length !== 1) r.refuse(`${seen.length} new dispatched tick runs appeared (${seen.map((x) => x.id).join(", ")}), so which one this dispatch started is unknown; check them by hand`);
  const started = seen[0]!;
  r.say(`  run ${started.id} ${started.url}`);
  const run = await r.until(`run ${started.id} to finish`, async () => {
    const x = (await r.api.listRecentRuns()).find((y) => y.id === started.id);
    return x?.status === "completed" ? x : null;
  });
  const job = (await r.api.listJobs(run.id)).find((j) => j.name === QUEUE_JOB_NAME) ?? null;
  let outcome: string | null = null;
  if (job) {
    try {
      const o = extractTickReport(await r.api.jobLog(job.id))?.outcome;
      outcome = typeof o === "string" ? o : null;
    } catch (e) {
      r.say(`  (could not read the queue job's log: ${why(e)})`);
    }
  }
  r.say(`  run ${run.id}: ${run.conclusion ?? "?"}; queue job: ${job ? (job.conclusion ?? job.status) : "none"}; outcome: ${outcome ?? "unknown"}`);
  return { run, job, outcome };
}
