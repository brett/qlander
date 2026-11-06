// Linear landing (queue.landing.mode: linear, DESIGN.md §7.4): each PR lands
// as one squashed commit on a linear stack, and the one atomic updateRefs that
// moves main also moves each PR's head branch to its own stack commit, so
// GitHub marks it merged. Merge mode is everything else in the suite.
//
// The in-memory GitHub models: trees (a merge's tree holds both parents'
// changes; a created commit takes the tree it is given), PR branches (a PR's
// head is its branch), the merged-state rule (a PR whose head is reachable
// from main is marked merged, mergeLag ticks later), and updateRefs' atomicity
// (every entry, forced or not, checked against its beforeOid before any
// moves). The merged-state rule and the atomicity are GitHub's documented
// behaviour; they are checked on real GitHub only by the sandbox checklist.

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { DEFAULT_LINEAR_BODY, parseConfig } from "../src/config/load";
import { fenced } from "../src/fenced";
import { TargetClient } from "../src/github/target";
import { headsVerdict } from "../src/ops";
import { type CrashPoint, linearMessage, policyHash } from "../src/queue";
import { parseState } from "../src/state";
import { LostLockError } from "../src/store";
import { FakeTarget } from "./fake-github";
import { APPROVERS, job, NAMES, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, pathRe, sha, TARGET, TARGET_OPTS, TARGET_SLUG } from "./sim";
import { type BatchCi, type CiOutcome, World } from "./world";

const LINEAR: NonNullable<Config["landing"]> = { mode: "linear", body: DEFAULT_LINEAR_BODY };

function linearWorld(oracle: (b: BatchCi) => CiOutcome = () => "pass", over: Partial<Config> = {}): World {
  return new World(oracle, { landing: LINEAR, ...over });
}

/** A ready PR with a title, as the merge commit message and the stack subject read it. */
function pr(w: World, n: number, o: { files?: string[] } = {}) {
  const p = w.readyPr(n, o);
  p.pr.title = `Change number ${n}`;
  return p;
}

/** main's history, newest first, down to the root: every commit and its parents. */
function history(w: World): { sha: string; parents: string[] }[] {
  const out: { sha: string; parents: string[] }[] = [];
  let cur: string | undefined = w.target.refs.get(NAMES.main);
  while (cur) {
    const c = w.target.commits.get(cur)!;
    out.push({ sha: cur, parents: c.parents });
    cur = c.parents[0];
  }
  return out;
}

/** main is linear: every commit has at most one parent. */
const isLinear = (w: World) => history(w).every((c) => c.parents.length <= 1);

/** Every value main took was a head CI passed on (DESIGN.md §1, invariant 1). */
function safe(w: World): void {
  for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
}

/** Does main's tree hold this commit's change? */
const mainHolds = (w: World, change: string) => w.target.content.get(w.target.refs.get(NAMES.main)!)!.has(change);

describe("a batch lands as a linear stack", () => {
  test("three PRs: one squashed commit each, every branch moved to its own, all marked merged", async () => {
    const w = linearWorld();
    const heads = [1, 2, 3].map((n) => pr(w, n).pr.head.sha);
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2, 3]]);
    safe(w);

    // main: three created commits, one parent each, on the old root.
    const h = history(w);
    expect(isLinear(w)).toBe(true);
    expect(h).toHaveLength(4);
    const stack = h.slice(0, 3).reverse();
    for (const c of stack) expect(w.target.created.has(c.sha)).toBe(true);
    for (const [i, change] of heads.entries()) {
      // Each stack commit adds exactly its PR's change to the one before.
      expect(w.target.content.get(stack[i]!.sha)!.has(change)).toBe(true);
      if (i > 0) expect(w.target.content.get(stack[i - 1]!.sha)!.has(change)).toBe(false);
    }
    const batch = w.state().history.find((x) => x.outcome === "landed")!.n;
    expect(w.target.createdMessages).toEqual([1, 2, 3].map((n, i) => `Change number ${n} (#${n})\n\nSquashed from #${n} at ${heads[i]}.\n\nLanded-by: qlander batch ${batch}`));

    // One atomic landing: main from the root, each branch from its admitted head to its own commit.
    expect(w.target.landings).toHaveLength(1);
    expect(w.target.landings[0]!.heads).toEqual([1, 2, 3].map((n, i) => ({ branch: `feat/pr-${n}`, before: heads[i]!, after: stack[i]!.sha })));
    expect(w.target.calls.some((c) => c.startsWith(`updateRef ${NAMES.main}`))).toBe(false);
    for (const [i, n] of [1, 2, 3].entries()) {
      const p = w.target.prs.get(n)!.pr;
      expect([p.merged, p.head.sha, p.labels.includes(NAMES.labels.ready)]).toEqual([true, stack[i]!.sha, false]);
      expect(w.comments(n).find((c) => c.startsWith("Landed"))).toContain(`pin \`${heads[i]}\`, squashed as \`${stack[i]!.sha}\``);
    }
    // The queue ref CI ran on is main's new head, and nothing is left behind.
    expect(w.greenHeads.has(stack[2]!.sha)).toBe(true);
    expect([...w.target.refs.keys()]).toEqual([NAMES.main]);
  });

  test("a PR without a title gets a neutral subject", async () => {
    const w = linearWorld();
    w.readyPr(1);
    await w.runUntilIdle();
    expect(w.target.createdMessages[0]!.split("\n")[0]).toBe("Pull request #1");
  });

  test("a red batch is bisected, each half rebuilt as its own stack, and the good PRs land linear", async () => {
    const w = linearWorld((b) => (b.prs.includes(3) ? "fail" : "pass"));
    for (const n of [1, 2, 3, 4]) pr(w, n);
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed().flat().sort()).toEqual([1, 2, 4]);
    expect(w.bounced()).toEqual([3]);
    safe(w);
    expect(isLinear(w)).toBe(true);
    // One commit per landed PR on top of the root, and #3's change never reached main.
    expect(history(w)).toHaveLength(4);
    expect(mainHolds(w, w.target.prs.get(3)!.pr.head.sha)).toBe(false);
    for (const n of [1, 2, 4]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
    // The bounced PR's branch is never touched.
    const p3 = w.target.prs.get(3)!.pr;
    expect([p3.merged, w.target.created.has(p3.head.sha), p3.labels.includes(NAMES.labels.ready)]).toEqual([false, false, false]);
  });

  test("a conflict mid-stack drops that PR with the usual comment; the stack closes over it", async () => {
    const w = linearWorld();
    pr(w, 1);
    const p2 = pr(w, 2);
    pr(w, 3);
    w.target.conflicts.add(p2.pr.head.sha);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 3]]);
    expect(w.comments(2).some((c) => c.startsWith("Not queued:") && c.includes("conflicts with main plus the PRs ahead of it"))).toBe(true);
    const h = history(w);
    expect(h).toHaveLength(3);
    expect(h[0]!.parents).toEqual([h[1]!.sha]); // #3's commit sits directly on #1's
    expect(w.target.landings[0]!.heads.map((x) => x.branch)).toEqual(["feat/pr-1", "feat/pr-3"]);
    expect(w.target.prs.get(2)!.pr.head.sha).toBe(p2.pr.head.sha);
  });

  test("an unsigned stack commit fails the build before any CI runs, and pauses", async () => {
    const w = linearWorld();
    pr(w, 1);
    w.target.unsignedCreated = true;
    await w.runUntilIdle();
    expect(w.paused()).toBe(true);
    expect(w.pauseReasons().join(" ")).toContain("stack commit");
    expect(w.verdicts).toEqual([]);
    expect(w.target.landings).toEqual([]);
  });

  test("pipelining stacks a speculative batch on the running stack, and both land linear", async () => {
    const w = linearWorld(() => "pass", { concurrency: { maxActive: 2, pipelineDepth: 1 } });
    w.ciTicks = 2;
    pr(w, 1);
    await w.tick();
    await w.tick();
    pr(w, 2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1], [2]]);
    expect(isLinear(w)).toBe(true);
    safe(w);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
  });
});

describe("the landing never overwrites a push", () => {
  test("an author push between the last revalidation and the landing: the update is refused whole, only that PR is dropped", async () => {
    const w = linearWorld();
    const heads = [1, 2, 3].map((n) => pr(w, n).pr.head.sha);
    const land = w.target.landStack.bind(w.target);
    let pushed: string | null = null;
    w.target.landStack = async (m, h, e) => {
      pushed ??= w.target.push(2); // the author pushes just as qlander lands
      return land(m, h, e);
    };
    const logs: string[] = [];
    for (let i = 0; i < 80; i++) {
      const r = await w.tick();
      if (r !== "crashed") logs.push(...r.log);
      if (w.landed().length > 0 && w.state().verify.length === 0) break;
    }
    expect(w.paused()).toBe(false);
    expect(logs.some((l) => l.includes("#2 moved since admission"))).toBe(true);
    // The author's commit stays where they pushed it, and nothing of #2 reached main.
    const p2 = w.target.prs.get(2)!.pr;
    expect([p2.head.sha, p2.merged, p2.labels.includes(NAMES.labels.ready)]).toEqual([pushed!, false, false]);
    expect(w.comments(2).some((c) => c.startsWith("Removed from the landing queue: head moved"))).toBe(true);
    expect(mainHolds(w, heads[1]!) || mainHolds(w, pushed!)).toBe(false);
    // The rest were rebuilt and landed, linear.
    expect(w.landed()).toEqual([[1, 3]]);
    expect(isLinear(w)).toBe(true);
    safe(w);
    expect(w.target.landings).toHaveLength(1);
  });

  test("main moved by someone else just before the landing: nothing moves, every PR branch is untouched, and the batch is rebuilt", async () => {
    const w = linearWorld();
    const heads = [1, 2].map((n) => pr(w, n).pr.head.sha);
    const land = w.target.landStack.bind(w.target);
    let glass: string | null = null;
    let afterRefusal: string[] = [];
    w.target.landStack = async (m, h, e) => {
      if (glass !== null) return land(m, h, e);
      // A break-glass merge moves main first, so the landing's beforeOid for main no longer holds.
      const main = w.target.refs.get(NAMES.main)!;
      glass = w.target.commit([main], "break-glass");
      w.target.githubUpdateRefs(NAMES.main, main, glass);
      try {
        return await land(m, h, e);
      } finally {
        afterRefusal = [1, 2].map((n) => w.target.prs.get(n)!.pr.head.sha);
      }
    };
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2]]);
    expect(afterRefusal).toEqual(heads);
    expect(w.target.landings).toHaveLength(1);
    expect(w.state().history.some((x) => x.outcome === "rebuilt")).toBe(true);
    // The landed stack sits on the break-glass commit.
    const h = history(w);
    expect(h[2]!.sha).toBe(glass!);
    expect(isLinear(w)).toBe(true);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
  });

  test("a GitHub that moved the PR branches but not main pauses with what to restore, and lands once they are restored", async () => {
    const w = linearWorld();
    const heads = [1, 2].map((n) => pr(w, n).pr.head.sha);
    w.target.partialLanding = true;
    for (let i = 0; i < 12 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    const why = w.repo.issues.filter((i) => i.open && i.labels.includes(NAMES.controlLabels.pause)).map((i) => i.body).join(" ");
    expect(why).toContain("but not main");
    expect(why).toContain(heads[0]!);
    // Nobody was told their PR changed: the moved branches are qlander's, not a push.
    for (const n of [1, 2]) expect(w.comments(n).some((c) => c.startsWith("Removed from the landing queue"))).toBe(false);
    // An operator restores the branches and resumes.
    w.target.partialLanding = false;
    for (const [i, n] of [1, 2].entries()) w.target.prs.get(n)!.pr.head.sha = heads[i]!;
    for (const issue of w.repo.issues) issue.open = false;
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2]]);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
  });
});

describe("a crash at every step boundary converges, linear", () => {
  const POINTS: CrashPoint[] = ["after-intent", "after-build-ref", "after-merges", "after-stack", "after-checkpoint", "after-queue-ref", "after-effect", "after-receipt", "mid-drain"];
  const oracle = (b: BatchCi): CiOutcome => (b.attempt === 1 ? "fail" : "pass");

  async function scenario(crash?: { point: CrashPoint; at: number }) {
    const w = linearWorld(oracle);
    for (const n of [1, 2, 3]) pr(w, n);
    let crashed = false;
    if (crash) {
      let hits = 0;
      const when = (p: CrashPoint) => p === crash.point && ++hits === crash.at;
      for (let i = 0; i < 40 && !crashed; i++) {
        crashed = (await w.tick({ crashWhen: when })) === "crashed";
        if (!crashed && w.landed().length > 0 && w.state().verify.length === 0 && w.state().outbox.length === 0) break;
      }
    }
    await w.runUntilIdle();
    return { w, crashed };
  }

  test("every point, first and second occurrence", async () => {
    const base = await scenario();
    expect(base.w.landed()).toEqual([[1, 2, 3]]);
    let exercised = 0;
    for (const point of POINTS) {
      for (const at of [1, 2]) {
        const { w, crashed } = await scenario({ point, at });
        if (!crashed) continue;
        exercised++;
        const where = `${point}#${at}`;
        expect(w.paused(), where).toBe(false);
        expect(w.landed().flat().sort(), where).toEqual([1, 2, 3]);
        safe(w);
        expect(isLinear(w), where).toBe(true);
        expect(history(w), where).toHaveLength(4);
        for (const n of [1, 2, 3]) expect(w.target.prs.get(n)!.pr.merged, where).toBe(true);
        const s = w.state();
        expect([s.journal, s.outbox], where).toEqual([null, []]);
        expect([...w.target.refs.keys()], where).toEqual([NAMES.main]);
      }
    }
    expect(exercised).toBeGreaterThanOrEqual(POINTS.length);
  });
});

describe("evidence and approvals are bound to the admitted head, not the rewrite", () => {
  const POLICY_FILE = ".github/workflows/ci.yml";
  const approve = (w: World, n: number, head: string) =>
    w.target.prs.get(n)!.comments.push({ id: 900 + n, user: { login: APPROVERS[1]!.login, id: APPROVERS[1]!.id }, body: `/qlander approve-policy ${head}`, created_at: "t", updated_at: "t" });

  test("an approved CI-policy PR lands linear; the rewrite asks for no new approval, and a red fast lane on the rewritten head stalls and bounces nothing", async () => {
    const w = linearWorld();
    const p = pr(w, 1, { files: [POLICY_FILE] });
    const admitted = p.pr.head.sha;
    approve(w, 1, admitted);
    pr(w, 2);
    w.target.mergeLag = 6; // GitHub is slow to mark the PRs merged
    const rewritten = new Set<string>();
    let rewrites = 0;
    for (let i = 0; i < 80; i++) {
      await w.tick();
      // GitHub starts the fast lane on every rewritten head, as for a push; make it red.
      for (const n of [1, 2]) {
        const head = w.target.prs.get(n)!.pr.head.sha;
        if (w.target.created.has(head) && !rewritten.has(head)) {
          rewritten.add(head);
          w.target.addRun({ head_sha: head, path: w.config.fastLane.workflowPath, event: w.config.fastLane.event, head_branch: `feat/pr-${n}` }, [job(w.config.fastLane.job, "failure")]);
          rewrites++;
        }
      }
      if (w.landed().length === 2 && w.state().verify.length === 0) break;
    }
    expect(rewrites).toBe(2);
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1], [2]]); // the policy PR alone, as ever
    for (const n of [1, 2]) {
      expect(w.target.prs.get(n)!.pr.merged).toBe(true);
      const said = w.comments(n).join("\n");
      expect(said).not.toContain("Removed from the landing queue");
      expect(said).not.toContain("fast lane is red");
      expect(said).not.toContain("approve-policy");
      expect(said).not.toContain("Bounced");
    }
    // Only the admitted head's approval was ever needed.
    expect(w.comments(1).find((c) => c.startsWith("Landed"))).toContain(`pin \`${admitted}\``);
  });

  test("a push after admission still drops the PR: the approval and fast lane name the old head", async () => {
    const w = linearWorld(() => "pass");
    w.ciTicks = 3;
    const p = pr(w, 1, { files: [POLICY_FILE] });
    approve(w, 1, p.pr.head.sha);
    await w.untilBuilt();
    const pushed = w.target.push(1, { files: [POLICY_FILE] });
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    expect(w.comments(1).some((c) => c.startsWith("Removed from the landing queue: head moved"))).toBe(true);
    expect(w.target.prs.get(1)!.pr.head.sha).toBe(pushed);
    expect(w.target.landings).toEqual([]);
  });

  test("a push after the landing is reported, not mistaken for the rewrite", async () => {
    const w = linearWorld();
    const p = pr(w, 1);
    const admitted = p.pr.head.sha;
    w.target.mergeLag = 100; // GitHub never gets round to it in this test
    await w.untilBuilt();
    for (let i = 0; i < 6 && w.landed().length === 0; i++) await w.tick();
    expect(w.landed()).toEqual([[1]]);
    const stackCommit = w.target.prs.get(1)!.pr.head.sha;
    expect(w.target.created.has(stackCommit)).toBe(true);
    const later = w.target.push(1);
    for (let i = 0; i < 4; i++) await w.tick();
    const said = w.comments(1).find((c) => c.startsWith("Landed revision"));
    expect(said).toStartWith(`Landed revision \`${admitted}\` in main as \`${stackCommit}\` (\`${stackCommit}\`). Commits pushed after it are **not** in main; this PR stays open for them.`);
    expect(w.target.prs.get(1)!.pr.head.sha).toBe(later);
    expect(w.state().verify).toEqual([]);
  });

  test("a read that still shows the admitted head after the landing waits, and the not-merged notice says so", async () => {
    const w = linearWorld();
    const p = pr(w, 1);
    const admitted = p.pr.head.sha;
    w.target.mergeLag = 100;
    await w.untilBuilt();
    for (let i = 0; i < 6 && w.landed().length === 0; i++) await w.tick();
    const stackCommit = w.target.prs.get(1)!.pr.head.sha;
    w.target.prs.get(1)!.pr.head.sha = admitted; // a read that lags behind the landing
    for (let i = 0; i < w.config.verifyTicks + 4; i++) await w.tick();
    const said = w.comments(1);
    expect(said.some((c) => c.startsWith("Landed revision"))).toBe(false);
    expect(said.some((c) => c.startsWith("Removed from"))).toBe(false);
    expect(said.find((c) => c.startsWith("This PR landed as"))).toStartWith(`This PR landed as \`${stackCommit}\` (squashed from \`${admitted}\`), which is in main at \`${stackCommit}\`, but GitHub has not marked this PR merged, and its branch still reads at \`${admitted}\`. A maintainer may close it.`);
    expect(w.target.prs.get(1)!.pr.labels.includes(NAMES.labels.ready)).toBe(true);
  });

  test("a renamed head branch drops the PR: the landing moves only the branch recorded at admission", async () => {
    const w = linearWorld();
    w.ciTicks = 3;
    pr(w, 1);
    await w.untilBuilt();
    expect(w.state().auth["1"]!.headRef).toBe("feat/pr-1");
    w.target.prs.get(1)!.pr.head.ref = "feat/renamed";
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    expect(w.comments(1).some((c) => c.includes("head branch changed from feat/pr-1 to feat/renamed"))).toBe(true);
    expect(w.target.landings).toEqual([]);
  });
});

describe("with the epoch fence on", () => {
  test("the landing carries the epoch; a successor's epoch makes it a lost lease and nothing moves", async () => {
    const t = new FakeTarget();
    t.epochBranch = "q-epoch/queue";
    const e = await t.advanceEpoch(null, "first");
    const f = t.addPr(1);
    const main = t.refs.get(NAMES.main)!;
    const s = await t.createCommit(t.treeOf.get(f.pr.head.sha)!, main, "Change (#1)\n\nbody");
    let epoch: string | null = e;
    const c = fenced(t, async () => {}, () => epoch);
    await expect(c.landStack({ branch: NAMES.main, before: main, after: s }, [{ branch: "feat/pr-1", before: f.pr.head.sha, after: s }], e)).rejects.toThrow("takes its epoch from the fence");
    // A successor advanced the epoch: GitHub refuses the whole call, and the fence reads it as a lost lease.
    await t.advanceEpoch(e, "successor");
    await expect(c.landStack({ branch: NAMES.main, before: main, after: s }, [{ branch: "feat/pr-1", before: f.pr.head.sha, after: s }], null)).rejects.toBeInstanceOf(LostLockError);
    expect([t.refs.get(NAMES.main), t.prs.get(1)!.pr.head.sha]).toEqual([main, f.pr.head.sha]);
    // Holding the current epoch, it lands, main and branch together.
    epoch = t.refs.get("q-epoch/queue")!;
    await c.landStack({ branch: NAMES.main, before: main, after: s }, [{ branch: "feat/pr-1", before: f.pr.head.sha, after: s }], null);
    expect([t.refs.get(NAMES.main), t.prs.get(1)!.pr.head.sha]).toEqual([s, s]);
  });
});

describe("headsVerdict (recovery with main unmoved)", () => {
  const heads = [
    { pr: 1, ref: "feat/a", before: sha("h1"), after: sha("s1") },
    { pr: 2, ref: "feat/b", before: sha("h2"), after: sha("s2") },
  ];
  test("untouched: null; pushed to: headMoved; at its stack commit: a pause that names what to restore", () => {
    expect(headsVerdict(heads, { "1": sha("h1"), "2": sha("h2") })).toBeNull();
    expect(headsVerdict(heads, { "1": sha("h1"), "2": sha("x") })).toEqual({ kind: "headMoved", prs: [2] });
    expect(headsVerdict(heads, { "1": sha("h1"), "2": null })).toEqual({ kind: "headMoved", prs: [2] });
    const half = headsVerdict(heads, { "1": sha("s1"), "2": sha("x") });
    expect(half?.kind).toBe("landRejected");
    expect(half).toMatchObject({ retry: false });
    expect((half as { reason: string }).reason).toContain(`#1: ${sha("h1")}`);
    expect(headsVerdict(undefined, { "1": sha("s1") })).toBeNull();
  });
});

describe("linearMessage", () => {
  test("subject from the flattened title and the PR number; body placeholders filled", () => {
    expect(linearMessage(7, sha("h"), 3, "Fix\nthe‮thing  ", "From #{number} at {head}, batch {batch}.")).toBe(`Fix the thing (#7)\n\nFrom #7 at ${sha("h")}, batch 3.`);
    expect(linearMessage(7, sha("h"), 3, "   ", "b")).toBe("Pull request #7\n\nb");
    expect(linearMessage(7, sha("h"), 3, undefined, "b")).toBe("Pull request #7\n\nb");
  });
});

describe("state", () => {
  test("a stack that does not chain from the base, or a landing that moves another branch, is refused", async () => {
    const w = linearWorld();
    w.ciTicks = 3;
    pr(w, 1);
    pr(w, 2);
    await w.untilBuilt();
    const good = w.stateRef.current!.text;
    const doc = JSON.parse(good);
    expect(doc.active.stack).toHaveLength(2);
    expect(() => parseState(good, NAMES)).not.toThrow();
    const broken = structuredClone(doc);
    broken.active.stack[1].parent = sha("elsewhere");
    expect(() => parseState(JSON.stringify(broken), NAMES)).toThrow("not on the commit before it");
    const reordered = structuredClone(doc);
    reordered.active.stack.reverse();
    expect(() => parseState(JSON.stringify(reordered), NAMES)).toThrow("one commit per PR");
    const land = structuredClone(doc);
    land.journal = { seq: 1, op: { kind: "land", before: doc.active.base, after: doc.active.head, heads: doc.active.stack.map((x: { pr: number; commit: string }) => ({ pr: x.pr, ref: "feat/other", before: doc.auth[String(x.pr)].head, after: x.commit })) }, reserved: false, at: doc.active.builtAt, checkpoint: null, tries: 0 };
    expect(() => parseState(JSON.stringify(land), NAMES)).toThrow("other than its admitted head and branch");
    land.journal.op.heads = land.journal.op.heads.map((h: { pr: number }) => ({ ...h, ref: doc.auth[String(h.pr)].headRef }));
    expect(() => parseState(JSON.stringify(land), NAMES)).not.toThrow();
    delete land.journal.op.heads;
    expect(() => parseState(JSON.stringify(land), NAMES)).toThrow("disagree on linear landing");
  });
});

describe("config", () => {
  const withLanding = (block: string) => OPT_IN_FREE_YAML.replace(/^( {2}controlLabels:)/m, `  landing:\n${block}\n$1`);
  const problems = (text: string) => {
    try {
      parseConfig(text);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("absent, or mode merge: no key, and the policy hash is unchanged", () => {
    expect("landing" in parseConfig(OPT_IN_FREE_YAML).config).toBe(false);
    const merge = parseConfig(withLanding("    mode: merge")).config;
    expect("landing" in merge).toBe(false);
    expect(policyHash(merge)).toBe(OPT_IN_FREE_HASH);
  });

  test("linear: the key, with the default body, in the policy hash", () => {
    const c = parseConfig(withLanding("    mode: linear")).config;
    expect(c.landing).toEqual({ mode: "linear", body: DEFAULT_LINEAR_BODY });
    expect(DEFAULT_LINEAR_BODY).toBe("Squashed from #{number} at {head}.\n\nLanded-by: qlander batch {batch}");
    expect(policyHash(c)).not.toBe(OPT_IN_FREE_HASH);
    const custom = parseConfig(withLanding('    mode: linear\n    body: "Batch {batch}\\nHead {head}"')).config;
    expect(custom.landing!.body).toBe("Batch {batch}\nHead {head}");
    expect(policyHash(custom)).not.toBe(policyHash(c));
  });

  test("refuses an unknown placeholder, a control character, a body in merge mode, and an unknown mode", () => {
    expect(problems(withLanding('    mode: linear\n    body: "by {author}"'))).toContain("unknown placeholder {author}");
    expect(problems(withLanding('    mode: linear\n    body: "a\\tb"'))).toContain("control characters");
    expect(problems(withLanding('    body: "x"'))).toContain("queue.landing.body is set, but queue.landing.mode is not linear");
    expect(problems(withLanding("    mode: rebase"))).not.toBe("");
  });
});

describe("the real client", () => {
  interface Route {
    method?: string;
    match: RegExp;
    status?: number;
    body?: unknown;
  }
  async function client(routes: Route[], epochBranch: string | null = null) {
    const seen: { method: string; url: string; body: any }[] = [];
    const all: Route[] = [{ match: pathRe(`/repos/${TARGET_SLUG}`), body: { id: TARGET, node_id: "R_target" } }, ...routes];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = all.find((x) => (x.method ?? "GET") === method && x.match.test(url));
      if (!r) return new Response(JSON.stringify({ message: `unrouted ${method} ${url}` }), { status: 599 });
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }) as typeof globalThis.fetch;
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch, sleep: async () => {}, epochBranch });
    return { c, seen };
  }
  const ok = { method: "POST", match: /\/graphql$/, body: { data: { updateRefs: { clientMutationId: null } } } };
  const main = { branch: NAMES.main, before: sha("B"), after: sha("Q") };
  const head = { branch: "feat/x", before: sha("H"), after: sha("S") };

  test("landStack: one updateRefs, main by fast-forward, each PR branch forced but from its beforeOid", async () => {
    const { c, seen } = await client([ok]);
    await c.landStack(main, [head], null);
    const gql = seen.filter((x) => x.url.endsWith("/graphql"));
    expect(gql).toHaveLength(1);
    expect(gql[0]!.body.variables.input.refUpdates).toEqual([
      { name: `refs/heads/${NAMES.main}`, beforeOid: sha("B"), afterOid: sha("Q"), force: false },
      { name: "refs/heads/feat/x", beforeOid: sha("H"), afterOid: sha("S"), force: true },
    ]);
  });

  test("landStack with the fence on adds the epoch entry, and refuses without one", async () => {
    const { c, seen } = await client([ok], "q-epoch/queue");
    await expect(c.landStack(main, [head], null)).rejects.toThrow("needs the epoch");
    await c.landStack(main, [head], sha("E"));
    expect(seen.at(-1)!.body.variables.input.refUpdates.at(-1)).toEqual({ name: "refs/heads/q-epoch/queue", beforeOid: sha("E"), afterOid: sha("E"), force: false });
  });

  test("landStack refuses, before any request, a reserved or repeated branch, a zero or unmoved sha, and anything but main as the trunk", async () => {
    const { c, seen } = await client([ok]);
    const n = seen.length;
    for (const branch of [NAMES.main, NAMES.release, `${NAMES.queuePrefix}1`, `${NAMES.buildPrefix}1`, "../x", "a.lock/b"]) {
      await expect(c.landStack(main, [{ ...head, branch }], null)).rejects.toThrow();
    }
    await expect(c.landStack(main, [head, head], null)).rejects.toThrow("twice");
    await expect(c.landStack(main, [{ ...head, after: "0".repeat(40) }], null)).rejects.toThrow("real object ids");
    await expect(c.landStack(main, [{ ...head, after: head.before }], null)).rejects.toThrow("real object ids");
    await expect(c.landStack({ ...main, branch: NAMES.release }, [head], null)).rejects.toThrow("moves main");
    await expect(c.landStack(main, [], null)).rejects.toThrow("1 to");
    expect(seen.length).toBe(n);
  });

  test("createCommit posts one tree and one parent; getCommit returns the tree; getPrBranch reads only PR branches", async () => {
    const { c, seen } = await client([
      { method: "POST", match: /\/git\/commits$/, body: { sha: sha("S") } },
      { match: /\/commits\/[0-9a-f]{40}$/, body: { sha: sha("M"), parents: [{ sha: sha("A") }, { sha: sha("H") }], commit: { tree: { sha: sha("T") }, verification: { verified: true, reason: "valid" } } } },
      { match: /\/git\/ref\/heads\/feat\/x$/, body: { object: { sha: sha("H") } } },
    ]);
    expect(await c.createCommit(sha("T"), sha("A"), "Subject (#1)\n\nbody")).toBe(sha("S"));
    expect(seen.at(-1)!.body).toEqual({ message: "Subject (#1)\n\nbody", tree: sha("T"), parents: [sha("A")] });
    expect((await c.getCommit(sha("M"))).tree).toBe(sha("T"));
    expect(await c.getPrBranch("feat/x")).toBe(sha("H"));
    await expect(c.getPrBranch(NAMES.main)).rejects.toThrow("reserved");
    await expect(c.getPrBranch(`${NAMES.queuePrefix}3`)).rejects.toThrow("reserved");
  });
});
