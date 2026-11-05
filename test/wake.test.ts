// Self-chaining (DESIGN.md §11.1): when a live queue tick dispatches the
// next one, the bounded CI watch, and the bounds that stop a dispatch storm.

import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import type { Listed } from "../src/github/api";
import { emptyState, type State } from "../src/state";
import type { Run } from "../src/types";
import { afterTick, type ChainApi, DISPATCH_SECONDS, MAX_DISPATCHES_PER_HOUR, RETICK_SECONDS, RETICK_WINDOW_MINUTES, retickAt, WATCH_MINUTES, WATCH_POLL_SECONDS, type Wake, wakeFor } from "../src/wake";
import { run, sha } from "./sim";
import { FakeTarget, FakeStateRef, FakeStateRepo } from "./fake-github";
import { World } from "./world";
import { reportAndChain, runQueue } from "../src/main";

const HEAD = sha("q7");
const active = (over: Partial<NonNullable<State["active"]>> = {}): NonNullable<State["active"]> => ({
  n: 7,
  base: sha("main"),
  head: HEAD,
  depth: 0,
  prs: [1, 2],
  lineage: 1,
  rerun: null,
  rerunAt: null,
  cancels: [],
  builtAt: "2026-10-23T10:00:00Z",
  ...over,
});
const withState = (over: Partial<State>): State => ({ ...emptyState(), ...over });
const auth = { head: sha("pr1"), baseRepoId: 1, policy: "p", policyPr: false, admittedAt: "t", labelledAt: "t", evidence: [], reviewRun: null };
const verify = [{ pr: 1, pin: sha("pr1"), landedIn: sha("main"), since: "2026-10-23T10:00:00Z", ticks: 1, notified: false }];

describe("wakeFor: which ticks chain", () => {
  test("acted with more work pending dispatches now", () => {
    expect(wakeFor("acted", withState({ pending: [{ prs: [1], depth: 1, lineage: 1 }] })).kind).toBe("now");
    expect(wakeFor("acted", withState({ solo: [{ pr: 1, lineage: 1, reason: "split" }] })).kind).toBe("now");
    expect(wakeFor("acted", withState({ auth: { "3": auth } })).kind).toBe("now");
    expect(wakeFor("acted", withState({ outbox: [{ id: "c", kind: "comment", pr: 1, body: "x" }] })).kind).toBe("now");
  });

  test("acted with only verification, or only CI cancellation, left does not chain", () => {
    expect(wakeFor("acted", withState({ verify })).kind).toBe("none");
    expect(wakeFor("acted", withState({ outbox: [{ id: "x", kind: "cancelRuns", ref: "queue/7", head: HEAD, until: "t", giveUpAt: "t" }] })).kind).toBe("none");
    expect(wakeFor("acted", emptyState()).kind).toBe("none");
  });

  test("a batch in flight (just built, or CI pending on an idle tick) watches its CI", () => {
    expect(wakeFor("acted", withState({ active: active() }))).toEqual({ kind: "ci", n: 7, head: HEAD });
    expect(wakeFor("idle", withState({ active: active() }))).toEqual({ kind: "ci", n: 7, head: HEAD });
    expect(wakeFor("waiting", withState({ active: active(), journal: { seq: 1, op: { kind: "rerun", runs: [] }, reserved: true, at: "t", checkpoint: null, tries: 0 } })).kind).toBe("ci");
  });

  test("busy, paused, retry-later, lost-lock and stale never chain, whatever is pending; nor does idle with nothing in flight", () => {
    const s = withState({ active: active(), pending: [{ prs: [3], depth: 1, lineage: 1 }], auth: { "3": auth } });
    for (const o of ["busy", "paused", "retry-later", "lost-lock", "stale"] as const) expect(wakeFor(o, s), o).toEqual({ kind: "none" });
    expect(wakeFor("idle", withState({ auth: { "3": auth } }))).toEqual({ kind: "none" });
  });

  test("a pause waiting in the outbox stops the chain", () => {
    expect(wakeFor("acted", withState({ active: active(), pending: [{ prs: [3], depth: 1, lineage: 1 }], outbox: [{ id: "p", kind: "pause", reason: "r" }] }))).toEqual({ kind: "none" });
  });
});

/** A fake clock, target and dispatcher. */
class Harness implements ChainApi {
  t = Date.parse("2026-10-23T12:00:00Z");
  startedAt = this.t;
  polls: number[] = [];
  dispatched: number[] = [];
  recent = 0;
  dispatchError: Error | null = null;
  recentError: Error | null = null;
  release = false;
  /** listRuns answers this many ms (of the fake clock) after it is asked; never, if Infinity. */
  listDelay = 0;
  /** Each count's window start, relative to the clock then. */
  since: number[] = [];
  constructor(private readonly script: (poll: number) => Run[] | Error) {}

  async dispatchTick(): Promise<void> {
    if (this.dispatchError) throw this.dispatchError;
    this.dispatched.push(this.t);
  }

  async recentDispatches(since: Date): Promise<number> {
    if (this.recentError) throw this.recentError;
    this.since.push(since.getTime() - this.t);
    return this.recent;
  }

  async releaseWaiting(): Promise<boolean> {
    return this.release;
  }

  deps() {
    return {
      target: {
        listRuns: async (q: { headSha: string; branch?: string; event?: string }): Promise<Listed<Run>> => {
          expect(q).toEqual({ headSha: HEAD, branch: "queue/7", event: "push" });
          this.polls.push(this.t);
          const r = this.script(this.polls.length);
          if (this.listDelay === Infinity) return new Promise<Listed<Run>>(() => {});
          if (r instanceof Error) throw r;
          return { items: r, truncated: false };
        },
      },
      chain: this,
      cfg: defaultConfig,
      startedAt: this.startedAt,
      now: () => this.t,
      sleep: async (ms: number) => {
        expect(ms).toBeGreaterThan(0);
        this.t += ms;
      },
    };
  }
}

const ci: Wake = { kind: "ci", n: 7, head: HEAD };
const qrun = (over: Partial<Run> = {}) => run({ id: 70, head_branch: "queue/7", head_sha: HEAD, status: "in_progress", conclusion: null, ...over });
const POLL = WATCH_POLL_SECONDS * 1000;
const WATCH = WATCH_MINUTES * 60_000;

describe("afterTick: dispatch", () => {
  test("now: dispatches at once, with no polling", async () => {
    const h = new Harness(() => []);
    const log = await afterTick({ kind: "now", reason: "r" }, h.deps());
    expect(h.dispatched).toEqual([h.startedAt]);
    expect(h.since).toEqual([-3_600_000]); // the cap's window is the last hour
    expect(h.polls).toEqual([]);
    expect(log.at(-1)).toBe("chain: dispatched the next queue tick");
  });

  test("none (or no wake at all, as for busy/paused/retry-later/lost-lock/dry runs): no poll, no dispatch", async () => {
    for (const w of [{ kind: "none" } as const, undefined]) {
      const h = new Harness(() => []);
      await afterTick(w, h.deps());
      expect(h.polls).toEqual([]);
      expect(h.dispatched).toEqual([]);
    }
  });

  test("a failed dispatch is logged, never thrown: the cron is the fallback", async () => {
    const h = new Harness(() => []);
    h.dispatchError = new Error("403");
    const log = await afterTick({ kind: "now", reason: "r" }, h.deps());
    expect(log.at(-1)).toContain("dispatch failed");
  });

  test(`at most ${MAX_DISPATCHES_PER_HOUR} dispatched ticks per hour; an unreadable count means no dispatch`, async () => {
    const h = new Harness(() => []);
    h.recent = MAX_DISPATCHES_PER_HOUR;
    expect((await afterTick({ kind: "now", reason: "r" }, h.deps())).at(-1)).toContain("not dispatched");
    h.recent = MAX_DISPATCHES_PER_HOUR - 1;
    h.recentError = new Error("500");
    expect((await afterTick({ kind: "now", reason: "r" }, h.deps())).at(-1)).toContain("dispatch failed");
    expect(h.dispatched).toEqual([]);
    h.recentError = null;
    await afterTick({ kind: "now", reason: "r" }, h.deps());
    expect(h.dispatched).toHaveLength(1);
  });
});

describe("afterTick: the yields and deadlines added after review", () => {
  test("a release job waiting for the runner: the queue yields (the cron's own queue job continues the chain)", async () => {
    const h = new Harness(() => []);
    h.release = true;
    const log = await afterTick({ kind: "now", reason: "r" }, h.deps());
    expect(h.dispatched).toEqual([]);
    expect(log.at(-1)).toContain("release job is waiting");
  });

  test("past the dispatch deadline nothing is sent", async () => {
    const h = new Harness(() => []);
    h.t = h.startedAt + WATCH + DISPATCH_SECONDS * 1000;
    const log = await afterTick({ kind: "now", reason: "r" }, h.deps());
    expect(h.dispatched).toEqual([]);
    expect(log.at(-1)).toContain("too close to the job timeout");
  });

  test("a listing that never answers cannot hold the watch past its deadline", async () => {
    const h = new Harness(() => [qrun()]);
    h.listDelay = Infinity;
    h.t = h.startedAt + WATCH - 10; // 10 ms of real time left for the read
    await afterTick(ci, h.deps());
    expect(h.dispatched).toHaveLength(1);
  });

  test("a truncated listing is neither a baseline nor progress", async () => {
    const h = new Harness(() => []);
    let n = 0;
    const deps = {
      ...h.deps(),
      target: {
        listRuns: async (): Promise<Listed<Run>> => {
          n++;
          // incomplete and empty, then complete with a run already finished: not progress
          return n % 2 === 1 ? { items: [], truncated: true } : { items: [qrun({ status: "completed", conclusion: "success" })], truncated: false };
        },
      },
    };
    await afterTick(ci, deps);
    expect(h.dispatched).toEqual([h.startedAt + WATCH]);
  });

  test("a tick whose op made no progress (aborted, refunded, dropped) never chains", () => {
    const s = withState({ auth: { "3": auth }, pending: [{ prs: [3], depth: 0, lineage: 1 }] });
    expect(wakeFor("acted", s, "built").kind).toBe("now");
    for (const r of ["buildAborted", "buildFailed", "opAbandoned", "opDropped", "landRejected", "targetMissing"]) expect(wakeFor("acted", s, r), r).toEqual({ kind: "none" });
  });
});

describe("afterTick: the CI watch", () => {
  test("ends early when a run seen running completes: dispatch on that poll, no further polls", async () => {
    const h = new Harness((n) => [qrun(n >= 3 ? { status: "completed", conclusion: "success" } : {})]);
    const log = await afterTick(ci, h.deps());
    expect(h.polls).toHaveLength(3);
    expect(h.dispatched).toEqual([h.startedAt + 2 * POLL]);
    expect(log[0]).toContain("until progress");
  });

  test("a run already completed when the watch began is not progress: the watch runs to its deadline (no tight loop)", async () => {
    const h = new Harness(() => [qrun({ status: "completed", conclusion: "success" })]);
    await afterTick(ci, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + WATCH]);
    expect(h.polls).toHaveLength(WATCH / POLL + 1);
  });

  test("the deadline counts from process start, not watch start", async () => {
    const h = new Harness(() => [qrun()]);
    h.t = h.startedAt + WATCH - 30_000; // the tick itself took 2.5 minutes
    await afterTick(ci, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + WATCH]);
    expect(h.polls).toHaveLength(3); // at -30 s, -10 s and the deadline
  });

  test("a tick that outlasted the watch dispatches at once, after one baseline read", async () => {
    const h = new Harness(() => [qrun()]);
    h.t = h.startedAt + WATCH + 5_000;
    await afterTick(ci, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + WATCH + 5_000]);
    expect(h.polls).toHaveLength(1);
  });

  test("a newer attempt that completes during the watch is progress", async () => {
    const h = new Harness((n) => [n < 2 ? qrun({ status: "completed", conclusion: "failure" }) : qrun({ status: "completed", conclusion: "success", run_attempt: 2 })]);
    await afterTick(ci, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + POLL]);
  });

  test("a run that appears and completes during the watch is progress", async () => {
    const h = new Harness((n) => (n < 3 ? [] : [qrun({ status: "completed", conclusion: "success" })]));
    await afterTick(ci, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + 2 * POLL]);
  });

  test("a failed first read is not a baseline: a completed run on the next read still waits for the deadline", async () => {
    const h = new Harness((n) => (n === 1 ? new Error("502") : [qrun({ status: "completed", conclusion: "success" })]));
    await afterTick(ci, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + WATCH]);
  });

  test("other workflows, branches and heads are not the batch's CI", async () => {
    const h = new Harness((n) => [
      qrun({ id: 1, path: ".github/workflows/other.yml", status: n >= 2 ? "completed" : "in_progress" }),
      qrun({ id: 2, head_branch: "queue/8", status: n >= 2 ? "completed" : "in_progress" }),
      qrun({ id: 3, head_sha: sha("other"), status: n >= 2 ? "completed" : "in_progress" }),
    ]);
    await afterTick(ci, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + WATCH]);
  });
});

describe("TickResult.wake from the real runner", () => {
  test("build gives ci; a land that empties the queue gives none; a split with halves pending gives now", async () => {
    const w = new World((b) => (b.prs.includes(3) ? "fail" : "pass"));
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    const seen: { outcome: string; wake: string; active: boolean; pending: number }[] = [];
    for (let i = 0; i < 40 && !w.paused(); i++) {
      const r = await w.tick();
      if (r === "crashed") throw new Error("crashed");
      const s = w.state();
      seen.push({ outcome: r.outcome, wake: r.wake?.kind ?? "-", active: s.active !== null, pending: s.pending.length + s.solo.length });
    }
    // Every finished tick carries a wake hint.
    expect(seen.every((x) => x.wake !== "-")).toBe(true);
    // A tick that leaves a batch in flight watches its CI.
    expect(seen.filter((x) => x.active).every((x) => x.wake === "ci")).toBe(true);
    // A split leaves halves pending and no batch in flight: chain now.
    expect(seen.some((x) => x.outcome === "acted" && !x.active && x.pending > 0 && x.wake === "now")).toBe(true);
    // Once everything has landed or bounced, the chain stops.
    expect(seen.at(-1)!.wake).toBe("none");
    expect(w.landed().flat().sort()).toEqual([1, 2, 4]);
  });
});

describe("the entry point", () => {
  test("runQueue chains only after the tick has returned (its lease released), with the tick's own clients", async () => {
    const stateRef = new FakeStateRef();
    const clients = { target: new FakeTarget(), repo: new FakeStateRepo(), stateRef };
    const env = { GITHUB_RUN_ID: "777", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "workflow_dispatch" };
    let leaseAtChain: unknown = "unset";
    const result = await runQueue(env, { repository: { id: defaultConfig.names.control.id } }, async () => clients, async (r, c) => {
      expect(c).toBe(clients);
      expect(r.wake).toBeDefined();
      leaseAtChain = JSON.parse(stateRef.current!.text).lease;
    });
    expect(result.outcome).toBe("idle");
    expect(leaseAtChain).toBeNull();
  });

  test("reportAndChain prints the report before chaining, and does nothing more without a chain client", async () => {
    const lines: string[] = [];
    const orig = console.log;
    console.log = (x: unknown) => void lines.push(String(x));
    try {
      const h = new Harness(() => []);
      const target = new FakeTarget();
      await reportAndChain({ outcome: "acted", log: [], wake: { kind: "now", reason: "r" } }, { target, repo: new FakeStateRepo(), stateRef: new FakeStateRef(), chain: h });
      expect(JSON.parse(lines[0]!).outcome).toBe("acted");
      expect(lines.at(-1)).toBe("chain: dispatched the next queue tick");
      expect(h.dispatched).toHaveLength(1);
      lines.length = 0;
      await reportAndChain({ outcome: "acted", log: [], wake: { kind: "now", reason: "r" } }, { target, repo: new FakeStateRepo(), stateRef: new FakeStateRef() });
      expect(lines).toHaveLength(1);
    } finally {
      console.log = orig;
    }
  });
});

describe("fill timer chaining", () => {
  const t0 = Date.parse("2026-10-23T12:00:00Z");
  const at = t0 + 20 * 60_000;
  const filling = withState({ auth: { "3": auth } });

  test("a tick whose selection chose to fill chains toward the deadline", () => {
    expect(wakeFor("idle", filling, null, at)).toEqual({ kind: "fill", at });
    expect(wakeFor("acted", filling, null, at)).toEqual({ kind: "fill", at });
  });

  test("without a fill decision (a landing, a pause, recovery) the old wakes stand", () => {
    expect(wakeFor("acted", filling, null, null)).toEqual({ kind: "now", reason: "admitted PRs are waiting" });
    expect(wakeFor("idle", filling, null, null)).toEqual({ kind: "none" });
    expect(wakeFor("idle", { ...filling, outbox: [{ id: "p", kind: "pause", reason: "r" }] }, null, at)).toEqual({ kind: "none" });
    expect(wakeFor("acted", { ...filling, outbox: [{ id: "c", kind: "comment", pr: 1, body: "x" }] }, null, at).kind).toBe("now");
    expect(wakeFor("paused", filling, null, at)).toEqual({ kind: "none" });
  });

  test("afterTick sleeps until the deadline when it falls inside the watch, then dispatches", async () => {
    const h = new Harness(() => []);
    await afterTick({ kind: "fill", at: h.startedAt + 60_000 }, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + 60_000]);
    expect(h.polls).toEqual([]);
  });

  test("a deadline crossed during the tick dispatches at once", async () => {
    const h = new Harness(() => []);
    await afterTick({ kind: "fill", at: h.startedAt - 1000 }, h.deps());
    expect(h.dispatched).toEqual([h.startedAt]);
  });

  test("a far deadline: afterTick waits out the watch, then dispatches the next filling tick", async () => {
    const h = new Harness(() => []);
    await afterTick({ kind: "fill", at: h.startedAt + 60 * 60_000 }, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + WATCH]);
  });
});

describe("mergeability-hold re-ticks", () => {
  const t0 = Date.parse("2026-10-23T12:00:00Z");
  const soon = t0 + RETICK_SECONDS * 1000;
  const held = withState({ auth: { "3": auth } });

  test("retickAt: a young hold re-ticks soon; an old one (or none) leaves it to the cron", () => {
    expect(retickAt(undefined, t0)).toBeNull();
    expect(retickAt(t0, t0)).toBe(soon);
    expect(retickAt(t0 - (RETICK_WINDOW_MINUTES * 60_000 - 1), t0)).toBe(soon);
    expect(retickAt(t0 - RETICK_WINDOW_MINUTES * 60_000, t0)).toBeNull();
  });

  test("a hold turns a would-be cron wait (idle, or a later fill deadline) into a short re-tick", () => {
    expect(wakeFor("idle", held, null, null, soon)).toEqual({ kind: "retick", at: soon });
    expect(wakeFor("idle", emptyState(), null, null, soon)).toEqual({ kind: "retick", at: soon }); // a ready PR not yet admitted
    expect(wakeFor("idle", held, null, t0 + 20 * 60_000, soon)).toEqual({ kind: "retick", at: soon });
    expect(wakeFor("idle", held, null, soon - 1, soon)).toEqual({ kind: "fill", at: soon - 1 });
  });

  test("it never replaces a CI watch or an immediate tick, and never chains past a pause, a no-progress op or a non-chaining outcome", () => {
    expect(wakeFor("idle", withState({ active: active() }), null, null, soon).kind).toBe("ci");
    expect(wakeFor("acted", held, null, null, soon).kind).toBe("now");
    expect(wakeFor("idle", { ...held, outbox: [{ id: "p", kind: "pause", reason: "r" }] }, null, null, soon)).toEqual({ kind: "none" });
    expect(wakeFor("acted", held, "buildAborted", null, soon)).toEqual({ kind: "none" });
    for (const o of ["busy", "paused", "retry-later", "lost-lock", "stale"] as const) expect(wakeFor(o, held, null, null, soon), o).toEqual({ kind: "none" });
  });

  test("afterTick waits until the re-tick, then dispatches through the same capped dispatch", async () => {
    const h = new Harness(() => []);
    const log = await afterTick({ kind: "retick", at: h.startedAt + RETICK_SECONDS * 1000 }, h.deps());
    expect(h.dispatched).toEqual([h.startedAt + RETICK_SECONDS * 1000]);
    expect(h.polls).toEqual([]);
    expect(log[0]).toStartWith("chain: re-tick for a PR held on unknown mergeability");
    h.recent = MAX_DISPATCHES_PER_HOUR;
    const capped = await afterTick({ kind: "retick", at: h.t + 1000 }, h.deps());
    expect(capped.at(-1)).toContain("not dispatched");
    expect(h.dispatched).toHaveLength(1);
  });

  test("the real runner: after a landing, a PR GitHub has not recomputed is held and the tick re-ticks; the re-tick builds it", async () => {
    const w = new World();
    w.readyPr(1);
    for (let i = 0; i < 12 && (i === 0 || w.landed().length === 0); i++) {
      if (i === 1) w.readyPr(2);
      const r = await w.tick();
      if (r === "crashed") throw new Error("crashed");
    }
    expect(w.landed()).toEqual([[1]]);
    expect(w.state().auth["2"]).toBeDefined();
    w.target.prs.get(2)!.pr.mergeable = null; // main just moved
    const r = await w.tick();
    if (r === "crashed") throw new Error("crashed");
    expect(r.outcome).toBe("idle");
    expect(r.log).toContain("#2 held: mergeability not computed yet");
    expect(r.wake?.kind).toBe("retick");
    expect(w.state().auth["2"]).toBeDefined();
    w.target.prs.get(2)!.pr.mergeable = true;
    const r2 = await w.tick();
    if (r2 === "crashed") throw new Error("crashed");
    expect(r2.wake?.kind).toBe("ci");
    expect(w.state().active?.prs).toEqual([2]);
    expect(w.state().held).toBeUndefined();
  });
});
