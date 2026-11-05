// The watchdog's pure decisions (src/watchdog.ts runs them): the checks
// against one observation of tick.yml and the issues, the alert-issue
// lifecycle, and the escaping every piece of untrusted text goes through.
// No I/O; unit-tested in test/watchdog.test.ts.
//
// A check has three answers: firing, clear, or unknown (a listing was
// incomplete, a timestamp was invalid, the read budget ran out). Unknown never
// opens or closes an alert issue: the existing state is kept.

import { CONTROL_BRANCH, QUEUE_JOB_NAME } from "./job-names";

export interface TickJob {
  id: number;
  name: string;
  status: string; // queued | in_progress | completed | waiting | pending
  conclusion: string | null; // success | failure | cancelled | skipped | timed_out | ...
  /** When the job was queued, if the payload says (validated before use). */
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  url: string;
  runnerName: string | null;
  steps: { name: string; conclusion: string | null }[];
}

export interface TickRun {
  id: number;
  url: string;
  event: string;
  branch: string;
  status: string; // queued | pending | waiting | requested | in_progress | completed
  conclusion: string | null;
  createdAt: string;
  /** The latest attempt's start (a rerun moves it). */
  runStartedAt: string | null;
  /** The run's last change: never earlier than any of its jobs completing. */
  updatedAt: string | null;
  /** The latest attempt's jobs, when they were read. */
  jobs?: TickJob[];
}

export interface IssueInfo {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
}

export interface Observation {
  now: Date;
  /** tick.yml's workflow state: "active", "disabled_manually", "disabled_inactivity", ... */
  workflowState: string;
  /** tick.yml's recent runs and every unfinished run, each once. */
  runs: TickRun[];
  /** Every job needed for the completion checks was read (the read budget did not run out). */
  jobsComplete: boolean;
  /** The unfinished runs were listed completely and every in-progress one's jobs were read. */
  unfinishedComplete: boolean;
  pause: IssueInfo[];
  releasePause: IssueInfo[];
  releaseBlocked: IssueInfo[];
  /** The pause and release-pause issues were listed completely. */
  pausesComplete: boolean;
  /** The two pause labels, as qlander.yml names them (queue.controlLabels.pause, release.labels.pause), for the alert text. */
  pauseLabels: { queue: string; release: string };
  /** What the queue found about main (queue.strategy.mainBaseline), from the state mirror. Absent or null: nothing. */
  mainRed?: { base: string; failing: string[]; held: number[] } | "unreadable" | null;
}

export type AlertKind = "ticks-stopped" | "ticks-failing" | "runner-stuck" | "paused" | "main-broken" | "workflow-disabled" | "config-invalid";

export const ALERT_TITLES: Record<AlertKind, string> = {
  "ticks-stopped": "ticks stopped",
  "ticks-failing": "ticks failing",
  "runner-stuck": "runner not picking up ticks",
  paused: "paused",
  "main-broken": "main is broken",
  "workflow-disabled": "tick workflow disabled",
  "config-invalid": "config invalid",
};

/**
 * What each alert means for someone who has not read the code: what is
 * wrong, whether PRs stop landing, and what to do. Plain words; docs/operating.md's
 * Monitoring section has the detail.
 */
export const ALERT_HELP: Record<AlertKind, { meaning: string; impact: string; action: string }> = {
  "ticks-stopped": {
    meaning: "The landing queue has not run for a while. Qlander works in short runs called ticks, and none has finished recently.",
    impact: "Yes. No PR lands, and ready PRs wait, until ticks run again.",
    action: "Check whether tick.yml is enabled and whether a qlander runner is up on the CI hosts. A \"runner not picking up ticks\" or \"tick workflow disabled\" alert usually explains it.",
  },
  "ticks-failing": {
    meaning: "The last few landing-queue runs (ticks) all failed.",
    impact: "Yes. Nothing lands while every tick fails.",
    action: "Open the linked run and read the failed step. A failure at a token step usually means the GitHub App key or installation; a failure in the tick step is a qlander bug or a GitHub outage.",
  },
  "runner-stuck": {
    meaning: "A landing-queue run (tick) has been waiting for a machine to run on, and none has picked it up.",
    impact: "Yes, if no tick has finished recently (a \"ticks stopped\" alert would say so). If ticks are still finishing, it is one stuck run and landing is not affected.",
    action: "Check the qlander runners and the CI controllers on the CI hosts (docs/operating.md: \"Restarting a runner host's controller\"). A run GitHub queued but never gave any jobs is ignored once a newer tick finishes, so this alert then closes by itself.",
  },
  paused: {
    meaning: "Someone paused the landing queue (a pause issue is open) and it has stayed paused for over 2 hours.",
    impact: "Yes. Nothing lands while it is paused.",
    action: "Read the pause issue, fix what it describes, then close it to resume.",
  },
  "main-broken": {
    meaning: "The target's main fails the suite with no PR in it. PRs that fail only the same tests stay admitted, and are not bounced, while they wait for main to move.",
    impact: "Yes, for every PR except one that fixes main. Such a PR still lands, and the held PRs are then tested again.",
    action: "Fix main: land a PR that makes the failing tests pass. If enough PRs are held, the queue also pauses, and the pause issue says so.",
  },
  "workflow-disabled": {
    meaning: "The landing queue's workflow (tick.yml) is switched off, so it cannot run.",
    impact: "Yes. Nothing lands until it is switched back on.",
    action: "If someone switched it off on purpose (for example during a controller restart), let them finish. Otherwise switch it back on in the control repo (the repo that holds qlander.yml): gh workflow enable tick.yml",
  },
  "config-invalid": {
    meaning: "qlander.yml, the queue's settings file, does not load.",
    impact: "Yes. Ticks fail until the file is fixed.",
    action: "Open the linked run for the exact error, fix qlander.yml on main, and merge the fix.",
  },
};

export const STATUS_TITLE = "qlander status";
export const alertTitle = (k: AlertKind) => `qlander alert: ${ALERT_TITLES[k]}`;

export interface Alert {
  kind: AlertKind;
  /** What "changed materially" means: a new key comments, the same key stays quiet. */
  key: string;
  /** Markdown, already escaped. */
  detail: string;
  url?: string;
}

export interface Unknown {
  kind: AlertKind;
  reason: string;
}

export interface Warning {
  detail: string;
  url?: string;
}

export interface Evaluation {
  alerts: Alert[];
  warnings: Warning[];
  unknown: Unknown[];
  /** Informational: shown on the status issue, never an alert and never a warning. */
  notes: string[];
}

export interface Thresholds {
  stoppedMinutes: number;
  failingInARow: number;
  queuedMinutes: number;
  pausedHours: number;
}

/** A queued tick run with no jobs older than this, with a newer tick completed since, is a ghost (see ghostTick). */
export const GHOST_MINUTES = 5;

export const THRESHOLDS: Thresholds = { stoppedMinutes: 30, failingInARow: 3, queuedMinutes: 20, pausedHours: 2 };

const MIN = 60_000;

/** A timestamp in ms, or null if it is missing or not a valid ISO time. Null means unknown, never "fine". */
export function time(iso: string | null | undefined): number | null {
  if (typeof iso !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/.test(iso)) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

const firstTime = (...xs: (string | null | undefined)[]): number | null => {
  for (const x of xs) {
    const t = time(x);
    if (t !== null) return t;
  }
  return null;
};

// ---------------------------------------------------------------- escaping

const ZW = "\u200b";

/**
 * Untrusted text (issue titles, mirror and report fields, log lines) as
 * inert inline Markdown: one line, HTML entities for & < >, backslash
 * escapes for Markdown syntax, and a zero-width space after @ and # so it
 * mentions nobody and links no issue.
 */
export function esc(x: unknown, max = 120): string {
  let s = typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : x == null ? "" : "?";
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return s.replace(/[\\`*_[\]()!|~{}#@&<>]/g, (c) => {
    if (c === "&") return "&amp;";
    if (c === "<") return "&lt;";
    if (c === ">") return "&gt;";
    if (c === "@") return `@${ZW}`;
    if (c === "#") return `\\#${ZW}`;
    return `\\${c}`;
  });
}

/** Untrusted text as an inline code span: nothing inside is interpreted, and it cannot close early. */
export function code(x: unknown, max = 200): string {
  let s = typeof x === "string" ? x : JSON.stringify(x) ?? "";
  s = s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/`/g, "'");
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  return `\`${s.trim() || " "}\``;
}

/** Untrusted lines as a fenced block that no line can close or escape. */
export function fenced(lines: unknown[]): string[] {
  return ["````text", ...lines.map((l) => (typeof l === "string" ? l : "?").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/`/g, "'").slice(0, 200)), "````"];
}

/** A link target we produced from the API: a github.com https URL, or nothing. */
export function safeUrl(u: unknown): string | undefined {
  return typeof u === "string" && /^https:\/\/github\.com\/[A-Za-z0-9_.\/-]+$/.test(u) ? u : undefined;
}

// ---------------------------------------------------------------- checks

/** A run that is (or would be) a real tick: on main, from the cron or a dispatch. */
export const isTickRun = (r: TickRun) => r.branch === CONTROL_BRANCH && (r.event === "schedule" || r.event === "workflow_dispatch");

/** A job that actually ran on a runner (a pending job replaced in its concurrency group never did). */
export const ran = (j: TickJob) => j.status === "completed" && j.conclusion !== "skipped" && (j.steps.length > 0 || j.runnerName !== null);

export interface Completion {
  run: TickRun;
  job: TickJob;
  at: number;
}

/**
 * Completed queue-tick jobs that ran, newest completion first (a rerun of an
 * older run sorts by when it finished, not when the run was created), and how
 * many had no valid completion time.
 */
export function completions(runs: TickRun[]): { done: Completion[]; invalid: number } {
  const done: Completion[] = [];
  let invalid = 0;
  for (const run of runs.filter(isTickRun)) {
    const job = run.jobs?.find((j) => j.name === QUEUE_JOB_NAME);
    if (!job || !ran(job)) continue;
    const at = time(job.completedAt);
    if (at === null) invalid++;
    else done.push({ run, job, at });
  }
  done.sort((a, b) => b.at - a.at);
  return { done, invalid };
}

export function humanAge(msAgo: number): string {
  const m = Math.max(0, Math.floor(msAgo / MIN));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function stamp(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Every check, against one observation. Pure. */
export function evaluate(o: Observation, t: Thresholds = THRESHOLDS): Evaluation {
  const alerts: Alert[] = [];
  const warnings: Warning[] = [];
  const unknown: Unknown[] = [];
  const notes: string[] = [];
  const now = o.now.getTime();
  const ticks = o.runs.filter(isTickRun);

  if (o.workflowState !== "active") {
    alerts.push({ kind: "workflow-disabled", key: o.workflowState, detail: `tick.yml is ${esc(o.workflowState, 40)}: no tick starts until it is enabled` });
  }

  // Ticks stopped: no queue tick has finished within the threshold. A recent
  // completion clears it whatever else is unknown; its absence counts only
  // when every needed job was read and every completion time was valid.
  const { done, invalid } = completions(o.runs);
  const last = done[0];
  const fresh = last && now - last.at <= t.stoppedMinutes * MIN;
  if (ticks.length === 0) {
    alerts.push({ kind: "ticks-stopped", key: "none", detail: "tick.yml has no runs at all" });
  } else if (!fresh && (!o.jobsComplete || invalid > 0)) {
    unknown.push({ kind: "ticks-stopped", reason: invalid > 0 ? "a tick's completion time is invalid" : "not enough tick jobs could be read" });
  } else if (!last) {
    alerts.push({ kind: "ticks-stopped", key: "none", detail: `no completed queue tick in the last ${ticks.length} runs` });
  } else if (!fresh) {
    alerts.push({ kind: "ticks-stopped", key: String(last.job.id), detail: `the last tick finished ${humanAge(now - last.at)} ago`, ...link(last.run.url) });
  }

  // Ticks failing: the N most recently completed queue-tick jobs all failed.
  if (!o.jobsComplete || invalid > 0) {
    unknown.push({ kind: "ticks-failing", reason: invalid > 0 ? "a tick's completion time is invalid" : "not enough tick jobs could be read" });
  } else {
    const recent = done.slice(0, t.failingInARow);
    if (recent.length === t.failingInARow && recent.every((x) => x.job.conclusion !== "success")) {
      const f = recent[0]!;
      const step = f.job.steps.find((s) => s.conclusion === "failure")?.name;
      alerts.push({
        kind: "ticks-failing",
        // The failure's kind and step, not its run: a new failing run every tick is not news.
        key: `${f.job.conclusion}:${step ?? ""}`,
        detail: `the last ${t.failingInARow} queue ticks failed; the newest ${esc(f.job.conclusion, 20)}${step ? ` at "${esc(step, 80)}"` : ""}`,
        ...link(f.run.url),
      });
    }
  }

  // Runner not picking up: a run, or a job in a started run, waiting for a runner past the threshold.
  let oldest: { at: number; url: string } | null = null;
  let blind = false;
  const wait = (at: number | null, url: string) => {
    if (at === null) blind = true;
    else if (!oldest || at < oldest.at) oldest = { at, url };
  };
  for (const r of ticks) {
    if (r.status === "completed") continue;
    if (ghostTick(r, done, now)) {
      notes.push(`ignored a ghost tick run ${r.id}: queued for ${humanAge(now - firstTime(r.runStartedAt, r.createdAt)!)} with no jobs, and a newer tick has completed since; GitHub will not cancel or delete it`);
      continue;
    }
    if (r.status !== "in_progress") wait(firstTime(r.runStartedAt, r.createdAt), r.url);
    else if (!r.jobs) blind = true;
    for (const j of r.jobs ?? []) if (j.status === "queued" || j.status === "waiting" || j.status === "pending") wait(firstTime(j.createdAt, r.runStartedAt, r.createdAt), r.url);
  }
  const o2 = oldest as { at: number; url: string } | null;
  if (o2 && now - o2.at > t.queuedMinutes * MIN) {
    alerts.push({ kind: "runner-stuck", key: "queued", detail: `a landing-queue run (tick) has waited ${humanAge(now - o2.at)} for a qlander runner`, ...link(o2.url) });
  } else if (blind || !o.unfinishedComplete) {
    unknown.push({ kind: "runner-stuck", reason: blind ? "an unfinished run has no valid wait time or unread jobs" : "the unfinished runs could not all be listed" });
  }

  // Paused too long: an open pause or release-pause issue past the threshold. A younger pause warns.
  const pauses = [...o.pause.map((i) => ({ i, what: o.pauseLabels.queue })), ...o.releasePause.map((i) => ({ i, what: o.pauseLabels.release }))]
    .map((p) => ({ ...p, at: time(p.i.createdAt) }))
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const long = pauses.filter((p) => p.at === null || now - p.at > t.pausedHours * 60 * MIN);
  if (long.length > 0) {
    const p = long[0]!;
    const more = long.length > 1 ? ` (and ${long.length - 1} more)` : "";
    const age = p.at === null ? "an unknown time" : `${Math.floor((now - p.at) / (60 * MIN))}h`;
    alerts.push({
      kind: "paused",
      key: long.map((x) => x.i.number).sort((a, b) => a - b).join(","),
      detail: `paused for ${age}: ${esc(p.i.title)} (issue ${p.i.number}, ${p.what})${more}`,
      ...link(p.i.url),
    });
  } else if (!o.pausesComplete) unknown.push({ kind: "paused", reason: "the pause issues could not all be listed" });
  for (const p of pauses) if (!long.includes(p)) warnings.push({ detail: `${p.what} open for ${humanAge(now - p.at!)}: ${esc(p.i.title)} (issue ${p.i.number})`, ...link(p.i.url) });

  if (o.mainRed === "unreadable") unknown.push({ kind: "main-broken", reason: "the queue's state mirror could not be read" });
  else if (o.mainRed) {
    alerts.push({
      kind: "main-broken",
      key: `${o.mainRed.base}:${o.mainRed.held.join(",")}`,
      detail: `main ${esc(o.mainRed.base, 40)} fails with no PR in it: ${esc(o.mainRed.failing.slice(0, 5).join(", "), 600)}. Held, still admitted: ${o.mainRed.held.map((p) => `PR ${p}`).join(", ")}`,
    });
  }
  for (const i of o.releaseBlocked) warnings.push({ detail: `release blocked: ${esc(i.title)} (issue ${i.number})`, ...link(i.url) });
  return { alerts, warnings, unknown, notes };
}

/**
 * A ghost tick run (one dispatched while tick.yml was disabled): queued, its
 * jobs read and none exist, its latest attempt started over GHOST_MINUTES ago,
 * and a tick created after that has since completed. GitHub refuses to
 * cancel or delete such a run, so it would hold runner-stuck open forever. A
 * run with any job, unread jobs, an invalid time or no newer completed tick is
 * not a ghost and is judged as waiting. GHOST_MINUTES was 60 until a second
 * ghost (from tick.yml being disabled and re-enabled with a dispatch) raised a
 * false runner-stuck alert between minutes 20 and 60: a newer finished tick
 * already proves the runner works, so 5 is enough.
 */
export function ghostTick(r: TickRun, done: Completion[], now: number): boolean {
  // The latest attempt's start, so a rerun of an old run is judged from when it began waiting.
  const since = firstTime(r.runStartedAt, r.createdAt);
  if (r.status !== "queued" || !r.jobs || r.jobs.length > 0 || since === null || time(r.createdAt) === null || now - since <= GHOST_MINUTES * MIN) return false;
  return done.some((d) => d.run.id !== r.id && (time(d.run.createdAt) ?? 0) > since && d.at > since);
}

const link = (u: string): { url?: string } => {
  const s = safeUrl(u);
  return s ? { url: s } : {};
};

export type Level = "OK" | "WARN" | "ALERT";
export const level = (e: Evaluation): Level => (e.alerts.length ? "ALERT" : e.warnings.length || e.unknown.length ? "WARN" : "OK");

// ---------------------------------------------------------------- alert lifecycle

const MARKER = /<!-- qlander-alert kind=([a-z-]+) key=(\S*) -->/;

export function alertMarker(a: Alert): string {
  return `<!-- qlander-alert kind=${a.kind} key=${encodeURIComponent(a.key)} -->`;
}

export function parseMarker(body: string): { kind: AlertKind; key: string } | null {
  const m = MARKER.exec(body);
  if (!m || !Object.hasOwn(ALERT_TITLES, m[1]!)) return null;
  try {
    return { kind: m[1] as AlertKind, key: decodeURIComponent(m[2]!) };
  } catch {
    return { kind: m[1] as AlertKind, key: m[2]! };
  }
}

const withLink = (a: Alert) => `${a.detail}${a.url ? ` ([link](${a.url}))` : ""}`;

export function alertBody(a: Alert, now: Date): string {
  return [
    alertMarker(a),
    `**${withLink(a)}**`,
    "",
    `**What this means:** ${ALERT_HELP[a.kind].meaning}`,
    "",
    `**Does this stop PRs landing?** ${ALERT_HELP[a.kind].impact}`,
    "",
    `**What to do:** ${ALERT_HELP[a.kind].action}`,
    "",
    `Since ${stamp(now)}. More detail: docs/operating.md, section Monitoring.`,
    "",
    "Opened by the qlander watchdog. It comments here only when the detail changes, and closes this issue when the condition clears.",
  ].join("\n");
}

export type AlertAction =
  | { kind: "create"; alert: Alert; title: string; body: string }
  | { kind: "update"; number: number; alert: Alert; body: string; comment: string }
  | { kind: "close"; number: number; comment: string };

/**
 * One open issue per alert kind. Create it when the condition starts; when
 * the key changes, comment and refresh the body (which carries the key);
 * close it with a comment when the condition clears. A kind whose check is
 * unknown keeps its issue as it is. Extra open issues of a kind are closed as
 * duplicates; issues without our marker are left alone.
 */
export function planAlerts(alerts: Alert[], unknown: Unknown[], open: IssueInfo[], now: Date): AlertAction[] {
  const actions: AlertAction[] = [];
  const byKind = new Map<AlertKind, { issue: IssueInfo; key: string }[]>();
  for (const issue of [...open].sort((a, b) => a.number - b.number)) {
    const m = parseMarker(issue.body);
    if (m) byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), { issue, key: m.key }]);
  }
  for (const a of alerts) {
    const [keep, ...dups] = byKind.get(a.kind) ?? [];
    if (!keep) {
      actions.push({ kind: "create", alert: a, title: alertTitle(a.kind), body: alertBody(a, now) });
      continue;
    }
    if (keep.key !== a.key) actions.push({ kind: "update", number: keep.issue.number, alert: a, body: alertBody(a, now), comment: `Changed at ${stamp(now)}: ${withLink(a)}` });
    for (const d of dups) actions.push({ kind: "close", number: d.issue.number, comment: `Duplicate of #${keep.issue.number}: the watchdog keeps one open issue per alert.` });
  }
  const held = new Set<AlertKind>([...alerts.map((a) => a.kind), ...unknown.map((u) => u.kind)]);
  for (const [kind, mine] of byKind) {
    if (held.has(kind)) continue;
    for (const m of mine) actions.push({ kind: "close", number: m.issue.number, comment: `Cleared at ${stamp(now)}: ${ALERT_TITLES[kind]} no longer holds.` });
  }
  return actions;
}

// ---------------------------------------------------------------- the status issue

export interface PinnedIssue extends IssueInfo {
  open: boolean;
  labels: string[];
}

export interface StatusPlan {
  /** The one status issue to rewrite; null when there is none (create) or none could be found (unknown). */
  keep: IssueInfo | null;
  create: boolean;
  /** Extra open status issues, to close as duplicates. */
  close: IssueInfo[];
  /** Node ids to unpin: closed (or now closing) status and alert issues still holding a pin slot. */
  unpin: string[];
}

/**
 * Exactly one status issue. Candidates are the open issues labelled
 * watchdog.labels.status from the listing, and the open pinned ones (a second,
 * independent read). Keep the pinned one, else the oldest; close the rest.
 * Create only when there is no candidate and the listing was complete: an
 * incomplete listing is unknown, and unknown never creates.
 */
export function planStatus(listed: { issues: IssueInfo[]; complete: boolean }, pinned: PinnedIssue[], labels: { alert: string; status: string }): StatusPlan {
  const [ALERT_LABEL, STATUS_LABEL] = [labels.alert, labels.status];
  const byNumber = new Map<number, IssueInfo>();
  for (const i of listed.issues) byNumber.set(i.number, i);
  const pinnedOpen = pinned.filter((p) => p.open && p.labels.includes(STATUS_LABEL));
  for (const p of pinnedOpen) if (!byNumber.has(p.number)) byNumber.set(p.number, p);
  const candidates = [...byNumber.values()].sort((a, b) => a.number - b.number);
  const keep = candidates.find((c) => pinnedOpen.some((p) => p.number === c.number)) ?? candidates[0] ?? null;
  // Close extras only on a complete listing: an unseen, older one may be the one to keep.
  const close = listed.complete ? candidates.filter((c) => c !== keep) : [];
  const closing = new Set(close.map((c) => c.number));
  const unpin = pinned.filter((p) => (p.labels.includes(STATUS_LABEL) || p.labels.includes(ALERT_LABEL)) && (!p.open || closing.has(p.number))).map((p) => p.nodeId);
  return { keep, create: keep === null && listed.complete, close, unpin };
}
