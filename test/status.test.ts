// The operator status view (src/status.ts, src/status-render.ts,
// src/status-cli.ts, src/operator.ts, src/github/operator-client.ts): projection from the
// state documents, issues and Actions runs, the text and JSON outputs, the
// watch loop, and that nothing it does writes anywhere.

import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { connectOperatorSources } from "../src/github/operator-client";
import { QUEUE_JOB_NAME } from "../src/job-names";
import { emptyReleaseState, type ReleaseState } from "../src/release-state";
import { emptyState, type State } from "../src/state";
import { median, projectStatus, usualDuration } from "../src/status";
import { gatherStatus, MIN_WATCH_SECONDS, parseStatusArgs, statusCommand } from "../src/status-cli";
import type { OperatorSources } from "../src/operator";
import { plain, renderStatusText } from "../src/status-render";
import { FakeStateRef, FakeTarget } from "./fake-github";
import { NAMES, sha } from "./sim";
import { ago, FakeRepo, NOW, run } from "./watchdog-fake";

const CFG = { names: NAMES, preLanding: defaultConfig.preLanding, windowBudget: defaultConfig.windowBudget, windowHours: defaultConfig.windowHours };
const SERVER = "https://github.com";
const CONTROL = `${NAMES.control.owner}/${NAMES.control.name}`;
const TARGET = `${NAMES.target.owner}/${NAMES.target.name}`;
const CI = defaultConfig.preLanding[0]!.path;

function auth(head: string, admittedMinAgo: number, extra: Partial<State["auth"][string]> = {}): State["auth"][string] {
  return { head, baseRepoId: NAMES.target.id, policy: "p", policyPr: false, admittedAt: ago(admittedMinAgo), labelledAt: ago(admittedMinAgo + 1), evidence: [], reviewRun: null, ...extra };
}

/** A queue in mid-flight: a running tick, a batch under test, a split half, a solo PR, a queued PR, a bounce and a landed PR. */
function busyState(): State {
  return {
    ...emptyState(),
    seq: 42,
    nextLineage: 9,
    lineages: { "6": { runs: 1 }, "7": { runs: 2 }, "8": { runs: 1 } },
    lease: { owner: "run-77-1-abc", until: ago(-8), acquiredAt: ago(2), executor: { runId: 77, attempt: 1, job: QUEUE_JOB_NAME } },
    active: { n: 12, base: sha("main"), head: sha("q12"), depth: 0, prs: [101, 102], lineage: 8, rerun: null, rerunAt: null, cancels: [], builtAt: ago(25) },
    auth: { "101": auth(sha("h101"), 60), "102": auth(sha("h102"), 50, { priority: { by: "operator", at: ago(49) } }), "103": auth(sha("h103"), 40), "104": auth(sha("h104"), 30), "105": auth(sha("h105"), 10) },
    pending: [{ prs: [103], depth: 1, lineage: 7 }],
    solo: [{ pr: 104, lineage: 6, reason: "policy" }],
    operatorSolo: [104],
    window: [{ at: ago(60), cost: 1 }, { at: ago(30), cost: 2 }, { at: ago(60 * 30), cost: 5 }],
    bounceStreak: 1,
    lastLandedAt: ago(90),
    verify: [{ pr: 99, pin: sha("h99"), landedIn: sha("m99"), since: ago(90), ticks: 1, notified: false }],
    history: [
      { n: 10, at: ago(200), outcome: "landed", prs: [99], head: sha("q10"), note: "main a -> b" },
      { n: 11, at: ago(120), outcome: "bounced", prs: [98], head: sha("q11"), note: "required checks failed", failedJobs: [{ name: "unit", url: `${SERVER}/${TARGET}/actions/runs/5/job/6` }] },
    ],
  };
}

function world(state: State | null = busyState(), release: ReleaseState | null = null) {
  const queueRef = new FakeStateRef();
  queueRef.clock = () => NOW;
  if (state) queueRef.current = { version: sha("v42"), text: JSON.stringify(state) };
  const releaseRef = new FakeStateRef();
  if (release) releaseRef.current = { version: sha("rv"), text: JSON.stringify(release) };
  const control = new FakeRepo();
  control.runs = [run({ createdAt: ago(3), event: "workflow_dispatch" }), run({ createdAt: ago(8) }), run({ createdAt: ago(1), branch: "feature" })];
  const target = new FakeTarget("read");
  for (const n of [101, 102, 103, 104, 105]) target.addPr(n, { title: `change ${n}` });
  const q12 = `${NAMES.queuePrefix}12`;
  target.addRun({ head_sha: sha("q12"), head_branch: q12, path: CI, status: "in_progress", conclusion: null });
  target.addRun({ head_sha: sha("other"), head_branch: q12, path: CI });
  let spanReads = 0;
  const spans = [10, 20, 30].map((m) => ({ startedAt: ago(m + 100), finishedAt: ago(100) }));
  const src: OperatorSources = {
    queueState: queueRef,
    releaseState: releaseRef,
    control,
    target,
    recentQueueSpans: async () => {
      spanReads++;
      return spans;
    },
  };
  return { src, queueRef, releaseRef, control, target, spanReads: () => spanReads };
}

const gather = (src: OperatorSources, titles = new Map<number, string>()) => gatherStatus(src, CFG, { serverUrl: SERVER, now: () => NOW, titles });

describe("projection", () => {
  test("a busy queue: lease, active batch with its CI, pending, solo, queued with waits, bounces, budget", async () => {
    const w = world();
    w.control.seed("hold on", [NAMES.watchdogLabels.alert], 15);
    const s = projectStatus(await gather(w.src));
    expect(s.at).toBe(NOW.toISOString());
    expect(s.queueSummary).toBe("testing");
    expect(s.queueState).toEqual({ kind: "ok", seq: 42, version: sha("v42") });
    expect(s.lease).toEqual({
      owner: "run-77-1-abc",
      acquiredAt: ago(2),
      ageMs: 2 * 60_000,
      until: ago(-8),
      expiresInMs: 8 * 60_000,
      executor: { runId: 77, attempt: 1, job: QUEUE_JOB_NAME, url: `${SERVER}/${CONTROL}/actions/runs/77/attempts/1` },
    });
    const a = s.active!;
    expect(a.ref).toBe(`${NAMES.queuePrefix}12`);
    expect(a.elapsedMs).toBe(25 * 60_000);
    expect(a.usualMs).toBe(20 * 60_000);
    expect(a.usualOver).toBe(3);
    expect(a.prs.map((p) => [p.pr, p.title, p.waitMs, p.priorityBy])).toEqual([
      [101, "change 101", 60 * 60_000, null],
      [102, "change 102", 50 * 60_000, "operator"],
    ]);
    expect(a.runs).toHaveLength(1); // the run at another sha on the same ref is not this batch's
    expect(a.runs[0]).toMatchObject({ path: CI, status: "in_progress", conclusion: null });
    expect(a.runs[0]!.url).toStartWith(`${SERVER}/${TARGET}/actions/runs/`);
    expect(s.pending.map((p) => p.prs.map((x) => x.pr))).toEqual([[103]]);
    expect(s.solo).toEqual([{ pr: expect.objectContaining({ pr: 104 }), reason: "policy" }]);
    expect(s.queued.map((p) => [p.pr, p.waitMs])).toEqual([[105, 10 * 60_000]]);
    expect(s.operatorSolo).toEqual([104]);
    expect(s.verifying).toEqual([{ pr: 99, landedIn: sha("m99"), ageMs: 90 * 60_000 }]);
    expect(s.bounces).toEqual([{ n: 11, at: ago(120), ageMs: 120 * 60_000, outcome: "bounced", prs: [98], note: "required checks failed", failedJobs: [{ name: "unit", url: `${SERVER}/${TARGET}/actions/runs/5/job/6` }] }]);
    expect(s.counters).toMatchObject({ windowUsed: 3, windowBudget: CFG.windowBudget, bounceStreak: 1, lastLandedAgeMs: 90 * 60_000 });
    expect(s.paused).toEqual({ queue: false, release: false });
    expect(s.issues.alert.issues.map((i) => i.title)).toEqual(["hold on"]);
    expect(s.release).toEqual({ kind: "absent", reason: "release state branch absent" });
    expect(s.ticks.workflow).toBe("active");
    expect(s.ticks.recent.map((t) => t.ageMs)).toEqual([3 * 60_000, 8 * 60_000]); // the run off the control branch is not a tick
    expect(s.problems).toEqual([]);
  });

  test("further running batches (queue.concurrency) are listed, each with its stacking", async () => {
    const st = busyState();
    st.pending = [];
    st.concurrent = [{ n: 13, base: sha("q12"), head: sha("q13"), depth: 0, prs: [103], lineage: 9, rerun: null, rerunAt: null, cancels: [], builtAt: ago(5), on: 12 }];
    st.lineages["9"] = { runs: 1 };
    const s = projectStatus(await gather(world(st).src));
    expect(s.concurrent.map((b) => [b.n, b.on, b.prs.map((p) => p.pr)])).toEqual([[13, 12, [103]]]);
    expect(s.queued.map((p) => p.pr)).toEqual([105]);
    expect(renderStatusText(s)).toContain("also running: batch 13 on queue/13");
    expect(renderStatusText(s)).toContain("stacked on batch 12");
  });

  test("an open pause issue, or a pause the queue has queued in its outbox, means paused", async () => {
    const w = world();
    w.control.seed("maintenance", [NAMES.controlLabels.pause], 30);
    const s = projectStatus(await gather(w.src));
    expect(s.queueSummary).toBe("paused");
    expect(s.paused.queue).toBe(true);
    expect(s.issues.pause.issues).toEqual([{ number: 1, title: "maintenance", url: expect.any(String), ageMs: 30 * 60_000 }]);

    const st = { ...busyState(), outbox: [{ id: "p1", kind: "pause" as const, reason: "breaker" }] };
    const s2 = projectStatus(await gather(world(st).src));
    expect(s2.paused.queue).toBe(true);
    expect(s2.outbox).toEqual([{ id: "p1", kind: "pause", pr: null }]);
  });

  test("an incomplete or failed pause listing is unknown, which the tick counts as paused", async () => {
    const w = world();
    w.control.incomplete.add(NAMES.controlLabels.pause);
    w.control.failing.add(NAMES.releaseLabels.pause);
    const s = projectStatus(await gather(w.src));
    expect(s.paused).toEqual({ queue: null, release: null });
    expect(s.queueSummary).toBe("paused");
    expect(s.problems.join("\n")).toContain(`'${NAMES.controlLabels.pause}' issues were listed incompletely`);
    expect(s.problems.join("\n")).toContain(`could not list the open '${NAMES.releaseLabels.pause}' issues`);
  });

  test("an unreadable state document leaves its pause unknown, even when no pause issue is open", async () => {
    const w = world();
    w.src.queueState = { read: () => Promise.reject(new Error("server (502)")) };
    w.releaseRef.current = { version: sha("rv"), text: "{bad" };
    const s = projectStatus(await gather(w.src));
    expect(s.paused).toEqual({ queue: null, release: null });
    expect(renderStatusText(s)).toContain("paused: queue unknown (counts as paused), release unknown (counts as paused)");
    // An absent release state branch holds no pending pause: the listing decides.
    const ok = projectStatus(await gather(world().src));
    expect(ok.paused).toEqual({ queue: false, release: false });
  });

  test("idle, waiting and landing", async () => {
    expect(projectStatus(await gather(world(emptyState()).src)).queueSummary).toBe("idle");
    const waiting = { ...emptyState(), auth: { "105": auth(sha("h105"), 10) } };
    expect(projectStatus(await gather(world(waiting).src)).queueSummary).toBe("waiting");
    const landing: State = {
      ...busyState(),
      journal: { seq: 43, op: { kind: "land", before: sha("main"), after: sha("q12") }, reserved: true, at: ago(1), checkpoint: null, tries: 0 },
    };
    const s = projectStatus(await gather(world(landing).src));
    expect(s.queueSummary).toBe("landing");
    expect(s.op).toEqual({ kind: "land", at: ago(1), ageMs: 60_000, tries: 0 });
  });

  test("a missing, corrupt or unreadable queue state is reported, never guessed", async () => {
    const absent = projectStatus(await gather(world(null).src));
    expect(absent.queueSummary).toBe("unknown");
    expect(absent.queueState).toEqual({ kind: "absent", reason: `the ${NAMES.stateBranch} branch does not exist` });
    expect(absent.active).toBeNull();

    const w = world();
    w.queueRef.current = { version: sha("bad"), text: "{not json" };
    const corrupt = projectStatus(await gather(w.src));
    expect(corrupt.queueState.kind).toBe("corrupt");
    expect(corrupt.problems[0]).toStartWith("queue state: state: not JSON");

    const w2 = world();
    w2.src.queueState = { read: () => Promise.reject(new Error("server (502): bad gateway")) };
    const err = projectStatus(await gather(w2.src));
    expect(err.queueState).toEqual({ kind: "error", reason: "server (502): bad gateway" });
    expect(err.at).toBe(NOW.toISOString()); // the reader's clock when GitHub's is not available
  });

  test("failed Actions reads and PR reads degrade to notes", async () => {
    const w = world();
    w.src.target = { listRuns: () => Promise.reject(new Error("rate_limit (403): slow down")), getPr: () => Promise.reject(new Error("not_found (404)")) };
    w.src.recentQueueSpans = () => Promise.reject(new Error("server (500)"));
    w.src.control = { ...w.control, listOpenIssues: w.control.listOpenIssues.bind(w.control), workflowState: () => Promise.reject(new Error("auth (403)")), listRecentRuns: () => Promise.reject(new Error("auth (403)")) };
    const s = projectStatus(await gather(w.src));
    expect(s.active!.runs).toEqual([]);
    expect(s.active!.runsNote).toBe("could not list: rate_limit (403): slow down");
    expect(s.active!.usualMs).toBeNull();
    expect(s.active!.prs[0]!.title).toBeNull();
    expect(s.ticks).toEqual({ workflow: null, error: "auth (403)", recent: [] });
    expect(s.problems).toHaveLength(4);
  });

  test("release: its state, a pending pause, and a corrupt document", async () => {
    const rel: ReleaseState = {
      ...emptyReleaseState(),
      seq: 5,
      pausePending: { id: "x", reason: "release moved" },
      last: { at: ago(4), kind: "none", reason: "main not qualified", release: sha("r1"), main: sha("m1") },
      history: [{ at: ago(300), outcome: "advanced", from: sha("r0"), to: sha("r1"), note: "", receipt: null }],
    };
    const s = projectStatus(await gather(world(busyState(), rel).src));
    expect(s.paused.release).toBe(true);
    expect(s.release).toEqual({
      kind: "ok",
      seq: 5,
      lease: null,
      op: null,
      pausePending: "release moved",
      last: { at: ago(4), ageMs: 4 * 60_000, kind: "none", reason: "main not qualified", release: sha("r1"), main: sha("m1") },
      lastHistory: { at: ago(300), outcome: "advanced", from: sha("r0"), to: sha("r1"), note: "" },
    });
    const w = world();
    w.releaseRef.current = { version: sha("rv"), text: JSON.stringify({ v: 9 }) };
    const bad = projectStatus(await gather(w.src));
    expect(bad.release.kind).toBe("corrupt");
    expect(bad.problems.some((p) => p.startsWith("release state:"))).toBe(true);
  });

  test("the usual duration is the median of the newest spans", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    const spans = Array.from({ length: 25 }, (_, i) => ({ startedAt: ago(1000 - i), finishedAt: ago(1000 - i - (i < 5 ? 100 : 10)) }));
    expect(usualDuration(spans)).toEqual({ ms: 10 * 60_000, over: 20 }); // the five oldest (100m) fall outside the newest twenty
    expect(usualDuration([{ startedAt: "garbage", finishedAt: ago(1) }, { startedAt: ago(1), finishedAt: ago(2) }])).toEqual({ ms: null, over: 0 });
  });
});

describe("rendering", () => {
  test("text names every section", async () => {
    const w = world();
    w.control.seed("maintenance", [NAMES.controlLabels.pause], 30);
    const text = renderStatusText(projectStatus(await gather(w.src)));
    expect(text).toContain("qlander status: PAUSED");
    expect(text).toContain(`[${NAMES.controlLabels.pause}] #1 maintenance (open 30m)`);
    expect(text).toContain(`lease: run-77-1-abc, held 2m, expires in 8m  ${SERVER}/${CONTROL}/actions/runs/77/attempts/1`);
    expect(text).toContain(`active batch 12 on ${NAMES.queuePrefix}12`);
    expect(text).toContain("elapsed 25m (usual 20m: median of the last 3 green CI runs on queue refs)");
    expect(text).toContain("#102 change 102  (waiting 50m)  [priority by operator]");
    expect(text).toContain("queued (oldest first):\n  #105 change 105  (waiting 10m)");
    expect(text).toContain("failed: unit");
    expect(text).toContain("release: release state branch absent");
    expect(text).toContain("budget: 3/");
  });

  test("untrusted text cannot reach the terminal as control sequences", async () => {
    expect(plain("a\x1b[2Jb\nc\u2028d\u009be")).toBe("a [2Jb c d e");
    expect(plain("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
    const w = world();
    w.target.prs.get(101)!.pr.title = "evil\x1b]0;owned\x07\r\nlanded";
    const text = renderStatusText(projectStatus(await gather(w.src)));
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(text).toContain("#101 evil ]0;owned landed");
  });

  test("the JSON form round-trips the Status", async () => {
    const s = projectStatus(await gather(world().src));
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });
});

describe("the command", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (t: string) => out.push(t), err: (l: string) => err.push(l) } };
  };

  test("arguments", () => {
    expect(parseStatusArgs([])).toMatchObject({ json: false, watch: null });
    expect(parseStatusArgs(["--json", "--watch", "30"])).toMatchObject({ json: true, watch: 30 });
    expect(parseStatusArgs(["--watch", "1"]).watch).toBe(MIN_WATCH_SECONDS);
    expect(() => parseStatusArgs(["--watch"])).toThrow();
    expect(() => parseStatusArgs(["--watch", "-5"])).toThrow();
    expect(() => parseStatusArgs(["--json", "--json"])).toThrow();
    expect(() => parseStatusArgs(["--bogus"])).toThrow();
  });

  test("usage errors exit 2; a missing token exits 3 before anything is read", async () => {
    const a = io();
    expect(await statusCommand(["--nope"], a.io, { env: {} })).toBe(2);
    const b = io();
    let connected = false;
    expect(await statusCommand([], b.io, { env: {}, connect: async () => ((connected = true), world().src) })).toBe(3);
    expect(b.err.join("\n")).toContain("GH_TOKEN");
    expect(connected).toBe(false);
  });

  test("one pass prints text; GH_TOKEN wins over GITHUB_TOKEN and is never printed", async () => {
    const a = io();
    const w = world();
    let token = "";
    const code = await statusCommand([], a.io, { env: { GH_TOKEN: "tok-a", GITHUB_TOKEN: "tok-b" }, now: () => NOW, connect: async (_c, h) => ((token = h.token), w.src) });
    expect(code).toBe(0);
    expect(token).toBe("tok-a");
    expect(a.out).toHaveLength(1);
    expect(a.out[0]).toStartWith("qlander status: TESTING");
    expect([...a.out, ...a.err].join("\n")).not.toContain("tok-");
  });

  test("--watch re-reads on the interval, as JSON lines, reading each title once", async () => {
    const a = io();
    const w = world();
    const sleeps: number[] = [];
    const code = await statusCommand(["--json", "--watch", "15"], a.io, { env: { GITHUB_TOKEN: "t" }, now: () => NOW, connect: async () => w.src, sleep: async (ms) => void sleeps.push(ms), maxPasses: 3 });
    expect(code).toBe(0);
    expect(sleeps).toEqual([15_000, 15_000]);
    expect(a.out).toHaveLength(3);
    for (const line of a.out) {
      expect(line.trimEnd()).not.toContain("\n");
      expect(JSON.parse(line).queueSummary).toBe("testing");
    }
    expect(w.target.calls.filter((c) => c === "getPr 101")).toHaveLength(1);
    expect(w.spanReads()).toBe(3);
  });

  test("the token never reaches the output, even quoted in an error, and a malformed token is refused", async () => {
    const a = io();
    const code = await statusCommand([], a.io, { env: { GH_TOKEN: "ghp_SECRET123" }, connect: () => Promise.reject(new Error("Header 'Authorization' has invalid value: 'Bearer ghp_SECRET123'")) });
    expect(code).toBe(3);
    expect(a.err.join("\n")).not.toContain("ghp_SECRET123");
    expect(a.err.join("\n")).toContain("Bearer [token]");
    const b = io();
    let connected = false;
    expect(await statusCommand([], b.io, { env: { GH_TOKEN: "ghp_SECRET\nWRAPPED" }, connect: async () => ((connected = true), world().src) })).toBe(3);
    expect(connected).toBe(false);
    expect(b.err.join("\n")).not.toContain("ghp_SECRET");
  });

  describe("the exit code", () => {
    const pass = async (args: string[], w: ReturnType<typeof world>) => {
      const a = io();
      const code = await statusCommand(args, a.io, { env: { GH_TOKEN: "t" }, now: () => NOW, connect: async () => w.src, sleep: async () => {}, maxPasses: 2 });
      return { code, out: a.out };
    };
    const failing = () => Promise.reject(new Error("server (500): boom"));

    test("every read failing exits 3, and still prints the view with its problems, as JSON and as text", async () => {
      const w = world();
      w.src.queueState = { read: failing };
      w.src.releaseState = { read: failing };
      w.src.target = { listRuns: failing, getPr: failing };
      w.src.recentQueueSpans = failing;
      w.src.control = { listOpenIssues: failing, workflowState: failing, listRecentRuns: failing } as unknown as typeof w.src.control;
      const json = await pass(["--json"], w);
      expect(json.code).toBe(3);
      const doc = JSON.parse(json.out[0]!);
      expect(doc.complete).toBe(false);
      expect(doc.queueSummary).toBe("unknown");
      expect(doc.problems.length).toBeGreaterThan(5);
      const text = await pass([], w);
      expect(text.code).toBe(3);
      expect(text.out[0]).toContain("could not check:");
    });

    test("one failed or incomplete read exits 3", async () => {
      const w = world();
      w.control.failing.add(NAMES.watchdogLabels.alert);
      expect((await pass(["--json"], w)).code).toBe(3);
      const w2 = world();
      w2.control.incomplete.add(NAMES.releaseLabels.alert);
      expect((await pass([], w2)).code).toBe(3);
      const w3 = world();
      w3.src.target = { ...w3.target, getPr: w3.target.getPr.bind(w3.target), listRuns: async () => ({ items: [], truncated: true }) } as typeof w3.src.target;
      expect((await pass([], w3)).code).toBe(3);
    });

    test("a corrupt state document exits 3", async () => {
      const w = world();
      w.queueRef.current = { version: sha("bad"), text: "{not json" };
      expect((await pass(["--json"], w)).code).toBe(3);
    });

    test("a paused queue exits 0: that is a state, not a failed read", async () => {
      const w = world();
      w.control.issues.push({ number: 7, title: "pause", body: "", labels: [NAMES.controlLabels.pause], open: true } as never);
      const r = await pass(["--json"], w);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out[0]!).paused.queue).toBe(true);
    });

    test("a bad release state is shown, but counts only while release advance is on", async () => {
      const w = world();
      w.releaseRef.current = { version: sha("bad"), text: "{not json" };
      const on = projectStatus(await gatherStatus(w.src, CFG, { serverUrl: SERVER, now: () => NOW, titles: new Map(), releaseEnabled: true }));
      expect(on.complete).toBe(false);
      const off = projectStatus(await gatherStatus(w.src, CFG, { serverUrl: SERVER, now: () => NOW, titles: new Map(), releaseEnabled: false }));
      expect(off.complete).toBe(true);
      expect(off.problems.some((p) => p.startsWith("release state:"))).toBe(true);
      w.control.failing.add(NAMES.controlLabels.pause);
      expect(projectStatus(await gatherStatus(w.src, CFG, { serverUrl: SERVER, now: () => NOW, titles: new Map(), releaseEnabled: false })).complete).toBe(false);
    });

    test("a tick workflow response with no state is not an answer", async () => {
      const w = world();
      w.src.control = { ...w.control, listOpenIssues: w.control.listOpenIssues.bind(w.control), listRecentRuns: w.control.listRecentRuns.bind(w.control), workflowState: async () => undefined as unknown as string } as typeof w.src.control;
      expect((await pass(["--json"], w)).code).toBe(3);
    });

    test("a state branch that does not exist yet exits 0, and problems still names it", async () => {
      const r = await pass(["--json"], world(null));
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.out[0]!);
      expect(doc.queueState.kind).toBe("absent");
      expect(doc.complete).toBe(true);
      expect(doc.problems).toHaveLength(1);
    });

    test("a state branch that does not exist does not hide another failed read", async () => {
      const w = world(null);
      w.control.failing.add(NAMES.controlLabels.pause);
      expect((await pass(["--json"], w)).code).toBe(3);
    });

    test("--watch keeps running through a failed read, and shows it in each pass", async () => {
      const w = world();
      w.control.failing.add(NAMES.controlLabels.pause);
      const r = await pass(["--json", "--watch", "15"], w);
      expect(r.code).toBe(0);
      expect(r.out).toHaveLength(2);
      for (const l of r.out) expect(JSON.parse(l).complete).toBe(false);
    });
  });

  test("a failed connection exits 3 with the reason", async () => {
    const a = io();
    const code = await statusCommand([], a.io, { env: { GH_TOKEN: "t" }, connect: () => Promise.reject(new Error("auth (401): Bad credentials")) });
    expect(code).toBe(3);
    expect(a.err).toEqual(["could not connect: auth (401): Bad credentials"]);
  });

  test("it never writes: no state commit, no issue change, no target call but reads", async () => {
    const w = world();
    await statusCommand(["--watch", "10"], io().io, { env: { GH_TOKEN: "t" }, now: () => NOW, connect: async () => w.src, sleep: async () => {}, maxPasses: 2 });
    expect(w.queueRef.writes).toBe(0);
    expect(w.releaseRef.writes).toBe(0);
    expect(w.control.writes).toEqual([]);
    expect(w.target.calls.every((c) => c.startsWith("getPr "))).toBe(true);
    expect(w.target.posted).toEqual([]);
  });
});

describe("the real sources", () => {
  test("make only GET requests and GraphQL queries (never a mutation), and the usual duration reads only green runs on queue refs", async () => {
    const seen: { method: string; url: string; body?: string }[] = [];
    const repo = (r: { id: number }) => Response.json({ id: r.id, node_id: `R_${r.id}` });
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ method: init?.method ?? "GET", url });
      if (url.endsWith(`/repos/${CONTROL}`)) return repo(NAMES.control);
      if (url.endsWith(`/repos/${TARGET}`)) return repo(NAMES.target);
      if (url.endsWith("/graphql")) {
        seen[seen.length - 1]!.body = String(init?.body ?? "");
        return Response.json({ data: { repository: { issues: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
      }
      if (url.includes("/actions/workflows/")) {
        return Response.json({
          workflow_runs: [
            { head_branch: `${NAMES.queuePrefix}3`, run_started_at: ago(30), updated_at: ago(10) },
            { head_branch: NAMES.main, run_started_at: ago(30), updated_at: ago(29) },
            { head_branch: `${NAMES.queuePrefix}4`, run_started_at: ago(20), updated_at: null },
          ],
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const src = await connectOperatorSources(CFG, { token: "t", fetch, readAttempts: 1 });
    expect(await src.recentQueueSpans()).toEqual([{ startedAt: ago(30), finishedAt: ago(10) }]);
    const runs = seen.find((r) => r.url.includes("/actions/workflows/"))!.url;
    expect(runs).toContain("event=push");
    expect(runs).toContain("status=success");
    expect(await src.control.listOpenIssues(NAMES.controlLabels.pause)).toEqual({ issues: [], complete: true });
    const posts = seen.filter((r) => r.method !== "GET");
    expect(posts.length).toBeGreaterThan(0);
    for (const r of posts) {
      expect(r.url).toEndWith("/graphql");
      expect(JSON.parse(r.body!).query).not.toMatch(/\bmutation\b/);
    }
  });
});

describe("bun src/cli.ts status", () => {
  const cliIo = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), read: () => null, write: () => {} } };
  };

  test("is a command: its usage errors exit 2, and a missing token exits 3 before any read", async () => {
    const { main, USAGE } = await import("../src/cli");
    expect(USAGE).toContain("status [--json] [--watch <seconds>]");
    const a = cliIo();
    expect(await main(["status", "--bogus"], a.io, {})).toBe(2);
    expect(a.err[0]).toBe("unexpected argument --bogus");
    const b = cliIo();
    expect(await main(["status"], b.io, {})).toBe(3);
    expect(b.err.join("\n")).toContain("GH_TOKEN or GITHUB_TOKEN");
  });
});
