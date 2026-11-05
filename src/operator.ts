// The operator's read context, shared by the operator commands in src/cli.ts
// (today `status`, src/status-cli.ts). It holds what every such command does
// before it acts: take the token from the environment, load the config,
// connect the read-only sources (src/github/operator-client.ts), and read the
// two state documents with the tick's own strict parsers.
//
// The commands that change something (pause, resume, quiesce, requeue, ...:
// src/control.ts) share the token and config loading here, and do their
// writes through a separate client of their own
// (src/github/control-client.ts), which the read context never holds.
// Nothing here writes.

import type { StateRefApi, TargetApi } from "./github/api";
import type { HttpOptions } from "./github/http";
import type { Config, Names } from "./config";
import { ConfigError, loadConfig } from "./config/load";
import type { ReleaseConfig } from "./release-config";
import { parseReleaseState, type ReleaseState } from "./release-state";
import { parseState, type State } from "./state";
import type { CiSpan, DocRead } from "./status";
import type { WatchdogApi } from "./watchdog";

/** What the operator commands read. The real ones are in src/github/operator-client.ts; tests pass fakes. */
export interface OperatorSources {
  queueState: Pick<StateRefApi, "read">;
  releaseState: Pick<StateRefApi, "read">;
  control: Pick<WatchdogApi, "workflowState" | "listRecentRuns" | "listOpenIssues">;
  target: Pick<TargetApi, "listRuns" | "getPr">;
  /** Recent successful CI runs on queue refs (for the usual batch duration). */
  recentQueueSpans(): Promise<CiSpan[]>;
}

export type OperatorConfig = Pick<Config, "names" | "preLanding" | "windowBudget" | "windowHours">;

export interface OperatorIo {
  out(text: string): void;
  err(line: string): void;
}

export interface OperatorDeps {
  env: Record<string, string | undefined>;
  /** Builds the sources from the config and token (default: the real read-only clients). */
  connect?: (cfg: OperatorConfig, http: HttpOptions) => Promise<OperatorSources>;
}

/** An error in words, for output (never thrown on). */
export const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/**
 * The token (GH_TOKEN, else GITHUB_TOKEN) and the full config at
 * `configPath`; or the exit code after saying why not (1). The returned io
 * redacts the token from everything printed, whatever an error quotes back.
 * `redact` removes the token from text posted anywhere else. `need` names what the token must be able to do, for the missing-token message.
 */
/** `status` and `audit` could not get an answer: distinct from 1 (checked and failed) and 2 (usage). */
export const EXIT_INCONCLUSIVE = 3;

export function openTokenAndConfig(
  configPath: string,
  io: OperatorIo,
  env: Record<string, string | undefined>,
  need = "a read-only token",
): { config: Config; release: ReleaseConfig; http: HttpOptions; io: OperatorIo; redact: (t: string) => string } | number {
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) {
    io.err(`this command needs ${need} in GH_TOKEN or GITHUB_TOKEN, for example: GH_TOKEN=$(gh auth token)`);
    return 1;
  }
  if (!/^[\x21-\x7e]+$/.test(token)) {
    io.err("the token in GH_TOKEN or GITHUB_TOKEN has whitespace or control characters in it; set it again, for example: GH_TOKEN=$(gh auth token)");
    return 1;
  }
  const redact = (t: string) => (token.length >= 8 ? t.split(token).join("[token]") : t); // a real token is far longer
  const safe: OperatorIo = { out: (t) => io.out(redact(t)), err: (l) => io.err(redact(l)) };
  try {
    const loaded = loadConfig(configPath);
    return { config: loaded.config, release: loaded.release, http: { token, ...(env.GITHUB_API_URL ? { baseUrl: env.GITHUB_API_URL } : {}) }, io: safe, redact };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    safe.err(`${e.source} is not a valid qlander config:`);
    for (const p of e.problems) safe.err(`  ${p}`);
    return 1;
  }
}

/**
 * The token, the config at `configPath` and the connected read-only sources;
 * or the exit code after saying why not (1), as openTokenAndConfig.
 */
export async function openOperator(
  configPath: string,
  io: OperatorIo,
  deps: OperatorDeps,
): Promise<{ cfg: OperatorConfig; src: OperatorSources; io: OperatorIo; releaseEnabled: boolean } | number> {
  const opened = openTokenAndConfig(configPath, io, deps.env);
  if (typeof opened === "number") return opened;
  const { config: cfg, release, http, io: safe } = opened;
  const connect = deps.connect ?? (async (c, h) => (await import("./github/operator-client")).connectOperatorSources(c, h));
  try {
    const src = await connect(cfg, http);
    return { cfg, src, io: safe, releaseEnabled: release.enabled };
  } catch (e) {
    safe.err(`could not connect: ${why(e)}`);
    return 1;
  }
}

/** One state document: parsed, absent, corrupt or unreadable, with GitHub's clock at the read. Never throws. */
export async function readDoc<S>(ref: Pick<StateRefApi, "read">, parse: (text: string) => S): Promise<{ doc: DocRead<S>; serverTime: Date | null }> {
  let r: Awaited<ReturnType<StateRefApi["read"]>>;
  try {
    r = await ref.read();
  } catch (e) {
    return { doc: { kind: "error", reason: why(e) }, serverTime: null };
  }
  if (r === null) return { doc: { kind: "absent" }, serverTime: null };
  try {
    return { doc: { kind: "ok", state: parse(r.text), version: r.version }, serverTime: r.serverTime };
  } catch (e) {
    return { doc: { kind: "corrupt", reason: why(e) }, serverTime: r.serverTime };
  }
}

/** Both state documents, read together, with the tick's own parsers. */
export async function readStateDocs(
  src: Pick<OperatorSources, "queueState" | "releaseState">,
  names: Names,
): Promise<{ queue: DocRead<State>; release: DocRead<ReleaseState>; serverTime: Date | null }> {
  const [queue, release] = await Promise.all([readDoc<State>(src.queueState, (t) => parseState(t, names)), readDoc<ReleaseState>(src.releaseState, parseReleaseState)]);
  return { queue: queue.doc, release: release.doc, serverTime: queue.serverTime };
}
