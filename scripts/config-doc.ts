// Generates docs/configuration.md from schema/qlander.schema.json: one
// section per block, with a table of its keys (type, default, meaning) and a
// YAML example. Each example value comes from the neutral example config
// (test/fixtures/example.qlander.yml), or else from the key's `examples`
// in the schema. test/docs.test.ts fails when the checked-in file is stale.
//
//   bun scripts/config-doc.ts            write docs/configuration.md
//   bun scripts/config-doc.ts --check    exit 1 if it differs from the rendering

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type S = Record<string, any>;

export const ROOT = join(import.meta.dir, "..");
export const DOC_PATH = "docs/configuration.md";
const SCHEMA_PATH = "schema/qlander.schema.json";
const EXAMPLE_PATH = "test/fixtures/example.qlander.yml";
const MAX_ITEMS = 3;
// $defs that are a format of their own: their name is the key's type, and
// their description is listed once, under Formats.
const FORMATS: Record<string, string> = { repo: "owner/name", branch: "branch", refPrefix: "branch prefix", label: "label", workflowPath: "workflow path", envName: "variable name" };

const isObj = (x: unknown): x is S => typeof x === "object" && x !== null && !Array.isArray(x);

function deref(root: S, n: S): { node: S; def: string | null } {
  if (typeof n.$ref !== "string") return { node: n, def: null };
  const def = n.$ref.replace("#/$defs/", "");
  const { $ref: _, ...own } = n;
  return { node: { ...root.$defs[def], ...own, description: own.description ?? root.$defs[def].description }, def };
}

const isBlock = (n: S) => n.type === "object" && isObj(n.properties);
const isBlockList = (root: S, n: S) => n.type === "array" && isBlock(deref(root, n.items ?? {}).node);
const hasVariants = (n: S) => Array.isArray(n.oneOf);

/** GitHub's heading anchor. */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function yamlScalar(v: unknown): string {
  if (typeof v === "string") {
    const plain = /^[A-Za-z0-9_.\/-][A-Za-z0-9_.\/@:*\[\]-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|[0-9.]+)$/i.test(v);
    return plain ? v : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

/** v as YAML lines in the subset qlander.yml allows (src/config/yaml.ts), lists cut at maxItems. */
export function yaml(v: unknown, indent = "", maxItems = Infinity): string[] {
  if (Array.isArray(v)) {
    if (v.length === 0) return [`${indent}[]`];
    return v.slice(0, maxItems).flatMap((x) => {
      if (isObj(x)) {
        const [first, ...rest] = yaml(x, `${indent}  `, maxItems);
        return [`${indent}- ${first!.trimStart()}`, ...rest];
      }
      return [`${indent}- ${yamlScalar(x)}`];
    });
  }
  if (isObj(v)) {
    if (Object.keys(v).length === 0) return [`${indent}{}`];
    return Object.entries(v).flatMap(([k, x]) => (isObj(x) || Array.isArray(x) ? (Array.isArray(x) && x.length === 0) || (isObj(x) && Object.keys(x).length === 0) ? [`${indent}${k}: ${Array.isArray(x) ? "[]" : "{}"}`] : [`${indent}${k}:`, ...yaml(x, `${indent}  `, maxItems)] : [`${indent}${k}: ${yamlScalar(x)}`]));
  }
  return [`${indent}${yamlScalar(v)}`];
}

function typeOf(root: S, n: S, def: string | null): string {
  if (def && FORMATS[def]) return `[${FORMATS[def]}](#formats)`;
  if ("const" in n) return `\`${n.const}\``;
  if (Array.isArray(n.enum)) return "string";
  if (hasVariants(n)) return "mapping";
  if (n.type === "object") return "mapping";
  if (n.type === "array") {
    const items = deref(root, n.items ?? {}).node;
    const itemDef = typeof n.items?.$ref === "string" ? n.items.$ref.replace("#/$defs/", "") : null;
    if (itemDef && FORMATS[itemDef]) return `list of [${FORMATS[itemDef]}s](#formats)`;
    return `list of ${isBlock(items) ? "mappings" : Array.isArray(items.enum) ? "strings" : `${items.type}s`}`;
  }
  return n.type;
}

function inline(v: unknown): string {
  if (Array.isArray(v)) return `\`[${v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(", ")}]\``;
  return `\`${typeof v === "string" ? v : JSON.stringify(v)}\``;
}

function meaning(n: S, def: string | null, raw: S): string {
  const parts = [def && FORMATS[def] && !raw.description ? "" : (n.description ?? "")];
  const enumOf = Array.isArray(n.enum) ? n.enum : n.type === "array" && Array.isArray(n.items?.enum) ? n.items.enum : null;
  if (enumOf) parts.push(`Values: ${enumOf.map((e: string) => `\`${e}\``).join(", ")}.`);
  if (typeof n.minimum === "number" && n.minimum !== 1) parts.push(`At least ${n.minimum}.`);
  return parts.filter(Boolean).join(" ").replace(/\|/g, "\\|");
}

type Section = { path: string; heading: string; level: number; node: S; parentPath: string[]; list: boolean; variant: string | null };

/** The blocks to document, in schema order: a block's own section, then its sub-blocks'. */
function sections(root: S): Section[] {
  const out: Section[] = [];
  const walk = (path: string[], n: S, list: boolean, variant: string | null) => {
    const dotted = path.join(".") + (list ? "[]" : "");
    const heading = path.length === 0 ? "Top level" : `\`${dotted}\`${variant ? ` (adapter \`${variant}\`)` : ""}`;
    out.push({ path: dotted, heading, level: path.length <= 1 ? 2 : 3, node: n, parentPath: path, list, variant });
    for (const [k, raw] of Object.entries(n.properties as S)) {
      const { node } = deref(root, raw as S);
      if (isBlock(node)) walk([...path, k], node, false, null);
      else if (isBlockList(root, node)) walk([...path, k], deref(root, node.items).node, true, null);
      else if (hasVariants(node)) for (const v of node.oneOf as S[]) walk([...path, k], v, false, String(v.properties?.adapter?.const ?? ""));
    }
  };
  walk([], root, false, null);
  return out;
}

const at = (v: unknown, path: string[]): unknown => path.reduce<unknown>((x, k) => (isObj(x) ? x[k] : undefined), v);

/** The example for one section: its own keys only (sub-blocks have their own), nested under its path. */
function example(root: S, sec: Section, fixture: unknown, missing: string[]): unknown {
  const fromFixture = at(fixture, sec.parentPath);
  const variantMatches = (x: unknown) => sec.variant === null || (isObj(x) && x.adapter === sec.variant);
  const one = (fx: unknown): S => {
    const o: S = {};
    for (const [k, raw] of Object.entries(sec.node.properties as S)) {
      const { node } = deref(root, raw as S);
      if (isBlock(node) || isBlockList(root, node) || hasVariants(node)) continue;
      const v = isObj(fx) && variantMatches(fx) && fx[k] !== undefined ? fx[k] : node.examples?.[0];
      if (v === undefined) missing.push(`${sec.path}.${k}`);
      else o[k] = v;
    }
    return o;
  };
  const body = sec.list ? (Array.isArray(fromFixture) && fromFixture.length > 0 ? fromFixture.map(one) : [one(undefined)]) : one(fromFixture);
  return sec.parentPath.reduceRight<unknown>((inner, k) => ({ [k]: inner }), body);
}

const firstSentence = (d: string) => (/^.*?\.(?=\s|$)/.exec(d)?.[0] ?? d).replace(/\|/g, "\\|");

export function renderConfigDoc(schema: S, fixture: unknown): { text: string; missing: string[] } {
  const missing: string[] = [];
  const secs = sections(schema);
  const out: string[] = [
    "# Configuration",
    "",
    "<!-- Generated from schema/qlander.schema.json by scripts/config-doc.ts. Do not edit: change the schema, then run `bun scripts/config-doc.ts`. -->",
    "",
    "Qlander reads one file: `qlander.yml`, at the root of the control repo. Start from the template's copy and change what you need. This page lists every key.",
    "",
    "- **Default** is the value used when you leave the key out. `required` means you must set it. `none` means no single default: the meaning, or the block's own section, says what leaving it out does.",
    "- **Policy.** Most keys are in the policy hash: changing one makes every admitted PR lose `ready` at the next tick. Outside the hash: `control.mainProtection`, `queue.concurrency`, `queue.strategy`, `hooks`, `tokens`, `bundle`, `notify`, `comments`, `runner` except its timings, and `release` except `branch`, `stateBranch` and `labels`. See [the policy hash](deployment.md#82-the-policy-hash).",
    "- **Checking.** Run `bun \"${bundle:?}\" validate --config qlander.yml` to check a config. After any change, run `bun \"${bundle:?}\" render --config qlander.yml` and commit the workflows with it. (In the qlander source repo, `bun src/cli.ts` in place of the bundle.)",
    "",
    "## Contents",
    "",
    ...secs.map((s) => `${s.level === 2 ? "" : "  "}- [${s.heading.replace(/`/g, "")}](#${slug(s.heading)})`),
    "- [Formats](#formats)",
    "",
  ];
  for (const sec of secs) {
    out.push(`${"#".repeat(sec.level)} ${sec.heading}`, "");
    if (sec.node.description) out.push(sec.node.description, "");
    out.push("| Key | Type | Default | Meaning |", "| --- | --- | --- | --- |");
    const required = new Set<string>(sec.node.required ?? []);
    for (const [k, raw] of Object.entries(sec.node.properties as S)) {
      const { node, def } = deref(schema, raw as S);
      const key = `${sec.path ? `${sec.path}.` : ""}${k}`;
      const dflt = required.has(k) ? "required" : "default" in node ? inline(node.default) : "none";
      const sub = isBlock(node) || isBlockList(schema, node) ? `\`${key}${isBlockList(schema, node) ? "[]" : ""}\`` : hasVariants(node) ? null : undefined;
      let m = sub === undefined ? meaning(node, def, raw as S) : firstSentence(node.description ?? "");
      if (sub) m += ` See [${sub.replace(/`/g, "")}](#${slug(sub)}).`;
      if (sub === null) m += ` See ${(node.oneOf as S[]).map((v) => `[${key} (adapter ${v.properties.adapter.const})](#${slug(`\`${key}\` (adapter \`${v.properties.adapter.const}\`)`)})`).join(" and ")}.`;
      out.push(`| \`${key}\` | ${typeOf(schema, node, def)} | ${dflt} | ${m} |`);
    }
    const ex = example(schema, sec, fixture, missing);
    if (!isObj(at(ex, sec.parentPath)) || Object.keys(at(ex, sec.parentPath) as S).length > 0) out.push("", "```yaml", ...yaml(ex, "", MAX_ITEMS), "```");
    out.push("");
  }
  out.push("## Formats", "", "| Type | Format |", "| --- | --- |");
  for (const [def, name] of Object.entries(FORMATS)) out.push(`| ${name} | ${schema.$defs[def].description} |`);
  return { text: out.join("\n").replace(/\n+$/, "\n") + "\n", missing };
}

export function renderFromRepo(root = ROOT): { text: string; missing: string[] } {
  const schema = JSON.parse(readFileSync(join(root, SCHEMA_PATH), "utf8"));
  const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
  const fixture = YAML.parse(readFileSync(join(root, EXAMPLE_PATH), "utf8"));
  return renderConfigDoc(schema, fixture);
}

if (import.meta.main) {
  const { text, missing } = renderFromRepo();
  if (missing.length) {
    console.error(`no example for: ${missing.join(", ")}`);
    process.exit(1);
  }
  const file = join(ROOT, DOC_PATH);
  if (process.argv.includes("--check")) {
    if (readFileSync(file, "utf8") !== text) {
      console.error(`${DOC_PATH} is stale: run bun scripts/config-doc.ts`);
      process.exit(1);
    }
  } else writeFileSync(file, text);
}
