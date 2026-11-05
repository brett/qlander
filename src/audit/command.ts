// `qlander audit` (docs/deployment.md §4.2):
//
//   GH_TOKEN=$(gh auth token) bun src/cli.ts audit [--config <file>]
//       [--target-only|--control-only] [--json]
//       [--queue-app <slug>] [--release-app <slug>] [--state-app <slug>]
//
// Checks the target's CI requirements (T1–T12) and the control repo's
// protection (C1–C8) and prints one line per finding: PASS, WARN, FAIL or
// SKIPPED, with the requirement id and a fix. It only reads: every request is
// a GET (src/audit/reader.ts), and it never prints the token. A rule that
// needs admin rights the token lacks is SKIPPED, never a guessed PASS.
//
// Exit 0: no FAIL and no failed read. Exit 1: a FAIL that is an answer. Exit 2:
// a usage error. Exit 3: inconclusive, no such FAIL but a failed read (a finding
// marked `inconclusive`; see readFailed), no token, an invalid config, or a
// stopped audit.
//
// The Apps are found by slug, by default `<control repo name>-queue`,
// `-release` and `-state` (the names setup gives them).

import { resolve } from "node:path";
import { CONFIG_PATH, ConfigError, type LoadedConfig, loadConfig } from "../config/load";
import { EXIT_INCONCLUSIVE } from "../operator";
import type { HttpOptions } from "../github/http";
import { type AppRole, readApps } from "./apps";
import { auditControl } from "./control";
import { auditReader } from "./reader";
import { auditTarget } from "./target";
import { type AuditGh, auditExitCode, type Finding } from "./types";

export const AUDIT_USAGE =
  "usage: audit [--config <file>] [--target-only|--control-only] [--json] [--queue-app <slug>] [--release-app <slug>] [--state-app <slug>]   (token: GH_TOKEN or GITHUB_TOKEN; read-only)";

export interface AuditIo {
  out(line: string): void;
  err(line: string): void;
}

export interface AuditDeps {
  env: Record<string, string | undefined>;
  /** Builds the reader (default: the real GET-only client). */
  connect?: (http: HttpOptions) => AuditGh;
}

interface Args {
  config: string;
  scope: "both" | "target" | "control";
  json: boolean;
  slugs: Partial<Record<AppRole, string>>;
}

function parseArgs(args: string[]): Args | string {
  const a: Args = { config: CONFIG_PATH, scope: "both", json: false, slugs: {} };
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!;
    const value = () => {
      const v = args[++i];
      if (!v || v.startsWith("--")) throw new Error(`${x} needs a value`);
      return v;
    };
    try {
      if (x === "--config") a.config = resolve(value());
      else if (x === "--json") a.json = true;
      else if (x === "--target-only" || x === "--control-only") {
        if (a.scope !== "both") return "--target-only and --control-only exclude each other";
        a.scope = x === "--target-only" ? "target" : "control";
      } else if (x === "--queue-app" || x === "--release-app" || x === "--state-app") a.slugs[x.slice(2, -4) as AppRole] = value();
      else return `unexpected argument ${x}`;
    } catch (e) {
      return (e as Error).message;
    }
  }
  return a;
}

/** The findings as text: one line each, its fix and details indented under it, then a count. */
export function renderFindings(findings: Finding[], header: string): string[] {
  const lines = [header];
  for (const f of findings) {
    lines.push(`${f.status.padEnd(7)} ${f.id.padEnd(4)} ${f.inconclusive ? "(read failed) " : ""}${f.message}`);
    if (f.fix && f.status !== "PASS") lines.push(`             fix: ${f.fix}`);
    for (const d of f.details ?? []) lines.push(`             - ${d}`);
  }
  lines.push(summary(findings));
  return lines;
}

export function summary(findings: Finding[]): string {
  const n = (s: string) => findings.filter((f) => f.status === s).length;
  const failedReads = findings.filter((f) => f.inconclusive).length;
  return `${n("PASS")} PASS, ${n("WARN")} WARN, ${n("FAIL")} FAIL, ${n("SKIPPED")} SKIPPED${failedReads ? `, ${failedReads} of them failed reads: inconclusive` : ""}`;
}

export async function runAudit(gh: AuditGh, cfg: LoadedConfig, scope: Args["scope"], slugs: Args["slugs"]): Promise<Finding[]> {
  const N = cfg.config.names;
  const base = N.control.name;
  const roles: AppRole[] = ["queue", ...(cfg.release.enabled ? (["release"] as const) : []), "state"];
  const apps = await readApps(
    gh,
    roles.map((role) => ({ role, slug: slugs[role] ?? `${base}-${role}` })),
  );
  const out: Finding[] = [];
  if (scope !== "control") out.push(...(await auditTarget(gh, cfg, apps)));
  if (scope !== "target") out.push(...(await auditControl(gh, cfg, apps)));
  return out;
}

export async function auditCommand(args: string[], io: AuditIo, deps: AuditDeps): Promise<number> {
  const a = parseArgs(args);
  if (typeof a === "string") {
    io.err(a);
    io.err(AUDIT_USAGE);
    return 2;
  }
  const token = deps.env.GH_TOKEN || deps.env.GITHUB_TOKEN;
  if (!token || !/^[\x21-\x7e]+$/.test(token)) {
    io.err("audit needs a read token in GH_TOKEN or GITHUB_TOKEN, for example: GH_TOKEN=$(gh auth token)");
    return EXIT_INCONCLUSIVE;
  }
  const redact = (t: string) => (token.length >= 8 ? t.split(token).join("[token]") : t);
  const safe: AuditIo = { out: (l) => io.out(redact(l)), err: (l) => io.err(redact(l)) };
  let cfg: LoadedConfig;
  try {
    cfg = loadConfig(a.config);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    safe.err(`${e.source} is not a valid qlander config:`);
    for (const p of e.problems) safe.err(`  ${p}`);
    return EXIT_INCONCLUSIVE;
  }
  const http: HttpOptions = { token, ...(deps.env.GITHUB_API_URL ? { baseUrl: deps.env.GITHUB_API_URL } : {}) };
  const gh = (deps.connect ?? auditReader)(http);
  let findings: Finding[];
  try {
    findings = await runAudit(gh, cfg, a.scope, a.slugs);
  } catch (e) {
    safe.err(`audit stopped: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT_INCONCLUSIVE;
  }
  const N = cfg.config.names;
  if (a.json) safe.out(JSON.stringify({ target: `${N.target.owner}/${N.target.name}`, control: `${N.control.owner}/${N.control.name}`, findings }));
  else for (const l of renderFindings(findings, `qlander audit: target ${N.target.owner}/${N.target.name} (${N.main}), control ${N.control.owner}/${N.control.name}`)) safe.out(l);
  return auditExitCode(findings);
}
