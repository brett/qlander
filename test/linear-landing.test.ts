// Linear landing (queue.landing.mode: linear, DESIGN.md §7.4): each PR lands
// as one squashed commit on a linear stack, and two guarded writes move each
// PR's head branch to its own stack commit and then main (test/linear-split.test.ts),
// so GitHub marks it merged. Merge mode is everything else in the suite.
//
// The in-memory GitHub models: trees (a merge's tree holds both parents'
// changes; a created commit takes the tree it is given), PR branches (a PR's
// head is its branch), the merged-state rule (a PR whose head is reachable
// from main is marked merged, mergeLag ticks later), and updateRefs' atomicity
// (every entry, forced or not, checked against its beforeOid before any
// moves). They are checked on real GitHub only by the sandbox checklist.

import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { DEFAULT_LINEAR_BODY, linearReleaseProblems, parseConfig } from "../src/config/load";
import { fenced } from "../src/fenced";
import { BLOCKS_DIRECT_UPDATE, classicProtection, forceUpdateOf } from "../src/force-update";
import { TargetClient } from "../src/github/target";
import { type CrashPoint, linearMessage, policyHash } from "../src/queue";
import { parseState } from "../src/state";
import { LostLockError } from "../src/store";
import { isGitBranchName } from "../src/validate";
import { FakeTarget, WRITER } from "./fake-github";
import { APPROVERS, job, NAMES, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, pathRe, sha, TARGET, TARGET_OPTS, TARGET_SLUG } from "./sim";
import { type BatchCi, type CiOutcome, World } from "./world";

const LINEAR: NonNullable<Config["landing"]> = { mode: "linear", body: DEFAULT_LINEAR_BODY, author: "app", maxRefusals: 3 };

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
    // The App is the author (signed); the PR's author is credited by a trailer at their noreply address.
    const by = `Co-authored-by: ${WRITER.login} <${WRITER.id}+${WRITER.login}@users.noreply.github.com>`;
    expect(w.target.createdMessages).toEqual([1, 2, 3].map((n, i) => `Change number ${n} (#${n})\n\nSquashed from #${n} at ${heads[i]}.\n\nLanded-by: qlander batch ${batch}\n\n${by}`));
    expect(w.target.createdAuthors.size).toBe(0);

    // Each branch from its admitted head to its own commit, then main from the root.
    expect(w.target.landings).toHaveLength(1);
    expect(w.target.branchMoves[0]!.moves).toEqual([1, 2, 3].map((n, i) => ({ branch: `feat/pr-${n}`, before: heads[i]!, after: stack[i]!.sha })));
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
    expect(w.target.landings[0]!.pinned.map((x) => x.branch)).toEqual(["feat/pr-1", "feat/pr-3"]);
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

describe("a parked batch keeps its stack (queue.strategy.reuseGreen)", () => {
  test("the run rerun by hand during the pause lands the parked stack linear, with no new queue run", async () => {
    let first: number | undefined;
    const w = linearWorld(
      (b) => {
        first ??= b.n;
        return b.n === first && b.attempt <= 2 ? "cancel" : "pass";
      },
      { strategy: { reuseGreen: true } },
    );
    for (const n of [1, 2, 3]) pr(w, n);
    for (let i = 0; i < 20 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    expect(w.state().parked?.stack).toHaveLength(3);
    const run = w.target.runs.filter((r) => r.head_branch === `${w.config.names.queuePrefix}${first}`).at(-1)!;
    await w.target.rerunFailedJobs(run.id); // by hand, while paused: passes
    await w.tick();
    for (const i of w.repo.issues) if (i.labels.includes(NAMES.controlLabels.pause)) i.open = false;
    const before = w.verdicts.length;
    await w.runUntilIdle(60);
    expect(w.landed()).toEqual([[1, 2, 3]]);
    expect(w.verdicts.length - before).toBe(0);
    expect(w.mainHistory.at(-1)).toBe(run.head_sha);
    expect(isLinear(w)).toBe(true);
    for (const n of [1, 2, 3]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
  });
});

describe("the landing never overwrites a push", () => {
  test("an author push between the last revalidation and the landing: the update is refused whole, only that PR is dropped", async () => {
    const w = linearWorld();
    const heads = [1, 2, 3].map((n) => pr(w, n).pr.head.sha);
    const move = w.target.moveBranches.bind(w.target);
    let pushed: string | null = null;
    w.target.moveBranches = async (g, m, e) => {
      pushed ??= w.target.push(2); // the author pushes just as qlander lands
      return move(g, m, e);
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
    const move = w.target.moveBranches.bind(w.target);
    let glass: string | null = null;
    let afterRefusal: string[] = [];
    w.target.moveBranches = async (g, m, e) => {
      if (glass !== null) return move(g, m, e);
      // A break-glass merge moves main first, so the first write's guard on main no longer holds.
      const main = w.target.refs.get(NAMES.main)!;
      glass = w.target.commit([main], "break-glass");
      w.target.githubUpdateRefs(NAMES.main, main, glass);
      try {
        return await move(g, m, e);
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
});

describe("a main read that lags behind an applied landing is never taken for a half-applied one", () => {
  test("a crash after the landing, then one stale main read: the journal is kept, and the next read records the landing", async () => {
    const w = linearWorld();
    for (const n of [1, 2]) pr(w, n);
    let crashed = false;
    for (let i = 0; i < 20 && !crashed; i++) {
      crashed =
        (await w.tick({
          crashWhen: (p) => {
            if (p !== "after-effect" || w.state().journal?.op.kind !== "land") return false;
            w.target.staleMain = { value: w.mainHistory.at(-2)!, reads: 2 }; // the next reads of main come from a lagging replica
            return true;
          },
        })) === "crashed";
    }
    expect(crashed).toBe(true);
    const r = await w.tick();
    expect(r !== "crashed" && r.log.some((l) => l.startsWith("landing unsettled"))).toBe(true);
    expect(w.state().journal?.op.kind).toBe("land");
    expect(w.paused()).toBe(false);
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2]]);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
    expect(w.target.landings).toHaveLength(1);
  });

  test("a landing whose response is lost, then one stale main read: unsettled, not a pause, and recorded on the next tick", async () => {
    const w = linearWorld();
    for (const n of [1, 2]) pr(w, n);
    const land = w.target.landStack.bind(w.target);
    w.target.landStack = async (m, h, e) => {
      await land(m, h, e);
      w.target.staleMain = { value: m.before, reads: 1 };
      throw new (await import("../src/github/http")).GitHubError("server", 502, "Bad gateway"); // applied, but the response is lost
    };
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2]]);
    expect(w.target.landings).toHaveLength(1);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
  });
});

describe("branch names", () => {
  test("a head branch git allows but the config-name pattern does not (feat/fix+tests) is admitted, persisted and landed", async () => {
    const w = linearWorld();
    pr(w, 1).pr.head.ref = "feat/fix+tests";
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.landings[0]!.pinned[0]!.branch).toBe("feat/fix+tests");
  });

  test("a name git would refuse is refused at admission with a comment, so the state never holds it", async () => {
    const w = linearWorld();
    pr(w, 1).pr.head.ref = "feat/a..b";
    pr(w, 2);
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[2]]);
    expect(w.comments(1).some((c) => c.startsWith("Not queued: its head branch name") && c.includes("feat/a..b"))).toBe(true);
    expect(w.target.prs.get(1)!.pr.labels.includes(NAMES.labels.ready)).toBe(false);
  });

  test("isGitBranchName follows git check-ref-format", () => {
    for (const ok of ["feat/fix+tests", "a#b", "release-notes/2026.10", "x@y", "UPPER/ünïcode"]) expect(isGitBranchName(ok), ok).toBe(true);
    for (const bad of ["", "@", "a..b", "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "/a", "a/", "a//b", "a.", ".a", "a/.b", "a.lock", "a/b.lock/c", "a@{b", "-a", "a\u0001b", "x".repeat(256)]) expect(isGitBranchName(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("a PR based on another PR's branch", () => {
  // #1 is not ready; #2 is built on #1's head. Only #2 is in the batch, and the oracle must be told so in both modes.
  for (const mode of ["merge", "linear"] as const) {
    test(`${mode} mode: CI judges the batch as #2 alone, and a failure of #2 bounces it`, async () => {
      const seen: number[][] = [];
      const oracle = (b: BatchCi): CiOutcome => {
        seen.push(b.prs);
        return b.prs.includes(2) ? "fail" : "pass";
      };
      const w = mode === "linear" ? linearWorld(oracle) : new World(oracle);
      const p1 = w.target.addPr(1, { labels: [] });
      const p2 = pr(w, 2);
      p2.pr.head.sha = w.target.commit([p1.pr.head.sha], "pr2-on-pr1", true, ["src/feature_2.py"]);
      w.evidence(2);
      await w.runUntilIdle();
      expect(seen.length).toBeGreaterThan(0);
      for (const prs of seen) expect(prs).toEqual([2]);
      expect(w.landed()).toEqual([]);
      expect(w.bounced()).toEqual([2]);
    });
  }
});

describe("a crash at every step boundary converges, linear", () => {
  const POINTS: CrashPoint[] = ["after-intent", "after-build-ref", "after-merges", "after-stack", "after-checkpoint", "after-queue-ref", "after-branches", "after-effect", "after-receipt", "mid-drain"];
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
  test("both writes carry the epoch; a successor's epoch makes either a lost lease and nothing moves", async () => {
    const t = new FakeTarget();
    t.epochBranch = "q-epoch/queue";
    const e = await t.advanceEpoch(null, "first");
    const f = t.addPr(1);
    const main = t.refs.get(NAMES.main)!;
    const h = f.pr.head.sha;
    const s = await t.createCommit(t.treeOf.get(h)!, main, "Change (#1)\n\nbody");
    let epoch: string | null = e;
    const c = fenced(t, async () => {}, () => epoch);
    const guard = { branch: NAMES.main, at: main };
    const move = [{ branch: "feat/pr-1", before: h, after: s }];
    const land = { branch: NAMES.main, before: main, after: s };
    const pin = [{ branch: "feat/pr-1", at: s }];
    await expect(c.moveBranches(guard, move, e)).rejects.toThrow("takes its epoch from the fence");
    await expect(c.landStack(land, pin, e)).rejects.toThrow("takes its epoch from the fence");
    // A successor advanced the epoch: GitHub refuses the whole call, and the fence reads it as a lost lease.
    await t.advanceEpoch(e, "successor");
    await expect(c.moveBranches(guard, move, null)).rejects.toBeInstanceOf(LostLockError);
    expect([t.refs.get(NAMES.main), t.prs.get(1)!.pr.head.sha]).toEqual([main, h]);
    // Holding the current epoch, the branch moves.
    epoch = t.refs.get("q-epoch/queue")!;
    await c.moveBranches(guard, move, null);
    expect(t.prs.get(1)!.pr.head.sha).toBe(s);
    // A successor takes over between the writes: main cannot move.
    const held = epoch;
    await t.advanceEpoch(held, "successor 2");
    await expect(c.landStack(land, pin, null)).rejects.toBeInstanceOf(LostLockError);
    expect(t.refs.get(NAMES.main)).toBe(main);
    epoch = t.refs.get("q-epoch/queue")!;
    await c.landStack(land, pin, null);
    expect(t.refs.get(NAMES.main)).toBe(s);
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
  const releaseOff = (t: string) => {
    const out = t.replace(/^( {2}enabled: )true$/m, "$1false");
    if (out === t) throw new Error("the example config no longer enables release advance");
    return out;
  };
  const withLanding = (block: string, base = releaseOff(OPT_IN_FREE_YAML)) => base.replace(/^( {2}controlLabels:)/m, `  landing:\n${block}\n$1`);
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
    const merge = parseConfig(withLanding("    mode: merge", OPT_IN_FREE_YAML)).config;
    expect("landing" in merge).toBe(false);
    expect(policyHash(merge)).toBe(OPT_IN_FREE_HASH);
  });

  test("linear: the key, with the defaults, in the policy hash", () => {
    const c = parseConfig(withLanding("    mode: linear")).config;
    expect(c.landing).toEqual({ mode: "linear", body: DEFAULT_LINEAR_BODY, author: "app", maxRefusals: 3 });
    expect(DEFAULT_LINEAR_BODY).toBe("Squashed from #{number} at {head}.\n\nLanded-by: qlander batch {batch}");
    const custom = parseConfig(withLanding('    mode: linear\n    body: "Batch {batch}\\nHead {head}"\n    author: author\n    maxRefusals: 5')).config;
    expect(custom.landing).toEqual({ mode: "linear", body: "Batch {batch}\nHead {head}", author: "author", maxRefusals: 5 });
    expect(policyHash(custom)).not.toBe(policyHash(c));
  });

  test("refuses an unknown placeholder, a control character, a linear-only key in merge mode, and unknown values", () => {
    expect(problems(withLanding('    mode: linear\n    body: "by {author}"'))).toContain("unknown placeholder {author}");
    expect(problems(withLanding('    mode: linear\n    body: "a\\tb"'))).toContain("control characters");
    for (const k of ['body: "x"', "author: app", "maxRefusals: 2"]) expect(problems(withLanding(`    ${k}`))).toContain(`queue.landing.${k.split(":")[0]} is set, but queue.landing.mode is not linear`);
    expect(problems(withLanding("    mode: rebase"))).not.toBe("");
    expect(problems(withLanding("    mode: linear\n    author: someone"))).not.toBe("");
    expect(problems(withLanding("    mode: linear\n    maxRefusals: 0"))).not.toBe("");
  });

  test("refuses linear with release advance enabled, dry run included, to protect the hotfix merge-back", () => {
    for (const dry of [true, false]) {
      const text = withLanding("    mode: linear", OPT_IN_FREE_YAML.replace(/^( {2}dryRun: ).*$/m, `$1${dry}`));
      const why = problems(text);
      expect(why).toContain("queue.landing.mode linear cannot be used with release advance");
      expect(why).toContain("merge-back");
    }
    expect(problems(withLanding("    mode: linear"))).toBe(""); // release disabled: allowed
    expect(problems(withLanding("    mode: merge", OPT_IN_FREE_YAML))).toBe("");
  });

  test("a future release.mode: dispatch is allowed, advance (or absent) is not", () => {
    const y = (mode?: string) => ({ queue: { landing: { mode: "linear" } }, release: { enabled: true, ...(mode ? { mode } : {}) } });
    expect(linearReleaseProblems(y())).toHaveLength(1);
    expect(linearReleaseProblems(y("advance"))).toHaveLength(1);
    expect(linearReleaseProblems(y("dispatch"))).toEqual([]);
    expect(linearReleaseProblems({ queue: { landing: { mode: "linear" } }, release: { enabled: false } })).toEqual([]);
  });

  test("dispatch with author: author is refused (its unsigned commits could never reach release); author: app is allowed", () => {
    const y = (author?: string) => ({ queue: { landing: { mode: "linear", ...(author ? { author } : {}) } }, release: { enabled: true, mode: "dispatch" } });
    expect(linearReleaseProblems(y("author"))).toEqual([expect.stringContaining("queue.landing.author author cannot be used with release.mode dispatch")]);
    expect(linearReleaseProblems(y("app"))).toEqual([]);
    expect(linearReleaseProblems(y())).toEqual([]);
    expect(linearReleaseProblems({ queue: { landing: { mode: "linear", author: "author" } }, release: { enabled: false, mode: "dispatch" } })).toEqual([]);
    expect(linearReleaseProblems({ queue: { landing: { mode: "linear", author: "author" } }, release: { enabled: true } })).toHaveLength(1);
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

  const guard = { branch: NAMES.main, at: sha("B") };
  const pin = { branch: "feat/x", at: sha("S") };

  test("moveBranches: one updateRefs, main a no-op guard, a move forced but from its beforeOid, a no-op entry not forced", async () => {
    const { c, seen } = await client([ok]);
    await c.moveBranches(guard, [head, { branch: "feat/y", before: sha("Y"), after: sha("Y") }], null);
    const gql = seen.filter((x) => x.url.endsWith("/graphql"));
    expect(gql).toHaveLength(1);
    expect(gql[0]!.body.variables.input.refUpdates).toEqual([
      { name: `refs/heads/${NAMES.main}`, beforeOid: sha("B"), afterOid: sha("B"), force: false },
      { name: "refs/heads/feat/x", beforeOid: sha("H"), afterOid: sha("S"), force: true },
      { name: "refs/heads/feat/y", beforeOid: sha("Y"), afterOid: sha("Y"), force: false },
    ]);
  });

  test("landStack: one updateRefs, main by fast-forward, each PR branch a no-op guard; nothing forced", async () => {
    const { c, seen } = await client([ok]);
    await c.landStack(main, [pin], null);
    const gql = seen.filter((x) => x.url.endsWith("/graphql"));
    expect(gql).toHaveLength(1);
    expect(gql[0]!.body.variables.input.refUpdates).toEqual([
      { name: `refs/heads/${NAMES.main}`, beforeOid: sha("B"), afterOid: sha("Q"), force: false },
      { name: "refs/heads/feat/x", beforeOid: sha("S"), afterOid: sha("S"), force: false },
    ]);
  });

  test("both with the fence on add the epoch entry, and refuse without one", async () => {
    const { c, seen } = await client([ok], "q-epoch/queue");
    const entry = { name: "refs/heads/q-epoch/queue", beforeOid: sha("E"), afterOid: sha("E"), force: false };
    await expect(c.landStack(main, [pin], null)).rejects.toThrow("needs the epoch");
    await expect(c.moveBranches(guard, [head], null)).rejects.toThrow("needs the epoch");
    await c.landStack(main, [pin], sha("E"));
    expect(seen.at(-1)!.body.variables.input.refUpdates.at(-1)).toEqual(entry);
    await c.moveBranches(guard, [head], sha("E"));
    expect(seen.at(-1)!.body.variables.input.refUpdates.at(-1)).toEqual(entry);
  });

  test("both refuse, before any request, a reserved or repeated branch, a zero sha, and anything but main as the trunk", async () => {
    const { c, seen } = await client([ok]);
    const n = seen.length;
    for (const branch of [NAMES.main, NAMES.release, `${NAMES.queuePrefix}1`, `${NAMES.buildPrefix}1`, "../x", "a.lock/b"]) {
      await expect(c.landStack(main, [{ ...pin, branch }], null)).rejects.toThrow();
      await expect(c.moveBranches(guard, [{ ...head, branch }], null)).rejects.toThrow();
    }
    await expect(c.landStack(main, [pin, pin], null)).rejects.toThrow("twice");
    await expect(c.moveBranches(guard, [head, head], null)).rejects.toThrow("twice");
    await expect(c.landStack(main, [{ ...pin, at: "0".repeat(40) }], null)).rejects.toThrow("real object id");
    await expect(c.moveBranches(guard, [{ ...head, after: "0".repeat(40) }], null)).rejects.toThrow("real object id");
    await expect(c.moveBranches({ ...guard, at: "0".repeat(40) }, [head], null)).rejects.toThrow("real object id");
    await expect(c.landStack({ ...main, after: main.before }, [pin], null)).rejects.toThrow("real object id");
    await expect(c.landStack({ ...main, branch: NAMES.release }, [pin], null)).rejects.toThrow("moves main");
    await expect(c.moveBranches({ ...guard, branch: NAMES.release }, [head], null)).rejects.toThrow("main");
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
    // git allows `+` and `#` in a branch name: each path component is encoded.
    expect(await c.getPrBranch("feat/fix+tests#2").catch(() => null)).toBeNull();
    expect(seen.at(-1)!.url).toContain("/git/ref/heads/feat/fix%2Btests%232");
    await expect(c.getPrBranch("feat/a..b")).rejects.toThrow("bad branch name");
    await expect(c.getPrBranch(NAMES.main)).rejects.toThrow("reserved");
    await expect(c.getPrBranch(`${NAMES.queuePrefix}3`)).rejects.toThrow("reserved");
  });
});

describe("authorship (queue.landing.author)", () => {
  test("app (default): the App authors and GitHub signs; the PR's author is credited by trailer; no author at all means no trailer", async () => {
    const w = linearWorld();
    pr(w, 1);
    pr(w, 2).pr.user = null;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    expect(w.target.createdAuthors.size).toBe(0);
    expect(w.target.createdMessages[0]).toEndWith(`\n\nCo-authored-by: ${WRITER.login} <${WRITER.id}+${WRITER.login}@users.noreply.github.com>`);
    expect(w.target.createdMessages[1]).not.toContain("Co-authored-by");
  });

  test("author: the PR's author at their noreply address is the author, with no trailer; the unsigned commit is expected, so the build goes on", async () => {
    const w = linearWorld(() => "pass", { landing: { ...LINEAR, author: "author" } });
    pr(w, 1);
    pr(w, 2).pr.user = null; // no account to credit: the App authors it, signed, as in app mode
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2]]);
    const [s1, s2] = history(w).slice(0, 2).reverse();
    expect(w.target.createdAuthors.get(s1!.sha)).toEqual({ name: WRITER.login, email: `${WRITER.id}+${WRITER.login}@users.noreply.github.com` });
    expect(w.target.commits.get(s1!.sha)!.verified).toBe(false);
    expect(w.target.createdAuthors.has(s2!.sha)).toBe(false);
    expect(w.target.commits.get(s2!.sha)!.verified).toBe(true);
    for (const m of w.target.createdMessages) expect(m).not.toContain("Co-authored-by");
  });

  test("author: an App-authored commit that is unsigned still fails the build", async () => {
    const w = linearWorld(() => "pass", { landing: { ...LINEAR, author: "author" } });
    pr(w, 1).pr.user = null;
    w.target.unsignedCreated = true;
    await w.runUntilIdle();
    expect(w.paused()).toBe(true);
    expect(w.verdicts).toEqual([]);
  });

  test("linearMessage puts the trailer last, after a blank line", () => {
    expect(linearMessage(7, sha("h"), 3, "T", "body", { login: "alice", email: "1001+alice@users.noreply.github.com" })).toBe("T (#7)\n\nbody\n\nCo-authored-by: alice <1001+alice@users.noreply.github.com>");
  });
});

describe("force-update compatibility at admission", () => {
  const blockAll = (bypass: string | null) => [{ id: 41, name: "no-force", covers: (b: string) => b.startsWith("feat/"), types: ["non_fast_forward"], bypass }];

  test("denied: the PR waits with a comment naming the rule, keeps ready, and is queued once the rule lets the App bypass it", async () => {
    for (const bypass of ["never", "pull_requests_only"]) {
      const w = linearWorld();
      pr(w, 1);
      w.target.branchRulesets = blockAll(bypass);
      for (let i = 0; i < 4; i++) await w.tick();
      expect(w.state().auth["1"]).toBeUndefined();
      const said = w.comments(1).filter((c) => c.startsWith("Labelled `ready` but not queued: this queue lands linear"));
      expect(said).toHaveLength(1); // once per head and rule
      expect(said[0]).toContain('non_fast_forward in ruleset "no-force" (41)');
      expect(w.target.prs.get(1)!.pr.labels.includes(NAMES.labels.ready)).toBe(true);
      w.target.branchRulesets = blockAll("always");
      await w.runUntilIdle();
      expect(w.landed()).toEqual([[1]]);
    }
  });

  test("an admitted PR whose branch becomes denied is dropped without losing ready, and comes back once allowed", async () => {
    const w = linearWorld();
    w.ciTicks = 3;
    pr(w, 1);
    await w.untilBuilt();
    w.target.branchRulesets = blockAll("never");
    for (let i = 0; i < 4; i++) await w.tick();
    expect(w.target.landings).toEqual([]);
    expect(w.state().auth["1"]).toBeUndefined();
    expect(w.target.prs.get(1)!.pr.labels.includes(NAMES.labels.ready)).toBe(true);
    w.target.branchRulesets = [];
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });

  test("unknown (unreadable bypass, classic protection, a failed read) is advisory: the PR is admitted and lands", async () => {
    const cases: ((w: World) => void)[] = [
      (w) => (w.target.branchRulesets = blockAll(null)),
      (w) => w.target.protectedBranches.add("feat/pr-1"),
      (w) => (w.target.branchRulesError = new (require("../src/github/http").GitHubError)("server", 502, "Bad gateway")),
    ];
    for (const setup of cases) {
      const w = linearWorld();
      pr(w, 1);
      setup(w);
      const logs: string[] = [];
      for (let i = 0; i < 40; i++) {
        const r = await w.tick();
        if (r !== "crashed") logs.push(...r.log);
        if (w.landed().length > 0 && w.state().verify.length === 0) break;
      }
      expect(w.landed()).toEqual([[1]]);
      expect(logs.some((l) => l.includes("whether the queue App may force-update feat/pr-1 is unknown"))).toBe(true);
    }
  });

  test("forceUpdateOf: an unreadable ruleset never hides a definite denial from another, in either order; unreadable alone is unknown", async () => {
    const never = { id: 2, name: "strict", covers: () => true, types: ["non_fast_forward"], bypass: "never" };
    const broken = { id: 3, name: "broken", covers: () => true, types: ["non_fast_forward"], bypass: "always" };
    for (const order of [[broken, never], [never, broken]]) {
      const t = new FakeTarget();
      t.branchRulesets = order;
      const read = t.rulesetBypass.bind(t);
      t.rulesetBypass = async (id) => {
        if (id === 3) throw new (require("../src/github/http").GitHubError)("server", 502, "Bad gateway");
        return read(id);
      };
      const v = await forceUpdateOf(t, "feat/x", new Map());
      expect(v.kind).toBe("denied");
      expect((v as { rule: string }).rule).toContain('"strict" (2)');
    }
    const t = new FakeTarget();
    t.branchRulesets = [broken];
    t.rulesetBypass = async () => {
      throw new (require("../src/github/http").GitHubError)("server", 502, "Bad gateway");
    };
    expect((await forceUpdateOf(t, "feat/x", new Map())).kind).toBe("unknown");
  });

  test("forceUpdateOf: exempt and always pass, each ruleset is read once per snapshot", async () => {
    const t = new FakeTarget();
    let reads = 0;
    t.branchRulesets = [
      { id: 1, name: "a", covers: () => true, types: ["non_fast_forward", "update"], bypass: "exempt" },
      { id: 2, name: "b", covers: () => true, types: ["deletion"], bypass: "never" },
    ];
    const read = t.rulesetBypass.bind(t);
    t.rulesetBypass = async (id) => (reads++, read(id));
    const cache = new Map();
    expect(await forceUpdateOf(t, "feat/x", cache)).toEqual({ kind: "allowed" });
    expect(await forceUpdateOf(t, "feat/y", cache)).toEqual({ kind: "allowed" });
    expect(reads).toBe(1); // only ruleset 1 blocks a forced update, and it is cached
  });

  test("forceUpdateOf: every rule that refuses a forced update denies it without a bypass, and passes with one", async () => {
    // required_status_checks was seen refusing a real landing: 'Required status check "x" is expected.'
    expect(BLOCKS_DIRECT_UPDATE).toContain("required_status_checks");
    for (const type of ["non_fast_forward", ...BLOCKS_DIRECT_UPDATE]) {
      const t = new FakeTarget();
      t.branchRulesets = [{ id: 1, name: "r", covers: () => true, types: [type], bypass: "never" }];
      const v = await forceUpdateOf(t, "feat/x", new Map());
      expect(v.kind).toBe("denied");
      expect((v as { rule: string }).rule).toContain(type);
      t.branchRulesets = [{ id: 1, name: "r", covers: () => true, types: [type], bypass: "always" }];
      expect(await forceUpdateOf(t, "feat/x", new Map())).toEqual({ kind: "allowed" });
    }
  });

  test("forceUpdateOf: a rule the landing satisfies or never meets does not hold the PR; required signatures only hold unsigned author commits", async () => {
    const t = new FakeTarget();
    t.branchRulesets = [{ id: 1, name: "r", covers: () => true, types: ["creation", "deletion", "required_linear_history", "copilot_code_review", "commit_message_pattern", "file_path_restriction"], bypass: "never" }];
    expect(await forceUpdateOf(t, "feat/x", new Map())).toEqual({ kind: "allowed" });
    t.branchRulesets = [{ id: 1, name: "r", covers: () => true, types: ["required_signatures"], bypass: "never" }];
    expect(await forceUpdateOf(t, "feat/x", new Map(), "app")).toEqual({ kind: "allowed" });
    expect((await forceUpdateOf(t, "feat/x", new Map(), "author")).kind).toBe("denied");
  });

  test("classicProtection: GitHub's protected flag is true for a ruleset too; protection.enabled says which", () => {
    // As GET /branches/{b} answers, even anonymously, for a branch with rulesets only (its classic endpoint: 404).
    expect(classicProtection({ protected: true, protection: { enabled: false, required_status_checks: { enforcement_level: "off", contexts: [], checks: [] } } } as never)).toBe(false);
    expect(classicProtection({ protected: true, protection: { enabled: true } })).toBe(true);
    expect(classicProtection({ protected: false, protection: { enabled: false } })).toBe(false);
    // An answer without the field is not proof of no protection: stay with the advisory unknown.
    expect(classicProtection({ protected: true })).toBe(true);
  });
});

describe("a refused landing is classified, not a pause", () => {
  test("refused with everything where the batch left it: retried next tick, and lands, without a pause", async () => {
    const w = linearWorld();
    for (const n of [1, 2]) pr(w, n);
    w.target.refuseLandings = 2; // fewer than maxRefusals (3)
    const logs: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await w.tick();
      if (r !== "crashed") logs.push(...r.log);
      if (w.landed().length > 0 && w.state().verify.length === 0) break;
    }
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1, 2]]);
    expect(logs.filter((l) => l.startsWith("landing refused"))).toHaveLength(2);
    expect(w.verdicts).toHaveLength(1); // retries cost no CI run
    expect(w.target.landings).toHaveLength(1);
  });

  test("maxRefusals unexplained refusals in a row pause, keeping the journal; resuming retries it", async () => {
    const w = linearWorld();
    pr(w, 1);
    w.target.refuseLandings = 3;
    for (let i = 0; i < 20 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    const body = w.repo.issues.filter((i) => i.open).map((i) => i.body).join(" ");
    expect(body).toContain("refused 3 times in a row");
    expect(w.state().journal?.op).toMatchObject({ kind: "land", refused: 3 });
    for (const i of w.repo.issues) i.open = false;
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
  });

  test("transient errors are retried and not counted; the op's retry budget (maxOpTries) still bounds them", async () => {
    const transient = () => new (require("../src/github/http").GitHubError)("server", 502, "Bad gateway");
    const w = linearWorld();
    pr(w, 1);
    w.target.refuseLandings = 2;
    w.target.refusal = transient;
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
    // Past maxOpTries resends, the queue pauses: the budget is spent, not a refusal count.
    const v = linearWorld();
    pr(v, 1);
    v.target.refuseLandings = 100;
    v.target.refusal = transient;
    for (let i = 0; i < 20 && !v.paused(); i++) await v.tick();
    expect(v.paused()).toBe(true);
    expect(v.repo.issues.filter((i) => i.open).map((i) => i.body).join(" ")).toContain(`re-executed ${v.config.maxOpTries} times`);
    expect(v.target.landings).toEqual([]);
  });

  test("a resend needs the batch's latest CI attempt green: green, refused, rerun red, then no landing", async () => {
    const w = linearWorld((b) => (b.attempt === 1 ? "pass" : "fail"));
    pr(w, 1);
    w.target.refuseLandings = 1;
    const refusedOnce = () => w.stateRef.current !== null && (w.state().journal?.op as { refused?: number } | undefined)?.refused === 1;
    for (let i = 0; i < 20 && !refusedOnce(); i++) await w.tick();
    expect(refusedOnce()).toBe(true);
    // Someone reruns the batch's CI by hand; attempt 2 fails.
    const head = w.state().active!.head;
    const run = w.target.runs.filter((r) => r.head_sha === head && r.head_branch?.startsWith(w.config.names.queuePrefix)).at(-1)!;
    await w.target.rerunFailedJobs(run.id);
    for (let i = 0; i < 3; i++) w.target.advance(); // the lists catch up with attempt 2
    await w.runUntilIdle();
    expect(w.target.landings).toEqual([]);
    expect(w.landed()).toEqual([]);
    expect(w.bounced()).toEqual([1]);
    for (const m of w.mainHistory.slice(1)) expect(w.greenHeads.has(m)).toBe(true);
  });

  test("a resend revalidates first: a PR whose policy hash changed meanwhile is not landed", async () => {
    const w = linearWorld();
    pr(w, 1);
    w.target.refuseLandings = 1;
    const refusedOnce = () => w.stateRef.current !== null && (w.state().journal?.op as { refused?: number } | undefined)?.refused === 1;
    for (let i = 0; i < 20 && !refusedOnce(); i++) await w.tick();
    expect(w.state().journal?.op).toMatchObject({ kind: "land", refused: 1 });
    w.config = { ...w.config, maxBatch: w.config.maxBatch + 1 }; // a policy change
    await w.tick();
    expect(w.target.landings).toEqual([]);
    expect(w.state().journal).toBeNull();
  });
});
