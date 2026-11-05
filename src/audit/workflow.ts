// Static reading of GitHub Actions workflow files for `qlander audit`
// (docs/deployment.md §4.1). Workflows are parsed as YAML data, never run.
// Everything here is a pure function of the file's text, so each rule can be
// tested on a fixture string.

export type Yaml = Record<string, unknown>;

// Bun ships a YAML parser; its type is not in the bundled typings yet (as in src/config/load.ts).
const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;

const isObj = (v: unknown): v is Yaml => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : null);

/** The parsed workflow, or why it could not be read. */
export function parseWorkflow(text: string): { ok: true; wf: Yaml } | { ok: false; error: string } {
  let y: unknown;
  try {
    y = YAML.parse(text);
  } catch (e) {
    return { ok: false, error: `not valid YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObj(y)) return { ok: false, error: "not a YAML mapping" };
  return { ok: true, wf: y };
}

/** `on:` as a map from event to its settings (null when it has none). */
export function triggers(wf: Yaml): Map<string, Yaml | null> {
  const on = wf.on ?? (wf as Record<string, unknown>)["true"]; // a YAML 1.1 reader turns `on` into true
  const out = new Map<string, Yaml | null>();
  if (typeof on === "string") out.set(on, null);
  else if (Array.isArray(on)) {
    for (const e of on) if (typeof e === "string") out.set(e, null);
  } else if (isObj(on)) {
    for (const [k, v] of Object.entries(on)) out.set(k, isObj(v) ? v : null);
  }
  return out;
}

/**
 * A GitHub branch filter pattern as a RegExp: `*` is any run of characters
 * but `/`, `**` any run at all, `?` and `+` quantify the character before
 * them, `[...]` is a class. Everything else is literal.
 */
export function filterPattern(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?" || c === "+") re += c;
    else if (c === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += p.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.^$|(){}\\]/g, "\\$&");
  }
  return compile(re, p);
}

/** A RegExp, or, for a pattern GitHub would also refuse (a bad class), one that matches the text literally. */
function compile(re: string, literal: string): RegExp {
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return new RegExp(`^${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  }
}

/**
 * A ruleset ref pattern (fnmatch, as GitHub's rulesets use it): `*` is any
 * run of characters but `/`, `**` any run at all, `?` one character but
 * `/`, `[...]` a class. Everything else is literal.
 */
export function fnmatchPattern(p: string): RegExp {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = p.indexOf("]", i);
      if (end < 0) re += "\\[";
      else {
        re += p.slice(i, end + 1);
        i = end;
      }
    } else re += c.replace(/[.^$|(){}+\\]/g, "\\$&");
  }
  return compile(re, p);
}

/** Whether a push filter (`branches` / `branches-ignore`) lets a push to `branch` through. */
export function branchFilterMatches(filter: Yaml | null, branch: string): boolean {
  if (!filter) return true;
  const branches = strings(filter.branches);
  const ignore = strings(filter["branches-ignore"]);
  if (branches) {
    let included = false;
    for (const p of branches) {
      const neg = p.startsWith("!");
      if (filterPattern(neg ? p.slice(1) : p).test(branch)) included = !neg;
    }
    return included;
  }
  if (ignore) return !ignore.some((p) => filterPattern(p).test(branch));
  // Only a tags filter: GitHub runs it for tags, never for a branch push.
  if (strings(filter.tags) || strings(filter["tags-ignore"])) return false;
  return true;
}

/** The workflow's push trigger settings: absent (no push), or present with its filter (null = unfiltered). */
export function pushTrigger(wf: Yaml): { present: false } | { present: true; filter: Yaml | null } {
  const t = triggers(wf);
  return t.has("push") ? { present: true, filter: t.get("push") ?? null } : { present: false };
}

/** Whether a push to `branch` starts this workflow, ignoring path filters (they depend on the diff). */
export function runsOnPushTo(wf: Yaml, branch: string): boolean {
  const p = pushTrigger(wf);
  return p.present && branchFilterMatches(p.filter, branch);
}

/** A push trigger with no branch or tag filter: any branch an App creates or moves starts it. */
export function unfilteredPush(wf: Yaml): boolean {
  const p = pushTrigger(wf);
  if (!p.present) return false;
  const f = p.filter;
  return !f || !["branches", "branches-ignore", "tags", "tags-ignore"].some((k) => f[k] !== undefined);
}

/** The path filter on the push trigger, if any (`paths` or `paths-ignore`). */
export function pushPathFilter(wf: Yaml): string | null {
  const p = pushTrigger(wf);
  if (!p.present || !p.filter) return null;
  if (p.filter.paths !== undefined) return "paths";
  if (p.filter["paths-ignore"] !== undefined) return "paths-ignore";
  return null;
}

export interface JobInfo {
  id: string;
  /** The job's display name: `name:` when it is a plain string, else its id. */
  name: string;
  job: Yaml;
}

export function jobs(wf: Yaml): JobInfo[] {
  if (!isObj(wf.jobs)) return [];
  return Object.entries(wf.jobs)
    .filter(([, j]) => isObj(j))
    .map(([id, j]) => ({ id, name: typeof (j as Yaml).name === "string" ? ((j as Yaml).name as string) : id, job: j as Yaml }));
}

export function steps(job: Yaml): Yaml[] {
  return Array.isArray(job.steps) ? job.steps.filter(isObj) : [];
}

/** Every string value under `v`, with the key path that leads to it (`jobs.build.steps[2].if`). */
export function* stringsIn(v: unknown, path = ""): Generator<{ path: string; value: string }> {
  if (typeof v === "string") yield { path, value: v };
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* stringsIn(v[i], `${path}[${i}]`);
  else if (isObj(v)) for (const [k, x] of Object.entries(v)) yield* stringsIn(x, path ? `${path}.${k}` : k);
}

/** The 1-based line of the first occurrence of `needle` in `text` (0 when absent). */
export function lineOf(text: string, needle: string): number {
  const first = needle.split("\n")[0]!.trim();
  if (!first) return 0;
  const i = text.split("\n").findIndex((l) => l.includes(first));
  return i + 1;
}

/** `id-token: write` in a permissions block (or `permissions: write-all`). */
export function grantsIdToken(perms: unknown): boolean {
  if (perms === "write-all") return true;
  return isObj(perms) && perms["id-token"] === "write";
}

/** The secrets a value refers to (`secrets.NAME`), except GITHUB_TOKEN, whose scope the workflow's permissions set. */
export function secretsIn(v: unknown): string[] {
  const out = new Set<string>();
  for (const { value } of stringsIn(v)) for (const m of value.matchAll(/(?<![\w.-])secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) if (m[1] !== "GITHUB_TOKEN") out.add(m[1]!);
  if (isObj(v) && v.secrets === "inherit") out.add("(inherit)");
  return [...out];
}

// --- run: lines (T12) -------------------------------------------------------

/** Commands that run the file named by their first operand. */
const INTERPRETERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "bun", "node", "deno", "python", "python3", "ruby", "perl", "pwsh", "source", ".", "tsx", "ts-node"]);
/** Commands that run the file named after their `-f`. */
const FILE_FLAG = new Set(["awk", "gawk", "jq", "sed", "make"]);
/** Prefixes that run the rest of the line as a command. */
const WRAPPERS = new Set(["exec", "time", "sudo", "env", "nohup", "xargs", "command", "builtin", "if", "then", "else", "elif", "do", "while", "until", "!", "{"]);
/** A shell that runs a heredoc body, or a `-c` string, as a script. */
const SHELL = /^(ba|z|da|k)?sh$/;
const base = (w: string) => (w.startsWith("/") ? w.slice(w.lastIndexOf("/") + 1) : w);
const SCRIPT_EXT = /\.(sh|bash|ts|mts|js|mjs|cjs|py|rb|pl|awk|jq|ps1)$/;
const WORKSPACE = /^(\$\{\{\s*github\.workspace\s*\}\}|\$GITHUB_WORKSPACE|\$\{GITHUB_WORKSPACE\})\//;


/** The text of a `$( … )` starting at `open` (the index of `(`), and the index after its `)`. */
function substitution(s: string, open: number): { body: string; end: number } {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    if (s[k] === "(") depth++;
    else if (s[k] === ")" && --depth === 0) return { body: s.slice(open + 1, k), end: k + 1 };
  }
  return { body: s.slice(open + 1), end: s.length };
}

/**
 * A shell script as simple commands, each a list of words. Quotes keep a
 * word together and are removed; commands end at an unquoted newline, `&&`,
 * `||`, `;`, `|`, `&`, parenthesis or backquote. A `$( … )`, quoted or not,
 * is a command of its own, and so is a backquoted one. Comments are
 * dropped, and so are heredoc bodies, except one fed to a shell or an
 * interpreter (`bash <<EOF`), which is read as a script. This is
 * a reading aid for a static scan, not a shell: it is meant to find the
 * files a script runs, and says nothing about whether it would.
 */
export function shellCommands(script: string): string[][] {
  const cmds: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let heredoc: string | null = null;
  let heredocRuns = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) cmds.push(words);
    words = [];
  };
  let i = 0;
  while (i < script.length) {
    const c = script[i]!;
    if (c === "\n") {
      endCmd();
      i++;
      if (heredoc !== null) {
        // the body, up to and including the delimiter line
        const body: string[] = [];
        while (i < script.length) {
          const nl = script.indexOf("\n", i);
          const line = script.slice(i, nl < 0 ? undefined : nl);
          i = nl < 0 ? script.length : nl + 1;
          if (line.trim() === heredoc) break;
          body.push(line);
        }
        if (heredocRuns) cmds.push(...shellCommands(body.join("\n")));
        heredoc = null;
        heredocRuns = false;
      }
    } else if (c === "'") {
      const end = script.indexOf("'", i + 1);
      word += script.slice(i + 1, end < 0 ? undefined : end);
      inWord = true;
      i = end < 0 ? script.length : end + 1;
    } else if (c === '"') {
      let k = i + 1;
      let text = "";
      while (k < script.length && script[k] !== '"') {
        if (script[k] === "\\" && k + 1 < script.length) {
          text += script[k + 1];
          k += 2;
        } else if (script[k] === "$" && script[k + 1] === "(") {
          const sub = substitution(script, k + 1);
          cmds.push(...shellCommands(sub.body));
          text += script.slice(k, sub.end);
          k = sub.end;
        } else if (script[k] === "`") {
          const end = script.indexOf("`", k + 1);
          const stop = end < 0 || end > script.indexOf('"', k + 1) ? script.indexOf('"', k + 1) : end;
          cmds.push(...shellCommands(script.slice(k + 1, stop < 0 ? undefined : stop)));
          text += script.slice(k, stop < 0 ? undefined : stop);
          k = stop < 0 ? script.length : stop === end ? end + 1 : stop;
        } else text += script[k++];
      }
      word += text;
      inWord = true;
      i = k + 1;
    } else if (c === "\\") {
      if (script[i + 1] !== "\n") {
        word += script[i + 1] ?? "";
        inWord = true;
      }
      i += 2;
    } else if (c === "#" && !inWord) {
      const nl = script.indexOf("\n", i);
      i = nl < 0 ? script.length : nl;
    } else if (c === "<" && script[i + 1] === "<" && script[i + 2] !== "<") {
      endWord();
      const m = /^<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(script.slice(i));
      if (m) {
        heredoc = m[2]!;
        const head = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && !WRAPPERS.has(w));
        heredocRuns = head !== undefined && INTERPRETERS.has(base(head));
        i += m[0].length;
      } else i += 2;
    } else if (/\s/.test(c)) {
      endWord();
      i++;
    } else if (c === "$" && script[i + 1] === "(") {
      endCmd();
      i += 2;
    } else if (";&|()`".includes(c)) {
      endCmd();
      i++;
    } else {
      word += c;
      inWord = true;
      i++;
    }
  }
  endCmd();
  return cmds;
}

/**
 * The repo files a `run:` script executes: the command word when it is a
 * path, the first operand of an interpreter (`bash x.sh`, `bun x.ts`), the
 * file after `-f` (`jq -f x.jq`), the same after `nix develop … -c` or
 * `uv run`, and whatever a `bash -c '…'` string runs. Each is returned as
 * written, with `./` and a workspace prefix removed; `dynamic` holds the
 * ones built from a variable or expression, which a static scan cannot
 * resolve.
 */
export function executedPaths(script: string): { paths: string[]; dynamic: string[] } {
  const paths: string[] = [];
  const dynamic: string[] = [];
  for (const words of shellCommands(script)) {
    let i = 0;
    while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || WRAPPERS.has(words[i]!))) i++;
    if (words[i] === "nix" && (words[i + 1] === "develop" || words[i + 1] === "shell")) {
      const c = words.findIndex((w, k) => k > i && (w === "-c" || w === "--command"));
      if (c < 0) continue;
      i = c + 1;
    }
    if (words[i] === "uv" && words[i + 1] === "run") {
      i += 2;
      while (i < words.length && words[i]!.startsWith("-")) i++;
    }
    const raw = words[i];
    if (!raw) continue;
    const word = INTERPRETERS.has(base(raw)) || FILE_FLAG.has(base(raw)) ? base(raw) : raw;
    let target: string | undefined;
    if (INTERPRETERS.has(word)) {
      let k = i + 1;
      while (k < words.length && words[k]!.startsWith("-")) {
        if (words[k] === "-c" && SHELL.test(word)) {
          const inner = executedPaths(words[k + 1] ?? "");
          paths.push(...inner.paths);
          dynamic.push(...inner.dynamic);
          k = words.length;
          break;
        }
        k++;
      }
      // `bun run <name>` runs a package.json script unless <name> is a path
      if (word === "bun" && words[k] === "run") k++;
      const op = words[k];
      if (op && (op.includes("/") || SCRIPT_EXT.test(op) || op.includes("$"))) target = op;
    } else if (FILE_FLAG.has(word)) {
      const f = words.findIndex((w, k) => k > i && w === "-f");
      if (f >= 0 && words[f + 1]) target = words[f + 1];
    } else if (word.includes("/") || SCRIPT_EXT.test(word)) target = word;
    if (!target) continue;
    const t = target.replace(WORKSPACE, "");
    if (t.startsWith("/") || t.startsWith("~")) continue; // a system path, not the repo's
    if (/\$|\{\{/.test(t)) dynamic.push(target);
    else paths.push(t.replace(/^(\.\/)+/, ""));
  }
  return { paths, dynamic };
}

/** `a/b/../c` → `a/c`; null when it climbs out of the repo. */
export function normalisePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** A local `uses:` (`./path`), as a repo path, or null for a remote one. */
export function localUses(uses: unknown): string | null {
  if (typeof uses !== "string" || !uses.startsWith("./")) return null;
  return normalisePath(uses.replace(/@.*$/, ""));
}
