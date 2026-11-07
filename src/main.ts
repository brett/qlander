// One tick of a job: `bun src/cli.ts tick queue|release` (src/cli.ts), each
// run by its own job in the tick workflow with timeout-minutes = that job's
// jobTimeoutMinutes. `bun src/main.ts queue|release` still works. It
// validates the event, makes a run id unique to this execution, connects the
// clients and runs one tick.
//
// Mode (DESIGN.md §14 G3): a job is live only when QLANDER_MODE is
// exactly "live" (the repo variable); the release job is also held in dry run
// by ReleaseConfig.dryRun until its own enablement (G4). Otherwise it is a dry
// run: it reads the state and GitHub, decides, and prints what it would do.
// The target is reached through a read-only client, and nothing anywhere is
// written: no lease, no state, no issue.
//
// Credentials come from the environment, never from the target repo. The two
// App token variables are named by qlander.yml `tokens` (absent:
// TARGET_TOKEN and TARGET_RELEASE_TOKEN):
//   tokens.queue          the queue App's installation token (queue-write environment)
//   tokens.release        the release App's installation token (release-write environment)
//   STATE_TOKEN           the state App's token (control-repo contents only): the
//                         only identity that can move either state branch
//   GITHUB_TOKEN          the workflow token (control-repo issues, Actions reads)
// Every repo, branch and label comes from qlander.yml (Config.names).
// Each job refuses to start if it can see the other App's token (DESIGN.md §12.1).

import { appendFileSync, readFileSync } from "node:fs";
import { type Config, defaultCloseLinkedIssues, defaultComments, defaultConfig, defaultHooks, defaultNotify, epochBranchFor, type Names } from "./config";
import type { AssignOn } from "./github/http";
import type { TargetApi, StateRefApi, StateRepoApi } from "./github/api";
import { TargetClient } from "./github/target";
import { StateRefClient } from "./github/state-ref";
import { defaultReleaseConfig, QUEUE_TOKEN_ENV, type ReleaseConfig } from "./release-config";
import { releaseDryRun, type ReleaseDryRun, releaseTick, type ReleaseResult } from "./release-runner";
import { StateRepoClient } from "./github/state-repo";
import type { Verdict } from "./ctx";
import { decide } from "./machine";
import { makeRunId, policyHash, tick, type TickResult } from "./queue";
import { buildSnapshot } from "./snapshot";
import { emptyState, type Executor, parseState, type Op } from "./state";
import { inspectState, queueCodec } from "./store";
import { enqueueHooks } from "./hooks";
import { parseEvent } from "./validate";
import { pauseReason } from "./outbox";
import { FLAKY_LABEL } from "./flaky";
import { QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "./job-names";
import { afterTick, type ChainApi } from "./wake";

/** When this process started: the self-chaining watch is bounded from here (src/wake.ts). */
const STARTED_AT = Date.now();

export interface Clients {
  target: TargetApi;
  repo: StateRepoApi;
  stateRef: StateRefApi;
  /** The queue job's tick dispatch (DESIGN.md §11.1); absent for the release job. */
  chain?: ChainApi;
}

export type Env = Record<string, string | undefined>;

/** The control repo's issue labels the queue and release jobs list or create with (StateRepoClient's allowlist). */
export function stateRepoLabels(n: Names): string[] {
  return [n.controlLabels.mirror, n.releaseLabels.mirror, n.controlLabels.pause, n.releaseLabels.alert, n.releaseLabels.pause, FLAKY_LABEL];
}

/** A pause issue a job opens is assigned to `notify.assignees`, which is what makes GitHub tell them. */
function pauseAssign(n: Names): AssignOn {
  return { labels: [n.controlLabels.pause, n.releaseLabels.pause], logins: defaultNotify.assignees };
}

/** Connection options shared by the three clients of one job. */
function connectOptions(n: Names, dataFiles: string[], fetchFn: typeof fetch | undefined) {
  const f = fetchFn ? { fetch: fetchFn } : {};
  return {
    control: { owner: n.control.owner, repo: n.control.name, repoId: n.control.id, ...f },
    target: { owner: n.target.owner, repo: n.target.name, repoId: n.target.id, names: n, dataFiles, ...f },
    stateBranches: [n.stateBranch, n.releaseStateBranch],
  };
}

/** Each job sees only its own App's key: a job that can see the other's refuses to start. */
export function assertOwnKeyOnly(env: Env, job: "queue" | "release"): void {
  const other = job === "queue" ? defaultReleaseConfig.tokenEnv : QUEUE_TOKEN_ENV;
  if (env[other]) throw new Error(`refusing to run the ${job} job: ${other} (the other App's key) is in its environment`);
}

export async function connectClients(env: Env, role: "queue" | "read" = "queue", fetchFn?: typeof fetch): Promise<Clients> {
  assertOwnKeyOnly(env, "queue");
  const token = env[QUEUE_TOKEN_ENV];
  const state = env.STATE_TOKEN;
  const own = env.GITHUB_TOKEN;
  if (!token || !state || !own) throw new Error(`${QUEUE_TOKEN_ENV}, STATE_TOKEN and GITHUB_TOKEN are required`);
  const n = defaultConfig.names;
  const o = connectOptions(n, [], fetchFn); // the queue reads no target file
  const repo = await StateRepoClient.connect({ token: own, ...o.control, labels: stateRepoLabels(n), assign: pauseAssign(n) });
  return {
    // The epoch branch only for a writing client with the fence on (docs/deployment.md §3.4).
    target: await TargetClient.connect({ token, ...o.target, role, epochBranch: role === "queue" && defaultConfig.runner.epochFence ? epochBranchFor(defaultConfig.runner, "queue") : null }),
    repo,
    stateRef: await StateRefClient.connect({ token: state, ...o.control, branch: n.stateBranch, stateBranches: o.stateBranches }),
    chain: repo,
  };
}

/** The release job's clients: the release App's key only (read-only in dry run), and its own state branch, written with STATE_TOKEN. */
export async function connectReleaseClients(env: Env, cfg: ReleaseConfig = defaultReleaseConfig, role: "release" | "read" = "release", fetchFn?: typeof fetch): Promise<Clients> {
  assertOwnKeyOnly(env, "release");
  const token = env[cfg.tokenEnv];
  const state = env.STATE_TOKEN;
  const own = env.GITHUB_TOKEN;
  if (!token || !state || !own) throw new Error(`${cfg.tokenEnv}, STATE_TOKEN and GITHUB_TOKEN are required`);
  const n = cfg.names;
  // The only target file the release job reads: a target-hosted qualification manifest.
  const q = cfg.qualification;
  const o = connectOptions(n, q.provider === "manifest" && q.source === "target" ? [q.path] : [], fetchFn);
  const writing = role === "release" && !cfg.dryRun;
  // release.mode dispatch: a client that writes no ref at all and may dispatch only the configured workflow (DESIGN.md §8.1).
  const d = cfg.mode === "dispatch" ? cfg.dispatch : null;
  return {
    target: await TargetClient.connect({
      token,
      ...o.target,
      role: !writing ? "read" : d ? "dispatch" : "release",
      epochBranch: writing && cfg.runner.epochFence ? epochBranchFor(cfg.runner, "release") : null,
      dispatch: writing && d ? { workflow: d.workflow, ref: d.ref, inputs: [d.inputs.sha, d.inputs.dryRun, d.inputs.dispatchId] } : null,
    }),
    // In dispatch mode the job also lists the status issue, where it reports a candidate and reads approvals.
    repo: await StateRepoClient.connect({ token: own, ...o.control, labels: [...stateRepoLabels(n), ...(d ? [n.watchdogLabels.status] : [])], assign: pauseAssign(n) }),
    stateRef: await StateRefClient.connect({ token: state, ...o.control, branch: n.releaseStateBranch, stateBranches: o.stateBranches }),
  };
}

export { QUEUE_JOB_NAME, RELEASE_JOB_NAME };

/** This execution's Actions job, from the runner environment, or null outside Actions. */
export function executorFromEnv(env: Env, job: string = QUEUE_JOB_NAME): Executor | null {
  const runId = Number(env.GITHUB_RUN_ID);
  const attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(attempt) || attempt < 1) return null;
  return { runId, attempt, job };
}

/** One queue tick for this execution; `after` runs once the tick has released its lease (self-chaining). */
export async function runQueue(
  env: Env,
  eventPayload: unknown,
  connect: (env: Env) => Promise<Clients> = connectClients,
  after?: (result: TickResult, clients: Clients) => Promise<void>,
): Promise<TickResult> {
  assertOwnKeyOnly(env, "queue");
  const cfg = defaultConfig;
  parseEvent(env.GITHUB_EVENT_NAME ?? "", eventPayload, cfg.names.control.id); // commands are PR labels, read by the tick
  const runId = makeRunId(env); // unique per execution: never shared by two runners
  const executor = executorFromEnv(env);
  if (!executor) throw new Error("refusing to run live outside Actions: GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required");
  const clients = await connect(env);
  const result = await tick({ ...clients, cfg, hooks: defaultHooks, comments: defaultComments, closeLinkedIssues: defaultCloseLinkedIssues, now: () => new Date(), runId, executor });
  await after?.(result, clients);
  return result;
}

/**
 * Print the tick's report first (the watchdog reads the last JSON block, and
 * a job killed during the watch still has it), then chain (src/wake.ts).
 */
export async function reportAndChain(result: TickResult, clients: Clients, startedAt = STARTED_AT): Promise<void> {
  console.log(JSON.stringify(result, null, 1));
  if (!clients.chain) return;
  for (const line of await afterTick(result.wake, { target: clients.target, chain: clients.chain, cfg: defaultConfig, startedAt })) console.log(line);
}

export interface DryRun {
  mode: "dry-run";
  /** A live run would refuse to initialise (and pause) for this reason. */
  refused?: string;
  log: string[];
  /** Whether a live tick would stop here: an open pause issue, a pending pause, a listing it could not trust, or a pause this decision would raise. Absent when it stopped before reading them (refused). */
  paused?: boolean;
  /** The op a live tick would journal and perform next, if any. */
  wouldDo: Op | null;
  /** As TickResult.readyListed and .ignored: what the decision saw, and every ready PR it would not admit. */
  readyListed?: number[];
  ignored?: Verdict[];
}

/**
 * The dry run: read state and GitHub, decide, report. No lease, no state
 * write, no target write (the target client is read-only and refuses writes).
 */
export async function runDry(
  env: Env,
  eventPayload: unknown,
  connect: (env: Env, role: "read") => Promise<Clients> = connectClients,
  cfg: Config = defaultConfig,
): Promise<DryRun> {
  parseEvent(env.GITHUB_EVENT_NAME ?? "", eventPayload, cfg.names.control.id);
  const { target, repo, stateRef } = await connect(env, "read");
  const seen = await inspectState(stateRef, repo, queueCodec(cfg.names)); // the same check a live run makes
  if (!seen.ok) return { mode: "dry-run", refused: seen.reason, log: [`a live tick would pause: ${seen.reason}`], wouldDo: null };
  const state = seen.read ? parseState(seen.read.text, cfg.names) : emptyState();
  // Fails closed, as a live tick does: an unreadable or incomplete pause listing counts as paused.
  const paused = state.outbox.some((n) => n.kind === "pause") || (await pauseReason(repo, cfg.names.controlLabels.pause)) !== null;
  if (state.journal) return { mode: "dry-run", paused, log: [`a journalled ${state.journal.op.kind} is outstanding; a live tick would recover it first`], wouldDo: state.journal.op };
  const snap = await buildSnapshot({ api: target, cfg, state, now: new Date(), paused, policyHash: policyHash(cfg) });
  const d = decide(state, snap, cfg);
  const hooks = enqueueHooks(state, d.events, defaultHooks, new Date()).log.map((l) => l.replace(/^hook: queued /, "hook (dry run): would queue "));
  return {
    mode: "dry-run",
    paused: paused || d.state.outbox.some((n) => n.kind === "pause"),
    log: [...d.log, ...hooks],
    wouldDo: d.state.journal?.op ?? null,
    ...(snap.readyListed ? { readyListed: snap.readyListed } : {}),
    ...(d.ignored ? { ignored: d.ignored } : {}),
  };
}

export const isLive = (env: Env) => env.QLANDER_MODE === "live";

/** The release job acts only when QLANDER_MODE is "live" and release advance is enabled and not held by its own config. */
export const isReleaseLive = (env: Env, cfg: ReleaseConfig = defaultReleaseConfig) => isLive(env) && cfg.enabled && !cfg.dryRun;

function releaseEvent(env: Env, eventPayload: unknown, cfg: ReleaseConfig): void {
  assertOwnKeyOnly(env, "release");
  parseEvent(env.GITHUB_EVENT_NAME ?? "", eventPayload, cfg.names.control.id);
}

/** One live release-advance tick for this execution (DESIGN.md §8). Only a plain tick is accepted. */
export async function runRelease(
  env: Env,
  eventPayload: unknown,
  connect: (env: Env) => Promise<Clients> = (e) => connectReleaseClients(e),
  cfg: ReleaseConfig = defaultReleaseConfig,
): Promise<ReleaseResult> {
  releaseEvent(env, eventPayload, cfg);
  const runId = makeRunId(env);
  const executor = executorFromEnv(env, RELEASE_JOB_NAME);
  if (!executor) throw new Error("refusing to run live outside Actions: GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT are required");
  const clients = await connect(env);
  return releaseTick({ ...clients, cfg, now: () => new Date(), runId, executor });
}

/** The release dry run: the same reads and decision with a read-only target client; nothing is written. */
export async function runReleaseDry(
  env: Env,
  eventPayload: unknown,
  connect: (env: Env) => Promise<Clients> = (e) => connectReleaseClients(e, defaultReleaseConfig, "read"),
  cfg: ReleaseConfig = defaultReleaseConfig,
): Promise<ReleaseDryRun> {
  releaseEvent(env, eventPayload, cfg);
  // Not enabled (release.enabled absent or false): nothing is read or written.
  if (!cfg.enabled) return { mode: "dry-run", log: ["release advance is not enabled (release.enabled)"], decision: null };
  return releaseDryRun({ ...(await connect(env)), cfg });
}

/** What the rendered workflow's later steps read from this tick: only the request for a Contents: write token. */
export function writeTickOutputs(result: object, env: Env): void {
  if ("needsContentsWrite" in result && result.needsContentsWrite === true && env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, "needs-contents-write=true\n");
}

/**
 * One tick of `job` for this execution, as the tick workflow runs it
 * (`bun src/cli.ts tick queue|release`): the event payload from
 * GITHUB_EVENT_PATH, live or dry by QLANDER_MODE, the report on stdout.
 */
export async function runTickJob(job: "queue" | "release", env: Env = process.env): Promise<void> {
  const path = env.GITHUB_EVENT_PATH;
  const payload = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  if (job === "queue" && isLive(env)) {
    await runQueue(env, payload, connectClients, reportAndChain); // prints its own report
    process.exit(0); // a request the chain abandoned at its deadline must not hold the job open
  } else {
    const result =
      job === "queue" ? await runDry(env, payload) : isReleaseLive(env) ? await runRelease(env, payload) : await runReleaseDry(env, payload);
    console.log(JSON.stringify(result, null, 1));
    writeTickOutputs(result, env);
  }
}

// The entry point before src/cli.ts: `bun src/main.ts queue|release` is `bun src/cli.ts tick queue|release`.
if (import.meta.main) {
  const job = process.argv[2];
  if (job !== "queue" && job !== "release") {
    console.error("usage: bun src/main.ts queue|release (or bun src/cli.ts tick queue|release)");
    process.exit(2);
  }
  await runTickJob(job);
}
