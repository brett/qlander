// The real runner, end to end against the fake GitHub (DESIGN.md §5.5).

import { describe, expect, test } from "bun:test";
import { World } from "./world";
import { APPROVERS, LANE } from "./sim";

describe("runner: worked cases", () => {
  test("happy path: three PRs land in one batch, are marked merged, and verified", async () => {
    const w = new World();
    for (const n of [1, 2, 3]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2, 3]]);
    for (const n of [1, 2, 3]) {
      expect(w.target.prs.get(n)!.pr.merged).toBe(true);
      expect(w.comments(n).some((c) => c.startsWith("Landed in main"))).toBe(true);
    }
    expect([...w.greenHeads]).toContain(w.target.refs.get("main")!);
    expect(w.target.refs.has("queue/1") || [...w.target.refs.keys()].some((k) => k.startsWith("queue/"))).toBe(false);
  });
});

/** Invariant 1 (DESIGN.md §1): every value main took was a commit whose pre-landing CI passed. */
function assertOnlyTestedLanded(w: World): void {
  for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
  for (const m of w.mainHistory.slice(1)) {
    for (const c of w.target.commits.values()) if (c.sha === m) expect(c.verified).toBe(true);
  }
}

describe("runner: the design's worked cases", () => {
  test("base moved mid-run: rebuild on the new main, never push the stale tree", async () => {
    const w = new World();
    w.readyPr(1);
    w.readyPr(2);
    await w.untilBuilt();
    // a human break-glass merge moves main
    const human = w.target.commit([w.target.refs.get("main")!], "human");
    w.target.githubUpdateRefs("main", w.target.refs.get("main")!, human);
    w.greenHeads.add(human); // not ours to judge
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    expect(w.state().history.some((h) => h.outcome === "rebuilt")).toBe(true);
    expect(w.target.calls.filter((c) => c.startsWith("updateRef main")).length).toBe(1);
    assertOnlyTestedLanded(w);
  });

  test("flaky failure: one rerun of the failed jobs clears it", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2, 3, 4]]);
    expect(w.target.calls.filter((c) => c.startsWith("rerun")).length).toBe(1);
    assertOnlyTestedLanded(w);
  });

  test("a culprit in a batch of 5 is bounced with job links; the other 4 land", async () => {
    const w = new World((b) => (b.prs.includes(3) ? "fail" : "pass"));
    for (const n of [1, 2, 3, 4, 5]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2], [4, 5]]);
    expect(w.bounced()).toEqual([3]);
    const bounce = w.comments(3).find((c) => c.startsWith("Bounced"))!;
    expect(bounce).toContain(`[${LANE}](https://github.com/x/${encodeURIComponent(LANE)})`);
    expect(w.target.prs.get(3)!.pr.labels).not.toContain("ready");
    expect(w.target.prs.get(3)!.pr.state).toBe("open");
    assertOnlyTestedLanded(w);
  });

  test("A and B pass alone but fail together: A lands, B is bounced", async () => {
    const w = new World((b) => {
      const has = (x: number) => b.prs.includes(x) || b.mainHas.includes(x);
      return has(1) && has(2) ? "fail" : "pass";
    });
    w.readyPr(1);
    w.readyPr(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.bounced()).toEqual([2]);
    assertOnlyTestedLanded(w);
  });

  test("a PR's head changes while queued: dropped, the rest rebuilt and landed", async () => {
    const w = new World();
    for (const n of [1, 2, 3]) w.readyPr(n);
    await w.untilBuilt();
    w.target.push(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 3]]);
    expect(w.target.prs.get(2)!.pr.labels).not.toContain("ready");
    expect(w.comments(2).some((c) => c.includes("head moved"))).toBe(true);
    assertOnlyTestedLanded(w);
  });

  test("a conflict drops that PR during the build", async () => {
    const w = new World();
    for (const n of [1, 2, 3]) w.readyPr(n);
    w.target.conflicts.add(w.target.prs.get(2)!.pr.head.sha);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 3]]);
    expect(w.comments(2).some((c) => c.includes("conflicts with main"))).toBe(true);
    assertOnlyTestedLanded(w);
  });

  test("a skipped required job is never green: config pause, nothing lands", async () => {
    const w = new World(() => "skip");
    w.readyPr(1);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    expect(w.paused()).toBe(true);
    expect(w.pauseReasons()[0]).toContain("configuration problem");
    expect(w.mainHistory).toHaveLength(1);
  });

  test("a cancelled job is never green: one rerun, then a pause", async () => {
    const w = new World(() => "cancel");
    w.readyPr(1);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    expect(w.target.calls.filter((c) => c.startsWith("rerun")).length).toBe(1);
    expect(w.pauseReasons()[0]).toContain("still inconclusive");
  });

  test("a hung run is cancelled for time, rerun, and lands when the rerun passes", async () => {
    const w = new World((b) => (b.attempt === 1 ? "hang" : "pass"));
    w.readyPr(1);
    await w.runUntilIdle();
    expect(w.target.calls.some((c) => c.startsWith("cancel"))).toBe(true);
    expect(w.state().history.at(-1)!.outcome).toBe("landed");
    assertOnlyTestedLanded(w);
  });

  test("an aggregate job failing only because a lane was cancelled is infra: one rerun, then a pause, never a split", async () => {
    const w = new World(() => "cancelAggregate");
    for (const n of [1, 2, 3]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    expect(w.target.calls.filter((c) => c.startsWith("rerun")).length).toBe(1);
    expect(w.pauseReasons()[0]).toContain("still inconclusive");
    expect(w.state().history.some((h) => h.outcome === "split")).toBe(false);
  });

  test("a real lane failure alongside a cancellation and a failed aggregate is still red: the batch splits", async () => {
    const w = new World((b) => (b.prs.length > 1 ? "failCancelAggregate" : "pass"));
    for (const n of [1, 2, 3]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.state().history.some((h) => h.outcome === "split")).toBe(true);
    assertOnlyTestedLanded(w);
  });

  test("a batch starved of runners is not cancelled for waiting: only after queuedHours", async () => {
    const w = new World((b) => (b.attempt === 1 ? "starve" : "pass"));
    const start = w.now.getTime();
    const at: number[] = [];
    const cancel = w.target.cancelRun.bind(w.target);
    w.target.cancelRun = async (id: number) => {
      at.push(w.now.getTime());
      return cancel(id);
    };
    w.readyPr(1);
    await w.runUntilIdle();
    expect(at.length).toBeGreaterThan(0);
    expect(at[0]! - start).toBeGreaterThanOrEqual(6 * 3_600_000);
    expect(w.state().history.at(-1)!.outcome).toBe("landed");
    assertOnlyTestedLanded(w);
  });

  test("lineage budget: an always-red batch stops and unreadies its PRs", async () => {
    const w = new World(() => "fail", { lineageBudget: 3 });
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    for (const n of [1, 2, 3, 4]) expect(w.target.prs.get(n)!.pr.labels).not.toContain("ready");
    const runs = w.target.calls.filter((c) => c.startsWith("createRef queue/") || c.startsWith("rerun")).length;
    expect(runs).toBe(3);
  });

  test("a policy PR runs alone, and only with a SHA-bound approval", async () => {
    const w = new World();
    w.readyPr(1);
    const p = w.readyPr(2, { files: [".github/workflows/ci.yml"] });
    w.readyPr(3);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 3]]); // #2 waits: no approval
    p.comments.push({ id: 77, user: { login: APPROVERS[1]!.login, id: APPROVERS[1]!.id }, body: `/qlander approve-policy ${p.pr.head.sha}`, created_at: "t", updated_at: "t" });
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 3], [2]]);
    assertOnlyTestedLanded(w);
  });

  test("a policy PR whose batch skips a required job is bounced with the reason, not a rerun story", async () => {
    const w = new World(() => "skip");
    const p = w.readyPr(1, { files: [".github/workflows/ci.yml"] });
    p.comments.push({ id: 78, user: { login: APPROVERS[1]!.login, id: APPROVERS[1]!.id }, body: `/qlander approve-policy ${p.pr.head.sha}`, created_at: "t", updated_at: "t" });
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    expect(w.bounced()).toEqual([1]);
    const bounce = w.comments(1).find((c) => c.startsWith("Bounced"))!;
    expect(bounce).toContain(`failed: CI: '${LANE}' skipped.`);
    expect(bounce).not.toContain("rerun");
  });

  test("an unsigned merge commit pauses before any CI runs", async () => {
    const w = new World();
    w.readyPr(1);
    w.target.unsignedMerges = true;
    await w.runUntilIdle();
    expect(w.verdicts).toEqual([]);
    expect(w.pauseReasons()[0]).toContain("not signed");
    expect([...w.target.refs.keys()].filter((k) => k !== "main")).toEqual([]);
    expect(w.state().window).toEqual([]);
  });

  test("a PR whose head branch is named main is never queued", async () => {
    const w = new World();
    w.readyPr(1, { headRef: "main" });
    w.readyPr(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[2]]);
  });

  test("operator bounce through a PR label", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.untilBuilt();
    w.command("bounce", 2);
    await w.tick();
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });
});

describe("runner: state and errors", () => {
  test("corrupt state on the state ref pauses without acting", async () => {
    const w = new World();
    w.readyPr(1);
    await w.stateRef.create("not state");
    expect(await w.tick()).toMatchObject({ outcome: "paused" });
    expect(w.pauseReasons()[0]).toContain("corrupt state");
    expect(w.target.calls.some((c) => c.startsWith("createRef"))).toBe(false);
  });

  test("once the state ref exists, the mirror issue is never read: garbage in it changes nothing", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick(); // creates the state ref and its mirror
    const mirror = w.repo.issues.find((i) => i.labels.includes("qlander-state"))!;
    mirror.body = "garbage";
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });

  test("a stale snapshot (PR force-pushed mid-read) retries next tick without acting", async () => {
    const w = new World();
    w.readyPr(1);
    let once = true;
    w.target.afterGetPr = (n, calls) => {
      if (once && calls === 1) {
        once = false;
        w.target.push(1);
        w.evidence(1);
      }
    };
    expect(await w.tick()).toMatchObject({ outcome: "stale" });
    expect(w.target.calls.some((c) => c.startsWith("createRef"))).toBe(false);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });

  test("a transient GitHub error retries later; a permission error pauses", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick(); // lists catch up
    const { GitHubError } = await import("../src/github/http");
    const merge = w.target.merge.bind(w.target);
    let fail: "server" | "auth" | null = "server";
    w.target.merge = async (...a) => {
      if (fail) throw new GitHubError(fail, fail === "server" ? 502 : 403, "boom");
      return merge(...a);
    };
    expect(await w.tick()).toMatchObject({ outcome: "retry-later" });
    expect(w.paused()).toBe(false);
    fail = null;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);

    const v = new World();
    v.readyPr(1);
    await v.tick(); // lists catch up
    v.target.merge = async () => {
      throw new GitHubError("auth", 403, "Resource not accessible by integration");
    };
    expect(await v.tick()).toMatchObject({ outcome: "paused" });
    expect(v.pauseReasons()[0]).toContain("auth");
  });
});

describe("runner: landing races", () => {
  test("main moving between decide and the CAS: the CAS fails, nothing lands stale, the batch is rebuilt", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    const cas = w.target.updateRef.bind(w.target);
    let raced = false;
    w.target.updateRef = async (branch, before, after) => {
      if (!raced) {
        raced = true;
        const human = w.target.commit([w.target.refs.get("main")!], "human-race");
        w.target.githubUpdateRefs("main", w.target.refs.get("main")!, human);
        w.greenHeads.add(human);
      }
      return cas(branch, before, after);
    };
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
    expect(w.state().history.some((h) => h.outcome === "rebuilt")).toBe(true);
    for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
  });
});
