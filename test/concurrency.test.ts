// Several batches at once (queue.concurrency, DESIGN.md §5.6): a failed
// batch's split halves and solo retests run side by side, and a fresh batch
// may be built on top of the running one (pipelining). End to end, through
// the real runner against the fake world, with CI that takes time.

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { type CrashPoint, policyHash } from "../src/queue";
import { actives } from "../src/ctx";
import { emptyState, parseState, type State } from "../src/state";
import { DEFAULT_MAX_ACTIVE, DEFAULT_PIPELINE_DEPTH, parseConfig } from "../src/config/load";
import { wakeFor } from "../src/wake";
import { decide } from "../src/machine";
import { BASE_CONFIG, cfg, green, livePr, NAMES, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, sha } from "./sim";
import { World, type BatchCi, type CiOutcome } from "./world";

const ON: Partial<Config> = { concurrency: { maxActive: 2, pipelineDepth: 1 } };

/** Every landing moved main to a commit whose CI passed. */
function safe(w: World): void {
  for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
}

/** A world whose CI takes `ciTicks` ticks, recording how many batches ran at once. */
function world(oracle: (b: BatchCi) => CiOutcome, over: Partial<Config>, ciTicks = 2) {
  const w = new World(oracle, over);
  w.ciTicks = ciTicks;
  let most = 0;
  const texts: string[] = [];
  const cas = w.stateRef.cas.bind(w.stateRef);
  w.stateRef.cas = async (before, text) => {
    texts.push(text);
    most = Math.max(most, actives(JSON.parse(text) as State).length);
    return cas(before, text);
  };
  return { w, most: () => most, texts };
}

const culprit = (bad: number[]) => (b: BatchCi): CiOutcome => (b.prs.some((p) => bad.includes(p)) ? "fail" : "pass");

/** Tick until idle; the tick count. */
async function settle(w: World): Promise<number> {
  return w.runUntilIdle(200);
}

describe("split halves run side by side", () => {
  test("one bad PR in a batch of 6 is isolated in fewer ticks than one batch at a time, and never more than maxActive run", async () => {
    const serial = world(culprit([5]), {});
    const both = world(culprit([5]), ON);
    for (const x of [serial, both]) for (const n of [1, 2, 3, 4, 5, 6]) x.w.readyPr(n);
    const tSerial = await settle(serial.w);
    const tBoth = await settle(both.w);
    for (const x of [serial, both]) {
      expect(x.w.paused()).toBe(false);
      expect(x.w.bounced()).toEqual([5]);
      expect(x.w.landed().flat().sort()).toEqual([1, 2, 3, 4, 6]);
      safe(x.w);
    }
    expect(serial.most()).toBe(1);
    expect(both.most()).toBe(2);
    expect(tBoth).toBeLessThan(tSerial);
    // The halves of the first split were built in the same span of CI, one tick apart.
    const hist = both.w.state().history;
    expect(hist.find((h) => h.outcome === "split")?.prs).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a green later half lands while the earlier half is still being isolated", async () => {
    const { w } = world(culprit([1]), ON);
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await settle(w);
    expect(w.bounced()).toEqual([1]);
    // [3,4] is the later half, but [1,2] failed: it does not wait for [1,2]'s isolation.
    expect(w.landed()).toEqual([[3, 4], [2]]);
    safe(w);
  });

  test("both halves green (the batch was flaky or the halves conflict): the earlier lands, the later is rebuilt on the new main", async () => {
    // The whole batch fails on the first main only; each half, and the batch on a main with [1,2], passes.
    const { w } = world((b) => (b.prs.length === 4 && b.mainHas.length === 0 ? "fail" : "pass"), ON);
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await settle(w);
    expect(w.landed()).toEqual([[1, 2], [3, 4]]);
    const hist = w.state().history;
    expect(hist.some((h) => h.outcome === "rebuilt" && h.prs.join() === "3,4")).toBe(true);
    // The rebuilt batch was tested on the main that has [1,2], and only then landed.
    safe(w);
  });

  test("both halves red: both split, side by side, within the cap", async () => {
    const t = world(culprit([1, 4]), ON);
    for (const n of [1, 2, 3, 4]) t.w.readyPr(n);
    await settle(t.w);
    expect(t.w.bounced().sort()).toEqual([1, 4]);
    expect(t.w.landed().flat().sort()).toEqual([2, 3]);
    expect(t.most()).toBe(2);
    safe(t.w);
  });

  test("PRs admitted during recovery get the free slot once every recovery item has started, and land before the culprit is bounced", async () => {
    const t = world(culprit([1]), ON);
    for (const n of [1, 2, 3, 4]) t.w.readyPr(n);
    await t.w.untilBuilt();
    t.w.readyPr(5);
    t.w.readyPr(6);
    await settle(t.w);
    expect(t.w.bounced()).toEqual([1]);
    expect(t.w.landed().flat().sort()).toEqual([2, 3, 4, 5, 6]);
    const hist = t.w.state().history;
    const at = (pr: number, outcome: string) => Date.parse(hist.find((h) => h.outcome === outcome && h.prs.includes(pr))!.at);
    expect(at(5, "landed")).toBeLessThan(at(1, "bounced"));
    expect(t.most()).toBe(2);
    safe(t.w);
  });

  test("a fresh batch beside recovery never lands ahead of an older half that has not failed, even one being rebuilt", async () => {
    // [1,2,3,4] fails on the first main only; [3,4]'s first run is slow, so [1,2] lands first, a fresh [5]
    // starts beside it, and [3,4] then has to be rebuilt (a newer batch number than [5]'s).
    const t = world((b) => (b.prs.length === 4 && b.mainHas.length === 0 ? "fail" : "pass"), ON);
    t.w.ciTicksFor = (b) => (b.prs.join() === "3,4" ? 5 : 2);
    for (const n of [1, 2, 3, 4]) t.w.readyPr(n);
    await t.w.untilBuilt();
    t.w.readyPr(5);
    await settle(t.w);
    const landed = t.w.landed();
    expect(landed.flat().sort()).toEqual([1, 2, 3, 4, 5]);
    expect(landed.findIndex((b) => b.includes(5))).toBeGreaterThan(landed.findIndex((b) => b.includes(3)));
    safe(t.w);
  });

  test("each concurrent run is charged to the window and to the shared lineage", async () => {
    const { w } = world(culprit([1]), ON);
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await settle(w);
    const s = w.state();
    // Builds: [1-4], [1,2], [3,4], [1], [2]; reruns: [1-4], [1,2], [1].
    expect(s.window.reduce((n, x) => n + x.cost, 0)).toBe(8);
    expect(s.lineages["1"]?.runs).toBe(8);
  });

  test("without queue.concurrency, the state never carries the new keys (the previous version reads every document)", async () => {
    const { w, texts } = world(culprit([5]), {});
    for (const n of [1, 2, 3, 4, 5, 6]) w.readyPr(n);
    await settle(w);
    expect(texts.length).toBeGreaterThan(10);
    for (const t of texts) {
      expect(t).not.toContain('"concurrent"');
      expect(t).not.toContain('"on"');
    }
  });
});

describe("pipelining: a fresh batch built on the running one", () => {
  const PIPE: Partial<Config> = { ...ON, maxBatch: 2 };

  test("green N then green N+1: both land, N+1 tested on N while N ran, with no rebuild", async () => {
    const t = world(() => "pass", PIPE, 3);
    for (const n of [1, 2, 3, 4]) t.w.readyPr(n);
    await settle(t.w);
    expect(t.w.landed()).toEqual([[1, 2], [3, 4]]);
    expect(t.most()).toBe(2);
    const hist = t.w.state().history;
    expect(hist.some((h) => h.outcome === "rebuilt" || h.outcome === "abandoned")).toBe(false);
    // Two landings, each a fast-forward to a tested head: [3,4]'s head sits on [1,2]'s.
    expect(t.w.mainHistory.length).toBe(3);
    safe(t.w);
  });

  test("a red N discards N+1: its run is charged to its own lineage, never to its PRs, which land later", async () => {
    const t = world(culprit([1]), PIPE, 3);
    for (const n of [1, 2, 3, 4]) t.w.readyPr(n);
    await settle(t.w);
    expect(t.w.bounced()).toEqual([1]);
    expect(t.w.landed().flat().sort()).toEqual([2, 3, 4]);
    const hist = t.w.state().history;
    const discarded = hist.filter((h) => h.outcome === "abandoned" && h.note.startsWith("discarded"));
    expect(discarded.length).toBeGreaterThanOrEqual(1);
    expect(discarded[0]!.prs).toEqual([3, 4]);
    // The discard neither unreadies nor tells off its PRs: they keep their FIFO place.
    expect(t.w.comments(3).some((c) => c.startsWith("Removed") || c.startsWith("Bounced"))).toBe(false);
    expect(hist.find((h) => h.outcome === "landed" && h.prs.includes(3))!.n).toBeGreaterThan(discarded[0]!.n);
    safe(t.w);
  });

  test("a PR that conflicts only on top of the running batch keeps its admission and place; nothing younger passes it", async () => {
    const t = world(culprit([1]), { ...ON, minBatch: 1, maxBatch: 1 }, 3);
    const merge = t.w.target.merge.bind(t.w.target);
    const head = (n: number) => t.w.target.prs.get(n)!.pr.head.sha;
    // #2 merges onto main, but not onto anything that contains #1.
    t.w.target.merge = async (base, sha, message) => {
      const cur = t.w.target.refs.get(base);
      const onTopOf1 = cur !== undefined && (t.w.target as unknown as { ancestors(s: string): Set<string> }).ancestors(cur).has(head(1));
      return sha === head(2) && onTopOf1 ? { kind: "conflict" } : merge(base, sha, message);
    };
    for (const n of [1, 2, 3]) t.w.readyPr(n);
    await settle(t.w);
    expect(t.w.bounced()).toEqual([1]);
    expect(t.w.landed().flat()).toEqual([2, 3]); // in order
    expect(t.w.comments(2).some((c) => c.startsWith("Not queued"))).toBe(false);
    const refused = t.w.state().history.filter((h) => h.outcome === "empty" && h.note.includes("refused"));
    expect(refused.length).toBe(1); // tried once, then no more speculation on that batch
    expect(t.w.state().window.length).toBe(4); // [1], its rerun, [2], [3]: the refused build was not charged
    safe(t.w);
  });

  test("speculation waits while recovery is queued or running", async () => {
    const t = world(culprit([1]), PIPE, 3);
    for (const n of [1, 2]) t.w.readyPr(n);
    await t.w.untilBuilt();
    // [1,2] is running; 3 and 4 arrive and are stacked on it.
    t.w.readyPr(3);
    t.w.readyPr(4);
    await settle(t.w);
    expect(t.w.bounced()).toEqual([1]);
    expect(t.w.landed().flat().sort()).toEqual([2, 3, 4]);
    safe(t.w);
  });
});

describe("decisions", () => {
  test("a half whose rerun passed is no longer failing: held on mergeability, it still lands before the younger half", () => {
    const M = sha("main");
    const C = cfg(ON);
    const prs = [1, 2, 3, 4].map((n) => livePr(n, n === 1 ? { mergeable: null } : {}));
    const au = Object.fromEntries(prs.map((p) => [String(p.number), { head: p.head, baseRepoId: p.baseRepoId, policy: "policy-1", policyPr: false, admittedAt: `2026-10-21T11:00:0${p.number}.000Z`, labelledAt: p.ready!.at, evidence: [], reviewRun: null }]));
    const batch = (n: number, b: number[], extra = {}) => ({ n, base: M, head: sha(`q${n}`), depth: 1, prs: b, lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T11:30:00.000Z", ...extra });
    const state: State = {
      ...emptyState(),
      seq: 6,
      nextLineage: 2,
      lineages: { "1": { runs: 4 } },
      auth: au,
      active: batch(5, [1, 2], { rerun: [{ runId: 1, attempt: 1 }], rerunAt: "2026-10-21T11:40:00.000Z", redJobs: [{ name: "Test", url: "u" }] }),
      concurrent: [batch(6, [3, 4])],
    };
    const snap = { now: new Date("2026-10-21T12:00:00Z"), paused: false, main: M, policyHash: "policy-1", prs: Object.fromEntries(prs.map((p) => [String(p.number), p])), ci: green, cis: { "5": green, "6": green }, mainFailedJobs: null, pinReachable: {} };
    const d = decide(state, snap, C);
    expect(d.state.journal).toBeNull();
    expect(d.log.join("\n")).toContain("batch 6 green: waits for batch 5");
  });
});

describe("crash recovery with two batches in flight", () => {
  const POINTS: CrashPoint[] = ["after-intent", "after-build-ref", "after-merges", "after-checkpoint", "after-queue-ref", "after-effect", "after-receipt", "mid-drain"];
  const cases: [string, (b: BatchCi) => CiOutcome, Partial<Config>][] = [
    ["split halves", culprit([1]), ON],
    ["pipelined", culprit([3]), { ...ON, maxBatch: 2 }],
  ];
  for (const [name, oracle, over] of cases) {
    test(`${name}: a crash at every point converges to the crash-free result`, async () => {
      const run = async (crash?: { point: CrashPoint; at: number }) => {
        const { w } = world(oracle, over);
        for (const n of [1, 2, 3, 4]) w.readyPr(n);
        let crashed = false;
        if (crash) {
          let hits = 0;
          const when = (p: CrashPoint) => p === crash.point && ++hits === crash.at;
          for (let i = 0; i < 60 && !crashed; i++) crashed = (await w.tick({ crashWhen: when })) === "crashed";
        }
        await settle(w);
        return { w, crashed };
      };
      const base = await run();
      const landed = base.w.landed().flat().sort();
      const bounced = base.w.bounced();
      let exercised = 0;
      for (const point of POINTS) {
        for (const at of [1, 2, 3, 4, 5]) {
          const { w, crashed } = await run({ point, at });
          if (!crashed) continue;
          exercised++;
          const where = `${name} @ ${point}#${at}`;
          expect(w.paused(), where).toBe(false);
          expect(w.landed().flat().sort(), where).toEqual(landed);
          expect(w.bounced(), where).toEqual(bounced);
          safe(w);
          const s = w.state();
          expect(s.journal, where).toBeNull();
          expect(s.outbox, where).toEqual([]);
          expect([...w.target.refs.keys()].filter((k) => k !== "main"), where).toEqual([]);
        }
      }
      expect(exercised).toBeGreaterThanOrEqual(20);
    });
  }
});

describe("the state document", () => {
  const H = (s: string) => sha(s);
  const batch = (n: number, prs: number[], extra: Record<string, unknown> = {}) => ({ n, base: H(`b${n}`), head: H(`h${n}`), depth: 1, prs, lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T12:00:00.000Z", ...extra });
  const auth = (prs: number[]) =>
    Object.fromEntries(prs.map((p) => [String(p), { head: H(`pr${p}`), baseRepoId: 1, policy: "v2:x", policyPr: false, admittedAt: "2026-10-21T12:00:00.000Z", labelledAt: "2026-10-21T12:00:00.000Z", evidence: [], reviewRun: null }]));
  const doc = (over: Partial<State> & Record<string, unknown>) => JSON.stringify({ ...emptyState(), lineages: { "1": { runs: 2 } }, auth: auth([1, 2, 3]), ...over });

  test("several running batches round-trip, byte for byte", () => {
    const text = doc({ active: batch(5, [1]) as State["active"], concurrent: [batch(6, [2, 3], { on: 5, depth: 0 })] as State["active"][] as never });
    const s = parseState(text, NAMES);
    expect(JSON.stringify(s)).toBe(text);
    expect(actives(s).map((a) => a.n)).toEqual([5, 6]);
  });

  test("refused: concurrent without active, empty, out of order, a PR in two batches, a stacked batch on a later one", () => {
    expect(() => parseState(doc({ concurrent: [batch(6, [2])] as never }), NAMES)).toThrow("no batch is active");
    expect(() => parseState(doc({ active: batch(5, [1]) as never, concurrent: [] as never }), NAMES)).toThrow("empty");
    expect(() => parseState(doc({ active: batch(5, [1]) as never, concurrent: [batch(7, [2]), batch(6, [3])] as never }), NAMES)).toThrow("order");
    expect(() => parseState(doc({ active: batch(5, [1]) as never, concurrent: [batch(6, [1])] as never }), NAMES)).toThrow("more than one");
    expect(() => parseState(doc({ active: batch(5, [1]) as never, concurrent: [batch(6, [2], { on: 7 })] as never }), NAMES)).toThrow("not an earlier batch");
    expect(() => parseState(doc({ active: batch(5, [1]) as never, concurrent: [batch(5, [2])] as never }), NAMES)).toThrow();
  });

  test("a build journalled beside a running batch must not pin a PR that is already placed", () => {
    const op = (pr: number) => ({ kind: "build", n: 9, base: H("b5"), pins: [{ pr, head: H(`pr${pr}`) }], depth: 0, lineage: 1, source: { kind: "candidates" }, rebuild: false });
    const j = (pr: number) => ({ seq: 9, op: op(pr), reserved: true, at: "2026-10-21T12:00:00.000Z", checkpoint: null, tries: 0 });
    expect(() => parseState(doc({ active: batch(5, [1]) as never, journal: j(2) as never }), NAMES)).not.toThrow();
    expect(() => parseState(doc({ active: batch(5, [1]) as never, journal: j(1) as never }), NAMES)).toThrow("already placed");
  });
});

describe("config", () => {
  test("queue.concurrency is not policy: the policy hash is the same with it, without it, and at any value", () => {
    const h = policyHash(BASE_CONFIG);
    expect(policyHash({ ...BASE_CONFIG, concurrency: { maxActive: 2, pipelineDepth: 1 } })).toBe(h);
    expect(policyHash({ ...BASE_CONFIG, concurrency: { maxActive: 4, pipelineDepth: 0 } })).toBe(h);
  });
});

describe("config file", () => {
  const base = OPT_IN_FREE_YAML;
  const withBlock = (block: string) => base.replace(/^( {2}controlLabels:)/m, `  concurrency:\n${block}\n$1`);
  const problems = (text: string) => {
    try {
      parseConfig(text);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("absent: no key, one batch at a time; present: the defaults fill in, and the hash never moves", () => {
    expect("concurrency" in parseConfig(base).config).toBe(false);
    const on = parseConfig(withBlock("    maxActive: 2")).config;
    expect(on.concurrency).toEqual({ maxActive: 2, pipelineDepth: DEFAULT_PIPELINE_DEPTH });
    expect(parseConfig(withBlock("    pipelineDepth: 0")).config.concurrency).toEqual({ maxActive: DEFAULT_MAX_ACTIVE, pipelineDepth: 0 });
    expect(policyHash(on)).toBe(OPT_IN_FREE_HASH);
  });

  test("refused: pipelineDepth not below maxActive, a zero cap, an unknown key", () => {
    expect(problems(withBlock("    maxActive: 2\n    pipelineDepth: 2"))).toContain("queue.concurrency.pipelineDepth must be less than queue.concurrency.maxActive");
    expect(problems(withBlock("    maxActive: 0"))).not.toBe("");
    expect(problems(withBlock("    maxActive: 2\n    extra: 1"))).not.toBe("");
  });
});

describe("wake (self-chaining) with several batches", () => {
  const b = (n: number, prs: number[]) => ({ n, base: sha(`b${n}`), head: sha(`h${n}`), depth: 1, prs, lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T12:00:00.000Z" });
  test("a free slot with work waiting chains at once; otherwise every running batch's CI is watched", () => {
    const one: State = { ...emptyState(), active: b(5, [1]), pending: [{ prs: [2], depth: 1, lineage: 1 }] };
    expect(wakeFor("acted", one, null, null, null, 2)).toEqual({ kind: "now", reason: "a batch slot is free and work is waiting" });
    // Without queue.concurrency (cap 1), the same state watches CI, as before.
    expect(wakeFor("acted", one)).toEqual({ kind: "ci", n: 5, head: sha("h5") });
    const two: State = { ...emptyState(), active: b(5, [1]), concurrent: [b(6, [2])] };
    expect(wakeFor("acted", two, null, null, null, 2)).toEqual({ kind: "ci", n: 5, head: sha("h5"), more: [{ n: 6, head: sha("h6") }] });
  });
});
