// The release job in release.mode dispatch (DESIGN.md §8.1). It never writes
// the release ref: the tick is handed a client built by dispatchOnly, which
// has no ref writer on it at all, and the target client itself has the
// "dispatch" role, which refuses every ref write (src/github/target.ts).
// Instead it drives the target's own release workflow:
//
//   1. take the lease and the epoch (src/release-runner.ts releaseTick)
//   2. reconcile a leftover intent: an `advance` by observation, a `dispatch`
//      by recording it as maybe sent (never resent)
//   3. follow what is in flight, paused or not: find each dispatched run by
//      the dispatch id its run name echoes, and record its conclusion
//   4. stop if paused
//   5. discover the newest qualified main commit, exactly as advance mode does
//   6. for that candidate: dispatch the workflow as a dry run (once per sha),
//      report the green dry run on the status issue, wait for an approval of
//      that sha from release.dispatch.approvers, then dispatch the real run
//      (once per sha), and count release as advanced only when the release
//      ref is seen at the candidate (or a descendant)
//
// Every dispatch is journalled (intent with its budget reservation, request,
// receipt), fenced by the lease (and, with the epoch fence on, by an
// epochHeld probe just before it), and stopped by a freeze variable. Nothing
// here checks out or runs target code: runs are read as data.

import { RELEASE_REPORT_MARKER, type Listed, type TargetApi, type TargetReads } from "./github/api";
import { GitHubError } from "./github/http";
import { APPROVE_RELEASE, REARM_RELEASE, releaseApproval, releaseRearm } from "./evidence";
import { CrashError } from "./queue";
import type { ReleaseDecision } from "./release";
import type { DispatchConfig } from "./release-config";
import { discoverRelease, type ReleaseDeps } from "./release-runner";
import {
  candidateStage,
  type DispatchCandidate,
  type DispatchHistoryItem,
  type DispatchJournal,
  type DispatchKind,
  type DispatchOutcome,
  type DispatchRecord,
  type DispatchState,
  emptyDispatchState,
  type ReleaseState,
} from "./release-state";
import { type EpochBox, ReleaseTickBase, type ReleaseOutcome, stableId } from "./release-tick";
import { LostLockError, type StateStore } from "./store";
import type { IssueComment, Run } from "./types";

/**
 * The target as the dispatch mode sees it: the reads, the epoch, and one
 * workflow dispatch. There is no ref writer on this type, and dispatchOnly
 * builds an object that has none at runtime either.
 */
export type DispatchTarget = TargetReads & Pick<TargetApi, "advanceEpoch" | "dispatchWorkflow">;

/** Narrow a (fenced) target client to DispatchTarget: only these methods are copied, so release cannot be written through what it returns. */
export function dispatchOnly(t: TargetApi): DispatchTarget {
  return {
    repoId: t.repoId,
    epochBranch: t.epochBranch,
    getRef: (b) => t.getRef(b),
    listRefs: (p) => t.listRefs(p),
    getCommit: (s) => t.getCommit(s),
    compare: (b, h) => t.compare(b, h),
    listOpenPrNumbersWithLabel: (l) => t.listOpenPrNumbersWithLabel(l),
    getPr: (n) => t.getPr(n),
    latestLabelEvent: (n, l) => t.latestLabelEvent(n, l),
    permission: (l) => t.permission(l),
    listBranchActivity: (b) => t.listBranchActivity(b),
    listComments: (n) => t.listComments(n),
    listReviews: (n) => t.listReviews(n),
    listRuns: (q) => t.listRuns(q),
    listWorkflowRuns: (p, q) => t.listWorkflowRuns(p, q),
    getRun: (id) => t.getRun(id),
    listJobs: (id) => t.listJobs(id),
    jobLog: (id) => t.jobLog(id),
    listCheckRuns: (s) => t.listCheckRuns(s),
    listStatuses: (s) => t.listStatuses(s),
    listCommitStatuses: (s) => t.listCommitStatuses(s),
    getDataFile: (p, r) => t.getDataFile(p, r),
    readEpoch: () => t.readEpoch(),
    epochHeld: (e) => t.epochHeld(e),
    readVariable: (n) => t.readVariable(n),
    getPrBranch: (b) => t.getPrBranch(b),
    branchRules: (b) => t.branchRules(b),
    rulesetBypass: (id) => t.rulesetBypass(id),
    branchProtected: (b) => t.branchProtected(b),
    advanceEpoch: (b, m) => t.advanceEpoch(b, m),
    dispatchWorkflow: (w, r, i) => t.dispatchWorkflow(w, r, i),
  };
}

/** Definite refusals (GitHub answered 4xx, so nothing started) retried per candidate before giving up on it. */
export const DISPATCH_REFUSALS = 3;
/** A run is matched only if created no earlier than this before its intent: runner and GitHub clocks differ. */
export const CLOCK_SLACK_MS = 5 * 60_000;
/** Pages of the workflow's runs read when looking for a dispatched run. */
const RUN_PAGES = 10;
/** Jobs listed in a candidate report, at most; their names are the target's text, shown as data. */
const REPORT_JOBS = 20;

/** The id a dispatch sends, which the run name must echo: kind, the sha's prefix, and a nonce from this intent. */
export function dispatchIdFor(kind: DispatchKind, sha: string, seq: number, runId: string): string {
  return `qlr-${kind}-${sha.slice(0, 12)}-${stableId(`${runId}:${seq}:${kind}:${sha}`)}`;
}

/** Whether a run name carries the dispatch id as a whole token. */
export const echoesId = (title: string, id: string) => new RegExp(`(^|[^A-Za-z0-9-])${id}($|[^A-Za-z0-9-])`).test(title);

/** A run's link. */
const runUrl = (cfg: ReleaseDeps["cfg"], id: number) => `https://github.com/${cfg.names.target.owner}/${cfg.names.target.name}/actions/runs/${id}`;

/** Concluded by qlander, not by GitHub: the run could not be followed. A real run left like this may still be promoting, so it pauses. */
const UNFOLLOWED = new Set(["never-appeared", "stuck", "ambiguous", "missing", "foreign-attempt", "unauthenticated"]);

/** Untrusted target text for an issue comment: one line, no markdown that could break out of a code span, bounded. */
const plain = (s: string, max = 100) => s.replace(/[\s`<>]+/g, " ").trim().slice(0, max);

/** What a live dispatch-mode tick would do next, in words (the release dry run's line). Pure. */
export function describeDispatch(state: ReleaseState, decision: ReleaseDecision): string {
  const c = state.dispatch?.candidate ?? null;
  if (c?.real || (c?.dry && c.dry.conclusion === null)) return `candidate ${c.sha}: ${candidateStage(c)}; a live tick would follow it`;
  if (decision.kind !== "advance") return `${decision.kind}: ${decision.reason}${c ? `; candidate ${c.sha}: ${candidateStage(c)}` : ""}`;
  if (!c || c.sha !== decision.to) {
    if (state.dispatch?.history.some((h) => h.sha === decision.to) || state.dispatch?.highWater === decision.to) return `${decision.to} already had its dry run; a live tick would wait for a newer commit`;
    return `a live tick would dispatch a dry run of ${decision.to}${c ? ` (superseding ${c.sha})` : ""}`;
  }
  return `candidate ${c.sha}: ${candidateStage(c)}`;
}

export class DispatchTick extends ReleaseTickBase {
  private readonly cfg: DispatchConfig;
  /** The open status issue, read once per tick (null: none open, or the listing failed). */
  private statusIssue: { number: number } | null | undefined;

  constructor(
    d: ReleaseDeps,
    store: StateStore<ReleaseState>,
    state: ReleaseState,
    private readonly target: DispatchTarget,
    box: EpochBox,
  ) {
    super(d, store, state, target, box);
    if (d.cfg.mode !== "dispatch" || !d.cfg.dispatch) throw new Error("DispatchTick needs release.mode dispatch and release.dispatch");
    this.cfg = d.cfg.dispatch;
  }

  private get deps(): ReleaseDeps {
    return this.d as ReleaseDeps;
  }

  private ds(): DispatchState {
    return this.state.dispatch ?? emptyDispatchState();
  }

  private setDs(ds: DispatchState, also: Partial<ReleaseState> = {}): void {
    this.state = { ...this.state, ...also, dispatch: ds };
  }

  private setCandidate(c: DispatchCandidate | null, also: Partial<ReleaseState> = {}): void {
    this.setDs({ ...this.ds(), candidate: c }, also);
  }

  private now(): number {
    return this.d.now().getTime();
  }

  // ---------------------------------------------------------------- recovery

  /** A leftover intent. An advance (from a mode switch) is settled by observation; a dispatch is recorded as maybe sent and never resent. */
  async reconcile(): Promise<void> {
    const j = this.state.journal;
    if (!j) return;
    if (j.op === "advance") return this.reconcileAdvance(j);
    const c = this.ds().candidate;
    if (!c || c.sha !== j.sha || c[j.kind] !== null) {
      // The intent and its candidate are one write, so this is a damaged state: never guess.
      this.setDs(this.ds(), { journal: null });
      return this.pause(`a ${j.kind} dispatch intent for ${j.sha} does not match the recorded candidate; read the release state's history before resuming`);
    }
    const rec: DispatchRecord = { kind: j.kind, id: j.id, at: j.at, sent: "unknown", run: null, conclusion: null, concludedAt: null };
    this.log.push(`dispatch ${j.kind} ${j.sha.slice(0, 8)} (${j.id}): the request may or may not have reached GitHub; looking for its run, never resending it`);
    this.setCandidate({ ...c, [j.kind]: rec }, { journal: null });
    await this.save();
  }

  // ---------------------------------------------------------------- following runs

  /**
   * The run a dispatch started, authenticated (DESIGN.md §8.1): the configured
   * workflow, a workflow_dispatch on the configured ref in the target itself,
   * created no earlier than the intent (less the clock slack), named with the
   * dispatch id, and started and last triggered by the release App's own bot
   * (release.dispatch.actor, login and id). The id in a run name is public
   * text that anyone who can dispatch the workflow could copy; the actor is
   * GitHub's. A run that carries the id from anyone else is ignored, and
   * logged. "unsure": the listing may be cut, so a second matching run could
   * be hidden: nothing is adopted from it. Two matches are "many", never a pick.
   */
  private async findRun(rec: DispatchRecord): Promise<{ kind: "found"; run: Run } | { kind: "none" } | { kind: "unsure" } | { kind: "many"; ids: number[] }> {
    const repoId = this.target.repoId;
    const created = new Date(Date.parse(rec.at) - CLOCK_SLACK_MS);
    const l: Listed<Run> = await this.target.listWorkflowRuns(this.cfg.workflow, { branch: this.cfg.ref, event: "workflow_dispatch", created, maxPages: RUN_PAGES });
    const named = l.items.filter(
      (r) =>
        r.path === this.cfg.workflow &&
        r.event === "workflow_dispatch" &&
        r.head_branch === this.cfg.ref &&
        r.repository?.id === repoId &&
        r.head_repository?.id === repoId &&
        Date.parse(r.created_at) >= created.getTime() &&
        typeof r.display_title === "string" &&
        echoesId(r.display_title, rec.id),
    );
    const hits = named.filter((r) => this.ours(r));
    for (const r of named) if (!hits.includes(r)) this.log.push(`ignored run ${r.id}: it carries dispatch id ${rec.id} but was started by ${r.actor?.login ?? "nobody known"} (triggered by ${r.triggering_actor?.login ?? "nobody known"}), not ${this.cfg.actor.login}`);
    if (hits.length > 1) return { kind: "many", ids: hits.map((r) => r.id) };
    if (l.truncated) return { kind: "unsure" };
    if (hits.length === 1) return { kind: "found", run: hits[0]! };
    return { kind: "none" };
  }

  /** GitHub reports the release App's bot as both who started the run and who triggered its latest attempt. */
  private ours(r: Run): boolean {
    const me = (a: Run["actor"]) => !!a && a.login === this.cfg.actor.login && a.id === this.cfg.actor.id;
    return me(r.actor) && me(r.triggering_actor);
  }

  /**
   * The run read by id (whose conclusion is what counts) must itself be
   * authenticated: started and last triggered by the release App's bot, and
   * on the very attempt the authenticated listing showed. A listing can lag
   * behind a rerun a person started, so it alone never vouches for getRun's
   * answer. "foreign": the latest attempt is someone else's; "wait": the two
   * reads disagree on the attempt (or the listing no longer shows it), so
   * nothing is concluded this tick.
   */
  private authenticate(listed: Run | null, run: Run): "ok" | "foreign" | "wait" {
    if (!this.ours(run)) return "foreign";
    if (!listed || listed.id !== run.id || listed.run_attempt !== run.run_attempt || !this.ours(listed)) return "wait";
    return "ok";
  }

  /**
   * When the run's latest attempt completed, from its jobs (GitHub's clock):
   * the newest completed_at, only if every job is listed, belongs to that
   * attempt and has completed. Null when that cannot be established.
   */
  private async completedAt(run: Run): Promise<string | null> {
    const l = await this.target.listJobs(run.id);
    if (l.truncated || l.items.length === 0) return null;
    let last = -Infinity;
    for (const j of l.items) {
      if (j.status !== "completed" || !j.completed_at || (j.run_attempt !== undefined && j.run_attempt !== run.run_attempt)) return null;
      const t = Date.parse(j.completed_at);
      if (Number.isNaN(t)) return null;
      last = Math.max(last, t);
    }
    return new Date(last).toISOString();
  }

  /** Record what is known now about one run in flight. Reads only, so it runs while paused too. */
  private async follow(rec: DispatchRecord, sha: string): Promise<DispatchRecord> {
    const now = this.now();
    let r = rec;
    const done = (conclusion: string, why: string, at: string = this.nowIso()): DispatchRecord => {
      this.log.push(`${r.kind} run for ${sha.slice(0, 8)}: ${conclusion} (${why})`);
      return { ...r, conclusion, concludedAt: at };
    };
    const late = now - Date.parse(r.at) >= this.cfg.appearMinutes * 60_000;
    // Looked up on every tick while the run is in flight, so a second run with the same id is caught even after the first was adopted.
    const f = await this.findRun(r);
    if (f.kind === "many") return done("ambiguous", `runs ${f.ids.join(", ")} all carry dispatch id ${r.id} and the release App's actor`);
    if (r.run && f.kind === "found" && f.run.id !== r.run.id) return done("ambiguous", `run ${f.run.id}, not the adopted run ${r.run.id}, now matches dispatch id ${r.id}`);
    if (!r.run) {
      if (f.kind !== "found") {
        if (!late) {
          this.log.push(`${r.kind} run for ${sha.slice(0, 8)}: not found yet (${r.id}${f.kind === "unsure" ? ", listing incomplete" : ""})`);
          return r;
        }
        if (f.kind === "unsure") return done("ambiguous", `the runs of ${this.cfg.workflow} could not all be listed within ${this.cfg.appearMinutes} minutes, so a run for ${r.id} cannot be told apart`);
        return done("never-appeared", `no run of ${this.cfg.workflow} named with ${r.id} by ${this.cfg.actor.login} within ${this.cfg.appearMinutes} minutes${r.sent === "unknown" ? "; the request's response was lost" : ""}`);
      }
      r = { ...r, run: { id: f.run.id, url: runUrl(this.deps.cfg, f.run.id), createdAt: f.run.created_at } };
      this.log.push(`${r.kind} run for ${sha.slice(0, 8)}: found run ${f.run.id}`);
    }
    const listed = f.kind === "found" && f.run.id === r.run!.id ? f.run : null;
    const run = await this.target.getRun(r.run!.id);
    if (!run) return done("missing", `run ${r.run!.id} can no longer be read`);
    const auth = this.authenticate(listed, run);
    if (auth === "foreign") return done("foreign-attempt", `run ${run.id}'s attempt ${run.run_attempt} was started by ${run.actor?.login ?? "nobody known"}, triggered by ${run.triggering_actor?.login ?? "nobody known"}, not ${this.cfg.actor.login}`);
    if (now - Date.parse(run.created_at) > this.cfg.runHours * 3_600_000 && run.status !== "completed") return done("stuck", `run ${run.id} still ${run.status} after ${this.cfg.runHours} hours`);
    if (auth === "wait" && now - Date.parse(run.created_at) > this.cfg.runHours * 3_600_000) {
      // Bounded: a run that has stayed unauthenticated for longer than any run may take is not followed any further.
      return done("unauthenticated", `run ${run.id}'s attempt ${run.run_attempt} could not be matched to an authenticated listing within ${this.cfg.runHours} hours of its start (the listing showed ${listed ? `attempt ${listed.run_attempt}` : "no authenticated run"})`);
    }
    if (auth === "wait") {
      this.log.push(`${r.kind} run ${run.id}: attempt ${run.run_attempt} cannot be authenticated yet (the listing shows ${listed ? `attempt ${listed.run_attempt}` : "no authenticated run"}); waiting`);
      return r;
    }
    if (run.status !== "completed") return r;
    const at = await this.completedAt(run);
    if (run.conclusion === "success") {
      // A green run counts only with GitHub's own completion time, which the validity window runs from.
      if (at === null) {
        this.log.push(`${r.kind} run ${run.id}: completed, but its jobs do not yet say when; waiting`);
        return r;
      }
      return done("success", `run ${run.id}, attempt ${run.run_attempt}, completed ${at}`, at);
    }
    return done(run.conclusion ?? "unknown", `run ${run.id}, attempt ${run.run_attempt}`, at ?? this.nowIso());
  }

  /**
   * Immediately before the real dispatch (DESIGN.md §8.1): the dry run is
   * looked up again, authenticated and unique, and its latest attempt must
   * still be a success that completed inside dryRunValidMinutes. A rerun
   * that failed, a deleted run, or a second run carrying its id each stop it.
   */
  private async confirmDry(c: DispatchCandidate): Promise<{ ok: true } | { ok: false; wait: true; why: string } | { ok: false; wait: false; why: string; conclusion: string }> {
    const dry = c.dry!;
    const f = await this.findRun(dry);
    if (f.kind === "unsure") return { ok: false, wait: true, why: "the dry run's listing is incomplete" };
    if (f.kind === "many") return { ok: false, wait: false, why: `runs ${f.ids.join(", ")} all carry its dispatch id`, conclusion: "ambiguous" };
    if (f.kind === "none" || f.run.id !== dry.run!.id) return { ok: false, wait: false, why: `run ${dry.run!.id} is no longer the one run carrying its dispatch id`, conclusion: "missing" };
    const run = await this.target.getRun(dry.run!.id);
    if (!run) return { ok: false, wait: false, why: `run ${dry.run!.id} can no longer be read`, conclusion: "missing" };
    const auth = this.authenticate(f.run, run);
    if (auth === "foreign") return { ok: false, wait: false, why: `run ${run.id}'s attempt ${run.run_attempt} was triggered by ${run.triggering_actor?.login ?? "nobody known"}, not ${this.cfg.actor.login}`, conclusion: "foreign-attempt" };
    if (auth === "wait") return { ok: false, wait: true, why: `run ${run.id}'s attempt ${run.run_attempt} does not match the authenticated listing's attempt ${f.run.run_attempt}` };
    if (run.status !== "completed") return { ok: false, wait: true, why: `run ${run.id} is running again (attempt ${run.run_attempt})` };
    if (run.conclusion !== "success") return { ok: false, wait: false, why: `run ${run.id}'s attempt ${run.run_attempt} concluded ${run.conclusion}`, conclusion: run.conclusion ?? "unknown" };
    const at = await this.completedAt(run);
    if (at === null) return { ok: false, wait: true, why: `run ${run.id}'s completion time cannot be read` };
    if (this.now() - Date.parse(at) > this.cfg.dryRunValidMinutes * 60_000) return { ok: false, wait: false, why: `run ${run.id} completed at ${at}, more than ${this.cfg.dryRunValidMinutes} minutes ago`, conclusion: "expired" };
    return { ok: true };
  }

  /** Step 3: the candidate's runs in flight. */
  private async followInFlight(): Promise<void> {
    const c = this.ds().candidate;
    if (!c) return;
    let next = c;
    for (const kind of ["dry", "real"] as const) {
      const rec = next[kind];
      if (rec && rec.conclusion === null) next = { ...next, [kind]: await this.follow(rec, c.sha) };
    }
    if (!Bun.deepEquals(next, c, true)) {
      this.setCandidate(next);
      await this.save();
    }
  }

  // ---------------------------------------------------------------- the status issue

  private async status(): Promise<{ number: number } | null> {
    if (this.statusIssue !== undefined) return this.statusIssue;
    const label = this.deps.cfg.names.watchdogLabels.status;
    try {
      const l = await this.d.repo.listOpenIssues(label);
      this.statusIssue = l.issues[0] ? { number: l.issues[0].number } : null;
      if (!this.statusIssue) this.log.push(`no open ${label} issue: the candidate is reported, and approvals read, once the watchdog has opened it`);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      this.log.push(`the ${label} issue could not be listed: ${String(e)}`);
      this.statusIssue = null;
    }
    return this.statusIssue;
  }

  private reportBody(c: DispatchCandidate, jobs: { name: string; conclusion: string | null }[]): string {
    const until = new Date(Date.parse(c.dry!.concludedAt!) + this.cfg.dryRunValidMinutes * 60_000).toISOString();
    const listed = jobs.slice(0, REPORT_JOBS).map((j) => `- ${plain(j.name)}: ${plain(j.conclusion ?? "unknown", 20)}`);
    return [
      `${RELEASE_REPORT_MARKER}${c.sha} ${c.dry!.id} -->`,
      `Release candidate \`${c.sha}\` passed its dry run: ${c.dry!.run!.url}`,
      "",
      ...(listed.length ? ["Jobs of the dry run:", ...listed, ...(jobs.length > REPORT_JOBS ? [`- and ${jobs.length - REPORT_JOBS} more`] : []), ""] : []),
      `To release it, one of ${this.cfg.approvers.map((h) => `\`${h.login}\``).join(", ")} posts a comment on this issue whose whole body is:`,
      "",
      "```",
      `${APPROVE_RELEASE} ${c.sha}`,
      "```",
      "",
      `The approval counts for this sha only, and only until ${until}. A newer qualified commit on main replaces this candidate.`,
    ].join("\n");
  }

  /** Report a green dry run once, on the status issue. Best effort: a failure is logged and retried next tick, never a pause. */
  private async report(c: DispatchCandidate): Promise<DispatchCandidate> {
    if (c.reported) return c;
    const issue = await this.status();
    if (!issue) return c;
    // One report per attempt: a re-armed attempt's green dry run is reported afresh.
    const marker = `${RELEASE_REPORT_MARKER}${c.sha} ${c.dry!.id} -->`;
    try {
      const posted = (await this.d.repo.listIssueComments(issue.number)).items.find((x) => x.body.startsWith(marker));
      let id = posted?.id;
      if (id === undefined) {
        const jobs = await this.target.listJobs(c.dry!.run!.id).then((l) => l.items.map((j) => ({ name: j.name, conclusion: j.conclusion })), () => []);
        id = await this.d.repo.commentIssue(issue.number, this.reportBody(c, jobs));
        this.log.push(`reported candidate ${c.sha.slice(0, 8)} on #${issue.number}`);
      }
      const next = { ...c, reported: { issue: issue.number, comment: id, at: this.nowIso() } };
      this.setCandidate(next);
      await this.save();
      return next;
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      this.log.push(`candidate report not posted: ${String(e)}`);
      return c;
    }
  }

  /** The approval for this candidate, if one counts; every approve-release comment that does not count is logged with why. */
  private async approval(c: DispatchCandidate): Promise<IssueComment | null> {
    const issue = await this.status();
    if (!issue) return null;
    let comments: IssueComment[];
    try {
      comments = (await this.d.repo.listIssueComments(issue.number)).items;
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      this.log.push(`approvals not read: ${String(e)}`);
      return null;
    }
    const { approval, refused } = releaseApproval(comments, this.cfg.approvers, c.sha, new Date(Date.parse(c.dry!.run!.createdAt)));
    for (const r of refused) this.log.push(`approval refused: ${r}`);
    if (!approval) this.log.push(`waiting for \`${APPROVE_RELEASE} ${c.sha}\` on #${issue.number} from ${this.cfg.approvers.map((h) => h.login).join(", ")}`);
    return approval;
  }

  // ---------------------------------------------------------------- guards on a new dispatch

  /** A freeze variable at its value stops new dispatches; one that cannot be read counts as frozen. */
  private async frozen(): Promise<string | null> {
    for (const f of this.cfg.freeze) {
      let v: string | null;
      try {
        v = await this.target.readVariable(f.variable);
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        return `the freeze variable ${f.variable} could not be read (${e.message}), which counts as frozen`;
      }
      if (v === f.value) return `the target variable ${f.variable} is ${JSON.stringify(f.value)}`;
    }
    return null;
  }

  /** The budget window, pruned to the last windowHours. */
  private window(): string[] {
    const h = this.cfg.budget.windowHours * 3_600_000;
    return this.ds().window.filter((t) => this.now() - Date.parse(t) < h);
  }

  // ---------------------------------------------------------------- one dispatch: intent, request, receipt

  private async dispatch(c: DispatchCandidate, kind: DispatchKind, also: Partial<DispatchCandidate> = {}): Promise<ReleaseOutcome> {
    const frozen = await this.frozen();
    if (frozen) {
      this.log.push(`frozen: ${frozen}; no ${kind} run is dispatched`);
      return "waiting";
    }
    const window = this.window();
    if (window.length >= this.cfg.budget.window) {
      await this.alert(`release-blocked: the dispatch budget is spent (${window.length} dispatches in ${this.cfg.budget.windowHours} hours, release.dispatch.budget); ${c.sha} waits for it`);
      return "alert";
    }
    if (c.refused >= DISPATCH_REFUSALS) return "alert"; // its alert is already open; a newer candidate starts again
    // The durable once-per-sha guard (DESIGN.md §8.1), whatever history has been pruned: a dry run only for a strict
    // descendant of the last dispatched sha, a real run only for the sha whose dry run was the last dispatch.
    // A re-armed candidate may have one more dry run of the last sha dispatched, only while its re-arm still names that
    // sha's last attempt, now closed: the new intent replaces `last`, so the same re-arm can never authorise another.
    const hw = this.ds().highWater;
    const prevLast = this.ds().last;
    const rearmed = kind === "dry" && c.rearm !== null && hw === c.sha && prevLast?.sha === c.sha && prevLast.id === c.rearm.incident && prevLast.closedAt !== null;
    if (kind === "real" ? hw !== c.sha : !rearmed && hw !== null && (hw === c.sha || (await this.target.compare(hw, c.sha)).status !== "ahead")) {
      this.log.push(`not dispatching the ${kind} run for ${c.sha}: ${hw} was dispatched last, and a sha is dispatched once per authorised attempt`);
      return "none";
    }
    const seq = this.state.seq + 1;
    const id = dispatchIdFor(kind, c.sha, seq, this.store.runId);
    const at = this.nowIso();
    const j: DispatchJournal = { seq, op: "dispatch", kind, sha: c.sha, id, at };
    const cand: DispatchCandidate = { ...c, ...also };
    // The intent, its budget reservation and the candidate it is for: one write, before anything is sent.
    // highWater rides in the same write: once this intent is durable, no sha at or behind it is ever dispatched again.
    this.setDs({ ...this.ds(), candidate: cand, highWater: c.sha, last: { sha: c.sha, id, closedAt: null }, window: [...window, at] }, { seq, journal: j });
    await this.save();
    this.crash("after-intent");
    const i = this.cfg.inputs;
    let sent: DispatchRecord["sent"] = "yes";
    try {
      await this.target.dispatchWorkflow(this.cfg.workflow, this.cfg.ref, { [i.sha]: c.sha, [i.dryRun]: kind === "dry" ? "true" : "false", [i.dispatchId]: id });
      this.crash("after-effect");
    } catch (e) {
      if (e instanceof CrashError || e instanceof LostLockError || !(e instanceof GitHubError)) throw e;
      if (e.kind === "server" || e.kind === "network") {
        // Ambiguous: GitHub may have started the run. It is looked for, never resent.
        sent = "unknown";
        this.log.push(`dispatch ${kind} ${c.sha.slice(0, 8)}: no answer (${String(e)}); looking for its run`);
      } else {
        // GitHub answered and refused (or the client refused before sending): nothing started, so no record. The reservation stays spent.
        const refused = e.kind === "rate_limit" ? cand.refused : cand.refused + 1;
        // Nothing started, so the high-water mark goes back to what it was: this sha may be dispatched again.
        this.setDs({ ...this.ds(), candidate: { ...cand, refused }, highWater: hw, last: prevLast }, { journal: null });
        await this.save();
        this.log.push(`dispatch ${kind} ${c.sha.slice(0, 8)} refused: ${String(e)}`);
        if (e.kind === "rate_limit") return "retry-later";
        await this.alert(`release-blocked: GitHub refused the ${kind} dispatch of ${this.cfg.workflow} for ${c.sha} (${refused} of ${DISPATCH_REFUSALS}${refused >= DISPATCH_REFUSALS ? "; not retried for this commit" : "; retried next tick"}): ${e.message}`);
        return "rejected";
      }
    }
    const rec: DispatchRecord = { kind, id, at, sent, run: null, conclusion: null, concludedAt: null };
    this.setCandidate({ ...cand, [kind]: rec }, { journal: null });
    this.log.push(`dispatched the ${kind} run for ${c.sha.slice(0, 8)} (${id})`);
    await this.save();
    this.crash("after-receipt");
    return "dispatched";
  }

  // ---------------------------------------------------------------- closing a candidate

  private async close(c: DispatchCandidate, outcome: DispatchOutcome, note: string, also: Partial<ReleaseState> = {}): Promise<void> {
    const ds = this.ds();
    const item: DispatchHistoryItem = { at: this.nowIso(), sha: c.sha, outcome, note, dryRun: c.dry?.run?.id ?? null, realRun: c.real?.run?.id ?? null };
    this.log.push(`candidate ${c.sha.slice(0, 8)}: ${outcome} (${note})`);
    // The attempt's end, which a re-arm must postdate; only for the candidate the last dispatch was for.
    const last = ds.last && ds.last.sha === c.sha && (c.dry || c.real) && ds.last.closedAt === null ? { ...ds.last, closedAt: this.nowIso() } : ds.last;
    this.setDs({ ...ds, candidate: null, last, history: [...ds.history, item].slice(-this.deps.cfg.historyLimit) }, also);
    await this.save();
  }

  /** Whether release is at `sha` or has moved past it. Reads only. */
  private async reached(release: string | null, sha: string): Promise<boolean> {
    if (release === null) return false;
    if (release === sha) return true;
    const s = (await this.target.compare(sha, release)).status;
    return s === "ahead" || s === "identical";
  }

  /**
   * A real run, once dispatched, is followed to its end: it is never
   * superseded. Only a green run with release seen at the commit (or past it)
   * is a release. Every other ending is an incomplete promotion, and pauses
   * the release job (never the queue): a red or cancelled run, a green run
   * that never moved release, a red run although release moved (the ref alone
   * proves nothing about the rest of the promotion), and a run that could not
   * be followed. The candidate's close and the pending pause are one state
   * write, so no interruption can drop the pause.
   */
  private async followReal(c: DispatchCandidate): Promise<ReleaseOutcome> {
    const r = c.real!;
    const url = r.run?.url ?? `no run found (dispatch id ${r.id})`;
    if (r.conclusion === null) {
      this.log.push(`waiting: the real run for ${c.sha.slice(0, 8)} is in flight (${url})`);
      return "waiting";
    }
    const cur = await this.target.getRef(this.deps.cfg.names.release);
    const reached = await this.reached(cur, c.sha);
    const seen = `release is ${cur ?? "absent"}${reached ? (cur === c.sha ? ", at it" : ", past it") : ", not at it"}`;
    if (r.conclusion === "success" && reached) {
      const note = `release seen at ${cur}${cur === c.sha ? "" : ", a descendant"} after the real run concluded success (${url})`;
      const history = [...this.state.history, { at: this.nowIso(), outcome: "advanced" as const, from: c.receipt.from, to: c.sha, note, receipt: c.receipt }].slice(-this.deps.cfg.historyLimit);
      await this.close(c, "released", note, { history });
      return "advanced";
    }
    if (r.conclusion === "success" && this.now() - Date.parse(r.concludedAt!) < this.cfg.observeMinutes * 60_000) {
      this.log.push(`waiting: the real run for ${c.sha.slice(0, 8)} is green; ${seen} yet`);
      return "waiting";
    }
    const outcome: DispatchOutcome = r.conclusion === "success" ? "not-observed" : reached ? "incomplete" : "real-failed";
    const what =
      r.conclusion === "success"
        ? `was green but ${seen} ${this.cfg.observeMinutes} minutes later`
        : UNFOLLOWED.has(r.conclusion)
          ? `could not be followed (${r.conclusion}); it may still be promoting, and ${seen}`
          : `concluded ${r.conclusion}, and ${seen}${reached ? ", which alone does not show the promotion finished" : ""}`;
    const reason = `the real run for ${c.sha} (${url}) ${what}. Production may have changed: check the promotion, and the target's ${this.cfg.workflow} runs, before closing this issue. Closing it resumes the release job toward the newest qualified commit; ${REARM_RELEASE} ${c.sha} ${r.id} on the status issue grants this commit one more attempt`;
    this.log.push(`pause: ${reason}`);
    // A release ref that moved is still recorded, as release history, but not as a release of ours.
    const history = reached ? { history: [...this.state.history, { at: this.nowIso(), outcome: "moved" as const, from: c.receipt.from, to: c.sha, note: `release reached it, but the real run concluded ${r.conclusion}`, receipt: null }].slice(-this.deps.cfg.historyLimit) } : {};
    await this.close(c, outcome, `the real run concluded ${r.conclusion}; ${seen}`, { ...history, pausePending: this.pending(reason) });
    await this.applyPause();
    return "paused";
  }

  /** A re-arm on the status issue for the last sha dispatched, bound to its last attempt; refusals are logged. */
  private async findRearm(sha: string): Promise<IssueComment | null> {
    const last = this.ds().last;
    if (!last || last.sha !== sha || last.closedAt === null) return null;
    const issue = await this.status();
    if (!issue) return null;
    let comments: IssueComment[];
    try {
      comments = (await this.d.repo.listIssueComments(issue.number)).items;
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      this.log.push(`re-arms not read: ${String(e)}`);
      return null;
    }
    const { rearm, refused } = releaseRearm(comments, this.cfg.approvers, sha, last.id, new Date(Date.parse(last.closedAt)));
    for (const r of refused) this.log.push(`re-arm refused: ${r}`);
    return rearm;
  }

  // ---------------------------------------------------------------- the tick

  async run(): Promise<ReleaseOutcome> {
    await this.reconcile();
    await this.applyPause();
    const paused = await this.paused();
    await this.followInFlight();
    if (paused) {
      this.log.push("paused: an open release-pause issue (or a pending pause); runs in flight are still followed, nothing is dispatched");
      return "paused";
    }
    const { decision, release, main } = await discoverRelease(this.target, this.deps.cfg);
    this.decision = decision;
    const reason = describeDispatch(this.state, decision);
    this.state = { ...this.state, last: { at: this.nowIso(), kind: decision.kind, reason, release, main } };
    this.log.push(`${decision.kind}: ${reason}`);
    await this.save();
    return this.step(decision, release);
  }

  private async step(decision: ReleaseDecision, release: string | null): Promise<ReleaseOutcome> {
    let c = this.ds().candidate;
    if (c?.real) return this.followReal(c);
    if (c?.dry && c.dry.conclusion === null) {
      this.log.push(`waiting: the dry run for ${c.sha.slice(0, 8)} is in flight; one target run at a time`);
      return "waiting";
    }
    if (c && (await this.reached(release, c.sha))) {
      await this.close(c, "released-elsewhere", `release reached it (${release}) without a real run of ours`);
      c = null;
    }
    if (decision.kind === "alert") {
      await this.alert(decision.reason);
      return "alert";
    }
    if (decision.kind === "none") return "none";
    if (c && c.sha !== decision.to) {
      await this.close(c, "superseded", `${decision.to} is newer and qualified`);
      c = null;
    }
    if (!c) {
      const seen = this.ds().history.find((h) => h.sha === decision.to);
      const hw = this.ds().highWater;
      const behind = hw !== null && (hw === decision.to || (await this.target.compare(hw, decision.to)).status !== "ahead");
      // A re-arm applies only while this sha is still the newest qualified commit, a strict descendant of release
      // (the decision rechecks both), and the last sha dispatched; a newer commit takes its place instead.
      const rearm = hw === decision.to ? await this.findRearm(decision.to) : null;
      if ((seen || behind) && !rearm) {
        this.log.push(`${decision.to.slice(0, 8)} is not newer than ${behind ? `${hw}, the last sha dispatched` : `its own earlier dry run (${seen!.outcome})`}; waiting for a newer commit, or \`${REARM_RELEASE} ${decision.to} <incident>\``);
        return "none";
      }
      if (rearm) this.log.push(`re-armed: ${decision.to.slice(0, 8)} gets one more attempt (comment ${rearm.id} by ${rearm.user.login}), from a fresh dry run`);
      c = {
        sha: decision.to,
        receipt: decision.receipt,
        since: this.nowIso(),
        dry: null,
        reported: null,
        approval: null,
        real: null,
        refused: 0,
        rearm: rearm ? { comment: rearm.id, login: rearm.user.login, id: rearm.user.id, incident: this.ds().last!.id, at: rearm.created_at } : null,
      };
      this.setCandidate(c);
      await this.save();
    } else if (!Bun.deepEquals(c.receipt, decision.receipt, true)) {
      c = { ...c, receipt: decision.receipt };
      this.setCandidate(c);
      await this.save();
    }
    if (!c.dry) return this.dispatch(c, "dry");
    const dry = c.dry;
    if (dry.conclusion !== "success") {
      const run = dry.run ? `: ${dry.run.url}` : "";
      await this.close(c, "dry-failed", `the dry run concluded ${dry.conclusion}`);
      await this.alert(`release-blocked: the dry run for ${c.sha} concluded ${dry.conclusion}${run}. It is not dispatched again for this commit; a newer qualified commit gets its own dry run`);
      return "alert";
    }
    if (this.now() - Date.parse(dry.concludedAt!) > this.cfg.dryRunValidMinutes * 60_000) {
      await this.close(c, "expired", `no approval within ${this.cfg.dryRunValidMinutes} minutes of the green dry run`);
      await this.alert(`release-blocked: the green dry run for ${c.sha} is older than ${this.cfg.dryRunValidMinutes} minutes (release.dispatch.dryRunValidMinutes) and was not approved; a newer qualified commit gets its own dry run`);
      return "alert";
    }
    c = await this.report(c);
    const approval = await this.approval(c);
    if (!approval) return "waiting";
    const fresh = await this.confirmDry(c);
    if (!fresh.ok) {
      if (fresh.wait) {
        this.log.push(`waiting: the dry run for ${c.sha.slice(0, 8)} cannot be confirmed yet (${fresh.why})`);
        return "waiting";
      }
      const outcome = fresh.conclusion === "expired" ? "expired" : "dry-failed";
      await this.close(c, outcome, `rechecked before the real run: ${fresh.why}`);
      await this.alert(`release-blocked: the dry run for ${c.sha} no longer stands (${fresh.why}); no real run is dispatched for this commit`);
      return "alert";
    }
    return this.dispatch(c, "real", { approval: { comment: approval.id, login: approval.user.login, id: approval.user.id, at: approval.created_at } });
  }
}
