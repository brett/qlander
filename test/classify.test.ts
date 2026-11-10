// DESIGN.md §6.2: the ordered classification, and "skipped or cancelled is
// never green".

import { describe, expect, test } from "bun:test";
import { type ClassifyInput, classify } from "../src/classify";
import type { Manifest } from "../src/config";
import type { Job, Run } from "../src/types";
import { TARGET, job, run, sha } from "./sim";

const Q = sha("queue-head");
const BRANCH = "queue/42";
const manifest: Manifest = [
  { path: ".github/workflows/ci.yml", name: "CI", when: "always", required_jobs: ["Build", "Test"], allow_skipped_jobs: { "pr-gate": "pr only" } },
  {
    path: ".github/workflows/scan.yml",
    name: "Scan",
    when: "always",
    required_jobs: ["Determine targets"],
    allow_skipped_jobs: { "vulnxscan (${{ matrix.service }})": "whole matrix skipped when nothing to scan" },
  },
];

const ciRun = (over: Partial<Run> = {}) =>
  run({ id: 100, path: ".github/workflows/ci.yml", head_branch: BRANCH, head_sha: Q, ...over });
const scanRun = (over: Partial<Run> = {}) =>
  run({ id: 200, path: ".github/workflows/scan.yml", head_branch: BRANCH, head_sha: Q, ...over });

function input(runs: Run[], jobs: Record<string, Job[]>, over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    now: new Date("2026-10-21T11:00:00Z"),
    builtAt: "2026-10-21T10:00:00Z",
    queueBranch: BRANCH,
    head: Q,
    repoId: TARGET,
    manifest,
    runs,
    jobsByRun: jobs,
    cancels: [],
    hasPolicyPr: false,
    limits: { noRunMinutes: 15, inProgressMinutes: 150, queuedHours: 6 },
    ...over,
  };
}

const okCi = [job("Build"), job("Test"), job("pr-gate", "skipped")];
const okScan = [job("Determine targets"), job("vulnxscan (api)"), job("vulnxscan (web)")];

describe("classify", () => {
  test("everything succeeded (allowed skips only) is green", () => {
    expect(classify(input([ciRun(), scanRun()], { "100": okCi, "200": okScan })).kind).toBe("green");
  });

  test("a whole skipped vulnxscan matrix listed in allow_skipped_jobs is green", () => {
    const scan = [job("Determine targets"), job("vulnxscan (${{ matrix.service }})", "skipped")];
    expect(classify(input([ciRun(), scanRun()], { "100": okCi, "200": scan })).kind).toBe("green");
  });

  test("a failing instantiated vulnxscan leg is red even though no required job failed", () => {
    const scan = [job("Determine targets"), job("vulnxscan (api)", "failure"), job("vulnxscan (web)")];
    const c = classify(input([ciRun(), scanRun({ conclusion: "failure" })], { "100": okCi, "200": scan }));
    expect(c.kind).toBe("red");
    if (c.kind === "red") expect(c.failedJobs.map((j) => j.name)).toEqual(["vulnxscan (api)"]);
  });

  test("a job skipped because its dependency failed is red, not config", () => {
    const ci = [job("Build", "failure"), job("Test", "skipped")];
    const c = classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan }));
    expect(c.kind).toBe("red");
    if (c.kind === "red") {
      expect(c.policy).toBe(false);
      expect(c.failedRuns).toEqual([{ runId: 100, attempt: 1 }]);
    }
  });

  test("a required job skipped with nothing failing is config (never green)", () => {
    const ci = [job("Build"), job("Test", "skipped")];
    const c = classify(input([ciRun(), scanRun()], { "100": ci, "200": okScan }));
    expect(c.kind).toBe("config");
  });

  test("the same skip with a policy PR in the batch is red (policy)", () => {
    const ci = [job("Build"), job("Test", "skipped")];
    const c = classify(input([ciRun(), scanRun()], { "100": ci, "200": okScan }, { hasPolicyPr: true }));
    expect(c).toMatchObject({ kind: "red", policy: true, failedRuns: [] });
  });

  test("a policy PR that deleted a required job is red (policy), not config", () => {
    const ci = [job("Build")];
    expect(classify(input([ciRun(), scanRun()], { "100": ci, "200": okScan }, { hasPolicyPr: true }))).toMatchObject({
      kind: "red",
      policy: true,
    });
    expect(classify(input([ciRun(), scanRun()], { "100": ci, "200": okScan })).kind).toBe("config");
  });

  test("a cancelled job is infra (never green)", () => {
    const ci = [job("Build"), job("Test", "cancelled")];
    const c = classify(input([ciRun({ conclusion: "cancelled" }), scanRun()], { "100": ci, "200": okScan }));
    expect(c.kind).toBe("infra");
  });

  test("neutral, stale and action_required are infra", () => {
    for (const k of ["neutral", "stale", "action_required"]) {
      const ci = [job("Build"), job("Test", k)];
      expect(classify(input([ciRun(), scanRun()], { "100": ci, "200": okScan })).kind).toBe("infra");
    }
  });

  test("#15: a run qlander cancelled for time is infra, with the cause noted", () => {
    const ci = [job("Build"), job("Test", "cancelled")];
    const c = classify(
      input([ciRun({ conclusion: "cancelled" }), scanRun()], { "100": ci, "200": okScan }, { cancels: [{ runId: 100, attempt: 1, cause: "timeout" }] }),
    );
    expect(c.kind).toBe("infra");
    if (c.kind === "infra") expect(c.reason).toContain("cancelled by qlander");
  });

  test("in progress past the limit is a timeout; once cancelled by us it is not timed out again", () => {
    const late = ciRun({ status: "in_progress", conclusion: null, created_at: "2026-10-21T08:00:00Z" });
    const running = { "100": [job("Build", null, "in_progress", "2026-10-21T08:05:00Z")], "200": okScan };
    expect(classify(input([late, scanRun()], running))).toMatchObject({ kind: "timeout", cause: "timeout" });
    const c = classify(input([late, scanRun()], running, { cancels: [{ runId: 100, attempt: 1, cause: "timeout" }] }));
    expect(c.kind).toBe("pending");
  });

  test("queued for more than 6 hours is a starved timeout", () => {
    const q = ciRun({ status: "queued", conclusion: null, created_at: "2026-10-21T04:00:00Z" });
    expect(classify(input([q, scanRun()], { "200": okScan }))).toMatchObject({ kind: "timeout", cause: "starved" });
  });

  test("no run yet: pending within 15 minutes, config after", () => {
    expect(classify(input([scanRun()], { "200": okScan }, { now: new Date("2026-10-21T10:05:00Z") })).kind).toBe("pending");
    expect(classify(input([scanRun()], { "200": okScan })).kind).toBe("config");
  });

  test("a seen run that is gone is config at once, for an if_triggered workflow too; one with a newer run is not judged", () => {
    const early = { now: new Date("2026-10-21T10:05:00Z") };
    const gone = [{ runId: 99, path: ".github/workflows/ci.yml" }];
    expect(classify(input([scanRun()], { "200": okScan }, { ...early, gone }))).toEqual({ kind: "config", reason: "CI: run 99 seen earlier is gone" });
    const optional: Manifest = [{ ...manifest[0]!, when: "if_triggered" }, manifest[1]!];
    expect(classify(input([scanRun()], { "200": okScan }, { manifest: optional, gone })).kind).toBe("config");
    expect(classify(input([scanRun()], { "200": okScan }, { manifest: optional })).kind).toBe("green");
    expect(classify(input([ciRun(), scanRun()], { "100": okCi, "200": okScan }, { gone })).kind).toBe("green");
    expect(classify(input([scanRun()], { "200": okScan }, { ...early, gone, hasPolicyPr: true }))).toMatchObject({ kind: "red", policy: true });
  });

  test("runs from another repo, another branch, a PR event or another sha are not evidence", () => {
    const fakes = [
      ciRun({ repository: { id: 1 } }),
      ciRun({ id: 101, head_branch: "queue/43" }),
      ciRun({ id: 102, event: "pull_request" }),
      ciRun({ id: 103, head_sha: sha("other") }),
    ];
    const jobs = { "100": okCi, "101": okCi, "102": okCi, "103": okCi, "200": okScan };
    expect(classify(input([...fakes, scanRun()], jobs)).kind).toBe("config");
  });

  test("only the newest run (latest attempt's jobs) counts", () => {
    const old = ciRun({ id: 100, conclusion: "failure" });
    const fresh = ciRun({ id: 150 });
    const c = classify(input([old, fresh, scanRun()], { "100": [job("Build", "failure")], "150": okCi, "200": okScan }));
    expect(c.kind).toBe("green");
  });

  test("a run still in progress with a failed job waits (rerun needs a completed run)", () => {
    const r = ciRun({ status: "in_progress", conclusion: null });
    expect(classify(input([r, scanRun()], { "100": [job("Build", "failure"), job("Test", null, "in_progress")], "200": okScan })).kind).toBe(
      "pending",
    );
  });
});

describe("timeouts measure the current attempt (review #1)", () => {
  test("a rerun attempt is not timed out by the first attempt's age", () => {
    const r = ciRun({ status: "in_progress", conclusion: null, run_attempt: 2, created_at: "2026-10-21T06:00:00Z", run_started_at: "2026-10-21T10:50:00Z" });
    const c = classify(input([r, scanRun()], { "100": [job("Build", null, "in_progress", "2026-10-21T10:51:00Z")], "200": okScan }));
    expect(c.kind).toBe("pending");
  });

  test("time spent queued does not count as execution time", () => {
    const r = ciRun({ status: "in_progress", conclusion: null, created_at: "2026-10-21T07:00:00Z" });
    const c = classify(input([r, scanRun()], { "100": [job("Build", null, "in_progress", "2026-10-21T10:30:00Z")], "200": okScan }));
    expect(c.kind).toBe("pending");
  });

  test("a queued rerun attempt starves only after 6 hours of its own", () => {
    const r = ciRun({ status: "queued", conclusion: null, run_attempt: 2, created_at: "2026-10-20T00:00:00Z", run_started_at: "2026-10-21T10:00:00Z" });
    expect(classify(input([r, scanRun()], { "200": okScan })).kind).toBe("pending");
  });

  test("execution past the limit, from this attempt's first job start, is a timeout", () => {
    const r = ciRun({ status: "in_progress", conclusion: null, run_attempt: 2, created_at: "2026-10-20T00:00:00Z", run_started_at: "2026-10-21T08:00:00Z" });
    const c = classify(input([r, scanRun()], { "100": [job("Build", null, "in_progress", "2026-10-21T08:05:00Z")], "200": okScan }));
    expect(c).toMatchObject({ kind: "timeout", cause: "timeout" });
  });
});

describe("aggregate jobs failing because a lane was cancelled", () => {
  // Aggregate jobs such as `full` and `fast` need: the lanes and run if: always(); a cancelled
  // lane makes them fail ("full: test-integration is 'cancelled', needed 'success'").
  const t = (m: number) => `2026-10-21T10:${String(m).padStart(2, "0")}:00Z`;
  const j = (name: string, conclusion: string, started: number, completed: number): Job => ({
    ...job(name, conclusion, "completed", t(started)),
    completed_at: t(completed),
  });
  const lanes = () => [j("Build", "success", 1, 10), j("Test", "cancelled", 5, 30)];

  test("the aggregate shape: a cancelled required lane plus failed full and fast is infra, not red", () => {
    const ci = [...lanes(), j("full", "failure", 31, 32), j("fast", "failure", 31, 32), job("pr-gate", "skipped")];
    const c = classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan }, { cancels: [{ runId: 100, attempt: 1, cause: "timeout" }] }));
    expect(c.kind).toBe("infra");
  });

  test("the same shape cancelled by someone else is infra too", () => {
    const ci = [...lanes(), j("full", "failure", 30, 31)];
    expect(classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan })).kind).toBe("infra");
  });

  test("a real lane failure plus a cancellation plus a failed aggregate stays red, naming the lane", () => {
    const ci = [j("Build", "failure", 1, 10), j("Test", "cancelled", 5, 30), j("full", "failure", 31, 32)];
    const c = classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan }));
    expect(c.kind).toBe("red");
    if (c.kind === "red") expect(c.failedJobs.map((x) => x.name)).toEqual(["Build"]);
  });

  test("a non-required job that started before the cancellation and failed stays red", () => {
    const ci = [...lanes(), j("extra-integration-test", "failure", 2, 20), j("full", "failure", 31, 32)];
    const c = classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan }));
    expect(c.kind).toBe("red");
    if (c.kind === "red") expect(c.failedJobs.map((x) => x.name)).toEqual(["extra-integration-test"]);
  });

  test("without timestamps nothing is excused", () => {
    const ci = [job("Build"), job("Test", "cancelled"), job("full", "failure")];
    expect(classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan })).kind).toBe("red");
  });

  test("a failed non-required job with no cancellation anywhere stays red", () => {
    const ci = [...okCi, j("full", "failure", 31, 32)];
    expect(classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan })).kind).toBe("red");
  });

  test("a cancellation in one run never excuses a failure in another", () => {
    const scan = [j("Determine targets", "success", 1, 2), j("vulnxscan (api)", "failure", 31, 32)];
    expect(classify(input([ciRun({ conclusion: "cancelled" }), scanRun({ conclusion: "failure" })], { "100": lanes(), "200": scan })).kind).toBe("red");
  });

  test("a non-required job that timed out stays red even beside a cancellation", () => {
    const ci = [...lanes(), j("full", "timed_out", 31, 36)];
    expect(classify(input([ciRun({ conclusion: "failure" }), scanRun()], { "100": ci, "200": okScan })).kind).toBe("red");
  });
});

describe("time limits exclude time spent waiting for a runner", () => {
  const at = (h: number, m = 0) => `2026-10-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  const starvedRun = () => ciRun({ status: "in_progress", conclusion: null, created_at: at(0, 53) });

  test("quick jobs done and a lane queued for 2.5 hours is pending, not a timeout", () => {
    for (const queuedStart of [null, at(0, 53)]) {
      const jobs = [job("Build", "success", "completed", at(0, 54)), job("Test", null, "queued", queuedStart)];
      const c = classify(input([starvedRun(), scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(3, 24)), builtAt: at(0, 53) }));
      expect(c.kind).toBe("pending");
    }
  });

  test("a lane that started late is timed from its own start", () => {
    const jobs = [job("Build", "success", "completed", at(0, 54)), job("Test", null, "in_progress", at(3, 0))];
    const ok = classify(input([starvedRun(), scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(5, 29)), builtAt: at(0, 53) }));
    expect(ok.kind).toBe("pending");
    const late = classify(input([starvedRun(), scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(5, 31)), builtAt: at(0, 53) }));
    expect(late).toMatchObject({ kind: "timeout", cause: "timeout" });
  });

  test("past queuedHours with nothing running is starved", () => {
    const jobs = [job("Build", "success", "completed", at(0, 54)), job("Test", null, "queued", null)];
    const c = classify(input([starvedRun(), scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(6, 54)), builtAt: at(0, 53) }));
    expect(c).toMatchObject({ kind: "timeout", cause: "starved" });
  });

  test("past queuedHours a running job may finish, but never past queuedHours + inProgressMinutes", () => {
    const jobs = [job("Build", "success", "completed", at(0, 54)), job("Test", null, "in_progress", at(6, 0))];
    const run = classify(input([starvedRun(), scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(7, 0)), builtAt: at(0, 53) }));
    expect(run.kind).toBe("pending");
    // Jobs that keep starting (each under its limit) cannot hold the queue forever.
    const fresh = [job("Build", "success", "completed", at(0, 54)), job("Test", null, "in_progress", at(9, 20))];
    const cap = classify(input([starvedRun(), scanRun()], { "100": fresh, "200": okScan }, { now: new Date(at(9, 24)), builtAt: at(0, 53) }));
    expect(cap).toMatchObject({ kind: "timeout", cause: "timeout" });
  });

  test("a run whose job list is missing still hits the caps", () => {
    const c = classify(input([starvedRun(), scanRun()], { "200": okScan }, { now: new Date(at(6, 54)), builtAt: at(0, 53) }));
    expect(c).toMatchObject({ kind: "timeout", cause: "starved" });
  });

  test("a run qlander cancelled that never completes pauses after the hard cap plus the rerun barrier", () => {
    const jobs = [job("Build", "success", "completed", at(0, 54)), job("full", null, "queued", null)];
    const cancels = [{ runId: 100, attempt: 1, cause: "timeout" as const }];
    const limits = { noRunMinutes: 15, inProgressMinutes: 150, queuedHours: 6, rerunBarrierMinutes: 60 };
    const wait = classify(input([starvedRun(), scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(9, 50)), builtAt: at(0, 53), cancels, limits }));
    expect(wait.kind).toBe("pending");
    const stuck = classify(input([starvedRun(), scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(10, 30)), builtAt: at(0, 53), cancels, limits }));
    expect(stuck.kind).toBe("config");
  });
});

// GitHub has reported a job as `in_progress` with its conclusion and
// completed_at already set, in a run it reports `completed`. A status that is
// not `completed` is never trusted for a pass, so such a job keeps the batch
// pending, but only for the time limits a running job gets: past them it is a
// configuration problem (there is nothing left to cancel), which pauses.
describe("a completed run whose job list still shows a job running", () => {
  const at = (d: number, h: number, m = 0) => `2026-10-${d}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`;
  // The shape GitHub returned: the run completed and succeeded, the job still says in_progress.
  const doneRun = (over: Partial<Run> = {}) => ciRun({ status: "completed", conclusion: "success", created_at: at(21, 10), ...over });
  const staleJob = (conclusion: string | null = "success", status = "in_progress"): Job => ({
    ...job("Test", conclusion, status, at(21, 10, 1)),
    completed_at: at(21, 10, 40),
    run_attempt: 1,
  });
  const ci = (j: Job) => [job("Build", "success", "completed", at(21, 10, 1)), j, job("pr-gate", "skipped")];

  test("24 hours later it is not still pending: it is config, naming the job", () => {
    const c = classify(input([doneRun(), scanRun()], { "100": ci(staleJob()), "200": okScan }, { now: new Date(at(22, 10, 1)), builtAt: at(21, 10) }));
    expect(c.kind).toBe("config");
    if (c.kind === "config") expect(c.reason).toBe("CI run 100 completed, but job 'Test' still shows in_progress past its time limit");
  });

  test("within the in-progress limit it waits, and its success conclusion is never green", () => {
    const c = classify(input([doneRun(), scanRun()], { "100": ci(staleJob()), "200": okScan }, { now: new Date(at(21, 12, 30)), builtAt: at(21, 10) }));
    expect(c.kind).toBe("pending");
  });

  test("the limit is the job's own: past inProgressMinutes from its started_at", () => {
    const run = (m: number) => classify(input([doneRun(), scanRun()], { "100": ci(staleJob()), "200": okScan }, { now: new Date(at(21, 12, m)), builtAt: at(21, 10) }));
    expect(run(31).kind).toBe("pending"); // 150 minutes after 10:01
    expect(run(32).kind).toBe("config");
  });

  test("a failure conclusion on such a job is red at once, without waiting", () => {
    const c = classify(input([doneRun({ conclusion: "failure" }), scanRun()], { "100": ci(staleJob("failure")), "200": okScan }, { now: new Date(at(21, 10, 45)), builtAt: at(21, 10) }));
    expect(c.kind).toBe("red");
  });

  test("a job still queued in a completed run is bounded by queuedHours (nothing running)", () => {
    const queued = { ...staleJob(null, "queued"), started_at: null, completed_at: null };
    const at6h = (m: number) => classify(input([doneRun(), scanRun()], { "100": ci(queued), "200": okScan }, { now: new Date(at(21, 16, m)), builtAt: at(21, 10) }));
    expect(at6h(0).kind).toBe("pending");
    expect(at6h(1)).toMatchObject({ kind: "config", reason: "CI run 100 completed, but job 'Test' still shows queued past its time limit" });
  });

  test("whatever its jobs show, a completed run's stale job is bounded by queuedHours + inProgressMinutes", () => {
    // A job restarted at 18:00 is under its own limit and is in_progress, so only the hard cap (18:30) applies.
    const restarted = { ...staleJob(), started_at: at(21, 18) };
    const run = (h: number, m: number) => classify(input([doneRun(), scanRun()], { "100": ci(restarted), "200": okScan }, { now: new Date(at(21, h, m)), builtAt: at(21, 10) }));
    expect(run(18, 30).kind).toBe("pending");
    expect(run(18, 31).kind).toBe("config");
  });

  test("a run qlander already cancelled for time that then completed this way is not exempt", () => {
    const cancels = [{ runId: 100, attempt: 1, cause: "timeout" as const }];
    const c = classify(input([doneRun(), scanRun()], { "100": ci(staleJob()), "200": okScan }, { now: new Date(at(22, 10, 1)), builtAt: at(21, 10), cancels }));
    expect(c.kind).toBe("config");
  });

  test("a long job in a run still in progress keeps the existing timeout (cancel, then infra)", () => {
    const running = ciRun({ status: "in_progress", conclusion: null, created_at: at(21, 10) });
    const jobs = ci({ ...staleJob(null), completed_at: null });
    const ok = classify(input([running, scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(21, 12, 30)), builtAt: at(21, 10) }));
    expect(ok.kind).toBe("pending");
    const late = classify(input([running, scanRun()], { "100": jobs, "200": okScan }, { now: new Date(at(21, 12, 32)), builtAt: at(21, 10) }));
    expect(late).toMatchObject({ kind: "timeout", cause: "timeout" });
  });
});
