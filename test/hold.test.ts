// Mergeability holds: right after a landing GitHub has
// not recomputed `mergeable` against the new main (null). An admitted PR is
// then held, not dropped: it keeps its admission and fill clock, is left out
// of anything built or landed this tick, and the tick re-ticks soon.

import { describe, expect, test } from "bun:test";
import { revalidate } from "../src/admission";
import { decide, HOLD_MINUTES } from "../src/machine";
import { parseState } from "../src/state";
import { cfg, TARGET, green, livePr, NAMES, red, Sim } from "./sim";

const MIN = 60_000;
const nul = (sim: Sim, n: number) => (sim.prs[String(n)] = { ...sim.prs[String(n)]!, mergeable: null });
const set = (sim: Sim, n: number, mergeable: boolean | null) => (sim.prs[String(n)] = { ...sim.prs[String(n)]!, mergeable });
/** Tick, then set the clock `minutes` after the tick's own time (the Sim steps 10 minutes). */
const tickAt = (sim: Sim, minutes: number): string[] => {
  const t = sim.now.getTime();
  const log = sim.tick();
  sim.now = new Date(t + minutes * MIN);
  return log;
};

/** #1 builds and lands; #2 and #3 are admitted while it is in flight. Returns at the tick after the landing. */
function afterLanding(): Sim {
  const sim = new Sim(cfg()).add(livePr(1));
  tickAt(sim, 1); // build [1]
  sim.add(livePr(2), livePr(3));
  tickAt(sim, 1); // admit #2 #3; land [1]
  expect(sim.landed).toEqual([[1]]);
  expect(Object.keys(sim.state.auth).sort()).toEqual(["2", "3"]);
  return sim;
}

describe("revalidate: only unknown mergeability is a hold", () => {
  const auth = { head: livePr(1).head, baseRepoId: TARGET, policy: "p", policyPr: false, admittedAt: "t", labelledAt: "t", evidence: [], reviewRun: null };
  const C = cfg();
  test("null mergeability holds; false, a moved head, a missing label and a red fast lane still drop", () => {
    expect(revalidate(auth, livePr(1, { mergeable: null }), C, "p")).toMatchObject({ ok: false, hold: true, headMoved: false });
    expect(revalidate(auth, livePr(1, { mergeable: false }), C, "p")).toMatchObject({ ok: false, hold: false });
    expect(revalidate(auth, livePr(1, { mergeable: null, head: livePr(9).head }), C, "p")).toMatchObject({ ok: false, hold: false, headMoved: true });
    expect(revalidate(auth, livePr(1, { mergeable: null, labels: [] }), C, "p")).toMatchObject({ ok: false, hold: false });
    expect(revalidate(auth, livePr(1, { fastLane: { ok: false, why: "rerunning" } }), C, "p")).toMatchObject({ ok: false, hold: false });
  });

  test("unknown mergeability never masks another failure: the rest of admission is still checked", () => {
    const n = { mergeable: null };
    expect(revalidate(auth, livePr(1, { ...n, fastLane: { ok: false, why: "rerunning" } }), C, "p")).toEqual({ ok: false, hold: false, headMoved: false, reason: "fast lane: rerunning" });
    expect(revalidate(auth, livePr(1, { ...n, review: { ok: false, why: "missing" } }), C, "p")).toMatchObject({ ok: false, hold: false, reason: "review: missing" });
    expect(revalidate(auth, livePr(1, { ...n, commitsVerified: false }), C, "p")).toMatchObject({ ok: false, hold: false, reason: "has unsigned commits" });
    expect(revalidate(auth, livePr(1, { ...n, policyPr: true }), C, "p")).toMatchObject({ ok: false, hold: false, headMoved: true });
    expect(revalidate(auth, livePr(1, n), C, "p")).toEqual({ ok: false, hold: true, headMoved: false, reason: "mergeability not computed yet" });
  });
});

describe("an admitted PR with unknown mergeability is held, not dropped", () => {
  test("it keeps its admission, admittedAt and fill clock; no dequeued event; the decision reports the hold", () => {
    const sim = afterLanding();
    const before = structuredClone(sim.state);
    nul(sim, 2);
    nul(sim, 3);
    const d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.state.auth["2"]).toEqual(before.auth["2"]!);
    expect(d.state.auth["3"]).toEqual(before.auth["3"]!);
    expect(d.state.eligibleSince?.["2"]).toEqual(before.eligibleSince!["2"]!);
    expect(d.state.eligibleSince?.["3"]).toEqual(before.eligibleSince!["3"]!);
    expect(d.state.journal).toBeNull(); // nothing built: everything is held
    expect(d.log).toContain(`#2 held: mergeability not computed yet`);
    expect(d.log.some((l) => l.startsWith("drop"))).toBe(false);
    expect(d.events?.some((e) => e.event === "dequeued") ?? false).toBe(false);
    expect(d.state.held).toEqual({ "2": { head: livePr(2).head, since: sim.now.toISOString() }, "3": { head: livePr(3).head, since: sim.now.toISOString() } });
    expect(d.holdSince).toBe(sim.now.getTime());
    parseState(JSON.stringify(d.state), NAMES); // the strict schema accepts it
  });

  test("a batch is never built with a held PR: the others build, the held one keeps its place", () => {
    const sim = afterLanding();
    nul(sim, 2);
    tickAt(sim, 1);
    expect(sim.builds.at(-1)!.prs).toEqual([3]);
    expect(sim.state.auth["2"]).toBeDefined();
    expect(sim.state.held?.["2"]).toBeDefined();
  });

  test("when mergeability comes back true it is eligible again and builds, with its original admission", () => {
    const sim = afterLanding();
    const admitted = sim.state.auth["2"]!.admittedAt;
    nul(sim, 2);
    nul(sim, 3);
    tickAt(sim, 1); // held
    expect(sim.builds).toHaveLength(1);
    set(sim, 2, true);
    set(sim, 3, true);
    tickAt(sim, 1);
    expect(sim.builds.at(-1)!.prs).toEqual([2, 3]);
    expect(sim.state.auth["2"]!.admittedAt).toBe(admitted);
    expect(sim.state.held).toBeUndefined();
  });

  test("false mergeability still drops it, and it is unreadied with a comment on the next look", () => {
    const sim = afterLanding();
    set(sim, 2, false);
    nul(sim, 3);
    const log = tickAt(sim, 1);
    expect(log).toContain("drop #2: conflicts with main");
    expect(sim.state.auth["2"]).toBeUndefined();
    set(sim, 3, true);
    tickAt(sim, 1);
    expect(sim.prs["2"]!.ready).toBeNull();
    expect(sim.comments.some((c) => c.pr === 2 && c.body.includes("conflicts with main"))).toBe(true);
  });

  test(`the hold is bounded: still unknown after ${HOLD_MINUTES} minutes, it is dropped as before`, () => {
    const sim = afterLanding();
    nul(sim, 2);
    nul(sim, 3);
    tickAt(sim, HOLD_MINUTES - 1);
    expect(sim.state.auth["2"]).toBeDefined();
    const since = sim.state.held!["2"]!.since;
    tickAt(sim, 1); // HOLD_MINUTES - 1 after the first hold: still held, same start
    expect(sim.state.held!["2"]!.since).toBe(since);
    const log = tickAt(sim, 1); // HOLD_MINUTES after
    expect(log).toContain(`drop #2: mergeability not computed yet after ${HOLD_MINUTES} minutes`);
    expect(sim.state.auth["2"]).toBeUndefined();
    // Still ready and still unknown: it waits unadmitted, its hold keeping its start (so no fresh re-tick window).
    expect(sim.state.held!["2"]!.since).toBe(since);
  });

  test("a hold restarts on a new head (the old head is dropped as moved anyway)", () => {
    const sim = afterLanding();
    nul(sim, 2);
    tickAt(sim, 1);
    const first = sim.state.held!["2"]!.since;
    sim.prs["2"] = { ...sim.prs["2"]!, head: livePr(22).head };
    tickAt(sim, 1);
    expect(sim.state.auth["2"]).toBeUndefined(); // head moved: dropped and unreadied
    expect(sim.state.held?.["2"]?.since).not.toBe(first);
  });

  test("an operator go is not consumed while every admitted PR is held", () => {
    const sim = new Sim(cfg({ minFill: 4 })).add(livePr(1));
    tickAt(sim, 1); // admitted, filling
    nul(sim, 1);
    sim.state = { ...sim.state, go: true };
    const log = tickAt(sim, 1);
    expect(log.some((l) => l.startsWith("waiting: #1 held"))).toBe(true);
    expect(sim.state.go).toBe(true);
    set(sim, 1, true);
    tickAt(sim, 1);
    expect(sim.builds.map((b) => b.prs)).toEqual([[1]]);
  });

  test("a pause neither resets nor extends a hold: the clock runs on, and expiry still comes", () => {
    const sim = afterLanding();
    nul(sim, 2);
    nul(sim, 3);
    tickAt(sim, 8);
    const held = sim.state.held;
    expect(held?.["2"]).toBeDefined();
    sim.paused = true;
    const d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.state.held).toEqual(held!);
    expect(d.holdSince).toBeUndefined(); // a paused tick never re-ticks
    tickAt(sim, 4); // paused, now 12 minutes after the hold began
    sim.paused = false;
    const log = tickAt(sim, 1);
    expect(log).toContain(`drop #2: mergeability not computed yet after ${HOLD_MINUTES} minutes`);
  });
});

describe("a ready PR not yet admitted with unknown mergeability", () => {
  test("waits as before, and is recorded as held so the tick re-ticks", () => {
    const sim = new Sim(cfg()).add(livePr(1, { mergeable: null }));
    const d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.state.auth).toEqual({});
    expect(d.log).toContain("#1 waits: mergeability not computed yet");
    expect(d.state.held).toEqual({ "1": { head: livePr(1).head, since: sim.now.toISOString() } });
    expect(d.holdSince).toBe(sim.now.getTime());
  });

  test("nothing held: no hold in the decision or the state", () => {
    const sim = new Sim(cfg()).add(livePr(1));
    const d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.holdSince).toBeUndefined();
    expect(d.state.held).toBeUndefined();
  });
});

describe("held PRs in recorded batches wait whole", () => {
  test("a pending split half with a held PR is not built (nor dropped) until it is known", () => {
    const sim = new Sim(cfg(), (b) => (b.prs.length === 4 ? red() : green)).add(livePr(1), livePr(2), livePr(3), livePr(4));
    tickAt(sim, 1); // build [1..4]
    tickAt(sim, 1); // red: rerun
    tickAt(sim, 1); // red again: split, build [1,2]
    expect(sim.state.pending.map((p) => p.prs)).toEqual([[3, 4]]);
    tickAt(sim, 1); // [1,2] lands: main moved
    expect(sim.landed).toEqual([[1, 2]]);
    nul(sim, 3);
    const builds = sim.builds.length;
    const log = tickAt(sim, 1);
    expect(log.some((l) => l.startsWith("pending batch held: #3"))).toBe(true);
    expect(sim.builds).toHaveLength(builds);
    expect(sim.state.pending.map((p) => p.prs)).toEqual([[3, 4]]);
    expect(sim.state.auth["3"]).toBeDefined();
    set(sim, 3, true);
    tickAt(sim, 1);
    expect(sim.builds.at(-1)!.prs).toEqual([3, 4]);
  });

  test("a solo PR that is held is not built until it is known", () => {
    const sim = new Sim(cfg());
    sim.state = { ...sim.state, solo: [{ pr: 1, lineage: 1, reason: "operator" }], lineages: { "1": { runs: 0 } } };
    sim.add(livePr(1));
    sim.state.auth["1"] = { head: livePr(1).head, baseRepoId: TARGET, policy: "policy-1", policyPr: false, admittedAt: sim.now.toISOString(), labelledAt: livePr(1).ready!.at, evidence: [], reviewRun: null };
    nul(sim, 1);
    const log = tickAt(sim, 1);
    expect(log).toContain("solo #1 held: mergeability not computed yet; not built this tick");
    expect(sim.builds).toHaveLength(0);
    expect(sim.state.solo).toHaveLength(1);
    set(sim, 1, true);
    tickAt(sim, 1);
    expect(sim.builds.map((b) => b.prs)).toEqual([[1]]);
  });

  test("an active batch with a held PR is neither landed nor abandoned until it is known", () => {
    const sim = new Sim(cfg()).add(livePr(1), livePr(2));
    tickAt(sim, 1); // build [1,2]
    nul(sim, 2);
    const log = tickAt(sim, 1);
    expect(log).toContain(`batch ${sim.state.active!.n} held: #2 mergeability not computed yet`);
    expect(sim.landed).toEqual([]);
    expect(sim.state.active?.prs).toEqual([1, 2]);
    set(sim, 2, true);
    tickAt(sim, 1);
    expect(sim.landed).toEqual([[1, 2]]);
  });
});
