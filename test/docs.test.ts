// The user docs: docs/configuration.md is exactly its rendering from the
// schema, the README stays short, the README's config example is valid on top
// of the template's, and every relative link (and its #anchor) resolves.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { DOC_PATH, renderFromRepo, ROOT, slug, yaml } from "../scripts/config-doc";
import { USAGE } from "../src/cli";
import { parseConfig } from "../src/config/load";
import { policyApproval } from "../src/evidence";
import type { IssueComment } from "../src/types";
import { yamlTextProblems } from "../src/config/yaml";

const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");

// The docs a reader of the public repo follows. Links into them must resolve.
const DOCS = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "DESIGN.md",
  "docs/getting-started.md",
  "docs/configuration.md",
  "docs/how-it-works.md",
  "docs/operating.md",
  "docs/hooks.md",
  "docs/deployment.md",
  "docs/qualification-manifest.md",
  "docs/vs-github-merge-queue.md",
  "template/README.md",
  "AGENTS.md",
  "template/AGENTS.md",
  "template/agent-landing-rules.md",
];

const AGENT_DOCS = ["AGENTS.md", "template/AGENTS.md", "template/agent-landing-rules.md"];
const PUBLIC_MAIN = "https://github.com/brett/qlander/blob/main/";

const README_MAX_LINES = 250;

/** The anchors GitHub gives a Markdown file's headings. */
function anchors(text: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

/** Every Markdown link target outside code, inline or a reference definition, with its line number. */
function links(text: string): { target: string; line: number }[] {
  const out: { target: string; line: number }[] = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) return;
    const prose = line.replace(/`[^`]*`/g, "");
    for (const m of prose.matchAll(/\]\(([^)\s]+)\)/g)) out.push({ target: m[1]!, line: i + 1 });
    const def = /^\s{0,3}\[[^\]]+\]:\s+<?([^>\s]+)>?/.exec(line);
    if (def) out.push({ target: def[1]!, line: i + 1 });
  });
  return out;
}

describe("docs/configuration.md", () => {
  test("is exactly its rendering from the schema (run bun scripts/config-doc.ts)", () => {
    const { text } = renderFromRepo();
    expect(read(DOC_PATH)).toBe(text);
  });

  test("every key has an example", () => {
    expect(renderFromRepo().missing).toEqual([]);
  });

  test("every YAML example parses, in the YAML subset qlander.yml allows", () => {
    const blocks = [...read(DOC_PATH).matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThan(20);
    for (const b of blocks) {
      expect(() => YAML.parse(b), b).not.toThrow();
      expect(yamlTextProblems(b), b).toEqual([]);
    }
  });
});

describe("README.md", () => {
  test(`is at most ${README_MAX_LINES} lines`, () => {
    expect(read("README.md").split("\n").length).toBeLessThanOrEqual(README_MAX_LINES);
  });

  test("its configuration example is a valid config on top of the template's", () => {
    const block = /## Configuration[\s\S]*?```yaml\n([\s\S]*?)```/.exec(read("README.md"))![1]!;
    const merge = (a: unknown, b: unknown): unknown => {
      if (typeof a !== "object" || a === null || Array.isArray(a) || typeof b !== "object" || b === null || Array.isArray(b)) return b;
      const o: Record<string, unknown> = { ...(a as Record<string, unknown>) };
      for (const [k, v] of Object.entries(b)) o[k] = merge(o[k], v);
      return o;
    };
    expect(yamlTextProblems(block)).toEqual([]);
    const config = merge(YAML.parse(read("template/qlander.yml")), YAML.parse(block));
    expect(() => parseConfig(yaml(config).join("\n"), "README example")).not.toThrow();
  });
});

describe("relative links in the docs", () => {
  test("every file and #anchor resolves", () => {
    const broken: string[] = [];
    for (const doc of DOCS) {
      if (!existsSync(join(ROOT, doc))) {
        broken.push(`${doc}: missing`);
        continue;
      }
      const text = read(doc);
      for (const { target, line } of links(text)) {
        if (/^[a-z]+:/i.test(target)) continue; // http(s), mailto
        const [path, anchor] = target.split("#") as [string, string | undefined];
        const file = path === "" ? doc : normalize(join(dirname(doc), path));
        if (!existsSync(join(ROOT, file))) {
          broken.push(`${doc}:${line}: ${target} (no ${file})`);
          continue;
        }
        if (anchor !== undefined && file.endsWith(".md") && !anchors(read(file)).has(anchor)) broken.push(`${doc}:${line}: ${target} (no #${anchor} in ${file})`);
      }
    }
    expect(broken).toEqual([]);
  });
});

/** The commands in USAGE: each line that starts with two spaces and a name, `a|b` naming two. */
const usageCommands = (usage: string): Set<string> => new Set([...usage.matchAll(/^ {2}([a-z][a-z|-]*)(?= |$)/gm)].flatMap((m) => m[1]!.split("|")));

/** Each `<prefix> <command>` in a doc's code (spans and fences), as `qlander x`, `bun "${bundle:?}" x` or `bun src/cli.ts x`, and each `/qlander x`. */
function namedCommands(text: string): { cli: string[]; slash: string[] } {
  let fence = false;
  const code: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    else if (fence) code.push(line);
    else for (const m of line.matchAll(/`([^`]*)`/g)) code.push(m[1]!);
  }
  const all = code.join("\n");
  return {
    cli: [...all.matchAll(/(?<![/\w-])(?:qlander|bun "\$\{bundle:\?\}"|bun src\/cli\.ts) +([a-z][a-z-]*)/g)].map((m) => m[1]!),
    slash: [...all.matchAll(/\/qlander +([a-z][a-z-]*)/g)].map((m) => m[1]!),
  };
}

describe("what the docs claim", () => {
  test("a push is only said to drop a PR once it has been admitted", () => {
    const rules = read("template/agent-landing-rules.md");
    expect(rules).not.toContain("A later push drops the PR");
    expect(rules).toContain("Don't add `ready` until the head is final");
    expect(rules).toMatch(/Before qlander admits the PR, a push changes what would land and `ready` stays on/);
    expect(rules).toMatch(/After admission.*a push takes the PR out of the queue/);
    expect(read("docs/how-it-works.md")).toContain("A push before admission changes what would land");
  });

  test("the status issue's comments, T0 and C0, and a dry run's exit are as the code has them", () => {
    expect(read("docs/operating.md")).not.toContain("so the issue makes no notification noise");
    expect(read("docs/operating.md")).toContain("logs one comment here");
    expect(read("docs/getting-started.md")).toContain("T0 and C0 appear only for a problem");
    expect(read("template/AGENTS.md")).not.toContain("A dry run can exit 0 and print");
    expect(read("AGENTS.md")).toContain("| `qlander quiesce --dry-run` | The state is idle now.");
  });

  test("the design names a red fast lane among the told waits, and setup and audit agree on release-landing", () => {
    expect(read("DESIGN.md")).toContain("- **A red fast lane,** counted from its `ready` label");
    expect(read("DESIGN.md")).not.toContain("Waits for a fast lane or a review get no comment");
    expect(read("DESIGN.md")).toContain("It doesn't restrict updates, because a person merges a green hotfix PR there");
  });
});

describe("the agent docs", () => {
  test("the extraction finds a command that doesn't exist, and skips names that aren't commands", () => {
    const sample = '`bun "${bundle:?}" frobnicate` `qlander nope --x` `<target>-qlander` `qlander.yml` `/qlander zap <sha>`\n```sh\nbun src/cli.ts fenced\n```\nqlander prose';
    expect(namedCommands(sample)).toEqual({ cli: ["frobnicate", "nope", "fenced"], slash: ["zap"] });
  });

  test("every command they name is in the CLI's usage", () => {
    const known = usageCommands(USAGE);
    for (const c of ["tick", "status", "audit", "setup", "remove", "prioritise", "verify-sandbox"]) expect(known.has(c), c).toBe(true);
    for (const doc of AGENT_DOCS) expect(namedCommands(read(doc)).cli.filter((c) => !known.has(c)), doc).toEqual([]);
    for (const doc of ["AGENTS.md", "template/AGENTS.md"]) expect(namedCommands(read(doc)).cli.length, doc).toBeGreaterThan(5);
  });

  test("every /qlander command they name is one the queue counts", () => {
    const head = "a".repeat(40);
    const alice = { id: 1, login: "alice" };
    const slash = AGENT_DOCS.flatMap((doc) => namedCommands(read(doc)).slash);
    expect(slash.length).toBeGreaterThan(0);
    for (const c of slash) {
      const comment = { body: `/qlander ${c} ${head}`, created_at: "t", updated_at: "t", user: alice } as IssueComment;
      expect(policyApproval([comment], [alice], head), c).toBe(comment);
    }
  });

  test("the template ships its copies, and lists them", () => {
    const listing = read("template/README.md");
    for (const f of ["AGENTS.md", "agent-landing-rules.md"]) {
      expect(existsSync(join(ROOT, "template", f)), f).toBe(true);
      expect(listing).toContain(`| \`${f}\` |`);
    }
  });

  test("a link to the public repo's main names a file and #anchor that exist", () => {
    const broken: string[] = [];
    for (const doc of AGENT_DOCS) {
      for (const { target, line } of links(read(doc))) {
        if (!target.startsWith(PUBLIC_MAIN)) continue;
        const [file, anchor] = target.slice(PUBLIC_MAIN.length).split("#") as [string, string | undefined];
        if (!existsSync(join(ROOT, file)) || (anchor !== undefined && !anchors(read(file)).has(anchor))) broken.push(`${doc}:${line}: ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
