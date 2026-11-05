// The public-hygiene scrub (scripts/public-scrub.ts). The engine is tested on
// neutral rules (acme, alice), so this file holds nothing a real rule would
// flag.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULES_PATH, type Hit, type Io, type RulesFile, loadRules, main, scanCommits, scanLine, scanTag, scanText, scanTree, summarize } from "../scripts/public-scrub";

const ROOT = `${import.meta.dir}/..`;
const ALICE = "Alice Example <alice@example.org>";

const neutral = (): RulesFile => ({
  exclude: ["private/", "notes.txt"],
  identities: { authors: [ALICE], committers: [ALICE] },
  allow: [{ literal: "example.org/alice/widgets", note: "the public owner", examples: ["see example.org/alice/widgets"] }],
  rules: [
    { id: "org", literal: "acmecorp", note: "the org", examples: ["AcmeCorp"] },
    { id: "word", pattern: "\\bacme\\w*", flags: "i", note: "the name", examples: ["acme"] },
    { id: "host", pattern: "\\bbuild-host-[0-9]+", note: "a host", examples: ["build-host-7"] },
    { id: "person", pattern: "\\balice\\b", flags: "i", note: "a person", examples: ["alice"] },
    { id: "exact", literal: "Widget-X", caseSensitive: true, note: "case matters", examples: ["Widget-X"] },
  ],
});
const rs = () => loadRules(neutral());
const rules = (hits: Hit[]) => hits.map((h) => `${h.line}:${h.match}:${h.rule}`);

const temps: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "scrub-"));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function git(dir: string, args: string[], who = ALICE) {
  const [, name, email] = /^(.*) <(.*)>$/.exec(who)!;
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

function write(dir: string, files: Record<string, string | Uint8Array>) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
}

function run(argv: string[], opts: { stdin?: string; env?: Record<string, string>; cwd?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (s) => out.push(s), err: (s) => err.push(s), stdin: () => opts.stdin ?? "", env: opts.env ?? {}, cwd: opts.cwd ?? ROOT };
  return { code: main(argv, io), out, err };
}

describe("rules file validation", () => {
  const bad = (edit: (f: RulesFile) => void, msg: RegExp) => {
    const f = neutral();
    edit(f);
    expect(() => loadRules(f)).toThrow(msg);
  };
  test("accepts the neutral rules", () => expect(rs().rules.map((r) => r.id)).toEqual(["org", "word", "host", "person", "exact"]));
  test("unknown keys, at any level", () => {
    bad((f) => ((f as any).extra = 1), /unknown key extra/);
    bad((f) => ((f.rules[0] as any).regex = "x"), /unknown key regex/);
    bad((f) => ((f.allow[0] as any).id = "x"), /unknown key id/);
  });
  test("exactly one of literal or pattern", () => {
    bad((f) => (f.rules[0]!.pattern = "x"), /exactly one of literal or pattern/);
    bad((f) => delete f.rules[0]!.literal, /exactly one of literal or pattern/);
  });
  test("every rule and allow entry has a note and examples", () => {
    bad((f) => (f.rules[1]!.examples = []), /at least one example/);
    bad((f) => (f.allow[0]!.examples = []), /at least one example/);
    bad((f) => (f.rules[1]!.note = ""), /note required/);
  });
  test("bad, empty-matching or flagged patterns", () => {
    bad((f) => (f.rules[1]!.pattern = "("), /bad pattern/);
    bad((f) => (f.rules[1]!.pattern = "x*"), /empty string/);
    bad((f) => (f.rules[1]!.flags = "g"), /flags may only use/);
    bad((f) => (f.rules[1]!.caseSensitive = true), /caseSensitive applies to literals/);
  });
  test("ids: kebab-case, unique, and not the reserved identity rule", () => {
    bad((f) => (f.rules[1]!.id = "Word"), /kebab-case/);
    bad((f) => (f.rules[1]!.id = "org"), /duplicate or reserved/);
    bad((f) => (f.rules[1]!.id = "identity"), /duplicate or reserved/);
  });
  test("a non-empty rules list and an exclude list", () => {
    bad((f) => (f.rules = []), /non-empty rules/);
    bad((f) => ((f as any).exclude = "private/"), /rules.exclude/);
  });
});

describe("matching", () => {
  test("literals ignore case unless caseSensitive; patterns use their flags", () => {
    expect(scanLine(rs(), "ACMECORP and Build-Host-1 and build-host-2")).toEqual([
      { rule: "org", match: "ACMECORP" },
      { rule: "host", match: "build-host-2" },
    ]);
    expect(scanLine(rs(), "widget-x Widget-X")).toEqual([{ rule: "exact", match: "Widget-X" }]);
  });
  test("an overlap is reported once, under the earliest rule", () => {
    expect(scanLine(rs(), "acmecorp-tools")).toEqual([{ rule: "org", match: "acmecorp" }]);
    expect(scanLine(rs(), "acme-tools")).toEqual([{ rule: "word", match: "acme" }]);
  });
  test("the allow list removes only matches wholly inside an allowed span", () => {
    expect(scanLine(rs(), "see example.org/alice/widgets")).toEqual([]);
    expect(scanLine(rs(), "example.org/alice/widgets, then alice")).toEqual([{ rule: "person", match: "alice" }]);
    expect(scanLine(rs(), "example.org/alice/gadgets")).toEqual([{ rule: "person", match: "alice" }]);
  });
  test("a path-scoped allow entry applies only to the content of its exact files in tree mode", () => {
    const f = neutral();
    f.allow.push({ literal: "acme-sdk 2.1", paths: ["deps.txt"], note: "a dependency", examples: ["acme-sdk 2.1"] });
    const s = loadRules(f);
    // Tree content (treePath set): only the exact path, only inside the span.
    expect(rules(scanText(s, "deps.txt", "acme-sdk 2.1\nacme-sdk 2.2", 1, "deps.txt"))).toEqual(["2:acme:word"]);
    expect(rules(scanText(s, "other.txt", "acme-sdk 2.1", 1, "other.txt"))).toEqual(["1:acme:word"]);
    expect(rules(scanText(s, "sub/deps.txt", "acme-sdk 2.1", 1, "sub/deps.txt"))).toEqual(["1:acme:word"]);
    expect(rules(scanText(s, "deps.txt", "acme-sdk 2.1 and acmecorp", 1, "deps.txt"))).toEqual(["1:acmecorp:org"]);
    // Not tree content: never allowed, whatever the label says.
    expect(rules(scanText(s, "deps.txt", "acme-sdk 2.1"))).toEqual(["1:acme:word"]);
    expect(scanLine(s, "acme-sdk 2.1").map((h) => h.rule)).toEqual(["word"]);
    // End to end: a tree allows it in deps.txt only; --text on the same file does not.
    const d = tmp();
    mkdirSync(join(d, "sub"));
    writeFileSync(join(d, "deps.txt"), "acme-sdk 2.1\n");
    writeFileSync(join(d, "sub", "deps.txt"), "acme-sdk 2.1\n");
    expect(rules(scanTree(s, d))).toEqual(["1:acme:word"]);
    writeFileSync(join(d, "rules.json"), JSON.stringify(f));
    expect(run(["--rules", join(d, "rules.json"), "--text", join(d, "deps.txt"), "--fail"], { cwd: d }).code).toBe(1);
  });
  test("paths must be exact file paths", () => {
    for (const paths of [[], [""], ["dir/"], ["*.txt"], "deps.txt"]) {
      const f = neutral();
      (f.allow[0] as any).paths = paths;
      expect(() => loadRules(f), JSON.stringify(paths)).toThrow(/paths must be a non-empty list of exact file paths|unknown key/);
    }
  });
  test("every hit in a line, with line numbers", () => {
    expect(rules(scanText(rs(), "f", "clean\nalice met alice\r\nacme"))).toEqual(["2:alice:person", "2:alice:person", "3:acme:word"]);
  });
  test("summary groups by rule and by file, largest first", () => {
    const hits = [...scanText(rs(), "a", "acme acme alice"), ...scanText(rs(), "b", "alice")];
    expect(summarize(hits)).toEqual({ byRule: [["person", 2], ["word", 2]], byFile: [["a", 3], ["b", 1]] });
  });
});

describe("--tree on a directory", () => {
  test("scans names, contents and link targets; skips excluded paths, .git and the top-level node_modules", () => {
    const d = tmp();
    write(d, {
      "clean.txt": "nothing here\n",
      "docs/a.md": "line one\nby alice\n",
      "acme-notes/readme.md": "fine\n",
      "private/secret.md": "acmecorp\n",
      "notes.txt": "acmecorp\n",
      "image.bin": new Uint8Array([0x61, 0x63, 0x6d, 0x65, 0, 1, 2]),
      "node_modules/x/index.js": "acme\n",
      "vendor/node_modules/y.js": "alice\n",
      ".git": "gitdir: /elsewhere/acme\n",
    });
    symlinkSync("../acme/elsewhere", join(d, "link")); // the target is what git would ship
    expect(scanTree(rs(), d).map((h) => `${h.file}:${h.line}:${h.rule}`).sort()).toEqual(["acme-notes/readme.md:0:word", "docs/a.md:2:person", "image.bin:0:word", "link:1:word", "vendor/node_modules/y.js:1:person"]);
  });
  test("content with NUL bytes is scanned, as single-byte runs and as UTF-16 either way round", () => {
    const d = tmp();
    const le = new Uint8Array(Buffer.from("x acmecorp y", "utf16le"));
    const be = new Uint8Array(le.length);
    for (let i = 0; i < le.length; i += 2) [be[i], be[i + 1]] = [le[i + 1]!, le[i]!];
    write(d, { "le.txt": le, "be.txt": be, "mixed.bin": new Uint8Array([0, 0, ...Buffer.from("x\0build-host-4\0")]) });
    expect(scanTree(rs(), d).map((h) => `${h.file}:${h.line}:${h.match}:${h.rule}`).sort()).toEqual(["be.txt:0:acmecorp:org", "le.txt:0:acmecorp:org", "mixed.bin:0:build-host-4:host"]);
  });
  test("--forbid-excluded: an excluded path that exists is a hit", () => {
    const d = tmp();
    write(d, { "private/x.md": "fine\n", "notes.txt": "fine\n", "ok.md": "fine\n" });
    expect(scanTree(rs(), d)).toEqual([]);
    expect(rules(scanTree(rs(), d, ".", true)).sort()).toEqual(["0:notes.txt:excluded-path", "0:private/:excluded-path"]);
  });
});

describe("--tree on a git ref, and --commits", () => {
  const repo = tmp();
  git(repo, ["init", "-q", "-b", "main"]);
  write(repo, { "a.txt": "clean\n", "private/x.md": "acmecorp\n", "docs/b.md": "x\nbuild-host-3\n" });
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "first: clean"]);
  write(repo, { "a.txt": "now alice\n" }); // uncommitted: a ref scan must not see it
  git(repo, ["commit", "-q", "--allow-empty", "-m", "second\n\nmentions acme in the body"], "Mallory Other <m@elsewhere.example>");
  const first = git(repo, ["rev-list", "--max-parents=0", "HEAD"]).slice(0, 12);
  const second = git(repo, ["rev-parse", "HEAD"]).slice(0, 12);

  test("a ref scans the committed tree, as an export would ship it", () => {
    expect(scanTree(rs(), "HEAD", repo).map((h) => `${h.file}:${h.line}:${h.match}:${h.rule}`)).toEqual(["docs/b.md:2:build-host-3:host"]);
  });
  test("--forbid-excluded on a ref reports the excluded files", () => {
    expect(rules(scanTree(rs(), "HEAD", repo, true))).toEqual(["0:private/x.md:excluded-path", "2:build-host-3:host"]);
  });
  test("an unknown ref is an error, not a clean result", () => {
    expect(() => scanTree(rs(), "no-such-ref", repo)).toThrow(/git ls-tree/);
  });
  test("each commit's message, author and committer", () => {
    expect(scanCommits(rs(), "HEAD", repo)).toEqual([
      { file: `commit ${second}`, line: 0, match: "author Mallory Other <m@elsewhere.example>", rule: "identity" },
      { file: `commit ${second}`, line: 0, match: "committer Mallory Other <m@elsewhere.example>", rule: "identity" },
      { file: `commit ${second}`, line: 3, match: "acme", rule: "word" },
    ]);
    expect(scanCommits(rs(), `${first}..HEAD`, repo)).toHaveLength(3);
    expect(scanCommits(rs(), `${second}..HEAD`, repo)).toEqual([]);
  });
  test("--commits needs allowed identities", () => {
    const r = rs();
    r.identities = { authors: [], committers: [] };
    expect(() => scanCommits(r, "HEAD", repo)).toThrow(/needs allowed identities/);
  });
  test("--identity replaces the rules file's identities", () => {
    const rulesFile = join(tmp(), "rules.json");
    writeFileSync(rulesFile, JSON.stringify(neutral()));
    const r = run(["--rules", rulesFile, "--commits", "HEAD", "--identity", "Mallory Other <m@elsewhere.example>", "--cwd", repo]);
    expect(r.out.filter((l) => l.endsWith(":identity"))).toEqual([`commit ${first}:0:author ${ALICE}:identity`, `commit ${first}:0:committer ${ALICE}:identity`]);
  });
});

describe("--tag", () => {
  const repo = tmp();
  git(repo, ["init", "-q", "-b", "main"]);
  write(repo, { "a.txt": "a\n" });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "one"]);
  git(repo, ["tag", "-a", "v1", "-m", "first release"]);
  git(repo, ["tag", "-a", "v2", "-m", "built for acme"]);
  git(repo, ["tag", "-a", "v3", "-m", "fine"], "Mallory Other <m@elsewhere.example>");
  git(repo, ["tag", "light"]);
  git(repo, ["tag", "-a", "acme-1", "-m", "fine"]);
  git(repo, ["tag", "-a", "nested", "-m", "fine", "v1"]);
  const r = (ref: string) => scanTag(rs(), ref, repo).map((h) => `${h.line}:${h.rule}:${h.match}`);
  test("a clean annotated tag by the allowed identity", () => expect(r("v1")).toEqual([]));
  test("the annotation, the name and the tagger are each checked", () => {
    expect(r("v2")).toEqual(["1:word:acme"]);
    expect(r("v3")).toEqual(["0:identity:tagger Mallory Other <m@elsewhere.example>"]);
    expect(r("acme-1")).toEqual(["0:word:acme"]);
  });
  test("a lightweight tag and a tag of a tag are hits", () => {
    expect(r("light")).toEqual(["0:identity:a commit, not an annotated tag"]);
    expect(r("nested")).toEqual(["0:identity:tags a tag, not a commit"]);
  });
  test("through the CLI, with --fail", () => {
    const rulesFile = join(tmp(), "rules.json");
    writeFileSync(rulesFile, JSON.stringify(neutral()));
    expect(run(["--rules", rulesFile, "--fail", "--tag", "v1", "--cwd", repo]).code).toBe(0);
    expect(run(["--rules", rulesFile, "--fail", "--tag", "v3", "--cwd", repo]).code).toBe(1);
  });
});

describe("the CLI", () => {
  const rulesFile = join(tmp(), "rules.json");
  writeFileSync(rulesFile, JSON.stringify(neutral()));
  const textFile = join(tmp(), "pr-body.md");
  writeFileSync(textFile, "Title\n\nfixes the build-host-9 timeout\n");

  test("--text <file> prints file:line:match:rule and the total; report only exits 0", () => {
    const r = run(["--rules", rulesFile, "--text", textFile]);
    expect(r).toEqual({ code: 0, out: [`${textFile}:3:build-host-9:host`, "public-scrub: 1 hit (report only)"], err: [] });
  });
  test("--text - reads stdin (a branch or tag name, a PR title)", () => {
    expect(run(["--rules", rulesFile, "--text", "-"], { stdin: "feat/acme-login" }).out[0]).toBe("<stdin>:1:acme:word");
  });
  test("--fail exits 1 on a hit and 0 when clean", () => {
    expect(run(["--rules", rulesFile, "--fail", "--text", textFile]).code).toBe(1);
    expect(run(["--rules", rulesFile, "--fail", "--text", "-"], { stdin: "all clear" })).toEqual({ code: 0, out: ["public-scrub: 0 hits"], err: [] });
  });
  test("--redact never prints the matched text", () => {
    expect(run(["--rules", rulesFile, "--redact", "--text", textFile]).out[0]).toBe(`${textFile}:3:<12 chars>:rule-3`);
  });
  test("--redact names a rule by its number, never its id (an id can name what it looks for), in hits and the summary", () => {
    const r = run(["--rules", rulesFile, "--redact", "--summary", "--text", "-"], { stdin: "acmecorp alice" });
    expect(r.out.join("\n")).not.toMatch(/\b(?:org|person)\b/);
    expect(r.out.slice(0, 2)).toEqual(["<stdin>:1:<8 chars>:rule-1", "<stdin>:1:<5 chars>:rule-4"]);
    expect(r.out).toContain("      1  rule-4");
  });
  test("--redact also hides a path whose own name has a hit", () => {
    const d = tmp();
    write(d, { "acme-plan.md": "alice\n", "ok.md": "alice\n" });
    const out = run(["--rules", rulesFile, "--redact", "--tree", d]).out;
    expect(out.join("\n")).not.toContain("acme");
    const hidden = out.filter((l) => l.startsWith("<path "));
    expect(hidden.map((l) => l.replace(/^<path [0-9a-f]{12}>/, "<path>")).sort()).toEqual(["<path>:0:<4 chars>:rule-2", "<path>:1:<5 chars>:rule-4"]);
    expect(new Set(hidden.map((l) => l.split(":")[0])).size).toBe(1); // the same file, the same hash
    expect(out).toContain("ok.md:1:<5 chars>:rule-4");
  });
  test("--summary groups the hits", () => {
    const r = run(["--rules", rulesFile, "--summary", "--text", "-"], { stdin: "acme alice\nalice" });
    expect(r.out.slice(3)).toEqual(["", "by rule:", "      2  person", "      1  word", "by file:", "      3  <stdin>", "public-scrub: 3 hits (report only)"]);
  });
  test("modes combine into one report", () => {
    const r = run(["--rules", rulesFile, "--text", textFile, "--text", "-"], { stdin: "acme" });
    expect(r.out.at(-1)).toBe("public-scrub: 2 hits (report only)");
  });
  test("rules from $PUBLIC_SCRUB_RULES when --rules is absent", () => {
    expect(run(["--text", "-"], { stdin: "acme", env: { PUBLIC_SCRUB_RULES: JSON.stringify(neutral()) }, cwd: tmp() }).out[0]).toBe("<stdin>:1:acme:word");
  });
  test("usage and rules errors exit 2, even without --fail", () => {
    expect(run(["--rules", rulesFile]).code).toBe(2);
    expect(run(["--rules", rulesFile, "--bogus"]).code).toBe(2);
    expect(run(["--rules", rulesFile, "--text"]).code).toBe(2);
    const none = run(["--text", "-"], { cwd: tmp() });
    expect(none.code).toBe(2);
    expect(none.err[0]).toContain("no rules");
    expect(run(["--text", "-"], { env: { PUBLIC_SCRUB_RULES: "{}" }, cwd: tmp() }).code).toBe(2);
  });
});
