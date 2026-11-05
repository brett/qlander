// The watchdog's checks and alert lifecycle (src/watchdog-core.ts): every
// threshold at its boundary, unknown never opening or clearing an alert, and
// one issue per kind. Rendering is in watchdog-render.test.ts, whole runs and
// the REST client in watchdog-run.test.ts. No network.

import { describe, expect, test } from "bun:test";
import { alertBody, completions, evaluate, humanAge, type Observation, parseMarker, planAlerts, THRESHOLDS, time } from "../src/watchdog-core";
import { MAX_DISPATCHES_PER_HOUR } from "../src/wake";
import { ago, issue, NOW, obs, run, SEC, WAITING } from "./watchdog-fake";
import { CONTROL_SLUG } from "./sim";

const kinds = (o: Observation) => evaluate(o).alerts.map((a) => a.kind);
const unknownKinds = (o: Observation) => evaluate(o).unknown.map((u) => u.kind);
const failed = (min: number, step = "Run one queue tick") => run({ conclusion: "failure" }, { conclusion: "failure", completedAt: ago(min), steps: [{ name: step, conclusion: "failure" }] });

describe("checks", () => {
  test("healthy: no alert, no warning, nothing unknown", () => {
    expect(evaluate(obs())).toEqual({ alerts: [], warnings: [], unknown: [], notes: [] });
  });

  test("ticks stopped: the last completed queue tick older than 30 minutes; exactly 30 is fine", () => {
    expect(kinds(obs({ runs: [run({}, { completedAt: ago(30) })] }))).toEqual([]);
    const a = evaluate(obs({ runs: [run({}, { completedAt: ago(30 + SEC) })] })).alerts;
    expect(a.map((x) => x.kind)).toEqual(["ticks-stopped"]);
    expect(a[0]!.detail).toBe("the last tick finished 30m ago");
  });

  test("ticks stopped: no run at all, or no queue tick that actually ran", () => {
    expect(evaluate(obs({ runs: [] })).alerts[0]).toMatchObject({ kind: "ticks-stopped", detail: "tick.yml has no runs at all" });
    const replaced = run({ conclusion: "cancelled", createdAt: ago(2) }, { conclusion: "cancelled", steps: [], runnerName: null, completedAt: ago(1) });
    const branch = run({ branch: "feature", event: "workflow_dispatch" }, { completedAt: ago(1) });
    expect(kinds(obs({ runs: [replaced, branch] }))).toEqual(["ticks-stopped"]);
    const running = run({ status: "in_progress", conclusion: null, createdAt: ago(2) }, { status: "in_progress", conclusion: null, completedAt: null });
    expect(kinds(obs({ runs: [running, run({}, { completedAt: ago(40) })] }))).toEqual(["ticks-stopped"]);
  });

  test("self-chaining (DESIGN.md §11.1): dispatched runs count as ticks; a replaced pending dispatched job is not a failure", () => {
    const chained = run({ event: "workflow_dispatch", createdAt: ago(5) }, { completedAt: ago(1) });
    expect(kinds(obs({ runs: [chained, run({}, { completedAt: ago(40) })] }))).toEqual([]);
    const replaced = (min: number) => run({ event: "workflow_dispatch", conclusion: "cancelled", createdAt: ago(min) }, { conclusion: "cancelled", steps: [], runnerName: null, completedAt: ago(min) });
    expect(kinds(obs({ runs: [replaced(1), replaced(2), replaced(3), run({ event: "workflow_dispatch" }, { completedAt: ago(4) })] }))).toEqual([]);
  });

  test("the watchdog's one page of 100 runs covers ticks-stopped at the chained rate (30 an hour cap, plus the cron)", () => {
    expect(100 / (MAX_DISPATCHES_PER_HOUR + 6)).toBeGreaterThan(THRESHOLDS.stoppedMinutes / 60);
  });

  test("ticks failing: the last 3 completed queue jobs failed, with the newest failure's run", () => {
    const three = [failed(1), failed(11), failed(21)];
    const a = evaluate(obs({ runs: three })).alerts;
    expect(a.map((x) => x.kind)).toEqual(["ticks-failing"]);
    expect(a[0]!.url).toBe(three[0]!.url);
    expect(a[0]!.detail).toBe('the last 3 queue ticks failed; the newest failure at "Run one queue tick"');
    expect(a[0]!.key).toBe("failure:Run one queue tick");
    expect(kinds(obs({ runs: [failed(1), failed(11)] }))).toEqual([]);
    expect(kinds(obs({ runs: [failed(1), failed(11), run({}, { completedAt: ago(21) }), failed(31)] }))).toEqual([]);
    const timedOut = run({ conclusion: "cancelled" }, { conclusion: "cancelled", completedAt: ago(1), steps: [{ name: "Run one queue tick", conclusion: "cancelled" }] });
    const replaced = run({ conclusion: "cancelled" }, { conclusion: "cancelled", steps: [], runnerName: null, completedAt: ago(2) });
    expect(kinds(obs({ runs: [timedOut, replaced, failed(11), failed(21)] }))).toEqual(["ticks-failing"]);
  });

  test("runner not picking up: waiting more than 20 minutes; exactly 20 is fine", () => {
    const queued = (min: number) => run({ status: "queued", conclusion: null, createdAt: ago(min), runStartedAt: ago(min) }, { ...WAITING, createdAt: ago(min) }, null);
    const fresh = run({}, { completedAt: ago(5) });
    expect(kinds(obs({ runs: [queued(20), fresh] }))).toEqual([]);
    const a = evaluate(obs({ runs: [queued(20 + SEC), fresh] })).alerts;
    expect(a.map((x) => x.kind)).toEqual(["runner-stuck"]);
    expect(a[0]!.detail).toBe("a landing-queue run (tick) has waited 20m for a qlander runner");
    expect(kinds(obs({ runs: [run({ status: "in_progress", conclusion: null, createdAt: ago(25) }, { completedAt: ago(5) }, { ...WAITING, createdAt: ago(25) })] }))).toEqual(["runner-stuck"]);
    expect(kinds(obs({ runs: [run({ status: "in_progress", conclusion: null, createdAt: ago(25) }, { status: "in_progress", conclusion: null, completedAt: null }, null), fresh] }))).toEqual([]);
  });

  test("paused: a pause or release-pause open more than 2 hours alerts; a younger one warns", () => {
    expect(evaluate(obs({ pause: [issue(7, "pause: main is red", 120)] })).warnings).toEqual([
      { detail: "pause open for 2h: pause: main is red (issue 7)", url: `https://github.com/${CONTROL_SLUG}/issues/7` },
    ]);
    expect(evaluate(obs({ pause: [issue(7, "pause: main is red", 120 + SEC)] })).alerts).toEqual([
      { kind: "paused", key: "7", detail: "paused for 2h: pause: main is red (issue 7, pause)", url: `https://github.com/${CONTROL_SLUG}/issues/7` },
    ]);
    const r = evaluate(obs({ releasePause: [issue(9, "release pause: corrupt", 300)], pause: [issue(8, "pause: x", 200)] })).alerts[0]!;
    expect(r.detail).toBe("paused for 5h: release pause: corrupt (issue 9, release-pause) (and 1 more)");
    expect(r.key).toBe("8,9");
  });

  test("an open release-blocked issue warns, never alerts", () => {
    const r = evaluate(obs({ releaseBlocked: [issue(11, "diverged", 600)] }));
    expect(r.alerts).toEqual([]);
    expect(r.warnings.map((w) => w.detail)).toEqual(["release blocked: diverged (issue 11)"]);
  });

  test("the tick workflow disabled alerts", () => {
    expect(evaluate(obs({ workflowState: "disabled_manually" })).alerts).toEqual([expect.objectContaining({ kind: "workflow-disabled", key: "disabled_manually" })]);
  });

  test("the thresholds are the documented ones", () => {
    expect(THRESHOLDS).toEqual({ stoppedMinutes: 30, failingInARow: 3, queuedMinutes: 20, pausedHours: 2 });
    expect([humanAge(59 * 60_000), humanAge(61 * 60_000), humanAge(50 * 3600_000)]).toEqual(["59m", "1h 1m", "2d 2h"]);
  });
});

describe("timestamps, incomplete reads, completion order", () => {
  test("fix 2: a queued job without created_at waits from the attempt's start; 26 minutes alerts", () => {
    const r = run({ status: "in_progress", conclusion: null, createdAt: ago(60), runStartedAt: ago(26) }, { completedAt: ago(5) }, { ...WAITING, createdAt: null });
    expect(kinds(obs({ runs: [r] }))).toEqual(["runner-stuck"]);
    expect(evaluate(obs({ runs: [r] })).alerts[0]!.detail).toContain("waited 26m");
    // A waiting run has a queued job; one with no jobs and a newer finished tick is a ghost.
    const q = run({ status: "queued", conclusion: null, createdAt: ago(26), runStartedAt: null }, { ...WAITING, createdAt: null }, null);
    expect(kinds(obs({ runs: [q, run({}, { completedAt: ago(5) })] }))).toEqual(["runner-stuck"]);
  });

  test("fix 2: invalid timestamps are unknown, never OK", () => {
    expect([time("garbage"), time(""), time(null), time("2026-10-22T11:00:00Z")]).toEqual([null, null, null, Date.parse("2026-10-22T11:00:00Z")]);
    const bad = run({ status: "queued", conclusion: null, createdAt: "not a time", runStartedAt: null }, null, null);
    const e = evaluate(obs({ runs: [bad, run({}, { completedAt: ago(5) })] }));
    expect(e.alerts).toEqual([]);
    expect(e.unknown.map((u) => u.kind)).toEqual(["runner-stuck"]);
    const badDone = run({}, { completedAt: "yesterday" });
    expect(unknownKinds(obs({ runs: [badDone, run({}, { completedAt: ago(45) })] }))).toEqual(["ticks-stopped", "ticks-failing"]);
  });

  test("fix 4: an incomplete unfinished-run listing is unknown, not clear; a stuck run it did list still alerts", () => {
    expect(unknownKinds(obs({ unfinishedComplete: false }))).toEqual(["runner-stuck"]);
    const stuck = run({ status: "queued", conclusion: null, createdAt: ago(40), runStartedAt: ago(40) }, { ...WAITING, createdAt: ago(40) }, null);
    expect(kinds(obs({ unfinishedComplete: false, runs: [stuck, run({}, { completedAt: ago(5) })] }))).toEqual(["runner-stuck"]);
    // An in-progress run whose jobs were not read is unknown too.
    expect(unknownKinds(obs({ runs: [{ ...run({ status: "in_progress", conclusion: null }), jobs: undefined }, run({}, { completedAt: ago(5) })] }))).toEqual(["runner-stuck"]);
  });

  test("fix 5: an exhausted read budget is unknown for both completion checks; a fresh completion still clears ticks stopped", () => {
    expect(unknownKinds(obs({ jobsComplete: false, runs: [run({}, { completedAt: ago(45) })] }))).toEqual(["ticks-stopped", "ticks-failing"]);
    expect(unknownKinds(obs({ jobsComplete: false, runs: [run({}, { completedAt: ago(5) })] }))).toEqual(["ticks-failing"]);
    expect(kinds(obs({ jobsComplete: false, runs: [] }))).toEqual(["ticks-stopped"]); // no runs at all is certain
  });

  test("fix 6: order by job completion, not run creation: an older run rerun a minute ago is the newest tick", () => {
    const rerun = run({ createdAt: ago(60), runStartedAt: ago(2) }, { completedAt: ago(1) });
    const newerFailures = [failed(11), failed(21), failed(31)].map((r, i) => ({ ...r, createdAt: ago(15 + 10 * i) }));
    const runs = [...newerFailures, rerun];
    expect(completions(runs).done[0]!.run.id).toBe(rerun.id);
    expect(kinds(obs({ runs }))).toEqual([]); // the newest completion succeeded: not failing
    const staleSuccess = run({ createdAt: ago(5) }, { completedAt: ago(50) });
    expect(kinds(obs({ runs: [staleSuccess, failed(1), failed(2), failed(3)] }))).toEqual(["ticks-failing"]);
  });
});

describe("alert lifecycle", () => {
  const stopped = { kind: "ticks-stopped" as const, key: "41", detail: "the last tick finished 45m ago" };
  const open = (n: number) => issue(n, "qlander alert: ticks stopped", 60, alertBody(stopped, NOW));

  test("opens one issue when a condition starts", () => {
    const acts = planAlerts([stopped], [], [], NOW);
    expect(acts).toEqual([expect.objectContaining({ kind: "create", title: "qlander alert: ticks stopped" })]);
    expect(parseMarker((acts[0] as { body: string }).body)).toEqual({ kind: "ticks-stopped", key: "41" });
  });

  test("the same key again does nothing (no comment every 15 minutes), whatever the detail says", () => {
    expect(planAlerts([{ ...stopped, detail: "the last tick finished 2h ago" }], [], [open(5)], NOW)).toEqual([]);
  });

  test("a material change comments once and records the new key", () => {
    const acts = planAlerts([{ ...stopped, key: "42", detail: "the last tick finished 31m ago" }], [], [open(5)], NOW);
    expect(acts).toEqual([expect.objectContaining({ kind: "update", number: 5, comment: "Changed at 2026-10-22 12:00 UTC: the last tick finished 31m ago" })]);
    expect(parseMarker((acts[0] as { body: string }).body)!.key).toBe("42");
  });

  test("closes with a comment when the condition clears; an issue without our marker is left alone", () => {
    const acts = planAlerts([], [], [open(5), issue(6, "qlander alert: by hand", 10, "written by a person")], NOW);
    expect(acts).toEqual([{ kind: "close", number: 5, comment: "Cleared at 2026-10-22 12:00 UTC: ticks stopped no longer holds." }]);
  });

  test("an unknown check keeps its open issue and opens none", () => {
    expect(planAlerts([], [{ kind: "ticks-stopped", reason: "budget" }], [open(5)], NOW)).toEqual([]);
    expect(planAlerts([], [{ kind: "ticks-stopped", reason: "budget" }], [], NOW)).toEqual([]);
  });

  test("exactly one open issue per kind: duplicates are closed, the oldest kept", () => {
    expect(planAlerts([stopped], [], [open(9), open(5)], NOW)).toEqual([{ kind: "close", number: 9, comment: "Duplicate of #5: the watchdog keeps one open issue per alert." }]);
  });

  test("keys survive the marker round trip; unknown kinds are not ours", () => {
    const a = { kind: "ticks-failing" as const, key: "failure:Mint the queue App token (target only)", detail: "d" };
    expect(parseMarker(alertBody(a, NOW))).toEqual({ kind: "ticks-failing", key: a.key });
    expect(parseMarker("<!-- qlander-alert kind=constructor key=x -->")).toBeNull();
  });
});

describe("ghost tick runs: queued forever, no jobs, GitHub will not cancel or delete them", () => {
  // A run dispatched while tick.yml was disabled, queued 8h with zero jobs, while ticks completed every few minutes.
  const ghost = (min = 486) => run({ event: "workflow_dispatch", status: "queued", conclusion: null, createdAt: ago(min), runStartedAt: ago(min), updatedAt: ago(min) }, null, null);
  const fresh = () => run({ createdAt: ago(6) }, { completedAt: ago(5) });

  test("the ghost shape is a note, not an alert, and leaves the check clear", () => {
    const g = ghost();
    const e = evaluate(obs({ runs: [g, fresh()] }));
    expect(e.alerts).toEqual([]);
    expect(e.unknown).toEqual([]);
    expect(e.notes).toEqual([`ignored a ghost tick run ${g.id}: queued for 8h 6m with no jobs, and a newer tick has completed since; GitHub will not cancel or delete it`]);
  });

  test("a queued run with a job waiting for a runner still alerts, however old", () => {
    const stuck = run({ status: "queued", conclusion: null, createdAt: ago(486), runStartedAt: ago(486) }, { ...WAITING, createdAt: ago(486) }, null);
    const e = evaluate(obs({ runs: [stuck, fresh()] }));
    expect(e.alerts.map((a) => a.kind)).toEqual(["runner-stuck"]);
    expect(e.notes).toEqual([]);
  });

  test("a ghost with no newer completed tick still alerts", () => {
    const older = run({ createdAt: ago(500) }, { completedAt: ago(499) });
    const e = evaluate(obs({ runs: [ghost(), older] }));
    expect(e.alerts.map((a) => a.kind)).toEqual(["ticks-stopped", "runner-stuck"]);
    expect(e.notes).toEqual([]);
    // A newer run whose queue job never ran (replaced while pending) is not a completed tick.
    const replaced = run({ createdAt: ago(5), conclusion: "cancelled" }, { conclusion: "cancelled", steps: [], runnerName: null, completedAt: ago(4) });
    expect(kinds(obs({ runs: [ghost(), replaced, older] }))).toContain("runner-stuck");
    // An older run that finished late (a rerun) is not newer than the ghost.
    const rerun = run({ createdAt: ago(600) }, { completedAt: ago(1) });
    expect(kinds(obs({ runs: [ghost(), rerun] }))).toEqual(["runner-stuck"]);
  });

  test("a ghost is ignored once a newer tick finishes (no hour's wait); jobs unread or not queued is not a ghost", () => {
    // A ghost 26 minutes old with a newer tick finished raised a false alert under the old 60-minute rule.
    expect(kinds(obs({ runs: [ghost(26), fresh()] }))).toEqual([]);
    expect(kinds(obs({ runs: [{ ...ghost(), jobs: undefined }, fresh()] }))).toEqual(["runner-stuck"]);
    expect(kinds(obs({ runs: [{ ...ghost(), status: "pending" }, fresh()] }))).toEqual(["runner-stuck"]);
    // A rerun of a day-old run, waiting 25 minutes: judged from the attempt, so it alerts.
    const rerun = { ...ghost(1440), runStartedAt: ago(25) };
    expect(kinds(obs({ runs: [rerun, run({ createdAt: ago(29) }, { completedAt: ago(28) })] }))).toEqual(["runner-stuck"]);
    // The same rerun waiting over an hour, with a tick created and completed since it started, is a ghost.
    expect(kinds(obs({ runs: [{ ...rerun, runStartedAt: ago(90) }, fresh()] }))).toEqual([]);
  });
});
