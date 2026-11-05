// The public tree (scripts/public-tree.ts), the export (scripts/export-public.ts)
// and the public repo's own workflows (public/.github/workflows here,
// .github/workflows in the public repo). The export is tested end to end on
// throwaway repos with neutral rules (acme, alice).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules, type RulesFile } from "../scripts/public-scrub";
import { danglingDocReferences, listFiles, makePublicTree } from "../scripts/public-tree";
import { ExportError, exportPublic } from "../scripts/export-public";
import { templatePinProblem } from "../scripts/template-pin";

const ROOT = join(import.meta.dir, "..");
const ALICE = "Alice Example <alice@example.org>";
const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;

const neutral = (): RulesFile => ({
  exclude: ["private/", "docs/plan.md", "deploy.yml"],
  identities: { authors: [ALICE], committers: [ALICE, "GitHub <noreply@github.com>"] },
  allow: [],
  rules: [{ id: "word", pattern: "\\bacme\\w*", flags: "i", note: "the name", examples: ["acme"] }],
});

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "export-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function write(dir: string, files: Record<string, string>) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
}

function git(dir: string, args: string[], who = "Mallory Private <m@private.example>") {
  const [, name, email] = /^(.*) <(.*)>$/.exec(who)!;
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

const noPin = () => null; // the pin gate has its own tests (test/template-pin.test.ts)

/** A private repo with an overlay, deny-listed paths and a clean public part, tagged `t1`. */
function privateRepo(extra: Record<string, string> = {}): string {
  const d = tmp();
  git(d, ["init", "-q", "-b", "main"]);
  write(d, {
    "package.json": JSON.stringify({ name: "x", version: "0.1.0" }),
    "README.md": "A queue. See docs/design.md.\n",
    "docs/design.md": "design\n",
    "docs/plan.md": "the acme plan\n",
    "deploy.yml": "org: acme\n",
    "private/notes.txt": "acme\n",
    ".github/workflows/ci.yml": "private ci\n",
    "public/.github/workflows/ci.yml": "public ci\n",
    "public/.github/workflows/extra.yml": "public only\n",
    ...extra,
  });
  git(d, ["add", "-A"]);
  git(d, ["commit", "-q", "-m", "private history, acme everywhere"]);
  git(d, ["tag", "t1"]);
  return d;
}

describe("makePublicTree", () => {
  test("the overlay replaces and adds files, public/ goes, then the deny-list is deleted", () => {
    const d = tmp();
    write(d, { "a.txt": "a", ".github/workflows/ci.yml": "private", "public/.github/workflows/ci.yml": "public", "public/new.txt": "new", "private/x": "x", "deploy.yml": "x", "keep/deploy.yml": "kept" });
    makePublicTree(d, neutral().exclude);
    expect(listFiles(d)).toEqual([".github/workflows/ci.yml", "a.txt", "keep/deploy.yml", "new.txt"]);
    expect(readFileSync(join(d, ".github/workflows/ci.yml"), "utf8")).toBe("public");
  });
  test("an overlay file on the deny-list is deleted too", () => {
    const d = tmp();
    write(d, { "public/deploy.yml": "x", "b.txt": "b" });
    makePublicTree(d, neutral().exclude);
    expect(listFiles(d)).toEqual(["b.txt"]);
  });
  test("refuses an exclude path that could leave the tree", () => {
    for (const bad of ["../x", "/etc", "a/../../b", ""]) expect(() => makePublicTree(tmp(), [bad]), bad).toThrow(/bad exclude path/);
  });
});

describe("danglingDocReferences", () => {
  test("a shipped file that names a deny-listed document", () => {
    const d = tmp();
    write(d, { "README.md": "see docs/plan.md §3\n", "docs/design.md": "fine\n" });
    expect(danglingDocReferences(d, neutral().exclude)).toEqual(["README.md: docs/plan.md"]);
    expect(danglingDocReferences(d, ["private/"])).toEqual([]);
  });
});

describe("exportPublic", () => {
  const rules = () => loadRules(neutral());

  test("one commit and one tag, by the one allowed identity, of the public tree, with no remote", () => {
    const repo = privateRepo();
    const out = join(tmp(), "public");
    const r = exportPublic({ templatePin: noPin, repo, tag: "t1", out, rules: rules() });
    expect(r).toMatchObject({ tag: "v0.1.0", identity: ALICE, signed: false, files: 5 });
    expect(listFiles(out, (p) => p === ".git")).toEqual([".github/workflows/ci.yml", ".github/workflows/extra.yml", "README.md", "docs/design.md", "package.json"]);
    expect(readFileSync(join(out, ".github/workflows/ci.yml"), "utf8")).toBe("public ci\n");
    expect(git(out, ["log", "--all", "--format=%H|%an <%ae>|%cn <%ce>|%s"])).toBe(`${r.commit}|${ALICE}|${ALICE}|qlander v0.1.0`);
    expect(git(out, ["for-each-ref", "refs/tags", "--format=%(refname:short) %(objecttype) %(taggername) %(taggeremail) %(contents:subject)"])).toBe(`v0.1.0 tag ${ALICE} qlander v0.1.0`);
    expect(git(out, ["remote"])).toBe("");
    expect(git(out, ["branch", "--show-current"])).toBe("main");
    expect(git(out, ["status", "--porcelain"])).toBe("");
  });

  test("a hit in the shipped tree refuses, names it, and leaves nothing behind", () => {
    const repo = privateRepo({ "src/x.ts": "// acme\n" });
    const out = join(tmp(), "public");
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out, rules: rules() })).toThrow(/the tree: 1 scrub hit\nsrc\/x\.ts:1:acme:word/);
    expect(existsSync(out)).toBe(false);
  });

  test("a hit in a path name refuses", () => {
    const repo = privateRepo({ "acme-notes.md": "fine\n" });
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out: join(tmp(), "p"), rules: rules() })).toThrow(/acme-notes\.md:0:acme:word/);
  });

  test("a mention of a deny-listed document refuses", () => {
    const repo = privateRepo({ "README.md": "See docs/plan.md.\n" });
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out: join(tmp(), "p"), rules: rules() })).toThrow(/mention deny-listed documents:\nREADME\.md: docs\/plan\.md/);
  });

  test("the message and the annotation are scrubbed before they are written", () => {
    const repo = privateRepo();
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out: join(tmp(), "p"), rules: rules(), message: "first, from acme\n" })).toThrow(/the commit message: 1 scrub hit/);
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out: join(tmp(), "p"), rules: rules(), annotation: "acme release\n" })).toThrow(/the tag annotation: 1 scrub hit/);
  });

  test("only a tag, an empty or absent directory, and exactly one allowed author", () => {
    const repo = privateRepo();
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "main", out: join(tmp(), "p"), rules: rules() })).toThrow(/no tag main/);
    const full = tmp();
    writeFileSync(join(full, "x"), "x");
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out: full, rules: rules() })).toThrow(/exists and is not empty/);
    expect(readdirSync(full)).toEqual(["x"]); // untouched
    const two = rules();
    two.identities = { authors: [ALICE, "Bob <b@example.org>"], committers: [ALICE] };
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out: join(tmp(), "p"), rules: two })).toThrow(/exactly one author identity/);
    const notCommitter = rules();
    notCommitter.identities = { authors: [ALICE], committers: ["GitHub <noreply@github.com>"] };
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out: join(tmp(), "p"), rules: notCommitter })).toThrow(ExportError);
  });

  /** What the CLI's real pin gate needs: a tree that builds, with the running Bun pinned, and this pin in the template. */
  const buildable = (pin: string): Record<string, string> => ({
    "scripts/build-release.ts": readFileSync(join(ROOT, "scripts/build-release.ts"), "utf8"),
    "src/cli.ts": 'console.log("hello");\n',
    "schema/qlander.schema.json": "{}\n",
    ".github/bun-release.txt": `${Bun.version} bun-linux-x64.zip ${"0".repeat(64)}\n`,
    "template/.github/qlander-release.txt": `${pin}\n`,
  });
  /** The pin that tree builds, taken from the gate's own refusal. */
  const builtPin = () => {
    const d = tmp();
    write(d, { "package.json": JSON.stringify({ name: "x", version: "0.1.0" }), ...buildable("stale") });
    return /this tree builds "(.*)"/.exec(templatePinProblem(d)!)![1]!;
  };

  test("the CLI refuses a stale template pin, and builds nothing", () => {
    const repo = privateRepo(buildable(`0.1.0 qlander-0.1.0.js ${"a".repeat(64)}`));
    const out = join(tmp(), "public");
    const rules = join(tmp(), "rules.json");
    writeFileSync(rules, JSON.stringify(neutral()));
    const p = Bun.spawnSync([process.execPath, join(ROOT, "scripts/export-public.ts"), "--repo", repo, "--tag", "t1", "--out", out, "--rules", rules], { stdout: "pipe", stderr: "pipe" });
    expect(p.exitCode).toBe(1);
    expect(p.stderr.toString()).toContain("is stale");
    expect(existsSync(out)).toBe(false);
  });

  test("the CLI ignores an inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE", () => {
    const repo = privateRepo(buildable(builtPin()));
    const other = privateRepo({ "src/x.ts": "// acme\n" }); // would be refused, if it were read
    const out = join(tmp(), "public");
    const rules = join(tmp(), "rules.json");
    writeFileSync(rules, JSON.stringify(neutral()));
    const p = Bun.spawnSync([process.execPath, join(ROOT, "scripts/export-public.ts"), "--repo", repo, "--tag", "t1", "--out", out, "--rules", rules], {
      env: { ...process.env, GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GIT_INDEX_FILE: join(other, ".git/index") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.stderr.toString()).toBe("");
    expect(p.exitCode).toBe(0);
    expect(git(out, ["log", "--format=%an <%ae>"])).toBe(ALICE);
    expect(git(other, ["tag"])).toBe("t1"); // the other repo was not touched
  });

  test("an empty directory that exists is used, and emptied again on failure", () => {
    const repo = privateRepo({ "src/x.ts": "// acme\n" });
    const out = tmp();
    expect(() => exportPublic({ templatePin: noPin, repo, tag: "t1", out, rules: rules() })).toThrow(ExportError);
    expect(readdirSync(out)).toEqual([]);
  });
});

// The public repo's workflows: here under public/, there under .github/.
const publicWorkflows = existsSync(join(ROOT, "public/.github/workflows")) ? join(ROOT, "public/.github/workflows") : join(ROOT, ".github/workflows");
type Obj = Record<string, any>;
const wf = (name: string) => YAML.parse(readFileSync(join(publicWorkflows, name), "utf8")) as Obj;
const steps = (job: Obj): Obj[] => job.steps as Obj[];

describe("the public repo's workflows", () => {
  test("ci, release, scrub and scrub-published, each a GitHub-hosted runner; the scrub rules secret is the only secret", () => {
    for (const name of ["ci.yml", "release.yml", "scrub.yml", "scrub-published.yml"]) {
      const w = wf(name);
      for (const [id, job] of Object.entries(w.jobs as Obj)) expect(job["runs-on"], `${name} ${id}`).toBe("ubuntu-latest");
      const secrets = readFileSync(join(publicWorkflows, name), "utf8").match(/secrets\.\w+/g) ?? [];
      expect(new Set(secrets), name).toEqual(new Set(name === "ci.yml" ? [] : ["secrets.PUBLIC_SCRUB_RULES"]));
    }
  });

  test("ci runs the suite (on the example config: the public repo has no qlander.yml), tsc and the linters, and nothing that needs a control repo", () => {
    const runs = Object.values(wf("ci.yml").jobs as Obj).flatMap((j) => steps(j).map((s) => String(s.run ?? "")));
    for (const want of ["bun test", "bunx tsc --noEmit", "zizmor", "actionlint"]) expect(runs.some((r) => r.includes(want)), want).toBe(true);
    for (const not of ["render --check", "public-scrub"]) expect(runs.some((r) => r.includes(not)), not).toBe(false);
  });

  test("scrub: pull_request_target on every PR, main checked out, the head fetched as data, every surface scanned, failing and redacted", () => {
    const w = wf("scrub.yml");
    expect(Object.keys(w.on)).toEqual(["pull_request_target"]);
    expect(w.on.pull_request_target).toEqual({ types: ["opened", "synchronize", "reopened", "edited"] });
    expect(w.permissions).toEqual({});
    const job = w.jobs.scrub as Obj;
    expect(job.name).toBe("public scrub");
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read" });
    const checkout = steps(job).find((s) => String(s.uses ?? "").startsWith("actions/checkout@"))!;
    expect(checkout.with.ref).toBe("main"); // never the PR head, and only main's script sees the rules
    expect(checkout.with["persist-credentials"]).toBe(false);
    const text = steps(job).map((s) => String(s.run ?? "")).join("\n");
    expect(text).not.toMatch(/git (checkout|switch|worktree)|refs\/scrub\/head:?\S*\s*&&|bun .*refs\/scrub/);
    const scan = steps(job).find((s) => String(s.run ?? "").includes("scripts/public-scrub.ts"))!;
    for (const flag of ["--fail", "--redact", "--forbid-excluded", '--tree "$HEAD_SHA"', '--commits "$BASE_SHA..$HEAD_SHA"', '--commit-trees "$BASE_SHA..$HEAD_SHA"', '"$t/pr-title"', '"$t/pr-body"', '"$t/branch-name"']) expect(scan.run, flag).toContain(flag);
    // Untrusted text reaches the shell neither as an expression in the script nor through env, which the log prints.
    for (const s of steps(job)) expect(String(s.run ?? ""), s.name).not.toContain("${{");
    for (const s of steps(job)) expect(JSON.stringify(s.env ?? {}), s.name).not.toMatch(/\.(title|body|ref)\b/);
  });

  test("scrub-published: every branch push, tags and releases; the script from main; an alert issue on a hit", () => {
    const w = wf("scrub-published.yml");
    expect(w.on).toEqual({ push: { branches: ["**"], tags: ["**"] }, release: { types: ["created", "published", "edited"] } });
    const job = w.jobs.scrub as Obj;
    expect(job.permissions).toEqual({ contents: "read", issues: "write" });
    expect(steps(job).find((s) => String(s.uses ?? "").startsWith("actions/checkout@"))!.with.ref).toBe("main");
    const run = steps(job).map((s) => String(s.run ?? "")).join("\n");
    for (const want of ["--fail", "--redact", "--forbid-excluded", "--commits", "--tag refs/scrub/tag", '!= "$AFTER"', "release-notes", "gh issue create"]) expect(run, want).toContain(want);
    for (const s of steps(job)) expect(String(s.run ?? ""), s.name).not.toContain("${{");
  });

  test("release: builds only a tag on main; scrubs the tag object the run was started for and the notes, failing, before anything is published", () => {
    const names = steps(wf("release.yml").jobs.release).map((s) => s.name as string);
    expect(names.indexOf("Refuse a tag that is not on main")).toBe(1); // right after the checkout, before any build or secret
    const scrub = names.indexOf("Scrub the tag (name, annotation, tagger), the release notes, the tree and the assets");
    expect(scrub).toBeGreaterThan(names.indexOf("Write the release notes"));
    expect(scrub).toBeLessThan(names.indexOf("Attest build provenance"));
    expect(scrub).toBeLessThan(names.indexOf("Publish the release"));
    const run = String(steps(wf("release.yml").jobs.release)[scrub]!.run);
    for (const want of ["--fail", "--redact", "--tag refs/scrub/tag", '"$t/tag-name"', '"$RUNNER_TEMP/notes.md"', '--tree "$TAG_COMMIT"', "--tree dist", '!= "$TAG_OBJECT"']) expect(run, want).toContain(want);
  });

  test("the main ruleset requires the public scrub and CI, from GitHub Actions, on squash merges only", () => {
    const r = JSON.parse(readFileSync(join(publicWorkflows, "../rulesets/main.json"), "utf8")) as Obj;
    expect(r).toMatchObject({ target: "branch", enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["~DEFAULT_BRANCH"] } } });
    const rule = (type: string) => (r.rules as Obj[]).find((x) => x.type === type)!;
    for (const type of ["deletion", "non_fast_forward", "required_signatures"]) expect(rule(type), type).toBeDefined();
    expect(rule("pull_request").parameters.allowed_merge_methods).toEqual(["squash"]);
    const checks = rule("required_status_checks").parameters.required_status_checks as Obj[];
    for (const c of checks) expect(c.integration_id, c.context).toBe(15368);
    const required = checks.map((c) => c.context as string);
    expect(required).toContain("public scrub");
    // Each one is a job some pull_request workflow really has: a renamed job would never report, and block every merge.
    const jobNames = ["scrub.yml", "ci.yml"].flatMap((n) => Object.values(wf(n).jobs as Obj).map((j) => j.name as string));
    expect(jobNames.sort()).toEqual([...required].sort());
  });

  test("the tags ruleset stops anyone moving or deleting a published tag", () => {
    const r = JSON.parse(readFileSync(join(publicWorkflows, "../rulesets/tags.json"), "utf8")) as Obj;
    expect(r).toMatchObject({ target: "tag", enforcement: "active", conditions: { ref_name: { include: ["~ALL"] } } });
    expect((r.rules as Obj[]).map((x) => x.type).sort()).toEqual(["deletion", "non_fast_forward", "update"]);
    expect(r.bypass_actors).toEqual([]);
  });

  test.skipIf(!existsSync(join(ROOT, "public/.github/workflows")))("release: the public copy is this repo's release.yml plus those three steps", () => {
    const priv = YAML.parse(readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8")) as Obj;
    const pub = wf("release.yml");
    const added = ["Refuse a tag that is not on main", "Refuse a stale template pin", "Scrub the tag (name, annotation, tagger), the release notes, the tree and the assets"];
    pub.jobs.release.steps = steps(pub.jobs.release).filter((s) => !added.includes(s.name));
    expect(pub).toEqual(priv);
  });
});
