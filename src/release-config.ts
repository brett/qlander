// The release job's configuration (DESIGN.md §8, §12.1). It is separate from
// the queue's Config on purpose: the release job runs under its own App
// (qlander-release), in its own environment (release-write), with its own
// key in its own variable, its own state ref and its own lease. Neither job
// reads the other's credentials (main.ts refuses to start if it can see them).

import type { RunnerContract } from "./config/runner";
import type { Names } from "./config";
import { controlConfig } from "./config/load";
import type { Qualification } from "./qualification";

export interface ReleaseConfig {
  /** The same identities as the queue's (release.branch, release.stateBranch, release.labels among them). */
  names: Names;
  /** Run release advance at all (release.enabled; absent: false). Disabled, the release job does nothing. */
  enabled: boolean;
  /** How a commit is proved qualified: the selected provider and its settings, defaults filled in (src/qualification.ts). */
  qualification: Qualification;
  /**
   * Hold the release job in dry run whatever QLANDER_MODE says. The
   * release job is live only when QLANDER_MODE is exactly "live" AND this
   * is false; otherwise it runs releaseDryRun: a read-only target client and
   * no writes anywhere. Stays true until release advance is enabled on its
   * own (DESIGN.md §14 G4), by a reviewed change here.
   */
  dryRun: boolean;
  /** Newest first-parent commits examined per tick; running out is an alert, never "none". */
  maxCandidates: number;
  /** The release job's own lease (DESIGN.md §15), on the qlander-release-state branch. */
  leaseMinutes: number;
  fenceMarginMinutes: number;
  jobTimeoutMinutes: number;
  /** R5's kill bound, as Config.controllerKillMinutes: the same runner contract as the queue. */
  controllerKillMinutes: number;
  /** Takeover of an expired release lease also waits this long past the kill deadline, and for GitHub to report the job completed. */
  takeoverGraceMinutes: number;
  /** The runner contract, the same as the queue's (Config.runner). */
  runner: RunnerContract;
  historyLimit: number;
  /** Environment variable holding the release App's installation token (tokens.release). */
  tokenEnv: string;
}

/** The release config, loaded from qlander.yml with the queue's (src/config.ts). Labels: names.releaseLabels (pause, alert, mirror). */
export const defaultReleaseConfig: ReleaseConfig = controlConfig().release;

/** The queue App's token variable (tokens.queue): the release job must never see it. */
export const QUEUE_TOKEN_ENV: string = controlConfig().tokens.queue;
