// Each state document records the epoch branch its last lease holder fenced
// ref writes on (docs/deployment.md §3.4), so a successor whose own epoch
// branch differs (a changed epochPrefix, the fence turned on or off) can void
// a frozen holder's authority. This file covers the documents carrying it.

import { describe, expect, test } from "bun:test";
import { emptyReleaseState, parseReleaseState } from "../src/release-state";
import { emptyState, parseState } from "../src/state";
import { NAMES } from "./sim";

const serialise = (s: unknown) => `${JSON.stringify(s, null, 1)}\n`;
const lease = { owner: "123.1.abcd", until: "2026-10-27T12:10:00.000Z", acquiredAt: "2026-10-27T12:00:00.000Z", executor: { runId: 123, attempt: 1, job: "queue" } };

describe("epochBranch: read and written back unchanged", () => {
  test("a queue state that names an epoch branch re-serialises byte for byte, leased or released", () => {
    for (const l of [lease, null]) {
      const text = serialise({ ...emptyState(), lease: l, epochBranch: "ls-epoch/queue" });
      const s = parseState(text, NAMES);
      expect(s.epochBranch).toBe("ls-epoch/queue");
      expect(serialise(s)).toBe(text);
    }
  });

  test("a release state that names an epoch branch re-serialises byte for byte, leased or released", () => {
    for (const l of [lease, null]) {
      const text = serialise({ ...emptyReleaseState(), lease: l, epochBranch: "ls-epoch/release" });
      const s = parseReleaseState(text);
      expect(s.epochBranch).toBe("ls-epoch/release");
      expect(serialise(s)).toBe(text);
    }
  });

  test("a document without it (written with the fence off, or before it was recorded) is unchanged too", () => {
    const q = serialise({ ...emptyState(), lease });
    expect("epochBranch" in parseState(q, NAMES)).toBe(false);
    expect(serialise(parseState(q, NAMES))).toBe(q);
    const r = serialise({ ...emptyReleaseState(), lease });
    expect("epochBranch" in parseReleaseState(r)).toBe(false);
    expect(serialise(parseReleaseState(r))).toBe(r);
  });

  test("anything but a valid branch name is corrupt state", () => {
    for (const bad of [null, 7, "", "a..b", "x/queue.lock", "-x", "a b", "x/queue\n"]) {
      expect(() => parseState(serialise({ ...emptyState(), epochBranch: bad }), NAMES)).toThrow("epochBranch");
      expect(() => parseReleaseState(serialise({ ...emptyReleaseState(), epochBranch: bad }))).toThrow("epochBranch");
    }
  });

  test("no length cap beyond the config's: any epochPrefix the loader accepts yields a branch the reader accepts", () => {
    const long = `${"x".repeat(250)}/release`;
    expect(parseState(serialise({ ...emptyState(), epochBranch: long }), NAMES).epochBranch).toBe(long);
    expect(parseReleaseState(serialise({ ...emptyReleaseState(), epochBranch: long })).epochBranch).toBe(long);
  });

  test("the lease itself takes no new field", () => {
    expect(() => parseState(serialise({ ...emptyState(), lease: { ...lease, epochBranch: "ls-epoch/queue" } }), NAMES)).toThrow("unexpected key");
  });
});
