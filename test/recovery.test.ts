// Input validation (DESIGN.md §11), the state document (§3.1) and recovery
// from the journal (§3.2).

import { describe, expect, test } from "bun:test";
import { decide } from "../src/machine";
import { applyOpResult, interpretObservation } from "../src/ops";
import { emptyState, loadState, parseState, renderState, type State, stateFromIssueBody } from "../src/state";
import { isWritableRef, parseEvent, parsePrNumber, queueRef, runIdFromTargetUrl } from "../src/validate";
import { cfg, green, livePr, NAMES, red, sha, Sim, TARGET_SLUG, LS, TARGET } from "./sim";

function journalledBuild(): Sim {
  const sim = new Sim().add(livePr(1), livePr(2), livePr(3));
  sim.state = decide(sim.state, sim.snapshot(), sim.config).state;
  return sim;
}


describe("events", () => {
  test("only schedule and workflow_dispatch from qlander itself", () => {
    expect(parseEvent("schedule", { repository: { id: LS } }, LS)).toEqual({ kind: "tick" });
    for (const e of ["push", "pull_request", "pull_request_target", "repository_dispatch", "workflow_run", "issue_comment"]) {
      expect(() => parseEvent(e, { repository: { id: LS } }, LS)).toThrow("refusing event");
    }
  });

  test("an event from another repository is refused", () => {
    expect(() => parseEvent("schedule", { repository: { id: TARGET } }, LS)).toThrow("not from the qlander repository");
    expect(() => parseEvent("workflow_dispatch", {}, LS)).toThrow();
  });

  test("a dispatch only wakes the tick: it carries no command (commands are PR labels)", () => {
    const ev = (inputs: object | null) => parseEvent("workflow_dispatch", { repository: { id: LS }, inputs }, LS);
    expect(ev({})).toEqual({ kind: "tick" });
    expect(ev(null)).toEqual({ kind: "tick" });
    for (const inputs of [{ command: "bounce", pr: "1401" }, { command: "tick" }, { pr: "7" }]) expect(() => ev(inputs)).toThrow("takes no inputs");
  });

  test("PR numbers are validated", () => {
    expect(parsePrNumber("1401")).toBe(1401);
    for (const pr of ["0", "-1", "1e3", "12a", "123456789", "1; rm -rf /"]) expect(() => parsePrNumber(pr)).toThrow();
  });

  test("refs: each App writes only its own", () => {
    expect(isWritableRef(NAMES, "main", "queue")).toBe(true);
    expect(isWritableRef(NAMES, "queue/12", "queue")).toBe(true);
    expect(isWritableRef(NAMES, "qlander-build/12", "queue")).toBe(true);
    expect(isWritableRef(NAMES, "release", "queue")).toBe(false);
    expect(isWritableRef(NAMES, "queue/0", "queue")).toBe(false);
    expect(isWritableRef(NAMES, "queue/1/../main", "queue")).toBe(false);
    expect(isWritableRef(NAMES, "release", "release")).toBe(true);
    expect(isWritableRef(NAMES, "main", "release")).toBe(false);
    expect(() => queueRef(NAMES, 0)).toThrow();
  });

  test("qualified target_url must be an Actions run in the target", () => {
    expect(runIdFromTargetUrl(NAMES.target, `https://github.com/${TARGET_SLUG}/actions/runs/123`)).toBe(123);
    for (const u of [
      `https://github.com/evil/${NAMES.target.name}/actions/runs/123`,
      `https://github.com/${TARGET_SLUG}/actions/runs/123/attempts/2`,
      `http://github.com/${TARGET_SLUG}/actions/runs/123`,
      `https://github.com/${TARGET_SLUG}/actions/runs/123?x`,
      null,
    ]) {
      expect(runIdFromTargetUrl(NAMES.target, u)).toBeNull();
    }
  });
});

describe("state document", () => {
  test("round-trips through the issue body", () => {
    const s = emptyState();
    s.seq = 5;
    expect(stateFromIssueBody(renderState(s), NAMES)).toEqual(s);
  });

  test("unknown version, extra keys or a bad sha are refused", () => {
    const s = emptyState();
    expect(() => parseState(JSON.stringify({ ...s, v: 1 }), NAMES)).toThrow("unknown version");
    expect(() => parseState(JSON.stringify({ ...s, extra: 1 }), NAMES)).toThrow("unexpected key");
    const bad: State = { ...s, verify: [{ pr: 1, pin: "nope", landedIn: sha("q"), since: "t", ticks: 0, notified: false }] };
    expect(() => parseState(JSON.stringify(bad), NAMES)).toThrow("bad sha");
    expect(() => parseState("{", NAMES)).toThrow("not JSON");
    expect(() => stateFromIssueBody("no block", NAMES)).toThrow("no state block");
  });
});

describe("journal recovery (#14)", () => {
  function journalled(): Sim {
    const sim = new Sim().add(livePr(1), livePr(2), livePr(3));
    // decide only (no perform), to leave a build journalled
    sim.state = decide(sim.state, sim.snapshot(), sim.config).state;
    return sim;
  }

  test("crash before the build was recorded: aborted, refunded, nothing lost", () => {
    const sim = journalled();
    const j = sim.state.journal!;
    expect(j.op.kind).toBe("build");
    expect(sim.state.window).toHaveLength(1);
    const r = interpretObservation(j, { queueHead: null });
    expect(r.kind).toBe("buildAborted");
    const s = applyOpResult(sim.state, r as never, cfg(), sim.now).state;
    expect(s.journal).toBeNull();
    expect(s.window).toEqual([]);
    expect(s.lineages["1"]).toEqual({ runs: 0 });
    expect(Object.keys(s.auth).sort()).toEqual(["1", "2", "3"]);
    expect(s.outbox.some((n) => n.kind === "deleteRef" && n.ref.startsWith("qlander-build/"))).toBe(true);
  });

  test("crash after the checkpoint but before queue/<n>: resume, adopt survivors, apply recorded drops", () => {
    const sim = journalled();
    const op = sim.state.journal!.op;
    if (op.kind !== "build") throw new Error("expected a build");
    const [p1, p2, p3] = op.pins;
    const head = sha("chain");
    let s = applyOpResult(sim.state, { kind: "checkpoint", record: { survivors: [p1!, p3!], dropped: [{ pr: p2!.pr, pin: p2!.head, outcome: "conflict" }], chainHead: head } }, cfg(), sim.now).state;
    const r = interpretObservation(s.journal!, { queueHead: null });
    expect(r).toEqual({ kind: "resumeBuild", head });
    // runner creates queue/<n> at the recorded head, then reports built
    s = applyOpResult(s, { kind: "built", head }, cfg(), sim.now).state;
    expect(s.active!.prs).toEqual([1, 3]);
    expect(s.auth["2"]).toBeUndefined();
    expect(s.outbox.some((n) => n.kind === "unready" && n.pr === 2)).toBe(true);
  });

  test("checkpoint plus a matching queue ref is adopted; a mismatching one fails and pauses", () => {
    const sim = journalled();
    const op = sim.state.journal!.op;
    if (op.kind !== "build") throw new Error();
    const head = sha("chain");
    const s = applyOpResult(sim.state, { kind: "checkpoint", record: { survivors: op.pins, dropped: [], chainHead: head } }, cfg(), sim.now).state;
    expect(interpretObservation(s.journal!, { queueHead: head, queueChainMatches: true })).toEqual({ kind: "built", head });
    const bad = interpretObservation(s.journal!, { queueHead: sha("other"), queueChainMatches: false });
    expect(bad.kind).toBe("queueMismatch");
    const after = applyOpResult(s, bad as never, cfg(), sim.now).state;
    expect(after.outbox.some((n) => n.kind === "pause")).toBe(true);
    expect(after.active).toBeNull();
  });

  test("land: recovered by ancestry before revalidation, even if the PR head moved since", () => {
    const sim = new Sim().add(livePr(1));
    sim.tick(); // build
    sim.state = decide(sim.state, sim.snapshot(), sim.config).state; // journals land, not performed
    const j = sim.state.journal!;
    expect(j.op.kind).toBe("land");
    // crash; meanwhile the land did go through and the author pushed again
    sim.prs["1"] = { ...sim.prs["1"]!, head: sha("later") };
    const r = interpretObservation(j, { main: sha("anything"), afterReachable: true });
    expect(r.kind).toBe("landed");
    sim.state = applyOpResult(sim.state, r as never, cfg(), sim.now).state;
    expect(sim.state.verify[0]!.pin).toBe(sha("pr1"));
    sim.drain();
    sim.tick();
    expect(sim.comments.some((c) => c.body.startsWith("Landed revision"))).toBe(true);
  });

  test("land: main still at base means not applied; anything else means main moved", () => {
    const j = { seq: 1, op: { kind: "land" as const, before: sha("B"), after: sha("Q") }, reserved: false, at: "t", checkpoint: null, tries: 0 };
    expect(interpretObservation(j, { main: sha("B"), afterReachable: false })).toMatchObject({ kind: "landRejected", retry: true });
    expect(interpretObservation(j, { main: sha("X"), afterReachable: false })).toEqual({ kind: "baseMoved" });
  });

  test("rerun recovery: confirmed by attempt; an unconfirmed request is never resent, and past the deadline it pauses", () => {
    const at = "2026-10-21T12:00:00.000Z";
    const req = [{ runId: 1, attempt: 1, at }, { runId: 2, attempt: 1, at }];
    const j = { seq: 1, op: { kind: "rerun" as const, runs: [], requested: req }, reserved: true, at, checkpoint: null, tries: 0 };
    const t = (min: number) => ({ now: new Date(Date.parse(at) + min * 60_000), reconcileMinutes: 15 });
    expect(interpretObservation(j, { attempts: { "1": 2, "2": 2 } }, undefined, t(1))).toEqual({ kind: "rerunDone", confirmed: [{ runId: 1, attempt: 1 }, { runId: 2, attempt: 1 }] });
    expect(interpretObservation(j, { attempts: { "1": 2, "2": 1 } }, undefined, t(1))).toEqual({ kind: "rerunReconcile", confirmed: [{ runId: 1, attempt: 1 }] });
    expect(interpretObservation(j, { attempts: { "1": 2, "2": 1 } }, undefined, t(20))).toMatchObject({ kind: "opAbandoned" });
    expect(interpretObservation(j, { attempts: { "1": 1 }, missingRuns: [2] }, undefined, t(1))).toMatchObject({ kind: "targetMissing" });
  });

  test("a rejected landing that is not retryable pauses; a transient one does not", () => {
    const sim = new Sim().add(livePr(1));
    sim.tick();
    const s = decide(sim.state, sim.snapshot(), sim.config).state;
    const hard = applyOpResult(s, { kind: "landRejected", retry: false, reason: "ruleset: signatures" }, cfg(), sim.now).state;
    expect(hard.outbox.some((n) => n.kind === "pause")).toBe(true);
    const soft = applyOpResult(s, { kind: "landRejected", retry: true, reason: "502" }, cfg(), sim.now).state;
    expect(soft.outbox.some((n) => n.kind === "pause")).toBe(false);
    expect(soft.active).not.toBeNull();
  });
});

describe("review #2: an existing queue ref that does not match", () => {
  test("keeps the charge, cancels its runs, records the end, then deletes", () => {
    const sim = journalledBuild();
    const op = sim.state.journal!.op;
    if (op.kind !== "build") throw new Error("expected a build");
    const head = sha("chain");
    const s = applyOpResult(sim.state, { kind: "checkpoint", record: { survivors: op.pins, dropped: [], chainHead: head } }, cfg(), sim.now).state;
    const r = interpretObservation(s.journal!, { queueHead: sha("other"), queueChainMatches: false });
    expect(r).toMatchObject({ kind: "queueMismatch", head: sha("other") });
    const after = applyOpResult(s, r as never, cfg(), sim.now).state;
    expect(after.window).toHaveLength(1);
    expect(after.lineages["1"]).toEqual({ runs: 1 });
    const kinds = after.outbox.map((n) => `${n.kind}:${"ref" in n ? n.ref : ""}`);
    const cancel = kinds.findIndex((k) => k.startsWith("cancelRuns:queue/"));
    const del = kinds.findIndex((k) => k.startsWith("deleteRef:queue/"));
    expect(cancel).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(cancel);
    expect(after.outbox.some((n) => n.kind === "pause")).toBe(true);
    expect(after.history.at(-1)).toMatchObject({ outcome: "abandoned", head: sha("other") });
    expect(after.journal).toBeNull();
    expect(Object.keys(after.auth).sort()).toEqual(["1", "2", "3"]);
  });
});

describe("rerun requests: one intent and one receipt each (review #2)", () => {
  test("a request sent but unconfirmed is reconciled, never resent inside the window", () => {
    const two = { kind: "red" as const, policy: false, failedRuns: [{ runId: 1, attempt: 1 }, { runId: 2, attempt: 1 }], failedJobs: [], reason: "x" };
    const sim = new Sim(cfg(), () => two).add(livePr(1));
    sim.tick(); // build
    sim.state = decide(sim.state, sim.snapshot(), sim.config).state; // journals the rerun
    const at = sim.now.toISOString();
    let s = applyOpResult(sim.state, { kind: "rerunSending", run: { runId: 1, attempt: 1 }, at }, cfg(), sim.now).state;
    s = applyOpResult(s, { kind: "rerunConfirmed", run: { runId: 1, attempt: 1 } }, cfg(), sim.now).state;
    s = applyOpResult(s, { kind: "rerunSending", run: { runId: 2, attempt: 1 }, at }, cfg(), sim.now).state;
    // the runner died here: the request for run 2 is ambiguous
    expect(s.journal!.op).toMatchObject({ kind: "rerun", runs: [], done: [{ runId: 1, attempt: 1 }], requested: [{ runId: 2, attempt: 1, at }] });
    const soon = interpretObservation(s.journal!, { attempts: { "1": 2, "2": 1 } }, undefined, { now: sim.now, reconcileMinutes: 15 });
    s = applyOpResult(s, soon as never, cfg(), sim.now).state;
    expect(s.journal!.op).toMatchObject({ runs: [], requested: [{ runId: 2 }] }); // waiting, not resent
    expect(s.lineages["1"]).toEqual({ runs: 2 }); // no new reservation
    const seen = interpretObservation(s.journal!, { attempts: { "1": 2, "2": 2 } }, undefined, { now: sim.now, reconcileMinutes: 15 });
    expect(seen).toMatchObject({ kind: "rerunDone" });
    s = applyOpResult(s, seen as never, cfg(), sim.now).state;
    expect(s.active!.rerun).toEqual([{ runId: 1, attempt: 1 }, { runId: 2, attempt: 1 }]);
  });
});

describe("review #6: the state schema", () => {
  const base = () => JSON.parse(JSON.stringify(emptyState())) as Record<string, unknown>;
  const bad = (mut: (s: any) => void) => {
    const s = base();
    mut(s);
    return () => parseState(JSON.stringify(s), NAMES);
  };

  test("negative or fractional budget accounting is refused", () => {
    expect(bad((s) => (s.lineages = { "1": { runs: -100 } }))).toThrow();
    expect(bad((s) => (s.window = [{ at: "2026-10-21T10:00:00.000Z", cost: -100 }]))).toThrow();
    expect(bad((s) => (s.window = [{ at: "2026-10-21T10:00:00.000Z", cost: 0.5 }]))).toThrow();
    expect(bad((s) => (s.redStreak = -1))).toThrow();
    expect(bad((s) => (s.nextLineage = 0))).toThrow();
  });

  test("bad timestamps, unknown variants and malformed journal ops are refused", () => {
    expect(bad((s) => (s.window = [{ at: "yesterday", cost: 1 }]))).toThrow();
    expect(bad((s) => (s.lastLandedAt = "soon"))).toThrow();
    expect(bad((s) => (s.journal = { seq: 1, op: { kind: "explode" }, reserved: false, at: "2026-10-21T10:00:00.000Z", checkpoint: null, tries: 0 }))).toThrow();
    expect(bad((s) => (s.journal = { seq: 1, op: { kind: "cancel", runs: [], cause: "timeout" }, reserved: false, at: "2026-10-21T10:00:00.000Z", checkpoint: null, tries: 0 }))).toThrow();
    expect(bad((s) => (s.outbox = [{ id: "x", kind: "launch", pr: 1 }]))).toThrow();
    expect(bad((s) => (s.solo = [{ pr: 1, lineage: 1, reason: "whim" }]))).toThrow();
  });

  test("relationships: a land journal needs the matching active batch; a PR is in one place only", () => {
    expect(
      bad((s) => (s.journal = { seq: 1, op: { kind: "land", before: sha("a"), after: sha("b") }, reserved: false, at: "2026-10-21T10:00:00.000Z", checkpoint: null, tries: 0 })),
    ).toThrow();
    const auth = { head: sha("h"), baseRepoId: 1, policy: "p", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: null };
    expect(
      bad((s) => {
        s.auth = { "1": auth };
        s.pending = [{ prs: [1], depth: 1, lineage: 1 }];
        s.solo = [{ pr: 1, lineage: 1, reason: "split" }];
      }),
    ).toThrow();
    expect(bad((s) => (s.pending = [{ prs: [1], depth: 1, lineage: 1 }]))).toThrow(); // no auth for #1
  });

  test("every state the simulator passes through parses", () => {
    const sim = new Sim(cfg(), (b) => (b.prs.includes(3) ? red() : green)).add(livePr(1), livePr(2), livePr(3), livePr(4), livePr(5));
    sim.strict = true;
    sim.runUntilIdle();
    expect(sim.landed.flat().sort()).toEqual([1, 2, 4, 5]);
  });

  test("loadState reports corrupt state instead of throwing, so the runner can pause", () => {
    expect(loadState("nonsense", NAMES)).toMatchObject({ ok: false });
    const good = loadState(renderState(emptyState()), NAMES);
    expect(good.ok).toBe(true);
  });
});
