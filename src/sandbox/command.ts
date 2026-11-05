// `verify-sandbox`: rollout gate G1 and experiment H1 (docs/deployment.md
// §3.4) against a sandbox repo, from the config's branch names.
//
//   bun src/sandbox/command.ts <phase> --repo <owner>/<name> --repo-id <id> [--config <file>]
//
// Phases, each with only its own tokens in the environment (any other
// VERIFY_*_TOKEN present is refused, as a tick refuses the other App's key):
//   queue    VERIFY_QUEUE_TOKEN, VERIFY_STATE_TOKEN   G1, and the queue epoch
//   release  VERIFY_RELEASE_TOKEN                     the release epoch; the queue epoch as the other App
//   cross    VERIFY_QUEUE_TOKEN                       the release epoch as the other App
//   admin    VERIFY_ADMIN_TOKEN                       an org admin: the rulesets and every admin reset
// Run them in that order; each later phase attacks the epochs the earlier
// ones made. Exit 0 when every planned check of the phase passed, 1 when
// any failed or did not run, 2 on a usage error or a refused target.
//
// The sandbox must never be the config's target or control repo: the
// command refuses either by id and by name before it reads a token, and each
// App token must reach the sandbox and no other repo before anything is
// written.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { epochBranchFor, type Names } from "../config";
import { CONFIG_PATH, ConfigError, loadConfig } from "../config/load";
import { Abort, describeError, type Phase, PHASES, plan, PushRejected, Recorder, refNumbers, summarize, type Summary } from "./checks";
import { type HttpBase, runG1 } from "./g1";
import { h1Admin, h1Cross, h1Queue, h1Release, type Pusher } from "./h1";
import { type ReadTiming, type Sandbox, tokenRepos } from "./repo";

export type Env = Record<string, string | undefined>;

export const USAGE = "usage: verify-sandbox queue|release|cross|admin --repo <owner>/<name> --repo-id <id> [--config <file>]";

/** The environment variables each phase reads; every other one listed here must be absent. */
export const PHASE_TOKENS: Record<Phase, string[]> = {
  queue: ["VERIFY_QUEUE_TOKEN", "VERIFY_STATE_TOKEN"],
  release: ["VERIFY_RELEASE_TOKEN"],
  cross: ["VERIFY_QUEUE_TOKEN"],
  admin: ["VERIFY_ADMIN_TOKEN"],
};
const ALL_TOKENS = [...new Set(Object.values(PHASE_TOKENS).flat())];

export class UsageError extends Error {}

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseArgs(args: string[]): { phase: Phase; sandbox: Sandbox; config: string } {
  const [phase, ...rest] = args;
  if (!PHASES.includes(phase as Phase)) throw new UsageError(`unknown phase ${phase ?? "(none)"}`);
  let repo: string | undefined;
  let id: string | undefined;
  let config = CONFIG_PATH;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    const v = rest[++i];
    if (v === undefined) throw new UsageError(`${a} needs a value`);
    if (a === "--repo" && repo === undefined) repo = v;
    else if (a === "--repo-id" && id === undefined) id = v;
    else if (a === "--config") config = resolve(v);
    else throw new UsageError(`unexpected argument ${a}`);
  }
  const [owner, name, ...extra] = (repo ?? "").split("/");
  if (!owner || !name || extra.length > 0 || !NAME_RE.test(owner) || !NAME_RE.test(name)) throw new UsageError("--repo must be <owner>/<name>");
  const repoId = Number(id);
  if (!id || !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(repoId)) throw new UsageError("--repo-id must be a repository id");
  return { phase: phase as Phase, sandbox: { owner, repo: name, repoId }, config };
}

/** Why `sandbox` must not be used: it is the config's target or control repo (by id or by name), or null. */
export function forbiddenTarget(sandbox: Sandbox, names: Names): string | null {
  const full = `${sandbox.owner}/${sandbox.repo}`.toLowerCase();
  for (const [what, r] of [["target", names.target], ["control", names.control]] as const) {
    if (sandbox.repoId === r.id) return `repo id ${sandbox.repoId} is the config's ${what} repo (${what}.repoId)`;
    if (full === `${r.owner}/${r.name}`.toLowerCase()) return `${sandbox.owner}/${sandbox.repo} is the config's ${what} repo`;
  }
  return null;
}

/** Each phase's tokens, after refusing any token that belongs to another phase. */
export function phaseTokens(phase: Phase, env: Env): Record<string, string> {
  const own = PHASE_TOKENS[phase];
  const foreign = ALL_TOKENS.filter((t) => !own.includes(t) && env[t]);
  if (foreign.length > 0) throw new UsageError(`refusing the ${phase} phase: ${foreign.join(", ")} must not be in its environment`);
  const missing = own.filter((t) => !env[t]);
  if (missing.length > 0) throw new UsageError(`the ${phase} phase needs ${missing.join(" and ")}`);
  return Object.fromEntries(own.map((t) => [t, env[t]!]));
}

/** The admin's `git push --force`, in a fresh temp repo; the token goes in through git's environment, never argv. */
export function gitPusher(sandbox: Sandbox, token: string): Pusher {
  const url = `https://github.com/${sandbox.owner}/${sandbox.repo}.git`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
  const git = (dir: string, args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", dir, ...args], { env, stdout: "pipe", stderr: "pipe" });
    return { code: p.exitCode, out: `${p.stdout.toString()}${p.stderr.toString()}` };
  };
  return {
    async forcePush(branch: string, sha: string) {
      const dir = mkdtempSync(join(tmpdir(), "verify-sandbox-"));
      try {
        for (const step of [["init", "-q"], ["fetch", "-q", "--no-tags", url, `+refs/heads/${branch}:refs/remotes/sandbox/epoch`]]) {
          const r = git(dir, step);
          if (r.code !== 0) throw new Error(`git ${step[0]} failed: ${r.out.trim()}`);
        }
        const r = git(dir, ["push", "--force", "--porcelain", url, `${sha}:refs/heads/${branch}`]);
        if (r.code === 0) return;
        if (/\[remote rejected\]|GH013|rule violations|declined/i.test(r.out)) throw new PushRejected(r.out.trim());
        throw new Error(`git push failed: ${r.out.trim()}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export interface Deps {
  http?: HttpBase;
  pusher?: (sandbox: Sandbox, token: string) => Pusher;
  log?: (line: string) => void;
  /** G1's wait for GitHub to mark the PRs merged, and check 4's wait before listing runs. */
  mergeWaitMs?: number;
  runsWaitMs?: number;
  /** Read-after-write lag (src/sandbox/repo.ts): how long a landed write may take to show, and how long an unproven "unchanged" must hold. */
  settleMs?: number;
  windowMs?: number;
  now?: () => number;
}

/** One phase against the sandbox. Throws only for a usage error or a refused target; check failures are in the summary. */
export async function runPhase(phase: Phase, sandbox: Sandbox, names: Names, epochPrefix: string, env: Env, deps: Deps = {}): Promise<Summary> {
  const refused = forbiddenTarget(sandbox, names);
  if (refused) throw new UsageError(`verify-sandbox never runs against the config's own repos: ${refused}`);
  const tokens = phaseTokens(phase, env);
  const log = deps.log ?? ((l: string) => console.log(l));
  const pn = { names, epochQueue: epochBranchFor({ epochPrefix }, "queue"), epochRelease: epochBranchFor({ epochPrefix }, "release") };
  const planned = plan(phase, pn);
  const rec = new Recorder(planned, log);
  const lags: NonNullable<ReadTiming["lags"]> = [];
  const read: ReadTiming = {
    lags,
    ...(deps.settleMs !== undefined ? { settleMs: deps.settleMs } : {}),
    ...(deps.windowMs !== undefined ? { windowMs: deps.windowMs } : {}),
    ...(deps.http?.sleep ? { sleep: deps.http.sleep } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };
  const o = { sandbox, names, epochQueue: pn.epochQueue, epochRelease: pn.epochRelease, read, ...(deps.http ? { http: deps.http } : {}), ...(deps.runsWaitMs !== undefined ? { runsWaitMs: deps.runsWaitMs } : {}), ...(deps.now ? { now: deps.now } : {}) };

  /** Each App token must reach exactly the sandbox; otherwise nothing more runs. */
  const scoped = async (id: string, token: string) =>
    (await rec.ok(id, () => tokenRepos({ ...(deps.http ?? {}), token }), async (repos) => ({
      evidence: { repos: repos.map((r) => r.id) },
      problems: repos.length === 1 && repos[0]!.id === sandbox.repoId ? [] : [`the token reaches ${JSON.stringify(repos.map((r) => r.fullName))}, not only the sandbox`],
    }))) !== undefined;

  try {
    switch (phase) {
      case "queue": {
        const queue = tokens.VERIFY_QUEUE_TOKEN!;
        const state = tokens.VERIFY_STATE_TOKEN!;
        if (!(await scoped("s1", queue)) || !(await scoped("s2", state))) throw new Abort("a token reaches more than the sandbox");
        const n = refNumbers(env.GITHUB_RUN_NUMBER, env.GITHUB_RUN_ATTEMPT);
        log(`verify-sandbox queue against ${sandbox.owner}/${sandbox.repo} (${sandbox.repoId}), batch numbers ${JSON.stringify(n)}`);
        await runG1({ sandbox, names, tokens: { queue, state }, n, read, ...(deps.http ? { http: deps.http } : {}), ...(deps.mergeWaitMs !== undefined ? { mergeWaitMs: deps.mergeWaitMs } : {}) }, rec);
        await h1Queue({ ...o, tokens: { queue, state }, n }, rec);
        break;
      }
      case "release": {
        const release = tokens.VERIFY_RELEASE_TOKEN!;
        if (!(await scoped("s1", release))) throw new Abort("the token reaches more than the sandbox");
        await h1Release({ ...o, tokens: { release } }, rec);
        break;
      }
      case "cross": {
        const queue = tokens.VERIFY_QUEUE_TOKEN!;
        if (!(await scoped("s1", queue))) throw new Abort("the token reaches more than the sandbox");
        await h1Cross({ ...o, tokens: { queue } }, rec);
        break;
      }
      case "admin": {
        const admin = tokens.VERIFY_ADMIN_TOKEN!;
        await h1Admin({ ...o, tokens: { admin }, pusher: (deps.pusher ?? gitPusher)(sandbox, admin) }, rec);
        break;
      }
    }
  } catch (e) {
    log(`${e instanceof Abort ? "ABORT" : "ERROR"}: ${describeError(e)}`);
  }
  // Every read that needed more than one try before it showed a write, and how long that took.
  if (lags.length > 0) log(`read-after-write lag: ${lags.length} read(s) lagged, longest ${Math.max(...lags.map((l) => l.ms))} ms: ${JSON.stringify(lags)}`);
  return { ...summarize(rec.checks, planned), lags };
}

/** The command: parse, load the config, run one phase, print the summary. Returns the exit code. */
export async function verifySandbox(args: string[], env: Env, deps: Deps = {}): Promise<number> {
  const log = deps.log ?? ((l: string) => console.log(l));
  try {
    const { phase, sandbox, config } = parseArgs(args);
    const c = loadConfig(config);
    const summary = await runPhase(phase, sandbox, c.config.names, c.config.runner.epochPrefix, env, deps);
    log(JSON.stringify({ phase, sandbox, ...summary }, null, 2));
    log(summary.ok ? `verify-sandbox ${phase}: every check passed` : `verify-sandbox ${phase}: FAILED (failed: ${summary.failed.join(", ") || "none"}; not run: ${summary.notRun.join(", ") || "none"}; unexpected: ${summary.unexpected.join(", ") || "none"})`);
    return summary.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      log(`verify-sandbox: ${e.message}`);
      log(USAGE);
      return 2;
    }
    if (e instanceof ConfigError) {
      log(`${e.source} is not a valid qlander config:`);
      for (const p of e.problems) log(`  ${p}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.main) process.exit(await verifySandbox(process.argv.slice(2), process.env));
