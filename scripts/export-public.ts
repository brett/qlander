// Builds the public repo's first commit from a tagged commit of this one
// (docs/deployment.md §7), as a new local git repository. It never pushes,
// adds no remote and talks to no server: publishing the result is a separate,
// deliberate step.
//
//   1. `git archive` of the tag's commit into <out> (which must not exist, or be empty);
//   2. the public tree (scripts/public-tree.ts): the public/ overlay, then the
//      rules file's `exclude` paths deleted;
//   3. refuses if a shipped file still mentions a deny-listed document, or if
//      the scrub (scripts/public-scrub.ts) finds anything in the tree, path
//      names included, or if a deny-listed path is present;
//      refuses if the template's pin is not the bundle this tree builds
//      (scripts/template-pin.ts, which needs the pinned Bun);
//   4. scrubs the commit message, the tag name and the tag annotation;
//   5. `git init`, one commit and one annotated tag v<package.json version>,
//      authored, committed and tagged as the rules file's one allowed author
//      identity;
//   6. checks the result: exactly one commit, no remote, the scrub clean on
//      the commit (--tree HEAD --forbid-excluded) and on its message and
//      identities (--commits HEAD), and the tagger is the same identity.
// Any failure removes <out> and exits 1. Nothing is half-built.
//
// Usage:
//   bun scripts/export-public.ts --tag <private tag> --out <dir>
//       [--rules <file>] [--message <file>] [--annotation <file>] [--sign]
//
// --sign signs the commit and the tag with your own git signing setup
// (user.signingkey, gpg.format); without it the commit is unsigned, and git
// runs with no global or system config at all.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatHit, type Hit, readRules, type Ruleset, scanCommits, scanText, scanTree } from "./public-scrub";
import { danglingDocReferences, listFiles, makePublicTree } from "./public-tree";
import { templatePinProblem } from "./template-pin";

export type ExportOptions = {
  /** The private repo the tag is in. */
  repo: string;
  /** A tag in `repo`; its commit is exported. */
  tag: string;
  /** The new repo's directory: must not exist, or be empty. */
  out: string;
  rules: Ruleset;
  /** The initial commit's message; default `qlander v<version>`. */
  message?: string;
  /** The tag annotation; default `qlander v<version>`. */
  annotation?: string;
  sign?: boolean;
  /** Checks the template's pin; default templatePinProblem. Tests of everything else pass their own. */
  templatePin?: (tree: string) => string | null;
};

export type ExportResult = { commit: string; tag: string; files: number; identity: string; signed: boolean };

export class ExportError extends Error {}

/** The environment without GIT_* variables: an inherited GIT_DIR, GIT_WORK_TREE or GIT_INDEX_FILE would point every git call at another repo. */
export function withoutGitEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("GIT_")));
}

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string | undefined>; input?: Uint8Array | string } = {}): Buffer {
  const p = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env ?? withoutGitEnv(process.env), input: opts.input, maxBuffer: 1 << 30 });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new ExportError(`${cmd} ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout;
}

function refuse(what: string, hits: Hit[]): void {
  if (hits.length > 0) throw new ExportError(`${what}: ${hits.length} scrub hit${hits.length === 1 ? "" : "s"}\n${hits.map((h) => formatHit(h)).join("\n")}`);
}

/** "Name <email>" split; refuses anything else. */
function parseIdentity(id: string): { name: string; email: string } {
  const m = /^([^<>]+?) <([^<>\s]+)>$/.exec(id);
  if (!m) throw new ExportError(`identity ${JSON.stringify(id)} is not "Name <email>"`);
  return { name: m[1]!, email: m[2]! };
}

export function exportPublic(o: ExportOptions): ExportResult {
  const repo = resolve(o.repo);
  const out = resolve(o.out);
  const { authors, committers } = o.rules.identities;
  if (authors.length !== 1) throw new ExportError(`the rules must allow exactly one author identity (have ${authors.length})`);
  const identity = authors[0]!;
  if (!committers.includes(identity)) throw new ExportError(`the author identity ${identity} is not an allowed committer`);
  const who = parseIdentity(identity);

  // Only a tag: the export is of a reviewed, named commit, never a moving branch.
  let commit: string;
  try {
    commit = run("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/tags/${o.tag}^{commit}`]).toString().trim();
  } catch {
    throw new ExportError(`no tag ${o.tag} in ${repo}`);
  }

  if (existsSync(out) && readdirSync(out).length > 0) throw new ExportError(`${out} exists and is not empty`);
  const created = !existsSync(out);
  mkdirSync(out, { recursive: true });
  try {
    run("tar", ["-x", "-C", out], { input: run("git", ["-C", repo, "archive", "--format=tar", commit]) });
    makePublicTree(out, o.rules.exclude);

    const dangling = danglingDocReferences(out, o.rules.exclude);
    if (dangling.length > 0) throw new ExportError(`shipped files mention deny-listed documents:\n${dangling.join("\n")}`);
    refuse("the tree", scanTree(o.rules, out, out, true));
    const pinProblem = (o.templatePin ?? templatePinProblem)(out);
    if (pinProblem !== null) throw new ExportError(pinProblem);

    const version = (JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as { version?: string }).version;
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new ExportError(`package.json version ${String(version)} is not X.Y.Z`);
    const tag = `v${version}`;
    const message = o.message ?? `qlander ${tag}\n`;
    const annotation = o.annotation ?? `qlander ${tag}\n`;
    refuse("the commit message", scanText(o.rules, "<message>", message));
    refuse("the tag annotation", scanText(o.rules, "<annotation>", annotation));
    refuse("the tag name", scanText(o.rules, "<tag>", tag));

    // No hooks, no templates, and (unless signing) none of the caller's git config.
    const template = mkdtempSync(join(tmpdir(), "export-template-"));
    const hooks = mkdtempSync(join(tmpdir(), "export-hooks-"));
    const env: Record<string, string | undefined> = {
      ...withoutGitEnv(process.env),
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
      GIT_COMMITTER_NAME: who.name,
      GIT_COMMITTER_EMAIL: who.email,
      GIT_TEMPLATE_DIR: template,
      ...(o.sign ? {} : { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }),
    };
    const git = (args: string[], input?: string) => run("git", ["-C", out, "-c", `core.hooksPath=${hooks}`, "-c", "core.autocrlf=false", ...args], { env, input }).toString().trim();
    try {
      git(["init", "-q", "-b", "main"]);
      git(["add", "--all", "--force"]);
      git(["commit", "-q", o.sign ? "-S" : "--no-gpg-sign", "-F", "-"], message);
      git(["tag", o.sign ? "-s" : "-a", tag, "-F", "-"], annotation);
    } finally {
      rmSync(template, { recursive: true, force: true });
      rmSync(hooks, { recursive: true, force: true });
    }

    // Check what was built, the way the public repo's own checks will.
    if (git(["rev-list", "--count", "--all"]) !== "1") throw new ExportError("the export has more than one commit");
    if (git(["remote"]) !== "") throw new ExportError("the export has a remote");
    refuse("the commit (tree)", scanTree(o.rules, "HEAD", out, true));
    refuse("the commit (message and identities)", scanCommits(o.rules, "HEAD", out));
    const tagger = git(["for-each-ref", `refs/tags/${tag}`, "--format=%(taggername) %(taggeremail)"]);
    if (tagger !== identity) throw new ExportError(`the tag is by ${tagger}, not ${identity}`);
    const head = git(["rev-parse", "HEAD"]);
    if (git(["rev-parse", `${tag}^{commit}`]) !== head) throw new ExportError("the tag is not on the commit");
    return { commit: head, tag, files: listFiles(out, (rel) => rel === ".git").length, identity, signed: !!o.sign };
  } catch (e) {
    if (created) rmSync(out, { recursive: true, force: true });
    else for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
    throw e;
  }
}

if (import.meta.main) {
  // The scrub's own git calls (scripts/public-scrub.ts) inherit this process's environment.
  for (const k of Object.keys(process.env)) if (k.startsWith("GIT_")) delete process.env[k];
  const argv = process.argv.slice(2);
  const opt: Record<string, string> = {};
  let sign = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      if (a === "--sign") sign = true;
      else if (["--tag", "--out", "--rules", "--message", "--annotation", "--repo"].includes(a) && argv[i + 1] !== undefined) opt[a.slice(2)] = argv[++i]!;
      else throw new ExportError(`unknown or incomplete argument ${a}`);
    }
    if (!opt.tag || !opt.out) throw new ExportError("usage: bun scripts/export-public.ts --tag <tag> --out <dir> [--rules <file>] [--message <file>] [--annotation <file>] [--sign]");
    const repo = opt.repo ?? join(import.meta.dir, "..");
    const r = exportPublic({
      repo,
      tag: opt.tag,
      out: opt.out,
      rules: readRules(opt.rules, process.env, repo),
      message: opt.message === undefined ? undefined : readFileSync(opt.message, "utf8"),
      annotation: opt.annotation === undefined ? undefined : readFileSync(opt.annotation, "utf8"),
      sign,
    });
    console.log(`exported ${opt.tag} to ${resolve(opt.out)}: one commit ${r.commit}, tag ${r.tag}, ${r.files} files, by ${r.identity}${r.signed ? ", signed" : ", unsigned"}; nothing was pushed`);
  } catch (e) {
    console.error(`export-public: ${(e as Error).message}`);
    process.exit(1);
  }
}

