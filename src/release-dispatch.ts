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
import { APPROVE_RELEASE, releaseApproval } from "./evidence";
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
    advanceEpoch: (b, m) => t.advanceEpoch(b, m),
    dispatchWorkflow: (w, r, i) => t.dispatchWorkflow(w, r, i),
  };
}

/** Definite refusals (GitHub answered 4xx, so nothing started) retried per candidate before giving up on it. */
export const DISPATCH_REFUSALS = 3;
/** A run is matched only if created no earlier than this before its intent: runner and GitHub clocks differ. */
export const CLOCK_SLACK_MS = 5 * 60_000;
/** Pages of the workflow's runs read when looking for a dispatched run. */
const RUN_PAGES = 2;
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
const UNFOLLOWED = new Set(["never-appeared", "stuck", "ambiguous", "missing"]);

/** Untrusted target text for an issue comment: one line, no markdown that could break out of a code span, bounded. */
const plain = (s: string, max = 100) => s.replace(/[\s`<>]+/g, " ").trim().slice(0, max);

/** What a live dispatch-mode tick would do next, in words (the release dry run's line). Pure. */
export function describeDispatch(state: ReleaseState, decision: ReleaseDecision): string {
  const c = state.dispatch?.candidate ?? null;
  if (c?.real || (c?.dry && c.dry.conclusion === null)) return `candidate ${c.sha}: ${candidateStage(c)}; a live tick would follow it`;
  if (decision.kind !== "advance") return `${decision.kind}: ${decision.reason}${c ? `; candidate ${c.sha}: ${candidateStage(c)}` : ""}`;
  if (!c || c.sha !== decision.to) {
    if (state.dispatch?.history.some((h) => h.sha === decision.to)) return `${decision.to} already had its dry run; a live tick would wait for a newer commit`;
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

  /** The runs of the configured workflow that echo `id`, started by a dispatch on the configured ref in the target itself. */
  private async findRun(rec: DispatchRecord): Promise<{ kind: "found"; run: Run } | { kind: "none"; truncated: boolean } | { kind: "many"; ids: number[] }> {
    const repoId = this.target.repoId;
    const created = new Date(Date.parse(rec.at) - CLOCK_SLACK_MS);
    const l: Listed<Run> = await this.target.listWorkflowRuns(this.cfg.workflow, { branch: this.cfg.ref, event: "workflow_dispatch", created, maxPages: RUN_PAGES });
    const hits = l.items.filter(
      (r) =>
        r.path === this.cfg.workflow &&
        r.event === "workflow_dispatch" &&
        r.head_branch === this.cfg.ref &&
        r.repository?.id === repoId &&
        r.head_repository?.id === repoId &&
        typeof r.display_title === "string" &&
        echoesId(r.display_title, rec.id),
    );
    if (hits.length > 1) return { kind: "many", ids: hits.map((r) => r.id) };
    if (hits.length === 1) return { kind: "found", run: hits[0]! };
    return { kind: "none", truncated: l.truncated };
  }

  /** Record what is known now about one run in flight. Reads only, so it runs while paused too. */
  private async follow(rec: DispatchRecord, sha: string): Promise<DispatchRecord> {
    const now = this.now();
    let r = rec;
    const done = (conclusion: string, why: string): DispatchRecord => {
      this.log.push(`${r.kind} run for ${sha.slice(0, 8)}: ${conclusion} (${why})`);
      return { ...r, conclusion, concludedAt: this.nowIso() };
    };
    if (!r.run) {
      const f = await this.findRun(r);
      if (f.kind === "many") return done("ambiguous", `runs ${f.ids.join(", ")} all carry dispatch id ${r.id}`);
      if (f.kind === "none") {
        if (now - Date.parse(r.at) < this.cfg.appearMinutes * 60_000) {
          this.log.push(`${r.kind} run for ${sha.slice(0, 8)}: not found yet (${r.id}${f.truncated ? ", listing incomplete" : ""})`);
          return r;
        }
        return done("never-appeared", `no run of ${this.cfg.workflow} named with ${r.id} within ${this.cfg.appearMinutes} minutes${r.sent === "unknown" ? "; the request's response was lost" : ""}`);
      }
      r = { ...r, run: { id: f.run.id, url: runUrl(this.deps.cfg, f.run.id) } };
      this.log.push(`${r.kind} run for ${sha.slice(0, 8)}: found run ${f.run.id}`);
    }
    const run = await this.target.getRun(r.run!.id);
    if (!run) return done("missing", `run ${r.run!.id} can no longer be read`);
    if (run.status === "completed") return done(run.conclusion ?? "unknown", `run ${run.id}, attempt ${run.run_attempt}`);
    if (now - Date.parse(run.created_at) > this.cfg.runHours * 3_600_000) return done("stuck", `run ${run.id} still ${run.status} after ${this.cfg.runHours} hours`);
    return r;
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
      `${RELEASE_REPORT_MARKER}${c.sha} -->`,
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
    const marker = `${RELEASE_REPORT_MARKER}${c.sha} -->`;
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
    const { approval, refused } = releaseApproval(comments, this.cfg.approvers, c.sha, new Date(Date.parse(c.dry!.at)));
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
    const seq = this.state.seq + 1;
    const id = dispatchIdFor(kind, c.sha, seq, this.store.runId);
    const at = this.nowIso();
    const j: DispatchJournal = { seq, op: "dispatch", kind, sha: c.sha, id, at };
    const cand: DispatchCandidate = { ...c, ...also };
    // The intent, its budget reservation and the candidate it is for: one write, before anything is sent.
    this.setDs({ ...this.ds(), candidate: cand, window: [...window, at] }, { seq, journal: j });
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
        this.setCandidate({ ...cand, refused }, { journal: null });
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
    this.setDs({ ...ds, candidate: null, history: [...ds.history, item].slice(-this.deps.cfg.historyLimit) }, also);
    await this.save();
  }

  /** Whether release is at `sha` or has moved past it. Reads only. */
  private async reached(release: string | null, sha: string): Promise<boolean> {
    if (release === null) return false;
    if (release === sha) return true;
    const s = (await this.target.compare(sha, release)).status;
    return s === "ahead" || s === "identical";
  }

  /** A real run, once dispatched, is followed to its end: it is never superseded, and the release ref decides. */
  private async followReal(c: DispatchCandidate): Promise<ReleaseOutcome> {
    const r = c.real!;
    const run = r.run ? ` (run ${r.run.url})` : "";
    if (r.conclusion === null) {
      this.log.push(`waiting: the real run for ${c.sha.slice(0, 8)} is in flight${run}`);
      return "waiting";
    }
    const cur = await this.target.getRef(this.deps.cfg.names.release);
    if (await this.reached(cur, c.sha)) {
      const note = `release seen at ${cur}${cur === c.sha ? "" : ", a descendant"} after the real run concluded ${r.conclusion}${run}`;
      const history = [...this.state.history, { at: this.nowIso(), outcome: "advanced" as const, from: c.receipt.from, to: c.sha, note, receipt: c.receipt }].slice(-this.deps.cfg.historyLimit);
      await this.close(c, "released", note, { history });
      if (r.conclusion !== "success") await this.alert(`release reached ${c.sha}, but its real run concluded ${r.conclusion}${run}: check the promotion`);
      return "advanced";
    }
    if (r.conclusion === "success") {
      if (this.now() - Date.parse(r.concludedAt!) < this.cfg.observeMinutes * 60_000) {
        this.log.push(`waiting: the real run for ${c.sha.slice(0, 8)} is green; release is ${cur ?? "absent"}, not at it yet`);
        return "waiting";
      }
      await this.close(c, "not-observed", `the real run was green but release is ${cur ?? "absent"}`);
      await this.alert(`release-blocked: the real run for ${c.sha} was green${run}, but release is ${cur ?? "absent"}, not at it, ${this.cfg.observeMinutes} minutes later. It is never dispatched again for this commit`);
      return "alert";
    }
    await this.close(c, "real-failed", `the real run concluded ${r.conclusion}`);
    if (UNFOLLOWED.has(r.conclusion)) {
      // Nobody knows whether a promotion is running: stop until a person has looked.
      await this.pause(`the real run for ${c.sha} could not be followed (${r.conclusion}, dispatch id ${r.id})${run}; it may still be promoting. Check the target's ${this.cfg.workflow} runs before closing this issue`);
      return "paused";
    }
    await this.alert(`release-blocked: the real run for ${c.sha} concluded ${r.conclusion}${run}. It is never dispatched again for this commit; a newer qualified commit gets its own dry run`);
    return "alert";
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
      if (seen) {
        this.log.push(`${decision.to.slice(0, 8)} already had its dry run (${seen.outcome}); waiting for a newer commit`);
        return "none";
      }
      c = { sha: decision.to, receipt: decision.receipt, since: this.nowIso(), dry: null, reported: null, approval: null, real: null, refused: 0 };
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
    return this.dispatch(c, "real", { approval: { comment: approval.id, login: approval.user.login, id: approval.user.id, at: approval.created_at } });
  }
}
