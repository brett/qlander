// What `setup` makes the GitHub side look like (docs/deployment.md §5,
// DESIGN.md §12): the three Apps and their exact permissions, the control
// repo's environments, secrets and labels, the target's labels, and every
// ruleset. Everything here is derived from the loaded config and the App
// name prefix; nothing is specific to one deployment.

import type { LoadedConfig } from "../config/load";
import { releaseAppBypassesRelease, releaseTokenPermissions } from "../release-permissions";

export type Role = "queue" | "release" | "state";
export type Level = "read" | "write";
/** Permission name to level, as GitHub reports it (`read`, `write`, `admin`). */
export type Permissions = Record<string, string>;

export interface Repo {
  owner: string;
  name: string;
}

export const full = (r: Repo) => `${r.owner}/${r.name}`;

export interface AppSpec {
  role: Role;
  /** The App's display name: `<prefix>-<role>`. */
  name: string;
  /** The slug GitHub derives from the name. */
  slug: string;
  /** The account that owns the App and installs it: a private App installs only on its owner. */
  owner: string;
  /** The one repo the App is installed on. */
  repo: Repo;
  /** The App's registration permissions, exactly (DESIGN.md §12.1). */
  permissions: Permissions;
  /** The permissions each tick job requests when it mints this App's token (src/render.ts). */
  tokenPermissions: Permissions;
  /** The environment secrets' prefix: `<secret>_CLIENT_ID`, `<secret>_PRIVATE_KEY`. */
  secret: string;
}

/** GitHub's slug for an App name: lower case, runs of anything else become one hyphen. */
export function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Permission maps compared by value, in a stable order. */
export function samePermissions(a: Permissions, b: Permissions): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
}

/** Every difference between what GitHub has and what is expected, one line each. */
export function permissionDiff(have: Permissions, want: Permissions): { name: string; have: string; want: string }[] {
  const out: { name: string; have: string; want: string }[] = [];
  for (const k of [...new Set([...Object.keys(want), ...Object.keys(have)])].sort()) {
    if (have[k] !== want[k]) out.push({ name: k, have: have[k] ?? "none", want: want[k] ?? "none" });
  }
  return out;
}

const QUEUE_TOKEN: Permissions = { contents: "write", workflows: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read" };
const STATE_TOKEN: Permissions = { contents: "write" };

/** The Apps a config needs: queue and state always, release when release advance is enabled. */
/** GitHub's limit on an App's name. */
export const MAX_APP_NAME = 34;

/** The App names GitHub would not accept whole, which setup must refuse before it creates anything. */
export function tooLongAppNames(specs: AppSpec[]): string[] {
  return specs.map((s) => s.name).filter((n) => n.length > MAX_APP_NAME);
}

export function appSpecs(c: LoadedConfig, prefix: string): AppSpec[] {
  const n = c.config.names;
  const target = { owner: n.target.owner, name: n.target.name };
  const control = { owner: n.control.owner, name: n.control.name };
  const spec = (role: Role, repo: Repo, token: Permissions, secret: string): AppSpec => ({
    role,
    name: `${prefix}-${role}`,
    slug: slugOf(`${prefix}-${role}`),
    owner: repo.owner,
    repo,
    permissions: { ...token, metadata: "read" },
    tokenPermissions: token,
    secret,
  });
  return [
    spec("queue", target, QUEUE_TOKEN, "QUEUE_APP"),
    // release.mode dispatch: least privilege, src/release-permissions.ts.
    ...(c.release.enabled ? [spec("release", target, releaseTokenPermissions(c.release, c.runner.epochFence), "RELEASE_APP")] : []),
    spec("state", control, STATE_TOKEN, "STATE_APP"),
  ];
}

export interface EnvironmentSpec {
  name: string;
  /** The Apps whose client id and private key the environment holds. */
  roles: Role[];
}

/** The control repo's environments: one per tick job, each with its target App and the state App. */
export function environmentSpecs(c: LoadedConfig): EnvironmentSpec[] {
  return [
    { name: "queue-write", roles: ["queue", "state"] },
    ...(c.release.enabled ? [{ name: "release-write", roles: ["release", "state"] as Role[] }] : []),
  ];
}

/** The branch every environment allows deployments from. */
export const DEPLOY_BRANCH = "main";

export const secretNames = (a: Pick<AppSpec, "secret">) => [`${a.secret}_CLIENT_ID`, `${a.secret}_PRIVATE_KEY`];

/** Issue labels the control repo needs. */
export function controlLabels(c: LoadedConfig): string[] {
  const n = c.config.names;
  return [
    n.controlLabels.pause,
    n.controlLabels.mirror,
    n.watchdogLabels.alert,
    n.watchdogLabels.status,
    ...(c.release.enabled ? [n.releaseLabels.pause, n.releaseLabels.alert, n.releaseLabels.mirror] : []),
  ].filter((l, i, all) => all.indexOf(l) === i);
}

/** PR labels the target needs (queue.labels). */
export function targetLabels(c: LoadedConfig): string[] {
  const l = c.config.names.labels;
  return [l.ready, l.bounce, l.solo, l.unsolo, l.go, ...(l.priority ? [l.priority] : [])].filter((x, i, all) => all.indexOf(x) === i);
}

// ---------------------------------------------------------------- rulesets

export interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

/**
 * A ruleset as setup wants it. `bypass` names Apps by role; `extraBypass`
 * says whether other bypass actors already on the ruleset (break-glass
 * humans, added by hand) are kept ("keep") or removed ("none"): a ruleset
 * whose point is that nobody else bypasses it is always "none".
 * `apps` adds Apps that are not qlander's by id: the release ruleset in
 * dispatch mode lists the target's promote identity, and not the release App.
 */
export interface RulesetSpec {
  repo: Repo;
  name: string;
  /** Full ref patterns (`refs/heads/...`). */
  include: string[];
  rules: Rule[];
  bypass: Role[];
  extraBypass: "keep" | "none";
  /** Other Apps, by id, that must be bypass actors too (release.dispatch.promoterApps). */
  apps?: number[];
  /** The Apps that must be installed on `repo` before this ruleset can name them. */
  needsInstalled: Role[];
}

const heads = (p: string) => `refs/heads/${p}`;
/** A ref prefix such as `queue/` as a ruleset pattern covering everything under it. */
const under = (prefix: string) => heads(`${prefix.replace(/\/$/, "")}/**`);

const PROTECT_REFS: Rule[] = [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: false } }, { type: "deletion" }];
const INTEGRITY: Rule[] = [{ type: "required_signatures" }, { type: "non_fast_forward" }, { type: "deletion" }];

/**
 * The control repo's rulesets (DESIGN.md §12.2): `main`, and the state
 * branches. `main` asks for what `control.mainProtection` says (strict by
 * default). A relaxed parameter is asked for at its weakest, which the
 * reconciliation never lowers anything to (src/setup/rulesets.ts), so setup
 * then neither adds nor removes it; a relaxed signedCommits leaves
 * required_signatures out, and an existing one is kept.
 */
export function controlRulesets(c: LoadedConfig): RulesetSpec[] {
  const n = c.config.names;
  const repo = { owner: n.control.owner, name: n.control.name };
  const m = c.controlMain;
  return [
    {
      repo,
      name: "qlander-control-main",
      include: [heads(DEPLOY_BRANCH)],
      rules: [
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: m.requiredApprovals,
            dismiss_stale_reviews_on_push: m.dismissStaleReviews,
            require_last_push_approval: m.lastPushApproval,
          },
        },
        ...INTEGRITY.filter((r) => m.signedCommits || r.type !== "required_signatures"),
      ],
      bypass: [],
      extraBypass: "none",
      needsInstalled: [],
    },
    {
      repo,
      name: "qlander-state-branches",
      include: [heads(n.stateBranch), ...(c.release.enabled ? [heads(n.releaseStateBranch)] : [])],
      rules: [...PROTECT_REFS, { type: "non_fast_forward" }],
      bypass: ["state"],
      extraBypass: "none",
      needsInstalled: ["state"],
    },
  ];
}

/**
 * The target's rulesets (DESIGN.md §13, docs/deployment.md §3.4). `queue-refs`
 * always; the landing and integrity rulesets only when `withLanding`
 * (`--apply-target-rulesets`), because they change who may move `main`.
 */
/** The full suite's checks, which release-landing requires (the hotfix path, DESIGN.md §9); audit T10 checks for the same list. */
export const releaseRequiredChecks = (c: Pick<LoadedConfig, "config">): string[] => [...new Set(c.config.preLanding.flatMap((w) => w.required_jobs))];

export function targetRulesets(c: LoadedConfig, withLanding: boolean): RulesetSpec[] {
  const n = c.config.names;
  const repo = { owner: n.target.owner, name: n.target.name };
  const out: RulesetSpec[] = [
    {
      repo,
      name: "queue-refs",
      include: [under(n.queuePrefix), under(n.buildPrefix)],
      rules: PROTECT_REFS,
      bypass: ["queue"],
      extraBypass: "none",
      needsInstalled: ["queue"],
    },
  ];
  if (!withLanding) return out;
  out.push(
    {
      repo,
      name: "main-landing",
      include: [heads(n.main)],
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 0 } },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: c.config.fastLane.job }], strict_required_status_checks_policy: false } },
        { type: "update", parameters: { update_allows_fetch_and_merge: false } },
      ],
      bypass: ["queue"],
      extraBypass: "keep",
      needsInstalled: ["queue"],
    },
    // queue.landing.author author lands unsigned commits (DESIGN.md §7.4), so setup does not ask for signatures there; one already on the ruleset is kept (setup only tightens), and audit T13 reports it.
    { repo, name: "main-integrity", include: [heads(n.main)], rules: c.config.landing?.author === "author" ? INTEGRITY.filter((r) => r.type !== "required_signatures") : INTEGRITY, bypass: [], extraBypass: "none", needsInstalled: [] },
  );
  if (c.release.enabled) {
    const full = releaseRequiredChecks(c).map((context) => ({ context }));
    out.push(
      {
        repo,
        name: "release-landing",
        include: [heads(n.release)],
        rules: [
          { type: "pull_request", parameters: { required_approving_review_count: 0, allowed_merge_methods: ["merge"] } },
          // No `update` rule: a person merges a release PR once its checks pass (the hotfix path, DESIGN.md §9).
          { type: "required_status_checks", parameters: { required_status_checks: full, strict_required_status_checks_policy: true } },
        ],
        // Dispatch mode: the release App never bypasses release; the configured promote identity
        // (release.dispatch.promoterApps) and named break-glass users are the only bypass actors kept.
        ...(releaseAppBypassesRelease(c.release)
          ? { bypass: ["release"] as Role[], extraBypass: "keep" as const, needsInstalled: ["release"] as Role[] }
          : // The release App's id is resolved too, so that a promoterApps entry naming it is refused (src/setup/rulesets.ts).
            { bypass: [] as Role[], extraBypass: "keep" as const, needsInstalled: ["release"] as Role[], apps: [...(c.release.dispatch?.promoterApps ?? [])] }),
      },
      { repo, name: "release-integrity", include: [heads(n.release)], rules: INTEGRITY, bypass: [], extraBypass: "none", needsInstalled: [] },
    );
  }
  if (c.runner.epochFence) {
    const p = c.runner.epochPrefix;
    out.push({ repo, name: "epoch-write-queue", include: [heads(`${p}queue`)], rules: PROTECT_REFS, bypass: ["queue"], extraBypass: "none", needsInstalled: ["queue"] });
    if (c.release.enabled) {
      out.push({ repo, name: "epoch-write-release", include: [heads(`${p}release`)], rules: PROTECT_REFS, bypass: ["release"], extraBypass: "none", needsInstalled: ["release"] });
    }
    out.push({
      repo,
      name: "epoch-integrity",
      include: [under(p)],
      rules: [{ type: "non_fast_forward" }, { type: "deletion" }],
      bypass: [],
      extraBypass: "none",
      needsInstalled: [],
    });
  }
  return out;
}
