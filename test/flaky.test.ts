// Flaky tracking: a red batch whose single rerun
// passes records its first attempt's failures, and one `flaky` issue per test.

import { describe, expect, test } from "bun:test";
import { appendOccurrence, cleanId, flakyItems, keyMarker, MAX_OCCURRENCES, MAX_TESTS_PER_JOB, parseFailingTests } from "../src/flaky";
import { GitHubError } from "../src/github/http";
import { drain } from "../src/outbox";
import { emptyState, type Notice, parseState, renderState, type State, stateFromIssueBody } from "../src/state";
import { flakySummary, summariseQueueState } from "../src/watchdog-render";
import { FakeStateRepo, FakeTarget } from "./fake-github";
import { cfg, green, LANE, livePr, NAMES, sha } from "./sim";
import type { CiClass } from "../src/classify";
import { actives } from "../src/ctx";
import { decide } from "../src/machine";
import { World } from "./world";

const T = "2026-10-21T10:00:01.1234567Z ";
const PYTEST = [
  `${T}[gw1] [ 40%] FAILED tests/unit/test_ingest.py::test_dedup[case-1]`,
  `${T}=========================== short test summary info ============================`,
  `${T}FAILED tests/unit/test_ingest.py::test_dedup[case-1] - AssertionError: assert 1 == 2`,
  `${T}\x1b[31mERROR tests/unit/test_db.py::TestPool::test_close\x1b[0m - TimeoutError`,
  `${T}========================= 2 failed, 900 passed in 61.2s =========================`,
].join("\n");

const flakyIssues = (w: World) => w.repo.issues.filter((i) => i.labels.includes("flaky"));
const occurrences = (body: string) => body.match(/qlander:flaky:/g)?.length ?? 0;

describe("test ids from job logs", () => {
  test("pytest: summary and xdist lines, timestamps and colour stripped, deduplicated", () => {
    expect(parseFailingTests(PYTEST)).toEqual(["tests/unit/test_ingest.py::test_dedup[case-1]", "tests/unit/test_db.py::TestPool::test_close"]);
  });

  test("vitest FAIL lines", () => {
    const log = ` FAIL  src/features/x/Thing.test.tsx > Thing > renders the empty state 12ms\n FAIL  src/a.test.ts > b`;
    expect(parseFailingTests(log)).toEqual(["src/features/x/Thing.test.tsx › Thing › renders the empty state", "src/a.test.ts › b"]);
  });

  test("playwright: the failed summary, line numbers dropped; its own flaky section is not a failure", () => {
    const log = ["  1 failed", "    [chromium] › e2e/login.spec.ts:12:5 › Login › signs in ─────", "  1 flaky", "    [chromium] › e2e/other.spec.ts:3:1 › retried and passed", "  40 passed (1.2m)"].join("\n");
    expect(parseFailingTests(log)).toEqual(["[chromium] › e2e/login.spec.ts › Login › signs in"]);
  });

  test("nothing recognisable gives no ids; markdown and HTML specials never survive", () => {
    expect(parseFailingTests("Error: process exited with code 1")).toEqual([]);
    expect(parseFailingTests("FAILED tests/x.py::test_`a`<b>@c")).toEqual(["tests/x.py::test_'a'‹b›@c"]);
  });

  test("ids stay distinct: non-ASCII kept, long ids cut with a hash, test and job keys never share an issue", () => {
    expect(cleanId("test[日本]")).not.toBe(cleanId("test[中国]"));
    const long = (end: string) => `tests/x.py::test_${"a".repeat(300)}${end}`;
    expect(cleanId(long("1")).length).toBeLessThanOrEqual(200);
    expect(cleanId(long("1"))).not.toBe(cleanId(long("2")));
    expect(keyMarker({ key: "Lint", byJob: true })).not.toBe(keyMarker({ key: "Lint", byJob: false }));
  });

  test("a job with one to ten failing tests gives one item per test; none or too many, one item for the job", () => {
    const many = Array.from({ length: MAX_TESTS_PER_JOB + 1 }, (_, i) => `t${i}`);
    const items = flakyItems([
      { name: "Unit A", url: "u1", tests: ["a", "b"] },
      { name: "Lint", url: "u2" },
      { name: "E2E", url: "u3", tests: many },
      { name: "Unit B", url: "u4", tests: ["a"] },
    ]);
    expect(items.map((i) => [i.key, i.byJob])).toEqual([["a", false], ["b", false], ["Lint", true], ["E2E", true]]);
  });

  test("occurrence lines are capped, oldest dropped", () => {
    let body = "head";
    for (let n = 1; n <= MAX_OCCURRENCES + 5; n++) body = appendOccurrence(body, `- ${n} <!-- qlander:flaky:${n}:x -->`);
    expect(occurrences(body)).toBe(MAX_OCCURRENCES);
    expect(body.startsWith("head\n- 6 ")).toBe(true);
  });
});

describe("the runner: rerun-then-pass is a flake, rerun-then-red is not", () => {
  test("a flake records history, a weekly mark and one issue per failing test, with occurrence links", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    w.failLog = () => PYTEST;
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    const s = w.state();
    const h = s.history.filter((x) => x.outcome === "flaky");
    expect(h).toHaveLength(1);
    expect(h[0]!.failedJobs!.map((j) => [j.name, j.tests])).toEqual([[LANE, ["tests/unit/test_ingest.py::test_dedup[case-1]", "tests/unit/test_db.py::TestPool::test_close"]]]);
    expect(h[0]!.runs).toHaveLength(1);
    expect(s.flakes).toEqual([{ at: h[0]!.at, n: h[0]!.n, count: 2, keys: ["tests/unit/test_ingest.py::test_dedup[case-1]", "tests/unit/test_db.py::TestPool::test_close"] }]);
    expect(s.active).toBeNull();
    const issues = flakyIssues(w);
    expect(issues.map((i) => i.title)).toEqual(["flaky: tests/unit/test_ingest.py::test_dedup[case-1]", "flaky: tests/unit/test_db.py::TestPool::test_close"]);
    for (const i of issues) {
      expect(occurrences(i.body)).toBe(1);
      expect(i.body).toContain(`batch ${h[0]!.n} ·`);
      expect(i.body).toContain(`runs ${h[0]!.runs![0]!.runId} attempt 1`);
    }
    expect(w.paused()).toBe(false);
  });

  test("the same test flaking again updates its one issue; a closed issue is not reused", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    w.failLog = () => "FAILED tests/unit/test_x.py::test_flaky - boom";
    w.readyPr(1);
    await w.runUntilIdle();
    w.readyPr(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1], [2]]);
    expect(flakyIssues(w)).toHaveLength(1);
    expect(occurrences(flakyIssues(w)[0]!.body)).toBe(2);
    expect(w.state().flakes).toHaveLength(2);
    flakyIssues(w)[0]!.open = false; // fixed and closed
    w.readyPr(3);
    await w.runUntilIdle();
    expect(flakyIssues(w).filter((i) => i.open)).toHaveLength(1);
    expect(flakyIssues(w)).toHaveLength(2);
  });

  test("no readable log: the flake is tracked by job name", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    w.readyPr(1);
    await w.runUntilIdle();
    expect(flakyIssues(w).map((i) => i.title)).toEqual([`flaky: job ${LANE}`]);
    expect(flakyIssues(w)[0]!.body).toContain(keyMarker({ key: LANE, byJob: true }));
  });

  test("a real failure (the rerun is red too) records no flake and opens no issue", async () => {
    const w = new World((b) => (b.prs.includes(2) ? "fail" : "pass"));
    w.failLog = () => PYTEST;
    for (const n of [1, 2, 3]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.bounced()).toEqual([2]);
    expect(w.state().history.some((h) => h.outcome === "flaky")).toBe(false);
    expect(w.state().flakes).toBeUndefined();
    expect(flakyIssues(w)).toEqual([]);
  });

  test("an infra rerun (cancelled job) that passes is not a flake", async () => {
    const w = new World((b) => (b.attempt === 1 ? "cancel" : "pass"));
    w.readyPr(1);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(flakyIssues(w)).toEqual([]);
  });
});

describe("state compatibility with state written before flaky tracking", () => {
  const serialise = (s: unknown) => `${JSON.stringify(s, null, 1)}\n`;
  /** A state from an all-green run: no flaky fields anywhere. */
  const prior = async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    return w.stateRef.current!.text;
  };
  /** A state taken while a red batch's rerun runs: `redJobs` carries the job ids. */
  const midRerun = async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"));
    w.readyPr(1);
    for (let i = 0; i < 40; i++) {
      await w.tick();
      const s = w.state();
      if (s.active?.rerun && s.active.redJobs) return s;
    }
    throw new Error("no rerun seen");
  };

  test("a state without flaky fields loads, and round-trips byte for byte without gaining any", async () => {
    const text = await prior();
    const s = parseState(text, NAMES);
    expect(s.flakes).toBeUndefined();
    expect(serialise(s)).toBe(text);
    expect(JSON.stringify(stateFromIssueBody(renderState(s), NAMES))).toBe(JSON.stringify(s));
  });

  test("a runner tick with no flake writes no new keys", async () => {
    const text = await prior();
    expect(text).not.toContain("flakes");
    expect(text).not.toContain("redJobs");
    expect(text).not.toContain('"flaky"');
  });

  test("redJobs written before job ids were kept still loads", async () => {
    const s = await midRerun();
    expect(s.active!.redJobs!.every((j) => typeof j.id === "number")).toBe(true);
    const old = { ...s, active: { ...s.active!, redJobs: s.active!.redJobs!.map(({ name, url }) => ({ name, url })) } };
    expect(parseState(serialise(old), NAMES)).toEqual(old);
  });

  test("the new fields load, and malformed ones are refused", async () => {
    const base = await midRerun();
    const ok: State = {
      ...base,
      flakes: [{ at: "2026-10-23T00:00:00.000Z", n: 3, count: 1, keys: ["a"] }],
      history: [{ n: 3, at: "2026-10-23T00:00:00.000Z", outcome: "flaky", prs: [1], head: null, note: "x", failedJobs: [{ name: "Test", url: "u", tests: ["a"] }], runs: [{ runId: 1, attempt: 1 }] }],
      outbox: [{ id: "f:3", kind: "flaky", n: 3, at: "2026-10-23T00:00:00.000Z", giveUpAt: "2026-10-24T00:00:00.000Z", runs: [{ runId: 1, attempt: 1 }], items: [{ key: "a", byJob: false, job: "Test", url: "u" }] }],
    };
    expect(parseState(JSON.stringify(ok), NAMES)).toEqual(ok);
    const bad = (mut: (o: Record<string, any>) => void) => {
      const o = JSON.parse(JSON.stringify(ok));
      mut(o);
      return () => parseState(JSON.stringify(o), NAMES);
    };
    expect(bad((o) => (o.flakes = [{ at: "yesterday", n: 1, count: 0, keys: [] }]))).toThrow("flakes[0].at");
    expect(bad((o) => (o.flakes = [{ at: "2026-10-23T00:00:00.000Z", n: 1, keys: [] }]))).toThrow("missing 'count'");
    expect(bad((o) => (o.active.redJobs = [{ name: 1, url: "u" }]))).toThrow("redJobs[0].name");
    expect(bad((o) => (o.active.redJobs = [{ name: "j", url: "u", id: 0 }]))).toThrow("redJobs[0].id");
    expect(bad((o) => (o.outbox[0].items = [{ key: "", byJob: false, job: "j", url: "u" }]))).toThrow("key: empty");
    expect(bad((o) => (o.outbox[0].extra = 1))).toThrow("unexpected key");
  });
});

describe("the flaky notice: idempotent and never a pause", () => {
  const notice = (over: Partial<Extract<Notice, { kind: "flaky" }>> = {}): Notice => ({
    id: "f:7",
    kind: "flaky",
    n: 7,
    at: "2026-10-23T00:00:00.000Z",
    giveUpAt: "2026-10-24T00:00:00.000Z",
    runs: [{ runId: 11, attempt: 1 }],
    items: [{ key: "tests/a.py::t", byJob: false, job: "Test", url: "https://github.com/c/actions/runs/11/job/5" }],
    ...over,
  });
  const run = (repo: FakeStateRepo, outbox: Notice[], now = "2026-10-23T01:00:00Z") =>
    drain({ ...emptyState(), outbox }, { target: new FakeTarget("queue", NAMES), repo, names: NAMES, now: new Date(now), reconcileMinutes: 30, save: async () => {} });

  test("performed again (a crash before the outbox was saved), it adds no issue and no line", async () => {
    const repo = new FakeStateRepo();
    await run(repo, [notice()]);
    const r = await run(repo, [notice()]);
    expect(r.outbox).toEqual([]);
    expect(repo.issues).toHaveLength(1);
    expect(occurrences(repo.issues[0]!.body)).toBe(1);
  });

  test("an incomplete listing creates nothing, keeps the notice, and does not hold up the notices behind it", async () => {
    const repo = new FakeStateRepo();
    repo.incomplete.add("flaky");
    const behind: Notice = { id: "p:1", kind: "pause", reason: "x" };
    const r = await run(repo, [notice(), behind]);
    expect(repo.issues.filter((i) => i.labels.includes("flaky"))).toEqual([]);
    expect(r.outbox.map((n) => n.id)).toEqual(["f:7"]);
    expect(r.failure).toBeNull();
    expect(repo.issues.filter((i) => i.labels.includes("pause"))).toHaveLength(1);
    const late = await run(repo, [notice()], "2026-10-24T00:00:01Z");
    expect(late.outbox).toEqual([]); // given up, silently
    expect(late.failure).toBeNull();
  });

  test("each item's receipt is saved as it is written: a failure on the second never revisits the first", async () => {
    const repo = new FakeStateRepo();
    const two = notice({ items: [{ key: "tests/a.py::t", byJob: false, job: "Test", url: "u" }, { key: "tests/b.py::t", byJob: false, job: "Test", url: "u" }] });
    const create = repo.createIssue.bind(repo);
    let calls = 0;
    repo.createIssue = async (t, b, l) => {
      if (++calls === 2) throw new GitHubError("server", 502, "boom");
      return create(t, b, l);
    };
    const r = await run(repo, [two]);
    expect((r.outbox[0] as Extract<Notice, { kind: "flaky" }>).done).toEqual(["test:tests/a.py::t"]);
    repo.issues[0]!.open = false; // closed meanwhile: must not be reopened as a new issue
    const again = await run(repo, r.outbox);
    expect(again.outbox).toEqual([]);
    expect(repo.issues.map((i) => i.title)).toEqual(["flaky: tests/a.py::t", "flaky: tests/b.py::t"]);
  });

  test("past its deadline it is dropped before anything is listed or written", async () => {
    const repo = new FakeStateRepo();
    const r = await run(repo, [notice()], "2026-10-24T00:00:00Z");
    expect(r.outbox).toEqual([]);
    expect(repo.listings).toEqual([]);
    expect(repo.issues).toEqual([]);
  });

  test("a permanent error drops it without a pause", async () => {
    const repo = new FakeStateRepo();
    repo.createIssue = async () => {
      throw new GitHubError("validation", 422, "label does not exist");
    };
    const r = await run(repo, [notice()]);
    expect(r.outbox).toEqual([]);
    expect(r.failure).toBeNull();
  });
});

describe("the weekly figure on the status issue", () => {
  const now = new Date("2026-10-23T12:00:00Z");
  test("counts the last 7 days, names the most frequent, and reads old state as none", () => {
    const flakes = [
      { at: "2026-10-10T00:00:00Z", n: 1, count: 1, keys: ["old"] },
      { at: "2026-10-20T00:00:00Z", n: 2, count: 2, keys: ["a", "b"] },
      { at: "2026-10-22T00:00:00Z", n: 3, count: 1, keys: ["a"] },
    ];
    expect(flakySummary(flakes, now)).toBe("flaky tests, last 7 days: 3 in 2 batches · most often `a` (2×) · open `flaky` issues track each one");
    expect(flakySummary(undefined, now)).toBe("flaky tests, last 7 days: none");
    expect(flakySummary("junk", now)).toBe("flaky tests, last 7 days: ?");
    const lines = summariseQueueState(renderState(emptyState()), { window: 10, windowHours: 24, now });
    expect(lines).toContain("flaky tests, last 7 days: none");
  });
});

describe("flakes with several batches running (queue.concurrency)", () => {
  const ON = { concurrency: { maxActive: 2, pipelineDepth: 1 } };
  /** The batch of 4 fails twice (so it splits); the first run of the later half [3,4] fails its first attempt only. */
  const onceFlaky = () => {
    let flaked: number | null = null;
    return (b: { n: number; prs: number[]; attempt: number; mainHas: number[] }) => {
      const own = b.prs.filter((p) => !b.mainHas.includes(p));
      if (own.length === 4) return "fail" as const;
      if (own.includes(3) && (flaked === null || flaked === b.n) && b.attempt === 1) {
        flaked = b.n;
        return "fail" as const;
      }
      return "pass" as const;
    };
  };
  const flakyHistory = (w: World) => w.state().history.filter((h) => h.outcome === "flaky");
  /** Every state written, to see where a batch sat when it was rerun. */
  const recording = (w: World) => {
    const texts: string[] = [];
    const cas = w.stateRef.cas.bind(w.stateRef);
    w.stateRef.cas = async (before, text) => {
      texts.push(text);
      return cas(before, text);
    };
    return texts;
  };

  test("a split half running beside the other half is recorded once, with its tests, from wherever it sits in state", async () => {
    const w = new World(onceFlaky(), ON);
    // The earlier half [1,2] runs long, so [3,4] fails, is rerun and passes while it runs.
    w.ciTicksFor = (b) => (b.prs.filter((p) => !b.mainHas.includes(p)).includes(1) ? 8 : 1);
    w.failLog = (_n, attempt) => (attempt === 1 ? "FAILED tests/unit/test_x.py::test_flaky - boom" : undefined);
    const texts = recording(w);
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await w.runUntilIdle(200);
    expect(w.landed().flat().sort()).toEqual([1, 2, 3, 4]);
    const h = flakyHistory(w);
    expect(h.map((x) => x.prs)).toEqual([[3, 4]]);
    expect(h[0]!.failedJobs![0]!.tests).toEqual(["tests/unit/test_x.py::test_flaky"]);
    // The half was rerun while the other half ran beside it.
    expect(texts.some((t) => actives(JSON.parse(t) as State).length === 2 && actives(JSON.parse(t) as State).some((a) => a.prs.includes(3) && a.redJobs !== undefined))).toBe(true);
    expect(flakyIssues(w).map((i) => i.title)).toEqual(["flaky: tests/unit/test_x.py::test_flaky"]);
    expect(occurrences(flakyIssues(w)[0]!.body)).toBe(1);
    expect(w.paused()).toBe(false);
  });

  test("a batch in `concurrent` (not `active`) whose rerun passed is recorded from its own CI, once", () => {
    const M = sha("main");
    const prs = [1, 2, 3, 4].map((n) => livePr(n));
    const au = Object.fromEntries(prs.map((p) => [String(p.number), { head: p.head, baseRepoId: p.baseRepoId, policy: "policy-1", policyPr: false, admittedAt: `2026-10-21T11:00:0${p.number}.000Z`, labelledAt: p.ready!.at, evidence: [], reviewRun: null }]));
    const batch = (n: number, b: number[], extra = {}) => ({ n, base: M, head: sha(`q${n}`), depth: 1, prs: b, lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T11:30:00.000Z", ...extra });
    const state: State = {
      ...emptyState(),
      seq: 7,
      nextLineage: 2,
      lineages: { "1": { runs: 4 } },
      auth: au,
      active: batch(5, [1, 2]),
      concurrent: [batch(6, [3, 4], { rerun: [{ runId: 9, attempt: 1 }], rerunAt: "2026-10-21T11:40:00.000Z", redJobs: [{ name: "Test", url: "https://github.com/o/r/actions/runs/9/job/77", id: 77 }] })],
    };
    const pending: CiClass = { kind: "pending", reason: "running" };
    const snap = { now: new Date("2026-10-21T12:00:00Z"), paused: false, main: M, policyHash: "policy-1", prs: Object.fromEntries(prs.map((p) => [String(p.number), p])), ci: pending, cis: { "5": pending, "6": green }, mainFailedJobs: null, pinReachable: {}, flakyTests: { "77": ["tests/a.py::t"] } };
    const d = decide(state, snap, cfg(ON));
    const h = d.state.history.filter((x) => x.outcome === "flaky");
    expect(h.map((x) => [x.n, x.prs, x.runs])).toEqual([[6, [3, 4], [{ runId: 9, attempt: 1 }]]]);
    expect(h[0]!.failedJobs![0]!.tests).toEqual(["tests/a.py::t"]);
    expect(d.state.outbox.filter((n) => n.kind === "flaky").map((n) => n.id)).toEqual(["f:6"]);
    expect(actives(d.state).every((a) => a.redJobs === undefined)).toBe(true);
    // Deciding again on the new state records nothing more.
    const again = decide({ ...d.state, journal: null }, snap, cfg(ON));
    expect(again.state.history.filter((x) => x.outcome === "flaky")).toHaveLength(1);
    expect(again.state.flakes).toHaveLength(1);
  });

  test("pipelining: a flaky batch and a flaky batch stacked on it are each recorded once", async () => {
    // [1,2] and the batch stacked on it, [3,4], both fail their first attempt only.
    const w = new World((b) => (b.attempt === 1 ? "fail" : "pass"), { ...ON, maxBatch: 2 });
    w.ciTicks = 3;
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await w.runUntilIdle(200);
    expect(w.landed().flat().sort()).toEqual([1, 2, 3, 4]);
    const h = flakyHistory(w);
    expect(h.map((x) => x.prs).sort()).toEqual([[1, 2], [3, 4]]);
    expect(new Set(h.map((x) => x.n)).size).toBe(2);
    expect(w.state().flakes).toHaveLength(2);
    expect(flakyIssues(w)).toHaveLength(1); // the same job, tracked by name, updated
    expect(occurrences(flakyIssues(w)[0]!.body)).toBe(2);
  });

  test("a green batch that waits for another reads its logs once, not on every tick it waits", async () => {
    const w = new World(onceFlaky(), ON);
    w.ciTicksFor = (b) => (b.prs.includes(1) ? 8 : 1);
    w.failLog = () => "FAILED tests/unit/test_x.py::test_flaky - boom";
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await w.runUntilIdle(200);
    expect(flakyHistory(w)).toHaveLength(1);
    const reads = w.target.calls.filter((c) => c.startsWith("jobLog "));
    expect(reads.length).toBeLessThanOrEqual(2);
  });
});

describe("review fixes: bounded parsing and writing, nothing lost", () => {
  test("a hostile log parses in linear time and still yields the real id", () => {
    const spaces = " ".repeat(1500);
    const hostile = [
      `FAIL x.test.ts > a${spaces}z`,
      `FAILED a.py::b${spaces}z`,
      `${"FAIL x.test.ts > a ".repeat(50)}z`,
      "1 failed",
      `[chromium] › a.spec.ts › t${" ".repeat(900)}${"─".repeat(90)}x`,
    ];
    const lines: string[] = [];
    while (lines.join("\n").length < 2_000_000) lines.push(...hostile);
    lines.push("FAILED tests/real.py::test_it - boom");
    const t0 = performance.now();
    const ids = parseFailingTests(lines.join("\n"));
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(ids).toContain("tests/real.py::test_it");
  });

  test("one huge line is skipped, not parsed", () => {
    const t0 = performance.now();
    expect(parseFailingTests(`FAIL x.test.ts > a${" ".repeat(1_900_000)}z\nFAILED tests/real.py::t`)).toEqual(["tests/real.py::t"]);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  test("suffixes are still cut: pytest reason, vitest duration, Playwright rule", () => {
    expect(parseFailingTests("FAILED tests/a.py::t[x - y] - AssertionError - z")).toEqual(["tests/a.py::t[x"]);
    expect(parseFailingTests(" FAIL  src/a.test.ts > s > t   12ms")).toEqual(["src/a.test.ts › s › t"]);
    expect(parseFailingTests("  1 failed\n    [webkit] › e2e/a.spec.ts:3:1 › t ──────")).toEqual(["[webkit] › e2e/a.spec.ts › t"]);
  });

  test("a job named like a test and that test from another job are two items", () => {
    const items = flakyItems([
      { name: "tests/a.py::t", url: "u1" },
      { name: "Unit", url: "u2", tests: ["tests/a.py::t"] },
    ]);
    expect(items.map((i) => [i.key, i.byJob])).toEqual([["tests/a.py::t", true], ["tests/a.py::t", false]]);
  });

  test("issue writes stop at the per-tick budget and resume on the next tick, each item once", async () => {
    const repo = new FakeStateRepo();
    const items = ["a", "b", "c"].map((k) => ({ key: `tests/${k}.py::t`, byJob: false, job: "Unit", url: "u" }));
    const n: Notice = { id: "f:7", kind: "flaky", n: 7, at: "2026-10-23T00:00:00.000Z", giveUpAt: "2026-10-24T00:00:00.000Z", runs: [{ runId: 11, attempt: 1 }], items };
    let ms = 0;
    const deps = (save: (o: Notice[]) => Promise<void>) => ({ target: new FakeTarget("queue", NAMES), repo, names: NAMES, now: new Date("2026-10-23T01:00:00Z"), reconcileMinutes: 30, save, clock: () => (ms += 15_000) });
    const first = await drain({ ...emptyState(), outbox: [n] }, deps(async () => {}));
    expect(first.failure).toBeNull();
    expect(first.outbox).toHaveLength(1);
    const left = first.outbox[0] as Extract<Notice, { kind: "flaky" }>;
    expect(left.done!.length).toBeGreaterThan(0);
    expect(left.done!.length).toBeLessThan(3);
    let rest = first.outbox;
    for (let i = 0; i < 5 && rest.length > 0; i++) rest = (await drain({ ...emptyState(), outbox: rest }, deps(async () => {}))).outbox;
    expect(rest).toEqual([]);
    expect(repo.issues.filter((i) => i.labels.includes("flaky")).map((i) => i.title).sort()).toEqual(items.map((i) => `flaky: ${i.key}`));
    for (const i of repo.issues) expect(occurrences(i.body)).toBe(1);
  });

  test("a batch whose rerun passed but which revalidation drops still records the flake", () => {
    const M = sha("main");
    const prs = [1, 2].map((n) => livePr(n));
    const au = Object.fromEntries(prs.map((p) => [String(p.number), { head: p.head, baseRepoId: p.baseRepoId, policy: "policy-1", policyPr: false, admittedAt: `2026-10-21T11:00:0${p.number}.000Z`, labelledAt: p.ready!.at, evidence: [], reviewRun: null }]));
    const state: State = {
      ...emptyState(),
      seq: 7,
      nextLineage: 2,
      lineages: { "1": { runs: 2 } },
      auth: au,
      active: { n: 5, base: M, head: sha("q5"), depth: 0, prs: [1, 2], lineage: 1, rerun: [{ runId: 9, attempt: 1 }], rerunAt: "2026-10-21T11:40:00.000Z", cancels: [], builtAt: "2026-10-21T11:30:00.000Z", redJobs: [{ name: "Unit", url: "u", id: 77 }] },
    };
    // #2 was pushed to after the batch was built: revalidation drops it.
    const live = { "1": prs[0]!, "2": livePr(2, { head: sha("moved") }) };
    const snap = { now: new Date("2026-10-21T12:00:00Z"), paused: false, main: M, policyHash: "policy-1", prs: live, ci: green, mainFailedJobs: null, pinReachable: {}, flakyTests: { "77": ["tests/a.py::t"] } };
    const d = decide(state, snap, cfg());
    const outcomes = d.state.history.map((h) => h.outcome);
    expect(outcomes).toContain("flaky");
    expect(outcomes.indexOf("flaky")).toBe(0);
    expect(d.state.outbox.some((o) => o.kind === "flaky")).toBe(true);
  });
});
