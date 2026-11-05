// Public-hygiene scrub (docs/deployment.md §7): finds text that must never
// reach the public repo, in files, commit messages and identities, PR text,
// branch and tag names, and release notes.
//
// The engine is generic and holds no denylist of its own. The rules come from
// a JSON file (default scripts/public-scrub.rules.json, which the export
// leaves out), from $PUBLIC_SCRUB_RULES (the JSON text itself), or from
// --rules <file>. See the RulesFile type for the shape.
//
// Usage:
//   bun scripts/public-scrub.ts [options] <mode>...
//   modes (any number, combined into one report):
//     --tree <dir|git-ref>   the files an export would ship (rules.exclude removed);
//                            each path name is scanned as well as its content
//     --text <file|->        arbitrary text: a commit message, PR title/body,
//                            branch or tag name, tag annotation, release notes
//     --commits <range>      each commit's message, and its author and committer
//                            identity against the allowed identities
//     --commit-trees <range> the tree of each commit in the range, with the --tree
//                            rules: a file added and removed again is still published
//     --tag <ref>            an annotated tag: its name, its annotation, and its
//                            tagger against the allowed authors (a lightweight
//                            tag is a hit: it has no tagger to check)
//     --pre-push <file|->    what a git pre-push hook reads on stdin: for each ref
//                            pushed, its name, its object as a tag and a tree, and
//                            every commit it reaches that the remote does not have
//   options:
//     --rules <file>         rules file (overrides $PUBLIC_SCRUB_RULES and the default)
//     --identity "N <e>"     allowed author/committer identity (repeatable;
//                            replaces both lists in the rules file)
//     --fail                 exit 1 when anything is found (default: report only, exit 0)
//     --summary              print hit counts grouped by rule and by file
//     --redact               print where, never the matched text; a rule by its number
//                            in the rules list (rule-<n>), never its id, since ids
//                            can name what they look for; and a hash for a path
//                            whose name has a hit (for public logs)
//     --forbid-excluded      an excluded path that exists is a hit (for a tree that
//                            should no longer have them, such as the public repo)
//     --cwd <dir>            git repo for git-ref trees and --commits (default: .)
//
// Output: one line per hit, `file:line:match:rule`, then the total. Line 0 is
// the path name itself (tree mode) or the identity (commits mode). Exit 2 on
// a usage or rules error, whatever the mode.

import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";

export type Hit = { file: string; line: number; match: string; rule: string };

type PatternSpec = { literal?: string; pattern?: string; flags?: string; caseSensitive?: boolean };
export type RuleSpec = PatternSpec & { id: string; note: string; examples: string[] };
/** An allowed span. With `paths`, it applies only to the content of those exact files in tree mode: never to --text, commit messages, path names or other files. */
export type AllowSpec = PatternSpec & { note: string; examples: string[]; paths?: string[] };
export type RulesFile = {
  /** Paths the export deletes before it scans: "dir/" is a prefix, anything else an exact path. */
  exclude: string[];
  /** Spans that are fine even though a rule matches inside them. */
  allow: AllowSpec[];
  /** Ordered: where two rules match overlapping text, the earlier one is reported. */
  rules: RuleSpec[];
  /** Allowed commit identities, exactly "Name <email>". */
  identities?: { authors: string[]; committers: string[] };
};

export type Ruleset = {
  exclude: string[];
  allow: { re: RegExp; paths?: string[] }[];
  rules: { id: string; re: RegExp }[];
  identities: { authors: string[]; committers: string[] };
  spec: RulesFile;
};

export const DEFAULT_RULES_PATH = "scripts/public-scrub.rules.json";
export const IDENTITY_RULE = "identity";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function compile(where: string, p: PatternSpec): RegExp {
  if ((p.literal === undefined) === (p.pattern === undefined)) throw new Error(`${where}: exactly one of literal or pattern`);
  const flags = p.flags ?? "";
  if (!/^[imsu]*$/.test(flags)) throw new Error(`${where}: flags may only use i, m, s, u`);
  if (p.literal !== undefined) {
    if (p.literal === "") throw new Error(`${where}: empty literal`);
    return new RegExp(escapeRe(p.literal), (p.caseSensitive ? "" : "i") + flags.replace("i", "") + "g");
  }
  if (p.caseSensitive !== undefined) throw new Error(`${where}: caseSensitive applies to literals; use flags for a pattern`);
  try {
    const re = new RegExp(p.pattern!, flags + "g");
    if (re.test("")) throw new Error("matches the empty string");
    return re;
  } catch (e) {
    throw new Error(`${where}: bad pattern: ${(e as Error).message}`);
  }
}

function onlyKeys(where: string, o: object, keys: string[]) {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${where}: unknown key ${k}`);
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/** Validates a parsed rules file. Every rule and allow entry must carry examples, which the tests replay. */
export function loadRules(raw: unknown): Ruleset {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("rules: not an object");
  const f = raw as RulesFile;
  onlyKeys("rules", f, ["exclude", "allow", "rules", "identities"]);
  if (!isStrings(f.exclude)) throw new Error("rules.exclude: list of paths");
  if (!Array.isArray(f.allow) || !Array.isArray(f.rules) || f.rules.length === 0) throw new Error("rules: allow and a non-empty rules list are required");
  const ids = new Set<string>();
  const rules = f.rules.map((r, i) => {
    const where = `rules[${i}]${r?.id ? ` (${r.id})` : ""}`;
    onlyKeys(where, r, ["id", "literal", "pattern", "flags", "caseSensitive", "note", "examples"]);
    if (typeof r.id !== "string" || !/^[a-z0-9-]+$/.test(r.id)) throw new Error(`${where}: id must be kebab-case`);
    if (r.id === IDENTITY_RULE || ids.has(r.id)) throw new Error(`${where}: duplicate or reserved id`);
    ids.add(r.id);
    if (typeof r.note !== "string" || !r.note) throw new Error(`${where}: note required`);
    if (!isStrings(r.examples) || r.examples.length === 0) throw new Error(`${where}: at least one example`);
    return { id: r.id, re: compile(where, r) };
  });
  const allow = f.allow.map((a, i) => {
    onlyKeys(`allow[${i}]`, a, ["literal", "pattern", "flags", "caseSensitive", "note", "examples", "paths"]);
    if (typeof a.note !== "string" || !a.note) throw new Error(`allow[${i}]: note required`);
    if (!isStrings(a.examples) || a.examples.length === 0) throw new Error(`allow[${i}]: at least one example`);
    if (a.paths !== undefined) {
      if (!isStrings(a.paths) || a.paths.length === 0 || a.paths.some((p) => !p || p.endsWith("/") || p.includes("*"))) throw new Error(`allow[${i}]: paths must be a non-empty list of exact file paths`);
      return { re: compile(`allow[${i}]`, a), paths: a.paths };
    }
    return { re: compile(`allow[${i}]`, a) };
  });
  let identities = { authors: [] as string[], committers: [] as string[] };
  if (f.identities !== undefined) {
    onlyKeys("rules.identities", f.identities, ["authors", "committers"]);
    if (!isStrings(f.identities.authors) || !isStrings(f.identities.committers)) throw new Error("rules.identities: authors and committers lists");
    identities = f.identities;
  }
  return { exclude: f.exclude, allow, rules, identities, spec: f };
}

/** --rules wins, then $PUBLIC_SCRUB_RULES (JSON text), then the default file. */
export function readRules(rulesPath: string | undefined, env: Record<string, string | undefined>, cwd: string): Ruleset {
  if (rulesPath) return loadRules(JSON.parse(readFileSync(rulesPath, "utf8")));
  if (env.PUBLIC_SCRUB_RULES) return loadRules(JSON.parse(env.PUBLIC_SCRUB_RULES));
  const p = join(cwd, DEFAULT_RULES_PATH);
  if (!existsSync(p)) throw new Error(`no rules: pass --rules, set PUBLIC_SCRUB_RULES, or add ${DEFAULT_RULES_PATH}`);
  return loadRules(JSON.parse(readFileSync(p, "utf8")));
}

function spans(re: RegExp, line: string): [number, number, string][] {
  const out: [number, number, string][] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    out.push([m.index, m.index + m[0].length, m[0]]);
  }
  return out;
}

/**
 * Hits in one line of `file`: allowed spans removed, and overlaps reported once,
 * under the earliest rule. A path-scoped allow entry counts only when `file` is
 * one of its paths.
 */
export function scanLine(rs: Ruleset, line: string, file?: string): { rule: string; match: string }[] {
  const allowed = rs.allow.filter((a) => !a.paths || (file !== undefined && a.paths.includes(file))).flatMap((a) => spans(a.re, line));
  const taken: [number, number][] = [];
  const out: { rule: string; match: string }[] = [];
  for (const r of rs.rules) {
    for (const [s, e, text] of spans(r.re, line)) {
      if (allowed.some(([as, ae]) => as <= s && e <= ae)) continue;
      if (taken.some(([ts, te]) => s < te && ts < e)) continue;
      taken.push([s, e]);
      out.push({ rule: r.id, match: text });
    }
  }
  return out;
}

/**
 * Hits in `text`, reported as `file`. `treePath` is set only when the text is a
 * file's content in tree mode: path-scoped allow entries apply then, and only
 * when it is one of their paths. Text, commit messages and path names never get one.
 */
export function scanText(rs: Ruleset, file: string, text: string, firstLine = 1, treePath?: string): Hit[] {
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const h of scanLine(rs, line, treePath)) hits.push({ file, line: firstLine + i, ...h });
  });
  return hits;
}

export function isExcluded(rs: Ruleset, path: string): boolean {
  return rs.exclude.some((x) => (x.endsWith("/") ? path.startsWith(x) : path === x));
}

/** Printable runs, like strings(1), with every other byte dropped for UTF-16 text. */
function printableRuns(b: Uint8Array, start: number, step: number): string {
  let out = "";
  for (let i = start; i < b.length; i += step) out += b[i]! >= 0x20 && b[i]! < 0x7f ? String.fromCharCode(b[i]!) : "\n";
  return out;
}

/**
 * A file's name and its content. Text is scanned line by line. Content with a
 * NUL byte is never skipped: its printable runs are scanned as single-byte
 * text and as UTF-16 (both byte orders), and hits are reported on line 0.
 */
function scanFile(rs: Ruleset, path: string, body: Uint8Array): Hit[] {
  const hits = scanText(rs, path, path, 0).map((h) => ({ ...h, line: 0 })); // the name ships too; line 0 whatever newlines it holds
  if (!body.includes(0)) {
    hits.push(...scanText(rs, path, new TextDecoder().decode(body), 1, path));
    return hits;
  }
  const seen = new Set<string>();
  for (const [start, step] of [[0, 1], [0, 2], [1, 2]] as const) {
    for (const h of scanText(rs, path, printableRuns(body, start, step), 1, path)) {
      const key = `${h.rule}\0${h.match}`;
      if (!seen.has(key)) {
        seen.add(key);
        hits.push({ ...h, line: 0 });
      }
    }
  }
  return hits;
}

export const EXCLUDED_PATH_RULE = "excluded-path";

function git(cwd: string, args: string[], stdin?: Uint8Array): Buffer {
  // Never replacement objects: a push sends the real ones.
  const p = spawnSync("git", ["--no-replace-objects", "-C", cwd, ...args], { input: stdin ?? "", maxBuffer: 1 << 30 });
  if (p.error) throw p.error;
  if (p.status !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString().trim()}`);
  return p.stdout;
}

/**
 * A git ref (its tree, as `git archive` would ship it: the authoritative form)
 * or a directory (every file but .git and a top-level node_modules/). With
 * forbidExcluded, an excluded path that is present is itself a hit: the public
 * repo has nothing to exclude, so there those paths must not exist at all.
 */
export function scanTree(rs: Ruleset, target: string, cwd = ".", forbidExcluded = false): Hit[] {
  const hits: Hit[] = [];
  if (existsSync(target) && statSync(target).isDirectory()) {
    const walk = (dir: string) => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, d.name);
        const rel = relative(target, full).split(sep).join("/");
        if (d.name === ".git") continue; // a directory, or a worktree's gitdir pointer file
        if (d.isDirectory()) {
          if (rel === "node_modules") continue;
          if (!isExcluded(rs, rel + "/")) walk(full);
          else if (forbidExcluded) hits.push({ file: rel + "/", line: 0, match: rel + "/", rule: EXCLUDED_PATH_RULE });
        } else if (isExcluded(rs, rel)) {
          if (forbidExcluded) hits.push({ file: rel, line: 0, match: rel, rule: EXCLUDED_PATH_RULE });
        }
        else if (d.isFile()) hits.push(...scanFile(rs, rel, readFileSync(full)));
        else if (d.isSymbolicLink()) hits.push(...scanFile(rs, rel, new TextEncoder().encode(readlinkSync(full)))); // git stores the target as the blob
      }
    };
    walk(target);
    return hits;
  }
  let entries = git(cwd, ["ls-tree", "-r", "-z", "--full-tree", target])
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((e) => {
      const [meta, path] = [e.slice(0, e.indexOf("\t")), e.slice(e.indexOf("\t") + 1)];
      const [, type, sha] = meta.split(" ");
      return { type, sha: sha!, path };
    })
    .filter((e) => {
      if (!isExcluded(rs, e.path)) return true;
      if (forbidExcluded) hits.push({ file: e.path, line: 0, match: e.path, rule: EXCLUDED_PATH_RULE });
      return false;
    });
  for (const e of entries) if (e.type !== "blob") hits.push(...scanText(rs, e.path, e.path, 0)); // a submodule: its name still ships
  entries = entries.filter((e) => e.type === "blob");
  if (entries.length === 0) return hits;
  const out = git(cwd, ["cat-file", "--batch"], new TextEncoder().encode(entries.map((e) => e.sha).join("\n") + "\n"));
  let at = 0;
  for (const e of entries) {
    const nl = out.indexOf(10, at);
    const size = Number(out.subarray(at, nl).toString().split(" ")[2]);
    hits.push(...scanFile(rs, e.path, out.subarray(nl + 1, nl + 1 + size)));
    at = nl + 1 + size + 1;
  }
  return hits;
}

/** Each commit in the range: its message, and its author and committer against the allowed identities. */
export function scanCommits(rs: Ruleset, range: string, cwd = "."): Hit[] {
  const { authors, committers } = rs.identities;
  if (authors.length === 0 || committers.length === 0) throw new Error("--commits needs allowed identities (--identity, or identities in the rules)");
  const hits: Hit[] = [];
  const log = git(cwd, ["log", "--format=%x1e%H%x00%an <%ae>%x00%cn <%ce>%x00%B", range]).toString();
  for (const rec of log.split("\x1e").filter(Boolean)) {
    const [sha, author, committer, ...body] = rec.split("\0");
    const file = `commit ${sha!.slice(0, 12)}`;
    if (!authors.includes(author!)) hits.push({ file, line: 0, match: `author ${author}`, rule: IDENTITY_RULE });
    if (!committers.includes(committer!)) hits.push({ file, line: 0, match: `committer ${committer}`, rule: IDENTITY_RULE });
    hits.push(...scanText(rs, file, body.join("\0").replace(/\n+$/, "")));
  }
  return hits;
}

/** The tree of each commit in the range, each distinct tree once. */
export function scanCommitTrees(rs: Ruleset, range: string, cwd = ".", forbidExcluded = false): Hit[] {
  const trees = new Set(git(cwd, ["log", "--format=%T", range]).toString().split("\n").filter(Boolean));
  return [...trees].flatMap((t) => scanTree(rs, t, cwd, forbidExcluded));
}

/** An annotated tag (`ref` names it): its name, its annotation, and its tagger against the allowed authors. */
export function scanTag(rs: Ruleset, ref: string, cwd = "."): Hit[] {
  if (rs.identities.authors.length === 0) throw new Error("--tag needs allowed identities (--identity, or identities in the rules)");
  const file = `tag ${ref}`;
  const type = git(cwd, ["cat-file", "-t", ref]).toString().trim();
  if (type !== "tag") return [{ file, line: 0, match: `a ${type}, not an annotated tag`, rule: IDENTITY_RULE }];
  const raw = git(cwd, ["cat-file", "tag", ref]).toString();
  const head = raw.slice(0, raw.indexOf("\n\n") === -1 ? raw.length : raw.indexOf("\n\n"));
  const body = raw.indexOf("\n\n") === -1 ? "" : raw.slice(raw.indexOf("\n\n") + 2);
  const field = (k: string) => head.split("\n").find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? "";
  const tagger = field("tagger").replace(/ \d+ [+-]\d{4}$/, "");
  const hits: Hit[] = [];
  if (!rs.identities.authors.includes(tagger)) hits.push({ file, line: 0, match: `tagger ${tagger}`, rule: IDENTITY_RULE });
  if (field("type") !== "commit") hits.push({ file, line: 0, match: `tags a ${field("type")}, not a commit`, rule: IDENTITY_RULE });
  hits.push(...scanText(rs, file, field("tag"), 0));
  hits.push(...scanText(rs, file, body.replace(/\n+$/, "")));
  return hits;
}

/**
 * A git pre-push hook's input, one `<local ref> <local oid> <remote ref> <remote oid>`
 * per ref. A tag push publishes the tag at once, before any server-side check
 * has run, so this is the only check that comes before it. Only branches and
 * tags may be pushed; the public repo's checks watch nothing else.
 */
export function scanPrePush(rs: Ruleset, input: string, cwd = ".", forbidExcluded = false): Hit[] {
  const hits: Hit[] = [];
  const isZero = (oid: string) => /^0+$/.test(oid);
  for (const line of input.split("\n").filter(Boolean)) {
    const [localRef, local, remoteRef, remote, ...rest] = line.trim().split(" ");
    if (!localRef || !local || !remoteRef || !remote || rest.length > 0) throw new Error(`pre-push: bad line: ${line}`);
    if (isZero(local)) continue; // a delete publishes nothing
    const file = `push ${remoteRef}`;
    hits.push(...scanText(rs, file, remoteRef.replace(/^refs\/(heads|tags)\//, ""), 0));
    if (!/^refs\/(heads|tags)\//.test(remoteRef)) hits.push({ file, line: 0, match: "a ref that is not a branch or a tag", rule: IDENTITY_RULE });
    if (remoteRef.startsWith("refs/tags/") || git(cwd, ["cat-file", "-t", local]).toString().trim() === "tag") hits.push(...scanTag(rs, local, cwd));
    const commit = `${local}^{commit}`;
    hits.push(...scanTree(rs, commit, cwd, forbidExcluded));
    // Only what the remote lacks, when this repo knows the remote's commit; otherwise all of it.
    const known = !isZero(remote) && spawnSync("git", ["--no-replace-objects", "-C", cwd, "cat-file", "-e", `${remote}^{commit}`]).status === 0;
    const range = known ? `${remote}..${git(cwd, ["rev-parse", commit]).toString().trim()}` : commit;
    hits.push(...scanCommits(rs, range, cwd), ...scanCommitTrees(rs, range, cwd, forbidExcluded));
  }
  return hits;
}

export function formatHit(h: Hit, redact = false): string {
  return `${h.file}:${h.line}:${redact ? `<${h.match.length} chars>` : h.match}:${h.rule}`;
}

/** For --redact: a rule from the rules file is shown by its 1-based position, never its id; the engine's own rules keep their names. */
export function redactRules(hits: Hit[], rs: Ruleset): Hit[] {
  const n = new Map(rs.rules.map((r, i) => [r.id, `rule-${i + 1}`]));
  return hits.map((h) => ({ ...h, rule: n.get(h.rule) ?? h.rule }));
}

/** For --redact: a file whose name or label itself has a hit is shown as a hash of it. */
export function redactNames(hits: Hit[]): Hit[] {
  const leaky = new Set(hits.filter((h) => h.line === 0 && h.file.includes(h.match)).map((h) => h.file));
  const name = (f: string) => (leaky.has(f) ? `<path ${new Bun.CryptoHasher("sha256").update(f).digest("hex").slice(0, 12)}>` : f);
  return hits.map((h) => ({ ...h, file: name(h.file) }));
}

export function summarize(hits: Hit[]): { byRule: [string, number][]; byFile: [string, number][] } {
  const count = (key: (h: Hit) => string) => {
    const m = new Map<string, number>();
    for (const h of hits) m.set(key(h), (m.get(key(h)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  return { byRule: count((h) => h.rule), byFile: count((h) => h.file) };
}

export type Io = { out: (s: string) => void; err: (s: string) => void; stdin: () => string; env: Record<string, string | undefined>; cwd: string };

/** The CLI. Returns the exit code: 0 clean or report-only, 1 hits with --fail, 2 usage or rules error. */
export function main(argv: string[], io: Io): number {
  const modes: [string, string][] = [];
  const identities: string[] = [];
  let rulesPath: string | undefined;
  let fail = false;
  let summary = false;
  let redact = false;
  let forbidExcluded = false;
  let cwd = io.cwd;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const val = () => {
        const v = argv[++i];
        if (v === undefined) throw new Error(`${a} needs a value`);
        return v;
      };
      if (a === "--tree" || a === "--text" || a === "--commits" || a === "--tag" || a === "--pre-push" || a === "--commit-trees") modes.push([a, val()]);
      else if (a === "--rules") rulesPath = val();
      else if (a === "--identity") identities.push(val());
      else if (a === "--cwd") cwd = val();
      else if (a === "--fail") fail = true;
      else if (a === "--summary") summary = true;
      else if (a === "--redact") redact = true;
      else if (a === "--forbid-excluded") forbidExcluded = true;
      else throw new Error(`unknown argument ${a}`);
    }
    if (modes.length === 0) throw new Error("give at least one of --tree, --text, --commits, --tag, --pre-push");
    let rs: Ruleset;
    try {
      rs = readRules(rulesPath, io.env, cwd);
    } catch (e) {
      // A rules error can quote a rule's id, which can name what it looks for.
      throw redact ? new Error("the rules could not be read") : e;
    }
    if (identities.length > 0) rs.identities = { authors: identities, committers: identities };
    let hits: Hit[] = [];
    for (const [mode, arg] of modes) {
      if (mode === "--tree") hits.push(...scanTree(rs, arg, cwd, forbidExcluded));
      else if (mode === "--commits") hits.push(...scanCommits(rs, arg, cwd));
      else if (mode === "--commit-trees") hits.push(...scanCommitTrees(rs, arg, cwd, forbidExcluded));
      else if (mode === "--tag") hits.push(...scanTag(rs, arg, cwd));
      else if (mode === "--pre-push") hits.push(...scanPrePush(rs, arg === "-" ? io.stdin() : readFileSync(arg, "utf8"), cwd, forbidExcluded));
      else hits.push(...scanText(rs, arg === "-" ? "<stdin>" : arg, arg === "-" ? io.stdin() : readFileSync(arg, "utf8")));
    }
    if (redact) hits = redactNames(redactRules(hits, rs));
    for (const h of hits) io.out(formatHit(h, redact));
    if (summary && hits.length > 0) {
      const s = summarize(hits);
      io.out("");
      io.out("by rule:");
      for (const [k, n] of s.byRule) io.out(`  ${String(n).padStart(5)}  ${k}`);
      io.out("by file:");
      for (const [k, n] of s.byFile) io.out(`  ${String(n).padStart(5)}  ${k}`);
    }
    io.out(`public-scrub: ${hits.length} hit${hits.length === 1 ? "" : "s"}${hits.length > 0 && !fail ? " (report only)" : ""}`);
    return hits.length > 0 && fail ? 1 : 0;
  } catch (e) {
    io.err(`public-scrub: ${(e as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exit(
    main(process.argv.slice(2), {
      out: (s) => console.log(s),
      err: (s) => console.error(s),
      stdin: () => readFileSync(0, "utf8"),
      env: process.env,
      cwd: process.cwd(),
    }),
  );
}
