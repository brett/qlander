// The release advance runner (DESIGN.md §8): one tick of the release job.
// It runs under the qlander-release App only, with its own state ref
// (the qlander-release-state branch), its own lease and its own pause label.
//
//   1. take the release lease (corrupt → pause; held → busy). The lease
//      records this Actions job; an expired lease is taken over only once
//      GitHub reports its job completed, past the kill deadline and grace (§15)
//   2. reconcile a leftover `advance(R → C)` intent by observation (§3.2),
//      even while paused: it only records what already happened
//   3. apply a pending pause; stop if paused (an open `release-pause` issue)
//   4. discover: compare release...main, fully paginated; a cut listing is
//      `truncated` (an alert), never "nothing eligible"
//   5. for each commit on main's first-parent chain, newest first: the
//      qualification provider's screen (a status and its proof run), a
//      strict-descendant check, and the provider's judgement (for a manifest,
//      qlander's own re-evaluation); the first that passes wins
//   6. persist the intent, then CAS release R → C (fenced by the
//      lease, beforeOid R, force false), then the receipt
//   7. release the lease; mirror the state to its issue
//
// A dry run (releaseDryRun: QLANDER_MODE is not "live", or the release is
// held by ReleaseConfig.dryRun) makes the same reads and decision with a
// read-only target client, and writes nothing anywhere: no lease, no state,
// no issues.
//
// Nothing here checks out or runs target code.

import type { TargetApi, TargetReads, StateRefApi, StateRepoApi } from "./github/api";
import { GitHubError, isGraphqlInternal } from "./github/http";
import { epochClientProblem, invariantProblems } from "./config";
import { epochHandover, fenced } from "./fenced";
import { CrashError, type CrashPoint } from "./queue";
import { CONTROL_ROOT } from "./config/load";
import { controlFileReader, qualificationProvider, type QualificationProvider } from "./qualification";
import { preflightRefs, type Receipt, type ReceiptEvidence, type ReleaseDecision } from "./release";
import type { ReleaseConfig } from "./release-config";
import { type AdvanceJournal, emptyReleaseState, parseReleaseState, releaseCodec, type ReleaseState, renderReleaseState } from "./release-state";
import { type EpochBox, ReleaseTickBase, type ReleaseOutcome } from "./release-tick";
import { DispatchTick, dispatchOnly, describeDispatch } from "./release-dispatch";
import type { Executor } from "./state";
import { isTransient as isTransientError, openOnce, pauseReason } from "./outbox";
export type { ReleaseOutcome } from "./release-tick";
import { CorruptStateError, inspectState, LeaseHeldError, LostLockError, StateStore, upsertMirror } from "./store";
import { isSha } from "./validate";

/** The release job keeps no count of GitHub's generic GraphQL error (src/queue.ts does), so here it stays a hard failure. */
const isTransient = (e: unknown) => isTransientError(e) && !isGraphqlInternal(e);

export interface ReleaseDeps {
  /** The target client, connected with the release App's token (role "release", or "read" in dry run). */
  target: TargetApi;
  repo: StateRepoApi;
  /** The qlander-release-state branch, written with the qlander-state App's token. */
  stateRef: StateRefApi;
  cfg: ReleaseConfig;
  now: () => Date;
  runId: string;
  /** The Actions job running this tick; recorded in the lease (DESIGN.md §15). Always set in production. */
  executor?: Executor | null;
  crash?: (point: CrashPoint) => void;
}

export interface ReleaseResult {
  outcome: ReleaseOutcome;
  log: string[];
  decision: ReleaseDecision | null;
}

/** main's first-parent chain, newest first, within the listed commits of release...main. */
export function firstParentChain(main: string, commits: { sha: string; parents: string[] }[]): string[] {
  const by = new Map(commits.map((c) => [c.sha, c]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | undefined = main; cur !== undefined && by.has(cur) && !seen.has(cur); cur = by.get(cur)!.parents[0]) {
    seen.add(cur);
    out.push(cur);
  }
  return out;
}

export interface Discovery {
  decision: ReleaseDecision;
  release: string | null;
  main: string | null;
}

/** Steps 4 and 5: the newest qualified commit, or why there is none. Reads only. */
export async function discoverRelease(c: TargetReads, cfg: ReleaseConfig, readControlFile: (path: string) => string | null = controlFileReader(CONTROL_ROOT)): Promise<Discovery> {
  const release = await c.getRef(cfg.names.release);
  const main = await c.getRef(cfg.names.main);
  // §8 step 1: no release branch → stop; an operator creates it.
  if (release === null) return { decision: { kind: "none", reason: "release branch does not exist" }, release, main };
  if (main === null) return { decision: { kind: "alert", reason: "main does not exist" }, release, main };
  const cmp = await c.compare(release, main);
  let chain: string[] = [];
  let truncated = cmp.commitsTruncated;
  if (cmp.status === "ahead") {
    chain = firstParentChain(main, cmp.commits);
    // An ahead compare whose listing lacks main itself is incomplete, whatever it says.
    if (chain.length === 0) truncated = true;
  }
  const pre = preflightRefs({ release, main, releaseToMain: cmp.status, truncated });
  if (pre.kind !== "go") return { decision: pre, release, main };
  const provider = qualificationProvider(cfg.qualification, { target: c, names: cfg.names, readControlFile });
  const policy = await provider.policy(main);
  if (!policy.ok) return { decision: { kind: "alert", reason: policy.reason }, release, main };
  const refused: string[] = [];
  for (const [i, sha] of chain.entries()) {
    if (i >= cfg.maxCandidates) {
      return { decision: { kind: "alert", reason: `release-blocked: none of the newest ${cfg.maxCandidates} of ${chain.length} first-parent commits qualified; older ones were not examined (search limit)` }, release, main };
    }
    const j = await judge(c, provider, sha, release);
    if (!j.ok) {
      refused.push(j.reason);
      continue;
    }
    const receipt: Receipt = { from: release, to: sha, policyBlob: policy.version, proofRun: j.proofRun, evidence: j.evidence };
    return { decision: { kind: "advance", from: release, to: sha, receipt }, release, main };
  }
  return { decision: { kind: "none", reason: refused.length ? `no qualified candidate: ${refused.slice(0, 5).join(" | ")}` : "no candidates" }, release, main };
}

/**
 * One candidate, cheapest check first: the provider's screen (a status and
 * its proof run), then ancestry (one compare), then the provider's judgement
 * (for a manifest, the push runs and their jobs). Returns at the first refusal,
 * so later reads are skipped.
 */
async function judge(
  c: TargetReads,
  provider: QualificationProvider,
  sha: string,
  release: string,
): Promise<{ ok: true; proofRun: number | null; evidence: ReceiptEvidence[] } | { ok: false; reason: string }> {
  if (!isSha(sha)) return { ok: false, reason: `${String(sha)}: not a sha` };
  const screened = await provider.screen(sha);
  if (!screened.ok) return screened;
  const fromRelease = (await c.compare(release, sha)).status;
  if (fromRelease !== "ahead") return { ok: false, reason: `${sha}: not a descendant of release (${fromRelease})` };
  const judged = await provider.judge(sha, screened);
  if (!judged.ok) return judged;
  return { ok: true, proofRun: screened.proofRun, evidence: judged.evidence };
}

class ReleaseTick extends ReleaseTickBase {
  constructor(
    d: ReleaseDeps,
    store: StateStore<ReleaseState>,
    state: ReleaseState,
    /** The lease-fenced client (src/fenced.ts): every target write goes through the release lease's fence; reads do not. */
    private readonly target: TargetApi,
    box: EpochBox,
  ) {
    super(d, store, state, target, box);
  }

  /** §3.2, `advance` is reconciled like `land`: by observing release, never by trusting the intent. */
  async reconcile(): Promise<void> {
    const j = this.state.journal;
    if (!j) return;
    // A dispatch intent left by release.mode dispatch, which has since been switched off: settled as dispatch mode would, without resending.
    if (j.op === "dispatch") return this.pause(`a ${j.kind} dispatch for ${j.sha} was in flight when release.mode changed to advance; set release.mode back to dispatch until it settles`);
    return this.reconcileAdvance(j);
  }

  /** Steps 4 and 5, through the fenced client (reads are not fenced). */
  discover(): Promise<Discovery> {
    return discoverRelease(this.target, this.d.cfg);
  }

  /** Step 7: intent, CAS, receipt. */
  async advance(d: Extract<ReleaseDecision, { kind: "advance" }>): Promise<ReleaseOutcome> {
    const j: AdvanceJournal = { seq: this.state.seq + 1, op: "advance", before: d.from, after: d.to, receipt: d.receipt, at: this.nowIso() };
    this.state = { ...this.state, seq: j.seq, journal: j };
    await this.save(); // the intent is durable before anything happens
    this.crash("after-intent");
    try {
      await this.target.updateRef(this.d.cfg.names.release, d.from, d.to); // beforeOid R, force false; fenced
      this.crash("after-effect");
    } catch (e) {
      if (e instanceof CrashError || e instanceof LostLockError) throw e;
      // Judge by the ref, not the error text, exactly as recovery would.
      const { cur, seen } = await this.observe(j);
      if (seen === "target" || seen === "descendant") {
        await this.finishJournal(j, "advanced", seen === "target" ? "applied (response lost)" : `applied (response lost); release has since moved on to ${cur}`);
        return "advanced";
      }
      if (seen === "moved") {
        await this.finishJournal(j, "moved", `${this.movedNote(cur)}; nothing written`);
        return "moved";
      }
      if (isTransient(e)) {
        await this.finishJournal(j, "rejected", String(e));
        return "retry-later";
      }
      // The rejection, the journal's removal and the pending pause are one
      // write: no lost response or crash can leave the journal gone and no pause.
      const reason = `release CAS ${d.from} → ${d.to} was rejected while release was unchanged: ${String(e)}`;
      this.log.push(`pause: ${reason}`);
      await this.finishJournal(j, "rejected", String(e), { pausePending: this.pending(reason) });
      await this.applyPause();
      return "rejected";
    }
    await this.finishJournal(j, "advanced", "applied");
    this.crash("after-receipt");
    return "advanced";
  }

  async run(): Promise<ReleaseOutcome> {
    await this.reconcile();
    await this.applyPause();
    if (await this.paused()) {
      this.log.push("paused: an open release-pause issue (or a pending pause)");
      return "paused";
    }
    const { decision, release, main } = await this.discover();
    this.decision = decision;
    const reason = decision.kind === "advance" ? `advance ${decision.from} → ${decision.to}` : decision.reason;
    this.state = { ...this.state, last: { at: this.nowIso(), kind: decision.kind, reason, release, main } };
    this.log.push(`${decision.kind}: ${reason}`);
    await this.save();
    if (decision.kind === "alert") {
      await this.alert(decision.reason);
      return "alert";
    }
    if (decision.kind === "none") return "none";
    return this.advance(decision);
  }
}

/**
 * One release tick. Transient errors retry next tick; other GitHub errors
 * pause the release job durably. A crash leaves the lease to expire and the
 * journal to recovery.
 */
export async function releaseTick(d: ReleaseDeps): Promise<ReleaseResult> {
  const refused = epochClientProblem(d.cfg.runner, d.target.epochBranch, "release");
  if (refused) throw new Error(`refusing to run: ${refused}`);
  const broken = invariantProblems(d.cfg, d.cfg.runner.cronMinutes);
  if (broken.length > 0) throw new Error(`refusing to run: ${broken.join("; ")}`);
  if (!d.cfg.enabled) throw new Error("refusing to run live: release advance is not enabled (release.enabled)");
  if (d.cfg.dryRun) throw new Error("refusing to run live: release advance is held in dry run (ReleaseConfig.dryRun)");
  let opened: { store: StateStore<ReleaseState>; state: ReleaseState; handover?: string };
  try {
    opened = await StateStore.open(d.stateRef, d.repo, d.runId, d.cfg, d.executor ?? null, releaseCodec(d.cfg.names.releaseLabels.mirror), epochHandover(d.target, d.cfg.runner, "release", d.runId));
  } catch (e) {
    if (e instanceof CorruptStateError) {
      await openOnce(d.repo, d.cfg.names.releaseLabels.pause, "release:corrupt-state", "qlander release paused: corrupt state", e.message);
      return { outcome: "paused", log: [e.message], decision: null };
    }
    if (e instanceof LeaseHeldError) return { outcome: "busy", log: [e.message], decision: null };
    if (isTransient(e)) return { outcome: "retry-later", log: [String(e)], decision: null };
    throw e;
  }
  const store = opened.store;
  const box: EpochBox = { epoch: null };
  // Every target write goes through the release lease's fence; with the epoch fence on, every ref write also carries the epoch taken below.
  const target = fenced(d.target, () => store.fence(), d.cfg.runner.epochFence ? () => box.epoch : null, (ms) => store.sleep(ms));
  // Dispatch mode gets a client with no ref writer on it at all (DESIGN.md §8.1): release is never written in that mode.
  const t: ReleaseTickBase = d.cfg.mode === "dispatch" ? new DispatchTick(d, store, opened.state, dispatchOnly(target), box) : new ReleaseTick(d, store, opened.state, target, box);
  if (opened.handover) t.log.push(opened.handover);
  let outcome: ReleaseOutcome;
  try {
    await t.takeEpoch();
    outcome = await t.run();
  } catch (e) {
    if (e instanceof CrashError) throw e;
    if (e instanceof LostLockError) return { outcome: "lost-lock", log: [...t.log, e.message], decision: t.decision };
    if (isTransient(e) || (e instanceof GitHubError && e.kind === "conflict")) outcome = "retry-later";
    else if (e instanceof GitHubError) {
      await t.pause(`the release job stopped on a ${e.kind} error: ${e.message}`);
      outcome = "paused";
    } else throw e;
    t.log.push(String(e));
  }
  try {
    await t.store.release(t.state);
  } catch (e) {
    if (e instanceof LostLockError) return { outcome: "lost-lock", log: t.log, decision: t.decision };
    if (!isTransient(e)) throw e;
  }
  try {
    const body = `Mirror of the ${d.cfg.names.releaseStateBranch} branch, for people. Qlander reads only whether this issue is open, if that branch goes missing, to refuse to start again from empty.\n\n${renderReleaseState(t.state)}`;
    await upsertMirror(d.repo, d.cfg.names.releaseLabels.mirror, "qlander release state (mirror)", body);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    t.log.push(`mirror not updated: ${String(e)}`);
  }
  return { outcome, log: t.log, decision: t.decision };
}

export interface ReleaseDryRun {
  mode: "dry-run";
  /** A live run would refuse to initialise (and pause) for this reason. */
  refused?: string;
  log: string[];
  /** What a live tick would decide (null when it would stop first). */
  decision: ReleaseDecision | null;
}

/**
 * The release dry run: the same initialisation check, pause check and
 * discovery as a live tick, through a read-only target client. No lease, no
 * state write, no issue, no target write.
 */
export async function releaseDryRun(d: Pick<ReleaseDeps, "target" | "repo" | "stateRef" | "cfg">): Promise<ReleaseDryRun> {
  const dry = (log: string[], decision: ReleaseDecision | null = null, refused?: string): ReleaseDryRun => ({ mode: "dry-run", ...(refused ? { refused } : {}), log, decision });
  const seen = await inspectState(d.stateRef, d.repo, releaseCodec(d.cfg.names.releaseLabels.mirror));
  if (!seen.ok) return dry([`a live release tick would pause: ${seen.reason}`], null, seen.reason);
  let state: ReleaseState;
  try {
    state = seen.read ? parseReleaseState(seen.read.text) : emptyReleaseState();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return dry([`a live release tick would pause: corrupt state: ${reason}`], null, reason);
  }
  if (state.journal?.op === "advance") return dry([`an advance ${state.journal.before} → ${state.journal.after} is outstanding; a live tick would reconcile it first`]);
  if (state.journal?.op === "dispatch") return dry([`a ${state.journal.kind} dispatch for ${state.journal.sha} is outstanding; a live tick would look for its run, never resend it`]);
  if (state.pausePending) return dry(["paused: a pending release pause"]);
  const why = await pauseReason(d.repo, d.cfg.names.releaseLabels.pause);
  if (why) return dry([`paused: ${why}`]);
  const { decision } = await discoverRelease(d.target, d.cfg);
  if (d.cfg.mode === "dispatch") return dry([`[dry run] ${describeDispatch(state, decision)}`], decision);
  const reason = decision.kind === "advance" ? `advance ${decision.from} → ${decision.to}` : decision.reason;
  return dry([`[dry run] ${decision.kind}: ${reason}`], decision);
}
