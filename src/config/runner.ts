// The runner contract (docs/deployment.md §3): which kind of runner the tick
// jobs run on, and the checks each mode needs (§3.5).
//
// The contract decides whether a job may take a lease at all and how long a
// successor waits before taking over an expired one (invariant R5). It never
// decides which PR may land, so, like `tokens`, it is kept out of Config and
// out of the policy hash. The timing numbers the queue and release configs
// already carried (jobTimeoutMinutes, the kill bound, takeoverGraceMinutes)
// stay in Config under their old keys, so the hash of an existing config does
// not change.

import type { Names } from "../config";

export type RunnerMode = "self-hosted-kill" | "hosted";

export interface RunnerContract {
  mode: RunnerMode;
  /** The tick workflow's schedule interval (R6: the lease must fit inside it). */
  cronMinutes: number;
  /** Each tick job's Actions timeout-minutes (R1). */
  jobTimeoutMinutes: number;
  /** self-hosted-kill only: something outside the guest destroys the job's VM at this age. Null in hosted mode. */
  hostKillMinutes: number | null;
  /** Takeover of an expired lease also waits this long past the kill bound (R5). */
  takeoverGraceMinutes: number;
  /** §3.4: every target ref write carries this job's epoch. Required in hosted mode; optional defence in depth in self-hosted-kill. */
  epochFence: boolean;
  /** §3.4: the target branch prefix for the epoch branches; used only when epochFence is on. */
  epochPrefix: string;
}

export const DEFAULT_EPOCH_PREFIX = "qlander-epoch/";

/** Hosted runners have no host-side kill, so "job completed" needs a longer settle before takeover (§3.3). */
export const HOSTED_MIN_GRACE_MINUTES = 15;

/**
 * R5's kill bound: the age (from lease acquisition) after which the holder
 * cannot act any more, given that GitHub also reports its job completed. In
 * self-hosted-kill mode it is the host kill; in hosted mode, the job timeout
 * (the epoch fence covers what the timeout cannot). StateStore.open waits
 * this plus takeoverGraceMinutes, exactly as before.
 */
export function killBoundMinutes(r: Pick<RunnerContract, "mode" | "jobTimeoutMinutes" | "hostKillMinutes">): number {
  return r.mode === "self-hosted-kill" ? (r.hostKillMinutes ?? 0) : r.jobTimeoutMinutes;
}

/** Two branch names, or prefixes ending in /, that could name the same ref or collide as file and directory. */
export function refsOverlap(a: string, b: string): boolean {
  const dir = (x: string) => (x.endsWith("/") ? x : `${x}/`);
  return a === b || dir(a).startsWith(dir(b)) || dir(b).startsWith(dir(a));
}

/**
 * The mode-specific rows of §3.5. R1 and R6, which apply to both modes, are
 * invariantProblems() (src/config/invariants.ts), called with cronMinutes.
 */
export function runnerProblems(r: RunnerContract, names: Names): string[] {
  const out: string[] = [];
  if (r.mode === "self-hosted-kill") {
    if (r.hostKillMinutes === null) out.push("runner.hostKillMinutes is required in self-hosted-kill mode");
    else if (r.hostKillMinutes < r.jobTimeoutMinutes) out.push("runner.hostKillMinutes must be at least runner.jobTimeoutMinutes");
    if (!(r.takeoverGraceMinutes >= 1)) out.push("runner.takeoverGraceMinutes must be at least 1 in self-hosted-kill mode");
  } else {
    if (r.hostKillMinutes !== null) out.push("runner.hostKillMinutes is for self-hosted-kill mode only: hosted runners have no host-side kill");
    if (!r.epochFence) out.push("runner.mode hosted requires runner.epochFence: true: hosted runners have no host-side kill");
    if (!(r.takeoverGraceMinutes >= HOSTED_MIN_GRACE_MINUTES)) out.push(`runner.takeoverGraceMinutes must be at least ${HOSTED_MIN_GRACE_MINUTES} in hosted mode`);
  }
  if (r.epochFence) {
    // The epoch branches live in the target, beside main, release and the batch refs.
    const target: [string, string][] = [
      ["target.main", names.main],
      ["release.branch", names.release],
      ["queue.refs.queuePrefix", names.queuePrefix],
      ["queue.refs.buildPrefix", names.buildPrefix],
    ];
    for (const [k, v] of target) if (refsOverlap(r.epochPrefix, v)) out.push(`runner.epochPrefix (${r.epochPrefix}) and ${k} (${v}) overlap`);
    // git refuses a ref with a component ending in .lock; the schema pattern cannot say so.
    if (r.epochPrefix.split("/").some((c) => c.endsWith(".lock"))) out.push(`runner.epochPrefix (${r.epochPrefix}): no component may end in .lock`);
  }
  return out;
}

/** The target branch that carries one job's epoch (§3.4): `<epochPrefix>queue` or `<epochPrefix>release`. */
export function epochBranchFor(r: Pick<RunnerContract, "epochPrefix">, job: "queue" | "release"): string {
  return `${r.epochPrefix}${job}`;
}

/**
 * What a job taking its lease must do about the epoch branch the state
 * records for the last holder (`recorded`, absent when it wrote without the
 * fence), before it writes its own lease (§3.4). Taking the epoch voids a
 * frozen holder only if both fence on the same branch, so:
 * - the recorded branch differs from this job's (epochPrefix changed, or the
 *   fence turned off): advance it too (`void`). This holds even after a
 *   release: the holder may keep authority on its branch (a successor's epoch
 *   advance failed, or a write was still in flight);
 * - no branch recorded, the last lease expired unreleased, and this job runs
 *   on hosted runners: nothing can void that holder and no host kill bounds
 *   it, so refuse (`refuse`);
 * - otherwise nothing extra: the same branch is voided by taking the epoch,
 *   and in self-hosted-kill mode R5's host kill bounds an unfenced holder.
 */
export function predecessorEpoch(r: RunnerContract, job: "queue" | "release", recorded: string | undefined, expiredLease: boolean): { void: string } | { refuse: string } | null {
  const mine = r.epochFence ? epochBranchFor(r, job) : null;
  if (recorded !== undefined && recorded !== mine) return { void: recorded };
  if (recorded === undefined && expiredLease && r.mode === "hosted") {
    return {
      refuse:
        "the expired lease's holder wrote without the epoch fence, which hosted runners cannot void (no host-side kill bounds it); switch to hosted mode only once a tick has released the lease, or let a self-hosted-kill tick take this lease over and release it",
    };
  }
  return null;
}

/**
 * The job's target client must match the contract: an epoch branch exactly
 * when the fence is on, and the one this job owns. Otherwise the tick would
 * fail at its first ref write (or, worse, write without the fence).
 */
export function epochClientProblem(r: Pick<RunnerContract, "epochFence" | "epochPrefix">, clientEpochBranch: string | null, job: "queue" | "release"): string | null {
  const want = r.epochFence ? epochBranchFor(r, job) : null;
  if (clientEpochBranch === want) return null;
  return want === null ? `the target client has an epoch branch (${clientEpochBranch}) but runner.epochFence is off` : `runner.epochFence is on but the target client's epoch branch is ${clientEpochBranch ?? "unset"}, not ${want}`;
}
