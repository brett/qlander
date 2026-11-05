// A fake GitHub for `qlander audit` tests: GET routes only, keyed by
// path. `world()` is a target and control repo (the neutral fixture config's
// acme/widgets and acme/widgets-control) that meets every requirement, so a
// test changes one thing and expects one finding.

import { join } from "node:path";
import { type LoadedConfig, loadConfig } from "../src/config/load";
import { GitHubError } from "../src/github/http";
import { renderWorkflows } from "../src/render";
import type { AuditGh, Finding } from "../src/audit/types";

export const ACME = join(import.meta.dir, "fixtures/acme.qlander.yml");
/** The fixture, with runner labels so its workflows render. */
export const acmeConfig = (): LoadedConfig => ({ ...loadConfig(ACME), runsOn: ["mq-runner"] });

export const notFound = () => new GitHubError("not_found", 404, "Not Found");
export const forbidden = () => new GitHubError("auth", 403, "Resource not accessible");

/** A file as the contents API returns it. */
export const file = (text: string) => ({ type: "file", content: Buffer.from(text).toString("base64"), encoding: "base64" });

export type Routes = Record<string, unknown>;

export function fakeGh(routes: Routes): AuditGh & { calls: string[] } {
  const calls: string[] = [];
  const resolve = (path: string) => {
    calls.push(path);
    if (!(path in routes)) throw notFound();
    const v = routes[path];
    if (v instanceof Error) throw v;
    return structuredClone(v);
  };
  return {
    calls,
    async get<T>(path: string) {
      return resolve(path) as T;
    },
    async list<T>(path: string, _q: unknown, pick: (p: unknown) => T[]) {
      return { items: pick(resolve(path)), truncated: false };
    },
  };
}

export const QUEUE_APP = 11;
export const RELEASE_APP = 12;
export const STATE_APP = 13;

export const BUILD_YML = `name: Build
on:
  push:
    branches: [trunk, "mq/batch/**"]
  pull_request:
    branches: [trunk, stable]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ./.github/actions/setup
      - run: bash build/test.sh
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: ./build/lint.sh --all
`;

export const CHECKS_YML = `on:
  pull_request:
    branches: [trunk]
jobs:
  quick:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`;

export const ACTION_YML = `name: setup
runs:
  using: composite
  steps:
    - run: bash .github/scripts/setup.sh
      shell: bash
`;

const ruleset = (id: number, name: string, include: string[], rules: { type: string; parameters?: Record<string, unknown> }[], bypass: { actor_id: number; actor_type: string }[] = []) => ({
  id,
  name,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include, exclude: [] } },
  bypass_actors: bypass.map((b) => ({ ...b, bypass_mode: "always" })),
  rules,
});

export const app = (id: number) => ({ actor_id: id, actor_type: "Integration" });
export const user = (id: number) => ({ actor_id: id, actor_type: "User" });

const T = "repos/acme/widgets";
const C = "repos/acme/widgets-control";

/** Everything in order, release advance off (as in the fixture). */
export function world(cfg: LoadedConfig = acmeConfig()): Routes {
  const targetRulesets = [
    ruleset(1, "main-landing", ["~DEFAULT_BRANCH"], [{ type: "update" }, { type: "pull_request", parameters: { required_approving_review_count: 0 } }], [app(QUEUE_APP), user(1001)]),
    ruleset(2, "main-integrity", ["~DEFAULT_BRANCH"], [{ type: "required_signatures" }, { type: "non_fast_forward" }, { type: "deletion" }]),
    ruleset(8, "checks", ["~DEFAULT_BRANCH"], [{ type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "quick" }] } }], [app(QUEUE_APP)]),
    ruleset(3, "queue-refs", ["refs/heads/mq/batch/**", "refs/heads/mq/build/**"], [{ type: "creation" }, { type: "update" }, { type: "deletion" }], [app(QUEUE_APP)]),
  ];
  const controlRulesets = [
    ruleset(4, "state-branches", ["refs/heads/mq-state", "refs/heads/mq-release-state"], [{ type: "creation" }, { type: "update" }, { type: "deletion" }, { type: "non_fast_forward" }], [app(STATE_APP)]),
    ruleset(5, "main", ["~DEFAULT_BRANCH"], [
      { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true } },
      { type: "required_signatures" },
      { type: "non_fast_forward" },
      { type: "deletion" },
    ]),
  ];
  const routes: Routes = {
    [T]: { id: 1002, full_name: "acme/widgets", default_branch: "trunk", visibility: "private", permissions: { admin: true } },
    [`${T}/contents/.github/workflows`]: [
      { type: "file", path: ".github/workflows/build.yml" },
      { type: "file", path: ".github/workflows/checks.yml" },
    ],
    [`${T}/contents/.github/workflows/build.yml`]: file(BUILD_YML),
    [`${T}/contents/.github/workflows/checks.yml`]: file(CHECKS_YML),
    [`${T}/contents/.github/actions/setup/action.yml`]: file(ACTION_YML),
    [`${T}/git/trees/trunk`]: {
      truncated: false,
      tree: [".github/workflows/build.yml", ".github/workflows/checks.yml", ".github/actions/setup/action.yml", ".github/scripts/setup.sh", "build/test.sh", "build/lint.sh", "src/app.ts"].map((path) => ({ path, type: "blob" })),
    },
    [`${T}/actions/workflows/build.yml/runs`]: {
      workflow_runs: [{ id: 501, path: ".github/workflows/build.yml", head_branch: "mq/batch/7", event: "push", status: "completed", conclusion: "success" }],
      total_count: 1,
    },
    [`${T}/actions/runs/501/jobs`]: {
      jobs: [
        { id: 1, name: "unit", status: "completed", conclusion: "success" },
        { id: 2, name: "lint", status: "completed", conclusion: "success" },
      ],
    },
    [`${T}/rulesets`]: targetRulesets.map(({ id }) => ({ id })),
    [`${T}/branches/trunk/protection`]: notFound(),
    "orgs/acme/installations": {
      installations: [
        { id: 91, app_id: QUEUE_APP, app_slug: "widgets-control-queue", repository_selection: "selected", permissions: { contents: "write", workflows: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read", metadata: "read" } },
        { id: 92, app_id: RELEASE_APP, app_slug: "widgets-control-release", repository_selection: "selected", permissions: { contents: "write", workflows: "write", actions: "read", checks: "read", statuses: "read", metadata: "read" } },
        { id: 93, app_id: STATE_APP, app_slug: "widgets-control-state", repository_selection: "selected", permissions: { contents: "write", metadata: "read" } },
      ],
    },
    "apps/widgets-control-queue": { id: QUEUE_APP, permissions: { contents: "write", workflows: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read", metadata: "read" } },
    "apps/widgets-control-release": { id: RELEASE_APP, permissions: { contents: "write", workflows: "write", actions: "read", checks: "read", statuses: "read", metadata: "read" } },
    "apps/widgets-control-state": { id: STATE_APP, permissions: { contents: "write", metadata: "read" } },
    [C]: { id: 1003, full_name: "acme/widgets-control", default_branch: "main", visibility: "private", permissions: { admin: true } },
    [`${C}/environments/queue-write`]: { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    [`${C}/environments/queue-write/deployment-branch-policies`]: { branch_policies: [{ name: "main", type: "branch" }] },
    [`${C}/environments/release-write`]: { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    [`${C}/environments/release-write/deployment-branch-policies`]: { branch_policies: [{ name: "main", type: "branch" }] },
    [`${C}/actions/secrets`]: { total_count: 0, secrets: [] },
    [`${C}/actions/organization-secrets`]: { total_count: 0, secrets: [] },
    [`${C}/actions/permissions/workflow`]: { default_workflow_permissions: "read", can_approve_pull_request_reviews: false },
    [`${C}/rulesets`]: controlRulesets.map(({ id }) => ({ id })),
  };
  for (const r of targetRulesets) routes[`${T}/rulesets/${r.id}`] = r;
  for (const r of controlRulesets) routes[`${C}/rulesets/${r.id}`] = r;
  for (const name of Object.values(cfg.config.names.labels)) routes[`${T}/labels/${encodeURIComponent(name!)}`] = { name };
  for (const f of renderWorkflows(cfg)) routes[`${C}/contents/${f.path}`] = file(f.text);
  return routes;
}

export const T_REPO = T;
export const C_REPO = C;

/** The findings with one id, as "STATUS message" lines. */
export const lines = (fs: Finding[], id?: string) => fs.filter((f) => !id || f.id === id).map((f) => `${f.status} ${f.message}`);
export const statuses = (fs: Finding[], id?: string) => [...new Set(fs.filter((f) => !id || f.id === id).map((f) => f.status))].sort();
