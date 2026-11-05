// Classification of the active batch's CI (DESIGN.md §6.2). The first class
// that applies wins: timeout → red → infra → red (policy) → config → pending →
// green. Timeout is a pending batch past its limit: qlander cancels those
// runs (recording the cause) and classifies them as infra on the next tick.

import type { Manifest, WorkflowEntry } from "./config";
import type { FailedJob, Job, JobsByRun, Run, RunRef } from "./types";
import { eligible, judgeWorkflow } from "./verdict";

export type CiClass =
  | { kind: "pending"; reason: string }
  | { kind: "green" }
  | { kind: "red"; policy: boolean; failedRuns: RunRef[]; failedJobs: FailedJob[]; reason: string }
  | { kind: "infra"; runs: RunRef[]; reason: string }
  | { kind: "config"; reason: string }
  | { kind: "timeout"; runs: RunRef[]; cause: "timeout" | "starved"; reason: string };

export interface Cancel extends RunRef {
  cause: "timeout" | "starved";
}

export interface ClassifyInput {
  now: Date;
  builtAt: string;
  queueBranch: string;
  head: string;
  repoId: number;
  manifest: Manifest;
  runs: Run[];
  jobsByRun: JobsByRun;
  /** Evidence runs whose job list is incomplete: never classified green. */
  incomplete?: number[];
  /** The run listing itself is incomplete (a page limit, or fewer runs than GitHub's total): pending, never a verdict. */
  runsIncomplete?: boolean;
  cancels: Cancel[];
  /** Runs that were rerun: classify only once they show a newer attempt, in metadata and jobs (review #5). */
  expect?: RunRef[];
  /** When the rerun was requested. */
  expectSince?: string | null;
  hasPolicyPr: boolean;
  limits: { noRunMinutes: number; inProgressMinutes: number; queuedHours: number; rerunBarrierMinutes?: number };
}

const minutes = (now: Date, iso: string) => (now.getTime() - Date.parse(iso)) / 60_000;
const ref = (r: Run): RunRef => ({ runId: r.id, attempt: r.run_attempt });
const INFRA = new Set(["cancelled", "action_required", "stale", "neutral"]);

// Time limits (DESIGN.md §6.2, "Time limits"). Only time a job spends on a
// runner counts towards the execution limit: a batch starved of runners is
// waiting, not stuck. Three rules, all on the current attempt:
//   1. timeout: a job has been in_progress for more than inProgressMinutes,
//      from its own started_at (a queued job is never counted);
//   2. starved: the attempt is older than queuedHours and no job is running;
//   3. timeout: the attempt is older than queuedHours + inProgressMinutes,
//      whatever its jobs show, so no run can hold the queue forever.
function overdue(i: ClassifyInput, run: Run | undefined, jobs: Job[] | undefined): "timeout" | "starved" | null {
  if (!run || run.status === "completed") return null;
  if (i.cancels.some((c) => c.runId === run.id && c.attempt === run.run_attempt)) return null;
  const running = (jobs ?? []).filter((j) => j.status === "in_progress");
  const starts = running.map((j) => j.started_at).filter((s): s is string => s !== null && !Number.isNaN(Date.parse(s)));
  if (starts.some((s) => minutes(i.now, s) > i.limits.inProgressMinutes)) return "timeout";
  const age = minutes(i.now, run.run_started_at);
  if (age > i.limits.queuedHours * 60 + i.limits.inProgressMinutes) return "timeout";
  if (age > i.limits.queuedHours * 60 && running.length === 0) return "starved";
  return null;
}

/**
 * A failed job that is not a verdict (DESIGN.md §6.2, "Excused failures"): a
 * job the manifest does not require, that failed, and that only started once
 * a job in the same run had already been cancelled. Aggregate jobs (such as
 * `full` or `fast`) are of this kind: they `needs:` the lanes, run `always()`,
 * and fail when a lane was cancelled. Once a run is cancelled nothing new
 * starts except `always()` jobs, so a job that started earlier, a required
 * job, or a job without timestamps is always a verdict.
 */
function excused(wf: WorkflowEntry, jobs: Job[], j: Job): boolean {
  if (j.conclusion !== "failure" || wf.required_jobs.includes(j.name) || !isTime(j.started_at)) return false;
  const cancelledAt = jobs
    .filter((x) => x.conclusion === "cancelled" && isTime(x.completed_at))
    .map((x) => Date.parse(x.completed_at!));
  return cancelledAt.length > 0 && Date.parse(j.started_at!) >= Math.min(...cancelledAt);
}

const isTime = (s: string | null | undefined): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s));

export function classify(i: ClassifyInput): CiClass {
  const branchRe = new RegExp(`^${i.queueBranch.replace(/[/.]/g, "\\$&")}$`);
  const evidence = i.runs.filter((r) => eligible(r, i.head, i.repoId, [branchRe]));
  const perWf = i.manifest.map((wf) => {
    const runs = evidence.filter((r) => r.path === wf.path);
    const run = runs.reduce<Run | undefined>((a, r) => (!a || r.id > a.id ? r : a), undefined);
    return { wf, run, jobs: run ? i.jobsByRun[String(run.id)] : undefined };
  });

  // The rerun barrier, before anything else (timeouts included): until every
  // rerun run shows a newer attempt, in its metadata and its jobs, what we see
  // may be the old attempt. Bounded: a run that never shows one was deleted or
  // superseded, which is a configuration problem that pauses.
  for (const e of i.expect ?? []) {
    const p = perWf.find((x) => x.run?.id === e.runId);
    const run = p?.run;
    const waited = i.expectSince ? minutes(i.now, i.expectSince) : 0;
    const why =
      !run ? `rerun of run ${e.runId} not visible${i.runsIncomplete ? " (the run list is incomplete)" : ""}`
      : run.run_attempt <= e.attempt ? `run ${e.runId} still at attempt ${run.run_attempt}`
      : (p.jobs ?? []).some((j) => j.run_attempt !== undefined && j.run_attempt !== run.run_attempt) ? `run ${e.runId} jobs still show another attempt`
      : null;
    if (why === null) continue;
    if (waited > (i.limits.rerunBarrierMinutes ?? Number.POSITIVE_INFINITY)) {
      return { kind: "config", reason: `${why} after ${Math.round(waited)} minutes: the rerun run was deleted or superseded` };
    }
    return { kind: "pending", reason: `waiting: ${why}` };
  }

  // A run qlander cancelled must reach completed: cancellation can leave
  // always() jobs running or queued. Overdue skips a cancelled attempt, so
  // bound the wait here: past the hard cap plus the rerun barrier, it is a
  // configuration problem, which pauses (abandoning cancels the runs again).
  const hardCap = i.limits.queuedHours * 60 + i.limits.inProgressMinutes + (i.limits.rerunBarrierMinutes ?? Number.POSITIVE_INFINITY);
  const unfinished = perWf.filter(
    ({ run }) =>
      run !== undefined &&
      run.status !== "completed" &&
      i.cancels.some((c) => c.runId === run.id && c.attempt === run.run_attempt) &&
      minutes(i.now, run.run_started_at) > hardCap,
  );
  if (unfinished.length > 0) {
    return { kind: "config", reason: `${unfinished.map(({ wf, run }) => `${wf.name} run ${run!.id}`).join(", ")} still not completed long after qlander cancelled it` };
  }

  // Timeout: a run past its limit that qlander has not cancelled yet.
  // Every clock belongs to the current attempt (see overdue): a rerun never
  // inherits earlier time, and a job never counts time spent queued.
  const late = perWf
    .map((p) => ({ ...p, cause: overdue(i, p.run, p.jobs) }))
    .filter((p): p is typeof p & { cause: "timeout" | "starved" } => p.cause !== null);
  if (late.length > 0) {
    const starved = late.every((p) => p.cause === "starved");
    return {
      kind: "timeout",
      runs: late.map(({ run }) => ref(run!)),
      cause: starved ? "starved" : "timeout",
      reason: `${late.map(({ wf }) => wf.name).join(", ")} past its time limit`,
    };
  }

  // An incomplete run list may hide the newest run: wait for a complete one
  // before any verdict. Bounded like a run (rule 3 above): past that it is a
  // configuration problem, which pauses, so no listing can hold the queue forever.
  if (i.runsIncomplete) {
    const waited = minutes(i.now, i.builtAt);
    if (waited > i.limits.queuedHours * 60 + i.limits.inProgressMinutes) {
      return { kind: "config", reason: `run list for ${i.queueBranch} still incomplete after ${Math.round(waited)} minutes` };
    }
    return { kind: "pending", reason: `run list incomplete for ${i.queueBranch}` };
  }

  // An incomplete job list cannot prove "all jobs succeeded": stop before any verdict.
  const partial = perWf.filter((p) => p.run && (i.incomplete ?? []).includes(p.run.id));
  if (partial.length > 0) {
    return { kind: "config", reason: `job list incomplete for ${partial.map((p) => `${p.wf.name} run ${p.run!.id}`).join(", ")}` };
  }

  const done = perWf.filter((p) => p.run?.status === "completed");

  // Red: any failure or time-out in a completed evidence run, whatever is skipped.
  const failedJobs: FailedJob[] = [];
  const failedRuns: RunRef[] = [];
  for (const { wf, run, jobs } of done) {
    const bad = (jobs ?? []).filter((j) => (j.conclusion === "failure" || j.conclusion === "timed_out") && !excused(wf, jobs!, j));
    const runBad = run!.conclusion === "failure" || run!.conclusion === "timed_out";
    if (bad.length > 0 || (runBad && !(jobs ?? []).some((j) => INFRA.has(j.conclusion ?? "")))) {
      failedRuns.push(ref(run!));
      failedJobs.push(...bad.map((j) => ({ name: j.name, url: j.html_url, id: j.id })));
    }
  }
  if (failedRuns.length > 0) {
    return { kind: "red", policy: false, failedRuns, failedJobs, reason: "required checks failed" };
  }

  // Infra: cancelled (by anyone, including our own timeout cancels) or another
  // non-verdict conclusion.
  const infraRuns = done.filter(
    ({ run, jobs }) =>
      INFRA.has(run!.conclusion ?? "") || (jobs ?? []).some((j) => INFRA.has(j.conclusion ?? "")),
  );
  if (infraRuns.length > 0) {
    const ours = infraRuns.filter(({ run }) =>
      i.cancels.some((c) => c.runId === run!.id && c.attempt === run!.run_attempt),
    );
    return {
      kind: "infra",
      runs: infraRuns.map(({ run }) => ref(run!)),
      reason: ours.length > 0 ? `cancelled by qlander (${ours.length} run(s) over time)` : "cancelled or inconclusive",
    };
  }

  // Shape problems: no run, missing job list, missing or wrongly skipped required job.
  const shape: string[] = [];
  for (const { wf, run, jobs } of perWf) {
    if (!run) {
      if (wf.when === "always" && minutes(i.now, i.builtAt) > i.limits.noRunMinutes) shape.push(`${wf.name}: no run`);
      continue;
    }
    if (run.status !== "completed") continue;
    if (!jobs) {
      shape.push(`${wf.name}: no job list`);
      continue;
    }
    for (const n of wf.required_jobs) if (!jobs.some((j) => j.name === n)) shape.push(`${wf.name}: '${n}' missing`);
    for (const j of jobs) {
      if (j.conclusion === "skipped" && !Object.hasOwn(wf.allow_skipped_jobs, j.name)) {
        shape.push(`${wf.name}: '${j.name}' skipped`);
      }
    }
  }
  if (shape.length > 0) {
    return i.hasPolicyPr
      ? { kind: "red", policy: true, failedRuns: [], failedJobs: [], reason: shape.join("; ") }
      : { kind: "config", reason: shape.join("; ") };
  }

  const waiting = perWf.filter(
    ({ wf, run, jobs }) =>
      (!run && wf.when === "always") || (run && (run.status !== "completed" || (jobs ?? []).some((j) => j.status !== "completed"))),
  );
  if (waiting.length > 0) return { kind: "pending", reason: waiting.map(({ wf }) => wf.name).join(", ") };

  // Green: the shared all-jobs verdict passes for every manifest workflow.
  for (const wf of i.manifest) {
    const v = judgeWorkflow(wf, evidence, i.jobsByRun);
    if (v.problems.length > 0) return { kind: "config", reason: v.problems.map((p) => p.msg).join("; ") };
  }
  return { kind: "green" };
}
