// The static workflow reading under `qlander audit` (src/audit/workflow.ts).
import { describe, expect, test } from "bun:test";
import { branchFilterMatches, executedPaths, filterPattern, fnmatchPattern, localUses, normalisePath, parseWorkflow, pushPathFilter, runsOnPushTo, secretsIn, shellCommands, triggers, unfilteredPush } from "../src/audit/workflow";

const wf = (text: string) => {
  const p = parseWorkflow(text);
  if (!p.ok) throw new Error(p.error);
  return p.wf;
};

describe("branch filters", () => {
  test("* stays inside one segment, ** crosses them", () => {
    expect(filterPattern("mq/*").test("mq/1")).toBe(true);
    expect(filterPattern("mq/*").test("mq/a/1")).toBe(false);
    expect(filterPattern("mq/**").test("mq/a/1")).toBe(true);
    expect(filterPattern("release.x").test("releaseYx")).toBe(false);
  });

  test("branches: the last matching pattern decides, ! excludes", () => {
    const f = { branches: ["**", "!mq/build/**"] };
    expect(branchFilterMatches(f, "trunk")).toBe(true);
    expect(branchFilterMatches(f, "mq/build/3")).toBe(false);
    expect(branchFilterMatches({ "branches-ignore": ["mq/**"] }, "mq/batch/1")).toBe(false);
    expect(branchFilterMatches({ "branches-ignore": ["mq/**"] }, "trunk")).toBe(true);
  });

  test("a tags-only push filter never runs for a branch; no filter runs for every branch", () => {
    expect(branchFilterMatches({ tags: ["v*"] }, "trunk")).toBe(false);
    expect(branchFilterMatches(null, "anything")).toBe(true);
  });

  test("on: as a string, a list and a map", () => {
    expect([...triggers(wf("on: push\njobs: {}\n")).keys()]).toEqual(["push"]);
    expect([...triggers(wf("on: [push, pull_request]\njobs: {}\n")).keys()]).toEqual(["push", "pull_request"]);
    expect([...triggers(wf("on:\n  push:\n    branches: [trunk]\njobs: {}\n")).keys()]).toEqual(["push"]);
  });

  test("an unfiltered push is one with no branch or tag filter, path filters aside", () => {
    expect(unfilteredPush(wf("on: push\n"))).toBe(true);
    expect(unfilteredPush(wf("on:\n  push:\n    paths: [src/**]\n"))).toBe(true);
    expect(unfilteredPush(wf("on:\n  push:\n    tags: [v*]\n"))).toBe(false);
    expect(unfilteredPush(wf("on:\n  push:\n    branches: [trunk]\n"))).toBe(false);
    expect(unfilteredPush(wf("on: pull_request\n"))).toBe(false);
  });

  test("runsOnPushTo and the push path filter", () => {
    const w = wf('on:\n  push:\n    branches: [trunk, "mq/batch/**"]\n    paths-ignore: [docs/**]\n');
    expect(runsOnPushTo(w, "mq/batch/1")).toBe(true);
    expect(runsOnPushTo(w, "mq/build/1")).toBe(false);
    expect(pushPathFilter(w)).toBe("paths-ignore");
  });
});

describe("run: scripts", () => {
  const paths = (s: string) => executedPaths(s).paths;

  test("interpreters, paths as commands, -f files, nix develop and uv run wrappers", () => {
    expect(paths("bash build/test.sh --fast")).toEqual(["build/test.sh"]);
    expect(paths("./build/lint.sh")).toEqual(["build/lint.sh"]);
    expect(paths("bun scripts/gate.ts && echo done")).toEqual(["scripts/gate.ts"]);
    expect(paths("jq -f .github/x.jq data.json")).toEqual([".github/x.jq"]);
    expect(paths("nix develop .#app -c bash ci/run.sh")).toEqual(["ci/run.sh"]);
    expect(paths("FOO=1 uv run --frozen python tools/check.py")).toEqual(["tools/check.py"]);
    expect(paths("bun run lint")).toEqual([]);
    expect(paths('cd "$GITHUB_WORKSPACE" && bash "$GITHUB_WORKSPACE/ci/x.sh"')).toEqual(["ci/x.sh"]);
  });

  test("bash -c strings and $( … ) inside quotes are scanned too", () => {
    expect(paths("cat files | nix develop .#app -c bash -c 'bun run ci/targets.ts --print >\"$1\"' _ out")).toEqual(["ci/targets.ts"]);
    expect(paths('if [ "$(bash ci/changed.sh "$A" "$B")" = true ]; then\n  echo yes\nfi')).toEqual(["ci/changed.sh"]);
  });

  test("comments, echo text, heredoc bodies and system paths are not commands", () => {
    expect(paths("# bash ci/old.sh\necho \"see ci/x.sh\"\ncat <<'EOF'\nbash ci/in-heredoc.sh\nEOF\n/usr/bin/env true\nbash ci/after.sh")).toEqual(["ci/after.sh"]);
  });

  test("a path built from a variable cannot be resolved", () => {
    expect(executedPaths("bash ci/$NAME.sh")).toEqual({ paths: [], dynamic: ["ci/$NAME.sh"] });
  });

  test("shellCommands splits at operators outside quotes only", () => {
    expect(shellCommands("a 'x|y' && b \"c;d\" | e")).toEqual([["a", "x|y"], ["b", "c;d"], ["e"]]);
  });

  test("normalisePath and localUses", () => {
    expect(normalisePath("app/../ci/x.sh")).toBe("ci/x.sh");
    expect(normalisePath("../x")).toBeNull();
    expect(localUses("./.github/actions/setup")).toBe(".github/actions/setup");
    expect(localUses("actions/checkout@v4")).toBeNull();
  });

  test("secrets: GITHUB_TOKEN and file names that merely contain 'secrets.' are not secrets", () => {
    expect(secretsIn({ env: { A: "${{ secrets.DEPLOY_KEY }}", B: "${{ secrets.GITHUB_TOKEN }}" }, run: "scan --baseline .secrets.baseline" })).toEqual(["DEPLOY_KEY"]);
    expect(secretsIn({ secrets: "inherit" })).toEqual(["(inherit)"]);
  });
});

test("review cases: if/then, env X=1, absolute interpreters, a variable operand, executed heredocs, backquotes in quotes", () => {
  const r = (s: string) => executedPaths(s);
  expect(r("if bun src/a.ts; then echo; fi").paths).toEqual(["src/a.ts"]);
  expect(r("env X=1 bun src/b.ts").paths).toEqual(["src/b.ts"]);
  expect(r("/usr/bin/bash src/c.sh").paths).toEqual(["src/c.sh"]);
  expect(r('bun "$SCRIPT"').dynamic).toEqual(["$SCRIPT"]);
  expect(r("bash <<'EOF'\nbash src/d.sh\nEOF\ncat <<EOF\nbash src/not-run.sh\nEOF").paths).toEqual(["src/d.sh"]);
  expect(r('echo "`bash src/e.sh`"').paths).toEqual(["src/e.sh"]);
  expect(fnmatchPattern("refs/heads/main?").test("refs/heads/main")).toBe(false);
  expect(fnmatchPattern("refs/heads/a+b").test("refs/heads/a+b")).toBe(true);
  expect(filterPattern("[z-a]").test("x")).toBe(false); // an invalid class is literal, not a crash
});
