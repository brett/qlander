// Loads qlander.yml (docs/deployment.md §1): the
// YAML text is screened (yaml.ts), parsed with Bun.YAML, checked against
// schema/qlander.schema.json (schema.ts), turned into the Config and
// ReleaseConfig objects, and then checked semantically. Any problem is a
// ConfigError listing every problem found, thrown before the caller reads
// any state.
//
// The policy hash is v2, over a canonical (key-sorted) form of Config, so key
// order no longer matters to it (src/queue.ts policyHash).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import schemaJson from "../../schema/qlander.schema.json" with { type: "json" };
import { allowedPathProblem } from "../automation";
import type { Config, Names, Strategy, TrustedAutomation } from "../config";
import type { ReleaseConfig } from "../release-config";
import type { Proof, ProofRun, Qualification } from "../qualification";
import type { Hook, HookEventName } from "../hooks";
import { CONTROL_BRANCH } from "../job-names";
import { invariantProblems } from "./invariants";
import { DEFAULT_EPOCH_PREFIX, killBoundMinutes, refsOverlap, type RunnerContract, runnerProblems } from "./runner";
import { schemaProblems } from "./schema";
import { yamlTextProblems } from "./yaml";

/**
 * The control repo's config, at its root. The tick reads it from its own
 * checkout of control main, never from the target. Next to the source by
 * default; a release bundle runs from elsewhere, so `tick` and `watchdog`
 * take `--config <file>` (useConfigFile) before they load anything.
 */
export let CONFIG_PATH = fileURLToPath(new URL("../../qlander.yml", import.meta.url));
/** The control repo's checkout root, the config's directory: where a `source: control` qualification manifest is read. */
export let CONTROL_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

/**
 * Read the control repo's config from `path` instead, and take its directory
 * as the checkout root. Only before the config is first loaded: a process
 * never mixes two configs.
 */
export function useConfigFile(path: string): void {
  if (loaded) throw new Error("the control config is already loaded");
  CONFIG_PATH = resolve(path);
  CONTROL_ROOT = dirname(CONFIG_PATH);
}

/** The schema file; its contents are built into the code (a release bundle has no schema/ next to it). */
export const SCHEMA_PATH = fileURLToPath(new URL("../../schema/qlander.schema.json", import.meta.url));

/** The GitHub Actions App's global id (§1.1): not a per-repo value, so it stays in code. */
const ACTIONS_APP_ID = 15368;
/** github-actions[bot]'s account id, global like ACTIONS_APP_ID: a status it posts names no producer by itself. */
const ACTIONS_BOT_ID = 41898282;
/** The proof run's defaults (docs/qualification-manifest.md). */
export const DEFAULT_PROOF_EVENTS = ["workflow_run", "workflow_dispatch"];

export class ConfigError extends Error {
  constructor(
    readonly source: string,
    readonly problems: string[],
  ) {
    super(`${source} is not a valid qlander config:\n  ${problems.join("\n  ")}`);
    this.name = "ConfigError";
  }
}

export interface LoadedConfig {
  config: Config;
  release: ReleaseConfig;
  /**
   * Lifecycle hooks (docs/hooks.md); empty when the file has none. Kept out
   * of Config on purpose: hooks only notify, they decide nothing, so they are
   * not policy and changing them must not change the policy hash (which would
   * revalidate every admitted PR).
   */
  hooks: Hook[];
  /**
   * The environment variables the tick workflow puts each App's installation
   * token in (`tokens`; absent: TARGET_TOKEN and TARGET_RELEASE_TOKEN). Kept
   * out of Config like hooks: a variable name is wiring, not policy.
   */
  tokens: Tokens;
  /**
   * The runner contract (`runner`, docs/deployment.md §3); also Config.runner
   * and ReleaseConfig.runner. policyHash leaves it out, like tokens: it
   * decides whether and when a job may hold a lease, never which PR may land.
   * Its timing numbers are also in Config, under the keys they always had, so
   * they stay in the policy hash.
   */
  runner: RunnerContract;
  /**
   * The PR comments to leave out (`comments.omit`); empty when the file has
   * none. Kept out of Config like hooks: a comment decides nothing.
   */
  comments: CommentSettings;
  /** Who is assigned the issues that say the queue has stopped (`notify`); kept out of Config like comments. */
  notify: { assignees: string[] };
  /**
   * The tick jobs' runner labels (`runner.runsOn`), rendered into tick.yml
   * (src/render.ts); null when absent. Wiring, not policy, like tokens.
   */
  runsOn: string[] | null;
  /**
   * Where the rendered workflows get qlander (`bundle`, docs/deployment.md
   * §6.3): a release of `repo`, pinned by PIN_FILE; null when absent (source
   * mode: `bun src/cli.ts` from the checkout). Wiring, not policy, like tokens.
   */
  bundle: Bundle | null;
  /**
   * What the control repo's main ruleset must hold (`control.mainProtection`):
   * audit C5 checks it and setup's control step writes it. Every key absent is
   * the strict default (STRICT_CONTROL_MAIN). Kept out of Config like bundle: it
   * protects the control repo, and decides nothing a tick does.
   */
  controlMain: ControlMainProtection;
}

/** The control repo's main ruleset parameters a config may relax (`control.mainProtection`). */
export interface ControlMainProtection {
  requiredApprovals: number;
  dismissStaleReviews: boolean;
  lastPushApproval: boolean;
  signedCommits: boolean;
}

/** DESIGN.md §12.2: the default, and the most any audit asks for unless a config raises requiredApprovals. */
export const STRICT_CONTROL_MAIN: ControlMainProtection = { requiredApprovals: 1, dismissStaleReviews: true, lastPushApproval: true, signedCommits: true };

/** GitHub's own cap on a ruleset's required approving reviews. */
const MAX_APPROVALS = 10;

/** A pinned release bundle's source (`bundle`). */
export interface Bundle {
  /** owner/name of the repo whose releases hold the bundle. */
  repo: string;
  /** Download with the job's own token (contents: read), so `repo` must be the control repo; else an anonymous download. */
  private: boolean;
  /**
   * Whether watchdog.yml runs the bundle too (default). False keeps the
   * watchdog in source mode, so a missing or broken release cannot also
   * silence the alarm that reports it; the control repo must then hold the
   * source.
   */
  watchdog: boolean;
}

/** A progress comment that asks nobody to act, so a config may leave it out. */
export type OptionalComment = "queued" | "landed";

export interface CommentSettings {
  omit: readonly OptionalComment[];
}


/** Each job's token variable; each job refuses to start if it can see the other's (src/main.ts). */
export interface Tokens {
  queue: string;
  release: string;
}

export const DEFAULT_TOKENS: Tokens = { queue: "TARGET_TOKEN", release: "TARGET_RELEASE_TOKEN" };


// The shape the schema guarantees once schemaProblems() is empty.
interface ProofRunYaml {
  workflow: string;
  events?: string[];
  jobTemplate?: string;
}
interface WorkflowYaml {
  path: string;
  name: string;
  when: "always" | "if_triggered";
  required_jobs: string[];
  allow_skipped_jobs: Record<string, string>;
}
type ProducerYaml =
  | { adapter: "job@main"; workflow: string; events: string[]; jobTemplate: string; runNameTemplate: string; searchPages: number }
  | { adapter: "app-check"; appId: number; name: string };
interface ConfigYaml {
  version: 1;
  control: { repo: string; repoId: number; mainProtection?: Partial<ControlMainProtection> };
  target: { repo: string; repoId: number; main: string };
  runner: {
    mode: RunnerContract["mode"];
    cronMinutes: number;
    jobTimeoutMinutes: number;
    hostKillMinutes?: number;
    takeoverGraceMinutes: number;
    epochFence?: boolean;
    epochPrefix?: string;
    runsOn?: string[];
  };
  lease: { minutes: number; fenceMarginMinutes: number };
  queue: {
    stateBranch: string;
    refs: { queuePrefix: string; buildPrefix: string };
    labels: { ready: string; bounce: string; solo: string; unsolo: string; go: string; priority?: string };
    priority?: { preempt?: boolean };
    concurrency?: { maxActive?: number; pipelineDepth?: number };
    strategy?: { firstAlone?: boolean; skipSeenRed?: boolean; reuseGreen?: boolean; adaptive?: { greens: number; ceiling: number }; mainBaseline?: boolean };
    controlLabels: { pause: string; mirror: string };
    admission: {
      fastLane: { workflow: string; event: string; job: string };
      review: { required: boolean; producerLogins: string[]; producer: ProducerYaml };
    };
    policy: { paths: string[]; approvers: { login: string; id: number }[]; trustedAutomations?: TrustedAutomation[]; shareBatch?: { max: number } };
    preLanding: WorkflowYaml[];
    batch: { min: number; max: number; minFill: number; maxWaitMinutes: number; maxSplitDepth: number; breakerBounces: number };
    budget: { lineage: number; window: number; windowHours: number };
    timeouts: {
      noRunMinutes: number;
      inProgressMinutes: number;
      queuedHours: number;
      rerunBarrierMinutes: number;
      reconcileMinutes: number;
      cancelWindowMinutes: number;
      cancelGiveUpHours: number;
      maxOpTries: number;
    };
    verify: { ticks: number; days: number };
    historyLimit: number;
  };
  release: {
    branch: string;
    stateBranch: string;
    labels: { pause: string; alert: string; mirror: string };
    enabled?: boolean;
    dryRun: boolean;
    maxCandidates: number;
    historyLimit: number;
    qualification: {
      provider: Qualification["provider"];
      manifest?: { source?: "target" | "control"; path: string; proof?: ProofRunYaml & { statusContext: string } };
      checksGreen?: { required: WorkflowYaml[] };
      commitStatus?: { context: string; creators: number[]; producerWorkflow?: string; targetUrl?: "actions-run"; proof?: ProofRunYaml };
    };
  };
  watchdog: { labels: { alert: string; status: string } };
  hooks?: { events: HookEventName[]; eventType: string }[];
  tokens?: Partial<Tokens>;
  comments?: { omit?: OptionalComment[] };
  notify?: { assignees?: string[] };
  bundle?: { repo: string; private?: boolean; watchdog?: boolean };
}

function repoName(full: string, id: number): Names["control"] {
  const [owner, name] = full.split("/") as [string, string]; // the schema allows exactly one slash
  return { owner, name, id };
}

/** Every identity, from the file (§1.1). */
function toNames(y: ConfigYaml): Names {
  const { queue: q, release: r } = y;
  return {
    control: repoName(y.control.repo, y.control.repoId),
    target: repoName(y.target.repo, y.target.repoId),
    main: y.target.main,
    release: r.branch,
    queuePrefix: q.refs.queuePrefix,
    buildPrefix: q.refs.buildPrefix,
    stateBranch: q.stateBranch,
    releaseStateBranch: r.stateBranch,
    // The priority label is optional: absent, the key is absent and the policy hash is unchanged.
    labels: { ready: q.labels.ready, bounce: q.labels.bounce, solo: q.labels.solo, unsolo: q.labels.unsolo, go: q.labels.go, ...(q.labels.priority ? { priority: q.labels.priority } : {}) },
    controlLabels: { pause: q.controlLabels.pause, mirror: q.controlLabels.mirror },
    releaseLabels: { pause: r.labels.pause, alert: r.labels.alert, mirror: r.labels.mirror },
    watchdogLabels: { alert: y.watchdog.labels.alert, status: y.watchdog.labels.status },
  };
}

/**
 * The queue's Config. Apart from `names`, the keys keep the step-2 order;
 * nothing depends on it any more (the v2 hash is canonical), but it keeps a
 * deployment's pre-v2 projection easy to check against a snapshot.
 */
function toConfig(y: ConfigYaml, names: Names, runner: RunnerContract): Config {
  const q = y.queue;
  const p = q.admission.review.producer;
  return {
    names,
    actionsAppId: ACTIONS_APP_ID,
    fastLane: { workflowPath: q.admission.fastLane.workflow, event: q.admission.fastLane.event, job: q.admission.fastLane.job },
    reviewRequired: q.admission.review.required,
    review:
      p.adapter === "job@main"
        ? { adapter: p.adapter, workflowPath: p.workflow, events: [...p.events], jobTemplate: p.jobTemplate, runNameTemplate: p.runNameTemplate, searchPages: p.searchPages }
        : { adapter: p.adapter, appId: p.appId, name: p.name },
    reviewProducerLogins: [...q.admission.review.producerLogins],
    humans: q.policy.approvers.map((h) => ({ login: h.login, id: h.id })),
    policyBoundary: [...q.policy.paths],
    preLanding: q.preLanding.map((w) => ({
      path: w.path,
      name: w.name,
      when: w.when,
      required_jobs: [...w.required_jobs],
      allow_skipped_jobs: { ...w.allow_skipped_jobs },
    })),
    minBatch: q.batch.min,
    maxBatch: q.batch.max,
    minFill: q.batch.minFill,
    maxWaitMinutes: q.batch.maxWaitMinutes,
    maxSplitDepth: q.batch.maxSplitDepth,
    lineageBudget: q.budget.lineage,
    windowBudget: q.budget.window,
    windowHours: q.budget.windowHours,
    breakerBounces: q.batch.breakerBounces,
    noRunMinutes: q.timeouts.noRunMinutes,
    inProgressMinutes: q.timeouts.inProgressMinutes,
    queuedHours: q.timeouts.queuedHours,
    verifyTicks: q.verify.ticks,
    verifyDays: q.verify.days,
    historyLimit: q.historyLimit,
    cancelWindowMinutes: q.timeouts.cancelWindowMinutes,
    reconcileMinutes: q.timeouts.reconcileMinutes,
    leaseMinutes: y.lease.minutes,
    maxOpTries: q.timeouts.maxOpTries,
    jobTimeoutMinutes: y.runner.jobTimeoutMinutes,
    fenceMarginMinutes: y.lease.fenceMarginMinutes,
    cancelGiveUpHours: q.timeouts.cancelGiveUpHours,
    rerunBarrierMinutes: q.timeouts.rerunBarrierMinutes,
    controllerKillMinutes: killBoundMinutes(runner),
    takeoverGraceMinutes: y.runner.takeoverGraceMinutes,
    runner,
    // Only when set: a config without it has no such key, and hashes as before.
    ...(q.policy.trustedAutomations?.length
      ? { trustedAutomations: q.policy.trustedAutomations.map((a) => ({ login: a.login, id: a.id, paths: [...a.paths] })) }
      : {}),
    // Likewise: absent, the key is absent and the hash is unchanged.
    ...(q.policy.shareBatch ? { policyShareBatch: { max: q.policy.shareBatch.max } } : {}),
    // Likewise: only `preempt: true` adds a key.
    ...(q.priority?.preempt ? { priorityPreempt: true as const } : {}),
    // Absent: no key. Not policy either way (policyHash leaves it out, like runner).
    ...(q.concurrency ? { concurrency: { maxActive: q.concurrency.maxActive ?? DEFAULT_MAX_ACTIVE, pipelineDepth: q.concurrency.pipelineDepth ?? DEFAULT_PIPELINE_DEPTH } } : {}),
    // Likewise not policy, and absent unless a key is on.
    ...strategyOf(q.strategy),
  };
}

/** queue.strategy as Config carries it: only the keys that are on, and no `strategy` key at all when none is. */
function strategyOf(y: ConfigYaml["queue"]["strategy"]): Pick<Config, "strategy"> {
  const s: Strategy = {
    ...(y?.firstAlone ? { firstAlone: true as const } : {}),
    ...(y?.skipSeenRed ? { skipSeenRed: true as const } : {}),
    ...(y?.reuseGreen ? { reuseGreen: true as const } : {}),
    ...(y?.adaptive ? { adaptive: { greens: y.adaptive.greens, ceiling: y.adaptive.ceiling } } : {}),
    ...(y?.mainBaseline ? { mainBaseline: true as const } : {}),
  };
  return Object.keys(s).length > 0 ? { strategy: s } : {};
}

/** queue.concurrency defaults, when the block is present without them. */
export const DEFAULT_MAX_ACTIVE = 2;
export const DEFAULT_PIPELINE_DEPTH = 1;

/** The proof job's name when release.qualification.manifest.proof.jobTemplate is absent. */
export const DEFAULT_PROOF_JOB_TEMPLATE = "Qualified {sha}";

const toProofRun = (p: ProofRunYaml): ProofRun => ({ workflow: p.workflow, events: [...(p.events ?? DEFAULT_PROOF_EVENTS)], jobTemplate: p.jobTemplate ?? DEFAULT_PROOF_JOB_TEMPLATE });
const toProof = (p: ProofRunYaml & { statusContext: string }): Proof => ({ statusContext: p.statusContext, ...toProofRun(p) });
const toEntry = (w: WorkflowYaml) => ({ path: w.path, name: w.name, when: w.when, required_jobs: [...w.required_jobs], allow_skipped_jobs: { ...w.allow_skipped_jobs } });

/**
 * The selected provider's block, with every default filled in. A missing
 * block (refused by semanticProblems for manifest and commit-status) yields
 * null; checks-green without a block copies queue.preLanding.
 */
function toQualification(q: ConfigYaml["release"]["qualification"], preLanding: WorkflowYaml[]): Qualification | null {
  switch (q.provider) {
    case "manifest":
      return q.manifest ? { provider: "manifest", source: q.manifest.source ?? "target", path: q.manifest.path, proof: q.manifest.proof ? toProof(q.manifest.proof) : null } : null;
    case "checks-green":
      return { provider: "checks-green", required: (q.checksGreen?.required ?? preLanding).map(toEntry) };
    case "commit-status": {
      const cs = q.commitStatus;
      if (!cs) return null;
      return {
        provider: "commit-status",
        context: cs.context,
        creators: [...cs.creators],
        producerWorkflow: cs.producerWorkflow ?? null,
        targetUrl: cs.targetUrl ?? null,
        proof: cs.proof ? toProofRun(cs.proof) : null,
      };
    }
  }
}

/** The ReleaseConfig. */
function toReleaseConfig(y: ConfigYaml, names: Names, qualification: Qualification, tokens: Tokens, runner: RunnerContract): ReleaseConfig {
  const r = y.release;
  return {
    names,
    enabled: r.enabled ?? false,
    qualification,
    dryRun: r.dryRun,
    maxCandidates: r.maxCandidates,
    leaseMinutes: y.lease.minutes,
    fenceMarginMinutes: y.lease.fenceMarginMinutes,
    jobTimeoutMinutes: y.runner.jobTimeoutMinutes,
    controllerKillMinutes: killBoundMinutes(runner),
    takeoverGraceMinutes: y.runner.takeoverGraceMinutes,
    runner,
    historyLimit: r.historyLimit,
    tokenEnv: tokens.release,
  };
}

/**
 * A target-hosted gate always exists (the fast lane is one), so a PR that
 * edits any workflow or local action, at any depth and with any extension,
 * must be a policy PR (§1.3). Config validation cannot read the target, so
 * it requires a directory-level pattern for each directory: a file pattern
 * such as `.github/workflows/*.yml` would leave `.yaml` workflows and
 * `action.yaml` unprotected. `audit` (step 8) checks the real dependency set.
 */
const GATE_DIRS = [".github/workflows", ".github/actions"];
const coversDir = (paths: string[], dir: string) => paths.some((p) => p === "**" || p === ".github/**" || p === `${dir}/**`);

const dup = <T>(xs: T[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];

/** The runner block, with its defaults filled in. */
function toRunner(r: ConfigYaml["runner"]): RunnerContract {
  return {
    mode: r.mode,
    cronMinutes: r.cronMinutes,
    jobTimeoutMinutes: r.jobTimeoutMinutes,
    hostKillMinutes: r.hostKillMinutes ?? null,
    takeoverGraceMinutes: r.takeoverGraceMinutes,
    epochFence: r.epochFence ?? false,
    epochPrefix: r.epochPrefix ?? DEFAULT_EPOCH_PREFIX,
  };
}

/** §1.4: distinct repos, branches and prefixes that cannot collide, distinct labels per repo. */
function nameProblems(n: Names): string[] {
  const out: string[] = [];
  if (n.control.id === n.target.id) out.push("control.repoId and target.repoId must differ: the config never lives in the target (§1.3)");
  if (`${n.control.owner}/${n.control.name}`.toLowerCase() === `${n.target.owner}/${n.target.name}`.toLowerCase()) out.push("control.repo and target.repo must differ");
  // The target's refs: main, release and the two batch prefixes.
  const target: [string, string][] = [
    ["target.main", n.main],
    ["release.branch", n.release],
    ["queue.refs.queuePrefix", n.queuePrefix],
    ["queue.refs.buildPrefix", n.buildPrefix],
  ];
  // The control repo's state branches, and the branch its tick workflow runs from.
  const control: [string, string][] = [
    ["the control repo's workflow branch", CONTROL_BRANCH],
    ["queue.stateBranch", n.stateBranch],
    ["release.stateBranch", n.releaseStateBranch],
  ];
  // git refuses a ref with a component ending in .lock; the schema pattern cannot say so.
  for (const [k, v] of [...target, ...control]) if (v.split("/").some((c) => c.endsWith(".lock"))) out.push(`${k} (${v}): no component may end in .lock`);
  for (const group of [target, control]) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [[ka, a], [kb, b]] = [group[i]!, group[j]!];
        if (refsOverlap(a, b)) out.push(`${ka} (${a}) and ${kb} (${b}) overlap`);
      }
    }
  }
  // GitHub label names are case-insensitive.
  const targetLabels = Object.values(n.labels).map((l) => l.toLowerCase());
  for (const d of dup(targetLabels)) out.push(`queue.labels: ${d} is used twice`);
  const controlLabels = [...Object.values(n.controlLabels), ...Object.values(n.releaseLabels), ...Object.values(n.watchdogLabels)].map((l) => l.toLowerCase());
  for (const d of dup(controlLabels)) out.push(`control-repo labels (queue.controlLabels, release.labels, watchdog.labels): ${d} is used twice`);
  return out;
}

/** The semantic checks of §1.4 that apply to the keys the code reads. */
function semanticProblems(cfg: Config, rel: ReleaseConfig, runner: RunnerContract): string[] {
  const out: string[] = nameProblems(cfg.names);
  // §3.5: R1 and R6 in both modes, then the mode's own rows.
  for (const p of invariantProblems(cfg, runner.cronMinutes)) out.push(`queue: ${p}`);
  for (const p of invariantProblems(rel, runner.cronMinutes)) out.push(`release: ${p}`);
  out.push(...runnerProblems(runner, cfg.names));
  if (cfg.minBatch > cfg.maxBatch) out.push("queue.batch.min must not exceed queue.batch.max");
  if (cfg.minFill > cfg.maxBatch) out.push("queue.batch.minFill must not exceed queue.batch.max");
  if (cfg.strategy?.adaptive && cfg.strategy.adaptive.ceiling < cfg.maxBatch) out.push("queue.strategy.adaptive.ceiling must be at least queue.batch.max");

  if (cfg.policyBoundary.length > 0 && cfg.humans.length === 0) out.push("queue.policy.approvers must not be empty while queue.policy.paths is not");
  for (const d of dup(cfg.humans.map((h) => h.login))) out.push(`queue.policy.approvers: login ${d} is listed twice`);
  for (const d of dup(cfg.humans.map((h) => h.id))) out.push(`queue.policy.approvers: id ${d} is listed twice`);

  if (!cfg.preLanding.some((w) => w.when === "always")) out.push("queue.preLanding needs at least one entry with when: always");
  if (cfg.review.adapter === "job@main") {
    for (const k of ["jobTemplate", "runNameTemplate"] as const) {
      if (!cfg.review[k].includes("{sha}")) out.push(`queue.admission.review.producer.${k} must contain {sha}`);
    }
  }
  const { gates: releaseGates, problems: releaseProblems } = qualificationChecks(rel.qualification);
  out.push(...releaseProblems);

  // §1.3: every file that defines a gate must be a policy path, so a target PR that edits it is a policy PR.
  const globs = cfg.policyBoundary.map((g) => new Bun.Glob(g));
  const gates: [string, string][] = [
    ...cfg.preLanding.map((w, i): [string, string] => [`queue.preLanding[${i}].path`, w.path]),
    ["queue.admission.fastLane.workflow", cfg.fastLane.workflowPath],
    ...(cfg.review.adapter === "job@main" ? [["queue.admission.review.producer.workflow", cfg.review.workflowPath] as [string, string]] : []),
    ...releaseGates,
  ];
  for (const [what, file] of gates) {
    if (!globs.some((g) => g.match(file))) out.push(`queue.policy.paths does not cover ${file} (${what})`);
  }
  for (const dir of GATE_DIRS) {
    if (!coversDir(cfg.policyBoundary, dir)) out.push(`queue.policy.paths must cover the whole ${dir} directory (${dir}/**, .github/** or **)`);
  }
  if (cfg.priorityPreempt && !cfg.names.labels.priority) out.push("queue.priority.preempt needs queue.labels.priority");
  if (cfg.policyShareBatch && cfg.policyShareBatch.max > cfg.maxBatch) out.push("queue.policy.shareBatch.max must not exceed queue.batch.max");
  if (cfg.concurrency && cfg.concurrency.pipelineDepth > cfg.concurrency.maxActive - 1) out.push("queue.concurrency.pipelineDepth must be less than queue.concurrency.maxActive");
  out.push(...automationProblems(cfg.trustedAutomations ?? [], gates.map(([, file]) => file)));
  return out;
}

/** The provider block names in the YAML, by provider. */
const PROVIDER_BLOCKS = { manifest: "manifest", "checks-green": "checksGreen", "commit-status": "commitStatus" } as const;

/** Only the selected provider's block may be present, and manifest and commit-status need theirs. */
function providerBlockProblems(q: ConfigYaml["release"]["qualification"]): string[] {
  const out: string[] = [];
  const own = PROVIDER_BLOCKS[q.provider];
  for (const k of Object.values(PROVIDER_BLOCKS)) {
    if (k !== own && q[k] !== undefined) out.push(`release.qualification.${k} is set, but the provider is ${q.provider}`);
  }
  if (q.provider !== "checks-green" && q[own] === undefined) out.push(`release.qualification.${own} is required for provider ${q.provider}`);
  return out;
}

/**
 * The release provider's semantic checks (docs/deployment.md §1.4, §2), and
 * the target files it makes gates (§1.3): a target-hosted manifest, every
 * proof workflow, the status producer and checks-green's workflows.
 */
function qualificationChecks(q: Qualification): { gates: [string, string][]; problems: string[] } {
  const gates: [string, string][] = [];
  const problems: string[] = [];
  const at = `release.qualification.${PROVIDER_BLOCKS[q.provider]}`;
  const proof = (p: ProofRun | null) => {
    if (!p) return;
    gates.push([`${at}.proof.workflow`, p.workflow]);
    if (!p.jobTemplate.includes("{sha}")) problems.push(`${at}.proof.jobTemplate must contain {sha}`);
  };
  if (q.provider === "manifest") {
    if (q.source === "target") gates.push([`${at}.path`, q.path]);

    proof(q.proof);
  } else if (q.provider === "checks-green") {
    q.required.forEach((w, i) => gates.push([`${at}.required[${i}].path`, w.path]));
    if (!q.required.some((w) => w.when === "always")) problems.push(`${at}.required needs at least one entry with when: always`);
  } else {
    if (q.producerWorkflow) gates.push([`${at}.producerWorkflow`, q.producerWorkflow]);
    else if (q.creators.includes(ACTIONS_BOT_ID)) problems.push(`${at}.producerWorkflow is required when creators includes github-actions[bot] (${ACTIONS_BOT_ID})`);
    if (new Set(q.creators).size !== q.creators.length) problems.push(`${at}.creators lists an account twice`);
    proof(q.proof);
  }
  return { gates, problems };
}

/**
 * Trusted automations (src/automation.ts): bot logins only, each listed once,
 * and allowed paths that are narrow by construction. A bot may never change a
 * gate file or anything under .github, whatever its globs say.
 */
function automationProblems(list: TrustedAutomation[], gateFiles: string[]): string[] {
  const out: string[] = [];
  const where = "queue.policy.trustedAutomations";
  const dup = (xs: unknown[]) => [...new Set(xs.filter((x, i) => xs.indexOf(x) !== i))];
  for (const d of dup(list.map((a) => a.login))) out.push(`${where}: login ${d} is listed twice`);
  for (const d of dup(list.map((a) => a.id))) out.push(`${where}: id ${d} is listed twice`);
  list.forEach((a, i) => {
    for (const d of dup(a.paths)) out.push(`${where}[${i}].paths: ${d} is listed twice`);
    for (const p of a.paths) {
      const why = allowedPathProblem(p);
      if (why) out.push(`${where}[${i}].paths: ${JSON.stringify(p)} ${why}`);
      else {
        const g = new Bun.Glob(p);
        for (const f of gateFiles) if (g.match(f)) out.push(`${where}[${i}].paths: ${JSON.stringify(p)} matches the gate file ${f}`);
      }
    }
  });
  return out;
}

/** Variables the workflow sets for its own use, or that GitHub reserves: never a token variable. */
const RESERVED_ENV = ["STATE_TOKEN", "QLANDER_MODE"];

/** GitHub-hosted runner images: a self-hosted-kill tick must never run on one (no host kills it). */
const HOSTED_IMAGE = /^(?:ubuntu|windows|macos)-/i;

function runsOnProblems(labels: string[] | null, mode: RunnerContract["mode"]): string[] {
  if (!labels) return [];
  const out: string[] = [];
  for (const d of dup(labels.map((l) => l.toLowerCase()))) out.push(`runner.runsOn: ${d} is listed twice`);
  if (mode === "self-hosted-kill") {
    for (const l of labels) if (HOSTED_IMAGE.test(l)) out.push(`runner.runsOn: ${l} is a GitHub-hosted image, but runner.mode is self-hosted-kill`);
  }
  return out;
}

/** The job's own token reads only the repo it runs in: a private bundle must come from the control repo. */
function bundleProblems(b: Bundle | null, control: string): string[] {
  if (!b?.private || b.repo.toLowerCase() === control.toLowerCase()) return [];
  return [`bundle.repo: a private bundle is downloaded with the job's own token, which reads only the control repo ${control}, not ${b.repo}`];
}

function tokenProblems(t: Tokens): string[] {
  const out: string[] = [];
  if (t.queue === t.release) out.push(`tokens.queue and tokens.release must differ (both ${t.queue})`);
  for (const [k, v] of Object.entries(t)) {
    if (RESERVED_ENV.includes(v) || v.startsWith("GITHUB_") || v.startsWith("RUNNER_") || v.startsWith("ACTIONS_")) out.push(`tokens.${k}: ${v} is reserved`);
  }
  return out;
}

/** Each event reaches each eventType at most once: a repeat would be a duplicate dispatch. */
function hookProblems(hooks: Hook[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  hooks.forEach((h, i) => {
    for (const e of h.events) {
      const k = `${h.eventType}|${e}`;
      if (seen.has(k)) out.push(`hooks[${i}]: event ${e} is already sent as ${h.eventType}`);
      seen.add(k);
    }
  });
  return out;
}

/** In Bun 1.4.2 (the pinned runtime); @types/bun 1.2.20 predates it. */
const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;

let schemaCache: Record<string, unknown> | undefined;
const schema = () => (schemaCache ??= structuredClone(schemaJson) as Record<string, unknown>);

/** Parse and check one config text. Throws ConfigError with every problem found. */
export function parseConfig(text: string, source = "qlander.yml"): LoadedConfig {
  const textProblems = yamlTextProblems(text);
  if (textProblems.length) throw new ConfigError(source, textProblems);
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new ConfigError(source, [`not valid YAML: ${(e as Error).message}`]);
  }
  const shape = schemaProblems(schema(), raw);
  if (shape.length) throw new ConfigError(source, shape);
  const y = raw as ConfigYaml;
  const names = toNames(y);
  const runner = toRunner(y.runner);
  const config = toConfig(y, names, runner);
  const blocks = providerBlockProblems(y.release.qualification);
  const qualification = toQualification(y.release.qualification, y.queue.preLanding);
  if (blocks.length || !qualification) throw new ConfigError(source, blocks);
  const tokens: Tokens = { ...DEFAULT_TOKENS, ...y.tokens };
  const release = toReleaseConfig(y, names, qualification, tokens, runner);
  const hooks = (y.hooks ?? []).map((h) => ({ events: [...h.events], eventType: h.eventType }));
  const runsOn = y.runner.runsOn ? [...y.runner.runsOn] : null;
  const bundle: Bundle | null = y.bundle ? { repo: y.bundle.repo, private: y.bundle.private ?? false, watchdog: y.bundle.watchdog ?? true } : null;
  const controlMain: ControlMainProtection = { ...STRICT_CONTROL_MAIN, ...y.control.mainProtection };
  const meaning = [
    ...semanticProblems(config, release, runner),
    ...(controlMain.requiredApprovals > MAX_APPROVALS ? [`control.mainProtection.requiredApprovals: at most ${MAX_APPROVALS} (GitHub's limit)`] : []),
    ...hookProblems(hooks),
    ...tokenProblems(tokens),
    ...runsOnProblems(runsOn, runner.mode),
    ...bundleProblems(bundle, y.control.repo),
  ];
  if (meaning.length) throw new ConfigError(source, meaning);
  const comments: CommentSettings = { omit: [...new Set(y.comments?.omit ?? [])] };
  const notify = { assignees: [...new Set(y.notify?.assignees ?? [])] };
  return { config, release, hooks, tokens, runner, runsOn, comments, notify, bundle, controlMain };
}

/** Read and check a config file. Throws ConfigError, including when the file cannot be read. */
export function loadConfig(path: string = CONFIG_PATH): LoadedConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError(path, [`cannot be read: ${(e as Error).message}`]);
  }
  return parseConfig(text, path);
}

let loaded: LoadedConfig | undefined;

/** The control repo's own config, loaded once per process. */
export function controlConfig(): LoadedConfig {
  return (loaded ??= loadConfig());
}
