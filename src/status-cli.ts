// `qlander status`: a read-only view of a live queue for its operators.
//
//   GH_TOKEN=$(gh auth token) bun src/status-cli.ts [--json] [--watch <seconds>] [--config <file>]
//
// It reads the sources listed in src/status.ts, projects them onto a Status
// and prints it: as text, or with --json as one JSON document (one per line
// under --watch). --watch re-reads and re-renders every N seconds (at least
// MIN_WATCH_SECONDS) until interrupted; a failed read is shown in the output
// and the loop goes on.
//
// Exit 0: a complete view, paused or not. Exit 2: a usage error. Exit 3:
// inconclusive, a read failed or came back incomplete (the view is still
// printed, with its problems), or no token, a bad config or no connection (no
// view). --watch never ends by itself, so its exit says nothing about reads; a
// failed start still exits 3.
//
// The token, config and sources come from the shared operator context
// (src/operator.ts). The token comes from GH_TOKEN, else GITHUB_TOKEN. It needs read access
// only: the control repo's contents (the state branches), issues and
// Actions, and the target's Actions and pull requests. The command makes
// only GET requests and GraphQL queries (POSTed to /graphql, never a
// mutation), and never prints the token: output is redacted.

import { resolve } from "node:path";
import { CONFIG_PATH } from "./config/load";
import { EXIT_INCONCLUSIVE, openOperator, type OperatorConfig, type OperatorDeps, type OperatorIo, type OperatorSources, readStateDocs, why } from "./operator";
import { type IssuesRead, projectStatus, prsToTitle, type Status, type StatusInput } from "./status";
import { renderStatusText } from "./status-render";
import { queueRef } from "./validate";

export const STATUS_USAGE = "usage: status [--json] [--watch <seconds>] [--config <file>]   (token: GH_TOKEN or GITHUB_TOKEN, read-only)";
export const MIN_WATCH_SECONDS = 10;
/** At most this many PR titles are read per pass (each is one request); titles are cached across --watch passes. */
export const MAX_TITLE_READS = 40;

/** A read's result, or its error in words. */
async function settle<T, R>(p: Promise<T>, ok: (x: T) => R): Promise<R | { error: string }> {
  try {
    return ok(await p);
  } catch (e) {
    return { error: why(e) };
  }
}

/**
 * Read every source once. Never throws: each failed read becomes an error in
 * the input, which the projection reports. `titles` caches PR titles across
 * passes (a title is display-only, so a stale one is harmless).
 */
export async function gatherStatus(
  src: OperatorSources,
  cfg: OperatorConfig,
  o: { serverUrl: string; now: () => Date; titles: Map<number, string>; releaseEnabled?: boolean },
): Promise<StatusInput> {
  const N = cfg.names;
  const { queue, release, serverTime } = await readStateDocs(src, N);
  const issues = (label: string): Promise<IssuesRead> => settle(src.control.listOpenIssues(label), (x) => x);
  const state = queue.kind === "ok" ? queue.state : null;
  const active = state?.active ?? null;
  const missing = state ? prsToTitle(state).filter((n) => !o.titles.has(n)).slice(0, MAX_TITLE_READS) : [];

  const [pause, releasePause, releaseBlocked, alert, tickWorkflow, ticks, batchRuns, ciSpans] = await Promise.all([
    issues(N.controlLabels.pause),
    issues(N.releaseLabels.pause),
    issues(N.releaseLabels.alert),
    issues(N.watchdogLabels.alert),
    settle(src.control.workflowState(), (state) => ({ state })),
    settle(src.control.listRecentRuns(), (runs) => ({ runs })),
    active
      ? settle(src.target.listRuns({ headSha: active.head, branch: queueRef(N, active.n), event: "push" }), (l) => ({ runs: l.items, truncated: l.truncated }))
      : Promise.resolve(undefined),
    active ? settle(src.recentQueueSpans(), (spans) => ({ spans })) : Promise.resolve({ spans: [] }),
    Promise.all(
      missing.map(async (n) => {
        try {
          const t = (await src.target.getPr(n)).title;
          if (typeof t === "string") o.titles.set(n, t);
        } catch {
          // display only: shown without a title
        }
      }),
    ),
  ]);

  const titles: Record<string, string> = {};
  for (const [n, t] of o.titles) titles[String(n)] = t;
  return {
    now: serverTime ?? o.now(),
    names: N,
    serverUrl: o.serverUrl,
    windowBudget: cfg.windowBudget,
    windowHours: cfg.windowHours,
    queue,
    release,
    ...(o.releaseEnabled === undefined ? {} : { releaseEnabled: o.releaseEnabled }),
    issues: { pause, releasePause, releaseBlocked, alert },
    tickWorkflow,
    ticks,
    ...(batchRuns ? { batchRuns } : {}),
    ciSpans,
    titles,
  };
}

export interface StatusDeps extends OperatorDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Stop --watch after this many passes (tests); unset: until interrupted. */
  maxPasses?: number;
}

/** --json, --watch <seconds> and --config <file>; anything else is a usage error (thrown as a string). */
export function parseStatusArgs(args: string[]): { json: boolean; watch: number | null; config: string } {
  let json = false;
  let watch: number | null = null;
  let config = CONFIG_PATH;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json" && !json) json = true;
    else if (a === "--watch" && watch === null) {
      const v = args[++i];
      if (!v || !/^[0-9]{1,6}$/.test(v)) throw `--watch needs a number of seconds`;
      watch = Math.max(MIN_WATCH_SECONDS, Number(v));
    } else if (a === "--config") {
      const v = args[++i];
      if (!v) throw "--config needs a file";
      config = resolve(v);
    } else throw `unexpected argument ${a}`;
  }
  return { json, watch, config };
}

const CLEAR = "\x1b[H\x1b[2J";

/** Run `status`; resolves to the exit code (see the top of this file). */
export async function statusCommand(args: string[], io: OperatorIo, deps: StatusDeps): Promise<number> {
  let opts: ReturnType<typeof parseStatusArgs>;
  try {
    opts = parseStatusArgs(args);
  } catch (e) {
    io.err(String(e));
    io.err(STATUS_USAGE);
    return 2;
  }
  const opened = await openOperator(opts.config, io, deps);
  if (typeof opened === "number") return EXIT_INCONCLUSIVE;
  const { cfg, src, releaseEnabled } = opened;
  io = opened.io;
  const serverUrl = deps.env.GITHUB_SERVER_URL || "https://github.com";
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const titles = new Map<number, string>();
  for (let pass = 1; ; pass++) {
    const status: Status = projectStatus(await gatherStatus(src, cfg, { serverUrl, now, titles, releaseEnabled }));
    if (opts.json) io.out(`${opts.watch === null ? JSON.stringify(status, null, 1) : JSON.stringify(status)}\n`);
    else io.out(`${opts.watch === null ? "" : CLEAR}${renderStatusText(status)}`);
    if (opts.watch === null) return status.complete ? 0 : EXIT_INCONCLUSIVE;
    if (deps.maxPasses !== undefined && pass >= deps.maxPasses) return 0;
    await sleep(opts.watch * 1000);
  }
}

if (import.meta.main) {
  process.exitCode = await statusCommand(process.argv.slice(2), { out: (t) => process.stdout.write(t), err: (l) => console.error(l) }, { env: process.env });
}
