// The worked cases of DESIGN.md §5.5, driven end to end through decide() and
// applyOpResult() by the simulator.

import { describe, expect, test } from "bun:test";
import type { CiClass } from "../src/classify";
import { defaultConfig } from "../src/config";
import { decide, VERIFY_MIN_MINUTES } from "../src/machine";
import { cfg, cmd, green, livePr, red, sha, Sim } from "./sim";

const ids = (...n: number[]) => n.map((x) => livePr(x));

describe("happy path", () => {
  test("three ready PRs land as one batch, then verify sees them merged", () => {
    const sim = new Sim().add(...ids(1, 2, 3));
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1, 2, 3]]);
    expect(sim.builds).toHaveLength(1);
    expect(sim.state.verify).toHaveLength(3);
    sim.tick();
    expect(sim.state.verify).toHaveLength(0);
  });

  test("batch size respects maxBatch, oldest admitted first", () => {
    const sim = new Sim(cfg({ maxBatch: 2 })).add(...ids(1, 2, 3));
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1, 2], [3]]);
  });
});

describe("base moved mid-run", () => {
  test("green on a stale base rebuilds and never lands the stale tree", () => {
    let moved = false;
    const sim = new Sim(cfg(), (b) => {
      if (!moved) {
        moved = true;
        sim.main = sha("someone-else");
      }
      return green;
    }).add(...ids(1, 2));
    sim.runUntilIdle();
    expect(sim.builds.map((b) => b.rebuild)).toEqual([false, true]);
    expect(sim.builds[1]!.base).toBe(sha("someone-else"));
    // every land was attempted only from the base its batch was built on
    for (const l of sim.lands) expect(l.before).toBe(l.mainAtLand);
    expect(sim.landed).toEqual([[1, 2]]);
  });

  test("main moving between decide and updateRefs: no push, then rebuild", () => {
    const sim = new Sim().add(...ids(1, 2));
    let raced = false;
    sim.beforeLand = () => {
      if (!raced) {
        raced = true;
        sim.main = sha("raced");
      }
    };
    sim.runUntilIdle();
    expect(sim.lands[0]!.before).not.toBe(sim.lands[0]!.mainAtLand);
    expect(sim.landed).toEqual([[1, 2]]);
    expect(sim.builds.map((b) => b.rebuild)).toEqual([false, true]);
  });
});

describe("red batches", () => {
  test("a flaky failure is cleared by one rerun of the failed jobs", () => {
    const sim = new Sim(cfg(), (b) => (b.rerun ? green : red())).add(...ids(1, 2, 3, 4));
    sim.runUntilIdle();
    expect(sim.reruns).toBe(1);
    expect(sim.landed).toEqual([[1, 2, 3, 4]]);
    expect(sim.bounced).toEqual([]);
  });

  test("a culprit in a batch of 5 is bounced and the other 4 land", () => {
    const sim = new Sim(cfg(), (b) => (b.prs.includes(3) ? red(["Test (shard 1)"]) : green)).add(...ids(1, 2, 3, 4, 5));
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1, 2], [4, 5]]);
    expect(sim.bounced).toEqual([3]);
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2, 3, 4, 5], [1, 2], [3, 4, 5], [3], [4, 5]]);
    expect(sim.reruns).toBe(3);
    const bounce = sim.comments.find((c) => c.pr === 3 && c.body.startsWith("Bounced"))!;
    expect(bounce.body).toContain("[Test (shard 1)](https://github.com/j/Test (shard 1))");
    expect(sim.prs["3"]!.labels).not.toContain("ready");
  });

  test("A and B pass alone but fail together: A lands, B is bounced on main+A", () => {
    const sim = new Sim(cfg(), (b) => {
      const has = (x: number) => b.prs.includes(x) || b.mainHas.includes(x);
      return has(1) && has(2) ? red() : green;
    }).add(...ids(1, 2));
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1]]);
    expect(sim.bounced).toEqual([2]);
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2], [1], [2]]);
    expect(sim.reruns).toBe(2);
  });

  test("split depth is capped at 2; deeper failures are tested one PR at a time", () => {
    const sim = new Sim(cfg(), (b) => (b.prs.includes(5) ? red() : green)).add(...ids(1, 2, 3, 4, 5, 6, 7, 8));
    sim.runUntilIdle();
    expect(sim.builds.map((b) => b.prs)).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [5, 6],
      [5],
      [6],
      [7, 8],
    ]);
    expect(sim.bounced).toEqual([5]);
    expect(sim.landed.flat().sort()).toEqual([1, 2, 3, 4, 6, 7, 8]);
    // The depth-2 batch [5,6] is not split again: its PRs go to solo.
    expect(sim.state.history.filter((h) => h.outcome === "split").map((h) => h.prs)).toEqual([
      [1, 2, 3, 4, 5, 6, 7, 8],
      [5, 6, 7, 8],
    ]);
    expect(sim.state.history.find((h) => h.outcome === "solo")!.prs).toEqual([5, 6]);
    // DESIGN.md §16: 7 builds + 4 reruns, inside the default lineage budget.
    expect(sim.builds.length + sim.reruns).toBe(11);
    expect(sim.builds.length + sim.reruns).toBeLessThanOrEqual(cfg().lineageBudget);
  });

  test("a single PR failing only what main already fails pauses instead of bouncing", () => {
    const sim = new Sim(cfg(), () => red(["Test"])).add(...ids(1));
    sim.mainFailedJobs = ["Test"];
    sim.runUntilIdle();
    expect(sim.bounced).toEqual([]);
    expect(sim.pauses[0]).toContain("main is red");
    expect(sim.state.pending).toEqual([{ prs: [1], depth: 0, lineage: 1 }]);
  });

  test("three bounces in a row trip the circuit breaker", () => {
    const sim = new Sim(cfg({ maxBatch: 1, minBatch: 1 }), () => red()).add(...ids(1, 2, 3, 4));
    sim.runUntilIdle();
    expect(sim.bounced).toEqual([1, 2, 3]);
    expect(sim.pauses.at(-1)).toContain("3 bounces in a row");
    expect(sim.state.auth["4"]).toBeDefined();
  });

});

describe("PR changes while queued", () => {
  test("a head that changes while queued drops the PR and rebuilds without it", () => {
    const sim = new Sim().add(...ids(1, 2, 3));
    sim.tick(); // builds [1,2,3]
    expect(sim.state.active?.prs).toEqual([1, 2, 3]);
    sim.prs["2"] = { ...sim.prs["2"]!, head: sha("pr2-v2") };
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1, 3]]);
    expect(sim.prs["2"]!.labels).not.toContain("ready");
    expect(sim.comments.some((c) => c.pr === 2 && c.body.includes("head moved"))).toBe(true);
    expect(sim.state.outbox).toEqual([]);
  });

  test("removing ready by hand drops the PR without a comment", () => {
    const sim = new Sim().add(...ids(1, 2));
    sim.tick();
    sim.prs["2"] = { ...sim.prs["2"]!, labels: [], ready: null };
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1]]);
    expect(sim.comments.some((c) => c.pr === 2 && !c.body.startsWith("Queued"))).toBe(false);
  });

  test("a conflict drops that PR from the build and the rest are tested", () => {
    const sim = new Sim().add(...ids(1, 2, 3));
    sim.conflicts.add(2);
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1, 3]]);
    expect(sim.prs["2"]!.labels).not.toContain("ready");
    expect(sim.comments.find((c) => c.pr === 2)!.body).toContain("conflicts with main");
  });

  test("a batch where everything conflicts is empty and refunds its run", () => {
    const sim = new Sim().add(...ids(1));
    sim.conflicts.add(1);
    sim.runUntilIdle();
    expect(sim.landed).toEqual([]);
    expect(sim.state.window).toEqual([]);
    expect(sim.state.history.at(-1)!.outcome).toBe("empty");
  });
});

describe("CI classes other than red and green", () => {
  test("config pauses at once, without a rerun, split or bounce", () => {
    const sim = new Sim(cfg(), () => ({ kind: "config", reason: "CI: 'Test' skipped" })).add(...ids(1, 2));
    sim.runUntilIdle();
    expect(sim.reruns).toBe(0);
    expect(sim.bounced).toEqual([]);
    expect(sim.pauses[0]).toContain("configuration problem");
    expect(sim.state.pending[0]!.prs).toEqual([1, 2]);
  });

  test("infra reruns once, then pauses if still inconclusive", () => {
    const infra: CiClass = { kind: "infra", runs: [{ runId: 9, attempt: 1 }], reason: "cancelled" };
    const sim = new Sim(cfg(), () => infra).add(...ids(1));
    sim.runUntilIdle();
    expect(sim.reruns).toBe(1);
    expect(sim.bounced).toEqual([]);
    expect(sim.pauses[0]).toContain("still inconclusive");
  });

  test("timeout cancels the runs and records the cause; the next class is infra", () => {
    let ticks = 0;
    const sim = new Sim(cfg(), (b) => {
      ticks++;
      if (ticks === 1) return { kind: "timeout", runs: [{ runId: 7, attempt: 1 }], cause: "timeout", reason: "late" };
      if (!b.rerun) return { kind: "infra", runs: [{ runId: 7, attempt: 1 }], reason: "cancelled by qlander" };
      return green;
    }).add(...ids(1));
    sim.tick(); // build
    sim.tick(); // timeout → cancel op performed
    expect(sim.state.active!.cancels).toEqual([{ runId: 7, attempt: 1, cause: "timeout" }]);
    sim.runUntilIdle();
    expect(sim.reruns).toBe(1);
    expect(sim.landed).toEqual([[1]]);
  });

  test("pending waits", () => {
    const sim = new Sim(cfg(), () => ({ kind: "pending", reason: "CI" })).add(...ids(1));
    sim.tick();
    const log = sim.tick();
    expect(log.some((l) => l.includes("pending"))).toBe(true);
    expect(sim.state.journal).toBeNull();
  });
});

describe("budgets", () => {
  test("lineage budget: a batch that keeps failing stops and unreadies its PRs", () => {
    const sim = new Sim(cfg({ lineageBudget: 3 }), () => red()).add(...ids(1, 2, 3, 4));
    sim.runUntilIdle();
    const runs = sim.builds.length + sim.reruns;
    expect(runs).toBe(3);
    for (const n of [1, 2, 3, 4]) expect(sim.prs[String(n)]!.labels).not.toContain("ready");
    expect(sim.comments.some((c) => c.body.includes("retry budget"))).toBe(true);
    expect(sim.state.pending).toEqual([]);
    expect(sim.state.solo).toEqual([]);
  });

  test("window budget pauses before a build", () => {
    const sim = new Sim(cfg({ windowBudget: 1, maxBatch: 1, minBatch: 1 })).add(...ids(1, 2));
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1]]);
    expect(sim.pauses[0]).toContain("window budget");
  });

  test("window entries older than the window are pruned", () => {
    const sim = new Sim(cfg({ windowBudget: 1, maxBatch: 1, minBatch: 1 })).add(...ids(1, 2));
    sim.state.window = [{ at: "2026-10-20T00:00:00Z", cost: 1 }];
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1]]);
  });

  test("reruns are charged against the lineage", () => {
    const sim = new Sim(cfg(), (b) => (b.rerun ? green : red())).add(...ids(1));
    sim.runUntilIdle();
    expect(sim.state.lineages["1"]).toEqual({ runs: 2 });
  });
});

describe("policy PRs (DESIGN.md §4.3)", () => {
  test("a policy PR without a SHA-bound approval is not admitted", () => {
    const sim = new Sim().add(livePr(1, { policyPr: true }));
    const log = sim.tick();
    expect(sim.state.auth["1"]).toBeUndefined();
    expect(log.join("\n")).toContain("SHA-bound approval");
  });

  test("an approved policy PR always runs alone, never batched with others", () => {
    const sim = new Sim().add(livePr(1), livePr(2, { policyPr: true, policyApproval: true }), livePr(3));
    sim.runUntilIdle();
    expect(sim.builds.map((b) => b.prs)).toEqual([[1], [2], [3]]);
  });

  test("a PR reclassified as policy while queued is dropped", () => {
    const sim = new Sim().add(...ids(1, 2));
    sim.tick();
    sim.prs["2"] = { ...sim.prs["2"]!, policyPr: true, policyApproval: true };
    sim.runUntilIdle();
    expect(sim.landed[0]).toEqual([1]);
  });

  test("operator solo makes a PR run alone", () => {
    const sim = new Sim().add(...ids(1, 2, 3));
    sim.tick({ commands: [cmd("solo", 1)] });
    sim.runUntilIdle();
    expect(sim.builds[0]!.prs).toEqual([1]);
  });
});

describe("operator bounce", () => {
  test("bouncing a PR in the active batch abandons it and rebuilds the rest", () => {
    const sim = new Sim().add(...ids(1, 2, 3));
    sim.tick();
    sim.tick({ commands: [cmd("bounce", 2)] });
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1, 3]]);
    expect(sim.prs["2"]!.labels).not.toContain("ready");
  });
});

describe("pause", () => {
  test("paused: nothing is built, landed or admitted", () => {
    const sim = new Sim().add(...ids(1));
    sim.paused = true;
    sim.tick();
    expect(sim.state.auth).toEqual({});
    expect(sim.builds).toEqual([]);
  });

  test("decide refuses to run over an unreconciled journal", () => {
    const sim = new Sim().add(...ids(1));
    const d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.state.journal).not.toBeNull();
    expect(() => decide(d.state, sim.snapshot(), sim.config)).toThrow("reconcile");
  });
});

describe("verification after landing (DESIGN.md §7.3)", () => {
  test("a PR whose head moved after its pin landed is told, unreadied and left open", () => {
    const sim = new Sim().add(...ids(1));
    sim.tick(); // build
    sim.tick(); // land
    expect(sim.landed).toEqual([[1]]);
    sim.prs["1"] = { ...sim.prs["1"]!, merged: false, open: true, head: sha("pr1-later") };
    sim.tick();
    const c = sim.comments.find((x) => x.body.startsWith("Landed revision"))!;
    expect(c.body).toContain(sha("pr1"));
    expect(sim.prs["1"]!.open).toBe(true);
    expect(sim.state.verify).toEqual([]);
  });

  test("not marked merged after verifyTicks: one comment, never closed", () => {
    const sim = new Sim().add(...ids(1));
    sim.tick();
    sim.tick();
    sim.prs["1"] = { ...sim.prs["1"]!, merged: false, open: true };
    for (let i = 0; i < 5; i++) sim.tick();
    expect(sim.comments.filter((c) => c.body.includes("has not marked this PR merged"))).toHaveLength(1);
    expect(sim.prs["1"]!.open).toBe(true);
  });
});

describe("verify pacing with chained ticks (DESIGN.md §11.1)", () => {
  test("ticks a minute apart: no 'not marked merged' comment until verifyTicks AND VERIFY_MIN_MINUTES have passed", () => {
    const sim = new Sim().add(...ids(1));
    sim.tick(); // build
    sim.tick(); // land
    const since = Date.parse(sim.state.verify[0]!.since);
    sim.prs["1"] = { ...sim.prs["1"]!, merged: false, open: true };
    const unmarked = () => sim.comments.filter((c) => c.body.includes("has not marked this PR merged"));
    // Sim.tick adds 10 minutes after each tick; pull the clock back to one minute per tick.
    for (let i = 1; i <= 10; i++) {
      sim.now = new Date(since + i * 60_000);
      sim.tick();
    }
    expect(sim.state.verify[0]!.ticks).toBeGreaterThanOrEqual(defaultConfig.verifyTicks);
    expect(unmarked()).toHaveLength(0);
    sim.now = new Date(since + VERIFY_MIN_MINUTES * 60_000);
    sim.tick();
    expect(unmarked()).toHaveLength(1);
    expect(sim.prs["1"]!.open).toBe(true);
  });
});

describe("review #4: no readmission in the tick that removed a PR", () => {
  test("an operator bounce does not rebuild the bounced PR from the stale snapshot", () => {
    const sim = new Sim().add(...ids(1));
    sim.tick(); // build [1]
    sim.tick({ commands: [cmd("bounce", 1)] });
    expect(sim.builds).toHaveLength(1);
    expect(sim.state.auth["1"]).toBeUndefined();
  });

  test("a PR whose head moved after its pin landed is not readmitted in the same tick", () => {
    const sim = new Sim().add(...ids(1));
    sim.tick(); // build
    sim.tick(); // land
    sim.prs["1"] = { ...livePr(1), head: sha("pr1-later") };
    sim.tick();
    expect(sim.state.auth["1"]).toBeUndefined();
    expect(sim.builds).toHaveLength(1);
  });
});

describe("review #5: solo isolates a PR already in the active batch", () => {
  test("solo on a member of a green multi-PR batch abandons it and rebuilds through the solo filter", () => {
    const sim = new Sim().add(...ids(1, 2));
    sim.tick(); // build [1,2]
    sim.tick({ commands: [cmd("solo", 1)] });
    sim.runUntilIdle();
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2], [1], [2]]);
    expect(sim.landed).toEqual([[1], [2]]);
    expect(sim.builds[1]!.prs).toEqual([1]);
  });
});

describe("review #8: batch size", () => {
  test("a red batch halves the next batch, and a landing restores it", () => {
    const sim = new Sim(cfg({ maxBatch: 8, minBatch: 2 }), (b) => (b.prs.includes(1) ? red() : green)).add(...ids(1));
    sim.runUntilIdle(); // #1 bounced: redStreak 1
    expect(sim.bounced).toEqual([1]);
    sim.add(...ids(2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14));
    sim.runUntilIdle();
    const after = sim.builds.slice(1).map((b) => b.prs);
    expect(after).toEqual([[2, 3, 4, 5], [6, 7, 8, 9, 10, 11, 12, 13], [14]]);
  });
});
