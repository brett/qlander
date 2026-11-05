// The public repo's scrub checks, run for real: each step's own `run:` script,
// with its own `env:` mapping resolved, under bash, against throwaway git repos
// and a neutral secret. Every surface has a case that must fail, and each case
// names the argument that catches it: with that argument dropped from the
// workflow the same case must pass, so no check here passes by accident.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const overlay = existsSync(join(ROOT, "public/.github/workflows")) ? join(ROOT, "public") : ROOT;
const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
type Obj = Record<string, any>;

const ALICE = "Alice Example <alice@example.org>";
const WEB_FLOW = "GitHub <noreply@github.com>";
const MALLORY = "Mallory Private <mallory@private.example>";
const RULES = JSON.stringify({
  exclude: ["private/"],
  identities: { authors: [ALICE], committers: [ALICE, WEB_FLOW] },
  allow: [],
  rules: [{ id: "word", pattern: "\\bacme\\w*", flags: "i", note: "the name", examples: ["acme"] }],
});

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "scrub-run-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const ident = (who: string) => /^(.*) <(.*)>$/.exec(who)!.slice(1) as [string, string];
const BASE_ENV = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function git(dir: string, args: string[], o: { author?: string; committer?: string } = {}): string {
  const [an, ae] = ident(o.author ?? ALICE);
  const [cn, ce] = ident(o.committer ?? ALICE);
  const p = Bun.spawnSync(["git", "-C", dir, ...args], { env: { ...BASE_ENV, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce }, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString().trim();
}

type Change = { files?: Record<string, string>; message?: string; author?: string; committer?: string };

function commit(dir: string, c: Change = {}): string {
  for (const [f, body] of Object.entries(c.files ?? { "change.txt": "a change\n" })) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), body);
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", c.message ?? "a change"], c);
  return git(dir, ["rev-parse", "HEAD"]);
}

/** A checkout of main holding the real script, and the "server" it came from, as SERVER/REPO.git. */
function world() {
  const root = tmp();
  const checkout = join(root, "checkout");
  mkdirSync(join(checkout, "scripts"), { recursive: true });
  cpSync(join(ROOT, "scripts/public-scrub.ts"), join(checkout, "scripts/public-scrub.ts"));
  git(checkout, ["init", "-q", "-b", "main"]);
  const base = commit(checkout, { files: { "README.md": "a queue\n" }, message: "start" });
  const bare = join(root, "server/o/r.git");
  mkdirSync(dirname(bare), { recursive: true });
  git(root, ["clone", "-q", "--bare", checkout, bare]);
  const dev = join(root, "dev");
  git(root, ["clone", "-q", bare, dev]);
  const temp = join(root, "temp");
  mkdirSync(temp);
  return { checkout, base, bare, dev, temp, server: `file://${join(root, "server")}` };
}

const workflow = (name: string): Obj => YAML.parse(readFileSync(join(overlay, ".github/workflows", name), "utf8")) as Obj;
const jobSteps = (w: Obj, job: string): Obj[] => w.jobs[job].steps;
const stepNamed = (w: Obj, job: string, name: string): Obj => {
  const s = jobSteps(w, job).find((x) => String(x.name ?? "").startsWith(name));
  if (!s) throw new Error(`no step ${name}`);
  return s;
};

/** The step's own env mapping against a github/secrets context. An expression with no value is empty, as on GitHub. */
function resolveEnv(step: Obj, ctx: Obj): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((step.env ?? {}) as Record<string, string>)) {
    out[k] = String(v).replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => String(path.split(".").reduce((o: any, part) => o?.[part], ctx) ?? ""));
  }
  return out;
}

/** Runs a step as GitHub does (bash -eo pipefail). `drop`: arguments removed from the script first; each must be there. */
function runStep(step: Obj, ctx: Obj, cwd: string, temp: string, drop: string[] = [], extra: Record<string, string> = {}) {
  let script = String(step.run);
  for (const d of drop) {
    if (!script.includes(d)) throw new Error(`the step has no ${d}`);
    script = script.split(d).join("");
  }
  const p = Bun.spawnSync(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", script], {
    cwd,
    env: { ...BASE_ENV, RUNNER_TEMP: temp, ...extra, ...resolveEnv(step, ctx) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

/** A stub `gh` that prints $GH_STUB_OUT and records its arguments and any --body-file. */
function stubGh(temp: string): { path: string; log: string } {
  const bin = join(temp, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(temp, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/bash\necho "$*" >> "${log}"\nwhile [ $# -gt 0 ]; do if [ "$1" = --body-file ]; then cat "$2" >> "${log}"; fi; shift; done\necho "$GH_STUB_OUT"\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { path: `${bin}:${BASE_ENV.PATH}`, log };
}

/** A case fails with the workflow as it is (no leak in the log), and passes once the arguments that catch it are gone. */
function failsAndIsCaughtBy(run: (drop: string[]) => { code: number | null; out: string }, drop: string[]) {
  const r = run([]);
  expect(r.code, r.out).toBe(1);
  expect(r.out.toLowerCase()).not.toContain("acme");
  const without = run(drop);
  expect(without.code, without.out).toBe(0);
}

describe("scrub.yml, on a PR", () => {
  const w = workflow("scrub.yml");
  type Pr = { change?: Change; changes?: Change[]; title?: string; body?: string | null; branch?: string; liveHead?: string };
  function pr(p: Pr, drop: string[] = [], secret: string | undefined = RULES) {
    const x = world();
    for (const c of p.changes ?? []) commit(x.dev, c);
    const head = commit(x.dev, p.change ?? {});
    git(x.dev, ["push", "-q", "origin", "HEAD:refs/pull/7/head"]);
    const ctx = {
      secrets: { PUBLIC_SCRUB_RULES: secret },
      // The event's text is what an old run would have; the check must read the API's.
      github: { token: "t", server_url: x.server, repository: "o/r", event: { pull_request: { number: 7, title: "stale", body: "stale", head: { sha: head, ref: "stale" }, base: { sha: x.base } } } },
    };
    const gh = stubGh(x.temp);
    const live = { title: p.title ?? "a title", body: p.body === undefined ? "a body" : p.body, head: { sha: p.liveHead ?? head, ref: p.branch ?? "topic" } };
    const fetched = runStep(stepNamed(w, "scrub", "Fetch the PR head"), ctx, x.checkout, x.temp);
    expect(fetched.code, fetched.out).toBe(0);
    return runStep(stepNamed(w, "scrub", "Scrub"), ctx, x.checkout, x.temp, drop, { PATH: gh.path, GH_STUB_OUT: JSON.stringify(live) });
  }

  test("a clean PR passes, also with no body and with a web-flow committer", () => {
    expect(pr({}).code).toBe(0);
    expect(pr({ body: null }).code).toBe(0);
    expect(pr({ change: { committer: WEB_FLOW } }).code).toBe(0);
  });
  const cases: [string, Pr, string[]][] = [
    ["the title", { title: "the acme fix" }, ['--text "$t/pr-title"']],
    ["the body", { body: "first line\nfor acme" }, ['--text "$t/pr-body"']],
    ["the branch name", { branch: "acme/fix" }, ['--text "$t/branch-name"']],
    ["a commit message", { change: { message: "fix\n\nfor acme" } }, ['--commits "$BASE_SHA..$HEAD_SHA"']],
    ["the author", { change: { author: MALLORY } }, ['--commits "$BASE_SHA..$HEAD_SHA"']],
    ["the committer", { change: { committer: MALLORY } }, ['--commits "$BASE_SHA..$HEAD_SHA"']],
    ["a file", { change: { files: { "src.txt": "for acme\n" } } }, ['--tree "$HEAD_SHA"', ' --commit-trees "$BASE_SHA..$HEAD_SHA"']],
    ["a path name", { change: { files: { "acme.txt": "x\n" } } }, ['--tree "$HEAD_SHA"', ' --commit-trees "$BASE_SHA..$HEAD_SHA"']],
    ["a file added in one commit and removed in the next", { changes: [{ files: { "src.txt": "for acme\n" } }], change: { files: { "src.txt": "clean\n" } } }, [' --commit-trees "$BASE_SHA..$HEAD_SHA"']],
    ["a deny-listed path", { change: { files: { "private/x.txt": "x\n" } } }, ["--forbid-excluded"]],
  ];
  for (const [name, p, drop] of cases) test(`fails on ${name}`, () => failsAndIsCaughtBy((d) => pr(p, d), drop));

  test("a run for an older head of the PR fails", () => {
    expect(pr({ liveHead: "f".repeat(40) }).code).toBe(1);
  });
  test("--fail is what makes a hit fail; --redact is what keeps it out of the log", () => {
    const hit: Pr = { title: "the acme fix" };
    expect(pr(hit, ["--fail"]).code).toBe(0);
    expect(pr(hit, ["--redact"]).out).toContain("acme");
  });
  test("no rules, or broken rules, is a failure, never a clean result, and a broken rule's id stays out of the log", () => {
    expect(pr({}, [], "").code).toBe(2);
    expect(pr({}, [], "{").code).toBe(2);
    const broken = JSON.stringify({ exclude: [], allow: [], rules: [{ id: "acme-rule", pattern: "(", note: "n", examples: ["x"] }] });
    const r = pr({}, [], broken);
    expect(r.code).toBe(2);
    expect(r.out).not.toContain("acme-rule");
  });
  test("a step's env, which the log prints, never holds the PR's text", () => {
    for (const s of jobSteps(w, "scrub")) expect(JSON.stringify(s.env ?? {}), s.name).not.toMatch(/\.(title|body)\b/);
  });
});

describe("scrub-published.yml", () => {
  const w = workflow("scrub-published.yml");
  const scrub = stepNamed(w, "scrub", "Scrub");
  const ZERO = "0".repeat(40);
  const ctx = (x: ReturnType<typeof world>, github: Obj) => ({ secrets: { PUBLIC_SCRUB_RULES: RULES }, github: { token: "t", server_url: x.server, repository: "o/r", ...github } });

  function push(c: Change, o: { branch?: string; newBranch?: boolean; before?: Change } = {}, drop: string[] = []) {
    const x = world();
    const before = git(x.checkout, ["rev-parse", "HEAD"]);
    if (o.branch) git(x.checkout, ["checkout", "-q", "-b", o.branch]);
    if (o.before) commit(x.checkout, o.before);
    const after = commit(x.checkout, c);
    git(x.checkout, ["checkout", "-q", "--detach"]);
    const ref = `refs/heads/${o.branch ?? "main"}`;
    return runStep(scrub, ctx(x, { event_name: "push", event: { before: o.newBranch ? ZERO : before, after } }), x.checkout, x.temp, drop, { GITHUB_REF: ref });
  }

  type Tag = { name?: string; pushedAs?: string; message?: string; tagger?: string; change?: Change; light?: boolean };
  function tagPush(t: Tag, drop: string[] = [], moved = false) {
    const x = world();
    commit(x.dev, t.change ?? {});
    const name = t.name ?? "v1";
    if (t.light) git(x.dev, ["tag", name]);
    else git(x.dev, ["tag", "-a", name, "-m", t.message ?? "a release"], { committer: t.tagger ?? ALICE });
    const dest = t.pushedAs ?? name;
    git(x.dev, ["push", "-q", "origin", `refs/tags/${name}:refs/tags/${dest}`]);
    const after = moved ? x.base : git(x.dev, ["rev-parse", `refs/tags/${name}`]);
    return runStep(scrub, ctx(x, { event_name: "push", event: { after } }), x.checkout, x.temp, drop, { GITHUB_REF: `refs/tags/${dest}` });
  }

  function release(r: { name?: string; tag?: string; body?: string }, drop: string[] = []) {
    const x = world();
    const event = join(x.temp, "event.json");
    writeFileSync(event, JSON.stringify({ release: { name: r.name ?? "v1", tag_name: r.tag ?? "v1", body: r.body ?? "notes" } }));
    return runStep(scrub, ctx(x, { event_name: "release" }), x.checkout, x.temp, drop, { GITHUB_REF: "refs/tags/v1", GITHUB_EVENT_PATH: event });
  }

  test("clean pushes, tags and releases pass", () => {
    expect(push({}).code).toBe(0);
    expect(push({}, { branch: "topic", newBranch: true }).code).toBe(0);
    expect(tagPush({}).code).toBe(0);
    expect(release({}).code).toBe(0);
  });

  const TREE = '--tree "$AFTER" ';
  const RANGE = ' --commits "$range"';
  const TREES = ' --commit-trees "$range"';
  const pushes: [string, Change, { branch?: string; newBranch?: boolean; before?: Change }, string[]][] = [
    ["a squash message edited at merge time", { message: "fix for acme" }, {}, [RANGE]],
    ["a commit author on main", { author: MALLORY }, {}, [RANGE]],
    ["a file on main", { files: { "src.txt": "acme\n" } }, {}, [TREE, TREES]],
    ["a branch's name, with no PR", {}, { branch: "acme-fix", newBranch: true }, ['args+=(--text "$t/branch-name")']],
    ["a side branch's commit", { message: "for acme" }, { branch: "topic", newBranch: true }, [RANGE]],
    ["a side branch's file", { files: { "src.txt": "acme\n" } }, { branch: "topic" }, [TREE, TREES]],
    ["a file added and removed on a side branch", { files: { "src.txt": "clean\n" } }, { branch: "topic", newBranch: true, before: { files: { "src.txt": "acme\n" } } }, [TREES]],
  ];
  for (const [name, c, o, drop] of pushes) test(`fails on ${name}`, () => failsAndIsCaughtBy((d) => push(c, o, d), drop));

  const TAG = '--tag refs/scrub/tag ';
  const tags: [string, Tag, string[]][] = [
    ["the name a tag is pushed under", { pushedAs: "v1-acme" }, ['--text "$t/tag-name" ']],
    ["the name inside a tag object", { name: "v1-acme", pushedAs: "v1" }, [TAG]],
    ["a tag's annotation", { message: "for acme" }, [TAG]],
    ["a tag's tagger", { tagger: MALLORY }, [TAG]],
    ["a lightweight tag, which has no tagger", { light: true }, [TAG]],
    ["a tagged commit's file", { change: { files: { "src.txt": "acme\n" } } }, ['--tree "refs/scrub/tag^{commit}" ']],
    ["a tagged commit's message", { change: { message: "for acme" } }, ['--commits "refs/scrub/tag^{commit}"']],
  ];
  for (const [name, t, drop] of tags) test(`fails on ${name}`, () => failsAndIsCaughtBy((d) => tagPush(t, d), drop));

  test("a tag that moved after the push fails, with nothing scanned as if it were the pushed object", () => {
    expect(tagPush({}, [], true).code).toBe(1);
  });
  test("a pushed commit that can't be found fails", () => {
    const x = world();
    const r = runStep(scrub, ctx(x, { event_name: "push", event: { before: x.base, after: "e".repeat(40) } }), x.checkout, x.temp, [], { GITHUB_REF: "refs/heads/topic" });
    expect(r.code).not.toBe(0);
  });
  test("a step's env, which the log prints, never holds a release's text; and no pending run can replace another", () => {
    for (const s of jobSteps(w, "scrub")) expect(JSON.stringify(s.env ?? {}), s.name).not.toMatch(/\.release\./);
    expect(w.concurrency).toBeUndefined();
  });

  const releases: [string, { name?: string; tag?: string; body?: string }, string[]][] = [
    ["a release's name", { name: "acme release" }, ['--text "$t/release-name" ']],
    ["a release's tag", { tag: "v1-acme" }, ['--text "$t/release-tag" ']],
    ["a release's notes", { body: "line\nfor acme" }, [' --text "$t/release-notes"']],
  ];
  for (const [name, r, drop] of releases) test(`fails on ${name}`, () => failsAndIsCaughtBy((d) => release(r, d), drop));

  test("the alert issue says where to look, never what was found, and only a failed scrub opens one", () => {
    const x = world();
    const gh = stubGh(x.temp);
    const alert = stepNamed(w, "scrub", "Open an alert issue");
    expect(alert.if).toBe("failure() && steps.scrub.outcome == 'failure'");
    const r = runStep(alert, ctx(x, { run_id: 5 }), x.checkout, x.temp, [], { PATH: gh.path });
    expect(r.code, r.out).toBe(0);
    const log = readFileSync(gh.log, "utf8");
    expect(log).toContain("issue create");
    expect(log).toContain("actions/runs/5");
  });

  test("a deleted branch or tag is not scanned", () => {
    expect(w.jobs.scrub.if).toBe("${{ github.event.deleted != true }}");
  });
});

describe("release.yml, before anything goes out", () => {
  const w = workflow("release.yml");
  const scrub = stepNamed(w, "release", "Scrub the tag");

  function tagged(t: { name?: string; message?: string; tagger?: string; light?: boolean; notes?: string; change?: Change; moved?: boolean; asset?: string; secret?: string }, drop: string[] = []) {
    const x = world();
    const head = commit(x.dev, t.change ?? {});
    const tag = t.name ?? "v1.2.3";
    if (t.light) git(x.dev, ["tag", tag]);
    else git(x.dev, ["tag", "-a", tag, "-m", t.message ?? "a release"], { committer: t.tagger ?? ALICE });
    git(x.dev, ["push", "-q", "origin", `refs/tags/${tag}`]);
    git(x.checkout, ["fetch", "-q", x.bare, `+refs/tags/${tag}:refs/tags/${tag}`]);
    writeFileSync(join(x.temp, "bun-path"), `${process.execPath}\n`);
    mkdirSync(join(x.checkout, "dist"));
    writeFileSync(join(x.checkout, "dist", `qlander-${tag.slice(1)}.js`), t.asset ?? "a bundle\n");
    const after = t.moved ? x.base : git(x.dev, ["rev-parse", `refs/tags/${tag}`]);
    const ctx = { secrets: { PUBLIC_SCRUB_RULES: t.secret ?? RULES }, github: { token: "t", server_url: x.server, repository: "o/r", ref_name: tag, sha: head, event: { after } } };
    const notes = runStep(stepNamed(w, "release", "Write the release notes"), ctx, x.checkout, x.temp, [], { GITHUB_SHA: x.base });
    expect(notes.code, notes.out).toBe(0);
    if (t.notes) writeFileSync(join(x.temp, "notes.md"), t.notes);
    return runStep(scrub, ctx, x.checkout, x.temp, drop);
  }

  test("a clean tag, its notes and its tree pass", () => {
    const r = tagged({});
    expect(r.code, r.out).toBe(0);
  });
  const cases: [string, Parameters<typeof tagged>[0], string[]][] = [
    ["the annotation", { message: "for acme" }, ["--tag refs/scrub/tag "]],
    ["the tagger", { tagger: MALLORY }, ["--tag refs/scrub/tag "]],
    ["a lightweight tag", { light: true }, ["--tag refs/scrub/tag "]],
    ["the release notes", { notes: "for acme\n" }, [' --text "$RUNNER_TEMP/notes.md"']],
    ["a built asset", { asset: "var x = 'acme';\n" }, [" --tree dist"]],
    ["a file in the tagged tree", { change: { files: { "src.txt": "acme\n" } } }, [' --tree "$TAG_COMMIT"']],
    ["a deny-listed path in the tagged tree", { change: { files: { "private/x.txt": "x\n" } } }, [" --forbid-excluded"]],
  ];
  for (const [name, t, drop] of cases) test(`fails on ${name}`, () => failsAndIsCaughtBy((d) => tagged(t, d), drop));

  test("fails on the tag name, by each of the three places it appears", () => {
    const name = { name: "v1.2.3-acme" };
    const r = tagged(name);
    expect(r.code, r.out).toBe(1);
    expect(r.out.toLowerCase()).not.toContain("acme");
    const places = ["--tag refs/scrub/tag ", '--text "$t/tag-name" ', ' --text "$RUNNER_TEMP/notes.md"'];
    for (const kept of places) expect(tagged(name, places.filter((p) => p !== kept)).code, kept).toBe(1);
  });
  test("a tag that moved after the run started fails", () => expect(tagged({ moved: true }).code).toBe(1));
  test("without the rules the release is refused", () => expect(tagged({ secret: "" }).code).toBe(2));

  test("the scrub runs before the attestation and the publish, and nothing later can run after it fails", () => {
    const steps = jobSteps(w, "release");
    const at = steps.indexOf(scrub);
    const names = steps.map((s) => String(s.name ?? ""));
    expect(at).toBeLessThan(names.indexOf("Attest build provenance"));
    expect(at).toBeLessThan(names.indexOf("Publish the release"));
    for (const s of steps.slice(at + 1)) {
      expect(String(s.if ?? ""), s.name).not.toMatch(/always|failure|cancelled/);
      expect(s["continue-on-error"], s.name).toBeUndefined();
    }
    expect(scrub["continue-on-error"]).toBeUndefined();
  });

  test("a tag whose commit is not on main is refused before any build", () => {
    const x = world();
    const gh = stubGh(x.temp);
    const refuse = stepNamed(w, "release", "Refuse a tag that is not on main");
    const run = (status: string) => runStep(refuse, { github: { token: "t", repository: "o/r", sha: x.base } }, x.checkout, x.temp, [], { PATH: gh.path, GH_STUB_OUT: status });
    for (const ok of ["identical", "behind"]) expect(run(ok).code, ok).toBe(0);
    for (const bad of ["ahead", "diverged"]) expect(run(bad).code, bad).toBe(1);
  });
});

describe("the maintainer's pre-push hook, on real pushes", () => {
  function repo(rules: string | null = RULES) {
    const x = world();
    mkdirSync(join(x.dev, ".githooks"));
    cpSync(join(overlay, ".githooks/pre-push"), join(x.dev, ".githooks/pre-push"));
    mkdirSync(join(x.dev, "scripts"), { recursive: true });
    cpSync(join(ROOT, "scripts/public-scrub.ts"), join(x.dev, "scripts/public-scrub.ts"));
    git(x.dev, ["config", "core.hooksPath", ".githooks"]);
    const pushRaw = (...refs: string[]) => {
      const env = { ...BASE_ENV, GIT_AUTHOR_NAME: "x", GIT_COMMITTER_NAME: "x", GIT_AUTHOR_EMAIL: "x@x", GIT_COMMITTER_EMAIL: "x@x", ...(rules === null ? {} : { PUBLIC_SCRUB_RULES: rules }) };
      if (rules === null) delete (env as Obj).PUBLIC_SCRUB_RULES;
      const p = Bun.spawnSync(["git", "-C", x.dev, "push", "origin", ...refs], { env, stdout: "pipe", stderr: "pipe" });
      return { code: p.exitCode, out: p.stderr.toString() };
    };
    const onServer = (ref: string) => Bun.spawnSync(["git", "-C", x.bare, "rev-parse", "--verify", "--quiet", ref], { env: BASE_ENV, stdout: "pipe" }).exitCode === 0;
    return { ...x, pushRaw, onServer };
  }

  test("a clean branch and a clean annotated tag go through; a delete goes through", () => {
    const r = repo();
    commit(r.dev);
    expect(r.pushRaw("HEAD:refs/heads/topic").code).toBe(0);
    expect(r.onServer("refs/heads/topic")).toBe(true);
    git(r.dev, ["tag", "-a", "v1", "-m", "a release"]);
    expect(r.pushRaw("refs/tags/v1").code).toBe(0);
    expect(r.onServer("refs/tags/v1")).toBe(true);
    expect(r.pushRaw(":refs/heads/topic").code).toBe(0);
    expect(r.onServer("refs/heads/topic")).toBe(false);
  });

  const refused: [string, (r: ReturnType<typeof repo>) => string, string][] = [
    ["a commit message", (r) => (commit(r.dev, { message: "for acme" }), "HEAD:refs/heads/topic"), "refs/heads/topic"],
    ["a commit author", (r) => (commit(r.dev, { author: MALLORY }), "HEAD:refs/heads/topic"), "refs/heads/topic"],
    ["a file", (r) => (commit(r.dev, { files: { "src.txt": "acme\n" } }), "HEAD:refs/heads/topic"), "refs/heads/topic"],
    ["a deny-listed path", (r) => (commit(r.dev, { files: { "private/x.txt": "x\n" } }), "HEAD:refs/heads/topic"), "refs/heads/topic"],
    ["a branch name", (r) => (commit(r.dev), "HEAD:refs/heads/acme-fix"), "refs/heads/acme-fix"],
    ["a tag name", (r) => (commit(r.dev), git(r.dev, ["tag", "-a", "v1-acme", "-m", "ok"]), "refs/tags/v1-acme"), "refs/tags/v1-acme"],
    ["a tag annotation", (r) => (commit(r.dev), git(r.dev, ["tag", "-a", "v1", "-m", "for acme"]), "refs/tags/v1"), "refs/tags/v1"],
    ["a tagger", (r) => (commit(r.dev), git(r.dev, ["tag", "-a", "v1", "-m", "ok"], { committer: MALLORY }), "refs/tags/v1"), "refs/tags/v1"],
    ["a lightweight tag", (r) => (commit(r.dev), git(r.dev, ["tag", "v1"]), "refs/tags/v1"), "refs/tags/v1"],
  ];
  for (const [name, make, ref] of refused) {
    test(`refuses ${name}, and nothing reaches the server`, () => {
      const r = repo();
      const spec = make(r);
      expect(r.pushRaw(spec).code).not.toBe(0);
      expect(r.onServer(ref)).toBe(false);
    });
  }

  test("refuses a file added and removed before the push, an annotated tag pushed outside refs/tags, and any ref that is not a branch or a tag", () => {
    const r = repo();
    commit(r.dev, { files: { "src.txt": "acme\n" } });
    commit(r.dev, { files: { "src.txt": "clean\n" } });
    expect(r.pushRaw("HEAD:refs/heads/topic").code).not.toBe(0);

    const s = repo();
    commit(s.dev);
    git(s.dev, ["tag", "-a", "v1", "-m", "for acme"]);
    expect(s.pushRaw("refs/tags/v1:refs/archive/v1").code).not.toBe(0);
    expect(s.onServer("refs/archive/v1")).toBe(false);
    expect(s.pushRaw("HEAD:refs/archive/clean").code).not.toBe(0);
  });

  test("scans the real objects, not what git replace shows", () => {
    const r = repo();
    commit(r.dev); // tracks the hook and the script, so the reset below keeps them
    const bad = commit(r.dev, { message: "for acme", files: { "a.txt": "a\n" } });
    git(r.dev, ["reset", "-q", "--hard", "HEAD~1"]);
    const clean = commit(r.dev, { message: "clean", files: { "b.txt": "b\n" } });
    git(r.dev, ["replace", bad, clean]);
    expect(r.pushRaw(`${bad}:refs/heads/topic`).code).not.toBe(0);
    expect(r.onServer("refs/heads/topic")).toBe(false);
  });

  test("deleting a branch with a bad name goes through, so it can be cleaned up", () => {
    const r = repo();
    commit(r.dev);
    git(r.dev, ["-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD:refs/heads/acme-fix"]);
    expect(r.pushRaw(":refs/heads/acme-fix").code).toBe(0);
  });

  test("an update scans what the remote lacks: a new bad commit is refused, and an old one is not scanned again", () => {
    const r = repo();
    commit(r.dev);
    expect(r.pushRaw("HEAD:refs/heads/topic").code).toBe(0);
    commit(r.dev, { files: { "b.txt": "b\n" }, message: "for acme" });
    expect(r.pushRaw("HEAD:refs/heads/topic").code).not.toBe(0);
    git(r.dev, ["-c", "core.hooksPath=/dev/null", "push", "-q", "origin", "HEAD:refs/heads/topic"]);
    commit(r.dev, { files: { "c.txt": "c\n" } });
    expect(r.pushRaw("HEAD:refs/heads/topic").code).toBe(0);
  });

  test("without the rules, the push is refused", () => {
    const r = repo(null);
    commit(r.dev);
    expect(r.pushRaw("HEAD:refs/heads/topic").code).not.toBe(0);
    expect(r.onServer("refs/heads/topic")).toBe(false);
  });
});
