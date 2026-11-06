// The watchdog's pure text work (src/watchdog.ts runs it): reading the JSON
// report a tick prints into its job log, summarising the state mirror
// issues, and rendering the pinned status issue's body. No I/O.
//
// Mirror bodies and tick reports are untrusted: every field is type-checked
// (a wrong type shows as "?") and every piece of text goes through esc(),
// code() or fenced() before it reaches Markdown.

import { QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "./job-names";
import type { Names } from "./config";
import { ALERT_TITLES, code, esc, type Evaluation, fenced, humanAge, type IssueInfo, isTickRun, level, ran, safeUrl, stamp, time, type TickRun } from "./watchdog-core";

/** A job log line without its Actions timestamp prefix. */
const untimed = (line: string) => line.replace(/^﻿?\d{4}-\d\d-\d\dT[0-9:.]+Z ?/, "");

/**
 * The JSON report the tick prints last (src/main.ts: JSON.stringify(result,
 * null, 1)): the last line that is exactly "{" up to the next line that is
 * exactly "}". Null if there is none or it does not parse.
 */
export function extractTickReport(log: string): Record<string, unknown> | null {
  const lines = log.split(/\r?\n/).map(untimed);
  for (let start = lines.length - 1; start >= 0; start--) {
    if (lines[start] !== "{") continue;
    const end = lines.indexOf("}", start + 1);
    if (end < 0) continue;
    try {
      const v = JSON.parse(lines.slice(start, end + 1).join("\n"));
      if (isObj(v)) return v;
    } catch {
      // keep looking further up
    }
  }
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const obj = (x: unknown): Obj | null => (isObj(x) ? x : null);
const int = (x: unknown): string => (Number.isSafeInteger(x) ? String(x) : "?");
const str = (x: unknown, max = 120): string => (typeof x === "string" ? esc(x, max) : "?");
const count = (x: unknown): string => (Array.isArray(x) ? String(x.length) : "?");
const sha = (x: unknown): string => (typeof x === "string" && /^[0-9a-f]{7,40}$/.test(x) ? x.slice(0, 7) : "?");
const when = (x: unknown): string => (typeof x === "string" && time(x) !== null ? esc(x, 30) : x === null ? "never" : "?");

/** The fenced JSON block of a mirror issue (queue: ```json qlander-state, release: ```json). */
export function mirrorJson(body: string): Obj | null {
  const m = /```json[^\n]*\n([\s\S]*?)\n```/.exec(body);
  if (!m) return null;
  try {
    return obj(JSON.parse(m[1]!));
  } catch {
    return null;
  }
}

/**
 * The weekly flaky figure from the mirror's `flakes` (batches whose single
 * rerun passed, src/flaky.ts): failures and batches in the last 7 days, and
 * the most frequent key. Absent `flakes` (state from before flaky tracking,
 * or no flake yet) reads as none.
 */
export function flakySummary(flakes: unknown, now: Date): string {
  if (flakes !== undefined && !Array.isArray(flakes)) return "flaky tests, last 7 days: ?";
  const since = now.getTime() - 7 * 86_400_000;
  const recent = (flakes ?? []).map(obj).filter((f): f is Obj => f !== null && typeof f.at === "string" && (time(f.at) ?? 0) > since);
  const keys = recent.flatMap((f) => (Array.isArray(f.keys) ? f.keys.filter((k): k is string => typeof k === "string") : []));
  const total = recent.reduce((t, f) => t + (Number.isSafeInteger(f.count) ? (f.count as number) : 0), 0);
  if (recent.length === 0) return "flaky tests, last 7 days: none";
  const tally = new Map<string, number>();
  for (const k of keys) tally.set(k, (tally.get(k) ?? 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const topText = top ? ` · most often ${code(top[0], 120)} (${top[1]}×)` : "";
  return `flaky tests, last 7 days: ${total} in ${recent.length} batch${recent.length === 1 ? "" : "es"}${topText} · open \`flaky\` issues track each one`;
}

/** The status issue warns at this share of the rolling window budget. */
export const WINDOW_WARN_SHARE = 0.75;

/** What the mirror says about main (queue.strategy.mainBaseline): null when nothing. */
export function mainRedFrom(body: string): { base: string; failing: string[]; held: number[] } | "unreadable" | null {
  const s = mirrorJson(body);
  if (!s) return "unreadable";
  const b = obj(s.baseline);
  const r = obj(b?.result);
  const held = Array.isArray(b?.held) ? b.held.flatMap((h) => (Number.isSafeInteger(obj(h)?.pr) ? [obj(h)!.pr as number] : [])) : [];
  if (r?.red !== true || held.length === 0) return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  const tests = list(r.tests);
  return { base: str(b!.base, 40), failing: tests.length > 0 ? tests : list(r.jobs), held };
}

export function summariseQueueState(body: string, budget?: { window: number; windowHours: number; now: Date }): string[] {
  const s = mirrorJson(body);
  if (!s) return ["(the mirror has no readable state block)"];
  const a = obj(s.active);
  const prs = Array.isArray(a?.prs) ? a.prs.map((p) => `PR ${int(p)}`).join(", ") : "?";
  const out = [a ? `seq ${int(s.seq)} · batch ${int(a.n)} (${prs}) ${str(a.phase, 30)}` : `seq ${int(s.seq)} · ${s.active === null ? "no active batch" : "active batch ?"}`];
  if (Array.isArray(s.concurrent) && s.concurrent.length > 0) out.push(`also running: ${s.concurrent.map((b) => `batch ${int(obj(b)?.n)}`).join(", ")}`);
  const auth = obj(s.auth);
  out.push(`pending ${count(s.pending)} · solo ${count(s.solo)} · admitted ${auth ? Object.keys(auth).length : "?"} · verifying ${count(s.verify)}`);
  if (s.journal !== null && s.journal !== undefined) out.push(`journal: ${str(obj(obj(s.journal)?.op)?.kind, 30)}`);
  const b = obj(s.baseline);
  if (b) out.push(`main with no PR in it: batch ${int(b.n)} at ${str(b.base, 40)} is ${obj(b.result)?.red === true ? "red" : "running"} · held PRs ${count(b.held)}`);
  out.push(`last landed ${when(s.lastLandedAt)} · red streak ${int(s.redStreak)} · bounce streak ${int(s.bounceStreak)}`);
  if (budget !== undefined) out.push(flakySummary(s.flakes, budget.now));
  if (budget !== undefined && Array.isArray(s.window)) {
    // The queue's own accounting: only reservations inside the rolling window count (machine.ts pruneWindow).
    const cutoff = budget.now.getTime() - budget.windowHours * 3_600_000;
    const used = s.window.reduce((n: number, w) => {
      const e = obj(w);
      const at = typeof e?.at === "string" ? Date.parse(e.at) : Number.NaN;
      return n + (Number.isSafeInteger(e?.cost) && at > cutoff ? (e!.cost as number) : 0);
    }, 0);
    const windowBudget = budget.window;
    const warn = used >= WINDOW_WARN_SHARE * windowBudget;
    out.push(`${warn ? "**warning:** " : ""}window budget: ${used} of ${windowBudget} full-suite runs used${warn ? ` (at or above ${WINDOW_WARN_SHARE * 100}%; the queue pauses at the limit)` : ""}`);
  }
  out.push(...summariseHooks(s.hooks, budget?.now));
  return out;
}

/** Hook deliveries failed within this long show as a warning (docs/hooks.md). */
export const HOOK_FAILURE_HOURS = 24;

/** Lifecycle hook deliveries (src/hooks.ts): how many wait, and recent failures. Nothing when no hook has fired. */
export function summariseHooks(x: unknown, now?: Date): string[] {
  const h = obj(x);
  if (!h) return [];
  const out: string[] = [];
  const waiting = Array.isArray(h.outbox) ? h.outbox.length : 0;
  if (waiting > 0) out.push(`hook deliveries waiting: ${waiting}`);
  const cutoff = now ? now.getTime() - HOOK_FAILURE_HOURS * 3_600_000 : Number.NEGATIVE_INFINITY;
  const recent = (Array.isArray(h.failed) ? h.failed : []).map(obj).filter((f): f is Obj => f !== null && typeof f.at === "string" && Date.parse(f.at) > cutoff);
  const last = recent.at(-1);
  if (last) {
    out.push(
      `**warning:** ${recent.length} hook ${recent.length === 1 ? "delivery" : "deliveries"} failed in the last ${HOOK_FAILURE_HOURS}h; latest: ${str(last.event, 30)} as ${str(last.eventType, 100)} at ${when(last.at)}: ${str(last.error, 200)}`,
    );
  }
  return out;
}

export function summariseReleaseState(body: string): string[] {
  const s = mirrorJson(body);
  if (!s) return ["(the mirror has no readable state block)"];
  const l = obj(s.last);
  const out = [l ? `seq ${int(s.seq)} · last check ${str(l.kind, 20)} at ${when(l.at)}: ${str(l.reason, 160)}` : `seq ${int(s.seq)} · no check recorded`];
  const j = obj(s.journal);
  if (j) out.push(j.op === "dispatch" ? `journal: dispatch the ${str(j.kind, 10)} run for ${sha(j.sha)}` : `journal: advance ${sha(j.before)} to ${sha(j.after)}`);
  const c = obj(obj(s.dispatch)?.candidate);
  if (c) out.push(`dispatch candidate: ${sha(c.sha)}`);
  const p = obj(s.pausePending);
  if (p) out.push(`pause pending: ${str(p.reason, 160)}`);
  const h = Array.isArray(s.history) ? obj(s.history.at(-1)) : null;
  if (h) out.push(`last history: ${str(h.outcome, 20)} at ${when(h.at)} (${sha(h.from)} to ${sha(h.to)})`);
  return out;
}

export interface JobReport {
  job: string;
  /** The parsed report, or null with a note saying why there is none. */
  report: Obj | null;
  note?: string;
}

export interface StatusInput {
  now: Date;
  runUrl: string;
  /** QLANDER_MODE, from the repo variable. */
  modeVar: string | undefined;
  /** release.dryRun from qlander.yml; null when the file is invalid. */
  releaseHeldByConfig: boolean | null;
  evaluation: Evaluation;
  runs: TickRun[];
  /** The most recently completed tick and its per-job reports; null when there is none. */
  newest: { run: TickRun; reports: JobReport[] } | null;
  /** Set when the job logs could not be read: replaces the newest-tick section. */
  logsNote?: string;
  queueMirror: IssueInfo | null;
  /** queue.budget from qlander.yml, for the budget warning; absent when the file is invalid. */
  budget?: { window: number; windowHours: number };
  releaseMirror: IssueInfo | null;
  openIssues: { label: string; issue: IssueInfo }[];
  pinNote?: string;
  /** The control-repo labels, from qlander.yml (or the watchdog's fallback when it is invalid). */
  labels: IssueLabels;
}

/** Every control-repo issue label the watchdog reads or writes. */
export type IssueLabels = Pick<Names, "controlLabels" | "releaseLabels" | "watchdogLabels">;

const hhmm = (iso: string) => (time(iso) === null ? "?" : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`);
const runLink = (r: TickRun) => {
  const u = safeUrl(r.url);
  return u ? `[run](${u})` : "run";
};

function jobResult(r: TickRun, name: string): string {
  const j = r.jobs?.find((x) => x.name === name);
  if (!j) return r.jobs ? "none" : "?";
  if (j.status !== "completed") return esc(j.status, 20);
  return ran(j) || j.conclusion === "skipped" ? esc(j.conclusion ?? "?", 20) : "not run";
}

const MAX_LOG_LINES = 12;
/** The most not-admitted verdicts shown; the rest are counted. */
const MAX_VERDICTS = 20;

/**
 * The queue report's admission view (src/machine.ts verdicts): what GitHub
 * listed with the ready label, and every ready PR the tick did not admit,
 * with its reason. Shown in full ahead of the log, so a silent non-admission
 * is visible even when the log is cut. Nothing for reports from before these
 * fields existed.
 */
function renderAdmission(rep: Obj): string[] {
  const out: string[] = [];
  if (rep.readyListed !== undefined) {
    const l = rep.readyListed;
    out.push(`- listed with ready: ${Array.isArray(l) ? (l.length === 0 ? "none" : l.map((n) => `PR ${int(n)}`).join(", ")) : "?"}`);
  }
  if (rep.ignored !== undefined) {
    const v = Array.isArray(rep.ignored) ? rep.ignored : null;
    if (!v) out.push("- ready but not admitted: ?");
    else {
      for (const x of v.slice(0, MAX_VERDICTS)) out.push(`- ready but not admitted: PR ${int(obj(x)?.pr)}: ${str(obj(x)?.reason, 200)}`);
      if (v.length > MAX_VERDICTS) out.push(`- ... ${v.length - MAX_VERDICTS} more in the job log`);
    }
  }
  return out;
}

function renderReport(r: JobReport): string[] {
  const label = r.job === QUEUE_JOB_NAME ? "Queue" : "Release";
  if (!r.report) return [`**${label}:** ${esc(r.note ?? "no report", 160)}`];
  const rep = r.report;
  const dry = rep.mode === "dry-run";
  const head = dry ? "dry run" : `live, outcome **${str(rep.outcome, 30)}**`;
  const out = [`**${label}** (${head}${rep.refused !== undefined ? `; a live tick would refuse: ${str(rep.refused, 160)}` : ""})`];
  if (dry && r.job === QUEUE_JOB_NAME) out.push(`- would do: ${rep.wouldDo === null || rep.wouldDo === undefined ? "nothing" : isObj(rep.wouldDo) ? code(rep.wouldDo) : "?"}`);
  if (r.job === QUEUE_JOB_NAME) out.push(...renderAdmission(rep));
  if (rep.decision !== undefined) {
    const d = obj(rep.decision);
    out.push(`- decision: ${d ? `${str(d.kind, 20)}${d.reason !== undefined ? `: ${str(d.reason, 160)}` : d.to !== undefined ? ` to ${sha(d.to)}` : ""}` : rep.decision === null ? "none" : "?"}`);
  }
  const log = Array.isArray(rep.log) ? rep.log : rep.log === undefined ? [] : ["?"];
  if (log.length) out.push("", ...fenced(log.length > MAX_LOG_LINES ? [...log.slice(0, MAX_LOG_LINES), `... ${log.length - MAX_LOG_LINES} more lines in the job log`] : log));
  return out;
}

/** The status issue's body: short, newest first, readable on a phone. */
export function renderStatus(s: StatusInput): string {
  const now = s.now.getTime();
  const e = s.evaluation;
  const mode =
    s.modeVar === "live"
      ? `live${s.releaseHeldByConfig === null ? " (release advance setting unknown: qlander.yml is invalid)" : s.releaseHeldByConfig ? " (release advance held in dry run by release.dryRun in qlander.yml)" : ""}`
      : `dry-run (QLANDER_MODE is ${s.modeVar ? code(s.modeVar, 20) : "unset"})`;
  const link = (u?: string) => (u ? ` ([link](${u}))` : "");
  const runUrl = safeUrl(s.runUrl);
  const L = s.labels;
  const out: string[] = [`<!-- ${L.watchdogLabels.status} -->`, `## ${level(e)} · ${stamp(s.now)}`, `${runUrl ? `[watchdog run](${runUrl})` : "watchdog run"} · mode: ${mode}`, ""];

  if (e.alerts.length) out.push("**Alerts**", ...e.alerts.map((a) => `- ${ALERT_TITLES[a.kind]}: ${a.detail}${link(a.url)}`), "");
  if (e.unknown.length) out.push("**Could not check** (alert issues left as they were)", ...e.unknown.map((u) => `- ${ALERT_TITLES[u.kind]}: ${u.reason}`), "");
  if (e.warnings.length) out.push("**Warnings**", ...e.warnings.map((w) => `- ${w.detail}${link(w.url)}`), "");
  if (e.notes.length) out.push("**Notes**", ...e.notes.map((n) => `- ${n}`), "");

  out.push("### Last 5 ticks");
  const ticks = s.runs.filter(isTickRun).sort((a, b) => (time(b.createdAt) ?? 0) - (time(a.createdAt) ?? 0)).slice(0, 5);
  if (ticks.length === 0) out.push("No tick.yml runs.");
  for (const r of ticks) out.push(`- ${hhmm(r.createdAt)} · queue ${jobResult(r, QUEUE_JOB_NAME)} · release ${jobResult(r, RELEASE_JOB_NAME)} · ${runLink(r)}`);
  out.push("");

  out.push(`### Newest tick${s.newest ? ` (${hhmm(s.newest.run.createdAt)}, ${runLink(s.newest.run)})` : ""}`);
  if (s.logsNote) out.push(esc(s.logsNote, 300));
  else if (!s.newest) out.push("No completed tick to read.");
  else if (s.newest.reports.length === 0) out.push("No job log to read.");
  else for (const r of s.newest.reports) out.push(...renderReport(r), "");
  if (out.at(-1) !== "") out.push("");

  out.push("### State");
  if (!s.queueMirror && !s.releaseMirror) out.push("No state mirror issues yet (they appear once ticks run live).");
  const mirror = (name: string, i: IssueInfo, lines: string[]) => {
    const u = safeUrl(i.url);
    out.push(`${name} (${u ? `[issue ${i.number}](${u})` : `issue ${i.number}`}):`, ...lines.map((l) => `- ${l}`));
  };
  if (s.queueMirror) mirror("Queue", s.queueMirror, summariseQueueState(s.queueMirror.body, s.budget ? { ...s.budget, now: s.now } : undefined));
  if (s.releaseMirror) mirror("Release", s.releaseMirror, summariseReleaseState(s.releaseMirror.body));
  out.push("");

  out.push("### Open issues");
  if (s.openIssues.length === 0) out.push(`No open ${L.controlLabels.pause}, ${L.releaseLabels.pause}, ${L.releaseLabels.alert} or ${L.watchdogLabels.alert} issues.`);
  for (const { label, issue } of s.openIssues) {
    const u = safeUrl(issue.url);
    const at = time(issue.createdAt);
    out.push(`- ${label} ${u ? `[issue ${issue.number}](${u})` : `issue ${issue.number}`} ${esc(issue.title)} · ${at === null ? "?" : humanAge(now - at)}`);
  }
  out.push("", "---", `Rewritten every 15 minutes by \`.github/workflows/watchdog.yml\`; see docs/operating.md, Monitoring.${s.pinNote ? ` ${esc(s.pinNote, 300)}` : ""}`);
  const body = out.join("\n");
  return body.length > 60_000 ? `${body.slice(0, 60_000)}\n\n(truncated)` : body;
}
