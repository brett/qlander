// The hard invariants (DESIGN.md §15), checked again by the loader on every config.
import type { Config } from "../config";
import { WATCH_MINUTES } from "../wake";

/**
 * Hard invariants (DESIGN.md §15). An executor must never outlive its lease:
 * Actions kills the tick job at jobTimeoutMinutes, and an effect needs at
 * least fenceMarginMinutes of lease left, so the job must die before the lease
 * could pass to another runner. The lease must also fit inside the cron
 * interval, so a crashed runner never blocks the next tick.
 */
export function invariantProblems(
  cfg: Pick<Config, "jobTimeoutMinutes" | "leaseMinutes" | "fenceMarginMinutes"> & { reconcileMinutes?: number },
  cronMinutes = 10,
): string[] {
  const out: string[] = [];
  if (!(cfg.jobTimeoutMinutes > 0)) out.push("jobTimeoutMinutes must be positive");
  if (!(cfg.jobTimeoutMinutes <= cfg.leaseMinutes - cfg.fenceMarginMinutes)) {
    out.push(`jobTimeoutMinutes (${cfg.jobTimeoutMinutes}) must be <= leaseMinutes (${cfg.leaseMinutes}) - fenceMarginMinutes (${cfg.fenceMarginMinutes})`);
  }
  if (!(cfg.fenceMarginMinutes > 0)) out.push("fenceMarginMinutes must be positive");
  if (!(cfg.leaseMinutes < cronMinutes)) out.push(`leaseMinutes (${cfg.leaseMinutes}) must be shorter than the cron interval (${cronMinutes})`);
  // The self-chaining CI watch (src/wake.ts) holds no lease, but must leave at least a minute for the dispatch and teardown.
  if (!(WATCH_MINUTES + 1 < cfg.jobTimeoutMinutes)) out.push(`the CI watch (${WATCH_MINUTES} minutes) + 1 must be shorter than jobTimeoutMinutes (${cfg.jobTimeoutMinutes})`);
  if (cfg.reconcileMinutes !== undefined && !(cfg.reconcileMinutes >= 2 * cronMinutes)) out.push("reconcileMinutes must span at least two ticks");
  return out;
}
