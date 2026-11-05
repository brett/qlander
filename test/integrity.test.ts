// Integrity of budgets and build records (review finding 6 follow-up): lineage counters and checkpoint survivor heads.

import { describe, expect, test } from "bun:test";
import { decide } from "../src/machine";
import { applyOpResult, interpretObservation } from "../src/ops";
import { emptyState, parseState, type State } from "../src/state";
import { cfg, livePr, NAMES, sha, Sim, TARGET } from "./sim";

const T = "2026-10-21T10:00:00.000Z";
const authFor = (pr: number) => ({ head: sha(`pr${pr}`), baseRepoId: TARGET, policy: "policy-1", policyPr: false, admittedAt: T, labelledAt: T, evidence: [], reviewRun: null });

function journalledBuild(): Sim {
  const sim = new Sim().add(livePr(1));
  sim.state = decide(sim.state, sim.snapshot(), sim.config).state;
  return sim;
}

describe("(a) every referenced lineage has a run counter", () => {
  test("parseState refuses a pending, solo or active lineage with no counter", () => {
    const base = (): State => ({ ...emptyState(), auth: { "1": authFor(1) } });
    expect(() => parseState(JSON.stringify({ ...base(), pending: [{ prs: [1], depth: 1, lineage: 5 }] }), NAMES)).toThrow("lineage 5");
    expect(() => parseState(JSON.stringify({ ...base(), solo: [{ pr: 1, lineage: 5, reason: "split" }] }), NAMES)).toThrow("lineage 5");
    const ok = { ...base(), pending: [{ prs: [1], depth: 1, lineage: 5 }], lineages: { "5": { runs: 1 } } };
    expect(() => parseState(JSON.stringify(ok), NAMES)).not.toThrow();
  });

  test("decide treats a missing counter as exhausted: no further run", () => {
    const sim = new Sim().add(livePr(1));
    sim.strict = false; // bypass the parser to exercise the machine's own guard
    sim.state = { ...emptyState(), auth: { "1": authFor(1) }, pending: [{ prs: [1], depth: 1, lineage: 5 }] };
    sim.tick();
    expect(sim.builds).toEqual([]);
    expect(sim.prs["1"]!.labels).not.toContain("ready");
  });
});

describe("(b) checkpoint survivors must be the pinned, authorised heads", () => {
  test("parseState refuses a survivor whose head differs from its pin", () => {
    const sim = journalledBuild();
    const s = structuredClone(sim.state);
    s.journal!.checkpoint = { survivors: [{ pr: 1, head: sha("evil") }], dropped: [], chainHead: sha("chain") };
    expect(() => parseState(JSON.stringify(s), NAMES)).toThrow("does not match its pin");
  });

  test("parseState refuses a pin whose head differs from the authorisation", () => {
    const sim = journalledBuild();
    const s = structuredClone(sim.state);
    s.auth["1"] = { ...s.auth["1"]!, head: sha("other") };
    expect(() => parseState(JSON.stringify(s), NAMES)).toThrow("authorised head");
  });

  test("a runner-reported checkpoint with a wrong survivor head pauses instead of building", () => {
    const sim = journalledBuild();
    const s = applyOpResult(
      sim.state,
      { kind: "checkpoint", record: { survivors: [{ pr: 1, head: sha("evil") }], dropped: [], chainHead: sha("chain") } },
      cfg(),
      sim.now,
    ).state;
    expect(s.journal).toBeNull();
    expect(s.active).toBeNull();
    expect(s.outbox.some((n) => n.kind === "pause")).toBe(true);
  });

  test("Reproduction: wrong survivor head in a recovered checkpoint never lands", () => {
    const sim = journalledBuild();
    sim.strict = false;
    // A checkpoint that got into state with an unauthorised survivor head.
    const evil = sha("evil");
    const chain = sha("chain");
    sim.state = structuredClone(sim.state);
    sim.state.journal!.checkpoint = { survivors: [{ pr: 1, head: evil }], dropped: [], chainHead: chain };
    // Recover: queue/<n> exists at the recorded head and its chain matches the record.
    const r = interpretObservation(sim.state.journal!, { queueHead: chain, queueChainMatches: true }, sim.state.auth);
    expect(r.kind).toBe("queueMismatch");
    sim.state = applyOpResult(sim.state, r as never, cfg(), sim.now).state;
    expect(sim.state.active).toBeNull();
    expect(sim.state.outbox.some((n) => n.kind === "pause")).toBe(true);
    // Even forcing "built" cannot activate it.
    const forced = structuredClone(sim.state);
    forced.journal = { seq: 1, op: (journalledBuild().state.journal!.op), reserved: true, at: T, checkpoint: { survivors: [{ pr: 1, head: evil }], dropped: [], chainHead: chain }, tries: 0 };
    const after = applyOpResult(forced, { kind: "built", head: chain }, cfg(), sim.now).state;
    expect(after.active).toBeNull();
    // And decide never journals a land.
    sim.drain();
    sim.paused = false;
    const d = decide(after.journal ? { ...after, journal: null } : after, sim.snapshot(), sim.config);
    expect(d.state.journal?.op.kind).not.toBe("land");
  });
});

describe("(b) a pin that is not the authorised head", () => {
  test("a checkpoint consistent with an unauthorised pin is rejected at checkpoint, built and recovery", () => {
    const sim = journalledBuild();
    const s = structuredClone(sim.state);
    const op = s.journal!.op;
    if (op.kind !== "build") throw new Error("expected a build");
    const evil = sha("evil");
    op.pins = [{ pr: 1, head: evil }]; // auth["1"].head is still sha("pr1")
    const rec = { survivors: [{ pr: 1, head: evil }], dropped: [], chainHead: sha("chain") };

    const atCheckpoint = applyOpResult(s, { kind: "checkpoint", record: rec }, cfg(), sim.now).state;
    expect(atCheckpoint.journal).toBeNull();
    expect(atCheckpoint.outbox.some((n) => n.kind === "pause")).toBe(true);

    const withRec = structuredClone(s);
    withRec.journal!.checkpoint = rec;
    const atBuilt = applyOpResult(withRec, { kind: "built", head: sha("chain") }, cfg(), sim.now).state;
    expect(atBuilt.active).toBeNull();
    expect(atBuilt.outbox.some((n) => n.kind === "cancelRuns")).toBe(true);

    expect(interpretObservation(withRec.journal!, { queueHead: sha("chain"), queueChainMatches: true }, withRec.auth).kind).toBe("queueMismatch");
  });
});

describe("a pause waiting in the outbox stops work like snap.paused", () => {
  test("after a rejected checkpoint queues a pause, decide on that state builds nothing", () => {
    const sim = journalledBuild();
    const s = applyOpResult(
      sim.state,
      { kind: "checkpoint", record: { survivors: [{ pr: 1, head: sha("evil") }], dropped: [], chainHead: sha("chain") } },
      cfg(),
      sim.now,
    ).state;
    expect(s.outbox.map((n) => n.kind)).toEqual(["deleteRef", "pause"]);
    const d = decide(s, sim.snapshot(), sim.config); // snapshot.paused is still false
    expect(d.state.journal).toBeNull();
    expect(d.log.join("\n")).toContain("pause pending");
  });

  test("a window-budget pause holds even after the window frees up, until it is applied", () => {
    const sim = new Sim(cfg({ windowBudget: 1, maxBatch: 1, minBatch: 1 })).add(livePr(1), livePr(2));
    sim.state = { ...sim.state, window: [{ at: "2026-10-21T11:59:00.000Z", cost: 1 }] };
    const first = decide(sim.state, sim.snapshot(), sim.config);
    expect(first.state.journal).toBeNull();
    expect(first.state.outbox.some((n) => n.kind === "pause" && n.reason.includes("window budget"))).toBe(true);
    // A day later the window is empty, but the pause has not been applied yet.
    const later = { ...sim.snapshot(), now: new Date("2026-10-22T13:00:00Z") };
    const second = decide(first.state, later, sim.config);
    expect(second.state.journal).toBeNull();
  });

  test("verification still runs while a pause is pending", () => {
    const sim = new Sim().add(livePr(1));
    sim.tick(); // build
    sim.tick(); // land: verify entry for #1
    const s = { ...sim.state, outbox: [{ id: "p:x", kind: "pause" as const, reason: "test" }] };
    const d = decide(s, sim.snapshot(), sim.config); // #1 is merged in the snapshot
    expect(d.state.verify).toEqual([]);
    expect(d.state.journal).toBeNull();
  });
});

describe("state versions", () => {
  test("a v2 document from before reviewRun existed loads, with reviewRun null (rediscover)", () => {
    // The shape written by qlander main 2253c8c (state v2, no reviewRun).
    const v2 = {
      v: 2,
      seq: 7,
      nextLineage: 2,
      journal: null,
      active: null,
      auth: { "1": { head: sha("pr1"), baseRepoId: TARGET, policy: "policy-1", policyPr: false, admittedAt: T, labelledAt: T, evidence: ["run 5", "run 6"] } },
      pending: [{ prs: [1], depth: 1, lineage: 1 }],
      solo: [],
      operatorSolo: [],
      lineages: { "1": { runs: 1 } },
      window: [],
      redStreak: 0,
      bounceStreak: 0,
      lastLandedAt: null,
      verify: [],
      outbox: [],
      history: [],
    };
    const s = parseState(JSON.stringify(v2), NAMES);
    expect(s.v).toBe(5);
    expect(s.auth["1"]!.reviewRun).toBeNull();
    expect(s.pending).toEqual(v2.pending);
  });

  test("other versions are refused", () => {
    for (const v of [1, 6, "5"]) expect(() => parseState(JSON.stringify({ ...emptyState(), v }), NAMES)).toThrow("unknown version");
  });
});

describe("the recorded review run follows the evidence", () => {
  test("revalidation with a different passing run records the replacement", () => {
    const sim = new Sim().add(livePr(1, { review: { ok: true, why: "run 11", run: { runId: 11, attempt: 1 } } }));
    sim.tick(); // admitted (run 11) and built
    expect(sim.state.auth["1"]!.reviewRun).toBe(11);
    sim.prs["1"] = { ...sim.prs["1"]!, review: { ok: true, why: "run 22", run: { runId: 22, attempt: 1 } } };
    const d = decide(sim.state, { ...sim.snapshot(), ci: { kind: "pending", reason: "CI" } }, sim.config);
    expect(d.state.auth["1"]!.reviewRun).toBe(22);
    expect(d.state.active?.prs).toEqual([1]); // still queued, not abandoned
  });
});
