// Target writes behind the lease fence (DESIGN.md §15). Reads pass through;
// every write first checks, by GitHub's clock, that this runner still owns the
// state and has more than the margin of lease left. A runner that lost its
// lease (suspended, slow, or overtaken) cannot push, land, delete, rerun,
// cancel, comment, unlabel or dispatch anything.
//
// With the epoch fence on (docs/deployment.md §3.4), every ref write is also
// sent as one atomic updateRefs call that carries `{epoch: E -> E}`, where E is
// the epoch this tick advanced to when it took its lease. A runner that froze
// after the lease check and resumed after a successor advanced the epoch has
// its whole call rejected by GitHub: nothing moves.
//
// GitHub can serve a ref read from a replica that has not seen a write made a
// moment earlier, so a read can show a ref's previous value for a while. A
// ref write here is always a check-and-set on GitHub's write path, so a
// lagging read can never make a write land that should not. It can only
// misjudge a write that was rejected. So nothing that decides how to treat a
// rejection rests on a single read: whether the epoch is still ours is asked
// on the write path (epochHeld, a no-op updateRefs), and a ref's value is
// re-read until the reads agree.

import { epochBranchFor, predecessorEpoch, type RunnerContract } from "./config/runner";
import type { RefUpdate, TargetApi } from "./github/api";
import { GitHubError, isGraphqlInternal } from "./github/http";
import { type EpochHandover, LeaseHeldError, LostLockError } from "./store";
import { ZERO_SHA } from "./validate";

/** Waits between re-reads of a ref that a lagging replica may still show at its previous value. */
export const LAG_WAITS_MS = [500, 1000, 2000];

/**
 * `epoch`: null when the epoch fence is off (ref writes go through the plain
 * methods). Otherwise it returns the epoch this tick holds, or null before
 * the tick has taken one, in which case every ref write is refused.
 */
export function fenced(
  target: TargetApi,
  fence: () => Promise<void>,
  epoch: (() => string | null) | null = null,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): TargetApi {
  const guard =
    <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> => {
      await fence();
      return f(...a);
    };

  /** Rejections after which it is unknown whether the epoch is still ours: never retried. */
  const ownershipUnknown = new WeakSet<object>();

  /** One atomic call with the epoch entry. A rejection after the epoch moved is a lost lease, not a GitHub error. */
  const epochWrite = async (writes: RefUpdate[]): Promise<void> => {
    const e = epoch!();
    if (e === null) throw new LostLockError("no epoch taken this tick; not writing refs");
    try {
      await target.epochUpdateRefs(writes, e);
    } catch (err) {
      // Asked on the write path, not read: a lagging read could show our own
      // earlier epoch (a false lost lease) or hide a successor's (a missed one).
      let held: boolean | undefined;
      try {
        held = await target.epochHeld(e);
      } catch {
        held = undefined;
      }
      if (held === false) throw new LostLockError(`the epoch is no longer ${e}: a successor took over`);
      if (held === undefined) {
        // The write path could not be asked: fall back to a read, as before. A read that shows
        // another epoch is a lost lease; one that shows ours may lag, so ownership stays unknown.
        let now: string | null | undefined;
        try {
          now = await target.readEpoch();
        } catch {
          now = undefined;
        }
        if (now !== undefined && now !== e) throw new LostLockError(`the epoch moved from ${e} to ${now ?? "(absent)"}: a successor took over`);
        if (typeof err === "object" && err !== null) ownershipUnknown.add(err);
      }
      throw err;
    }
  };

  /** Whether `b` exists, judged only when every read across the lag waits agrees; null when they disagree. */
  const settledPresence = async (b: string): Promise<boolean | null> => {
    const first = (await target.getRef(b)) !== null;
    for (const ms of LAG_WAITS_MS) {
      await sleep(ms);
      if (((await target.getRef(b)) !== null) !== first) return null;
    }
    return first;
  };

  const createRef = async (b: string, s: string): Promise<void> => {
    try {
      await epochWrite([{ branch: b, before: ZERO_SHA, after: s }]);
    } catch (err) {
      // Keep the plain client's contract: a create of an existing ref is a
      // conflict. Only when the reads agree that it exists: a lagging read can
      // show a ref deleted a moment ago.
      if (!(err instanceof LostLockError) && (await settledPresence(b)) === true) throw new GitHubError("conflict", null, `Reference already exists: ${b}`);
      throw err;
    }
  };

  const deleteRef = async (b: string): Promise<void> => {
    // A delete carries the ref's commit as beforeOid. A ref moved a moment ago
    // (a build ref just merged into) can read at its previous commit, so a
    // rejection while the epoch is still ours is retried with a fresh read.
    for (let attempt = 0; ; attempt++) {
      const cur = await target.getRef(b);
      if (cur === null) {
        // Already gone, as the plain client: only confirmed absence counts.
        const present = await settledPresence(b);
        if (present === false) return;
        if (attempt < LAG_WAITS_MS.length) {
          await fence();
          continue;
        }
        throw new GitHubError("conflict", null, `${b}: reads disagree on whether it exists; not deleting`);
      }
      try {
        await epochWrite([{ branch: b, before: cur, after: ZERO_SHA }]);
        return;
      } catch (err) {
        if (err instanceof LostLockError || ownershipUnknown.has(err as object)) throw err;
        if (attempt < LAG_WAITS_MS.length) {
          await sleep(LAG_WAITS_MS[attempt]!);
          // The retry is a new write, later than the lease check this call began with: check the lease again.
          await fence();
          continue;
        }
        if ((await settledPresence(b)) === false) return;
        throw err;
      }
    }
  };

  const refs =
    epoch === null
      ? {
          createRef: (b: string, s: string) => target.createRef(b, s),
          deleteRef: (b: string) => target.deleteRef(b),
          updateRef: (b: string, before: string, after: string) => target.updateRef(b, before, after),
        }
      : { createRef, deleteRef, updateRef: (b: string, before: string, after: string) => epochWrite([{ branch: b, before, after }]) };

  return {
    repoId: target.repoId,
    epochBranch: target.epochBranch,
    getRef: (b) => target.getRef(b),
    listRefs: (p) => target.listRefs(p),
    getCommit: (s) => target.getCommit(s),
    compare: (b, h) => target.compare(b, h),
    listOpenPrNumbersWithLabel: (l) => target.listOpenPrNumbersWithLabel(l),
    getPr: (n) => target.getPr(n),
    latestLabelEvent: (n, l) => target.latestLabelEvent(n, l),
    permission: (l) => target.permission(l),
    listBranchActivity: (b) => target.listBranchActivity(b),
    listComments: (n) => target.listComments(n),
    listReviews: (n) => target.listReviews(n),
    listRuns: (q) => target.listRuns(q),
    listWorkflowRuns: (p, q) => target.listWorkflowRuns(p, q),
    getRun: (id) => target.getRun(id),
    listJobs: (id) => target.listJobs(id),
    jobLog: (id) => target.jobLog(id),
    listCheckRuns: (s) => target.listCheckRuns(s),
    listStatuses: (s) => target.listStatuses(s),
    listCommitStatuses: (s) => target.listCommitStatuses(s),
    getDataFile: (p, r) => target.getDataFile(p, r),
    readEpoch: () => target.readEpoch(),
    epochHeld: (e) => target.epochHeld(e),
    advanceEpoch: guard((before: string | null, m: string) => target.advanceEpoch(before, m)),
    voidEpoch: guard((b: string, m: string) => target.voidEpoch(b, m)),
    // Only with the epoch this tick holds: a caller cannot supply another one.
    epochUpdateRefs: guard(async (w: RefUpdate[], e: string) => {
      if (epoch === null || e !== epoch()) throw new LostLockError("epochUpdateRefs with an epoch this tick does not hold");
      return epochWrite(w);
    }),
    createRef: guard(refs.createRef),
    deleteRef: guard(refs.deleteRef),
    updateRef: guard(refs.updateRef),
    merge: guard((b: string, h: string, m: string) => target.merge(b, h, m)),
    rerunFailedJobs: guard((id: number) => target.rerunFailedJobs(id)),
    cancelRun: guard((id: number) => target.cancelRun(id)),
    comment: guard((n: number, body: string) => target.comment(n, body)),
    removeLabel: guard((n: number, l: string) => target.removeLabel(n, l)),
    dispatch: guard((t: string, p: object) => target.dispatch(t, p)),
  };
}

/**
 * Take the epoch at the start of a tick, after the lease (docs/deployment.md
 * §3.4): a new commit on top of the current epoch, moved there with a
 * fast-forward CAS. From then on every ref write a predecessor could still
 * send carries an epoch that is no longer current, and GitHub rejects it.
 * `target` must be the lease-fenced client. If the epoch moved while we read
 * it, a conflict is thrown (the tick retries later).
 */
export async function takeEpoch(target: TargetApi, runId: string): Promise<string> {
  const before = await target.readEpoch();
  try {
    return await target.advanceEpoch(before, `qlander epoch ${runId}`);
  } catch (e) {
    if (e instanceof LostLockError) throw e;
    let now: string | null | undefined;
    try {
      now = await target.readEpoch();
    } catch {
      now = undefined;
    }
    if (now !== undefined && now !== before) throw new GitHubError("conflict", null, `the epoch moved while it was being advanced (${before ?? "absent"} to ${now ?? "absent"})`);
    // GitHub reports a stale beforeOid as an untyped GraphQL error, and a lagging
    // replica can still show the old epoch: retry, never pause, and not counted as a fault.
    if (isGraphqlInternal(e) || (e instanceof GitHubError && e.kind === "validation")) throw new GitHubError("conflict", null, `the epoch advance from ${before ?? "absent"} was rejected (${e.message}); retrying next tick`);
    throw e;
  }
}

/**
 * The epoch side of taking a lease (docs/deployment.md §3.4), for
 * StateStore.open: the branch this job records (null with the fence off),
 * and what to do about the branch the state records for the last holder
 * (predecessorEpoch). A recorded branch other than ours is voided first, so
 * changing epochPrefix, or turning the fence off, never leaves a frozen
 * holder its authority. `target` is the unwrapped client: this runs before
 * the lease is ours, and voiding a branch no job under this config owns can
 * only stop a holder, never let one write.
 */
export function epochHandover(target: TargetApi, r: RunnerContract, job: "queue" | "release", runId: string): EpochHandover {
  return {
    branch: r.epochFence ? epochBranchFor(r, job) : null,
    takeover: async (recorded, expired) => {
      const p = predecessorEpoch(r, job, recorded, expired !== null);
      if (p === null) return null;
      if ("refuse" in p) throw new LeaseHeldError(`${expired?.owner ?? "the last holder"}: ${p.refuse}`);
      const after = await target.voidEpoch(p.void, `qlander void ${runId}`);
      return `voided the recorded epoch branch ${p.void} (now ${after})`;
    },
  };
}
