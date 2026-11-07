// queue.strategy.mainBaseline (DESIGN.md §5.7): before a PR that failed alone is
// bounced, the suite runs on main with no PR in it. A PR that fails only what
// main fails stays admitted and is not counted. Nothing lands on a red suite, a
// failure of the PR's own still bounces it, and a broken main stays loud.

import { describe, expect, test } from "bun:test";
import { baselineResult, mainFailures, ownFailures } from "../src/baseline";
import type { Config } from "../src/config";
import { parseConfig } from "../src/config/load";
import { policyHash } from "../src/queue";
import { notIdle } from "../src/control";
import { CONFIG_PATH } from "../src/config/load";
import type { StateRepoApi, TargetApi } from "../src/github/api";
import { GitHubError } from "../src/github/http";
import { decide } from "../src/machine";
import { drain } from "../src/outbox";
import { readWatchdogConfig } from "../src/watchdog";
import { emptyState, parseState, renderState, type State } from "../src/state";
import type { Observation } from "../src/watchdog-core";
import { evaluate, THRESHOLDS } from "../src/watchdog-core";
import { mainRedFrom, summariseQueueState } from "../src/watchdog-render";
import { actives } from "../src/ctx";
import { cfg, livePr, NAMES, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, type Oracle, red, sha, Sim } from "./sim";
import { World } from "./world";

const ON: Partial<Config> = { strategy: { mainBaseline: true } };
const BROKEN = "tests/unit/test_main.py::test_broken_on_main";
const OWN = "tests/unit/test_pr.py::test_broken_by_the_pr";
const OWN_TOO = "tests/unit/test_pr.py::test_broken_by_another_pr";
const log = (tests: string[]) => tests.map((t) => `FAILED ${t} - boom`).join("\n");

interface Setup {
  /** What main fails with no PR in it, given which attempt on main this is. */
  main?: (nth: number) => string[];
  /** What a PR fails, on top of what main fails. */
  pr?: Record<number, string[]>;
  /** A PR that fixes main: once in the tree, main fails nothing. */
  fix?: number;
  over?: Partial<Config>;
  /** No log can be read, so nothing but job names can be compared. */
  noLogs?: boolean;
}

function world(o: Setup) {
  const failing = new Map<number, string[]>();
  let baselines = 0;
  const main = o.main ?? (() => [BROKEN]);
  const w: World = new World(
    (b) => {
      const isBaseline = w.stateRef.current ? parseState(w.stateRef.current.text, w.config.names).baseline?.n === b.n : false;
      const fixed = o.fix !== undefined && (b.mainHas.includes(o.fix) || (!isBaseline && b.prs.includes(o.fix)));
      if (isBaseline && b.attempt === 1) baselines++;
      const fromMain = fixed ? [] : main(baselines);
      const tests = [...fromMain, ...(isBaseline ? [] : b.prs.flatMap((pr) => o.pr?.[pr] ?? []))];
      failing.set(b.n, tests);
      return tests.length > 0 ? "fail" : "pass";
    },
    { ...ON, ...o.over },
  );
  w.failLog = (n) => (o.noLogs ? undefined : log(failing.get(n) ?? []));
  return w;
}

const ticks = async (w: World, n: number) => {
  for (let i = 0; i < n && !w.paused(); i++) await w.tick();
};
const bouncedComments = (w: World, pr: number) => (w.target.prs.get(pr)?.comments ?? []).filter((c) => c.body.startsWith("Bounced")).map((c) => c.body);
const stillReady = (w: World, pr: number) => w.target.prs.get(pr)!.pr.labels.includes(w.config.names.labels.ready);
/** Every value main took passed the suite, or is where it started. */
const neverLandedOnRed = (w: World) => {
  for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
};

describe("comparing failures", () => {
  const job = (name: string, id: number) => ({ name, url: `https://github.com/j/${id}`, id });

  test("a shard red on main does not hide a new failure in the same shard", () => {
    const main = baselineResult([job("unit", 1), job("all", 2)], { "1": ["a"] });
    expect(ownFailures([job("unit", 3), job("all", 4)], { "3": ["a"] }, main)).toEqual([]);
    expect(ownFailures([job("unit", 3), job("all", 4)], { "3": ["a", "b"] }, main)).toEqual(["b"]);
  });

  test("a job with no test ids matches by name, and a job main does not fail is the PR's own", () => {
    const main = baselineResult([job("unit", 1), job("all", 2)], { "1": ["a"] });
    expect(ownFailures([job("all", 4)], {}, main)).toEqual([]);
    expect(ownFailures([job("lint", 4)], {}, main)).toEqual(["lint"]);
  });

  test("main's job with no readable ids can only match by name", () => {
    const main = baselineResult([job("unit", 1)], {});
    expect(main.byJob).toEqual(["unit"]);
    expect(ownFailures([job("unit", 3)], { "3": ["a"] }, main)).toEqual([]);
  });

  test("too many ids in a job reads as the whole job, on either side", () => {
    const many = Array.from({ length: 11 }, (_, i) => `t${i}`);
    const main = baselineResult([job("unit", 1)], { "1": many });
    expect(main.tests).toEqual([]);
    expect(ownFailures([job("unit", 3)], { "3": ["z"] }, main)).toEqual([]);
    const narrow = baselineResult([job("unit", 1)], { "1": ["a"] });
    expect(ownFailures([job("unit", 3)], { "3": many }, narrow)).toEqual([]);
  });

  test("a summary names at most a few", () => {
    expect(mainFailures({ red: true, jobs: ["j"], tests: ["a", "b", "c", "d"], byJob: [] })).toBe("a, b, c and 1 more");
    expect(mainFailures({ red: true, jobs: ["j"], tests: [], byJob: ["j"] })).toBe("j");
  });
});

describe("config", () => {
  test("present only when on, and not policy", () => {
    const y = OPT_IN_FREE_YAML.replace(/^( {2}controlLabels:)/m, "  strategy:\n    mainBaseline: true\n$1");
    expect(parseConfig(y).config.strategy).toEqual({ mainBaseline: true });
    expect(policyHash(parseConfig(y).config)).toBe(OPT_IN_FREE_HASH);
    expect(parseConfig(OPT_IN_FREE_YAML).config.strategy).toBeUndefined();
  });

  test("off: a PR that fails alone is bounced with no extra run", async () => {
    const w = world({ over: { strategy: {} } });
    w.readyPr(1);
    await ticks(w, 8);
    expect(bouncedComments(w, 1)).toHaveLength(1);
    expect(w.state().bounceStreak).toBe(1);
    expect(w.state().baseline).toBeUndefined();
    expect(w.verdicts.map((v) => v[0]).filter((n, i, all) => all.indexOf(n) === i)).toHaveLength(1);
  });
});

describe("a PR that fails only what main fails", () => {
  test("stays admitted and `ready`, is not bounced or counted, and is told why", async () => {
    const w = world({});
    w.readyPr(1);
    await ticks(w, 10);
    expect(bouncedComments(w, 1)).toEqual([]);
    expect(stillReady(w, 1)).toBe(true);
    const s = w.state();
    expect(s.auth["1"]).toBeDefined();
    expect(s.bounceStreak).toBe(0);
    expect(s.baseline?.result?.tests).toEqual([BROKEN]);
    expect(s.baseline?.held.map((h) => h.pr)).toEqual([1]);
    expect(w.mainHistory).toHaveLength(1);
    const told = w.target.prs.get(1)!.comments.map((c) => c.body).find((b) => b.startsWith("Still in the landing queue"));
    expect(told).toContain(BROKEN);
    expect(told).not.toContain("@");
  });

  test("the run on main is at main's own commit, is charged to the budget once, and its ref goes", async () => {
    const w = world({});
    w.readyPr(1);
    await ticks(w, 10);
    const s = w.state();
    const n = s.baseline!.n;
    expect(s.baseline!.base).toBe(w.target.refs.get(w.config.names.main)!);
    expect(w.verdicts.filter((v) => v[0] === n)).toHaveLength(1);
    expect(w.target.refs.has(`${w.config.names.queuePrefix}${n}`)).toBe(false);
    expect(s.window).toHaveLength(3); // the PR, its rerun, the run on main
  });

  test("is not built again on the same main, so it costs no more runs", async () => {
    const w = world({});
    w.readyPr(1);
    await ticks(w, 10);
    const runs = w.verdicts.length;
    await ticks(w, 6);
    expect(w.verdicts.length).toBe(runs);
    expect(w.paused()).toBe(false);
  });

  test("a later PR on the same main needs no second run on main", async () => {
    const w = world({ over: { ...ON, breakerBounces: 5 } });
    w.readyPr(1);
    await ticks(w, 10);
    const n = w.state().baseline!.n;
    w.readyPr(2);
    await ticks(w, 10);
    const s = w.state();
    expect(s.baseline!.n).toBe(n);
    expect(s.baseline!.held.map((h) => h.pr)).toEqual([1, 2]);
    expect(w.verdicts.filter((v) => v[0] === n)).toHaveLength(1);
  });

  test("a group on a main known to be red is held whole, without splitting", async () => {
    const w = world({ over: { ...ON, breakerBounces: 9, maxBatch: 4, minFill: 1 } });
    w.readyPr(1);
    await ticks(w, 10);
    const before = w.verdicts.length;
    for (const n of [2, 3, 4]) w.readyPr(n);
    await ticks(w, 12);
    expect(w.state().baseline!.held.map((h) => h.pr).sort()).toEqual([1, 2, 3, 4]);
    expect(w.state().history.some((h) => h.outcome === "split")).toBe(false);
    expect(w.verdicts.length).toBeLessThanOrEqual(before + 4); // the batch size halved after the first red: two batches, each with its rerun
  });

  test("a push takes it out of the hold, as it takes any PR out of the queue", async () => {
    const w = world({});
    w.readyPr(1);
    await ticks(w, 10);
    expect(w.state().baseline?.held.map((h) => h.pr)).toEqual([1]);
    w.target.push(1);
    await ticks(w, 2);
    expect(w.state().auth["1"]).toBeUndefined();
    expect(w.state().baseline?.held).toEqual([]);
  });

});

describe("a broken main stays loud, and nothing lands on a red suite", () => {
  test("a PR that fixes main lands by itself, and the held PRs are then tested and land", async () => {
    const w = world({ fix: 3 });
    w.readyPr(1);
    await ticks(w, 10);
    w.readyPr(2);
    await ticks(w, 10);
    expect(w.state().baseline?.held.map((h) => h.pr)).toEqual([1, 2]);
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([]);
    w.readyPr(3);
    await w.runUntilIdle(60);
    expect(w.paused()).toBe(false);
    expect(w.landed().flat().sort()).toEqual([1, 2, 3]);
    expect(w.state().baseline).toBeUndefined();
    expect(w.state().bounceStreak).toBe(0);
    expect(bouncedComments(w, 1)).toEqual([]);
    neverLandedOnRed(w);
  });

  test("breakerBounces PRs held: the queue pauses, saying main is broken and naming the test; they stay admitted", async () => {
    const w = world({ over: { ...ON, breakerBounces: 2 } });
    w.readyPr(1);
    await ticks(w, 10);
    expect(w.paused()).toBe(false);
    w.readyPr(2);
    await ticks(w, 12);
    expect(w.paused()).toBe(true);
    const issue = w.repo.issues.find((i) => i.labels.includes("pause"))!;
    expect(issue.title).toContain("main is broken");
    expect(issue.body).toContain(BROKEN);
    expect(issue.body).toContain("#1 #2");
    expect(issue.body).not.toContain("@");
    expect(stillReady(w, 1) && stillReady(w, 2)).toBe(true);
    expect(w.state().auth["1"] && w.state().auth["2"]).toBeDefined();
    expect(w.state().bounceStreak).toBe(0);
    expect(w.landed()).toEqual([]);
  });

  test("resuming retests the held PRs: a person's retry is a real retry", async () => {
    const w = world({ over: { ...ON, breakerBounces: 1 } });
    w.readyPr(1);
    await ticks(w, 10);
    expect(w.paused()).toBe(true);
    const n = w.state().baseline!.n;
    for (const i of w.repo.issues) if (i.labels.includes("pause")) i.open = false;
    const runs = w.verdicts.length;
    await w.tick();
    expect(w.state().baseline?.n ?? 0).not.toBe(n);
    await ticks(w, 12);
    expect(w.verdicts.length).toBeGreaterThan(runs); // tested again, and still only main's failure
    expect(w.state().baseline?.n).not.toBe(n);
    expect(bouncedComments(w, 1)).toEqual([]);
    expect(w.paused()).toBe(true);
  });

  test("the watchdog alerts from the state mirror, and stays quiet with none held", () => {
    const base = sha("main");
    const state = (held: number[]): State =>
      ({ ...emptyState(), baseline: { n: 7, base, builtAt: "2026-10-21T12:00:00.000Z", forBatch: 6, result: { red: true, jobs: ["unit"], tests: [BROKEN], byJob: [] }, held: held.map((pr) => ({ pr, head: sha(`h${pr}`) })) } }) as State;
    const body = (s: State) => `Mirror.\n\n${renderState(s)}`;
    expect(mainRedFrom(body(state([])))).toBeNull();
    const seen = mainRedFrom(body(state([4])));
    expect(seen).toEqual({ base, failing: [BROKEN], held: [4] });
    expect(mainRedFrom("no state here")).toBe("unreadable");
    expect(summariseQueueState(body(state([4]))).join("\n")).toContain("held PRs 1");
    const now = new Date("2026-10-21T12:00:00Z");
    const o: Observation = { now, workflowState: "active", runs: [], jobsComplete: true, unfinishedComplete: true, pause: [], releasePause: [], releaseBlocked: [], pausesComplete: true, pauseLabels: { queue: "pause", release: "release-pause" } };
    const kinds = (m: Observation["mainRed"]) => evaluate({ ...o, mainRed: m }, THRESHOLDS);
    expect(kinds(seen).alerts.filter((a) => a.kind === "main-broken")).toHaveLength(1);
    expect(kinds(null).alerts.filter((a) => a.kind === "main-broken")).toHaveLength(0);
    expect(kinds("unreadable").unknown.filter((u) => u.kind === "main-broken")).toHaveLength(1);
  });
});

describe("a failure of the PR's own is never hidden", () => {
  test("it fails what main fails and more, in the same job: bounced and counted, and told which is which", async () => {
    const w = world({ pr: { 1: [OWN] } });
    w.readyPr(1);
    await ticks(w, 10);
    const b = bouncedComments(w, 1);
    expect(b).toHaveLength(1);
    expect(b[0]).toContain(OWN);
    expect(b[0]).toContain(BROKEN);
    expect(w.state().bounceStreak).toBe(1);
    expect(stillReady(w, 1)).toBe(false);
  });

  test("main is fine: bounced as ever, and a green run is not reused for the next PR", async () => {
    const w = world({ main: () => [], pr: { 1: [OWN], 2: [OWN_TOO] } });
    w.readyPr(1);
    await ticks(w, 10);
    expect(bouncedComments(w, 1)).toHaveLength(1);
    expect(w.state().baseline).toBeUndefined();
    w.readyPr(2);
    await ticks(w, 10);
    expect(bouncedComments(w, 2)).toHaveLength(1);
    expect(w.state().bounceStreak).toBe(2);
    const numbers = new Set(w.verdicts.map((v) => v[0]));
    expect(numbers.size).toBe(4); // two PRs, each with its own run on main
  });

  test("three bounces of their own still pause as ever", async () => {
    const w = world({ main: () => [], pr: { 1: [OWN], 2: [OWN], 3: [OWN] } });
    for (const n of [1, 2, 3]) {
      w.readyPr(n);
      await ticks(w, 10);
    }
    expect(w.state().bounceStreak).toBeGreaterThanOrEqual(w.config.breakerBounces);
    expect(w.pauseReasons().join()).toContain("bounces in a row");
  });

  test("a flaky failure on main that passes once: that PR is judged as ever, and the next run can still catch it", async () => {
    // The first PR's two attempts fail, and then the run on main passes, on the same main.
    let calls = 0;
    const w = world({ main: () => (++calls === 3 ? [] : [BROKEN]) });
    w.readyPr(1);
    await ticks(w, 10);
    expect(bouncedComments(w, 1)).toHaveLength(1);
    w.readyPr(2);
    await ticks(w, 10);
    expect(bouncedComments(w, 2)).toEqual([]);
    expect(w.state().baseline?.held.map((h) => h.pr)).toEqual([2]);
  });

  test("a CI-policy PR is judged as ever: it may have changed the gates", () => {
    const s = new Sim(cfg(ON), () => red()).add(livePr(1, { policyPr: true, policyApproval: true }));
    s.runUntilIdle();
    expect(s.bounced).toEqual([1]);
    expect(s.state.baseline).toBeUndefined();
    expect(s.state.bounceStreak).toBe(1);
  });

  test("main's run is inconclusive: bounced as ever, with the run cancelled and its budget spent", async () => {
    const o: Setup = {};
    const w = world(o);
    const oracle = w.oracle;
    w.oracle = (b) => (w.state().baseline?.n === b.n ? "cancel" : oracle(b));
    w.readyPr(1);
    await ticks(w, 10);
    expect(bouncedComments(w, 1)).toHaveLength(1);
    expect(w.state().baseline).toBeUndefined();
    expect(w.state().bounceStreak).toBe(1);
  });

  test("with no readable logs only job names compare: the PR is held, and still lands only on green", async () => {
    const w = world({ noLogs: true, fix: 2 });
    w.readyPr(1);
    await ticks(w, 10);
    expect(bouncedComments(w, 1)).toEqual([]);
    w.readyPr(2);
    await w.runUntilIdle(60);
    expect(w.landed().flat().sort()).toEqual([1, 2]);
    neverLandedOnRed(w);
  });
});

describe("a broken main with PRs queued behind it", () => {
  test("three PRs red alone in a row, two of them only on main's test: one real bounce, no 3-bounce pause, and the fix unblocks the rest", async () => {
    const w = world({ pr: { 1: [OWN] }, fix: 4 });
    for (const n of [1, 2, 3]) {
      w.readyPr(n);
      await ticks(w, 12);
    }
    const s = w.state();
    expect(bouncedComments(w, 1)).toHaveLength(1);
    expect(bouncedComments(w, 2)).toEqual([]);
    expect(bouncedComments(w, 3)).toEqual([]);
    expect(s.bounceStreak).toBe(1);
    expect(w.pauseReasons()).toEqual([]);
    expect(s.baseline?.held.map((h) => h.pr)).toEqual([2, 3]);
    w.readyPr(4);
    await w.runUntilIdle(60);
    expect(w.landed().flat().sort()).toEqual([2, 3, 4]);
    neverLandedOnRed(w);
  });
});

describe("state", () => {
  test("round-trips through the strict reader, and refuses a malformed record", () => {
    const base = sha("main");
    const ok = { ...emptyState(), baseline: { n: 7, base, builtAt: "2026-10-21T12:00:00.000Z", forBatch: 6, held: [] } };
    expect(parseState(JSON.stringify(ok), NAMES).baseline?.n).toBe(7);
    expect(() => parseState(JSON.stringify({ ...ok, baseline: { ...ok.baseline, held: "x" } }), NAMES)).toThrow();
    expect(() => parseState(JSON.stringify({ ...ok, baseline: { ...ok.baseline, stopped: false } }), NAMES)).toThrow();
    expect(() => parseState(JSON.stringify({ ...ok, baseline: { ...ok.baseline, result: { red: "yes", jobs: [], tests: [], byJob: [] } } }), NAMES)).toThrow();
  });
});

describe("queue refs", () => {
  test("a batch built in the same tick as the run on main gets its own queue ref", () => {
    // [1,2] goes red and splits; [1] is red alone while [2] is still going, and a slot is free beside them.
    const oracle: Oracle = (b) => (b.prs.includes(1) ? red() : { kind: "pending", reason: "running" });
    const s = new Sim(cfg({ ...ON, concurrency: { maxActive: 3, pipelineDepth: 1 }, maxBatch: 2, minBatch: 2, minFill: 1 }), oracle);
    s.add(livePr(1), livePr(2));
    let d = decide(s.state, s.snapshot(), s.config);
    for (let i = 0; i < 20 && !d.state.baseline; i++) {
      s.tick();
      if (actives(s.state).some((a) => a.prs.length === 1 && a.prs[0] === 1 && a.rerun !== null)) s.add(livePr(3));
      d = decide(s.state, s.snapshot(), s.config);
    }
    expect(d.state.baseline).toBeDefined();
    const op = d.state.journal?.op;
    expect(op?.kind).toBe("build");
    if (op?.kind === "build") expect(op.n).not.toBe(d.state.baseline!.n);
  });
});

describe("crashes, pauses and held batches", () => {
  const notice = { id: "b:9", kind: "createRef" as const, ref: "queue/9", head: sha("main") };
  const drainWith = async (o: { conflict?: boolean; pause?: boolean }) => {
    const calls: string[] = [];
    const target = {
      getRef: async () => null,
      createRef: async () => {
        calls.push("createRef");
        if (o.conflict) throw new GitHubError("conflict", 422, "Reference already exists");
      },
    } as unknown as TargetApi;
    const repo = { listOpenIssues: async () => ({ issues: o.pause ? [{ number: 1, title: "p", body: "" }] : [], complete: true }) } as unknown as StateRepoApi;
    const out = await drain({ ...emptyState(), outbox: [notice] }, { target, repo, names: NAMES, now: new Date(), reconcileMinutes: 5, save: async () => {} });
    return { out, calls };
  };

  test("a lagging read and a ref that already exists never pause: the notice waits for the next tick", async () => {
    const { out } = await drainWith({ conflict: true });
    expect(out.failure).toBeNull();
    expect(out.outbox).toHaveLength(1);
  });

  test("the ref that starts CI waits out a pause", async () => {
    const { out, calls } = await drainWith({ pause: true });
    expect(calls).toEqual([]);
    expect(out.outbox).toHaveLength(1);
    expect((await drainWith({})).calls).toEqual(["createRef"]);
  });

  test("a green run waits for its batch, however long that batch is held, and is not run twice", async () => {
    const w = world({ main: () => [], pr: { 1: [OWN] } });
    w.ciTicks = 0;
    w.readyPr(1);
    // Up to and including the tick that starts the run on main.
    for (let i = 0; i < 10; i++) {
      await w.tick();
      if (w.state().baseline) break;
    }
    const n = w.state().baseline!.n;
    w.target.prs.get(1)!.pr.mergeable = null;
    await w.tick();
    expect(w.state().baseline?.n).toBe(n);
    expect(w.state().baseline?.result?.red).toBe(false);
    w.target.prs.get(1)!.pr.mergeable = true;
    await ticks(w, 4);
    expect(bouncedComments(w, 1)).toHaveLength(1);
    expect(new Set(w.verdicts.map((v) => v[0])).size).toBe(2);
    expect(w.state().baseline).toBeUndefined();
  });

  test("a result nobody is waiting for goes", () => {
    const s = new Sim(cfg(ON));
    s.state = { ...s.state, baseline: { n: 7, base: s.main, builtAt: s.now.toISOString(), forBatch: 6, result: { red: false, jobs: [], tests: [], byJob: [] }, held: [] } };
    expect(decide(s.state, s.snapshot(), s.config).state.baseline).toBeUndefined();
  });

  test("quiesce doesn't call a queue idle while the run on main is going", () => {
    const base = sha("main");
    const queue = (baseline: State["baseline"]) => ({ kind: "ok" as const, state: { ...emptyState(), ...(baseline ? { baseline } : {}) } as State, commit: "c" });
    const release = { kind: "absent" as const };
    const docs = (b: State["baseline"]) => ({ queue: queue(b), release }) as unknown as Parameters<typeof notIdle>[0];
    const conf = { names: NAMES } as unknown as Parameters<typeof notIdle>[1];
    const going = { n: 7, base, builtAt: "2026-10-21T12:00:00.000Z", forBatch: 6, held: [] };
    expect(notIdle(docs(going), conf).join()).toContain("no PR in it");
    expect(notIdle(docs({ ...going, result: { red: true, jobs: ["j"], tests: [], byJob: ["j"] } }), conf)).toEqual([]);
  });

  test("a mirror the watchdog can't find keeps an open alert, and only matters with the key on", () => {
    const now = new Date("2026-10-21T12:00:00Z");
    const o: Observation = { now, workflowState: "active", runs: [], jobsComplete: true, unfinishedComplete: true, pause: [], releasePause: [], releaseBlocked: [], pausesComplete: true, pauseLabels: { queue: "pause", release: "release-pause" } };
    expect(evaluate({ ...o, mainRed: "unreadable" }, THRESHOLDS).unknown.map((u) => u.kind)).toContain("main-broken");
    expect(readWatchdogConfig(CONFIG_PATH)).toMatchObject({ ok: true, mainBaseline: false });
  });
});

describe("a test that fails on and off on main", () => {
  /**
   * Main's own run always passes. Each PR fails `fails[pr]` (default BROKEN)
   * on the first `first[pr]` batches it is in, on every attempt, and passes
   * after that: a failure that comes and goes, as main's own run never shows.
   */
  function onAndOff(o: { first: Record<number, number>; fails?: Record<number, string[]>; over?: Partial<Config> }) {
    const failing = new Map<number, string[]>();
    const builds = new Map<number, number>();
    const counted = new Set<number>();
    const w: World = new World(
      (b) => {
        const isBaseline = w.stateRef.current ? parseState(w.stateRef.current.text, w.config.names).baseline?.n === b.n : false;
        if (!isBaseline && !counted.has(b.n)) {
          counted.add(b.n);
          for (const pr of b.prs) builds.set(pr, (builds.get(pr) ?? 0) + 1);
        }
        const tests = isBaseline ? [] : b.prs.flatMap((pr) => ((builds.get(pr) ?? 0) <= (o.first[pr] ?? 0) ? (o.fails?.[pr] ?? [BROKEN]) : []));
        failing.set(b.n, tests);
        return tests.length > 0 ? "fail" : "pass";
      },
      { ...ON, ...o.over },
    );
    w.failLog = (n) => log(failing.get(n) ?? []);
    return w;
  }
  const retried = (w: World, pr: number) => (w.target.prs.get(pr)?.comments ?? []).filter((c) => c.body.includes("is tested alone once more")).map((c) => c.body);

  test("the second PR to fail it alone is tested again instead of bounced, and lands", async () => {
    const w = onAndOff({ first: { 1: 1, 2: 1 } });
    w.readyPr(1);
    await ticks(w, 10);
    expect(bouncedComments(w, 1)).toHaveLength(1);
    expect(w.state().aloneRed?.seen.map((e) => e.pr)).toEqual([1]);
    w.readyPr(2);
    await w.runUntilIdle(60);
    expect(bouncedComments(w, 2)).toEqual([]);
    const told = retried(w, 2);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("#1");
    expect(told[0]).toContain(BROKEN);
    expect(told[0]).not.toContain("@");
    expect(w.landed().flat()).toEqual([2]);
    expect(w.paused()).toBe(false);
    expect(w.state().bounceStreak).toBe(0); // the landing reset it; the retry never counted
    expect(w.state().aloneRed).toBeUndefined(); // main moved
    neverLandedOnRed(w);
  });

  test("three PRs in a row each fail it alone: the second is retried and lands, and the bounces never reach the pause", async () => {
    const w = onAndOff({ first: { 1: 1, 2: 1, 3: 1 } });
    for (const n of [1, 2, 3]) {
      w.readyPr(n);
      await ticks(w, 24);
    }
    expect(bouncedComments(w, 1)).toHaveLength(1);
    expect(retried(w, 2)).toHaveLength(1);
    expect(bouncedComments(w, 2)).toEqual([]);
    expect(w.landed().flat()).toEqual([2]);
    // Main moved when #2 landed: #3 is the first to fail it on the new main, so it bounces, as #1 did.
    expect(bouncedComments(w, 3)).toHaveLength(1);
    expect(w.pauseReasons()).toEqual([]);
    expect(w.state().bounceStreak).toBe(1);
    neverLandedOnRed(w);
  });

  test("a PR that really breaks the same test is retried once, then bounced and counted, and the breaker still pauses", async () => {
    const w = onAndOff({ first: { 1: 99, 2: 99, 3: 99 } });
    for (const n of [1, 2, 3]) {
      w.readyPr(n);
      await ticks(w, 24);
    }
    expect(bouncedComments(w, 1)).toHaveLength(1);
    for (const n of [2, 3]) {
      expect(retried(w, n)).toHaveLength(1);
      expect(bouncedComments(w, n)).toHaveLength(1);
    }
    expect(retried(w, 1)).toEqual([]);
    expect(w.pauseReasons().join()).toContain("3 bounces in a row");
    // #2's marker went when #3 was retried, since #2 had left the queue; #3's stays, but the watchdog skips it, as #3 left too.
    expect(w.state().aloneRed?.retried.map((r) => [r.pr, r.failing])).toEqual([[3, [BROKEN]]]);
    expect(mainRedFrom(`Mirror.\n\n${renderState(w.state())}`)).toBeNull();
    expect(w.landed()).toEqual([]);
  });

  test("a different failure is the PR's own: bounced with no retry", async () => {
    const w = onAndOff({ first: { 1: 99, 2: 99 }, fails: { 1: [OWN], 2: [OWN_TOO] } });
    w.readyPr(1);
    await ticks(w, 10);
    w.readyPr(2);
    await ticks(w, 10);
    expect(retried(w, 2)).toEqual([]);
    expect(bouncedComments(w, 2)).toHaveLength(1);
    expect(w.state().bounceStreak).toBe(2);
  });

  test("off: nothing is remembered and nothing is retried", async () => {
    const w = onAndOff({ first: { 1: 99, 2: 99 }, over: { strategy: {} } });
    w.readyPr(1);
    await ticks(w, 10);
    w.readyPr(2);
    await ticks(w, 10);
    expect(retried(w, 2)).toEqual([]);
    expect(bouncedComments(w, 2)).toHaveLength(1);
    expect(w.state().aloneRed).toBeUndefined();
  });

  test("the watchdog says main most likely fails on and off, from the state mirror", () => {
    const base = sha("main");
    const result = { red: true, jobs: ["unit"], tests: [BROKEN], byJob: [] };
    const state = (retried: number[]): State =>
      ({ ...emptyState(), auth: { "2": { head: sha("h2") } as unknown as State["auth"][string] }, aloneRed: { base, seen: [{ pr: 1, n: 3, result }, { pr: 2, n: 6, result: { ...result, tests: ["later::only_this_pr"] } }], retried: retried.map((pr) => ({ pr, head: sha(`h${pr}`), other: 1, failing: [BROKEN] })) } }) as State;
    const body = (s: State) => `Mirror.\n\n${renderState(s)}`;
    expect(mainRedFrom(body(state([])))).toBeNull();
    const seen = mainRedFrom(body(state([2])));
    // What the retry was for, not what #2 failed later on its own.
    expect(seen).toEqual({ base, failing: [BROKEN], held: [2], onAndOff: true });
    expect(summariseQueueState(body(state([2]))).join("\n")).toContain("tested alone again 1");
    const now = new Date("2026-10-21T12:00:00Z");
    const o: Observation = { now, workflowState: "active", runs: [], jobsComplete: true, unfinishedComplete: true, pause: [], releasePause: [], releaseBlocked: [], pausesComplete: true, pauseLabels: { queue: "pause", release: "release-pause" } };
    const alert = evaluate({ ...o, mainRed: seen }, THRESHOLDS).alerts.find((a) => a.kind === "main-broken");
    expect(alert?.detail).toContain("on and off");
    expect(alert?.detail).toContain("test\\_broken\\_on\\_main"); // markdown-escaped
    expect(alert?.detail).toContain("PR 2");
  });

  test("state round-trips through the strict reader, and refuses a malformed record", () => {
    const base = sha("main");
    const result = { red: true, jobs: ["unit"], tests: [BROKEN], byJob: [] };
    const retry = { pr: 2, head: sha("h2"), other: 1, failing: [BROKEN] };
    const ok = { ...emptyState(), aloneRed: { base, seen: [{ pr: 1, n: 3, result }], retried: [retry] } };
    expect(parseState(JSON.stringify(ok), NAMES).aloneRed?.retried).toEqual([retry]);
    const bad = (aloneRed: unknown) => () => parseState(JSON.stringify({ ...ok, aloneRed }), NAMES);
    expect(bad({ ...ok.aloneRed, seen: [] })).toThrow();
    expect(bad({ ...ok.aloneRed, seen: [ok.aloneRed.seen[0], ok.aloneRed.seen[0]] })).toThrow();
    expect(bad({ ...ok.aloneRed, seen: [{ pr: 1, n: 3, result: { ...result, red: false } }] })).toThrow();
    expect(bad({ ...ok.aloneRed, retried: [retry, { ...retry, head: sha("h3") }] })).toThrow();
    expect(bad({ ...ok.aloneRed, retried: [{ pr: 2, head: sha("h2") }] })).toThrow();
    expect(bad({ ...ok.aloneRed, retried: Array.from({ length: 9 }, (_, i) => ({ ...retry, pr: i + 2 })) })).toThrow();
    expect(bad({ base, seen: ok.aloneRed.seen })).toThrow();
  });
});
