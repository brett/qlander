// The priority lane (queue.labels.priority, DESIGN.md §4.4): opt-in; absent,
// nothing changes. A prioritised PR goes before solo, pending and new work,
// builds at once without the fill wait, and only with other prioritised PRs,
// under the same solo filter as any batch. With queue.priority.preempt it may
// stop a running batch whose CI is still pending, once per lineage. The
// label's actor check and the config are in priority-config.test.ts.

import { describe, expect, test } from "bun:test";
import type { LivePr } from "../src/admission";
import type { Config } from "../src/config";
import { decide } from "../src/machine";
import { applyOpResult } from "../src/ops";
import type { Op, State } from "../src/state";
import { cfg, green, livePr, NAMES, red, Sim, sha, HUMAN } from "./sim";

const LABEL = "queue:priority";
const withLabel = (over: Partial<Config> = {}): Config => cfg({ names: { ...NAMES, labels: { ...NAMES.labels, priority: LABEL } }, ...over });
const P = withLabel();
const PREEMPT = withLabel({ priorityPreempt: true });
const pending = () => ({ kind: "pending" as const, reason: "running" });

/** A PR whose priority label counts, applied by `by`. */
const prio = (n: number, over: Partial<LivePr> = {}, by = HUMAN) =>
  livePr(n, { labels: ["ready", LABEL], priority: { actorLogin: by, at: "2026-10-21T11:00:00Z" }, ...over });
const batches = (sim: Sim) => sim.builds.map((b) => b.prs);
const abandoned = (s: State) => s.history.filter((h) => h.outcome === "abandoned");

describe("absent: today's behaviour", () => {
  test("a priority field on a PR is ignored when the label is not configured", () => {
    const sim = new Sim(cfg({ minBatch: 1, maxBatch: 1 })).add(livePr(1), livePr(2), prio(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2], [3]]);
    expect(sim.comments.some((c) => c.body.includes("Prioritised"))).toBe(false);
  });
});

describe("ordering", () => {
  test("a prioritised PR goes before every ordinary PR admitted ahead of it", () => {
    const sim = new Sim(withLabel({ minBatch: 1, maxBatch: 1 })).add(livePr(1), livePr(2), livePr(3), prio(4));
    expect(sim.tick().join("\n")).toContain(`build: priority #4 (applied by ${HUMAN})`);
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[4], [1], [2], [3]]);
  });

  test("prioritised PRs keep FIFO order among themselves", () => {
    const sim = new Sim(withLabel({ minBatch: 1, maxBatch: 1 })).add(livePr(1), prio(2), prio(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[2], [3], [1]]);
  });

  test("it goes before pending recovery work too", () => {
    // [1,2] red, and red on the rerun: split into [1] and [2]; [1] builds at once. Then #3 is prioritised.
    const sim = new Sim(P, (b) => (b.prs.includes(2) ? red() : green)).add(livePr(1), livePr(2));
    while (sim.state.pending.length === 0) sim.tick();
    expect(batches(sim).at(-1)).toEqual([1]);
    sim.add(prio(3));
    sim.runUntilIdle();
    expect(batches(sim).slice(-3)).toEqual([[1], [3], [2]]);
    expect(sim.bounced).toEqual([2]);
  });
});

describe("no fill wait", () => {
  test("a prioritised PR builds at once although the fill target is not met", () => {
    const sim = new Sim(withLabel({ minFill: 4, maxWaitMinutes: 60 })).add(livePr(1), prio(2));
    sim.tick();
    expect(batches(sim)).toEqual([[2]]);
  });

  test("the same queue without priority waits to fill", () => {
    const sim = new Sim(withLabel({ minFill: 4, maxWaitMinutes: 60 })).add(livePr(1), livePr(2));
    expect(sim.tick().join("\n")).toContain("filling");
    expect(batches(sim)).toEqual([]);
  });
});

describe("isolation from ordinary PRs", () => {
  test("prioritised PRs share a batch only with each other", () => {
    const sim = new Sim(P).add(livePr(1), livePr(2), prio(3), prio(4));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[3, 4], [1, 2]]);
  });

  test("a prioritised CI-policy PR still runs alone", () => {
    const sim = new Sim(P).add(prio(1, { policyPr: true, policyApproval: true }), prio(2), prio(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2, 3]]);
  });

  test("with shareBatch, prioritised approved CI-policy PRs share as usual, never with ordinary ones", () => {
    const pol = { policyPr: true, policyApproval: true };
    const sim = new Sim(withLabel({ policyShareBatch: { max: 3 } })).add(livePr(1), prio(2, pol), prio(3, pol), prio(4));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[2, 3], [4], [1]]);
  });

  test("an operator-solo prioritised PR runs alone", () => {
    const sim = new Sim(P).add(prio(1), prio(2));
    sim.state.operatorSolo = [1];
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2]]);
  });

  test("priority skips no gate: an unapproved CI-policy PR or a red fast lane is not admitted", () => {
    const sim = new Sim(P).add(prio(1, { policyPr: true }), prio(2, { fastLane: { ok: false, why: "red" } }), livePr(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[3]]);
    expect(sim.state.auth["1"]).toBeUndefined();
    expect(sim.state.auth["2"]).toBeUndefined();
  });

  test("a prioritised PR held on unknown mergeability (as after a landing) holds ordinary work back", () => {
    const sim = new Sim(P, pending).add(livePr(9));
    sim.tick(); // [9] running
    sim.add(livePr(1), prio(2));
    sim.tick(); // #1 and #2 admitted behind it
    sim.oracle = () => green;
    sim.tick(); // [9] lands
    expect(sim.landed).toEqual([[9]]);
    sim.prs["2"] = { ...sim.prs["2"]!, mergeable: null };
    const d = decide(sim.state, sim.snapshot(), P);
    expect(d.state.journal).toBeNull();
    expect(d.log.join("\n")).toContain("waiting: prioritised #2 held");
    expect(d.holdSince).toBeDefined();
  });
});

describe("label removal and failure", () => {
  test("removing the label mid-queue returns the PR to its FIFO place", () => {
    const sim = new Sim(withLabel({ minBatch: 1, maxBatch: 1 }), pending).add(livePr(1));
    sim.tick(); // [1] running
    sim.add(livePr(2), livePr(3), prio(4));
    sim.tick();
    expect(sim.state.auth["4"]?.priority).toEqual({ by: HUMAN, at: "2026-10-21T11:00:00Z" });
    sim.prs["4"] = { ...livePr(4) };
    expect(sim.tick()).toContain("#4 no longer prioritised");
    expect(sim.state.auth["4"]?.priority).toBeUndefined();
    sim.oracle = () => green;
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2], [3], [4]]);
  });

  test("a prioritised PR that fails is bounced as usual, and the queue goes on", () => {
    const sim = new Sim(P, (b) => (b.prs.includes(3) ? red() : green)).add(livePr(1), livePr(2), prio(3));
    sim.runUntilIdle();
    expect(batches(sim)[0]).toEqual([3]);
    expect(sim.bounced).toEqual([3]);
    expect(sim.landed).toEqual([[1, 2]]);
  });

  test("a red batch of prioritised PRs is split, not rebuilt whole", () => {
    const sim = new Sim(P, (b) => (b.prs.includes(2) ? red() : green)).add(prio(1), prio(2), livePr(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1, 2], [1], [2], [3]]);
    expect(sim.bounced).toEqual([2]);
  });
});

describe("comments and hook events", () => {
  test("queued and landing comments say who applied priority", () => {
    const sim = new Sim(P).add(prio(1, {}, "operator-a"), livePr(2));
    sim.runUntilIdle();
    const body = (pr: number, start: string) => sim.comments.find((c) => c.pr === pr && c.body.startsWith(start))!.body;
    expect(body(1, "Queued in batch")).toContain("Prioritised by operator-a.");
    expect(body(1, "Landed in")).toContain("Prioritised by operator-a.");
    expect(body(2, "Queued in batch")).not.toContain("Prioritised");
    expect(body(2, "Landed in")).not.toContain("Prioritised");
  });

  const startedDetails = (config: Config, prs: LivePr[]) => {
    const sim = new Sim(config).add(...prs);
    const d = decide(sim.state, sim.snapshot(), config);
    const op = d.state.journal!.op as Extract<Op, { kind: "build" }>;
    const chainHead = sha("chain");
    const s1 = applyOpResult(d.state, { kind: "checkpoint", record: { survivors: op.pins, dropped: [], chainHead } }, config, sim.now).state;
    const started = applyOpResult(s1, { kind: "built", head: chainHead }, config, sim.now).events!.find((e) => e.event === "batch_started")!;
    return { admitted: d.events!.filter((e) => e.event === "admitted"), started: started.details };
  };

  test("admitted and batch_started carry details.priority only when there is priority", () => {
    const { admitted, started } = startedDetails(P, [prio(1), livePr(2)]);
    expect(admitted.find((e) => e.prs[0]!.number === 1)!.details).toMatchObject({ priority: { by: HUMAN } });
    expect("priority" in admitted.find((e) => e.prs[0]!.number === 2)!.details).toBe(false);
    expect(started.priority).toEqual([{ number: 1, by: HUMAN }]);
    expect("priority" in startedDetails(P, [livePr(1)]).started).toBe(false);
  });
});

describe("running batch: preempt off (default)", () => {
  test("the running batch is left alone; priority builds right after it lands", () => {
    const sim = new Sim(P, pending).add(livePr(1), livePr(2));
    sim.tick();
    sim.add(prio(3));
    sim.tick();
    sim.tick();
    expect(sim.state.active?.prs).toEqual([1, 2]);
    expect(abandoned(sim.state)).toEqual([]);
    sim.oracle = () => green;
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1, 2], [3]]);
  });

  test("…or right after it fails", () => {
    const sim = new Sim(P, pending).add(livePr(1));
    sim.tick();
    sim.add(livePr(2), prio(3));
    sim.tick();
    sim.oracle = (b) => (b.prs.includes(1) ? red() : green);
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [3], [2]]);
    expect(sim.bounced).toEqual([1]);
  });
});

describe("running batch: queue.priority.preempt", () => {
  const start = () => {
    const sim = new Sim(PREEMPT, pending).add(livePr(1), livePr(2));
    sim.tick(); // batch 1 = [1, 2], CI pending
    sim.add(prio(3));
    return sim;
  };

  test("stops the pending batch through the abandon path, builds the priority batch, then retests the batch in order", () => {
    const sim = start();
    const lineage = sim.state.active!.lineage;
    expect(sim.tick().join("\n")).toContain("build: priority #3");
    expect(abandoned(sim.state)).toMatchObject([{ prs: [1, 2], note: "preempted by priority #3" }]);
    expect(sim.state.active?.prs).toEqual([3]);
    expect(sim.state.pending).toEqual([{ prs: [1, 2], depth: 0, lineage }]);
    expect(sim.comments.filter((c) => c.body.startsWith("Batch 1 was stopped")).map((c) => c.pr)).toEqual([1, 2]);
    sim.oracle = () => green;
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1, 2], [3], [1, 2]]);
    expect(sim.landed).toEqual([[3], [1, 2]]);
  });

  test("the stopped batch's runs are cancelled from the outbox", () => {
    const sim = start();
    const d = decide(sim.state, sim.snapshot(), PREEMPT);
    expect(d.state.outbox.find((n) => n.kind === "cancelRuns")).toMatchObject({ id: "x:1" });
  });

  test("budgets: the stopped run stays charged to the window and its lineage; the retest charges again", () => {
    const sim = start();
    const lineage = String(sim.state.active!.lineage);
    expect(sim.state.window.length).toBe(1);
    sim.tick();
    expect(sim.state.lineages[lineage]).toEqual({ runs: 1, preempted: true });
    expect(sim.state.window.length).toBe(2);
    sim.oracle = () => green;
    sim.runUntilIdle();
    expect(sim.state.lineages[lineage]).toEqual({ runs: 2, preempted: true });
    expect(sim.state.window.length).toBe(3);
  });

  test("a lineage is preempted at most once: the retested batch runs to the end", () => {
    const sim = start();
    sim.tick(); // preempted; [3] built
    sim.oracle = (b) => (b.prs.includes(3) ? green : pending());
    sim.tick(); // [3] lands
    sim.tick(); // [1, 2] rebuilt, pending
    expect(sim.state.active?.prs).toEqual([1, 2]);
    sim.add(prio(4));
    expect(sim.tick().join("\n")).toContain("not preempted: its lineage was preempted once already");
    expect(sim.state.active?.prs).toEqual([1, 2]);
  });

  test("safe point: a batch whose CI is green lands; it is never stopped", () => {
    const sim = start();
    sim.oracle = () => green;
    sim.tick();
    expect(sim.landed).toEqual([[1, 2]]);
    sim.runUntilIdle();
    expect(abandoned(sim.state)).toEqual([]);
    expect(batches(sim)).toEqual([[1, 2], [3]]);
  });

  test("safe point: a red batch is handled as red (rerun), not stopped", () => {
    const sim = start();
    sim.oracle = () => red();
    sim.tick();
    expect(sim.reruns).toBe(1);
    expect(abandoned(sim.state)).toEqual([]);
  });

  test("safe point: a batch held on mergeability is not stopped", () => {
    const sim = start();
    sim.prs["1"] = { ...sim.prs["1"]!, mergeable: null };
    const d = decide(sim.state, sim.snapshot(), PREEMPT);
    expect(abandoned(d.state)).toEqual([]);
    expect(d.state.active?.prs).toEqual([1, 2]);
  });

  test("a batch that carries a prioritised PR is never stopped", () => {
    const sim = new Sim(PREEMPT, pending).add(prio(1));
    sim.tick();
    sim.add(prio(2));
    expect(sim.tick().join("\n")).toContain("not preempted: it carries a prioritised PR");
    expect(sim.state.active?.prs).toEqual([1]);
  });

  test("not when the window budget could not pay for the priority build", () => {
    const sim = start();
    sim.config = withLabel({ priorityPreempt: true, windowBudget: 1 });
    sim.tick();
    expect(abandoned(sim.state)).toEqual([]);
    expect(sim.state.active?.prs).toEqual([1, 2]);
  });

  test("not for a prioritised PR that is held", () => {
    const sim = start();
    sim.prs["3"] = { ...sim.prs["3"]!, mergeable: null };
    sim.tick();
    expect(sim.state.active?.prs).toEqual([1, 2]);
  });

  test("not for a label that does not count (no write access)", () => {
    const sim = new Sim(PREEMPT, pending).add(livePr(1));
    sim.tick();
    sim.add({ ...livePr(2), labels: ["ready", LABEL], priorityIgnored: "applied by someone, who has no write access" });
    expect(sim.tick()).toContain("#2: priority label ignored: applied by someone, who has no write access");
    expect(sim.state.active?.prs).toEqual([1]);
  });

  test("not when the lineage has no run left for the retest", () => {
    const sim = start();
    sim.config = withLabel({ priorityPreempt: true, lineageBudget: 1 });
    expect(sim.tick().join("\n")).toContain("not preempted: its lineage has no run left for the retest");
    expect(sim.state.active?.prs).toEqual([1, 2]);
  });

  test("a PR running from solo goes back to the front of solo, ahead of its split siblings", () => {
    // maxSplitDepth 0: a red [1,2] goes straight to solo [1], [2]; [1] then runs with CI pending.
    const sim = new Sim(withLabel({ priorityPreempt: true, maxSplitDepth: 0 }), (b) => (b.prs.length === 2 ? red() : pending())).add(livePr(1), livePr(2));
    while (!(sim.state.active?.prs.length === 1)) sim.tick();
    expect(sim.state.active?.prs).toEqual([1]);
    expect(sim.state.solo.map((x) => x.pr)).toEqual([2]);
    sim.add(prio(3));
    sim.tick();
    expect(sim.state.active?.prs).toEqual([3]);
    expect(sim.state.solo.map((x) => x.pr)).toEqual([1, 2]);
    expect(sim.state.pending).toEqual([]);
    sim.oracle = (b) => (b.prs.length === 2 ? red() : green);
    sim.runUntilIdle();
    expect(batches(sim).slice(-3)).toEqual([[3], [1], [2]]);
  });
});
