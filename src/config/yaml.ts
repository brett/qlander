// What Bun.YAML.parse lets through that a policy file must not: a repeated
// mapping key (YAML forbids it, Bun keeps the last one silently, so a
// reviewer reading the first would approve the wrong value), and syntax a
// reviewer could misread. This screen accepts only a small, line-based
// subset of YAML and refuses everything else, so it never has to understand
// a construct to find the keys inside it:
//   - block mappings, `key: value` or `key:` with a plain key;
//   - block sequences, `- value` or `- key: value`;
//   - values that are a plain scalar or one quoted string, on one line, or
//     an empty `[]` or `{}`.
// Refused: other flow collections, block scalars (`|`, `>`), quoted
// keys, anchors, aliases, tags, merge keys, directives, complex keys,
// multi-line scalars and tabs. A config file needs none of them.

/** A plain key: starts with a letter, digit or underscore and holds no YAML
 * indicator. A comma is only an indicator inside a flow collection, which is
 * refused, so a job name like `Build (linux, arm64)` can be a key. */
const KEY = /^([A-Za-z0-9_][^:#"'{}[\]&*!|>%@`]*?)[ ]*:(?: (.*))?$/;
const QUOTED = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*')$/;
/** A plain scalar: no indicator first, no ": " or " #" inside, no trailing colon. */
const PLAIN = /^[^\s\-?:,[\]{}#&*!|>'"%@`](?:(?!: | #).)*$/;

const isScalar = (v: string) => (QUOTED.test(v) || PLAIN.test(v)) && !v.endsWith(":");

/** The line without its comment, or null when a quote is left open. */
function stripComment(line: string): string | null {
  let q: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i).trimEnd();
  }
  return q ? null : line.trimEnd();
}

/** Problems with the YAML text itself, before it is parsed; empty when it passes. */
export function yamlTextProblems(text: string): string[] {
  const out: string[] = [];
  const scopes: { col: number; keys: Set<string> }[] = [];
  for (const [n, raw] of text.split("\n").entries()) {
    const at = `line ${n + 1}`;
    if (raw.includes("\t")) {
      out.push(`${at}: tabs are not allowed`);
      continue;
    }
    const line = stripComment(raw);
    if (line === null) {
      out.push(`${at}: a quoted string must end on its line`);
      continue;
    }
    if (line.trim() === "" || (n === 0 && line === "---")) continue;
    let col = line.length - line.trimStart().length;
    let rest = line.slice(col);
    let item = false;
    if (/^-( |$)/.test(rest)) {
      const after = rest.slice(1);
      col += 1 + (after.length - after.trimStart().length);
      rest = after.trimStart();
      item = true;
    }
    const m = KEY.exec(rest);
    if (!m) {
      if (!(item && isScalar(rest))) out.push(`${at}: not in the YAML subset qlander.yml allows (plain keys, block lists, one-line scalars)`);
      continue;
    }
    const value = (m[2] ?? "").trim();
    if (value !== "" && value !== "[]" && value !== "{}" && !isScalar(value)) {
      out.push(`${at}: the value must be a one-line plain or quoted scalar (no flow collections, block scalars, anchors, aliases or tags)`);
      continue;
    }
    const key = m[1]!;
    if (item) while (scopes.length && scopes[scopes.length - 1]!.col >= col) scopes.pop();
    else while (scopes.length && scopes[scopes.length - 1]!.col > col) scopes.pop();
    if (!scopes.length || scopes[scopes.length - 1]!.col < col) scopes.push({ col, keys: new Set() });
    const scope = scopes[scopes.length - 1]!;
    if (scope.keys.has(key)) out.push(`${at}: duplicate key ${JSON.stringify(key)}`);
    scope.keys.add(key);
  }
  return out;
}
