// Producer-bound evidence adapters (DESIGN.md §4.1) and the policy-boundary
// test (§4.3). Pure: they judge API data the runner has already fetched.

import type { Human, ReviewProducer } from "./config";
import type { CheckRun, IssueComment, Job, JobsByRun, Run, RunRef } from "./types";
import { isSha } from "./validate";

export interface Proof {
  ok: boolean;
  why: string;
  /** Not proven either way (a search limit was hit); fails closed, but is not "absent". */
  unknown?: true;
  run?: RunRef;
  checkId?: number;
}

const no = (why: string): Proof => ({ ok: false, why });

/** Job conclusions that are a red verdict on the commit. */
const FAILED = new Set(["failure", "timed_out"]);

function successfulJob(jobs: Job[] | undefined, name: string): Job | undefined {
  return jobs?.find((j) => j.name === name && j.status === "completed" && j.conclusion === "success");
}

/**
 * `job@subject`: the run executes the subject itself (fast lane, queue CI).
 * Latest attempt's jobs. The newest matching run decides, with one exception:
 * a newer run that is still queued or running defers to the run before it.
 * Adding a label restarts the target's CI, and that rerun must not hide the verdict
 * the same commit already has. It defers only when the run is a first attempt
 * (a retry could hide an earlier failure, which the latest attempt's jobs no
 * longer show), its job list is complete, and none of its jobs has failed or
 * timed out. Every other newer run blocks: an unreadable job list, a cancelled
 * or skipped job, or a completed run without the job. A newer failure always
 * beats an older success.
 */
export function jobAtSubject(
  req: { workflowPath: string; event: string; job: string; branch?: string },
  subject: string,
  repoId: number,
  runs: Run[],
  jobsByRun: JobsByRun,
): Proof {
  if (!isSha(subject)) return no("subject is not a sha");
  const matching = runs
    .filter(
      (r) =>
        r.path === req.workflowPath &&
        r.event === req.event &&
        r.repository?.id === repoId &&
        r.head_repository?.id === repoId &&
        r.head_sha === subject &&
        (req.branch === undefined || r.head_branch === req.branch),
    )
    .sort((a, b) => b.id - a.id);
  if (matching.length === 0) return no(`no ${req.event} run of ${req.workflowPath} for ${subject}`);
  for (const run of matching) {
    const jobs = jobsByRun[String(run.id)];
    if (!jobs) return { ok: false, unknown: true, why: `job list of run ${run.id} not readable` };
    const job = jobs.find((j) => j.name === req.job);
    if (job?.status === "completed" && job.conclusion === "success") {
      return { ok: true, why: `run ${run.id}`, run: { runId: run.id, attempt: run.run_attempt } };
    }
    if (job?.status === "completed" && FAILED.has(job.conclusion ?? "")) {
      return no(`job '${req.job}' ${job.conclusion} in run ${run.id}`);
    }
    const pending = run.status !== "completed" && job?.status !== "completed";
    const failed = jobs.find((j) => FAILED.has(j.conclusion ?? ""));
    if (!pending || run.run_attempt !== 1 || failed) {
      return no(
        failed
          ? `job '${failed.name}' ${failed.conclusion} in run ${run.id}`
          : `job '${req.job}' has not succeeded in run ${run.id}`,
      );
    }
  }
  return no(`job '${req.job}' has not succeeded in run ${matching[0]!.id}`);
}

/**
 * `job@main`: a run of main's revision judges another SHA. The run's own sha is
 * the producer revision and must be on main; the subject is bound only by the
 * exact job name. `run.head_sha` is never compared with the subject.
 */
export function jobAtMain(
  req: { workflowPath: string; events: string[]; jobTemplate: string },
  subject: string,
  repoId: number,
  runs: Run[],
  jobsByRun: JobsByRun,
  isOnMain: (sha: string) => boolean,
  /** The target's main branch (target.main): the producer's run must be on it. */
  mainBranch: string,
): Proof {
  if (!isSha(subject)) return no("subject is not a sha");
  const jobName = req.jobTemplate.replace("{sha}", subject);
  const matching = runs
    .filter(
      (r) =>
        r.path === req.workflowPath &&
        req.events.includes(r.event) &&
        r.head_branch === mainBranch &&
        r.repository?.id === repoId &&
        isSha(r.head_sha) &&
        isOnMain(r.head_sha),
    )
    .sort((a, b) => b.id - a.id);
  for (const run of matching) {
    if (successfulJob(jobsByRun[String(run.id)], jobName)) {
      return { ok: true, why: `run ${run.id}`, run: { runId: run.id, attempt: run.run_attempt } };
    }
  }
  return no(`no successful '${jobName}' from ${req.workflowPath} on main`);
}

/** `app-check`: a check run by a configured App on the subject sha. */
export function appCheck(req: { appId: number; name: string }, subject: string, checks: CheckRun[]): Proof {
  if (!isSha(subject)) return no("subject is not a sha");
  const c = checks
    .filter((x) => x.app?.id === req.appId && x.name === req.name && x.head_sha === subject)
    .sort((a, b) => b.id - a.id)[0];
  if (!c) return no(`no '${req.name}' check from app ${req.appId}`);
  if (c.status !== "completed" || c.conclusion !== "success") return no(`'${req.name}' is ${c.conclusion ?? c.status}`);
  return { ok: true, why: `check ${c.id}`, checkId: c.id };
}

export function reviewProof(
  producer: ReviewProducer,
  subject: string,
  repoId: number,
  data: { runs: Run[]; jobsByRun: JobsByRun; checks: CheckRun[]; isOnMain: (sha: string) => boolean; mainBranch: string },
): Proof {
  return producer.adapter === "job@main"
    ? jobAtMain(producer, subject, repoId, data.runs, data.jobsByRun, data.isOnMain, data.mainBranch)
    : appCheck(producer, subject, data.checks);
}

/**
 * Policy approval bound to the exact head (DESIGN.md §4.3 (b)): an unedited
 * comment whose whole body is `/qlander approve-policy <head>`, by a
 * configured human (matched by id and login).
 */
export function policyApproval(comments: IssueComment[], humans: Human[], head: string): IssueComment | undefined {
  if (!isSha(head)) return undefined;
  const want = `/qlander approve-policy ${head}`;
  return comments.find(
    (c) =>
      c.body.trim() === want &&
      c.created_at === c.updated_at &&
      humans.some((h) => h.id === c.user.id && h.login === c.user.login),
  );
}

/** True when any changed file falls inside the policy boundary. */
export function isPolicyChange(files: string[], boundary: string[]): boolean {
  const globs = boundary.map((g) => new Bun.Glob(g));
  return files.some((f) => globs.some((g) => g.match(f)));
}
