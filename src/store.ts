// The state store and the whole-tick lease (DESIGN.md §3.1, §15).
//
// The store of record is a commit on a protected state branch (StateRefApi):
// qlander-state for the queue, qlander-release-state for the release
// job, each with its own codec and lease.
// Every write commits the new state on top of the version this store last
// read or wrote, and moves the ref with a compare-and-swap. A stale writer's
// CAS fails, so it can never overwrite a newer state.
//
// On top of that, a runner takes a lease for the whole tick: it writes
// `lease: {owner, until}` with a CAS before doing anything, and another
// runner that finds a live lease stops at once. Only one runner acts per
// tick, even outside the workflow's concurrency group. A crashed runner's
// lease simply expires.
//
// The state issue is a human-readable mirror, written after the ref and
// never read for decisions.

import type { Names } from "./config";
import { incompleteListing, unionListings } from "./github/issues";
import type { StateRefApi, StateRepoApi } from "./github/api";
import { GitHubError } from "./github/http";
import { emptyState, type Executor, type Lease, parseState, renderState, type State, stateFromIssueBody } from "./state";

/** A state document that carries the whole-tick lease. */
export interface Leased {
  lease: Lease | null;
  /** The epoch branch the last holder fenced on; absent when it wrote without the fence (docs/deployment.md §3.4). */
  epochBranch?: string;
}

/**
 * How one job's state document is created, parsed and guarded. The queue and
 * the release job each have their own codec, ref and lease (DESIGN.md §3.1).
 */
export interface StateCodec<S extends Leased> {
  empty(): S;
  /** Strict parse; throws on anything invalid. */
  parse(text: string): S;
  /**
   * Called when the state branch is missing, before starting from empty (by
   * live and dry runs alike): the reason to refuse initialising, or null.
   */
  refuseInit(repo: StateRepoApi): Promise<string | null>;
}

/**
 * The epoch side of taking a lease (docs/deployment.md §3.4; built by
 * epochHandover in src/fenced.ts). `branch` is recorded as the state's
 * epochBranch with the new lease (left out when null, so a document written
 * with the fence off is unchanged). `takeover` runs on every acquisition,
 * after R5's checks and before the new lease is written, with the recorded
 * branch and the expired lease (null when the last one was released): it
 * voids the recorded branch when that differs from ours, or throws
 * LeaseHeldError to refuse. Anything it throws leaves the state untouched,
 * so the record survives for the next tick.
 */
export interface EpochHandover {
  branch: string | null;
  /** A line for the tick log, or null when there was nothing to do. */
  takeover(recorded: string | undefined, expired: Lease | null): Promise<string | null>;
}

export class LostLockError extends Error {
  constructor(message: string) {
    super(`lost the state lock: ${message}`);
    this.name = "LostLockError";
  }
}

export class LeaseHeldError extends Error {
  constructor(message: string) {
    super(`another runner holds the lease: ${message}`);
    this.name = "LeaseHeldError";
  }
}

export class CorruptStateError extends Error {
  constructor(message: string) {
    super(`corrupt state: ${message}`);
    this.name = "CorruptStateError";
  }
}

/** A state document as the store commits it. */
export const serialise = (s: unknown) => `${JSON.stringify(s, null, 1)}\n`;

/** Waits before each re-read of a ref that still shows our own earlier write (about 7.5 s in all, well inside the fence margin). */
const STALE_READ_WAITS_MS = [500, 1000, 2000, 4000];

/** The queue's codec: refs and labels in its state are checked against the config's names. */
export function queueCodec(names: Names): StateCodec<State> {
  return { empty: emptyState, parse: (text) => parseState(text, names), refuseInit: (repo) => refuseIfIssueHoldsState(repo, names) };
}

export class StateStore<S extends Leased = State> {
  private constructor(
    private readonly ref: StateRefApi,
    private version: string,
    readonly runId: string,
    private readonly lease: Lease,
    private readonly marginMs: number,
    /** Also the tick's waits for a lagging read (src/fenced.ts). */
    readonly sleep: (ms: number) => Promise<void>,
  ) {}

  /**
   * Every version the ref held just before one of our writes moved it. The
   * ref only moves forward (CAS, force false, a ruleset on the branch), so a
   * read that returns one of these is a lagging replica, not a
   * takeover: GitHub serves a REST ref read right after a GraphQL updateRefs
   * from a replica that may not have the new commit yet.
   */
  private readonly written: string[] = [];

  private get leaseUntil(): string {
    return this.lease.until;
  }

  /**
   * Read the state and take the lease with a CAS, by GitHub's clock.
   * - CorruptStateError: the state does not parse, or the state branch is
   *   missing while a state issue still holds state (never silently reset).
   * - LeaseHeldError: a live lease exists (no same-owner bypass: run ids are
   *   unique per execution); or an expired lease's executor job is not known to
   *   be completed, or the grace past the controller's kill deadline has not
   *   passed (DESIGN.md §15); or someone moved the ref while we took it.
   */
  static async open<S extends Leased = State>(
    ref: StateRefApi,
    repo: StateRepoApi,
    runId: string,
    cfg: {
      leaseMinutes: number;
      fenceMarginMinutes: number;
      controllerKillMinutes?: number;
      takeoverGraceMinutes?: number;
      /** Waits between re-reads of a lagging ref (tests pass a no-op). */
      sleep?: (ms: number) => Promise<void>;
    },
    executor: Executor | null,
    codec: StateCodec<S>,
    epoch?: EpochHandover,
  ): Promise<{ store: StateStore<S>; state: S; handover?: string }> {
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(runId)) throw new Error(`bad run id ${runId}`);
    const seen = await inspectState(ref, repo, codec);
    if (!seen.ok) throw new CorruptStateError(seen.reason);
    let read = seen.read;
    if (read === null) {
      try {
        await ref.create(serialise(codec.empty()));
      } catch (e) {
        if (!(e instanceof GitHubError && e.kind === "conflict")) throw e; // someone else created it first
      }
      read = await ref.read();
      if (read === null) throw new CorruptStateError("state branch vanished right after creation");
    }
    let state: S;
    try {
      state = codec.parse(read.text);
    } catch (e) {
      throw new CorruptStateError(e instanceof Error ? e.message : String(e));
    }
    const now = read.serverTime.getTime();
    const l = state.lease;
    if (l && Date.parse(l.until) > now) throw new LeaseHeldError(`${l.owner} until ${l.until}`);
    if (l?.executor) {
      // An expired lease is not enough: the job that held it may be frozen,
      // not dead. Take over only once GitHub reports that job completed, and
      // only after the grace past the controller's kill deadline.
      const settle = ((cfg.controllerKillMinutes ?? 0) + (cfg.takeoverGraceMinutes ?? 0)) * 60_000;
      const from = Date.parse(l.acquiredAt ?? l.until);
      if (now < from + settle) throw new LeaseHeldError(`${l.owner}: waiting out the controller kill deadline and grace`);
      const job = await repo.jobState(l.executor.runId, l.executor.attempt, l.executor.job);
      if (job !== "completed") {
        throw new LeaseHeldError(`${l.owner}: its job ${l.executor.runId}/${l.executor.attempt} "${l.executor.job}" is ${job}, not completed`);
      }
    }
    let handover: string | null = null;
    if (epoch) {
      try {
        handover = await epoch.takeover(state.epochBranch, l);
      } catch (e) {
        if (e instanceof LeaseHeldError) throw e;
        throw new LeaseHeldError(`the recorded epoch branch ${state.epochBranch} could not be voided, so the lease is not taken: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Ours from now on; with the fence off, a record only goes once it has been voided.
      if (epoch.branch !== null) state = { ...state, epochBranch: epoch.branch };
      else if (state.epochBranch !== undefined) {
        const { epochBranch: _voided, ...rest } = state;
        state = rest as S;
      }
    }
    const until = new Date(now + cfg.leaseMinutes * 60_000).toISOString();
    const lease: Lease = { owner: runId, until, acquiredAt: new Date(now).toISOString(), executor };
    const sleep = cfg.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const store = new StateStore<S>(ref, read.version, runId, lease, cfg.fenceMarginMinutes * 60_000, sleep);
    try {
      await store.write(state);
    } catch (e) {
      if (e instanceof LostLockError) throw new LeaseHeldError(e.message);
      throw e;
    }
    return { store, state: { ...state, lease }, ...(handover === null ? {} : { handover }) };
  }

  /**
   * The fence, checked immediately before every external effect: nobody has
   * written the state since we did, and our lease still has more than the
   * margin left by GitHub's clock. Otherwise the effect is not performed.
   */
  async fence(): Promise<void> {
    let r = await this.ref.read();
    // A lagging replica can still show a version from before our last write. Re-read
    // a few times; anything else, or a lag that does not clear, fails closed.
    for (const ms of STALE_READ_WAITS_MS) {
      if (r === null || r.version === this.version || !this.written.includes(r.version)) break;
      await this.sleep(ms);
      r = await this.ref.read();
    }
    if (r === null || r.version !== this.version) throw new LostLockError("the state moved: another runner took over");
    const left = Date.parse(this.leaseUntil) - r.serverTime.getTime();
    if (left < this.marginMs) throw new LostLockError(`only ${Math.round(left / 1000)}s of lease left; not acting`);
  }

  /** Persist state (holding the lease) with a CAS. Throws LostLockError if the ref moved since we last wrote. */
  async write(state: S, release = false): Promise<void> {
    const next: S = { ...state, lease: release ? null : this.lease };
    try {
      const before = this.version;
      this.version = await this.ref.cas(before, serialise(next));
      this.written.push(before);
    } catch (e) {
      // Judge by the ref, not the error: if it moved, someone else wrote.
      const now = await this.ref.read();
      if (now === null || now.version !== this.version) throw new LostLockError(`state ref moved from ${this.version}`);
      throw e;
    }
  }

  /** End the tick: write the final state with the lease released. */
  async release(state: S): Promise<void> {
    await this.write(state, true);
  }
}

/**
 * Rewrite a mirror issue: the oldest open one with the label. One is created
 * only when the listing, read twice, was complete and empty both times;
 * otherwise a transient error is thrown and the mirror waits for the next
 * tick. Never a duplicate on a short read.
 */
export async function upsertMirror(repo: StateRepoApi, label: string, title: string, body: string): Promise<void> {
  let seen = await repo.listOpenIssues(label);
  if (seen.issues.length === 0) seen = unionListings(seen, await repo.listOpenIssues(label));
  const oldest = seen.issues[0];
  if (oldest) return repo.updateIssueBody(oldest.number, body);
  if (!seen.complete) throw incompleteListing(label);
  await repo.createIssue(title, body, [label]);
}

/** Best effort: the human-readable mirror on the state issue. Read back only by refuseIfIssueHoldsState below. */
export async function mirror(repo: StateRepoApi, names: Names, state: State): Promise<void> {
  const body = `Mirror of the ${names.stateBranch} branch, for people. Qlander reads this issue only if that branch goes missing, to refuse to start again from empty.\n\n${renderState(state)}`;
  await upsertMirror(repo, names.controlLabels.mirror, "qlander state (mirror)", body);
}

function isEmpty(s: State): boolean {
  return !s.journal && !s.active && !s.concurrent && Object.keys(s.auth).length === 0 && s.pending.length === 0 && s.solo.length === 0 && s.verify.length === 0 && s.outbox.length === 0 && s.window.length === 0 && !s.hooks?.outbox.length;
}

/**
 * The queue's guard for a missing state branch: every labelled state issue
 * must be verifiably empty. A missing marker, an unreadable block or any
 * state at all means someone may depend on it, and starting from empty would
 * orphan its batch and drop its budget.
 */
async function refuseIfIssueHoldsState(repo: StateRepoApi, names: Names): Promise<string | null> {
  const listed = await repo.listOpenIssues(names.controlLabels.mirror);
  if (!listed.complete) return "the state branch is missing and the state issues could not all be listed; refusing to initialise";
  for (const issue of listed.issues) {
    if (!issue.body.includes("qlander-state")) {
      return `the state branch is missing and state issue #${issue.number} has no readable state block; refusing to initialise`;
    }
    let s: State;
    try {
      s = stateFromIssueBody(issue.body.replace(/^<!--[^\n]*-->\n/, ""), names);
    } catch {
      return `the state branch is missing and state issue #${issue.number} holds unreadable state; refusing to initialise`;
    }
    if (!isEmpty(s)) return `the state branch is missing but state issue #${issue.number} holds state; refusing to initialise from empty`;
  }
  return null;
}

/**
 * The one read-only initialisation check, shared by live and dry runs. If the
 * state branch exists, its state is returned (unparsed). If it is missing,
 * the codec's guard decides whether starting from empty is safe.
 */
export async function inspectState<S extends Leased = State>(
  ref: StateRefApi,
  repo: StateRepoApi,
  codec: StateCodec<S>,
): Promise<{ ok: true; read: { version: string; text: string; serverTime: Date } | null } | { ok: false; reason: string }> {
  const read = await ref.read();
  if (read !== null) return { ok: true, read };
  const refused = await codec.refuseInit(repo);
  return refused === null ? { ok: true, read: null } : { ok: false, reason: refused };
}
