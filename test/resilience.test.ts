// The runner under crashes and concurrency (DESIGN.md §3.2, §15).

import { describe, expect, test } from "bun:test";
import type { CrashPoint } from "../src/queue";
import { interpretObservation } from "../src/ops";
import { LeaseHeldError, LostLockError, queueCodec, StateStore } from "../src/store";
import { FakeStateRef, FakeStateRepo } from "./fake-github";
import { emptyState, parseState } from "../src/state";
import { NAMES, sha } from "./sim";
import { World, type BatchCi, type CiOutcome } from "./world";

function safe(w: World): void {
  for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
}

const POINTS: CrashPoint[] = ["after-intent", "after-build-ref", "after-merges", "after-checkpoint", "after-queue-ref", "after-effect", "after-receipt", "mid-drain"];

async function scenario(oracle: (b: BatchCi) => CiOutcome, crash?: { point: CrashPoint; at: number }) {
  const w = new World(oracle);
  for (const n of [1, 2, 3]) w.readyPr(n);
  let crashed = false;
  if (crash) {
    // Occurrences are counted across the whole run, not per tick.
    let hits = 0;
    const when = (p: CrashPoint) => p === crash.point && ++hits === crash.at;
    for (let i = 0; i < 40 && !crashed; i++) {
      crashed = (await w.tick({ crashWhen: when })) === "crashed";
      if (!crashed && w.landed().length > 0 && w.state().verify.length === 0 && w.state().outbox.length === 0) break;
    }
  }
  await w.runUntilIdle();
  return { w, crashed };
}

describe("a crash at every step boundary converges to the crash-free result", () => {
  const cases: [string, (b: BatchCi) => CiOutcome][] = [
    ["build, rerun, land", (b) => (b.attempt === 1 ? "fail" : "pass")],
    ["build, cancel for time, rerun, land", (b) => (b.attempt === 1 ? "hang" : "pass")],
  ];
  for (const [name, oracle] of cases) {
    test(`${name}: every point, first to third occurrence`, async () => {
      const base = await scenario(oracle);
      expect(base.w.landed()).toEqual([[1, 2, 3]]);
      expect(base.w.repo.issues.filter((i) => i.labels.includes("flaky")).length).toBe(name.includes("cancel") ? 0 : 1);
      let exercised = 0;
      for (const point of POINTS) {
        for (const at of [1, 2, 3]) {
          const { w, crashed } = await scenario(oracle, { point, at });
          if (!crashed) continue;
          exercised++;
          const where = `${name} @ ${point}#${at}`;
          expect(w.paused(), where).toBe(false);
          expect(w.landed().flat().sort(), where).toEqual([1, 2, 3]);
          safe(w);
          const s = w.state();
          expect(s.outbox, where).toEqual([]);
          expect(s.journal, where).toBeNull();
          expect([...w.target.refs.keys()].filter((k) => k !== "main"), where).toEqual([]);
          // Flaky tracking: a rerun that passed after a red first attempt opens
          // exactly one flaky issue with one occurrence, crash or not; a rerun
          // after a timeout (infra) is not a flake.
          const flaky = w.repo.issues.filter((i) => i.labels.includes("flaky"));
          expect(flaky.length, where).toBe(base.w.repo.issues.filter((i) => i.labels.includes("flaky")).length);
          for (const i of flaky) expect(i.body.match(/qlander:flaky:/g)?.length, where).toBe(1);
          // Idempotent notices: no comment posted twice.
          const bodies = w.target.posted.map((p) => `${p.pr}:${p.body}`);
          expect(new Set(bodies).size, where).toBe(bodies.length);
          // At most one extra build for a crash, never a double landing.
          expect(w.target.calls.filter((x) => x.startsWith("updateRef main")).length, where).toBeLessThanOrEqual(2);
          expect(w.mainHistory.length, where).toBe(2);
        }
      }
      expect(exercised).toBeGreaterThanOrEqual(12);
    });
  }
});

describe("the state store: CAS on the state branch, and the whole-tick lease (DESIGN.md §15)", () => {
  const T0 = new Date("2026-10-21T12:00:00Z");
  const later = (min: number) => new Date(T0.getTime() + min * 60_000);
  const LEASE = { leaseMinutes: 15, fenceMarginMinutes: 2 };
  /** A state ref whose GitHub clock the test sets. */
  const refAt = () => {
    const ref = new FakeStateRef();
    let t = T0;
    ref.clock = () => t;
    return { ref, at: (d: Date) => (t = d) };
  };
  const repo = new FakeStateRepo();

  test("a live lease stops a second runner before it reads anything into action", async () => {
    const { ref, at } = refAt();
    await StateStore.open(ref, repo, "A", LEASE, null, queueCodec(NAMES));
    at(later(5));
    await expect(StateStore.open(ref, repo, "B", LEASE, null, queueCodec(NAMES))).rejects.toBeInstanceOf(LeaseHeldError);
  });

  test("a stale writer's CAS fails: it can never overwrite a newer state", async () => {
    const { ref, at } = refAt();
    const a = await StateStore.open(ref, repo, "A", LEASE, null, queueCodec(NAMES));
    at(later(20));
    const b = await StateStore.open(ref, repo, "B", LEASE, null, queueCodec(NAMES)); // A's lease expired; B takes over
    await b.store.write({ ...b.state, seq: 9 });
    await expect(a.store.write({ ...a.state, seq: 1 })).rejects.toBeInstanceOf(LostLockError);
    expect(parseState(ref.current!.text, NAMES).seq).toBe(9);
  });

  test("two runners racing to take the lease: exactly one wins", async () => {
    const { ref, at } = refAt();
    await (await StateStore.open(ref, repo, "seed", LEASE, null, queueCodec(NAMES))).store.release(emptyState());
    at(later(1));
    let b: Promise<unknown> | null = null;
    ref.beforeCas = () => {
      ref.beforeCas = null;
      b = StateStore.open(ref, repo, "B", LEASE, null, queueCodec(NAMES)).then(
        () => "B won",
        (e) => e.constructor.name,
      );
      return b.then(() => undefined);
    };
    const a = await StateStore.open(ref, repo, "A", LEASE, null, queueCodec(NAMES)).then(
      () => "A won",
      (e) => e.constructor.name,
    );
    expect([a, await b].sort()).toEqual(["B won", "LeaseHeldError"].sort());
  });

  test("review #1: a runner whose lease lapsed cannot erase a landing another runner completed", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    let raced = false;
    w.stateRef.beforeCas = async () => {
      // Once A holds the lease and is about to write its next state.
      if (raced || !w.stateRef.current?.text.includes("\"owner\": \"A\"")) return;
      raced = true;
      w.stateRef.beforeCas = null;
      // A (slow) is about to write; its lease has lapsed, and B runs to completion.
      w.now = new Date(w.now.getTime() + 20 * 60_000);
      for (let i = 0; i < 4 && w.landed().length === 0; i++) await w.tick({ runId: `B${i}` });
    };
    const a = await w.tick({ runId: "A" });
    expect(w.landed()).toEqual([[1]]);
    expect(a === "crashed" ? a : a.outcome).toBe("lost-lock");
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]); // still there: never overwritten
    expect(w.state().history.filter((h) => h.outcome === "abandoned")).toEqual([]);
    safe(w);
  });

  test("while one runner holds the lease, a second tick is busy and does nothing", async () => {
    const w = new World();
    w.readyPr(1);
    w.readyPr(2);
    let inner = null as string | null;
    w.stateRef.beforeCas = async () => {
      // Only once A actually holds the lease (not during its own acquisition).
      if (inner !== null || !w.stateRef.current?.text.includes("\"owner\": \"A\"")) return;
      inner = "pending";
      const r = await w.tick({ runId: "B" });
      inner = r === "crashed" ? r : r.outcome;
    };
    await w.tick({ runId: "A" });
    expect(inner).toBe("busy");
    expect(w.target.calls.filter((c) => c.startsWith("createRef queue/")).length).toBeLessThanOrEqual(1);
    w.stateRef.beforeCas = null;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
  });

  test("a queue ref with no recorded build is a mismatch: charged, cancelled, paused (not refunded)", () => {
    const j = { seq: 1, op: { kind: "build" as const, n: 5, base: sha("b"), pins: [{ pr: 1, head: sha("p") }], depth: 0, lineage: 1, source: { kind: "candidates" as const }, rebuild: false }, reserved: true, at: "2026-10-21T12:00:00.000Z", checkpoint: null, tries: 0 };
    expect(interpretObservation(j, { queueHead: sha("q") })).toMatchObject({ kind: "queueMismatch" });
    expect(interpretObservation(j, { queueHead: null })).toMatchObject({ kind: "buildAborted" });
  });
});

describe("outbox drain", () => {
  test("GitHub failures are judged; anything else (a bug, a crash) propagates", async () => {
    const { drain } = await import("../src/outbox");
    const { GitHubError } = await import("../src/github/http");
    const { FakeTarget, FakeStateRepo } = await import("./fake-github");
    const target = new FakeTarget();
    target.addPr(1);
    const repo = new FakeStateRepo();
    const state = { ...emptyState(), outbox: [{ id: "c:1:x", kind: "comment" as const, pr: 1, body: "hi" }] };
    const deps = { target, repo, names: NAMES, now: new Date("2026-10-21T12:00:00Z"), reconcileMinutes: 15, save: async () => {} };
    target.comment = async () => {
      throw new TypeError("bug");
    };
    await expect(drain(state, deps)).rejects.toThrow("bug");
    target.comment = async () => {
      throw new GitHubError("server", 502, "down");
    };
    const deferred = await drain(state, deps);
    expect(deferred.outbox).toHaveLength(1);
    expect(deferred.failure).toBeNull();
    target.comment = async () => {
      throw new GitHubError("auth", 403, "nope");
    };
    expect((await drain(state, deps)).failure?.reason).toContain("auth");
  });
});
