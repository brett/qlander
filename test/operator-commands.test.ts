// Operator commands are durable PR labels (DESIGN.md §10), not workflow
// inputs: a dispatch that GitHub coalesces away can no longer lose one. Every
// command that arrives while a tick runs is applied by a later tick, in label
// order, exactly once, and only if a write-access user applied it.

import { describe, expect, test } from "bun:test";
import { GitHubError } from "../src/github/http";
import type { TickResult } from "../src/queue";
import { World } from "./world";
import { NAMES } from "./sim";

const ok = (r: TickResult | "crashed"): TickResult => {
  if (r === "crashed") throw new Error("crashed");
  return r;
};

/** Run `during` once, in the middle of the next tick (on its first state write after the lease). */
function midTick(w: World, during: () => void): void {
  let writes = 0;
  w.stateRef.beforeCas = () => {
    if (++writes === 2) {
      during();
      w.stateRef.beforeCas = null;
    }
  };
}

describe("operator commands are labels, applied in order", () => {
  test("several commands arriving during an active tick are all applied by the next tick, in order", async () => {
    let hold = true; // the first batch's CI is still running while the commands arrive
    const w = new World(() => (hold ? "hang" : "pass"));
    for (const n of [1, 2, 3, 4]) w.readyPr(n);
    await w.untilBuilt();
    expect(w.state().active?.prs).toEqual([1, 2, 3, 4]);
    // While a tick is running: bounce #2, then solo #3, then solo #4 and unsolo #4.
    midTick(w, () => {
      w.command("bounce", 2);
      w.command("solo", 3);
      w.command("solo", 4);
      w.command("unsolo", 4);
    });
    await w.tick();
    expect(w.target.prs.get(2)!.pr.labels).toContain(NAMES.labels.bounce); // not seen by that tick; still durable
    const r = ok(await w.tick());
    const applied = r.log.filter((l) => l.startsWith("operator "));
    expect(applied.map((l) => l.split(" (")[0])).toEqual(["operator bounce #2", "operator solo #3", "operator solo #4", "operator unsolo #4"]);
    expect(w.state().operatorSolo).toEqual([3]); // unsolo #4 came after solo #4
    // Every command label is removed once applied, and #2 is no longer ready.
    for (const n of [2, 3, 4]) expect(w.target.prs.get(n)!.pr.labels.filter((l) => l.startsWith("qlander:"))).toEqual([]);
    expect(w.target.prs.get(2)!.pr.labels).not.toContain("ready");
    hold = false;
    await w.runUntilIdle();
    expect(w.landed().flat()).not.toContain(2);
    expect(w.landed()).toContainEqual([3]);
  });

  test("order is the labels' order: unsolo then solo leaves the PR solo", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    w.command("unsolo", 1);
    w.command("solo", 1);
    await w.tick();
    expect(w.state().operatorSolo).toEqual([1]);
  });

  test("a command is applied once, even if its label removal fails and it stays visible", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.untilBuilt();
    w.command("bounce", 2);
    const remove = w.target.removeLabel.bind(w.target);
    let fail = true;
    w.target.removeLabel = async (n, label) => {
      if (fail && label === NAMES.labels.bounce) throw new GitHubError("server", 502, "Bad Gateway");
      return remove(n, label);
    };
    await w.tick();
    expect(w.target.prs.get(2)!.pr.labels).toContain(NAMES.labels.bounce); // removal failed; the notice is pending
    await w.tick();
    fail = false;
    await w.tick();
    expect(w.target.prs.get(2)!.pr.labels).not.toContain(NAMES.labels.bounce);
    expect(w.target.posted.filter((p) => p.pr === 2 && p.body.includes("Removed from the landing queue by an operator"))).toHaveLength(1);
  });

  test("a command label applied without write access is removed and ignored", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.untilBuilt();
    w.target.permissions.set("drive-by", "triage");
    w.command("bounce", 2, "drive-by");
    const r = ok(await w.tick());
    expect(r.log.join("\n")).toContain("ignored qlander:bounce on #2: applied by drive-by");
    expect(w.target.prs.get(2)!.pr.labels).not.toContain(NAMES.labels.bounce);
    expect(w.target.prs.get(2)!.pr.labels).toContain("ready");
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
  });

  test("an admitted PR whose ready is re-applied without a readable actor leaves the queue", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.untilBuilt();
    w.target.label(2, "ready", null);
    const r = ok(await w.tick());
    expect(r.log).toContain("drop #2: who applied ready is not readable");
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });

  test("a command label whose newest application has no readable actor is refused, even after a writer's", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.untilBuilt();
    w.command("bounce", 2); // a writer's application ...
    w.command("bounce", 2, null); // ... then one GitHub returns without an actor
    const r = ok(await w.tick());
    expect(r.log.join("\n")).toContain("ignored qlander:bounce on #2: who applied it is not readable");
    expect(r.log.some((l) => l.startsWith("operator bounce"))).toBe(false);
    expect(w.target.prs.get(2)!.pr.labels).not.toContain(NAMES.labels.bounce);
    expect(w.target.prs.get(2)!.pr.labels).toContain("ready");
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
  });
});
