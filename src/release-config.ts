// The release job's configuration (DESIGN.md §8, §12.1). It is separate from
// the queue's Config on purpose: the release job runs under its own App
// (qlander-release), in its own environment (release-write), with its own
// key in its own variable, its own state ref and its own lease. Neither job
// reads the other's credentials (main.ts refuses to start if it can see them).

import type { RunnerContract } from "./config/runner";
import type { Human, Names } from "./config";
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
  /**
   * advance (default): the job fast-forwards release itself (DESIGN.md §8).
   * dispatch: it never writes release; it dispatches the target's own
   * workflow and only observes release (DESIGN.md §8.1, src/release-dispatch.ts).
   */
  mode: "advance" | "dispatch";
  /** The dispatch mode's settings, defaults filled in; null in advance mode. */
  dispatch: DispatchConfig | null;
}

/** release.dispatch (DESIGN.md §8.1). */
export interface DispatchConfig {
  /** The target workflow that promotes a commit and moves release itself. */
  workflow: string;
  /** The branch it is dispatched on: the target's main or release. */
  ref: string;
  /** The workflow_dispatch input names qlander sets. */
  inputs: { sha: string; dryRun: string; dispatchId: string };
  /** The release App's bot account: a run counts only if it is the run's actor and triggering actor (DESIGN.md §8.1). */
  actor: Human;
  /** The target's promote identity, by App id: with named users, the only bypass actors on the release ruleset (DESIGN.md §8.1). */
  promoterApps: number[];
  /** Whose `/qlander approve-release <sha>` comment counts (login and id). Never empty. */
  approvers: Human[];
  dryRunValidMinutes: number;
  appearMinutes: number;
  runHours: number;
  observeMinutes: number;
  /** At most `window` dispatches, dry and real together, in any `windowHours`. */
  budget: { window: number; windowHours: number };
  /** Target repository variables that stop new dispatches while one equals its value. */
  freeze: { variable: string; value: string }[];
}

/** The release config, loaded from qlander.yml with the queue's (src/config.ts). Labels: names.releaseLabels (pause, alert, mirror). */
export const defaultReleaseConfig: ReleaseConfig = controlConfig().release;

/** The queue App's token variable (tokens.queue): the release job must never see it. */
export const QUEUE_TOKEN_ENV: string = controlConfig().tokens.queue;
