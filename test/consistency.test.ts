// One test per review finding, run end to end through the
// real runner against a fake GitHub that is eventually consistent.

import { describe, expect, test } from "bun:test";
import { GitHubError } from "../src/github/http";
import { World } from "./world";

const pauses = (w: World) => w.repo.issues.filter((i) => i.labels.includes("pause"));
const reruns = (w: World) => w.target.calls.filter((c) => c.startsWith("rerun")).length;
const builds = (w: World) => w.target.calls.filter((c) => c.startsWith("createRef queue/")).length;

describe("review #2: a rerun request is never blindly resent", () => {
  test("accepted by GitHub but the response was lost, and getRun still shows the old attempt: wait, then confirm", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    w.readyPr(1);
    await w.untilBuilt();
    const rerun = w.target.rerunFailedJobs.bind(w.target);
    const getRun = w.target.getRun.bind(w.target);
    let stale = 0;
    w.target.rerunFailedJobs = async (id) => {
      await rerun(id); // GitHub accepted it...
      stale = 2; // ...and getRun lags for two ticks
      w.target.rerunFailedJobs = rerun;
      throw new GitHubError("server", 502, "bad gateway"); // ...but the response was lost
    };
    w.target.getRun = async (id) => {
      const r = await getRun(id);
      return r && stale > 0 ? { ...r, run_attempt: r.run_attempt - 1 } : r;
    };
    for (let i = 0; i < 12 && w.landed().length === 0; i++) {
      await w.tick();
      stale = Math.max(0, stale - 1);
    }
    expect(reruns(w)).toBe(1);
    expect(w.landed()).toEqual([[1]]);
  });
});

describe("review #3: recovery does not execute new work while paused", () => {
  test("a journalled rerun is not requested while an operator pause is open; it is after the pause closes", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    w.readyPr(1);
    await w.untilBuilt();
    let journalled = false;
    for (let i = 0; i < 4 && !journalled; i++) journalled = (await w.tick({ crash: "after-intent" })) === "crashed" && w.state().journal?.op.kind === "rerun";
    expect(journalled).toBe(true);
    const n = await w.repo.createIssue("operator pause", "maintenance", ["pause"]);
    expect(await w.tick()).toMatchObject({ outcome: "paused" });
    expect(reruns(w)).toBe(0);
    w.repo.issues.find((i) => i.number === n)!.open = false;
    await w.runUntilIdle();
    expect(reruns(w)).toBe(1);
    expect(w.landed()).toEqual([[1]]);
  });
});

describe("review #4: a hard-error pause is durable before the issue exists", () => {
  test("merge 403, then the pause issue cannot be created (502): nothing rebuilds or lands", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick(); // lists catch up
    w.target.merge = async () => {
      throw new GitHubError("auth", 403, "Resource not accessible by integration");
    };
    const create = w.repo.createIssue.bind(w.repo);
    w.repo.createIssue = async (title, body, labels) => {
      if (labels.includes("pause")) throw new GitHubError("server", 502, "down");
      return create(title, body, labels);
    };
    for (let i = 0; i < 6; i++) await w.tick();
    expect(w.state().outbox.some((n) => n.kind === "pause")).toBe(true);
    expect(builds(w)).toBe(0);
    expect(w.mainHistory).toHaveLength(1);
    w.repo.createIssue = create;
    await w.tick();
    expect(w.paused()).toBe(true);
  });
});

describe("review #5: classification waits for the rerun's attempt", () => {
  test("lists still show attempt 1's failure after attempt 2 passed: no bounce", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    w.target.listLag = 2;
    w.readyPr(1);
    await w.runUntilIdle();
    expect(w.bounced()).toEqual([]);
    expect(w.landed()).toEqual([[1]]);
  });
});

describe("review #6: a missing target ends recovery, and retries are bounded", () => {
  test("the run to rerun was deleted: a terminal outcome and a pause, not a wedge", async () => {
    const w = new World(() => "fail");
    w.readyPr(1);
    await w.untilBuilt();
    let journalled = false;
    for (let i = 0; i < 4 && !journalled; i++) journalled = (await w.tick({ crash: "after-intent" })) === "crashed" && w.state().journal?.op.kind === "rerun";
    const op = w.state().journal!.op;
    if (op.kind !== "rerun") throw new Error("expected a rerun");
    w.target.runs = w.target.runs.filter((r) => r.id !== op.runs[0]!.runId);
    await w.tick();
    expect(w.state().journal).toBeNull();
    expect(w.pauseReasons().join(" ")).toContain("no longer exist");
  });

  test("an outstanding op that keeps failing is abandoned after maxOpTries, with a pause", async () => {
    const w = new World(() => "hang");
    w.readyPr(1);
    await w.untilBuilt();
    w.target.cancelRun = async () => {
      throw new GitHubError("server", 502, "down");
    };
    for (let i = 0; i < 25 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    expect(w.pauseReasons().join(" ")).toContain("re-executed");
    expect(w.state().journal).toBeNull();
  });
});

describe("review #7: a checkpointed batch is revalidated before it is pushed", () => {
  test("a PR pushed while the runner was down: the stale batch is not pushed, no CI is spent on it", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.tick(); // lists catch up
    expect(await w.tick({ crash: "after-checkpoint" })).toBe("crashed");
    w.target.push(2); // new head while the runner was down
    await w.runUntilIdle();
    const queued = w.verdicts.map(([n]) => n);
    expect(new Set(queued).size).toBe(queued.filter((n, i) => queued.indexOf(n) === i).length);
    expect(w.landed()).toEqual([[1]]);
    // the checkpointed batch [1, 2] never reached CI
    expect(w.verdicts.every(([n]) => n !== w.state().history.find((h) => h.prs.includes(2))?.n)).toBe(true);
    expect(builds(w)).toBe(1);
  });
});

describe("review #8: a comment is never reposted on one negative (lagging) list", () => {
  test("posted, then the runner died before the receipt; listComments lags: no duplicate", async () => {
    const w = new World();
    w.target.commentLag = 2; // two negative list responses, inside the 30-minute reconcile window
    w.readyPr(1);
    await w.tick();
    let died = false;
    // Die right after a comment was posted, before its receipt is saved.
    for (let i = 0; i < 4 && !died; i++) died = (await w.tick({ crashWhen: (p) => p === "mid-drain" && w.target.posted.length > 0 })) === "crashed";
    expect(died).toBe(true);
    await w.runUntilIdle();
    const bodies = w.target.posted.map((p) => p.body);
    expect(new Set(bodies).size).toBe(bodies.length);
  });
});

describe("review #9: cancellation keeps looking for late-published runs", () => {
  test("an abandoned batch's run appears only after the cancel: it is still cancelled", async () => {
    const w = new World(() => "hang");
    w.target.listLag = 3; // the queue run is published late
    for (const n of [1, 2]) w.readyPr(n);
    await w.untilBuilt();
    w.target.push(2); // abandon the batch before its run is visible
    for (let i = 0; i < 10; i++) await w.tick();
    const queueRuns = w.target.runs.filter((r) => r.head_branch?.startsWith("queue/"));
    const first = queueRuns[0]!;
    expect(first.conclusion).toBe("cancelled");
  });
});

describe("review #10: a bounced PR whose label removal keeps failing is not readmitted", () => {
  test("removeLabel returns 502 every time: one build, then nothing", async () => {
    const w = new World(() => "fail");
    w.readyPr(1);
    w.target.removeLabel = async () => {
      throw new GitHubError("server", 502, "down");
    };
    for (let i = 0; i < 15; i++) await w.tick();
    expect(w.bounced()).toEqual([1]);
    expect(builds(w)).toBe(1);
  });
});

describe("review #11: one persistent outbox failure opens one pause issue", () => {
  test("a queue ref deletion keeps being rejected: a single pause issue across ticks", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    const n = w.state().active!.n;
    w.target.rejectDeletes.add(`queue/${n}`);
    for (let i = 0; i < 8; i++) await w.tick();
    expect(pauses(w)).toHaveLength(1);
  });
});

describe("review #12: verification really runs after landing", () => {
  test("merge detection lags: verification waits, then removes ready and completes", async () => {
    const w = new World();
    w.target.mergeLag = 2;
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    expect(w.state().verify).toEqual([]);
    for (const n of [1, 2]) {
      const pr = w.target.prs.get(n)!.pr;
      expect(pr.merged).toBe(true);
      expect(pr.labels).not.toContain("ready");
    }
    expect(w.target.calls.filter((c) => c.startsWith("unlabel")).length).toBe(2);
  });
});
