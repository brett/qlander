// What both release modes share (DESIGN.md §8, §8.1): one tick's state
// writes, its pause and alert issues, the epoch it takes after the lease, and
// the read-only reconciliation of a leftover `advance(R → C)` intent (§3.2).
// src/release-runner.ts (advance) and src/release-dispatch.ts (dispatch)
// each extend it. Nothing here writes a target ref: the epoch is advanced
// through the client the caller hands in, and an advance journal is settled
// by observation only.

import type { TargetApi, StateRepoApi } from "./github/api";
import { GitHubError } from "./github/http";
import { takeEpoch } from "./fenced";
import type { CrashPoint } from "./queue";
import type { ReleaseConfig } from "./release-config";
import type { ReleaseDecision } from "./release";
import type { AdvanceJournal, ReleaseHistoryItem, ReleaseState } from "./release-state";
import { openOnce, pauseReason } from "./outbox";
import type { StateStore } from "./store";

export interface ReleaseTickDeps {
  repo: StateRepoApi;
  cfg: ReleaseConfig;
  now: () => Date;
  crash?: (point: CrashPoint) => void;
}

/** The epoch this tick advanced to, shared with the fenced client that stamps every ref write with it (src/fenced.ts). */
export interface EpochBox {
  epoch: string | null;
}

/** The target reads and the epoch write every release tick needs, whatever its mode. */
export type TickTarget = Pick<TargetApi, "getRef" | "compare" | "readEpoch" | "advanceEpoch" | "epochBranch">;

export const oneLine = (title: string) => title.replace(/\s+/g, " ").slice(0, 100);

export const stableId = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);

export abstract class ReleaseTickBase {
  log: string[] = [];
  decision: ReleaseDecision | null = null;
  constructor(
    protected readonly d: ReleaseTickDeps,
    readonly store: StateStore<ReleaseState>,
    public state: ReleaseState,
    private readonly reads: TickTarget,
    private readonly box: EpochBox,
  ) {}

  /** First act after the lease: advance the epoch, which voids every ref write a predecessor could still send. */
  async takeEpoch(): Promise<void> {
    if (!this.d.cfg.runner.epochFence) return;
    this.box.epoch = await takeEpoch(this.reads, this.store.runId);
    this.log.push(`epoch ${this.reads.epochBranch} advanced to ${this.box.epoch}`);
  }

  protected crash(p: CrashPoint): void {
    this.d.crash?.(p);
  }

  protected nowIso(): string {
    return this.d.now().toISOString();
  }

  async save(): Promise<void> {
    await this.store.write(this.state);
  }

  /** Record the outcome and drop the journal in one state write; `also` rides in the same CAS. */
  protected async finishJournal(j: AdvanceJournal, outcome: ReleaseHistoryItem["outcome"], note: string, also: Partial<ReleaseState> = {}): Promise<void> {
    const history = [...this.state.history, { at: this.nowIso(), outcome, from: j.before, to: j.after, note, receipt: outcome === "advanced" ? j.receipt : null }];
    this.state = { ...this.state, ...also, journal: null, history: history.slice(-this.d.cfg.historyLimit) };
    this.log.push(`advance ${j.before.slice(0, 8)} → ${j.after.slice(0, 8)}: ${outcome} (${note})`);
    await this.save();
  }

  /**
   * §3.2: what release says about `advance(R → C)`. At C or a descendant of C,
   * the advance happened; at R, it did not; anything else, release moved.
   */
  protected async observe(j: Pick<AdvanceJournal, "before" | "after">): Promise<{ cur: string | null; seen: "target" | "descendant" | "unchanged" | "moved" }> {
    const cur = await this.reads.getRef(this.d.cfg.names.release);
    if (cur === j.after) return { cur, seen: "target" };
    if (cur === j.before) return { cur, seen: "unchanged" };
    if (cur !== null) {
      const c = await this.reads.compare(j.after, cur);
      if (c.status === "identical" || c.status === "ahead") return { cur, seen: "descendant" };
    }
    return { cur, seen: "moved" };
  }

  protected movedNote(cur: string | null): string {
    return `release is ${cur ?? "absent"}, which neither the recorded head nor a descendant of the target`;
  }

  /** §3.2, `advance` is reconciled like `land`: by observing release, never by trusting the intent. Reads only. */
  protected async reconcileAdvance(j: AdvanceJournal): Promise<void> {
    const { cur, seen } = await this.observe(j);
    if (seen === "target") return this.finishJournal(j, "advanced", "observed on recovery");
    if (seen === "unchanged") return this.finishJournal(j, "not-applied", "release still at the recorded head; deciding again");
    if (seen === "descendant") return this.finishJournal(j, "advanced", `observed on recovery; release has since moved on to ${cur}`);
    return this.finishJournal(j, "moved", this.movedNote(cur));
  }

  /** Fails closed: an unreadable or incomplete release-pause listing counts as paused (src/outbox.ts pauseReason). */
  async paused(): Promise<boolean> {
    if (this.state.pausePending) return true;
    const why = await pauseReason(this.d.repo, this.d.cfg.names.releaseLabels.pause);
    if (why) this.log.push(`paused: ${why}`);
    return why !== null;
  }

  /** Persist a pause first, then try to open its issue; a failed open leaves it pending (still paused). */
  protected pending(reason: string): NonNullable<ReleaseState["pausePending"]> {
    return this.state.pausePending ?? { id: `release:${stableId(reason)}`, reason };
  }

  async pause(reason: string): Promise<void> {
    this.state = { ...this.state, pausePending: this.pending(reason) };
    this.log.push(`pause: ${reason}`);
    await this.save();
    await this.applyPause();
  }

  async applyPause(): Promise<void> {
    const p = this.state.pausePending;
    if (!p) return;
    try {
      await openOnce(this.d.repo, this.d.cfg.names.releaseLabels.pause, p.id, oneLine(`qlander release paused: ${p.reason}`), `${p.reason}\n\nThe release job advances nothing while this issue is open. Close it to resume. The queue is not affected.`);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      this.log.push(`pause issue not opened yet: ${String(e)}`);
      return;
    }
    this.state = { ...this.state, pausePending: null };
    await this.save();
  }

  protected async alert(reason: string): Promise<void> {
    try {
      await openOnce(this.d.repo, this.d.cfg.names.releaseLabels.alert, `release-blocked:${stableId(reason.replace(/[0-9a-f]{40}/g, ""))}`, oneLine(`release blocked: ${reason}`), `${reason}\n\nThe release job keeps checking every tick. This does not pause the queue.`);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      this.log.push(`alert issue not opened: ${String(e)}`);
    }
  }

  abstract run(): Promise<ReleaseOutcome>;
}

/**
 * advanced: release moved (by the CAS, or, in dispatch mode, seen at the
 * candidate). dispatched and waiting are the dispatch mode's: a run was
 * started, or a run, an approval or a freeze is awaited.
 */
export type ReleaseOutcome = "advanced" | "none" | "alert" | "paused" | "busy" | "lost-lock" | "retry-later" | "moved" | "rejected" | "dispatched" | "waiting";
