// Whole watchdog runs against an in-memory GitHub (test/watchdog-fake.ts),
// and the REST client against realistic API payloads through a fake fetch.
// No network.

import { describe, expect, test } from "bun:test";
import { WatchdogClient } from "../src/github/watchdog-client";
import { QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "../src/main";
import { MAX_JOB_FETCHES, runWatchdog } from "../src/watchdog";
import { alertBody, evaluate } from "../src/watchdog-core";
import { ago, FakeRepo, NOW, obs, run, WAITING } from "./watchdog-fake";
import { watchdogLabelSets } from "../src/watchdog";
import { ISSUE_LABELS, NAMES, CONTROL_SLUG, LS } from "./sim";

const at = (min: number) => ({ now: new Date(NOW.getTime() + min * 60_000), runUrl: `https://github.com/${CONTROL_SLUG}/actions/runs/1`, modeVar: undefined });
const openAlerts = (gh: FakeRepo) => gh.issues.filter((i) => i.open && i.labels.includes("qlander-alert"));
const report = (log: string[]) => JSON.stringify({ mode: "dry-run", log, wouldDo: null }, null, 1);

describe("whole watchdog runs", () => {
  test("creates and pins the status issue once, then only rewrites its body", async () => {
    const gh = new FakeRepo();
    const r = run({}, { completedAt: ago(5) });
    gh.runs = [r];
    gh.logs.set(r.jobs![0]!.id, report(["idle: nothing to land"]));
    expect((await runWatchdog(gh, at(0))).level).toBe("OK");
    expect(gh.writes).toEqual(["create #1 qlander status", "pin I_1", "edit #1"]);
    expect(gh.issue(1).body).toContain("idle: nothing to land");
    gh.writes = [];
    await runWatchdog(gh, at(1));
    expect(gh.writes).toEqual(["edit #1"]);
    expect(gh.issue(1).comments).toEqual([]);
  });

  test("an alert opens once, stays quiet while unchanged, comments on a change, closes when it clears", async () => {
    const gh = new FakeRepo();
    gh.runs = [run({}, { completedAt: ago(45) })];
    await runWatchdog(gh, at(0));
    const alert = openAlerts(gh)[0]!;
    expect(alert.title).toBe("qlander alert: ticks stopped");
    const status = gh.issues.find((i) => i.labels.includes("qlander-status"))!;
    expect(status.body).toContain(`qlander-alert [issue ${alert.number}]`);
    for (const m of [15, 30, 45]) {
      gh.writes = [];
      await runWatchdog(gh, at(m));
      expect(gh.writes).toEqual([`edit #${status.number}`]);
    }
    expect(alert.comments).toEqual([]);
    gh.runs = [run({ createdAt: ago(-10) }, { completedAt: ago(-10) }), ...gh.runs]; // a newer tick, old by now: a material change
    await runWatchdog(gh, at(90));
    expect(alert.comments).toHaveLength(1);
    expect(alert.open).toBe(true);
    gh.runs = [run({ createdAt: ago(-100) }, { completedAt: ago(-100) }), ...gh.runs]; // ticks are back
    await runWatchdog(gh, at(105));
    expect(alert.open).toBe(false);
    expect(alert.comments.at(-1)).toStartWith("Cleared at");
    expect(openAlerts(gh)).toEqual([]);
  });

  test("unreadable logs and a refused pin degrade the status body, not the run", async () => {
    const gh = new FakeRepo();
    gh.runs = [run({}, { completedAt: ago(5) })];
    gh.logsReadable = false;
    gh.pinAllowed = false;
    expect((await runWatchdog(gh, at(0))).level).toBe("OK");
    expect(gh.issue(1).body).toContain("Job logs could not be read with this token");
    expect(gh.issue(1).body).toContain("could not pin this issue");
  });

  test("reads the jobs of only as many completed runs as it needs", async () => {
    const gh = new FakeRepo();
    gh.runs = Array.from({ length: 30 }, (_, i) => run({ createdAt: ago(10 * i + 1) }, { completedAt: ago(10 * i) }));
    await runWatchdog(gh, at(0));
    expect(gh.jobCalls).toBe(5);
  });
});

describe("whole runs", () => {
  test("fix 4: a run waiting behind more than a page of newer runs is still found, and the alert stays open", async () => {
    const gh = new FakeRepo();
    gh.recentPage = 30;
    const stuck = run({ status: "queued", conclusion: null, createdAt: ago(400), runStartedAt: ago(400) }, { ...WAITING, createdAt: ago(400) }, null);
    gh.runs = [stuck, ...Array.from({ length: 35 }, (_, i) => run({ createdAt: ago(10 * i + 1) }, { completedAt: ago(10 * i) }))];
    await runWatchdog(gh, at(0));
    expect(openAlerts(gh).map((i) => i.title)).toEqual(["qlander alert: runner not picking up ticks"]);
  });

  test("fix 4: an incomplete unfinished listing does not clear the runner alert", async () => {
    const gh = new FakeRepo();
    gh.runs = [run({}, { completedAt: ago(5) })];
    const a = gh.seed("qlander alert: runner not picking up ticks", ["qlander-alert"], 60, alertBody({ kind: "runner-stuck", key: "queued", detail: "d" }, NOW));
    gh.unfinishedTruncated = true;
    await runWatchdog(gh, at(0));
    expect(a.open).toBe(true);
    expect(a.comments).toEqual([]);
    gh.unfinishedTruncated = false;
    await runWatchdog(gh, at(15));
    expect(a.open).toBe(false);
  });

  test("a ghost tick run (queued, no jobs, a newer tick completed) closes the runner alert and is noted", async () => {
    const gh = new FakeRepo();
    const ghost = run({ event: "workflow_dispatch", status: "queued", conclusion: null, createdAt: ago(486), runStartedAt: ago(486), updatedAt: ago(486) }, null, null);
    gh.runs = [ghost, run({ createdAt: ago(6) }, { completedAt: ago(5) })];
    const a = gh.seed("qlander alert: runner not picking up ticks", ["qlander-alert"], 400, alertBody({ kind: "runner-stuck", key: "queued", detail: "d" }, NOW));
    const r = await runWatchdog(gh, at(0));
    expect(a.open).toBe(false);
    expect(r.level).toBe("OK");
    expect(r.evaluation.notes).toEqual([expect.stringContaining(`ghost tick run ${ghost.id}`)]);
    expect(gh.issues.find((i) => i.labels.includes("qlander-status"))!.body).toContain("**Notes**");
  });

  test("fix 5: runs that never started do not use up the budget into a false alert or a false clear", async () => {
    const replaced = (i: number) => run({ conclusion: "cancelled", createdAt: ago(i + 1), updatedAt: ago(i) }, { conclusion: "cancelled", steps: [], runnerName: null, completedAt: ago(i) }, null);
    const gh = new FakeRepo();
    const failing = [0, 1, 2].map((i) => run({ conclusion: "failure", createdAt: ago(60 + i), updatedAt: ago(60 + i) }, { conclusion: "failure", completedAt: ago(60 + i) }));
    // 15 never-started runs before three real failures: all read, so the failures are seen.
    gh.runs = [...Array.from({ length: 15 }, (_, i) => replaced(i)), ...failing];
    const failingAlert = gh.seed("qlander alert: ticks failing", ["qlander-alert"], 60, alertBody({ kind: "ticks-failing", key: "failure:", detail: "d" }, NOW));
    await runWatchdog(gh, at(0));
    expect(failingAlert.open).toBe(true); // still failing: not closed
    // More never-started runs than the budget: unknown, so neither alert opens nor closes.
    const gh2 = new FakeRepo();
    gh2.runs = [...Array.from({ length: MAX_JOB_FETCHES + 10 }, (_, i) => replaced(i)), ...failing];
    const kept = gh2.seed("qlander alert: ticks failing", ["qlander-alert"], 60, alertBody({ kind: "ticks-failing", key: "failure:", detail: "d" }, NOW));
    const r = await runWatchdog(gh2, at(0));
    expect(r.evaluation.unknown.map((u) => u.kind)).toEqual(["ticks-stopped", "ticks-failing"]);
    expect(kept.open).toBe(true);
    expect(openAlerts(gh2)).toHaveLength(1); // no "ticks stopped" opened on a guess
  });

  test("fix 6: an older run rerun a minute ago is read, and its report is the newest tick", async () => {
    const gh = new FakeRepo();
    const newer = Array.from({ length: 8 }, (_, i) => run({ conclusion: "failure", createdAt: ago(20 + i * 10) }, { conclusion: "failure", completedAt: ago(19 + i * 10) }));
    const rerun = run({ createdAt: ago(300), runStartedAt: ago(2) }, { completedAt: ago(1) });
    gh.runs = [...newer, rerun];
    gh.logs.set(rerun.jobs![0]!.id, report(["the rerun's report"]));
    for (const r of newer) gh.logs.set(r.jobs![0]!.id, report(["an older failure"]));
    const res = await runWatchdog(gh, at(0));
    expect(res.evaluation.alerts).toEqual([]); // the newest completion succeeded
    expect(gh.issues.find((i) => i.labels.includes("qlander-status"))!.body).toContain("the rerun's report");
  });
});

/** A fake fetch serving realistic REST payloads, by path and query. */
function restFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const key = `${u.pathname}${u.searchParams.get("status") ? `?status=${u.searchParams.get("status")}` : ""}`;
    const body = routes[key] ?? routes[u.pathname];
    if (body === undefined) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("the REST client against realistic payloads", () => {
  const R = `/repos/${CONTROL_SLUG}`;
  const rawRun = (id: number, status: string, created: string, started: string | null) => ({
    id,
    name: "tick",
    html_url: `https://github.com/${CONTROL_SLUG}/actions/runs/${id}`,
    event: "schedule",
    head_branch: "main",
    status,
    conclusion: null,
    created_at: created,
    updated_at: created,
    run_started_at: started,
    run_attempt: 1,
  });
  // A jobs payload as the API returns it for a waiting job: no created_at in this one, started_at null.
  const queuedJob = { id: 77, run_id: 9, run_attempt: 1, name: RELEASE_JOB_NAME, status: "queued", conclusion: null, started_at: null, completed_at: null, html_url: `https://github.com/${CONTROL_SLUG}/actions/runs/9/job/77`, runner_name: null, labels: ["qlander"], steps: [] };
  const doneJob = { id: 76, run_id: 9, run_attempt: 1, name: QUEUE_JOB_NAME, status: "completed", conclusion: "success", created_at: ago(27), started_at: ago(27), completed_at: ago(25), html_url: `https://github.com/${CONTROL_SLUG}/actions/runs/9/job/76`, runner_name: "ci-host-qlander-1", steps: [{ name: "Run one queue tick", status: "completed", conclusion: "success", number: 4 }] };

  test("a job waiting 26 minutes with no created_at alerts, from the attempt's start", async () => {
    const fetchFn = restFetch({
      [R]: { id: LS },
      [`${R}/actions/workflows/tick.yml/runs?status=in_progress`]: { total_count: 1, workflow_runs: [rawRun(9, "in_progress", ago(26), ago(26))] },
      [`${R}/actions/workflows/tick.yml/runs`]: { total_count: 0, workflow_runs: [] },
      [`${R}/actions/runs/9/jobs`]: { total_count: 2, jobs: [doneJob, queuedJob] },
    });
    const c = await WatchdogClient.connect({ ...watchdogLabelSets(ISSUE_LABELS), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: fetchFn });
    const { runs, truncated } = await c.listUnfinishedRuns();
    expect(truncated).toBe(false);
    expect(runs.map((r) => [r.id, r.status, r.runStartedAt])).toEqual([[9, "in_progress", ago(26)]]);
    runs[0]!.jobs = await c.listJobs(9);
    expect(runs[0]!.jobs[1]).toMatchObject({ status: "queued", createdAt: null, startedAt: null });
    const e = evaluate(obs({ runs: [...runs, run({}, { completedAt: ago(5) })] }));
    expect(e.alerts.map((a) => [a.kind, a.detail])).toEqual([["runner-stuck", "a landing-queue run (tick) has waited 26m for a qlander runner"]]);
  });

  test("a recent-runs listing shorter than it says is a failed read", async () => {
    for (const body of [{ total_count: 1, workflow_runs: [] }, {}]) {
      const fetchFn = restFetch({ [R]: { id: LS }, [`${R}/actions/workflows/tick.yml/runs`]: body });
      const c = await WatchdogClient.connect({ ...watchdogLabelSets(ISSUE_LABELS), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: fetchFn });
      await expect(c.listRecentRuns()).rejects.toThrow("the run listing is incomplete");
    }
  });

  test("a listing shorter than its total_count is reported truncated", async () => {
    const fetchFn = restFetch({
      [R]: { id: LS },
      [`${R}/actions/workflows/tick.yml/runs?status=queued`]: { total_count: 3, workflow_runs: [rawRun(5, "queued", ago(5), null)] },
      [`${R}/actions/workflows/tick.yml/runs`]: { total_count: 0, workflow_runs: [] },
    });
    const c = await WatchdogClient.connect({ ...watchdogLabelSets(ISSUE_LABELS), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: fetchFn });
    expect((await c.listUnfinishedRuns()).truncated).toBe(true);
  });

  test("an empty jobs listing is trusted only when total_count is 0", async () => {
    const fetchFn = restFetch({
      [R]: { id: LS },
      [`${R}/actions/runs/9/jobs`]: { total_count: 0, jobs: [] },
      [`${R}/actions/runs/10/jobs`]: { total_count: 1, jobs: [] },
      [`${R}/actions/runs/11/jobs`]: { jobs: [] },
    });
    const c = await WatchdogClient.connect({ ...watchdogLabelSets(ISSUE_LABELS), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: fetchFn });
    expect(await c.listJobs(9)).toEqual([]);
    await expect(c.listJobs(10)).rejects.toThrow("empty jobs listing with total_count 1");
    await expect(c.listJobs(11)).rejects.toThrow("empty jobs listing with total_count undefined");
  });
});

describe("an invalid qlander.yml", () => {
  test("is an alert, and the watchdog still monitors ticks; the alert clears when the config is fixed", async () => {
    const gh = new FakeRepo();
    gh.runs = [run({}, { completedAt: ago(45) })];
    const bad = { ok: false as const, reason: "$.version: must be 1", labels: ISSUE_LABELS };
    const r = await runWatchdog(gh, { ...at(0), modeVar: "live", config: bad });
    expect(r.level).toBe("ALERT");
    expect(r.evaluation.alerts.map((a) => a.kind).sort()).toEqual(["config-invalid", "ticks-stopped"]);
    const cfgAlert = openAlerts(gh).find((i) => i.title === "qlander alert: config invalid")!;
    expect(cfgAlert.body).toContain("config invalid: $.version: must be 1");
    const status = gh.issues.find((i) => i.labels.includes("qlander-status"))!;
    expect(status.body).toContain("qlander.yml is invalid");
    await runWatchdog(gh, { ...at(15), config: { ok: true, control: NAMES.control, releaseDryRun: true, labels: ISSUE_LABELS } });
    expect(cfgAlert.open).toBe(false);
  });
});
