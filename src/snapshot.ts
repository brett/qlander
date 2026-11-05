// GitHub state → the pure inputs: the Snapshot decide() reads, and the
// Observation recovery reads (DESIGN.md §3.2, §4, §6). Read-only: every call
// goes through TargetApi, and nothing from the target is executed.

import { type LivePr, WRITERS } from "./admission";
import { type AutomationTrust, automationFor, automationTrust } from "./automation";
import { classify } from "./classify";
import type { Config, Names, TrustedAutomation } from "./config";
import { actives, baselineBatch, parkedBatch, type Snapshot } from "./ctx";
import { jobId, LOG_BUDGET_MS, MAX_LOGS, parseFailingTests } from "./flaky";
import { appCheck, isPolicyChange, jobAtMain, jobAtSubject, policyApproval, type Proof } from "./evidence";
import type { TargetApi, Compare } from "./github/api";
import { GitHubError } from "./github/http";
import type { Observation } from "./ops";
import type { Active, Journal, State } from "./state";
import type { FailedJob, JobsByRun, Run } from "./types";
import { type Command, COMMAND_KINDS, queueRef } from "./validate";

export interface SnapshotInput {
  api: TargetApi;
  cfg: Config;
  state: State;
  now: Date;
  paused: boolean;
  policyHash: string;
}

const notEvaluated: Proof = { ok: false, why: "not evaluated (PR not open with ready)" };

/** PRs the snapshot must describe: everything open with ready, plus everything state refers to. */
export function prsOfInterest(state: State, ready: number[]): number[] {
  const out = new Set<number>(ready);
  Object.keys(state.auth).forEach((k) => out.add(Number(k)));
  actives(state).forEach((a) => a.prs.forEach((p) => out.add(p)));
  state.pending.forEach((p) => p.prs.forEach((x) => out.add(x)));
  state.solo.forEach((p) => out.add(p.pr));
  state.verify.forEach((v) => out.add(v.pr));
  return [...out].sort((a, b) => a - b);
}

function newest(runs: Run[]): Run | undefined {
  return runs.reduce<Run | undefined>((a, r) => (!a || r.id > a.id ? r : a), undefined);
}

/** The snapshot saw a PR or main move while it was being read; discard it and try next tick. */
export class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(`stale snapshot: ${message}`);
    this.name = "StaleSnapshotError";
  }
}

/** Shared, lazily filled lookups so one snapshot asks GitHub each question once. */
class Lookups {
  private onMain = new Map<string, boolean>();
  /** Complete job lists only; runs whose list is incomplete are in `incomplete` and never used as evidence. */
  private jobs: JobsByRun = {};
  readonly incomplete = new Set<number>();
  private search: { runs: Run[]; truncated: boolean } | null = null;

  constructor(
    private readonly api: TargetApi,
    readonly main: string,
  ) {}

  async isOnMain(sha: string): Promise<boolean> {
    if (sha === this.main) return true;
    let v = this.onMain.get(sha);
    if (v === undefined) {
      const c = await this.api.compare(sha, this.main);
      v = c.status === "ahead" || c.status === "identical";
      this.onMain.set(sha, v);
    }
    return v;
  }

  async jobsFor(runs: Run[]): Promise<JobsByRun> {
    for (const r of runs) {
      const key = String(r.id);
      if (this.jobs[key] || this.incomplete.has(r.id)) continue;
      const listed = await this.api.listJobs(r.id);
      if (listed.truncated) this.incomplete.add(r.id);
      else this.jobs[key] = listed.items;
    }
    return this.jobs;
  }

  /** The review workflow's recent main runs, read once per snapshot. */
  async reviewRuns(p: Extract<Config["review"], { adapter: "job@main" }>, mainBranch: string): Promise<{ runs: Run[]; truncated: boolean }> {
    if (!this.search) {
      const listed = await this.api.listWorkflowRuns(p.workflowPath, { branch: mainBranch, maxPages: p.searchPages });
      this.search = { runs: listed.items.filter((r) => p.events.includes(r.event)), truncated: listed.truncated };
    }
    return this.search;
  }
}

/** How many of a head's newest fast-lane runs are read for a verdict. */
const FAST_LANE_RUNS = 5;

async function fastLaneProof(i: SnapshotInput, head: string, l: Lookups): Promise<Proof> {
  const f = i.cfg.fastLane;
  const listed = await i.api.listRuns({ headSha: head, event: f.event });
  // An incomplete listing may hide the newest run: not proven either way, never green.
  if (listed.truncated) return { ok: false, unknown: true, why: `the run list for ${head} is incomplete` };
  const runs = listed.items.filter((r) => r.path === f.workflowPath);
  // The newest few runs: a label-triggered rerun still queued must not hide the verdict before it.
  const recent = [...runs].sort((a, b) => b.id - a.id).slice(0, FAST_LANE_RUNS);
  return jobAtSubject(f, head, i.api.repoId, recent, recent.length > 0 ? await l.jobsFor(recent) : {});
}

/**
 * The review for `head` (DESIGN.md §4.1). A recorded run (from the
 * authorisation) is re-checked first, so unrelated newer reviews can never
 * push a valid one out of view. Otherwise the producer's runs on main are
 * searched by run name; a search that hit its page limit without an answer is
 * "unknown", not "absent".
 */
async function reviewProof(i: SnapshotInput, head: string, l: Lookups, recorded: number | null): Promise<Proof> {
  const p = i.cfg.review;
  if (p.adapter === "app-check") return appCheck(p, head, await i.api.listCheckRuns(head));
  const repoId = i.api.repoId;
  if (recorded !== null) {
    const run = await i.api.getRun(recorded);
    if (run && run.repository?.id === repoId && run.head_branch === i.cfg.names.main && (await l.isOnMain(run.head_sha))) {
      const proof = jobAtMain(p, head, repoId, [run], await l.jobsFor([run]), () => true, i.cfg.names.main);
      if (proof.ok) return proof;
    }
  }
  const search = await l.reviewRuns(p, i.cfg.names.main);
  const name = p.runNameTemplate.replace("{sha}", head);
  const named = search.runs.filter((r) => r.display_title === name).sort((a, b) => b.id - a.id);
  const onMain: Run[] = [];
  for (const r of named) if (await l.isOnMain(r.head_sha)) onMain.push(r);
  const proof = jobAtMain(p, head, repoId, onMain, await l.jobsFor(onMain), () => true, i.cfg.names.main);
  if (proof.ok || !search.truncated) return proof;
  return { ok: false, unknown: true, why: `no review found in the newest ${p.searchPages} pages of ${p.workflowPath} runs` };
}

/**
 * One target PR as admission sees it (DESIGN.md §4.2). Commits and files come
 * from compare(main...head), addressed by immutable shas, never by PR number,
 * so a force-push mid-read cannot lend another revision's commits or files to
 * this head. buildSnapshot re-reads the PR afterwards and discards the
 * snapshot if its head or base moved.
 */
async function describePr(i: SnapshotInput, n: number, l: Lookups): Promise<LivePr> {
  const pr = await i.api.getPr(n);
  const open = pr.state === "open" && !pr.merged;
  const live: LivePr = {
    number: pr.number,
    open,
    draft: pr.draft,
    merged: pr.merged,
    head: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    baseRepoId: pr.base.repoId,
    headRepoId: pr.head.repoId,
    labels: pr.labels,
    ready: null,
    mergeable: pr.mergeable,
    commitsVerified: false,
    policyPr: false,
    fastLane: notEvaluated,
    review: notEvaluated,
    policyApproval: false,
    ...(pr.user ? { author: pr.user.login } : {}),
    ...(pr.title !== undefined ? { title: pr.title } : {}),
  };
  if (!open || !pr.labels.includes(i.cfg.names.labels.ready)) return live;
  const head = pr.head.sha;

  const ev = await i.api.latestLabelEvent(n, i.cfg.names.labels.ready);
  if (ev !== null && ev !== "unknown" && ev.actor !== null) {
    const byProducer = i.cfg.reviewRequired && i.cfg.reviewProducerLogins.includes(ev.actor);
    live.ready = { actorLogin: ev.actor, actorPermission: byProducer ? "none" : await i.api.permission(ev.actor), at: ev.at };
  } else {
    // "unknown" provenance or an unreadable actor leaves ready null: fails closed. Say which, for the tick's verdict.
    live.readyUnreadable =
      ev === "unknown"
        ? "the PR's event history could not be read completely"
        : ev === null
          ? "no labeled event for it is in the PR's event history"
          : "its latest labeled event has no actor";
  }
  const diff = await i.api.compare(l.main, head);
  live.commitsVerified = !diff.truncated && diff.commits.every((c) => c.verified);
  live.policyPr = diff.truncated || isPolicyChange(diff.files, i.cfg.policyBoundary); // fail closed
  const bot = automationFor(i.cfg.trustedAutomations, pr.user);
  if (bot) live.automation = await trustOf(i, bot, pr.head.ref, head, diff);
  live.fastLane = await fastLaneProof(i, head, l);
  const auth = i.state.auth[String(n)];
  live.review = i.cfg.reviewRequired
    ? await reviewProof(i, head, l, auth && auth.head === head ? auth.reviewRun : null)
    : { ok: true, why: "review evidence not required (v1: reviewed from the agents' VM; ready by a write-access user)" };
  if (live.policyPr) live.policyApproval = policyApproval(await i.api.listComments(n), i.cfg.humans, head) !== undefined;
  const pl = i.cfg.names.labels.priority;
  if (pl && pr.labels.includes(pl)) {
    const p = await priorityOf(i, n, pl);
    if ("why" in p) live.priorityIgnored = p.why;
    else live.priority = p;
  }
  return live;
}

/**
 * Whether the priority label counts (DESIGN.md §4.4): its latest `labeled`
 * event must be by a user with write, maintain or admin access, as for an
 * operator command. A bot never prioritises, whatever its access: not a
 * trusted automation, not the review producer. Ordering only, so any failure
 * to read it means "no priority", never an error that stops the tick.
 */
async function priorityOf(i: SnapshotInput, n: number, label: string): Promise<{ actorLogin: string; at: string } | { why: string }> {
  try {
    const ev = await i.api.latestLabelEvent(n, label);
    if (ev === null || ev === "unknown" || ev.actor === null) return { why: "who applied it is not readable" };
    const automation = (i.cfg.trustedAutomations ?? []).some((a) => a.login === ev.actor) || i.cfg.reviewProducerLogins.includes(ev.actor);
    if (automation || ev.actor.endsWith("[bot]")) return { why: `applied by ${ev.actor}, an automation` };
    const permission = await i.api.permission(ev.actor);
    if (!WRITERS.has(permission)) return { why: `applied by ${ev.actor}, who has no write access` };
    return { actorLogin: ev.actor, at: ev.at };
  } catch (e) {
    return { why: `not readable (${e instanceof Error ? e.message : String(e)})` };
  }
}

/**
 * A trusted automation's PR (src/automation.ts). Any failure to read the
 * branch's activity is "not trusted", never an error: the PR then simply
 * waits under today's rules, and nothing else in the tick is held up.
 */
async function trustOf(i: SnapshotInput, bot: TrustedAutomation, headRef: string, head: string, diff: Compare): Promise<AutomationTrust> {
  try {
    return automationTrust(bot, { headRef, head }, diff, await i.api.listBranchActivity(headRef));
  } catch (e) {
    return { ok: false, login: bot.login, why: `branch activity not readable (${e instanceof Error ? e.message : String(e)})` };
  }
}

async function batchCi(i: SnapshotInput, l: Lookups, a: Active | null): Promise<Snapshot["ci"]> {
  if (!a) return null;
  const branch = queueRef(i.cfg.names, a.n);
  const listed = await i.api.listRuns({ headSha: a.head, branch, event: "push" });
  const runs = listed.items;
  const newestPerPath = i.cfg.preLanding.map((wf) => newest(runs.filter((r) => r.path === wf.path))).filter((r): r is Run => r !== undefined);
  const jobsByRun = await l.jobsFor(newestPerPath);
  return classify({
    now: i.now,
    builtAt: a.builtAt,
    queueBranch: branch,
    head: a.head,
    repoId: i.api.repoId,
    manifest: i.cfg.preLanding,
    runs,
    jobsByRun,
    incomplete: newestPerPath.filter((r) => l.incomplete.has(r.id)).map((r) => r.id),
    runsIncomplete: listed.truncated,
    cancels: a.cancels,
    expect: a.rerun ?? [],
    expectSince: a.rerunAt,
    hasPolicyPr: a.prs.some((p) => i.state.auth[String(p)]?.policyPr === true),
    limits: { noRunMinutes: i.cfg.noRunMinutes, inProgressMinutes: i.cfg.inProgressMinutes, queuedHours: i.cfg.queuedHours, rerunBarrierMinutes: i.cfg.rerunBarrierMinutes },
  });
}

/**
 * Operator commands (DESIGN.md §10): every open PR carrying a command label,
 * oldest label first. The label's latest `labeled` event names the command
 * and its actor, whose permission on the target is checked now, when the
 * command is consumed. A label whose provenance cannot be read completely
 * waits; one whose latest application has no readable actor is refused as
 * unauthorized.
 */
async function operatorCommands(i: SnapshotInput, readySeen: Set<number>): Promise<Command[]> {
  const out: Command[] = [];
  for (const kind of COMMAND_KINDS) {
    const label = i.cfg.names.labels[kind];
    for (const pr of await i.api.listOpenPrNumbersWithLabel(label)) {
      const read = await i.api.getPr(pr);
      if (read.state === "open" && read.labels.includes(i.cfg.names.labels.ready)) readySeen.add(pr); // for the verdicts only
      // Lists lag: the PR itself must still carry the label (it may have just been removed).
      if (!read.labels.includes(label)) continue;
      const ev = await i.api.latestLabelEvent(pr, label);
      if (ev === null || ev === "unknown") continue;
      // An unreadable actor cannot be shown to have write access: the command is refused, never honoured.
      const authorized = ev.actor !== null && WRITERS.has(await i.api.permission(ev.actor));
      out.push({ kind, pr, label, id: ev.id, at: ev.at, actor: ev.actor, authorized });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
}

/**
 * The operatorSolo PRs that have left the queue (DESIGN.md §10): merged,
 * closed or without the ready label, the same in two reads, so one lagging
 * read never clears a mark. Best effort and outside the snapshot's
 * consistency check: a PR that cannot be read, or reads differently twice,
 * keeps its mark this tick, and nothing here can fail or discard the tick.
 */
async function soloLeft(i: SnapshotInput): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const why = (pr: Awaited<ReturnType<TargetApi["getPr"]>>) =>
    pr.merged ? "merged" : pr.state !== "open" ? "closed" : !pr.labels.includes(i.cfg.names.labels.ready) ? "not labelled ready" : null;
  for (const n of i.state.operatorSolo) {
    try {
      const a = why(await i.api.getPr(n));
      if (a !== null && a === why(await i.api.getPr(n))) out[String(n)] = a;
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
    }
  }
  return out;
}

/** The most job logs read per run to compare failures with main's: a job past it matches by name (src/baseline.ts). */
const BASELINE_LOGS = 12;

/** Failed job names in main's newest completed push run of the CI workflow, or null if unknown. */
async function mainFailedJobs(i: SnapshotInput, l: Lookups): Promise<string[] | null> {
  const path = i.cfg.preLanding[0]?.path;
  if (!path) return null;
  const mainBranch = i.cfg.names.main;
  const runs = (await i.api.listWorkflowRuns(path, { branch: mainBranch, event: "push", maxPages: 1 })).items.filter(
    (r) => r.status === "completed" && r.head_branch === mainBranch && r.event === "push" && r.repository.id === i.api.repoId,
  );
  const top = newest(runs);
  if (!top) return null;
  const jobs = (await l.jobsFor([top]))[String(top.id)];
  if (!jobs) return null; // incomplete list: unknown
  return jobs.filter((j) => j.conclusion === "failure" || j.conclusion === "timed_out").map((j) => j.name);
}

export async function buildSnapshot(i: SnapshotInput): Promise<Snapshot> {
  const main = await i.api.getRef(i.cfg.names.main);
  if (!main) throw new Error(`${i.cfg.names.target.name} ${i.cfg.names.main} does not exist`);
  const l = new Lookups(i.api, main);
  const ready = await i.api.listOpenPrNumbersWithLabel(i.cfg.names.labels.ready);
  const readyListed = [...ready].sort((a, b) => a - b);
  const prs: Record<string, LivePr> = {};
  for (const n of prsOfInterest(i.state, ready)) {
    try {
      prs[String(n)] = await describePr(i, n, l);
    } catch (e) {
      // A PR that no longer exists is left out: revalidation then drops it as unreadable.
      if (!(e instanceof GitHubError && e.kind === "not_found")) throw e;
    }
  }
  const pinReachable: Record<string, boolean> = {};
  for (const v of i.state.verify) pinReachable[v.pin] = await l.isOnMain(v.pin);
  const ci = await batchCi(i, l, i.state.active);
  // queue.strategy.reuseGreen (DESIGN.md §5.7): a parked batch's CI, only when decide() could act on it.
  const p = i.state.parked;
  // Best effort: an unreadable run only means no reuse this tick (null), never a failed tick.
  const parkedCi = i.cfg.strategy?.reuseGreen && p && !i.paused && p.base === main ? await batchCi(i, l, parkedBatch(p)).catch(() => null) : undefined;
  // Several batches running (DESIGN.md §5.6): each one's CI, by batch number.
  let cis: Snapshot["cis"];
  if (i.state.concurrent) {
    cis = {};
    for (const a of actives(i.state)) {
      const k = a.n === i.state.active?.n ? ci : await batchCi(i, l, a);
      if (k) cis[String(a.n)] = k;
    }
  }
  // Flaky tracking: a batch whose rerun of a red attempt is now green reads the first attempt's job logs.
  const flakyJobs = actives(i.state).flatMap((a) => {
    const k = cis?.[String(a.n)] ?? (a.n === i.state.active?.n ? ci : null);
    return k?.kind === "green" && a.rerun !== null && a.redJobs ? a.redJobs : [];
  });
  const flakyTests = flakyJobs.length > 0 ? await failingTests(i.api, flakyJobs) : undefined;
  // queue.strategy.mainBaseline (DESIGN.md §5.7): main's own run while it is going, and the logs a comparison needs.
  const b = i.cfg.strategy?.mainBaseline ? i.state.baseline : undefined;
  const baselineCi = b && !b.result && !i.paused ? await batchCi(i, l, baselineBatch(b)) : undefined;
  const baselineTests = baselineCi?.kind === "red" ? await failingTests(i.api, baselineCi.failedJobs, BASELINE_LOGS) : undefined;
  const redJobs = b?.result?.red || baselineCi?.kind === "red"
    ? actives(i.state).flatMap((a) => {
        const k = cis?.[String(a.n)] ?? (a.n === i.state.active?.n ? ci : null);
        return k?.kind === "red" ? k.failedJobs : [];
      })
    : [];
  const redTests = redJobs.length > 0 ? await failingTests(i.api, redJobs, BASELINE_LOGS) : undefined;
  const failed = await mainFailedJobs(i, l);
  const readySeen = new Set<number>();
  const commands = await operatorCommands(i, readySeen);
  const left = await soloLeft(i);

  // Consistency: nothing the evidence was read against may have moved meanwhile.
  if ((await i.api.getRef(i.cfg.names.main)) !== main) throw new StaleSnapshotError("main moved while the snapshot was read");
  for (const live of Object.values(prs)) {
    if (!live.open) continue;
    const now = await i.api.getPr(live.number);
    if (now.head.sha !== live.head || now.base.ref !== live.baseRef || now.base.repoId !== live.baseRepoId) {
      throw new StaleSnapshotError(`#${live.number} moved while the snapshot was read`);
    }
  }

  return {
    now: i.now,
    paused: i.paused,
    main,
    policyHash: i.policyHash,
    prs,
    ci,
    ...(cis ? { cis } : {}),
    ...(parkedCi !== undefined ? { parkedCi } : {}),
    ...(baselineCi ? { baselineCi } : {}),
    ...(baselineTests ? { baselineTests } : {}),
    ...(redTests ? { redTests } : {}),
    mainFailedJobs: failed,
    pinReachable,
    commands,
    ...(Object.keys(left).length > 0 ? { soloLeft: left } : {}),
    readyListed,
    ...(() => {
      const unlisted = [...readySeen].filter((n) => !prs[String(n)]).sort((a, b) => a - b);
      return unlisted.length > 0 ? { readyUnlisted: unlisted } : {};
    })(),
    ...(flakyTests ? { flakyTests } : {}),
  };
}

/**
 * Failing test ids from the logs of the first attempt's failed jobs, once
 * their rerun has passed (flaky tracking). Best effort: a log that cannot be
 * read is left out, and the flake is then tracked by job name.
 */
async function failingTests(api: TargetApi, jobs: FailedJob[], maxLogs = MAX_LOGS): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  // Bounded well inside the tick's job timeout: at most MAX_LOGS downloads,
  // each with its own deadline, and none started after LOG_BUDGET_MS.
  const started = Date.now();
  for (const j of jobs.slice(0, maxLogs)) {
    if (Date.now() - started > LOG_BUDGET_MS) break;
    const id = jobId(j);
    if (id === null || String(id) in out) continue;
    try {
      out[String(id)] = parseFailingTests(await api.jobLog(id));
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
    }
  }
  return out;
}

/** What recovery needs to judge a journalled op (DESIGN.md §3.2). */
export async function observe(api: TargetApi, j: Journal, names: Names): Promise<Observation> {
  const op = j.op;
  switch (op.kind) {
    case "build": {
      const ref = queueRef(names, op.n);
      const queueHead = await api.getRef(ref);
      if (queueHead === null || !j.checkpoint || !j.checkpoint.chainHead) return { queueHead, queueRef: ref, queueChainMatches: false };
      // Walk back from the queue head: one merge commit per survivor, second
      // parent = its pin, first parents ending at the recorded base.
      let cur = queueHead;
      let matches = queueHead === j.checkpoint.chainHead;
      for (const pin of [...j.checkpoint.survivors].reverse()) {
        if (!matches) break;
        const c = await api.getCommit(cur);
        matches = c.parents.length === 2 && c.parents[1] === pin.head;
        cur = c.parents[0] ?? "";
      }
      return { queueHead, queueRef: ref, queueChainMatches: matches && cur === op.base };
    }
    case "rerun":
    case "cancel": {
      const runs = op.kind === "rerun" ? [...op.runs, ...(op.requested ?? [])] : op.runs;
      const attempts: Record<string, number> = {};
      const missingRuns: number[] = [];
      for (const r of runs) {
        const run = await api.getRun(r.runId);
        if (run === null) missingRuns.push(r.runId);
        else attempts[String(r.runId)] = run.run_attempt;
      }
      return { attempts, missingRuns };
    }
    case "land": {
      const main = await api.getRef(names.main);
      if (main === null) return { afterReachable: false };
      if (main === op.after) return { main, afterReachable: true };
      const c = await api.compare(op.after, main);
      return { main, afterReachable: c.status === "ahead" || c.status === "identical" };
    }
  }
}
