// Linear landing's two writes (DESIGN.md §7.4): the PR branches move first and
// main second, because GitHub marks a PR merged only if its head was already at
// a commit the main push reaches. Each write guards, on GitHub's write path,
// what the other relies on. Every way out that does not land settles the
// branches first. Also: what verify says about a landed PR that ends closed
// without the merged mark.

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { DEFAULT_LINEAR_BODY } from "../src/config/load";
import { GitHubError } from "../src/github/http";
import { interpretObservation } from "../src/ops";
import { NAMES, sha } from "./sim";
import { type BatchCi, type CiOutcome, World } from "./world";

const LINEAR: NonNullable<Config["landing"]> = { mode: "linear", body: DEFAULT_LINEAR_BODY, author: "app", maxRefusals: 3 };
const linearWorld = (oracle: (b: BatchCi) => CiOutcome = () => "pass", over: Partial<Config> = {}) => new World(oracle, { landing: LINEAR, ...over });

function pr(w: World, n: number) {
  const p = w.readyPr(n);
  p.pr.title = `Change number ${n}`;
  return p;
}

const pauseText = (w: World) => w.repo.issues.filter((i) => i.open && i.labels.includes(NAMES.controlLabels.pause)).map((i) => i.body).join(" ");

async function crashBetween(w: World): Promise<void> {
  let crashed = false;
  for (let i = 0; i < 20 && !crashed; i++) crashed = (await w.tick({ crashWhen: (p) => p === "after-branches" })) === "crashed";
  expect(crashed).toBe(true);
}

describe("the two writes", () => {
  test("branches first with main guarded, then main with every branch guarded", async () => {
    const w = linearWorld();
    const before = [1, 2].map((n) => pr(w, n).pr.head.sha);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    const stack = [1, 2].map((n) => w.target.prs.get(n)!.pr.head.sha);
    expect(w.target.branchMoves).toEqual([{ guard: { branch: NAMES.main, at: w.mainHistory[0]! }, moves: [1, 2].map((n, i) => ({ branch: `feat/pr-${n}`, before: before[i]!, after: stack[i]! })) }]);
    expect(w.target.landings).toEqual([{ main: { branch: NAMES.main, before: w.mainHistory[0]!, after: stack[1]! }, pinned: [1, 2].map((n, i) => ({ branch: `feat/pr-${n}`, at: stack[i]! })) }]);
    expect(w.target.calls.filter((c) => c.startsWith("moveBranches") || c.startsWith("landStack")).map((c) => c.split(" ")[0])).toEqual(["moveBranches", "landStack"]);
  });
});

describe("GitHub processes a branch move in the background", () => {
  test("main waits until every PR reads at its stack commit, so each ends merged", async () => {
    const w = linearWorld();
    for (const n of [1, 2]) pr(w, n);
    w.target.headProcessingReads = 4;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
    expect(w.target.branchMoves).toHaveLength(1);
  });

  test("not processed in time: main does not move, the branches go back, and a later try lands", async () => {
    const w = linearWorld();
    const before = pr(w, 1).pr.head.sha;
    w.target.headProcessingReads = 100_000;
    await w.tick();
    for (let i = 0; i < 10 && w.target.branchMoves.length < 2; i++) await w.tick();
    expect(w.target.landings).toEqual([]);
    expect(w.target.prs.get(1)!.pr.head.sha).toBe(before);
    // The PR's read lags behind the move back too: that is not a push, so nothing is dropped.
    for (let i = 0; i < 2; i++) await w.tick();
    expect(w.state().journal?.op.kind).toBe("land");
    expect(w.paused()).toBe(false);
    expect(w.comments(1).some((c) => c.startsWith("Removed from"))).toBe(false);
    w.target.processAll();
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });

  test("a push while it waits: the wait ends at once, landStack refuses, and the push stays", async () => {
    const w = linearWorld();
    for (const n of [1, 2]) pr(w, n);
    const move = w.target.moveBranches.bind(w.target);
    let pushed = "";
    w.target.moveBranches = async (g, m, e) => {
      await move(g, m, e);
      if (!pushed && m.some((x) => x.before !== x.after)) pushed = w.target.push(2);
    };
    await w.runUntilIdle();
    expect(w.target.prs.get(2)!.pr.head.sha).toBe(pushed);
    expect(w.target.prs.get(2)!.pr.merged).toBe(false);
    expect(w.landed()).toEqual([[1]]);
  });
});

describe("between the writes", () => {
  /** Run `act` after the branches moved and before main does, once. */
  function between(w: World, act: () => void): void {
    const land = w.target.landStack.bind(w.target);
    let done = false;
    w.target.landStack = async (m, p, e) => {
      if (!done) {
        done = true;
        act();
      }
      return land(m, p, e);
    };
  }

  test("an author push: main does not move, the others go back, the push stays, that PR is dropped and the rest land", async () => {
    const w = linearWorld();
    const before = [1, 2, 3].map((n) => pr(w, n).pr.head.sha);
    let pushed = "";
    between(w, () => {
      pushed = w.target.push(2);
    });
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    const restore = w.target.branchMoves[1]!;
    expect(restore.moves.filter((x) => x.before !== x.after).map((x) => [x.branch, x.after])).toEqual([["feat/pr-1", before[0]!], ["feat/pr-3", before[2]!]]);
    // The pushed branch is guarded in the same write, never moved.
    expect(restore.moves.find((x) => x.branch === "feat/pr-2")).toEqual({ branch: "feat/pr-2", before: pushed, after: pushed });
    const p2 = w.target.prs.get(2)!.pr;
    expect([p2.head.sha, p2.merged, p2.labels.includes(NAMES.labels.ready)]).toEqual([pushed, false, false]);
    expect(w.comments(2).some((c) => c.startsWith("Removed from the landing queue: head moved"))).toBe(true);
    expect(w.landed()).toEqual([[1, 3]]);
    for (const n of [1, 3]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
    for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
  });

  test("the branch deleted: refused the same way, and the rest land", async () => {
    const w = linearWorld();
    for (const n of [1, 2]) pr(w, n);
    between(w, () => {
      w.target.prs.get(2)!.pr.head.ref = "renamed-away";
    });
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.target.prs.get(2)!.pr.merged).toBe(false);
    expect(w.landed()).toEqual([[1]]);
  });

  test("main moved: every branch goes back, guarded on main as read, and the batch is rebuilt on it", async () => {
    const w = linearWorld();
    const before = [1, 2].map((n) => pr(w, n).pr.head.sha);
    let glass = "";
    between(w, () => {
      const main = w.target.refs.get(NAMES.main)!;
      glass = w.target.commit([main], "break-glass");
      w.target.githubUpdateRefs(NAMES.main, main, glass);
    });
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    const restore = w.target.branchMoves[1]!;
    expect(restore.guard).toEqual({ branch: NAMES.main, at: glass });
    expect(restore.moves.map((x) => x.after)).toEqual(before);
    expect(w.state().history.some((x) => x.outcome === "rebuilt")).toBe(true);
    expect(w.landed()).toEqual([[1, 2]]);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
    for (const m of w.mainHistory.slice(1).filter((m) => m !== glass)) expect(w.greenHeads.has(m)).toBe(true);
  });

  test("main refused for no stated reason: the branches go back in the same tick, it counts, and it is resent", async () => {
    const w = linearWorld();
    const before = pr(w, 1).pr.head.sha;
    w.target.refuseLandings = 1;
    const seen: string[] = [];
    await w.tick();
    for (let i = 0; i < 30 && w.landed().length === 0; i++) {
      await w.tick();
      if ((w.state().journal?.op as { refused?: number } | undefined)?.refused === 1) seen.push(w.target.prs.get(1)!.pr.head.sha);
    }
    expect(seen[0]!).toBe(before);
    expect(w.landed()).toEqual([[1]]);
    expect(w.verdicts).toHaveLength(1);
    await w.runUntilIdle();
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });

  test("a crash between them: restored on the next tick, resent only after revalidating, and it lands", async () => {
    const w = linearWorld();
    const before = pr(w, 1).pr.head.sha;
    await crashBetween(w);
    expect(w.target.prs.get(1)!.pr.head.sha).toBe((w.state().journal!.op as { after: string }).after);
    expect(w.target.refs.get(NAMES.main)).toBe(w.mainHistory[0]!);
    await w.tick();
    expect(w.target.prs.get(1)!.pr.head.sha).toBe(before);
    expect(w.state().journal?.op.kind).toBe("land");
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
    expect(w.comments(1).some((c) => c.startsWith("Removed from"))).toBe(false);
  });

  test("a crash between them, then a pause: nothing moves until it closes, and the log names the branch", async () => {
    const w = linearWorld();
    pr(w, 1);
    await crashBetween(w);
    const stack = w.target.prs.get(1)!.pr.head.sha;
    await w.repo.createIssue("stop", "stop", [NAMES.controlLabels.pause]);
    const r = await w.tick();
    expect(r !== "crashed" && r.outcome).toBe("paused");
    expect(r !== "crashed" && r.log.some((l) => l.includes("feat/pr-1") && l.includes(stack))).toBe(true);
    expect(w.target.prs.get(1)!.pr.head.sha).toBe(stack);
    for (const i of w.repo.issues) i.open = false;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });
});

describe("lost responses and lagging reads", () => {
  const lost = () => new GitHubError("server", 502, "Bad gateway");

  test("the first write applied, its response lost: back on the same tick, resent, and it lands", async () => {
    const w = linearWorld();
    pr(w, 1);
    const move = w.target.moveBranches.bind(w.target);
    let first = true;
    w.target.moveBranches = async (g, m, e) => {
      await move(g, m, e);
      if (first) {
        first = false;
        throw lost();
      }
    };
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.branchMoves).toHaveLength(3); // forward, back, forward
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });

  test("main applied, its response lost, main read fresh: landed", async () => {
    const w = linearWorld();
    pr(w, 1);
    const land = w.target.landStack.bind(w.target);
    w.target.landStack = async (m, p, e) => {
      await land(m, p, e);
      throw lost();
    };
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.branchMoves).toHaveLength(1);
  });

  test("main applied, its response lost, and main's read lags: the restore is refused on the write path, so a landed batch is never unwound", async () => {
    const w = linearWorld();
    pr(w, 1);
    const land = w.target.landStack.bind(w.target);
    w.target.landStack = async (m, p, e) => {
      await land(m, p, e);
      w.target.staleMain = { value: m.before, reads: 1 };
      throw lost();
    };
    const log: string[] = [];
    await w.tick();
    for (let i = 0; i < 30 && w.landed().length === 0; i++) {
      const t = await w.tick();
      if (t !== "crashed") log.push(...t.log);
    }
    expect(log.some((l) => l.startsWith("landing unsettled"))).toBe(true);
    expect(w.landed()).toEqual([[1]]);
    await w.runUntilIdle();
    expect(w.target.branchMoves).toHaveLength(1);
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });

  test("main applied, its response lost, and someone fast-forwarded main past it: still landed, by ancestry", async () => {
    const w = linearWorld();
    pr(w, 1);
    const land = w.target.landStack.bind(w.target);
    w.target.landStack = async (m, p, e) => {
      await land(m, p, e);
      w.target.githubUpdateRefs(NAMES.main, m.after, w.target.commit([m.after], "descendant"));
      throw lost();
    };
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.branchMoves).toHaveLength(1);
  });

  /** The next reads of the branch, and of the PR, still show the admitted head. */
  function staleAtAdmitted(w: World, reads: number, pullReads = reads): string {
    const admitted = (w.state().journal!.op as { heads: { before: string }[] }).heads[0]!.before;
    const branch = w.target.getPrBranch.bind(w.target);
    const pull = w.target.getPr.bind(w.target);
    let staleBranch = reads;
    let stalePull = pullReads;
    w.target.getPrBranch = async (b) => (staleBranch-- > 0 ? admitted : branch(b));
    w.target.getPr = async (n) => {
      const p = await pull(n);
      if (stalePull-- > 0) p.head.sha = admitted;
      return p;
    };
    return admitted;
  }

  test("a crash after the first write, then reads still at the admitted head: the resend is refused on the write path, nothing is dropped, and it lands", async () => {
    const w = linearWorld();
    pr(w, 1);
    await crashBetween(w);
    const moves = w.target.branchMoves.length;
    const move = w.target.moveBranches.bind(w.target);
    let refused = 0;
    w.target.moveBranches = (g, m, e) => move(g, m, e).catch((err) => {
      refused++;
      throw err;
    });
    staleAtAdmitted(w, 1, 4);
    await w.runUntilIdle();
    expect(refused).toBeGreaterThan(0);
    expect(w.target.branchMoves.length).toBeGreaterThan(moves);
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
    expect(w.comments(1).some((c) => c.startsWith("Removed from"))).toBe(false);
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });

  test("a resend no longer valid, with reads stale at the admitted head: the op cannot end until the write path agrees", async () => {
    const w = linearWorld();
    pr(w, 1);
    await crashBetween(w);
    const before = (w.state().journal!.op as { heads: { before: string }[] }).heads[0]!.before;
    staleAtAdmitted(w, 2, 4); // observation and the settling read; the snapshot's PR reads
    w.config = { ...w.config, maxBatch: w.config.maxBatch + 1 }; // the policy changes: the resend does not revalidate
    const t = await w.tick();
    expect(t !== "crashed" && t.log.some((l) => l.startsWith("landing unsettled"))).toBe(true);
    expect(w.state().journal?.op.kind).toBe("land");
    await w.tick();
    expect(w.target.prs.get(1)!.pr.head.sha).toBe(before);
    await w.tick();
    expect(w.state().journal).toBeNull();
    expect(w.target.landings).toEqual([]);
  });

  test("a branch that reads absent once: not taken for a deleted one; it is moved back", async () => {
    const w = linearWorld();
    const before = pr(w, 1).pr.head.sha;
    await crashBetween(w);
    const read = w.target.getPrBranch.bind(w.target);
    let absent = 2; // the observation and the first settling read
    w.target.getPrBranch = async (b) => (absent-- > 0 ? null : read(b));
    await w.tick();
    expect(w.target.prs.get(1)!.pr.head.sha).toBe(before);
    expect(w.state().journal?.op.kind).toBe("land");
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });

  test("a push refuses main, and the other PR's read lags behind its move back: the journal waits, so that PR is not dropped as a push", async () => {
    const w = linearWorld();
    for (const n of [1, 2]) pr(w, n);
    const land = w.target.landStack.bind(w.target);
    let first = true;
    w.target.landStack = async (m, p, e) => {
      if (first) {
        first = false;
        w.target.push(2);
        w.target.headProcessingReads = 1000; // the move back takes GitHub a while
      }
      return land(m, p, e);
    };
    for (let i = 0; i < 12 && w.target.branchMoves.length < 2; i++) await w.tick();
    expect(w.state().journal?.op.kind).toBe("land");
    expect(w.comments(1).some((c) => c.startsWith("Removed from"))).toBe(false);
    w.target.processAll();
    await w.runUntilIdle();
    expect(w.comments(1).some((c) => c.startsWith("Removed from"))).toBe(false);
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });

  test("a restore that keeps being refused: journal kept, it pauses only past the reconcile window naming the branch and head, and finishes after resuming", async () => {
    const w = linearWorld();
    const before = pr(w, 1).pr.head.sha;
    await crashBetween(w);
    w.target.refuseBranchMoves = 1000;
    const since = Date.parse(w.state().journal!.at);
    for (let i = 0; i < 60 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    expect(w.now.getTime() - since).toBeGreaterThanOrEqual(w.config.reconcileMinutes * 60_000);
    expect(w.state().journal?.op.kind).toBe("land");
    expect(pauseText(w)).toContain("feat/pr-1");
    expect(pauseText(w)).toContain(before);
    w.target.refuseBranchMoves = 0;
    for (const i of w.repo.issues) i.open = false;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.prs.get(1)!.pr.merged).toBe(true);
  });
});

describe("interpretObservation, linear", () => {
  const op = { kind: "land" as const, before: sha("B"), after: sha("S2"), heads: [{ pr: 1, ref: "a", before: sha("H1"), after: sha("S1") }, { pr: 2, ref: "b", before: sha("H2"), after: sha("S2") }] };
  const j = { seq: 1, op, reserved: false, at: "2026-10-21T12:00:00Z", checkpoint: null, tries: 0 } as never;
  const at = (a: string, b: string | null) => ({ "1": a, "2": b });
  test("only main at its base and every branch at its admitted head may resend; anything else settles first", () => {
    const see = (main: string, a: string, b: string | null) => interpretObservation(j, { main, afterReachable: false, heads: at(a, b) }).kind;
    expect(see(sha("B"), sha("H1"), sha("H2"))).toBe("retryLand");
    expect(see(sha("B"), sha("S1"), sha("H2"))).toBe("settleLand");
    expect(see(sha("B"), sha("H1"), sha("x"))).toBe("settleLand");
    expect(see(sha("B"), sha("H1"), null)).toBe("settleLand");
    expect(see(sha("M"), sha("H1"), sha("H2"))).toBe("settleLand");
    expect(interpretObservation(j, { afterReachable: false }).kind).toBe("settleLand");
    expect(interpretObservation(j, { main: sha("S2"), afterReachable: true }).kind).toBe("landed");
  });
});

describe("a landed PR that ends closed, not merged", () => {
  async function landed(w: World) {
    w.target.mergeLag = 100000; // GitHub never marks it in this test
    await w.untilBuilt();
    for (let i = 0; i < 6 && w.landed().length === 0; i++) await w.tick();
    expect(w.landed()).toEqual([[1]]);
    w.target.prs.get(1)!.pr.state = "closed";
  }

  test("linear: it waits for a late mark, then says so once and removes ready", async () => {
    const w = linearWorld();
    const admitted = pr(w, 1).pr.head.sha;
    await landed(w);
    await w.tick();
    expect(w.comments(1).some((c) => c.includes("closed this PR"))).toBe(false);
    expect(w.state().verify).toHaveLength(1);
    w.now = new Date(w.now.getTime() + 16 * 60_000);
    await w.tick();
    await w.tick();
    const said = w.comments(1).filter((c) => c.includes("closed this PR"));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(admitted);
    expect(w.target.prs.get(1)!.pr.labels.includes(NAMES.labels.ready)).toBe(false);
    expect(w.state().verify).toEqual([]);
  });

  test("a mark that arrives during the wait says nothing", async () => {
    const w = linearWorld();
    pr(w, 1);
    await landed(w);
    await w.tick();
    w.target.prs.get(1)!.pr.merged = true;
    w.now = new Date(w.now.getTime() + 16 * 60_000);
    await w.tick();
    await w.tick();
    expect(w.comments(1).some((c) => c.includes("closed this PR"))).toBe(false);
    expect(w.state().verify).toEqual([]);
  });

  test("merge mode: unchanged, the entry goes and nothing is posted", async () => {
    const w = new World();
    w.readyPr(1);
    await landed(w);
    const n = w.comments(1).length;
    await w.tick();
    await w.tick();
    expect(w.comments(1)).toHaveLength(n);
    expect(w.state().verify).toEqual([]);
    expect(w.target.prs.get(1)!.pr.labels.includes(NAMES.labels.ready)).toBe(true);
  });
});
