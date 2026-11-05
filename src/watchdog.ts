// The watchdog: `bun src/cli.ts watchdog`, run every 15 minutes by
// .github/workflows/watchdog.yml on a GitHub-hosted runner, so that it still
// runs when the CI hosts (and the qlander runner pools) are down.
//
// It reads only qlander, through the workflow's GITHUB_TOKEN (contents:
// read for the checkout, issues: write, actions: read): tick.yml's state,
// runs, jobs and job logs, and the issues. It holds no App key and decides
// nothing for the queue. It writes:
//   - one issue per alert kind, labelled `qlander-alert`: opened when the
//     condition starts (that notifies watchers), commented on only when the
//     detail changes materially, closed with a comment when it clears, and
//     left alone while its check is unknown;
//   - one status issue, labelled `qlander-status` and pinned, whose body
//     is rewritten (never commented on) every run.
//
// The checks and the alert lifecycle are pure (src/watchdog-core.ts), as is
// the rendering (src/watchdog-render.ts). This file wires them to a
// WatchdogApi: the real client (src/github/watchdog-client.ts) or a test fake.

import { readFileSync } from "node:fs";
import type { RepoName } from "./config";
import { CONFIG_PATH, ConfigError, loadConfig } from "./config/load";
import { QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "./job-names";
import {
  esc,
  type AlertAction,
  completions,
  type Evaluation,
  evaluate,
  type IssueInfo,
  isTickRun,
  type PinnedIssue,
  planStatus,
  type Level,
  level,
  planAlerts,
  ran,
  STATUS_TITLE,
  THRESHOLDS,
  type Thresholds,
  type TickJob,
  type TickRun,
  time,
} from "./watchdog-core";
import { unionListings } from "./github/issues";
import { extractTickReport, type IssueLabels, type JobReport, mainRedFrom, renderStatus, type StatusInput } from "./watchdog-render";

/** What the watchdog needs from GitHub. */
export interface WatchdogApi {
  /** tick.yml's workflow state ("active", "disabled_manually", ...). */
  workflowState(): Promise<string>;
  /** tick.yml's newest runs by creation (one page). */
  listRecentRuns(): Promise<TickRun[]>;
  /** Every unfinished tick.yml run (queued, in progress, waiting, pending, requested); truncated if the listing is incomplete. */
  listUnfinishedRuns(): Promise<{ runs: TickRun[]; truncated: boolean }>;
  /** A run's latest-attempt jobs. */
  listJobs(runId: number): Promise<TickJob[]>;
  /** A job's plain-text log. Throws if it is not readable. */
  jobLog(jobId: number): Promise<string>;
  /** Every open issue with the label, oldest first (a strongly consistent read); complete is false if it could not be read to the end. Throws if it could not be read. */
  listOpenIssues(label: string): Promise<{ issues: IssueInfo[]; complete: boolean }>;
  /** The repo's pinned issues, open or closed, with their labels. Throws if they could not be read. */
  listPinnedIssues(): Promise<PinnedIssue[]>;
  createIssue(title: string, body: string, labels: string[]): Promise<IssueInfo>;
  updateIssueBody(n: number, body: string): Promise<void>;
  comment(n: number, body: string): Promise<void>;
  closeIssue(n: number): Promise<void>;
  pinIssue(nodeId: string): Promise<void>;
  unpinIssue(nodeId: string): Promise<void>;
}

/** The most completed runs whose jobs are read in one watchdog run. */
export const MAX_JOB_FETCHES = 40;
/** The most unfinished runs whose jobs are read; beyond it the runner check is unknown. */
export const MAX_UNFINISHED_FETCHES = 20;

export interface WatchdogResult {
  level: Level;
  evaluation: Evaluation;
  actions: AlertAction[];
  /** The status issue written, or null when none could be found and creating one was not safe. */
  statusIssue: number | null;
  /** Things the run could not do, also shown in the status body when there is one. */
  notes: string[];
}

export interface WatchdogOptions {
  now: Date;
  runUrl: string;
  /** QLANDER_MODE, the repo variable. */
  modeVar: string | undefined;
  thresholds?: Thresholds;
  /** qlander.yml as the watchdog sees it; read from the file when absent. */
  config?: WatchdogConfig;
}

/**
 * What the watchdog needs from qlander.yml. It must keep monitoring the
 * ticks when the file is invalid (the ticks then fail, and that is exactly
 * when an alert matters), so it never imports the tick's eagerly loaded
 * config: it loads the file itself and turns a failure into an alert.
 */
export type WatchdogConfig =
  | { ok: true; control: RepoName; releaseDryRun: boolean; labels: IssueLabels; budget?: { window: number; windowHours: number }; mainBaseline?: boolean; assignees?: string[] }
  | { ok: false; reason: string; labels: IssueLabels };

/** Used only when qlander.yml is invalid and a label cannot be read from it at all. */
const FALLBACK_LABELS: IssueLabels = {
  controlLabels: { pause: "qlander:pause", mirror: "qlander:state" },
  releaseLabels: { pause: "qlander:release-pause", alert: "qlander:release-blocked", mirror: "qlander:release-state" },
  watchdogLabels: { alert: "qlander:alert", status: "qlander:status" },
};
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,49}$/;

/**
 * `a.b.c: value` for every block-style scalar line, by indentation, without a
 * YAML parser, so one broken line elsewhere does not hide the labels. A path
 * seen twice is dropped (ambiguous).
 */
function scalarPaths(text: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const stack: { indent: number; key: string }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").replace(/^\s*#.*$/, "");
    const m = /^( *)([A-Za-z][A-Za-z0-9_]*):(?:\s+(.*?))?\s*$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const path = [...stack.map((s) => s.key), m[2]!].join(".");
    const value = m[3];
    if (value === undefined || value === "") {
      stack.push({ indent, key: m[2]! });
      continue;
    }
    out.set(path, out.has(path) ? null : value.replace(/^"(.*)"$|^'(.*)'$/, "$1$2"));
  }
  return out;
}

/**
 * The labels an invalid file still names, read leniently (each must be a
 * plausible label at its usual place), so the watchdog keeps watching the
 * same issues while the ticks fail. If any is missing, or two collide (the
 * watchdog would then write to issues that are not its own, such as a pause
 * issue), every label falls back to FALLBACK_LABELS, which are distinct.
 * The fallbacks are guesses, so they must not be labels the file gives to
 * something else: if the file names any of them anywhere, this throws and the
 * watchdog run fails, visibly, without touching an issue.
 */
export function lenientLabels(text: string): IssueLabels {
  const paths = scalarPaths(text);
  let complete = true;
  const at = (path: string[], fallback: string): string => {
    const x = paths.get(path.join("."));
    if (typeof x === "string" && LABEL_RE.test(x)) return x;
    complete = false;
    return fallback;
  };
  const f = FALLBACK_LABELS;
  const read: IssueLabels = {
    controlLabels: { pause: at(["queue", "controlLabels", "pause"], f.controlLabels.pause), mirror: at(["queue", "controlLabels", "mirror"], f.controlLabels.mirror) },
    releaseLabels: {
      pause: at(["release", "labels", "pause"], f.releaseLabels.pause),
      alert: at(["release", "labels", "alert"], f.releaseLabels.alert),
      mirror: at(["release", "labels", "mirror"], f.releaseLabels.mirror),
    },
    watchdogLabels: { alert: at(["watchdog", "labels", "alert"], f.watchdogLabels.alert), status: at(["watchdog", "labels", "status"], f.watchdogLabels.status) },
  };
  const all = watchdogLabelSets(read).readLabels.map((l) => l.toLowerCase());
  if (complete && new Set(all).size === all.length) return read;
  const lower = text.toLowerCase();
  const taken = watchdogLabelSets(FALLBACK_LABELS).readLabels.filter((l) => lower.includes(l.toLowerCase()));
  if (taken.length) throw new Error(`qlander.yml is invalid and its labels cannot all be read, and the fallback labels ${taken.join(", ")} appear in it: refusing to guess which issues are the watchdog's`);
  return FALLBACK_LABELS;
}

export function readWatchdogConfig(path: string = CONFIG_PATH): WatchdogConfig {
  try {
    const { config, release, notify } = loadConfig(path);
    const n = config.names;
    return {
      ok: true,
      control: n.control,
      releaseDryRun: release.dryRun,
      labels: { controlLabels: n.controlLabels, releaseLabels: n.releaseLabels, watchdogLabels: n.watchdogLabels },
      budget: { window: config.windowBudget, windowHours: config.windowHours },
      mainBaseline: config.strategy?.mainBaseline === true,
      assignees: notify.assignees,
    };
  } catch (e) {
    let text = "";
    try {
      text = readFileSync(path, "utf8");
    } catch {
      text = "";
    }
    return { ok: false, reason: e instanceof ConfigError ? e.problems.join("; ") : String(e), labels: lenientLabels(text) };
  }
}

/** Every label the watchdog lists, and the two it writes. */
export function watchdogLabelSets(l: IssueLabels): { readLabels: string[]; writeLabels: string[] } {
  return {
    readLabels: [l.controlLabels.pause, l.releaseLabels.pause, l.releaseLabels.alert, l.controlLabels.mirror, l.releaseLabels.mirror, l.watchdogLabels.alert, l.watchdogLabels.status],
    writeLabels: [l.watchdogLabels.alert, l.watchdogLabels.status],
  };
}

/** Recent and unfinished runs, each once (the unfinished listing is the fresher copy). */
function merge(recent: TickRun[], unfinished: TickRun[]): TickRun[] {
  const by = new Map<number, TickRun>();
  for (const r of [...recent, ...unfinished]) by.set(r.id, { ...r });
  return [...by.values()];
}

/**
 * Read jobs: every unfinished tick run (up to a cap), the 5 newest runs for
 * the status, and completed runs in order of their last change until the
 * newest N queue-job completions are certain. A run whose last change is
 * older than the N-th completion cannot hold a newer one, so reading stops
 * there; if the budget runs out first, the completion checks are unknown.
 */
export async function readJobs(api: WatchdogApi, runs: TickRun[], t: Thresholds): Promise<{ jobsComplete: boolean; unfinishedRead: boolean }> {
  const ticks = runs.filter(isTickRun);
  const unfinished = ticks.filter((r) => r.status !== "completed");
  for (const r of unfinished.slice(0, MAX_UNFINISHED_FETCHES)) r.jobs = await api.listJobs(r.id);
  const shown = [...ticks].sort((a, b) => (time(b.createdAt) ?? Infinity) - (time(a.createdAt) ?? Infinity)).slice(0, 5);
  for (const r of shown) r.jobs ??= await api.listJobs(r.id);

  const changed = (r: TickRun) => time(r.updatedAt) ?? Infinity; // unknown: read it early
  const queue = ticks.filter((r) => r.status === "completed").sort((a, b) => changed(b) - changed(a));
  let fetched = 0;
  for (const r of queue) {
    const { done } = completions(runs);
    const nth = done[t.failingInARow - 1];
    if (nth && changed(r) < nth.at) return { jobsComplete: true, unfinishedRead: unfinished.length <= MAX_UNFINISHED_FETCHES };
    if (r.jobs) continue;
    if (fetched >= MAX_JOB_FETCHES) return { jobsComplete: false, unfinishedRead: unfinished.length <= MAX_UNFINISHED_FETCHES };
    r.jobs = await api.listJobs(r.id);
    fetched++;
  }
  return { jobsComplete: true, unfinishedRead: unfinished.length <= MAX_UNFINISHED_FETCHES };
}

/** The most recently completed tick's JSON reports, one per job that ran. */
async function newestReports(api: WatchdogApi, runs: TickRun[]): Promise<{ newest: StatusInput["newest"]; logsNote?: string }> {
  const latest = completions(runs).done[0];
  if (!latest) return { newest: null };
  const reports: JobReport[] = [];
  for (const name of [QUEUE_JOB_NAME, RELEASE_JOB_NAME]) {
    const job = latest.run.jobs?.find((j) => j.name === name);
    if (!job || !ran(job)) continue;
    let log: string;
    try {
      log = await api.jobLog(job.id);
    } catch (e) {
      return { newest: { run: latest.run, reports }, logsNote: `Job logs could not be read with this token (${String(e).slice(0, 160)}); open the run instead.` };
    }
    const report = extractTickReport(log);
    reports.push(report ? { job: name, report } : { job: name, report: null, note: `no JSON report in the log (the job ended ${job.conclusion})` });
  }
  return { newest: { run: latest.run, reports } };
}

export async function runWatchdog(api: WatchdogApi, opts: WatchdogOptions): Promise<WatchdogResult> {
  const { now } = opts;
  const t = opts.thresholds ?? THRESHOLDS;
  const config = opts.config ?? readWatchdogConfig();
  const L = config.labels;
  const [ALERT_LABEL, STATUS_LABEL] = [L.watchdogLabels.alert, L.watchdogLabels.status];
  const workflowState = await api.workflowState();
  const unfinished = await api.listUnfinishedRuns();
  const runs = merge(await api.listRecentRuns(), unfinished.runs);
  const { jobsComplete, unfinishedRead } = await readJobs(api, runs, t);
  const pauses = await api.listOpenIssues(L.controlLabels.pause);
  const releasePauses = await api.listOpenIssues(L.releaseLabels.pause);
  const [pause, releasePause] = [pauses.issues, releasePauses.issues];
  const releaseBlocked = (await api.listOpenIssues(L.releaseLabels.alert)).issues;
  const mirrors = await api.listOpenIssues(L.controlLabels.mirror);
  // A mirror that can't be found says nothing, so it never closes an open alert. With the key off there is nothing to find.
  const mainRed = mirrors.issues[0] ? mainRedFrom(mirrors.issues[0].body) : config.ok && config.mainBaseline ? "unreadable" : null;
  const evaluation = evaluate(
    { now, workflowState, runs, jobsComplete, unfinishedComplete: !unfinished.truncated && unfinishedRead, pause, releasePause, releaseBlocked, mainRed, pausesComplete: pauses.complete && releasePauses.complete, pauseLabels: { queue: L.controlLabels.pause, release: L.releaseLabels.pause } },
    t,
  );
  if (!config.ok) evaluation.alerts.push({ kind: "config-invalid", key: config.reason, detail: `config invalid: ${esc(config.reason, 1000)}` });
  const notes: string[] = [];

  // Alert issues: open on start, comment on a material change, close on clear,
  // keep while unknown. A create needs a complete listing, read twice.
  let alertRead = await api.listOpenIssues(ALERT_LABEL);
  let actions = planAlerts(evaluation.alerts, evaluation.unknown, alertRead.issues, now);
  if (actions.some((a) => a.kind === "create")) {
    alertRead = unionListings(alertRead, await api.listOpenIssues(ALERT_LABEL));
    actions = planAlerts(evaluation.alerts, evaluation.unknown, alertRead.issues, now);
  }
  if (!alertRead.complete) {
    // Nothing opens, comments or closes on a guess: an unseen issue may already cover a kind.
    actions = [];
    notes.push("The alert issues could not all be listed; none was opened, changed or closed this run.");
  }
  const closed = new Set(actions.flatMap((a) => (a.kind === "close" ? [a.number] : [])));
  const openAlerts = alertRead.issues.filter((i) => !closed.has(i.number));
  for (const a of actions) {
    if (a.kind === "create") {
      openAlerts.push(await api.createIssue(a.title, a.body, [ALERT_LABEL]));
    } else if (a.kind === "update") {
      await api.updateIssueBody(a.number, a.body);
      await api.comment(a.number, a.comment);
    } else {
      await api.comment(a.number, a.comment);
      await api.closeIssue(a.number);
    }
  }

  // The status issue: exactly one, pinned, its body rewritten every run.
  const { newest, logsNote } = await newestReports(api, runs);
  const queueMirror = mirrors.issues[0] ?? null;
  const releaseMirror = (await api.listOpenIssues(L.releaseLabels.mirror)).issues[0] ?? null;
  const pinned = await api.listPinnedIssues();
  let listed = await api.listOpenIssues(STATUS_LABEL);
  let plan = planStatus(listed, pinned, L.watchdogLabels);
  if (plan.create) {
    listed = unionListings(listed, await api.listOpenIssues(STATUS_LABEL));
    plan = planStatus(listed, pinned, L.watchdogLabels);
  }
  for (const extra of plan.close) {
    await api.comment(extra.number, `Duplicate of #${plan.keep!.number}: the watchdog keeps one status issue.`);
    await api.closeIssue(extra.number);
  }
  for (const id of plan.unpin) {
    try {
      await api.unpinIssue(id);
    } catch (e) {
      notes.push(`A closed status or alert issue could not be unpinned (${String(e).slice(0, 160)}); unpin it by hand.`);
    }
  }
  const status = plan.keep ?? (plan.create ? await api.createIssue(STATUS_TITLE, "Being written by the qlander watchdog.", [STATUS_LABEL]) : null);
  if (!status) {
    notes.push("No status issue was found and the listing was incomplete, so none was created.");
    return { level: level(evaluation), evaluation, actions, statusIssue: null, notes };
  }
  if (!pinned.some((p) => p.open && p.number === status.number)) {
    try {
      await api.pinIssue(status.nodeId);
    } catch (e) {
      notes.push(`The watchdog could not pin this issue (${String(e).slice(0, 160)}); pin it by hand.`);
    }
  }
  const pinNote = notes.length ? notes.join(" ") : undefined;
  const body = renderStatus({
    now,
    runUrl: opts.runUrl,
    modeVar: opts.modeVar,
    releaseHeldByConfig: config.ok ? config.releaseDryRun : null,
    evaluation,
    runs,
    newest,
    ...(logsNote ? { logsNote } : {}),
    queueMirror,
    ...(config.ok && config.budget ? { budget: config.budget } : {}),
    releaseMirror,
    openIssues: [
      ...pause.map((issue) => ({ label: L.controlLabels.pause, issue })),
      ...releasePause.map((issue) => ({ label: L.releaseLabels.pause, issue })),
      ...releaseBlocked.map((issue) => ({ label: L.releaseLabels.alert, issue })),
      ...openAlerts.map((issue) => ({ label: ALERT_LABEL, issue })),
    ],
    ...(pinNote ? { pinNote } : {}),
    labels: L,
  });
  await api.updateIssueBody(status.number, body);
  return { level: level(evaluation), evaluation, actions, statusIssue: status.number, notes };
}

/** One watchdog run, as the watchdog workflow runs it (`bun src/cli.ts watchdog`): the summary on stdout. */
export async function watchdogMain(env: Record<string, string | undefined> = process.env): Promise<void> {
  const { WatchdogClient } = await import("./github/watchdog-client");
  if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");
  const config = readWatchdogConfig();
  // An invalid config is reported as an alert; the repo then comes from the run itself (tick.yml and watchdog.yml run only in the control repo).
  const [owner = "", repo = ""] = (config.ok ? `${config.control.owner}/${config.control.name}` : (env.GITHUB_REPOSITORY ?? "")).split("/");
  const repoId = config.ok ? config.control.id : Number(env.GITHUB_REPOSITORY_ID);
  if (!Number.isSafeInteger(repoId) || repoId < 1 || !owner || !repo) throw new Error("qlander.yml is invalid and GITHUB_REPOSITORY or GITHUB_REPOSITORY_ID is not set");
  const api = await WatchdogClient.connect({ token: env.GITHUB_TOKEN, owner, repo, repoId, ...watchdogLabelSets(config.labels), assign: { labels: [config.labels.watchdogLabels.alert], logins: config.ok ? (config.assignees ?? []) : [] } });
  const runUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? `${owner}/${repo}`}/actions/runs/${env.GITHUB_RUN_ID ?? ""}`;
  const r = await runWatchdog(api, { now: new Date(), runUrl, modeVar: env.QLANDER_MODE || undefined, config });
  const e = r.evaluation;
  const summary = {
    level: r.level,
    alerts: e.alerts.map((a) => `${a.kind}: ${a.detail}`),
    unknown: e.unknown.map((u) => `${u.kind}: ${u.reason}`),
    warnings: e.warnings.map((w) => w.detail),
    evaluationNotes: e.notes,
    actions: r.actions.map((a) => `${a.kind}${"number" in a ? ` #${a.number}` : ""}`),
    statusIssue: r.statusIssue,
    notes: r.notes,
  };
  console.log(JSON.stringify(summary, null, 1));
}

// The entry point before src/cli.ts: `bun src/watchdog.ts` is `bun src/cli.ts watchdog`.
if (import.meta.main) await watchdogMain();
