// The reader step for queue.strategy's state fields (DESIGN.md §5.7,
// docs/deployment.md §8.1.1): seenRed, parked and adaptive are read, checked
// and written back unchanged by the parser; once each key's writer exists,
// a decision with that key off removes a leftover field.

import { describe, expect, test } from "bun:test";
import { serialise } from "../src/store";
import { emptyState, parseState, type State } from "../src/state";
import { cfg, green, livePr, NAMES, Sim, sha } from "./sim";

const pin = (pr: number) => ({ pr, head: sha(`pr${pr}`) });

/** A state carrying all three fields, as a later step would write them. */
function withStrategy(s: State = emptyState()): State {
  return {
    ...s,
    seenRed: [{ n: 7, base: sha("main0"), pins: [pin(41), pin(42), pin(43)] }],
    parked: { n: 9, base: sha("main0"), head: sha("q9"), pins: [pin(44), pin(45)], depth: 1, lineage: 3, builtAt: "2026-10-21T11:00:00.000Z" },
    adaptive: { size: 6, greens: 2 },
  };
}

const text = (s: unknown) => serialise(s);
const refuses = (s: unknown) => () => parseState(text(s), NAMES);

describe("the reader", () => {
  test("a document carrying them parses and re-serialises byte for byte", () => {
    const t = text(withStrategy());
    expect(serialise(parseState(t, NAMES))).toBe(t);
  });

  test("a document without them is unchanged, and gains none of them", () => {
    const t = text(emptyState());
    const s = parseState(t, NAMES);
    expect(serialise(s)).toBe(t);
    for (const k of ["seenRed", "parked", "adaptive"]) expect(k in s).toBe(false);
  });

  test("with every key off, a decision removes leftover fields", () => {
    const sim = new Sim(cfg(), () => green).add(livePr(1), livePr(2));
    sim.state = withStrategy();
    const before = withStrategy();
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1, 2]]);
    expect(sim.state.seenRed).toBeUndefined();
    expect(sim.state.parked).toBeUndefined();
    expect(sim.state.adaptive).toBeUndefined();
  });

  test("refused: malformed fields", () => {
    const base = withStrategy();
    expect(refuses({ ...base, seenRed: [] })).toThrow("seenRed: empty");
    expect(refuses({ ...base, seenRed: [{ n: 7, base: sha("m"), pins: [pin(1)] }] })).toThrow("fewer than 2");
    expect(refuses({ ...base, seenRed: [{ n: 7, base: sha("m"), pins: [pin(1), pin(1)] }] })).toThrow("duplicate PR");
    expect(refuses({ ...base, seenRed: [{ n: 7, base: "nope", pins: [pin(1), pin(2)] }] })).toThrow("bad sha");
    expect(refuses({ ...base, seenRed: [{ n: 7, base: sha("m"), pins: [pin(1), pin(2)], extra: 1 }] })).toThrow("unexpected key");
    expect(refuses({ ...base, parked: { ...base.parked!, pins: [] } })).toThrow("empty");
    expect(refuses({ ...base, parked: { ...base.parked!, lineage: 0 } })).toThrow("parked.lineage");
    expect(refuses({ ...base, parked: { ...base.parked!, builtAt: "yesterday" } })).toThrow("parked.builtAt");
    expect(refuses({ ...base, adaptive: { size: 0, greens: 0 } })).toThrow("adaptive.size");
    expect(refuses({ ...base, adaptive: { size: 4 } })).toThrow("missing 'greens'");
  });
});
