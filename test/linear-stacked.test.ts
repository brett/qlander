// A PR carrying commits that landed squashed (DESIGN.md §7.4): once A is on main
// as a squash, a PR built on A's commits has a merge base from before A, so a
// change of its own that undoes part of A vanishes with no conflict. The build
// refuses it until it is rebased. Same-batch stacks are fine: the merge chain
// keeps A's commits. Also: the forged-title check on a stack commit's message.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { DEFAULT_LINEAR_BODY } from "../src/config/load";
import { linearMessage } from "../src/queue";
import { commitPrefix, parseState, SQUASHED_MAX } from "../src/state";
import { NAMES, sha } from "./sim";
import { type BatchCi, type CiOutcome, World } from "./world";

const LINEAR: NonNullable<Config["landing"]> = { mode: "linear", body: DEFAULT_LINEAR_BODY, author: "app", maxRefusals: 3 };
const linearWorld = (oracle: (b: BatchCi) => CiOutcome = () => "pass", over: Partial<Config> = {}) => new World(oracle, { landing: LINEAR, ...over });

function pr(w: World, n: number) {
  const p = w.readyPr(n);
  p.pr.title = `Change number ${n}`;
  return p;
}

const refusal = (w: World, n: number) => w.comments(n).find((c) => c.startsWith("Not queued:"));

/** #1 lands; then #2, built on #1's admitted head or an older commit of it, is ready. */
async function stacked(w: World, onOlder = false) {
  const p1 = pr(w, 1);
  const older = p1.pr.head.sha;
  const h1 = onOlder ? w.target.push(1) : older;
  if (onOlder) w.evidence(1);
  await w.runUntilIdle();
  expect(w.landed()).toEqual([[1]]);
  const p2 = pr(w, 2);
  p2.pr.head.sha = w.target.commit([onOlder ? older : h1], "pr2-on-pr1", true, ["src/feature_2.py"]);
  w.evidence(2);
  return { h1, older, p2 };
}

describe("why: real git", () => {
  test("the revert is lost after a squash, kept after a merge", () => {
    const d = mkdtempSync(join(tmpdir(), "ql-stacked-"));
    const git = (...a: string[]) => {
      const p = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...a], { cwd: d, stdout: "pipe", stderr: "pipe" });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
      return p.stdout.toString().trim();
    };
    const write = (s: string) => writeFileSync(join(d, "f"), `${s}\n`);
    git("init", "-q");
    write("base");
    git("add", "f");
    git("commit", "-qm", "base");
    git("branch", "merged");
    git("branch", "squashed");
    git("checkout", "-qb", "a");
    write("a");
    git("commit", "-qam", "A");
    git("checkout", "-qb", "c");
    write("base");
    git("commit", "-qam", "C reverts A");
    const mergeC = (b: string) => {
      git("checkout", "-q", b);
      git("merge", "-q", "--no-edit", "c");
      return git("show", `${b}:f`);
    };
    git("checkout", "-q", "merged");
    git("merge", "-q", "--no-ff", "--no-edit", "a");
    expect(mergeC("merged")).toBe("base");
    git("checkout", "-q", "squashed");
    git("merge", "-q", "--squash", "a");
    git("commit", "-qm", "S_A");
    expect(mergeC("squashed")).toBe("a");
  });
});

describe("the build refuses it", () => {
  test("after its parent landed: before any CI, with a comment naming the commit; ready removed", async () => {
    const w = linearWorld();
    const { h1 } = await stacked(w);
    const runs = w.verdicts.length;
    await w.runUntilIdle();
    expect(w.verdicts).toHaveLength(runs);
    expect(w.landed()).toEqual([[1]]);
    const said = refusal(w, 2)!;
    expect(said).toContain("landed squashed");
    expect(said).toContain(h1);
    expect(said).toContain("git rebase --onto");
    expect(w.target.prs.get(2)!.pr.labels.includes(NAMES.labels.ready)).toBe(false);
    expect(w.state().auth).toEqual({});
    expect(w.state().squashed).toContain(commitPrefix(h1));
  });

  test("stacked on an older commit of the parent, not the head that landed", async () => {
    const w = linearWorld();
    const { older } = await stacked(w, true);
    await w.runUntilIdle();
    expect(refusal(w, 2)).toContain(older);
  });

  test("too many commits to list: it cannot be proved safe", async () => {
    const w = linearWorld();
    pr(w, 1);
    const create = w.target.createRef.bind(w.target);
    w.target.createRef = async (b, s) => {
      if (b.startsWith(NAMES.buildPrefix)) w.target.compareCommitLimit = 0; // only the build's own read is cut, after admission
      return create(b, s);
    };
    for (let i = 0; i < 6 && !w.target.prs.get(1)!.pr.labels.every((l) => l !== NAMES.labels.ready); i++) await w.tick();
    expect(w.landed()).toEqual([]);
    expect(refusal(w, 1)).toContain("more commits");
  });

  test("more commits than a landing records", async () => {
    const w = linearWorld();
    const p = pr(w, 1);
    for (let i = 0; i < 251; i++) p.pr.head.sha = w.target.commit([p.pr.head.sha], `c${i}`, true, ["src/x.py"]);
    w.evidence(1);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    expect(refusal(w, 1)).toContain("more commits");
  });

  test("merge mode after linear: the record stays, and the check still runs", async () => {
    const w = linearWorld();
    const { h1 } = await stacked(w);
    const { landing: _, ...merge } = w.config;
    w.config = merge as Config;
    await w.runUntilIdle();
    expect(refusal(w, 2)).toContain(h1);
    expect(w.state().squashed).toContain(commitPrefix(h1));
  });
});

describe("the build lets it through", () => {
  test("once rebased onto main", async () => {
    const w = linearWorld();
    const { p2 } = await stacked(w);
    await w.runUntilIdle();
    p2.pr.head.sha = w.target.commit([w.target.refs.get(NAMES.main)!], "pr2-rebased", true, ["src/feature_2.py"]);
    p2.pr.labels.push(NAMES.labels.ready);
    w.evidence(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1], [2]]);
  });

  test("a head that already contains main: it merges to its own tree", async () => {
    const w = linearWorld();
    const { h1, p2 } = await stacked(w);
    p2.pr.head.sha = w.target.commit([h1, w.target.refs.get(NAMES.main)!], "pr2-merged-main", true, ["src/feature_2.py"]);
    w.evidence(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1], [2]]);
  });

  test("in one batch, parent then child: the merge chain keeps the parent's commits", async () => {
    const w = linearWorld();
    const p1 = pr(w, 1);
    const p2 = pr(w, 2);
    p2.pr.head.sha = w.target.commit([p1.pr.head.sha], "pr2-on-pr1", true, ["src/feature_2.py"]);
    w.evidence(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.merged).toBe(true);
    expect(refusal(w, 2)).toBeUndefined();
  });

  test("merge mode: no record, and the stacked PR lands", async () => {
    const w = new World();
    const p1 = w.readyPr(1);
    await w.runUntilIdle();
    const p2 = w.readyPr(2);
    p2.pr.head.sha = w.target.commit([p1.pr.head.sha], "pr2-on-pr1", true, ["src/feature_2.py"]);
    w.evidence(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1], [2]]);
    expect("squashed" in w.state()).toBe(false);
  });
});

describe("pipelining", () => {
  const PIPE: Partial<Config> = { concurrency: { maxActive: 2, pipelineDepth: 1 } };

  test("over its running parent: the speculation is refused, the PR keeps its admission, and it is told only after the parent lands", async () => {
    const w = linearWorld(() => "pass", PIPE);
    w.ciTicks = 3;
    const h1 = pr(w, 1).pr.head.sha;
    await w.tick();
    await w.tick();
    const p2 = pr(w, 2);
    p2.pr.head.sha = w.target.commit([h1], "pr2-on-pr1", true, ["src/feature_2.py"]);
    w.evidence(2);
    await w.tick();
    await w.tick();
    expect(refusal(w, 2)).toBeUndefined();
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(refusal(w, 2)).toContain(h1);
  });

  test("over a parent that then bounces: it lands, carrying the parent's commits", async () => {
    const w = linearWorld((b) => (b.prs.includes(1) ? "fail" : "pass"), PIPE);
    w.ciTicks = 3;
    const p1 = pr(w, 1);
    await w.tick();
    await w.tick();
    const p2 = pr(w, 2);
    p2.pr.head.sha = w.target.commit([p1.pr.head.sha], "pr2-on-pr1", true, ["src/feature_2.py"]);
    w.evidence(2);
    await w.runUntilIdle();
    expect(w.bounced()).toEqual([1]);
    expect(w.landed()).toEqual([[2]]);
  });
});

describe("the record", () => {
  test("bounded, oldest out first, no duplicates", async () => {
    const w = linearWorld();
    w.ciTicks = 3;
    pr(w, 1);
    await w.untilBuilt();
    const doc = JSON.parse(w.stateRef.current!.text);
    expect(doc.active.stack[0].own).toHaveLength(1);
    const fill = Array.from({ length: SQUASHED_MAX }, (_, i) => i.toString(16).padStart(12, "0"));
    doc.squashed = fill;
    w.stateRef.current = { ...w.stateRef.current!, text: JSON.stringify(doc) };
    await w.runUntilIdle();
    const s = w.state().squashed!;
    expect(s).toHaveLength(SQUASHED_MAX);
    expect(s[0]).toBe(fill[1]!);
    expect(new Set(s).size).toBe(s.length);
  });

  test("state: own is required on a stack, and squashed holds only prefixes", async () => {
    const w = linearWorld();
    w.ciTicks = 3;
    pr(w, 1);
    await w.untilBuilt();
    const good = w.stateRef.current!.text;
    expect(() => parseState(good, NAMES)).not.toThrow();
    const noOwn = JSON.parse(good);
    delete noOwn.active.stack[0].own;
    expect(() => parseState(JSON.stringify(noOwn), NAMES)).toThrow("missing 'own'");
    for (const bad of [["nothex"], []]) expect(() => parseState(JSON.stringify({ ...JSON.parse(good), squashed: bad }), NAMES)).toThrow("squashed");
  });
});

describe("carrySeenRed", () => {
  test("not carried across a linear landing: the rest is built, not split on an inference about its tree", async () => {
    const w = linearWorld((b) => (b.prs.length > 1 && b.prs.includes(2) && b.attempt === 1 ? "fail" : "pass"), { strategy: { firstAlone: true, skipSeenRed: true } });
    for (const n of [1, 2, 3, 4]) pr(w, n);
    await w.runUntilIdle();
    expect(w.landed().flat().sort()).toEqual([1, 2, 3, 4]);
    expect(w.state().seenRed).toBeUndefined();
    expect(w.state().history.some((h) => h.note?.includes("already seen red"))).toBe(false);
  });
});

describe("linearMessage, a title that could forge a line", () => {
  const H = sha("h");
  test.each(["Merge pull request #999 at x", "Landed-by: qlander batch 999", "Co-authored-by: Mallory <m@example.com>", "Title: not the title", "--- a divider", "Co-author​ed-by: Mallory <m@example.com>"])("%j keeps the neutral subject and goes on a Title line", (title) => {
    const m = linearMessage(7, H, 3, title, "Body.\n\nLanded-by: qlander batch 3");
    expect(m.split("\n")[0]).toBe("Pull request #7");
    expect(m.split("\n").at(-1)).toStartWith("Title: ");
    expect(m.split("\n").filter((l) => /^landed-by:/i.test(l))).toEqual(["Landed-by: qlander batch 3"]);
  });
  test("the co-author trailer stays last, after a blank line", () => {
    const m = linearMessage(7, H, 3, "Signed-off-by: M", "Body.", { login: "a", email: "1+a@users.noreply.github.com" });
    expect(m).toBe("Pull request #7\n\nBody.\nTitle: Signed-off-by: M\n\nCo-authored-by: a <1+a@users.noreply.github.com>");
  });
  test("an ordinary title is unchanged", () => {
    expect(linearMessage(7, H, 3, "fix: x", "Body.")).toBe("fix: x (#7)\n\nBody.");
  });
});
