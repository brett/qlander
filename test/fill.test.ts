// The fill timer: a fresh batch waits for
// minFill PRs at the head of the FIFO, never longer than maxWaitMinutes for
// the oldest admitted PR; run-alone PRs, recovery and operator `go` never wait.

import { describe, expect, test } from "bun:test";
import { decide } from "../src/machine";
import { renderState, stateFromIssueBody } from "../src/state";
import { cfg, cmd, green, livePr, NAMES, red, Sim } from "./sim";

const fill = cfg({ minFill: 4, maxWaitMinutes: 20 });
const ids = (...n: number[]) => n.map((x) => livePr(x));

describe("fill timer", () => {
  test("below minFill, a fresh batch waits", () => {
    const sim = new Sim(fill).add(...ids(1, 2, 3));
    const log = sim.tick();
    expect(sim.builds).toEqual([]);
    expect(Object.keys(sim.state.auth)).toEqual(["1", "2", "3"]);
    expect(log.join("\n")).toContain("filling: 3 of 4 PRs; builds by 2026-10-21T12:20:00.000Z");
  });

  test("reaching minFill builds at once", () => {
    const sim = new Sim(fill).add(...ids(1, 2, 3));
    sim.tick();
    sim.add(livePr(4));
    sim.tick();
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2, 3, 4]]);
  });

  test("the target is capped by the effective batch size after a red streak", () => {
    const sim = new Sim(cfg({ minFill: 4, maxWaitMinutes: 20, minBatch: 1 })).add(...ids(1, 2));
    sim.state.redStreak = 2; // maxBatch 8 >> 2 = 2
    sim.tick();
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2]]);
  });

  test("maxWait builds a lone PR once its admission is maxWaitMinutes old", () => {
    const sim = new Sim(fill).add(livePr(1));
    sim.tick(); // 12:00, admitted
    sim.tick(); // 12:10
    expect(sim.builds).toEqual([]);
    const log = sim.tick(); // 12:20
    expect(sim.builds.map((b) => b.prs)).toEqual([[1]]);
    expect(log.join("\n")).toContain("oldest eligible PR waited 20m");
  });

  test("time behind an active batch counts toward maxWait", () => {
    const sim = new Sim(fill).add(...ids(1, 2, 3, 4));
    sim.tick(); // 12:00: batch [1..4] built
    sim.add(livePr(5)); // admitted at 12:10 while the batch runs
    let ticks = 0;
    while (sim.landed.length === 0 && ticks++ < 10) sim.tick();
    // The batch landed; #5 has been admitted since 12:10. It builds by 12:30 at the latest.
    while (sim.builds.length < 2 && sim.now.getTime() <= Date.parse("2026-10-21T12:30:00Z")) sim.tick();
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2, 3, 4], [5]]);
  });

  test("a policy PR at the head runs alone at once", () => {
    const sim = new Sim(fill).add(livePr(1, { policyPr: true, policyApproval: true }), livePr(2));
    sim.tick();
    expect(sim.builds.map((b) => b.prs)).toEqual([[1]]);
  });

  test("a run-alone PR behind the prefix closes it: the prefix builds without waiting", () => {
    const sim = new Sim(fill).add(livePr(1), livePr(2, { policyPr: true, policyApproval: true }), livePr(3));
    sim.tick();
    expect(sim.builds.map((b) => b.prs)).toEqual([[1]]);
  });

  test("operator go builds now, and is kept until selection reaches fresh candidates", () => {
    const sim = new Sim(fill).add(livePr(1));
    sim.tick();
    expect(sim.builds).toEqual([]);
    const go = cmd("go", 1);
    const log = sim.tick({ commands: [go] });
    expect(sim.builds.map((b) => b.prs)).toEqual([[1]]);
    expect(log.join("\n")).toContain("build: operator go");
    expect(log.join("\n")).not.toContain("bounce");
    expect(sim.prs["1"]!.labels).toContain("ready"); // go is not a bounce
  });

  test("operator go during a batch survives its carrier landing, and builds the next fresh batch", () => {
    const sim = new Sim(fill).add(...ids(1, 2, 3, 4));
    sim.tick(); // batch [1..4] built
    sim.add(livePr(5));
    sim.tick({ commands: [cmd("go", 1)] }); // go on a PR in the batch; consumed into state
    expect(sim.state.go).toBe(true);
    for (let i = 0; i < 5 && sim.builds.length < 2; i++) sim.tick(); // #1 lands and closes; no command any more
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2, 3, 4], [5]]);
    expect(sim.state.go).toBeUndefined();
    expect(sim.now.getTime()).toBeLessThan(Date.parse("2026-10-21T12:50:00Z")); // well before #5's own deadline
  });

  test("a transient revalidation drop does not restart the fill clock", () => {
    const sim = new Sim(fill).add(livePr(1));
    sim.tick(); // 12:00 admitted
    sim.prs["1"] = { ...sim.prs["1"]!, mergeable: null };
    sim.tick(); // 12:10: held, not dropped (src/machine.ts HOLD_MINUTES)
    sim.prs["1"] = { ...sim.prs["1"]!, mergeable: true };
    sim.tick(); // 12:20: eligible since 12:00, so it builds now
    expect(sim.builds.map((b) => b.prs)).toEqual([[1]]);
  });

  test("the decision reports the fill deadline for the wake, and none once it builds", () => {
    const sim = new Sim(fill).add(livePr(1));
    expect(decide(sim.state, sim.snapshot(), sim.config).fillUntil).toBe(Date.parse("2026-10-21T12:20:00Z"));
    sim.add(...ids(2, 3, 4));
    expect(decide(sim.state, sim.snapshot(), sim.config).fillUntil).toBeUndefined();
  });

  test("recovery is not delayed: split halves below minFill run at once", () => {
    const sim = new Sim(fill, (b) => (b.prs.includes(3) ? red() : green)).add(...ids(1, 2, 3, 4));
    const logs: string[] = [];
    for (let i = 0; i < 30 && sim.builds.length < 3; i++) logs.push(...sim.tick());
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2, 3, 4], [1, 2], [3, 4]]);
    expect(logs.filter((l) => l.startsWith("filling"))).toEqual([]);
  });

  test("the timer survives restarts: admittedAt is persisted state", () => {
    const sim = new Sim(fill).add(livePr(1));
    sim.tick(); // 12:00 admitted
    const restarted = new Sim(fill).add(livePr(1));
    restarted.state = stateFromIssueBody(renderState(sim.state), NAMES);
    restarted.now = new Date("2026-10-21T12:19:00Z");
    restarted.tick();
    expect(restarted.builds).toEqual([]);
    restarted.now = new Date("2026-10-21T12:20:00Z");
    restarted.tick();
    expect(restarted.builds.map((b) => b.prs)).toEqual([[1]]);
  });
});
