// The lease and fencing (DESIGN.md §15), storage initialisation, and the
// bounded reconciliations.

import { describe, expect, test } from "bun:test";
import { defaultConfig, invariantProblems } from "../src/config";
import { GitHubError } from "../src/github/http";
import { applyOpResult } from "../src/ops";
import { makeRunId } from "../src/queue";
import { classify } from "../src/classify";
import { decide } from "../src/machine";
import { emptyState, parseState, renderState, type State } from "../src/state";
import { TARGET, cfg, job, livePr, NAMES, run, sha, Sim } from "./sim";
import { World } from "./world";
import { FakeTarget, FakeStateRef, FakeStateRepo } from "./fake-github";
import { runQueue } from "../src/main";

const reruns = (w: World) => w.target.calls.filter((c) => c.startsWith("rerun")).length;

describe("P1-a: an executor cannot outlive its lease", () => {
  test("Reproduction: A stalls before its main CAS, B takes over and abandons; A's land is fenced off", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    const read = w.stateRef.read.bind(w.stateRef);
    let tookOver = false;
    w.stateRef.read = async () => {
      const r = await read();
      // The first read that sees A's land journal is A's fence before updateRef.
      // A stalls right there, past its lease; meanwhile the PR is unreadied and B takes over.
      if (!tookOver && r && r.text.includes('"kind": "land"') && r.text.includes('"owner": "A"')) {
        tookOver = true;
        w.now = new Date(w.now.getTime() + 9 * 60_000);
        const p = w.target.prs.get(1)!.pr;
        p.labels = p.labels.filter((l) => l !== "ready");
        await w.tick({ runId: "B" });
        return read(); // what A's fence now sees
      }
      return r;
    };
    const a = await w.tick({ runId: "A" });
    expect(tookOver).toBe(true);
    expect(a === "crashed" ? a : a.outcome).toBe("lost-lock");
    expect(w.mainHistory).toHaveLength(1); // main never moved
    expect(w.target.calls.filter((c) => c.startsWith("updateRef main"))).toEqual([]);
  });

  test("the runner's own clock is never used: a runner skewed an hour ahead still sees the live lease", async () => {
    const w = new World();
    w.readyPr(1);
    let inner = null as string | null;
    w.stateRef.beforeCas = async () => {
      if (inner !== null || !w.stateRef.current?.text.includes('"owner": "A"')) return;
      inner = "pending";
      const r = await w.tick({ runId: "B", skewMinutes: 60 });
      inner = r === "crashed" ? r : r.outcome;
    };
    await w.tick({ runId: "A" });
    expect(inner).toBe("busy");
  });

  test("no same-owner bypass: a second execution with the same run id is busy too", async () => {
    const w = new World();
    let inner = null as string | null;
    w.stateRef.beforeCas = async () => {
      if (inner !== null || !w.stateRef.current?.text.includes('"owner": "same"')) return;
      inner = "pending";
      const r = await w.tick({ runId: "same" });
      inner = r === "crashed" ? r : r.outcome;
    };
    await w.tick({ runId: "same" });
    expect(inner).toBe("busy");
  });

  test("run ids are unique per execution: run id, attempt, and a random part", () => {
    const a = makeRunId({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" });
    const b = makeRunId({ GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "2" });
    expect(a).toMatch(/^123\.2\.[A-Za-z0-9]{8}$/);
    expect(a).not.toBe(b);
    expect(makeRunId({ GITHUB_RUN_ID: "x; rm", GITHUB_RUN_ATTEMPT: "-1" }, () => "abcdef12")).toBe("local.0.abcdef12");
  });

  test("the hard invariant: the job dies before its lease can pass on", () => {
    expect(invariantProblems(defaultConfig)).toEqual([]);
    expect(defaultConfig.jobTimeoutMinutes).toBeLessThanOrEqual(defaultConfig.leaseMinutes - defaultConfig.fenceMarginMinutes);
    expect(invariantProblems({ ...defaultConfig, jobTimeoutMinutes: 7 }).join(" ")).toContain("jobTimeoutMinutes");
    expect(invariantProblems({ ...defaultConfig, leaseMinutes: 12, jobTimeoutMinutes: 5 }).join(" ")).toContain("cron");
  });

  test("a runner refuses to start with a config that breaks the invariant", async () => {
    const w = new World(() => "pass", { jobTimeoutMinutes: 9 });
    await expect(w.tick()).rejects.toThrow("refusing to run");
  });
});

describe("P1-b: never initialise over existing state", () => {
  const oldState = (): State => ({
    ...emptyState(),
    seq: 4,
    auth: { "1": { head: sha("pr1"), baseRepoId: TARGET, policy: "p", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: null } },
    active: { n: 2, base: sha("b"), head: sha("q"), depth: 0, prs: [1], lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T10:00:00.000Z" },
    lineages: { "1": { runs: 1 } },
    window: [{ at: "2026-10-21T10:00:00.000Z", cost: 1 }],
  });

  test("the ref is missing and the state issue holds a batch: pause, do not reset", async () => {
    const w = new World();
    await w.repo.createIssue("qlander state", `<!-- qlander-mirror-rev: 7 writer: run-3 -->\n${renderState(oldState())}`, ["qlander-state"]);
    expect(await w.tick()).toMatchObject({ outcome: "paused" });
    expect(w.repo.issues.filter((i) => i.labels.includes("pause")).map((i) => i.body).join(" ")).toContain("refusing to initialise");
    expect(w.stateRef.current).toBeNull();
    expect(w.repo.issues[0]!.body).toContain('"seq": 4'); // the issue is left as it was
  });

  test("an issue with an empty state (or none) initialises normally", async () => {
    const w = new World();
    await w.repo.createIssue("qlander state (mirror)", renderState(emptyState()), ["qlander-state"]);
    w.readyPr(1);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });
});

describe("rerun barrier is bounded; ambiguous reruns are never resent or refunded", () => {
  test("the rerun run was deleted after its receipt: a pause after the bound, not pending forever", async () => {
    const w = new World((b) => (b.attempt === 1 ? "fail" : "hang"));
    w.readyPr(1);
    await w.untilBuilt();
    for (let i = 0; i < 6 && !w.state().active?.rerun; i++) await w.tick();
    const rerun = w.state().active!.rerun!;
    w.target.runs = w.target.runs.filter((r) => r.id !== rerun[0]!.runId);
    for (let i = 0; i < 12 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    expect(w.repo.issues.filter((i) => i.labels.includes("pause")).map((i) => i.body).join(" ")).toContain("deleted or superseded");
  });

  test("#2: a lost response with stale getRun forever: exactly one request, then a pause, never a resend", async () => {
    const w = new World(() => "fail");
    w.readyPr(1);
    await w.untilBuilt();
    const rerun = w.target.rerunFailedJobs.bind(w.target);
    const getRun = w.target.getRun.bind(w.target);
    w.target.rerunFailedJobs = async (id) => {
      await rerun(id);
      throw new GitHubError("server", 502, "lost");
    };
    w.target.getRun = async (id) => {
      const r = await getRun(id);
      return r ? { ...r, run_attempt: 1 } : r; // never shows the new attempt
    };
    for (let i = 0; i < 12 && !w.paused(); i++) await w.tick();
    expect(reruns(w)).toBe(1);
    expect(w.paused()).toBe(true);
    expect(w.pauseReasons().join(" ")).toContain("not confirmed");
  });

  test("a rerun that may have been sent is never refunded", () => {
    const two = { kind: "red" as const, policy: false, failedRuns: [{ runId: 1, attempt: 1 }], failedJobs: [], reason: "x" };
    const sim = new Sim(cfg(), () => two).add(livePr(1));
    sim.tick(); // build
    sim.state = decide(sim.state, sim.snapshot(), sim.config).state; // journals the rerun (reserved)
    const before = structuredClone(sim.state);
    let s = applyOpResult(sim.state, { kind: "rerunSending", run: { runId: 1, attempt: 1 }, at: sim.now.toISOString() }, cfg(), sim.now).state;
    s = applyOpResult(s, { kind: "opAbandoned", reason: "not confirmed" }, cfg(), sim.now).state;
    expect(s.lineages).toEqual(before.lineages);
    expect(s.window).toEqual(before.window);
    // The flag is the backstop even when no request is listed any more.
    const bare = structuredClone(before);
    bare.journal = { ...bare.journal!, op: { kind: "rerun", runs: [{ runId: 1, attempt: 1 }], done: [], requested: [], everSent: true } };
    const after = applyOpResult(bare, { kind: "opAbandoned", reason: "x" }, cfg(), sim.now).state;
    expect(after.lineages).toEqual(before.lineages);
    expect(after.window).toEqual(before.window);
  });
});

describe("#5: the attempt barrier comes before the timeout check", () => {
  test("a stale attempt-1 view with old job start times is pending, not timed out", () => {
    const Q = sha("qh");
    const r = run({ id: 100, head_branch: "queue/9", head_sha: Q, status: "in_progress", conclusion: null, run_attempt: 1, created_at: "2026-10-21T06:00:00Z" });
    const c = classify({
      now: new Date("2026-10-21T12:00:00Z"),
      builtAt: "2026-10-21T06:00:00.000Z",
      queueBranch: "queue/9",
      head: Q,
      repoId: TARGET,
      manifest: [{ path: ".github/workflows/ci.yml", name: "CI", when: "always", required_jobs: ["Test"], allow_skipped_jobs: {} }],
      runs: [r],
      jobsByRun: { "100": [{ ...job("Test", null, "in_progress", "2026-10-21T06:05:00Z"), run_attempt: 1 }] },
      cancels: [],
      expect: [{ runId: 100, attempt: 1 }],
      expectSince: "2026-10-21T11:50:00.000Z",
      hasPolicyPr: false,
      limits: { noRunMinutes: 15, inProgressMinutes: 150, queuedHours: 6, rerunBarrierMinutes: 60 },
    });
    expect(c.kind).toBe("pending");
  });
});

describe("#8: a comment is sent at most once", () => {
  test("the response is lost and the list never shows it: one post, then delivery is uncertain, never a loop", async () => {
    const w = new World();
    w.target.commentLag = 1000;
    w.readyPr(1);
    const comment = w.target.comment.bind(w.target);
    w.target.comment = async (n, body) => {
      await comment(n, body);
      throw new GitHubError("server", 502, "lost");
    };
    for (let i = 0; i < 20; i++) await w.tick();
    const bodies = w.target.posted.map((p) => p.body);
    expect(new Set(bodies).size).toBe(bodies.length);
    expect(w.state().outbox.filter((n) => n.kind === "comment")).toEqual([]);
  });
});

describe("#9: cancellation keeps every run it saw until it is terminal", () => {
  test("a run revealed after the 30-minute window is still cancelled", async () => {
    const w = new World(() => "hang");
    w.target.listLag = 5; // visible only after 50 minutes
    for (const n of [1, 2]) w.readyPr(n);
    await w.tick();
    for (let i = 0; i < 8 && !w.target.calls.some((c) => c.startsWith("createRef queue/")); i++) await w.tick();
    w.target.push(2); // abandon before the run is visible
    const first = () => w.target.runs.find((r) => r.head_branch?.startsWith("queue/"));
    for (let i = 0; i < 20 && first()?.conclusion !== "cancelled"; i++) await w.tick();
    expect(first()!.conclusion).toBe("cancelled");
  });

  test("a run that will not stop: reconciled for hours, then a pause", async () => {
    const w = new World(() => "hang");
    for (const n of [1, 2]) w.readyPr(n);
    await w.untilBuilt();
    w.target.cancelRun = async () => {}; // accepted, but the run keeps going
    w.target.push(2);
    for (let i = 0; i < 45 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    expect(w.pauseReasons().join(" ")).toContain("still running");
  });
});

describe("the entry point", () => {
  const LS = defaultConfig.names.control.id;

  test("each execution runs under a fresh run id from makeRunId, and only for a valid event", async () => {
    const stateRef = new FakeStateRef();
    const owners: string[] = [];
    stateRef.beforeCas = () => {
      const m = /"owner": "([^"]+)"/.exec(stateRef.current?.text ?? "");
      if (m) owners.push(m[1]!);
    };
    const clients = { target: new FakeTarget(), repo: new FakeStateRepo(), stateRef };
    const env = { GITHUB_RUN_ID: "777", GITHUB_RUN_ATTEMPT: "3", GITHUB_EVENT_NAME: "schedule" };
    await runQueue(env, { repository: { id: LS } }, async () => clients);
    await runQueue(env, { repository: { id: LS } }, async () => clients);
    const distinct = [...new Set(owners)];
    expect(distinct.length).toBe(2);
    for (const o of distinct) expect(o).toMatch(/^777\.3\.[A-Za-z0-9]{8}$/);
    await expect(runQueue({ ...env, GITHUB_EVENT_NAME: "push" }, { repository: { id: LS } }, async () => clients)).rejects.toThrow("refusing event");
    await expect(runQueue(env, { repository: { id: 1 } }, async () => clients)).rejects.toThrow("not from the qlander repository");
  });
});

describe("last-round remainders", () => {
  test("a write that exceeds its deadline is aborted and reported as an ambiguous network error", async () => {
    const { Http } = await import("../src/github/http");
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const http = new Http({ token: "t", fetch: hang, writeTimeoutMs: 20, readTimeoutMs: 20, sleep: async () => {} });
    const e = await http.request("POST", "x").catch((x) => x);
    expect(e).toMatchObject({ kind: "network" });
    expect(String(e)).toContain("deadline");
  });

  test("the default write deadline sits well inside the fence margin", async () => {
    const { WRITE_TIMEOUT_MS } = await import("../src/github/http");
    expect(WRITE_TIMEOUT_MS).toBeLessThan((defaultConfig.fenceMarginMinutes * 60_000) / 2);
  });

  test("P1-b: a labelled state issue without the marker blocks initialisation", async () => {
    const w = new World();
    // A state issue whose fenced block marker was removed by hand: not verifiably empty.
    await w.repo.createIssue("qlander state", JSON.stringify({ v: 3, seq: 4, active: { n: 2 } }), ["qlander-state"]);
    expect(await w.tick()).toMatchObject({ outcome: "paused" });
    expect(w.stateRef.current).toBeNull();
    expect(w.repo.issues.filter((i) => i.labels.includes("pause")).map((i) => i.body).join(" ")).toContain("refusing to initialise");
  });

  test("#9: a run discovered once is remembered even if the cancel fails and the list then loses it", async () => {
    const { drain } = await import("../src/outbox");
    const target = new FakeTarget();
    const r = target.addRun({ head_sha: sha("qh"), head_branch: "queue/9", status: "in_progress", conclusion: null });
    let saved: unknown[] = [];
    const state = { ...emptyState(), outbox: [{ id: "x:9", kind: "cancelRuns" as const, ref: "queue/9", head: sha("qh"), until: "2026-10-21T12:30:00.000Z", giveUpAt: "2026-10-21T18:00:00.000Z" }] };
    target.cancelRun = async () => {
      throw new GitHubError("server", 502, "down");
    };
    await drain(state, { target, repo: new FakeStateRepo(), names: NAMES, now: new Date("2026-10-21T12:00:00Z"), reconcileMinutes: 30, save: async (o) => void (saved = o) });
    expect(saved).toMatchObject([{ id: "x:9", seen: [r.id] }]);
  });

  test("a lost lease at the land fence ends the tick quietly: no landRejected, no pause, no state change", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    const read = w.stateRef.read.bind(w.stateRef);
    let moved = false;
    let before = "";
    w.stateRef.read = async () => {
      const r = await read();
      if (!moved && r && r.text.includes('"kind": "land"') && r.text.includes('"owner": "A"')) {
        moved = true;
        before = r.text;
        // someone else moves the state (and holds no lease, so the fence is all that stops A)
        w.stateRef.current = { version: sha("other-writer"), text: r.text };
        return read();
      }
      return r;
    };
    const a = await w.tick({ runId: "A" });
    expect(a === "crashed" ? a : a.outcome).toBe("lost-lock");
    expect(w.paused()).toBe(false);
    expect(w.stateRef.current!.text).toBe(before); // A wrote nothing after losing the lock
    expect(w.target.calls.filter((c) => c.startsWith("updateRef main"))).toEqual([]);
  });

  test("a v4 state (from ba84de1) loads as v5 with the new fields defaulted", () => {
    const v4 = {
      ...emptyState(),
      v: 4,
      auth: { "1": { head: sha("pr1"), baseRepoId: TARGET, policy: "p", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: null } },
      active: { n: 2, base: sha("b"), head: sha("q"), depth: 0, prs: [1], lineage: 1, rerun: null, cancels: [], builtAt: "2026-10-21T10:00:00.000Z" },
      lineages: { "1": { runs: 1 } },
      outbox: [{ id: "x:1", kind: "cancelRuns", ref: "queue/1", head: sha("q1"), until: "2026-10-21T10:30:00.000Z" }],
    } as unknown as Record<string, unknown>;
    const s = parseState(JSON.stringify(v4), NAMES);
    expect(s.v).toBe(5);
    expect(s.active!.rerunAt).toBeNull();
    expect(s.outbox[0]).toMatchObject({ kind: "cancelRuns", giveUpAt: "2026-10-21T10:30:00.000Z" });
  });
});

describe("a lease-margin fence failure at landing", () => {
  test("the lease is nearly expired and nobody else wrote: the tick ends quietly, nothing is persisted, no pause", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    const read = w.stateRef.read.bind(w.stateRef);
    let late = false;
    let before = "";
    w.stateRef.read = async () => {
      const r = await read();
      if (!late && r && r.text.includes('"kind": "land"') && r.text.includes('"owner": "A"')) {
        late = true;
        before = r.text;
        w.now = new Date(w.now.getTime() + 7 * 60_000); // only 1 minute of lease left: under the 2-minute margin
        return read();
      }
      return r;
    };
    const a = await w.tick({ runId: "A" });
    expect(a === "crashed" ? a : a.outcome).toBe("lost-lock");
    expect(w.paused()).toBe(false);
    expect(w.state().outbox.some((n) => n.kind === "pause")).toBe(false);
    expect(w.stateRef.current!.text).toBe(before);
    expect(w.mainHistory).toHaveLength(1);
  });
});

describe("dry run (rollout gate G3)", () => {
  test("decides and reports, but writes nothing: no lease, no state, no target change", async () => {
    const { runDry, isLive } = await import("../src/main");
    const target = new FakeTarget("read");
    const w = new World();
    w.target = target as never;
    for (const n of [1, 2, 3, 4]) w.readyPr(n); // the config's minFill: a full batch builds at once
    w.target.advance(); // let the lists catch up
    const stateRef = new FakeStateRef();
    const repo = new FakeStateRepo();
    const r = await runDry({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: defaultConfig.names.control.id } }, async () => ({ target, repo, stateRef }));
    expect(r.wouldDo).toMatchObject({ kind: "build", pins: [{ pr: 1 }, { pr: 2 }, { pr: 3 }, { pr: 4 }] });
    expect(stateRef.current).toBeNull();
    expect(stateRef.writes).toBe(0);
    expect(repo.issues).toEqual([]);
    expect(target.calls.filter((c) => /^(createRef|deleteRef|updateRef|merge|rerun|cancel|unlabel)/.test(c))).toEqual([]);
    expect(isLive({})).toBe(false);
    expect(isLive({ QLANDER_MODE: "Live" })).toBe(false);
    expect(isLive({ QLANDER_MODE: "live" })).toBe(true);
  });
});

describe("a lagging state-ref read is not a takeover", () => {
  // GitHub served the fence's REST ref read, right after the checkpoint's
  // GraphQL updateRefs, from a replica that still had the previous commit.
  // The fence called that "another runner took over" and the build stopped
  // with its checkpoint recorded and no queue ref.
  const laggingAfterCheckpoint = (w: World, staleReads: number) => {
    const ref = w.stateRef;
    const read = ref.read.bind(ref);
    const cas = ref.cas.bind(ref);
    let stale: { version: string; text: string } | null = null;
    let left = 0;
    ref.cas = async (before, text) => {
      const prev = ref.current;
      const v = await cas(before, text);
      if (left === 0 && stale === null && text.includes('"chainHead"') && !text.includes('"checkpoint": null')) {
        stale = prev;
        left = staleReads;
      }
      return v;
    };
    ref.read = async () => {
      if (stale && left > 0) {
        left--;
        return { ...stale, serverTime: ref.clock() };
      }
      return read();
    };
  };
  const noWait = (w: World) => (w.config = { ...w.config, sleep: async () => {} } as typeof w.config);

  test("the fence re-reads past our own earlier write and the build completes", async () => {
    const w = new World();
    noWait(w);
    w.readyPr(1);
    laggingAfterCheckpoint(w, 2);
    const outcomes: string[] = [];
    for (let i = 0; i < 6 && !(w.stateRef.current && w.state().active); i++) {
      const r = await w.tick();
      outcomes.push(r === "crashed" ? r : r.outcome);
    }
    expect(outcomes).not.toContain("lost-lock");
    expect(w.state().active).not.toBeNull();
    expect(w.state().journal).toBeNull();
  });

  test("a lag that never clears still fails closed: lost-lock, no queue ref", async () => {
    const w = new World();
    noWait(w);
    w.readyPr(1);
    laggingAfterCheckpoint(w, 1_000);
    let r: Awaited<ReturnType<World["tick"]>> | null = null;
    for (let i = 0; i < 6 && !(w.stateRef.current && w.state().journal?.checkpoint); i++) r = await w.tick();
    expect(r === "crashed" ? r : r?.outcome).toBe("lost-lock");
    expect(w.target.calls.filter((c) => c.startsWith("createRef queue/"))).toEqual([]);
  });
});
