// `setup` (docs/deployment.md §5): makes the GitHub side of a deployment
// match the config, from an operator's machine, never from Actions.
//
//   setup [--config <file>] [--plan | --apply] [--step apps|install|control|target|verify|permissions]
//         [--keys-dir <dir> | --key-cmd <command>] [--name <prefix>] [--rotate]
//         [--apply-target-rulesets] [--poll-seconds <n>] [--wait-minutes <n>] [--skip-audit]
//
// --plan (the default; --dry-run is the same) prints every change and writes
// nothing. --apply makes them. Without --step it runs apps, install, control,
// target and verify in order, stopping at the first that fails; every step
// reads afresh, so any one can be rerun on its own. Apps are named
// `<prefix>-queue`, `<prefix>-release` and `<prefix>-state` (default prefix:
// the control repo's name).
//
// The operator's token is GH_TOKEN, else GITHUB_TOKEN, else `gh auth token`;
// it must be an owner of the orgs involved. Environment secrets are set with
// `gh secret set`, which encrypts them. QLANDER_GITHUB_API and
// QLANDER_GITHUB_WEB point at another GitHub host (GitHub Enterprise
// Server), default https://api.github.com and https://github.com.
//
// Exit 0 when every step reached its end state (or, in plan mode, could be
// planned), 1 when a step failed or waits for a person, 2 on a usage error.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { CONFIG_PATH, ConfigError, loadConfig } from "../config/load";
import { appsStep, installStep, permissionsStep } from "./app-steps";
import { SetupApi } from "./client";
import { Ctx, type SetupDeps, StepFailed } from "./context";
import { appSpecs, full, MAX_APP_NAME, slugOf, tooLongAppNames } from "./expected";
import { CommandKeyStore, DirKeyStore, KeyError, type KeyStore } from "./keys";
import { browserManifestCode } from "./manifest-flow";
import { controlStep, targetStep, verifyStep } from "./repo-steps";

export const STEPS = ["apps", "install", "control", "target", "verify", "permissions"] as const;
export type Step = (typeof STEPS)[number];
/** The steps a run without --step makes, in order. `permissions` runs only when asked for. */
export const DEFAULT_STEPS: Step[] = ["apps", "install", "control", "target", "verify"];

const RUN: Record<Step, (c: Ctx) => Promise<void>> = {
  apps: appsStep,
  install: installStep,
  control: controlStep,
  target: targetStep,
  verify: verifyStep,
  permissions: permissionsStep,
};

export const USAGE = [
  "usage: setup [--config <file>] [--plan | --apply] [--step apps|install|control|target|verify|permissions]",
  "             [--keys-dir <dir> | --key-cmd <command>] [--name <prefix>] [--rotate] [--apply-target-rulesets]",
  "             [--poll-seconds <n>] [--wait-minutes <n>] [--skip-audit]",
].join("\n");

export class UsageError extends Error {}

export interface SetupArgs {
  config: string;
  apply: boolean;
  step: Step | null;
  keysDir: string | null;
  keyCmd: string | null;
  name: string | null;
  rotate: boolean;
  targetRulesets: boolean;
  pollMs: number;
  waitMs: number;
  skipAudit: boolean;
}

const PREFIX = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,30}$/;

export function parseSetupArgs(args: string[]): SetupArgs {
  const a: SetupArgs = { config: CONFIG_PATH, apply: false, step: null, keysDir: null, keyCmd: null, name: null, rotate: false, targetRulesets: false, pollMs: 10_000, waitMs: 60 * 60_000, skipAudit: false };
  let mode: string | null = null;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const f = args[i]!;
    if (seen.has(f)) throw new UsageError(`${f} given twice`);
    seen.add(f);
    const value = () => {
      const v = args[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${f} needs a value`);
      return v;
    };
    const number = (min: number) => {
      const v = Number(value());
      if (!Number.isFinite(v) || v < min) throw new UsageError(`${f} needs a number of at least ${min}`);
      return v;
    };
    switch (f) {
      case "--config":
        a.config = resolve(value());
        break;
      case "--plan":
      case "--dry-run":
      case "--apply":
        if (mode && mode !== f) throw new UsageError(`${mode} and ${f} cannot be combined`);
        mode = f;
        a.apply = f === "--apply";
        break;
      case "--step": {
        const s = value();
        if (!(STEPS as readonly string[]).includes(s)) throw new UsageError(`unknown step ${s}: one of ${STEPS.join(", ")}`);
        a.step = s as Step;
        break;
      }
      case "--keys-dir":
        a.keysDir = value();
        break;
      case "--key-cmd":
        a.keyCmd = value();
        break;
      case "--name": {
        const v = value();
        if (!PREFIX.test(v)) throw new UsageError("--name must be a short App name prefix (letters, digits, space, _ . -)");
        a.name = v;
        break;
      }
      case "--rotate":
        a.rotate = true;
        break;
      case "--apply-target-rulesets":
        a.targetRulesets = true;
        break;
      case "--skip-audit":
        a.skipAudit = true;
        break;
      case "--poll-seconds":
        a.pollMs = number(0.01) * 1000;
        break;
      case "--wait-minutes":
        a.waitMs = number(0) * 60_000;
        break;
      default:
        throw new UsageError(`unexpected argument ${f}`);
    }
  }
  if (a.keysDir && a.keyCmd) throw new UsageError("--keys-dir and --key-cmd cannot be combined");
  if (a.rotate && a.step !== "control") throw new UsageError("--rotate goes with --step control");
  return a;
}

export type Env = Record<string, string | undefined>;

/** The operator's token: GH_TOKEN, GITHUB_TOKEN, or `gh auth token`. */
function operatorToken(env: Env): string | null {
  const t = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (t) return t;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/** `gh secret set`: it fetches the environment's public key and seals the value. The value goes on stdin, never argv. */
function ghSecretSet(env: Env) {
  return async (repo: { owner: string; name: string }, environment: string, name: string, value: string): Promise<void> => {
    const r = spawnSync("gh", ["secret", "set", name, "--env", environment, "--repo", full(repo)], { input: value, encoding: "utf8", env: env as NodeJS.ProcessEnv });
    if (r.status !== 0) throw new Error(`gh secret set ${name} --env ${environment} failed: ${(r.stderr || r.error?.message || "").trim()}`);
  };
}

export interface SetupIo {
  out(line: string): void;
  err(line: string): void;
}

/** Overrides for tests: the deps that would otherwise reach a person, `gh` or the clock. */
export type SetupOverrides = Partial<Pick<SetupDeps, "setSecret" | "manifestCode" | "sleep" | "now" | "audit">> & { input?: NodeJS.ReadableStream | null };

export async function runSetup(d: SetupDeps, steps: Step[]): Promise<number> {
  const c = new Ctx(d);
  for (const s of steps) {
    d.out(`== ${s}${d.apply ? "" : " (plan: nothing is written)"}`);
    try {
      await RUN[s](c);
    } catch (e) {
      if (e instanceof StepFailed) return 1;
      // A GitHub refusal, a key problem, a failed `gh` or a manifest flow that timed out: the step stops here, and rerunning it resumes.
      if (e instanceof Error) {
        d.out(`FAIL  ${s}: ${e.message}`);
        return 1;
      }
      throw e;
    }
  }
  return 0;
}

export async function setupCommand(args: string[], io: SetupIo, env: Env = process.env, overrides: SetupOverrides = {}): Promise<number> {
  let a: SetupArgs;
  try {
    a = parseSetupArgs(args);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(e.message);
    io.err(USAGE);
    return 2;
  }
  let config;
  try {
    config = loadConfig(a.config);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.err(`${e.source} is not a valid qlander config:`);
    for (const p of e.problems) io.err(`  ${p}`);
    return 1;
  }
  let keys: KeyStore | null = null;
  try {
    keys = a.keysDir ? new DirKeyStore(a.keysDir, a.apply) : a.keyCmd ? new CommandKeyStore(a.keyCmd) : null;
  } catch (e) {
    if (!(e instanceof KeyError)) throw e;
    io.err(e.message);
    return 2;
  }
  const token = operatorToken(env);
  if (!token) {
    io.err("no operator token: set GH_TOKEN, or log in with `gh auth login` as an owner of the orgs involved");
    return 2;
  }
  const tooLong = tooLongAppNames(appSpecs(config, a.name ?? config.config.names.control.name));
  if (tooLong.length > 0) {
    io.err(`App names are limited to ${MAX_APP_NAME} characters on GitHub: ${tooLong.join(", ")}. Set a shorter prefix with --name.`);
    return 2;
  }
  const web = (env.QLANDER_GITHUB_WEB ?? "https://github.com").replace(/\/$/, "");
  const deps: SetupDeps = {
    config,
    api: new SetupApi(token, { baseUrl: (env.QLANDER_GITHUB_API ?? "https://api.github.com").replace(/\/$/, "") }),
    keys,
    prefix: a.name ?? config.config.names.control.name,
    apply: a.apply,
    rotate: a.rotate,
    targetRulesets: a.targetRulesets,
    web,
    out: io.out,
    setSecret: overrides.setSecret ?? ghSecretSet(env),
    manifestCode:
      overrides.manifestCode ??
      ((spec, manifest, stop) => browserManifestCode(spec, manifest, { web, out: io.out, timeoutMs: Math.min(a.waitMs, 60 * 60_000), input: overrides.input === undefined ? process.stdin : overrides.input, stop })),
    sleep: overrides.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: overrides.now ?? Date.now,
    pollMs: a.pollMs,
    waitMs: a.waitMs,
    audit: a.skipAudit
      ? async () => null
      : overrides.audit ??
      (async () => {
        const { renderFindings, runAudit } = await import("../audit/command");
        const { auditReader } = await import("../audit/reader");
        const { unsettled } = await import("../audit/types");
        const prefix = a.name ?? config.config.names.control.name;
        const slugs = { queue: slugOf(`${prefix}-queue`), release: slugOf(`${prefix}-release`), state: slugOf(`${prefix}-state`) };
        const findings = await runAudit(auditReader({ token, baseUrl: deps.api.base.baseUrl }), config, "both", slugs);
        return { lines: renderFindings(findings, "audit:"), failed: unsettled(findings) };
      }),
  };
  return runSetup(deps, a.step ? [a.step] : DEFAULT_STEPS);
}
