// queue.strategy (DESIGN.md §5.7): opt-in ways to isolate a red batch with
// less CI. Each key is off when absent, and then nothing changes: the same
// splits, the same runs, the same state, and the same policy hash.

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { parseConfig } from "../src/config/load";
import { policyHash } from "../src/queue";
import { BASE_CONFIG, cfg, cmd, green, livePr, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, red, sha, Sim } from "./sim";
import { actives, parkedBatch } from "../src/ctx";
import { parseState, type State } from "../src/state";
import { bench, meanOverCulprit, traceAbandons, traceAll } from "./strategy-bench";
import { World } from "./world";
import type { CiClass } from "../src/classify";
import { decide } from "../src/machine";
import { GitHubError } from "../src/github/http";

const FIRST_ALONE: Partial<Config> = { strategy: { firstAlone: true } };

/**
 * One culprit in a fresh batch of n, by its position, with the strategy off:
 * CI runs and ticks to idle, measured on the code before queue.strategy existed.
 */
const OFF = {
  4: { runs: 8, ticks: 10.25, firstLanded: 3.5 },
  6: { runs: 10, ticks: 77 / 6, firstLanded: 4 },
  8: { runs: 11, ticks: 14.125, firstLanded: 4.5 },
} as const;

describe("config", () => {
  const withBlock = (block: string) => OPT_IN_FREE_YAML.replace(/^( {2}controlLabels:)/m, `  strategy:\n${block}\n$1`);
  const problems = (text: string) => {
    try {
      parseConfig(text);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("absent, or every key false: no strategy key at all", () => {
    expect("strategy" in parseConfig(OPT_IN_FREE_YAML).config).toBe(false);
    expect("strategy" in parseConfig(withBlock("    firstAlone: false")).config).toBe(false);
  });

  test("present: only the keys that are on", () => {
    expect(parseConfig(withBlock("    firstAlone: true")).config.strategy).toEqual({ firstAlone: true });
  });

  test("not policy: the hash is the same with it, without it, and at any value", () => {
    expect(policyHash(parseConfig(withBlock("    firstAlone: true")).config)).toBe(OPT_IN_FREE_HASH);
    expect(policyHash({ ...BASE_CONFIG, strategy: { firstAlone: true } })).toBe(policyHash(BASE_CONFIG));
  });

  test("refused: an unknown key, a non-boolean", () => {
    expect(problems(withBlock("    extra: true"))).not.toBe("");
    expect(problems(withBlock("    firstAlone: 1"))).not.toBe("");
  });
});

/**
 * traceAll() with the strategy off, on the code before queue.strategy existed:
 * every build, rerun and landing, and the final state document, of 37
 * isolations. It moves if test/sim.ts changes what it records.
 */
const OFF_TRACE = "1df2436e1ca502f8";

describe("off: nothing changes", () => {
  test("the same builds, reruns, landings and state, byte for byte, as the code before the option", () => {
    expect(traceAll()).toBe(OFF_TRACE);
  });

  test("a red batch splits into halves, with the runs and ticks of the code before the option", () => {
    for (const [n, want] of Object.entries(OFF)) {
      expect(meanOverCulprit(Number(n), {}, "runs")).toBe(want.runs);
      expect(meanOverCulprit(Number(n), {}, "ticks")).toBeCloseTo(want.ticks, 6);
      expect(meanOverCulprit(Number(n), {}, "firstLanded")).toBeCloseTo(want.firstLanded, 6);
    }
  });
});

describe("firstAlone: a red fresh batch retests its first PR alone, then the rest", () => {
  test("a red that comes from a later PR lands the first PR on the next run, without a bisect", () => {
    const off = bench(8, [8]);
    const on = bench(8, [8], FIRST_ALONE);
    for (const r of [off, on]) {
      expect(r.bounced).toEqual([8]);
      expect(r.landed.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    }
    // Ticks: build and rerun the batch, then build [1] alone and land it.
    expect(on.firstLanded).toBe(4);
    expect(off.firstLanded).toBe(4); // with the culprit in the other half, the halves land #1 as early
    // Culprit second: the halves need [1,2] split before #1 lands.
    expect(bench(8, [2], FIRST_ALONE).firstLanded).toBe(4);
    expect(bench(8, [2]).firstLanded).toBe(8);
  });

  test("a culprit at the head is bounced on its own run, and the rest lands in one more", () => {
    const on = bench(8, [1], FIRST_ALONE);
    expect(on.bounced).toEqual([1]);
    expect(on.runs).toBe(5); // the batch and its rerun, #1 and its rerun, [2..8]
    expect(bench(8, [1]).runs).toBe(11);
  });

  test("the measured trade: the oldest PR lands sooner; CI per incident is lower only when the head PR is the culprit", () => {
    for (const n of [4, 6, 8] as const) {
      expect(meanOverCulprit(n, FIRST_ALONE, "firstLanded")).toBeLessThan(OFF[n].firstLanded);
      expect(meanOverCulprit(n, FIRST_ALONE, "runs")).toBeGreaterThan(OFF[n].runs);
    }
  });

  test("only a fresh batch: the rest, if red, splits into halves as before", () => {
    const s = bench(8, [8], FIRST_ALONE);
    expect(s.runs).toBe(13);
  });

  test("end to end through the runner, with CI that takes time: same safety, first PR first", async () => {
    const w = new World((b) => (b.prs.includes(6) ? "fail" : "pass"), FIRST_ALONE);
    w.ciTicks = 2;
    for (const n of [1, 2, 3, 4, 5, 6]) w.readyPr(n);
    await w.runUntilIdle(200);
    expect(w.paused()).toBe(false);
    expect(w.bounced()).toEqual([6]);
    expect(w.landed()[0]).toEqual([1]);
    expect(w.landed().flat().sort()).toEqual([1, 2, 3, 4, 5]);
    for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
    expect(w.state().history.find((h) => h.outcome === "split")?.prs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("with queue.concurrency too: the first PR and the rest run side by side, and the first lands first", async () => {
    const w = new World((b) => (b.prs.includes(6) ? "fail" : "pass"), { ...FIRST_ALONE, concurrency: { maxActive: 2, pipelineDepth: 1 } });
    w.ciTicks = 2;
    let both = false;
    const cas = w.stateRef.cas.bind(w.stateRef);
    w.stateRef.cas = async (before, text) => {
      const prs = actives(JSON.parse(text) as State).map((a) => a.prs);
      if (prs.some((x) => x.length === 1 && x[0] === 1) && prs.some((x) => x.length === 5)) both = true;
      return cas(before, text);
    };
    for (const n of [1, 2, 3, 4, 5, 6]) w.readyPr(n);
    await w.runUntilIdle(200);
    expect(w.paused()).toBe(false);
    expect(w.bounced()).toEqual([6]);
    expect(w.landed()[0]).toEqual([1]);
    expect(w.landed().flat().sort()).toEqual([1, 2, 3, 4, 5]);
    for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
    expect(both).toBe(true); // [1] and [2..6] were running at the same time
  });
});

const SKIP: Partial<Config> = { strategy: { skipSeenRed: true } };
const BOTH: Partial<Config> = { strategy: { firstAlone: true, skipSeenRed: true } };

describe("skipSeenRed: a tree already seen red on this main is never built again", () => {
  test("config: present only when on, and not policy", () => {
    const y = OPT_IN_FREE_YAML.replace(/^( {2}controlLabels:)/m, "  strategy:\n    skipSeenRed: true\n$1");
    expect(parseConfig(y).config.strategy).toEqual({ skipSeenRed: true });
    expect(policyHash(parseConfig(y).config)).toBe(OPT_IN_FREE_HASH);
  });

  test("a landed prefix makes the rest on the new main the red batch's tree: split without a run, at every level", () => {
    const s = new Sim(cfg(SKIP), (b) => (b.prs.includes(7) ? red() : green));
    for (let i = 1; i <= 8; i++) s.add(livePr(i));
    s.runUntilIdle(100);
    expect(s.bounced).toEqual([7]);
    expect(s.landed).toEqual([[1, 2, 3, 4], [5, 6], [8]]);
    // Neither [5..8] on main+[1..4] nor [7,8] on main+[1..6] was built: each is batch 1's tree.
    expect(s.builds.map((b) => b.prs)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8], [1, 2, 3, 4], [5, 6], [7], [8]]);
    const inferred = s.state.history.filter((h) => h.note.startsWith("already seen red"));
    expect(inferred).toMatchObject([
      { outcome: "split", prs: [5, 6, 7, 8], head: null, n: 1 },
      { outcome: "solo", prs: [7, 8], head: null, n: 1 },
    ]);
    expect(s.state.seenRed).toBeUndefined(); // nothing left that can match
  });

  test("a single PR is always built: its bounce cites a run of its own", () => {
    const s = new Sim(cfg(SKIP), (b) => (b.prs.includes(2) ? red() : green));
    s.add(livePr(1), livePr(2));
    s.runUntilIdle();
    expect(s.landed).toEqual([[1]]);
    expect(s.bounced).toEqual([2]);
    expect(s.builds.map((b) => b.prs)).toEqual([[1, 2], [1], [2]]);
  });

  test("a recorded composition on the current main is split at selection, without a build", () => {
    const s = new Sim(cfg(SKIP), () => green);
    s.add(livePr(1), livePr(2), livePr(3));
    s.tick(); // admitted, built as [1,2,3]
    expect(s.builds).toHaveLength(1);
    // Put it back as recovery work, recorded red on this very main.
    const a = s.state.active!;
    s.state = { ...s.state, active: null, pending: [{ prs: [1, 2, 3], depth: 1, lineage: a.lineage }], seenRed: [{ n: a.n, base: s.main, pins: [1, 2, 3].map((pr) => ({ pr, head: s.state.auth[String(pr)]!.head })) }] };
    s.tick();
    expect(s.builds.map((b) => b.prs)).toEqual([[1, 2, 3], [1]]);
    expect(s.state.pending).toEqual([{ prs: [2, 3], depth: 2, lineage: a.lineage }]);
  });

  test("stale entries go: main moved by anything but a landing of their prefix, or a PR's head moved", () => {
    const s = new Sim(cfg(SKIP), () => green);
    s.add(livePr(1), livePr(2), livePr(3));
    const pins = [1, 2].map((pr) => ({ pr, head: sha(`pr${pr}`) }));
    s.state = { ...s.state, seenRed: [{ n: 1, base: s.main, pins }] };
    s.tick({ main: sha("elsewhere") });
    expect(s.state.seenRed).toBeUndefined();
  });

  test("off: a leftover field is removed, and nothing reads it", () => {
    const s = new Sim(cfg(), () => green);
    s.add(livePr(1), livePr(2));
    s.state = { ...s.state, seenRed: [{ n: 1, base: s.main, pins: [1, 2].map((pr) => ({ pr, head: sha(`pr${pr}`) })) }] };
    s.runUntilIdle();
    expect(s.landed).toEqual([[1, 2]]);
    expect(s.state.seenRed).toBeUndefined();
  });

  test("measured: fewer CI runs and ticks per isolation, the same PRs landed and bounced", () => {
    const SKIP_RUNS = { 4: 7, 6: 23 / 3, 8: 9 } as const;
    const BOTH_RUNS = { 4: 6.25, 6: 47 / 6, 8: 8.875 } as const;
    for (const n of [4, 6, 8] as const) {
      expect(meanOverCulprit(n, SKIP, "runs")).toBeCloseTo(SKIP_RUNS[n], 6);
      expect(meanOverCulprit(n, BOTH, "runs")).toBeCloseTo(BOTH_RUNS[n], 6);
      expect(meanOverCulprit(n, SKIP, "ticks")).toBeLessThan(OFF[n].ticks);
      for (let c = 1; c <= n; c++) {
        const off = bench(n, [c]);
        for (const on of [bench(n, [c], SKIP), bench(n, [c], BOTH)]) {
          expect(on.bounced).toEqual(off.bounced);
          expect(on.landed.sort()).toEqual(off.landed.sort());
          expect(on.runs).toBeLessThanOrEqual(off.runs);
        }
      }
    }
    // Two culprits in one batch of 8.
    expect(bench(8, [3, 7]).runs).toBe(18);
    expect(bench(8, [3, 7], SKIP).runs).toBe(14);
  });

  test("end to end through the runner: one batch at a time, 7 CI runs instead of 11; with queue.concurrency (halves already overlap) no more than before", async () => {
    for (const conc of [{}, { concurrency: { maxActive: 2, pipelineDepth: 1 } }]) {
      const runs: number[] = [];
      const ticks: number[] = [];
      for (const over of [{}, SKIP]) {
        const w = new World((b) => (b.prs.includes(7) ? "fail" : "pass"), { ...conc, ...over });
        w.ciTicks = 2;
        for (let i = 1; i <= 8; i++) w.readyPr(i);
        ticks.push(await w.runUntilIdle(300));
        expect(w.paused()).toBe(false);
        expect(w.bounced()).toEqual([7]);
        expect(w.landed().flat().sort()).toEqual([1, 2, 3, 4, 5, 6, 8]);
        for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
        runs.push(w.verdicts.length);
      }
      if ("concurrency" in conc) {
        expect(runs[1]).toBeLessThanOrEqual(runs[0]!);
      } else {
        expect(runs).toEqual([11, 7]);
        expect(ticks[1]).toBeLessThan(ticks[0]!);
      }
    }
  });
});

const REUSE: Partial<Config> = { strategy: { reuseGreen: true } };

describe("reuseGreen: after a pause, a parked batch whose run went green lands without a rebuild", () => {
  test("config: present only when on, and not policy", () => {
    const y = OPT_IN_FREE_YAML.replace(/^( {2}controlLabels:)/m, "  strategy:\n    reuseGreen: true\n$1");
    expect(parseConfig(y).config.strategy).toEqual({ reuseGreen: true });
    expect(policyHash(parseConfig(y).config)).toBe(OPT_IN_FREE_HASH);
  });

  /** A batch inconclusive twice (the queue pauses), then its run is rerun by hand and passes while paused, then the queue resumes. */
  function pausedThenGreen(over: Partial<Config>, moveMain = false) {
    let fixed = false;
    const infra: CiClass = { kind: "infra", runs: [{ runId: 9, attempt: 1 }], reason: "cancelled" };
    const s = new Sim(cfg(over), (b) => (b.n === 1 && !fixed ? infra : green)).add(livePr(1), livePr(2), livePr(3));
    for (let i = 0; i < 6 && !s.paused; i++) s.tick();
    expect(s.pauses[0]).toContain("still inconclusive after a rerun");
    const runsAtPause = s.builds.length + s.reruns;
    fixed = true; // someone reran the batch's run by hand, and it passed
    s.tick(); // paused: nothing happens
    if (moveMain) s.main = sha("moved");
    s.paused = false;
    s.runUntilIdle();
    return { s, extraRuns: s.builds.length + s.reruns - runsAtPause };
  }

  test("on: the parked batch lands on its own run; off: it is rebuilt", () => {
    const on = pausedThenGreen(REUSE);
    const off = pausedThenGreen({});
    for (const r of [on, off]) expect(r.s.landed.flat()).toEqual([1, 2, 3]);
    expect(on.extraRuns).toBe(0);
    expect(off.extraRuns).toBe(1);
    expect(on.s.lands[0]!.before).toBe(sha("main0"));
    expect(on.s.state.parked).toBeUndefined();
    expect(on.s.state.history.filter((h) => h.outcome === "landed").map((h) => h.n)).toEqual([1]);
  });

  test("a parked batch keeps the runs seen for it, adds those seen while parked, and has them back when it lands", () => {
    const infra: CiClass = { kind: "infra", runs: [{ runId: 9, attempt: 1 }], reason: "cancelled" };
    const s = new Sim(cfg(REUSE), () => infra).add(livePr(1), livePr(2));
    const PATH = s.config.preLanding[0]!.path;
    for (let i = 0; i < 6 && !s.paused; i++) {
      if (s.state.active) s.state.active.seen = [{ runId: 9, path: PATH }];
      s.tick();
    }
    expect(s.state.parked?.seen).toEqual([{ runId: 9, path: PATH }]);
    expect(parkedBatch(s.state.parked!).seen).toEqual([{ runId: 9, path: PATH }]);
    const d = decide(s.state, s.snapshot({ ciSeen: { [String(s.state.parked!.n)]: [{ runId: 9, path: PATH }, { runId: 12, path: PATH }] } }), s.config);
    expect(d.state.parked?.seen).toEqual([{ runId: 9, path: PATH }, { runId: 12, path: PATH }]);
    expect(parseState(JSON.stringify(d.state), s.config.names).parked?.seen).toEqual([{ runId: 9, path: PATH }, { runId: 12, path: PATH }]);
  });

  test("its runs are left to finish while it is parked, and cancelled once it is unparked", () => {
    let fixed = false;
    const infra: CiClass = { kind: "infra", runs: [{ runId: 9, attempt: 1 }], reason: "cancelled" };
    const s = new Sim(cfg(REUSE), (b) => (b.n === 1 && !fixed ? infra : green)).add(livePr(1), livePr(2));
    const cancels: string[] = [];
    for (let i = 0; i < 6 && !s.paused; i++) {
      s.tick();
      cancels.push(...s.state.outbox.filter((n) => n.kind === "cancelRuns").map((n) => n.id));
    }
    expect(s.state.parked?.n).toBe(1);
    expect(cancels).toEqual([]);
    // Main moves while paused: the parked batch can no longer land as tested.
    s.main = sha("moved");
    s.paused = false;
    const d = decide(s.state, s.snapshot(), s.config);
    expect(d.state.parked).toBeUndefined();
    expect(d.state.outbox.some((n) => n.kind === "cancelRuns" && n.id === "x:1")).toBe(true);
  });

  test("not reused: main moved, the run is not green, or the PRs changed; then it is built as before", () => {
    const moved = pausedThenGreen(REUSE, true);
    expect(moved.extraRuns).toBe(1);
    expect(moved.s.landed.flat()).toEqual([1, 2, 3]);
    // Still red when the queue resumes: rebuilt (and the state carries no parked batch after).
    let n1 = 0;
    const s = new Sim(cfg(REUSE), (b) => (b.n === 1 ? (n1++, { kind: "infra", runs: [{ runId: 9, attempt: 1 }], reason: "cancelled" }) : green)).add(livePr(1), livePr(2));
    for (let i = 0; i < 6 && !s.paused; i++) s.tick();
    s.paused = false;
    s.runUntilIdle();
    expect(s.landed.flat()).toEqual([1, 2]);
    expect(s.builds).toHaveLength(2); // the batch, and its rebuild after the pause
    expect(s.state.parked).toBeUndefined();
  });

  test("reuse needs no run, so no budget: an exhausted lineage or window still lands it", () => {
    for (const over of [{ lineageBudget: 2 }, { windowBudget: 2 }]) {
      const r = pausedThenGreen({ ...REUSE, ...over });
      expect(r.s.landed.flat()).toEqual([1, 2, 3]);
      expect(r.extraRuns).toBe(0);
      expect(r.s.pauses).toHaveLength(1);
    }
  });

  test("a parked batch whose PRs leave the queue is unparked, and its runs are cancelled", () => {
    const infra: CiClass = { kind: "infra", runs: [{ runId: 9, attempt: 1 }], reason: "cancelled" };
    const s = new Sim(cfg(REUSE), (b) => (b.n === 1 ? infra : green)).add(livePr(1), livePr(2));
    for (let i = 0; i < 6 && !s.paused; i++) s.tick();
    expect(s.state.parked?.n).toBe(1);
    s.paused = false;
    const d = decide(s.state, s.snapshot({ commands: [cmd("bounce", 1), cmd("bounce", 2)] }), s.config);
    expect(d.state.parked).toBeUndefined();
    expect(d.state.outbox.some((n) => n.kind === "cancelRuns" && n.id === "x:1")).toBe(true);
  });

  test("with another batch running (queue.concurrency), a parked batch is not landed ahead of it", () => {
    const s = new Sim(cfg({ ...REUSE, concurrency: { maxActive: 2, pipelineDepth: 0 } }), () => green).add(livePr(1), livePr(2), livePr(3));
    s.tick(); // [1,2,3] building
    const a = s.state.active!;
    // Pretend [3] was parked on this main, alone, and is next in pending while [1,2] runs.
    s.state = {
      ...s.state,
      active: { ...a, prs: [1, 2] },
      pending: [{ prs: [3], depth: 1, lineage: a.lineage }],
      parked: { n: 99, base: s.main, head: sha("q99"), pins: [{ pr: 3, head: sha("pr3") }], depth: 1, lineage: a.lineage, builtAt: "2026-10-21T11:00:00.000Z" },
    };
    const d = decide(s.state, s.snapshot({ ci: { kind: "pending", reason: "running" }, parkedCi: green }), s.config);
    expect(d.state.journal?.op.kind).not.toBe("land");
  });

  test("off: batches abandoned as the queue pauses go exactly as before (traces measured on the code before the option)", () => {
    expect(traceAbandons()).toBe("fd671e70efe75752,4d6481fd528c477d,b7c49fd235e0eec5");
  });

  test("off: a leftover field is removed, and nothing reads it", () => {
    const s = new Sim(cfg(), () => green).add(livePr(1), livePr(2));
    s.state = { ...s.state, parked: { n: 9, base: s.main, head: sha("q9"), pins: [1, 2].map((pr) => ({ pr, head: sha(`pr${pr}`) })), depth: 0, lineage: 1, builtAt: "2026-10-21T11:00:00.000Z" }, lineages: { "1": { runs: 1 } } };
    s.runUntilIdle();
    expect(s.builds).toHaveLength(1);
    expect(s.state.parked).toBeUndefined();
  });

  test("end to end through the runner: the run rerun by hand during the pause lands the batch, with no new queue run", async () => {
    for (const over of [REUSE, {}]) {
      let first: number | undefined;
      const w = new World((b) => {
        first ??= b.n;
        return b.n === first && b.attempt <= 2 ? "cancel" : "pass";
      }, over);
      for (const n of [1, 2, 3]) w.readyPr(n);
      for (let i = 0; i < 20 && !w.paused(); i++) await w.tick();
      expect(w.paused()).toBe(true);
      const ref = `${w.config.names.queuePrefix}${first}`;
      const run = w.target.runs.filter((r) => r.head_branch === ref).at(-1)!;
      await w.target.rerunFailedJobs(run.id); // by hand, while paused: passes
      await w.tick();
      await w.tick();
      for (const i of w.repo.issues) if (i.labels.includes(w.config.names.controlLabels.pause)) i.open = false;
      const before = w.verdicts.length;
      await w.runUntilIdle(60);
      expect(w.landed()).toEqual([[1, 2, 3]]);
      for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
      // on: no new run at all; off: a rebuild and its run.
      expect(w.verdicts.length - before).toBe(over === REUSE ? 0 : 1);
      if (over === REUSE) expect(w.mainHistory.at(-1)).toBe(run.head_sha);
    }
  });

  test("end to end: an unreadable parked run means no reuse this tick, never a failed tick", async () => {
    let first: number | undefined;
    const w = new World((b) => {
      first ??= b.n;
      return b.n === first && b.attempt <= 2 ? "cancel" : "pass";
    }, REUSE);
    for (const n of [1, 2, 3]) w.readyPr(n);
    for (let i = 0; i < 20 && !w.paused(); i++) await w.tick();
    const ref = `${w.config.names.queuePrefix}${first}`;
    const list = w.target.listRuns.bind(w.target);
    w.target.listRuns = async (q) => {
      if (q.branch === ref) throw new GitHubError("not_found", 404, "gone");
      return list(q);
    };
    for (const i of w.repo.issues) if (i.labels.includes(w.config.names.controlLabels.pause)) i.open = false;
    await w.runUntilIdle(60);
    expect(w.pauseReasons()).toHaveLength(1);
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2, 3]]); // rebuilt and landed
  });
});

describe("skipSeenRed turned off mid-landing", () => {
  test("a landing applied with the key off removes the field rather than carrying it", () => {
    const s = new Sim(cfg(SKIP), (b) => (b.prs.includes(4) ? red() : green));
    for (let i = 1; i <= 4; i++) s.add(livePr(i));
    // Run until the first half's landing is journalled, then turn the key off before it is applied.
    for (let i = 0; i < 20 && s.state.journal?.op.kind !== "land"; i++) {
      const d = decide(s.state, s.snapshot(), s.config);
      s.state = d.state;
      if (s.state.journal?.op.kind === "land") break;
      s.perform();
      s.drain();
    }
    expect(s.state.journal?.op.kind).toBe("land");
    expect(s.state.seenRed).toHaveLength(1);
    s.config = cfg();
    s.perform();
    expect(s.landed).toEqual([[1, 2]]);
    expect(s.state.seenRed).toBeUndefined();
  });
});

const ADAPTIVE: Partial<Config> = { strategy: { adaptive: { greens: 2, ceiling: 16 } } };

describe("adaptive: the fresh batch size doubles after full greens in a row, and halves on red", () => {
  const withBlock = (block: string) => OPT_IN_FREE_YAML.replace(/^( {2}controlLabels:)/m, `  strategy:\n${block}\n$1`);

  test("config: both numbers required, the ceiling at least queue.batch.max, and not policy", () => {
    const max = parseConfig(OPT_IN_FREE_YAML).config.maxBatch;
    const on = parseConfig(withBlock(`    adaptive:\n      greens: 2\n      ceiling: ${max * 2}`)).config;
    expect(on.strategy).toEqual({ adaptive: { greens: 2, ceiling: max * 2 } });
    expect(policyHash(on)).toBe(OPT_IN_FREE_HASH);
    expect(() => parseConfig(withBlock(`    adaptive:\n      greens: 2\n      ceiling: ${max - 1}`))).toThrow("ceiling must be at least queue.batch.max");
    expect(() => parseConfig(withBlock("    adaptive:\n      greens: 2"))).toThrow();
    expect(() => parseConfig(withBlock(`    adaptive:\n      greens: 0\n      ceiling: ${max}`))).toThrow();
  });

  test("a mostly green queue: batches grow to the ceiling, with fewer CI runs and ticks per landed PR", () => {
    const max = BASE_CONFIG.maxBatch;
    const off = bench(128, []);
    const on = bench(128, [], ADAPTIVE);
    expect(on.landed.sort((a, b) => a - b)).toEqual(off.landed.sort((a, b) => a - b));
    expect(off.runs).toBe(128 / max);
    expect(on.runs).toBe(9);
    expect(on.ticks / on.landed.length).toBeLessThan(off.ticks / off.landed.length);
    // One culprit in every hundred: the red halves the limit, and it grows back.
    const offRed = bench(200, [50, 150]);
    const onRed = bench(200, [50, 150], ADAPTIVE);
    expect(onRed.bounced).toEqual(offRed.bounced);
    expect(onRed.landed.sort((a, b) => a - b)).toEqual(offRed.landed.sort((a, b) => a - b));
    expect([offRed.runs, onRed.runs]).toEqual([45, 40]);
    expect([offRed.ticks, onRed.ticks]).toEqual([74, 64]);
  });

  test("the limit: doubles after `greens` full batches, capped at the ceiling; a red fresh batch halves it", () => {
    const s = new Sim(cfg(ADAPTIVE), (b) => (b.prs.includes(41) ? red() : green));
    for (let i = 1; i <= 60; i++) s.add(livePr(i));
    s.runUntilIdle(200);
    expect(BASE_CONFIG.maxBatch).toBe(8); // the sizes below assume it
    // 8, 8 (two full greens: double) 16, 16 red with #41 (halve to 8): its isolation (8 8 4 1 1 1 1 4), then 8, and the last 4 PRs.
    expect(s.builds.map((b) => b.prs.length)).toEqual([8, 8, 16, 16, 8, 8, 4, 1, 1, 1, 1, 4, 8, 4]);
    expect(s.bounced).toEqual([41]);
    expect(s.state.adaptive).toEqual({ size: 8, greens: 1 });
  });

  test("a trickle never fills a batch: decisions are the same as off, and with no red nothing is written", () => {
    const off = bench(2, [15], {}, { more: 40, every: 1 });
    const on = bench(2, [15], ADAPTIVE, { more: 40, every: 1 });
    expect(on).toEqual(off);
    const s = new Sim(cfg(ADAPTIVE), () => green);
    for (let i = 1; i <= 2; i++) s.add(livePr(i));
    for (let t = 0; t < 30; t++) {
      if (t % 2 === 0) s.add(livePr(3 + t));
      s.tick();
    }
    expect(s.landed.flat().length).toBeGreaterThan(10);
    expect(s.state.adaptive).toBeUndefined();
  });

  test("recovery never grows the limit, even solo PRs at depth 0 (maxSplitDepth 0)", () => {
    const over = { maxBatch: 2, minBatch: 1, maxSplitDepth: 0, minFill: 1, strategy: { adaptive: { greens: 1, ceiling: 8 } } };
    const s = new Sim(cfg(over), (b) => (b.prs.includes(2) ? red() : green)).add(livePr(1), livePr(2));
    s.runUntilIdle();
    expect(s.landed).toEqual([[1]]);
    expect(s.bounced).toEqual([2]);
    expect(s.state.adaptive).toEqual({ size: 1, greens: 0 });
  });

  test("off: a leftover field is removed, and the size is queue.batch.max halved per red in a row", () => {
    const s = new Sim(cfg(), () => green);
    for (let i = 1; i <= 3; i++) s.add(livePr(i));
    s.state = { ...s.state, adaptive: { size: 1, greens: 0 } };
    s.runUntilIdle();
    expect(s.builds.map((b) => b.prs)).toEqual([[1, 2, 3]]);
    expect(s.state.adaptive).toBeUndefined();
  });

  test("end to end through the runner, CI taking time, 48 green PRs: fewer CI runs", async () => {
    const runs: number[] = [];
    for (const over of [{}, ADAPTIVE]) {
      const w = new World(() => "pass", over);
      w.ciTicks = 2;
      for (let i = 1; i <= 48; i++) w.readyPr(i);
      await w.runUntilIdle(300);
      expect(w.paused()).toBe(false);
      expect(w.landed().flat().sort((a, b) => a - b)).toEqual(Array.from({ length: 48 }, (_, i) => i + 1));
      for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
      runs.push(w.verdicts.length);
    }
    expect(runs[1]).toBeLessThan(runs[0]!);
  });
});
