// Hosted mode (docs/deployment.md §3.3, §3.4): a whole hosted queue against
// the fake GitHub with the epoch fence on, and the handover between lease
// holders whose epoch branches differ. Taking the epoch voids a frozen holder
// only when both fence on the same branch, so the lease records its holder's
// epoch branch, and a successor on another branch (a changed epochPrefix, or
// the fence turned off) advances the holder's branch too before it takes the
// lease. The record is on the state document, not the lease, because a holder
// can keep authority after its lease is released. A holder that wrote without
// the fence cannot be voided at all, so hosted mode refuses to take over its
// expired lease.

import { describe, expect, test } from "bun:test";
import { epochBranchFor, type RunnerContract } from "../src/config";
import { predecessorEpoch } from "../src/config/runner";
import { epochHandover } from "../src/fenced";
import { emptyReleaseState, parseReleaseState, releaseCodec } from "../src/release-state";
import { emptyState, parseState } from "../src/state";
import { LeaseHeldError, queueCodec, StateStore } from "../src/store";
import { FakeStateRef, FakeStateRepo, FakeTarget } from "./fake-github";
import { BASE_CONFIG, NAMES } from "./sim";
import { World } from "./world";
import { ReleaseWorld } from "./release-world";
import { GitHubError } from "../src/github/http";

const HOSTED: RunnerContract = { ...BASE_CONFIG.runner, mode: "hosted", hostKillMinutes: null, takeoverGraceMinutes: 15, epochFence: true, epochPrefix: "q-epoch-a/" };
const SELF: RunnerContract = { ...BASE_CONFIG.runner, mode: "self-hosted-kill", epochFence: false };
const A = "q-epoch-a/";
const B = "q-epoch-b/";
const serialise = (s: unknown) => `${JSON.stringify(s, null, 1)}\n`;

describe("predecessorEpoch: what a job taking its lease does about the recorded epoch branch", () => {
  const on = (mode: RunnerContract["mode"], prefix: string): RunnerContract => ({ ...(mode === "hosted" ? HOSTED : SELF), epochFence: true, epochPrefix: prefix });
  const off: RunnerContract = { ...SELF, epochFence: false };
  test.each([
    ["same branch: taking the epoch voids it", on("hosted", A), `${A}queue`, true, null],
    ["prefix changed: void the old branch", on("hosted", B), `${A}queue`, true, { void: `${A}queue` }],
    ["prefix changed after a release: void it all the same", on("hosted", B), `${A}queue`, false, { void: `${A}queue` }],
    ["prefix changed, self-hosted-kill: void it too", on("self-hosted-kill", B), `${A}queue`, true, { void: `${A}queue` }],
    ["fence turned off: void the old branch", off, `${A}queue`, false, { void: `${A}queue` }],
    ["fence turned on in self-hosted-kill: the host kill bounds the unfenced holder", on("self-hosted-kill", A), undefined, true, null],
    ["hosted after an unfenced holder that released its lease: nothing outstanding to void", on("hosted", A), undefined, false, null],
    ["fence off on both sides (no epoch at all)", off, undefined, true, null],
  ] as const)("%s", (_why, r, recorded, expiredLease, want) => {
    expect(predecessorEpoch(r, "queue", recorded, expiredLease)).toEqual(want);
  });
  test("hosted, taking over an expired lease of a holder that wrote without the fence: refused, since nothing can void it", () => {
    expect(predecessorEpoch(on("hosted", A), "queue", undefined, true)).toEqual({ refuse: expect.stringContaining("without the epoch fence") });
  });
});

/** A world on hosted runners with the fence on, epoch prefix `prefix`. */
function hostedWorld(prefix = A): World {
  const w = new World(() => "pass", { runner: { ...HOSTED, epochPrefix: prefix } });
  w.target.epochBranch = epochBranchFor({ epochPrefix: prefix }, "queue");
  return w;
}

describe("a hosted queue, end to end against the fake GitHub with the fence on", () => {
  test("lands every ready PR; each tick advances its epoch first, and every state write records its branch", async () => {
    const w = hostedWorld();
    for (const n of [1, 2, 3]) w.readyPr(n);
    const recorded: (string | undefined)[] = [];
    const cas = w.stateRef.cas.bind(w.stateRef);
    w.stateRef.cas = async (before, text) => {
      recorded.push(parseState(text, NAMES).epochBranch);
      return cas(before, text);
    };
    const ticks = await w.runUntilIdle();
    expect(w.landed().flat().sort()).toEqual([1, 2, 3]);
    expect(w.target.calls.filter((c) => c.startsWith("advanceEpoch")).length).toBe(ticks);
    expect(w.target.epochRejections).toEqual([]);
    expect(recorded.length).toBeGreaterThan(ticks);
    expect(new Set(recorded)).toEqual(new Set([`${A}queue`]));
    const last = parseState(w.stateRef.current!.text, NAMES);
    expect([last.lease, last.epochBranch]).toEqual([null, `${A}queue`]); // kept after the release
  });

  test("the release job records its branch too, and keeps it after the release", async () => {
    const w = new ReleaseWorld({ runner: { ...HOSTED, epochPrefix: A } });
    w.target.epochBranch = `${A}release`;
    const c = w.land();
    w.qualified(c);
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.release).toBe(c);
    expect(parseReleaseState(w.stateRef.current!.text).epochBranch).toBe(`${A}release`);
  });

  test("with the fence off, nothing records an epoch branch: the documents are exactly as before", async () => {
    const w = new World();
    w.readyPr(1);
    const texts: string[] = [];
    const cas = w.stateRef.cas.bind(w.stateRef);
    w.stateRef.cas = async (before, text) => {
      texts.push(text);
      return cas(before, text);
    };
    await w.runUntilIdle();
    expect(w.landed().flat()).toEqual([1]);
    expect(texts.some((t) => t.includes('"lease": {'))).toBe(true);
    expect(texts.some((t) => t.includes("epochBranch"))).toBe(false);
    expect(w.target.calls.filter((c) => c.startsWith("voidEpoch"))).toEqual([]);
  });
});

describe("changing epochPrefix while a frozen holder exists is fenced", () => {
  /** The operator moves the config to prefix B. */
  const switchToB = (w: World) => {
    w.config = { ...w.config, runner: { ...w.config.runner, epochPrefix: B } };
    w.target.epochBranch = `${B}queue`;
  };
  const unready = (w: World) => {
    const p = w.target.prs.get(1)!.pr;
    p.labels = p.labels.filter((l) => l !== "ready");
  };

  /**
   * Holder H (prefix A) freezes at its main CAS, after the lease check, and
   * `meanwhile` runs. The PR is unreadied first, so no later tick lands the
   * batch itself: any move of main to H's commit is H's own. Then H resumes
   * and sends its land with its A epoch.
   */
  async function frozenHolder(w: World, meanwhile: () => Promise<void>) {
    w.readyPr(1);
    let froze: string | null = null;
    let resumed = false;
    const send = w.target.epochUpdateRefs.bind(w.target);
    w.target.epochUpdateRefs = async (writes, e) => {
      const land = writes.find((x) => x.branch === NAMES.main);
      if (froze === null && land) {
        froze = land.after;
        unready(w);
        await meanwhile();
        // H resumes: its client still fences on its own branch.
        w.target.epochBranch = `${A}queue`;
        resumed = true;
      }
      return send(writes, e);
    };
    for (let i = 0; i < 20 && !resumed; i++) {
      const r = await w.tick({ runId: `H${i}` });
      if (resumed) return { r, after: froze as unknown as string };
    }
    throw new Error("no land was attempted");
  }

  /** H's lease runs out and S, under the new prefix, takes it over. */
  const takeoverUnderB = (w: World, logs: string[][]) => async () => {
    switchToB(w);
    w.now = new Date(w.now.getTime() + 9 * 60_000);
    const s = await w.tick({ runId: "S" });
    if (s !== "crashed") logs.push(s.log);
  };

  test("a successor under the new prefix voids the old branch first, so the frozen land is rejected and main never moves", async () => {
    const w = hostedWorld(A);
    const logs: string[][] = [];
    const { r, after } = await frozenHolder(w, takeoverUnderB(w, logs));
    expect(logs.flat().some((l) => l.includes(`voided the recorded epoch branch ${A}queue`))).toBe(true);
    expect(r === "crashed" ? r : r.outcome).toBe("lost-lock");
    expect(w.mainHistory).not.toContain(after);
  });

  test("without the void, the frozen holder keeps its authority and its land goes through: the hole this closes", async () => {
    const w = hostedWorld(A);
    w.target.voidEpoch = async () => "0".repeat(40); // as before: a successor only advances its own branch
    const { after } = await frozenHolder(w, takeoverUnderB(w, []));
    expect(w.mainHistory).toContain(after);
  });

  test("after a release too: S takes H's lease on the same prefix but fails to advance the epoch and releases; T, under the new prefix, still voids H's branch", async () => {
    for (const withVoid of [true, false]) {
      const w = hostedWorld(A);
      if (!withVoid) w.target.voidEpoch = async () => "0".repeat(40);
      const { r, after } = await frozenHolder(w, async () => {
        w.now = new Date(w.now.getTime() + 9 * 60_000);
        const advance = w.target.advanceEpoch.bind(w.target);
        w.target.advanceEpoch = async () => {
          throw new GitHubError("conflict", 409, "the epoch moved");
        };
        const s = await w.tick({ runId: "S" });
        w.target.advanceEpoch = advance;
        expect(s === "crashed" ? s : s.outcome).toBe("retry-later");
        expect(parseState(w.stateRef.current!.text, NAMES).lease).toBeNull(); // released, H never voided
        switchToB(w);
        await w.tick({ runId: "T" });
      });
      if (withVoid) {
        expect(r === "crashed" ? r : r.outcome).toBe("lost-lock");
        expect(w.mainHistory).not.toContain(after);
      } else expect(w.mainHistory).toContain(after);
    }
  });
});

describe("taking the lease (StateStore.open with the epoch handover)", () => {
  const T0 = new Date("2026-10-27T12:00:00Z");
  const LATER = new Date("2026-10-27T13:00:00Z");
  const expired = { owner: "h.1.x", until: "2026-10-27T12:08:00.000Z", acquiredAt: T0.toISOString(), executor: null };
  const leaseCfg = { leaseMinutes: 8, fenceMarginMinutes: 2 };

  async function setup(lease: object | null, recorded?: string, release = false) {
    const ref = new FakeStateRef();
    ref.clock = () => LATER;
    const text = serialise({ ...(release ? emptyReleaseState() : emptyState()), lease, ...(recorded ? { epochBranch: recorded } : {}) });
    await ref.create(text);
    return { ref, text, target: new FakeTarget(release ? "release" : "queue"), repo: new FakeStateRepo() };
  }
  const openQueue = (s: Awaited<ReturnType<typeof setup>>, r: RunnerContract) => StateStore.open(s.ref, s.repo, "s.1.x", leaseCfg, null, queueCodec(NAMES), epochHandover(s.target, r, "queue", "s.1.x"));

  test("hosted, after an expired holder that wrote without the fence: busy, and the state is left exactly as it was", async () => {
    const s = await setup(expired);
    s.target.epochBranch = `${A}queue`;
    const open = openQueue(s, HOSTED);
    await expect(open).rejects.toBeInstanceOf(LeaseHeldError);
    await expect(open).rejects.toThrow("without the epoch fence");
    expect(s.ref.current!.text).toBe(s.text);
  });

  test("self-hosted-kill turning the fence on: the host kill bounds the holder, so it takes over and records its branch", async () => {
    const s = await setup(expired);
    s.target.epochBranch = `${A}queue`;
    const { state } = await openQueue(s, { ...SELF, epochFence: true, epochPrefix: A });
    expect(state.epochBranch).toBe(`${A}queue`);
    expect(parseState(s.ref.current!.text, NAMES).epochBranch).toBe(`${A}queue`);
    expect(s.target.calls.filter((c) => c.startsWith("voidEpoch"))).toEqual([]);
  });

  test("the fence turned off: the release job voids the recorded branch, and drops the record once it has", async () => {
    const s = await setup(expired, `${A}release`, true);
    s.target.epochBranch = `${A}release`;
    const old = await s.target.advanceEpoch(null, "holder");
    s.target.epochBranch = null;
    const { state, handover } = await StateStore.open(s.ref, s.repo, "s.1.x", leaseCfg, null, releaseCodec(NAMES.releaseLabels.mirror), epochHandover(s.target, { ...SELF, epochFence: false }, "release", "s.1.x"));
    expect(s.target.refs.get(`${A}release`)).not.toBe(old);
    expect(handover).toContain(`voided the recorded epoch branch ${A}release`);
    expect("epochBranch" in state).toBe(false);
    expect("epochBranch" in parseReleaseState(s.ref.current!.text)).toBe(false);
  });

  test("a void that fails (not an epoch chain, or any error) is busy, and the record survives for the next tick", async () => {
    const s = await setup(expired, `${A}queue`);
    s.target.refs.set(`${A}queue`, s.target.refs.get(NAMES.main)!); // a code commit, not an epoch chain
    s.target.epochBranch = `${B}queue`;
    const open = openQueue(s, { ...HOSTED, epochPrefix: B });
    await expect(open).rejects.toBeInstanceOf(LeaseHeldError);
    await expect(open).rejects.toThrow("could not be voided");
    expect(s.ref.current!.text).toBe(s.text);
  });

  test("a recorded branch that reads as missing is created at a new root, never skipped: a lagging read cannot hide it", async () => {
    const s = await setup(null, `${A}queue`);
    s.target.epochBranch = `${B}queue`;
    const { state, handover } = await openQueue(s, { ...HOSTED, epochPrefix: B });
    expect(s.target.calls.some((c) => c.startsWith(`voidEpoch ${A}queue (none)`))).toBe(true);
    expect(s.target.refs.has(`${A}queue`)).toBe(true);
    expect(handover).toContain("voided");
    expect(state.epochBranch).toBe(`${B}queue`);
  });

  test("a live lease is never voided: busy before the handover runs", async () => {
    const s = await setup({ ...expired, until: "2026-10-27T14:00:00.000Z" }, `${A}queue`);
    s.target.epochBranch = `${B}queue`;
    await expect(openQueue(s, { ...HOSTED, epochPrefix: B })).rejects.toBeInstanceOf(LeaseHeldError);
    expect(s.target.calls.filter((c) => c.startsWith("voidEpoch"))).toEqual([]);
  });
});
