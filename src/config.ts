// Configuration, checked into this repo as qlander.yml (DESIGN.md §6.1,
// §4.3). Target PRs cannot change it, so the pre-landing manifest and the
// policy boundary are not something a candidate can weaken.

import type { RunnerContract } from "./config/runner";
import { controlConfig } from "./config/load";

export interface WorkflowEntry {
  path: string;
  name: string;
  when: "always" | "if_triggered";
  required_jobs: string[];
  allow_skipped_jobs: Record<string, string>;
}

/** Same schema and semantics as a qualification manifest's `required[]` (docs/qualification-manifest.md). */
export type Manifest = WorkflowEntry[];

export type ReviewProducer =
  | { adapter: "job@main"; workflowPath: string; events: string[]; jobTemplate: string; runNameTemplate: string; searchPages: number }
  | { adapter: "app-check"; appId: number; name: string };

export interface Human {
  login: string;
  id: number;
}

/** A GitHub repository, by name and by id (the id is checked on connect). */
export interface RepoName {
  owner: string;
  name: string;
  id: number;
}

/**
 * Every identity qlander acts on (docs/deployment.md §1.1): the
 * two repos, the target's branches and ref prefixes, the state branches in
 * the control repo, and every label. All of it comes from qlander.yml;
 * none of it is a code default. The queue and the release config share one
 * Names object.
 */
export interface Names {
  /** The repo that holds the config, the tick workflow, the state branches and the issues. */
  control: RepoName;
  /** The repo whose main the queue lands. */
  target: RepoName;
  /** target.main: the branch the queue lands. */
  main: string;
  /** release.branch: the branch release advance moves. */
  release: string;
  /** queue.refs.queuePrefix: `<prefix><n>` is the batch CI tests. */
  queuePrefix: string;
  /** queue.refs.buildPrefix: `<prefix><n>` is where the batch is merged together. */
  buildPrefix: string;
  /** queue.stateBranch and release.stateBranch, in the control repo. */
  stateBranch: string;
  releaseStateBranch: string;
  /**
   * queue.labels: on target PRs. bounce/solo/unsolo/go are the operator
   * commands (DESIGN.md §10). `priority` is optional (DESIGN.md §4.4): absent,
   * the key is absent and the priority lane is off.
   */
  labels: { ready: string; bounce: string; solo: string; unsolo: string; go: string; priority?: string };
  /** queue.controlLabels: on control-repo issues. */
  controlLabels: { pause: string; mirror: string };
  /** release.labels: on control-repo issues. */
  releaseLabels: { pause: string; alert: string; mirror: string };
  /** watchdog.labels: on control-repo issues. */
  watchdogLabels: { alert: string; status: string };
}

/**
 * A bot account whose PRs may land without a human (src/automation.ts):
 * its own `ready` counts, and a CI-policy change needs no approval, but only
 * when every changed file matches one of `paths` and the bot authored and
 * pushed every commit. The PR still runs the full suite, alone.
 */
export interface TrustedAutomation {
  /** Exact GitHub login, including `[bot]`. */
  login: string;
  /** The account id; login AND id must both match. */
  id: number;
  /** Path globs (one-segment `*` only) the bot may change. */
  paths: string[];
}

export interface Config {
  names: Names;
  actionsAppId: number;
  fastLane: { workflowPath: string; event: string; job: string };
  /**
   * Producer-bound review evidence (DESIGN.md §4.1). Optional: when off,
   * `ready` is applied by a write-access account after a review held outside
   * CI. The adapter stays, so this can be switched on once a CI review
   * producer exists.
   */
  reviewRequired: boolean;
  review: ReviewProducer;
  /** Logins whose `ready` counts as the review producer applying it; honoured only when reviewRequired. */
  reviewProducerLogins: string[];
  humans: Human[];
  policyBoundary: string[];
  preLanding: Manifest;
  minBatch: number;
  maxBatch: number;
  /**
   * Fill timer: a fresh batch is built only once this many PRs head the FIFO
   * (capped by the effective batch size), or the oldest has been admitted
   * for maxWaitMinutes, or a run-alone PR is at the head or closes the
   * prefix, or an operator applies the go label (queue.labels.go). Recovery never waits.
   */
  minFill: number;
  maxWaitMinutes: number;
  maxSplitDepth: number;
  lineageBudget: number;
  windowBudget: number;
  windowHours: number;
  breakerBounces: number;
  noRunMinutes: number;
  inProgressMinutes: number;
  queuedHours: number;
  verifyTicks: number;
  verifyDays: number;
  historyLimit: number;
  /** How long a cancellation keeps looking for late-published runs. */
  cancelWindowMinutes: number;
  /** How long an unconfirmed rerun request or comment is reconciled before it is terminal (paused, or delivery uncertain). Never resent. */
  reconcileMinutes: number;
  /** The whole-tick lease (DESIGN.md §15). */
  leaseMinutes: number;
  /** Re-executions of one journalled op before recovery gives up and pauses. */
  maxOpTries: number;
  /** The tick job's Actions timeout-minutes (enforced by the workflow, step 6). */
  jobTimeoutMinutes: number;
  /** An effect is fenced: the lease must have at least this long left, by server time. */
  fenceMarginMinutes: number;
  /** How long cancellation keeps reconciling runs it has seen before it pauses. */
  cancelGiveUpHours: number;
  /** How long classification waits for a rerun run's new attempt before treating it as deleted or superseded. */
  rerunBarrierMinutes: number;
  /**
   * R5's kill bound (src/config/runner.ts killBoundMinutes): runner.hostKillMinutes
   * in self-hosted-kill mode, runner.jobTimeoutMinutes in hosted mode. The
   * key keeps its old name because Config is the policy hash's input.
   */
  controllerKillMinutes: number;
  /** Takeover of an expired lease also waits this long past the kill bound. */
  takeoverGraceMinutes: number;
  /**
   * The runner contract (qlander.yml `runner`, src/config/runner.ts). It
   * travels with the config so a job can never check one config against
   * another file's contract, but policyHash leaves it out: it decides how the
   * jobs run, never which PR may land. Its timing numbers are the keys above.
   */
  runner: RunnerContract;
  /**
   * Opt-in (absent by default). Present only when configured and non-empty,
   * and last, so a config without it hashes exactly as before (§8.2); when
   * present it is in the policy hash, like every other key.
   */
  trustedAutomations?: TrustedAutomation[];
  /**
   * Opt-in (absent by default; absent means every CI-policy PR runs alone).
   * When set, consecutive CI-policy PRs at the head of the FIFO, each with
   * its own SHA-bound human approval, may share one batch of at most `max`
   * PRs. Never with ordinary PRs, and never a trusted automation's waived PR
   * or an operator-solo PR (DESIGN.md §4.3 (d)). Present only when
   * configured, so a config without it hashes exactly as before.
   */
  policyShareBatch?: { max: number };
  /**
   * Opt-in, and only with names.labels.priority (DESIGN.md §4.4): a
   * prioritised PR may cancel the running batch's CI to build at once.
   * Present only when true, so a config without it hashes exactly as before.
   */
  priorityPreempt?: true;
  /**
   * Opt-in (absent by default; absent means one batch at a time, exactly as
   * before). Up to `maxActive` batches' CI at once: split halves and solo
   * retests side by side, and up to `pipelineDepth` speculative batches
   * stacked on the running fresh batch (DESIGN.md §5.6). Like `runner`, not
   * policy: policyHash leaves it out, because it decides when a tested commit
   * lands, never what may land or on what evidence.
   */
  concurrency?: { maxActive: number; pipelineDepth: number };
  /**
   * Opt-in (absent by default; absent means every key is off, exactly as
   * before): how a red batch is isolated (DESIGN.md §5.7). Present only when
   * at least one key is on. Like `concurrency`, not policy: policyHash leaves
   * it out, because it decides which tested commit lands when, never what may
   * land or on what evidence.
   */
  strategy?: Strategy;
  /**
   * Opt-in (absent by default; absent means merge mode, exactly as before):
   * queue.landing.mode linear (DESIGN.md §7.4). Each PR lands as one squashed
   * commit on a linear stack, and the landing moves every PR's head branch to
   * its own stack commit in the write before the one that moves main. Policy: in the
   * hash when present, so switching it drops every admitted PR.
   */
  landing?: {
    mode: "linear";
    body: string;
    /** Who authors a stack commit: the App (signed, PR author credited by trailer), or the PR's author (unsigned). */
    author: "app" | "author";
    /** Unexplained refused landings in a row before the queue pauses (DESIGN.md §7.4). */
    maxRefusals: number;
  };
}

/** queue.strategy: each key is present only when on. */
export interface Strategy {
  /** A red fresh batch retests its first PR alone, then the rest together, instead of splitting into halves. */
  firstAlone?: true;
  /**
   * A batch of several PRs whose tree was already seen red on the current
   * main (state.seenRed) is split without a new run. A single PR is always built.
   */
  skipSeenRed?: true;
  /**
   * A batch abandoned as the queue paused is remembered (state.parked); once
   * the queue resumes, if main has not moved and its run is now green, it
   * lands without a rebuild.
   */
  reuseGreen?: true;
  /**
   * Adaptive fresh batch size (state.adaptive): the limit starts at maxBatch,
   * doubles after `greens` full fresh batches in a row land, up to
   * `ceiling`, and halves (not below minBatch) on a red fresh batch.
   */
  adaptive?: { greens: number; ceiling: number };
  /**
   * Before a PR is bounced, run the suite on main alone (state.baseline). A PR
   * that fails only what main fails stays admitted, and is not bounced or counted.
   * One that fails exactly what another PR failed alone on the same main, which
   * main's own run did not show, is tested alone once more (state.aloneRed).
   */
  mainBaseline?: true;
}

/**
 * The queue config, loaded from qlander.yml at the control repo's root
 * (docs/deployment.md §1) when this module is first imported, so a malformed
 * file fails the job before it reads any state. Its policy hash is v2 (§8.2);
 * no older hash is accepted.
 */
export const defaultConfig: Config = controlConfig().config;

/** The lifecycle hooks in the same file (docs/hooks.md). Not part of Config, so not part of the policy hash. */
export const defaultHooks = controlConfig().hooks;

/** The PR comments the same file leaves out (docs/operating.md, "PR comments"). Not part of Config either. */
export const defaultComments = controlConfig().comments;

/** Who is assigned a pause the queue or the release job opens (docs/operating.md, "Getting notified"). Not part of Config either. */
export const defaultNotify = controlConfig().notify;

export { invariantProblems } from "./config/invariants";
export { epochBranchFor, epochClientProblem, type RunnerContract } from "./config/runner";
