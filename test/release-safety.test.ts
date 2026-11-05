// Release advance safety (DESIGN.md §3.2, §12.1, §15): the CAS, crashes
// between intent and effect, its own pause, its own lease and fence, dry run,
// and key separation from the queue.

import { describe, expect, test } from "bun:test";
import { GitHubError } from "../src/github/http";
import { CrashError } from "../src/queue";
import { assertOwnKeyOnly, runQueue, runRelease } from "../src/main";
import { releaseDryRun } from "../src/release-runner";
import { defaultReleaseConfig } from "../src/release-config";
import { parseReleaseState, type ReleaseState } from "../src/release-state";
import { FakeTarget } from "./fake-github";
import { BLOB, ReleaseWorld } from "./release-world";
import { sha, QUEUE_TOKEN_ENV, RELEASE_TOKEN_ENV } from "./sim";

describe("compare-and-swap", () => {
  test("a stale CAS: release moves between discovery and the write; nothing is forced", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    const y = w.target.commit([w.R], "hotfix-y");
    w.stateRef.beforeCas = () => {
      // Just as the intent is persisted, a human merges a hotfix into release.
      if (w.release === w.R && w.target.calls.some((c) => c.startsWith("compare"))) w.target.refs.set("release", y);
    };
    const r = await w.ok();
    expect(r.outcome).toBe("moved");
    expect(w.release).toBe(y); // never overwritten
    expect(w.releaseWrites()).toEqual([`updateRef release ${w.R} -> ${a}`]); // one CAS, beforeOid R, rejected
    expect(w.state().history.at(-1)).toMatchObject({ outcome: "moved", from: w.R, to: a });
    expect(w.state().journal).toBeNull();
    w.stateRef.beforeCas = null;
    expect((await w.ok()).outcome).toBe("alert"); // release is now a hotfix off main: diverged
    expect(w.releaseWrites()).toHaveLength(1);
  });

  test("a CAS rejected while release is unchanged (ruleset, permission) pauses the release job only", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    w.target.updateRef = async () => {
      throw new GitHubError("auth", 200, "Repository rule violations found");
    };
    expect((await w.ok()).outcome).toBe("rejected");
    expect(w.issues("release-pause")).toHaveLength(1);
    expect(w.issues("pause")).toEqual([]); // the queue is not paused
    expect((await w.ok()).outcome).toBe("paused");
  });

  test("a rejected CAS records the rejection and the pending pause in one state write", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    const real = w.target.updateRef.bind(w.target);
    w.target.updateRef = async () => {
      throw new GitHubError("auth", 200, "Repository rule violations found");
    };
    // The process dies on the first state write after the rejection is recorded.
    w.stateRef.beforeCas = () => {
      const s = parseReleaseState(w.stateRef.current!.text);
      if (s.history.at(-1)?.outcome === "rejected") throw new CrashError("after-receipt");
    };
    expect(await w.tick()).toBe("crashed");
    expect(w.state().journal).toBeNull();
    expect(w.state().pausePending).not.toBeNull(); // the pause survived the crash
    w.stateRef.beforeCas = null;
    w.target.updateRef = real; // the ruleset is lifted, but nobody has resumed
    w.pastLease();
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.issues("release-pause")).toHaveLength(1);
    expect(w.release).toBe(w.R);
  });

  test("a CAS whose response was lost, after which release moved on to a descendant, is `advanced`", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    const d = w.target.commit([a], "release-hotfix-on-a");
    const real = w.target.updateRef.bind(w.target);
    w.target.updateRef = async (b, x, y) => {
      await real(b, x, y); // R → a lands
      w.target.refs.set("release", d); // and a hotfix lands on top before we look
      throw new GitHubError("server", 502, "bad gateway"); // but the response is lost
    };
    const r = await w.ok();
    expect(r.outcome).toBe("advanced");
    expect(w.state().history.at(-1)).toMatchObject({ outcome: "advanced", from: w.R, to: a, receipt: { from: w.R, to: a } });
    expect(w.state().journal).toBeNull();
    expect(w.release).toBe(d);
  });

  test("a transient CAS failure retries next tick without pausing", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    const real = w.target.updateRef.bind(w.target);
    let fail = true;
    w.target.updateRef = async (b, x, y) => {
      if (fail) {
        fail = false;
        throw new GitHubError("server", 502, "bad gateway");
      }
      return real(b, x, y);
    };
    expect((await w.ok()).outcome).toBe("retry-later");
    expect(w.issues("release-pause")).toEqual([]);
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.release).toBe(a);
  });
});

describe("crash between intent and effect (§3.2)", () => {
  test("crash after the intent: recovery sees release unchanged, decides again, advances once", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    expect(await w.tick({ crash: "after-intent" })).toBe("crashed");
    expect(w.state().journal).toMatchObject({ op: "advance", before: w.R, after: a });
    expect(w.release).toBe(w.R);
    expect((await w.ok()).outcome).toBe("busy"); // the crashed runner's lease is still live
    w.pastLease();
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.release).toBe(a);
    expect(w.releaseWrites()).toHaveLength(1);
    expect(w.state().history.map((h) => h.outcome)).toEqual(["not-applied", "advanced"]);
  });

  test("crash after the effect: recovery records the advance by observation and never writes again", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    expect(await w.tick({ crash: "after-effect" })).toBe("crashed");
    expect(w.release).toBe(a);
    w.pastLease();
    expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: "release is main" });
    expect(w.releaseWrites()).toHaveLength(1);
    expect(w.state().history.at(-1)).toMatchObject({ outcome: "advanced", to: a, receipt: { to: a } });
  });

  test("recovery runs even while paused, but nothing new is decided", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    await w.tick({ crash: "after-effect" });
    await w.repo.createIssue("hold release", "operator", ["release-pause"]);
    w.qualified(w.land());
    w.pastLease();
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.state().journal).toBeNull();
    expect(w.state().history.at(-1)).toMatchObject({ outcome: "advanced", to: a });
    expect(w.release).toBe(a);
  });
});

describe("pause, lease and fence", () => {
  test("an open release-pause issue: no discovery, no write; closing it resumes", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    await w.repo.createIssue("hold", "operator hold", ["release-pause"]);
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.target.calls.some((c) => c.startsWith("compare"))).toBe(false);
    expect(w.releaseWrites()).toEqual([]);
    w.repo.issues.find((i) => i.labels.includes("release-pause"))!.open = false;
    expect((await w.ok()).outcome).toBe("advanced");
  });

  test("the queue's pause issue does not pause release", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    await w.repo.createIssue("queue paused", "budget", ["pause"]);
    expect((await w.ok()).outcome).toBe("advanced");
  });

  test("a pause whose issue cannot be opened stays pending, and pending counts as paused", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    w.target.updateRef = async () => {
      throw new GitHubError("auth", 403, "Resource not accessible by integration");
    };
    const create = w.repo.createIssue.bind(w.repo);
    w.repo.createIssue = async (t, b, l) => {
      if (l.includes("release-pause")) throw new GitHubError("server", 500, "down");
      return create(t, b, l);
    };
    expect((await w.ok()).outcome).toBe("rejected");
    expect(w.state().pausePending).not.toBeNull();
    w.repo.createIssue = create;
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.state().pausePending).toBeNull();
    expect(w.issues("release-pause")).toHaveLength(1);
  });

  test("a runner that lost its lease before the CAS never writes release (the fence)", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    const read = w.stateRef.read.bind(w.stateRef);
    let stalled = false;
    w.stateRef.read = async () => {
      const r = await read();
      // A's fence read before updateRef: A stalls past its lease and B takes over.
      if (!stalled && r && r.text.includes('"op": "advance"') && r.text.includes('"owner": "A"')) {
        stalled = true;
        w.now = new Date(w.now.getTime() + 9 * 60_000);
        w.stateRef.read = read;
        await w.ok({ runId: "B" });
        return read();
      }
      return r;
    };
    const r = await w.ok({ runId: "A" });
    expect(stalled).toBe(true);
    expect(r.outcome).toBe("lost-lock");
    // B recovered A's intent (not applied) and advanced once; A never wrote.
    expect(w.releaseWrites()).toEqual([`updateRef release ${w.R} -> ${a}`]);
    expect(w.release).toBe(a);
  });

  test("a corrupt release state pauses; a missing ref with a mirror issue refuses to start empty", async () => {
    const w = new ReleaseWorld();
    w.stateRef.current = { version: sha("v"), text: '{"v":1,"surprise":true}' };
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.issues("release-pause")).toHaveLength(1);
    const w2 = new ReleaseWorld();
    await w2.ok(); // creates the ref and its mirror
    w2.stateRef.current = null;
    expect((await w2.ok()).outcome).toBe("paused");
    expect(w2.stateRef.current).toBeNull();
  });

  test("the release state parser is strict", () => {
    const good = { v: 1, lease: null, seq: 0, journal: null, pausePending: null, last: null, history: [] };
    expect(parseReleaseState(JSON.stringify(good))).toEqual(good as ReleaseState);
    for (const bad of [{ ...good, v: 2 }, { ...good, extra: 1 }, { ...good, seq: -1 }, { ...good, history: [{ at: "x" }] }]) {
      expect(() => parseReleaseState(JSON.stringify(bad))).toThrow();
    }
    const R = sha("r");
    const C = sha("c");
    const receipt = { from: R, to: R, policyBlob: BLOB, proofRun: 1, evidence: [] };
    const j = { seq: 1, op: "advance", before: R, after: C, receipt, at: "2026-10-22T12:00:00Z" };
    expect(() => parseReleaseState(JSON.stringify({ ...good, journal: j }))).toThrow("receipt does not match");
  });
});

describe("dry run", () => {
  test("decides and writes nothing anywhere: no target write, no state, no lease, no issue", async () => {
    const w = new ReleaseWorld({ dryRun: true });
    w.target.role = "read";
    const a = w.land();
    w.qualified(a);
    const r = await releaseDryRun({ target: w.target, repo: w.repo, stateRef: w.stateRef, cfg: w.cfg });
    expect(r.mode).toBe("dry-run");
    expect(r.decision).toMatchObject({ kind: "advance", to: a });
    expect(w.releaseWrites()).toEqual([]);
    expect(w.release).toBe(w.R);
    expect(w.stateRef.writes).toBe(0);
    expect(w.stateRef.current).toBeNull();
    expect(w.repo.issues).toEqual([]);
  });

  test("a live release tick refuses to run while release advance is held in dry run", async () => {
    const w = new ReleaseWorld({ dryRun: true });
    w.qualified(w.land());
    await expect(w.tick()).rejects.toThrow("held in dry run");
    expect(w.stateRef.writes).toBe(0);
  });

  test("the dry-run target client is read-only, and dry run is the default until G4", async () => {
    await expect(new FakeTarget("read").updateRef("release", sha("a"), sha("b"))).rejects.toThrow("may not write release");
    expect(defaultReleaseConfig.dryRun).toBe(true);
  });
});

describe("keys and entry point (§12.1)", () => {
  const ev = { repository: { id: defaultReleaseConfig.names.control.id } };
  const never = async (): Promise<never> => {
    throw new Error("must not connect");
  };

  test("the release job refuses to start if it can see the queue key, and vice versa", async () => {
    expect(() => assertOwnKeyOnly({ [QUEUE_TOKEN_ENV]: "q" }, "release")).toThrow(QUEUE_TOKEN_ENV);
    expect(() => assertOwnKeyOnly({ [RELEASE_TOKEN_ENV]: "r" }, "queue")).toThrow(RELEASE_TOKEN_ENV);
    await expect(runRelease({ GITHUB_EVENT_NAME: "schedule", [RELEASE_TOKEN_ENV]: "r", [QUEUE_TOKEN_ENV]: "q" }, ev, never)).rejects.toThrow("other App's key");
    await expect(runQueue({ GITHUB_EVENT_NAME: "schedule", [QUEUE_TOKEN_ENV]: "q", [RELEASE_TOKEN_ENV]: "r" }, ev, never)).rejects.toThrow("other App's key");
  });

  test("the release role cannot write main, and the queue role cannot write release", async () => {
    const rel = new FakeTarget("release");
    const root = rel.refs.get("main")!;
    const next = rel.commit([root], "n");
    await expect(rel.updateRef("main", root, next)).rejects.toThrow("may not write main");
    const q = new FakeTarget("queue");
    q.refs.set("release", root);
    await expect(q.updateRef("release", root, next)).rejects.toThrow("may not write release");
  });

  test("runRelease takes only a tick", async () => {
    const w = new ReleaseWorld();
    const clients = async () => ({ target: w.target, repo: w.repo, stateRef: w.stateRef });
    const env = { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "5", GITHUB_RUN_ATTEMPT: "1" };
    expect((await runRelease(env, ev, clients, w.cfg)).outcome).toBe("none");
    await expect(runRelease({ ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }, { ...ev, inputs: { command: "bounce", pr: "3" } }, clients, w.cfg)).rejects.toThrow("takes no inputs");
    await expect(runRelease({ ...env, GITHUB_EVENT_NAME: "push" }, ev, clients, w.cfg)).rejects.toThrow("refusing event");
  });
});
