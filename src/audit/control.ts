// `qlander audit`, control side (docs/deployment.md §4.2, DESIGN.md
// §12.2): the environments, secrets, Actions approval setting, the state
// branches' ruleset, control main's ruleset parameter by parameter, the
// visibility rule, the rendered workflows, and the state App.

import { type ControlMainProtection, type LoadedConfig, STRICT_CONTROL_MAIN } from "../config/load";
import { GitHubError } from "../github/http";
import { CONTROL_BRANCH } from "../job-names";
import { firstDifference, renderWorkflows } from "../render";
import { appChecks, type AppIdentity } from "./apps";
import { type RepoInfo, RepoView, why } from "./repo-view";
import { refsRuleset, type RulesetCtx } from "./ruleset-checks";
import { appliesTo, readRulesets, type Ruleset } from "./rulesets";
import { type AuditGh, couldNotCheck, fail, type Finding, guard, pass, skipped, warn, unread } from "./types";

/** The environments the rendered tick workflow uses (src/render.ts). */
export const QUEUE_ENVIRONMENT = "queue-write";
export const RELEASE_ENVIRONMENT = "release-write";


/** C1: each environment exists and deploys from the control repo's main only. */
export async function c1(cfg: LoadedConfig, gh: AuditGh, repo: string): Promise<Finding[]> {
  const envs = [QUEUE_ENVIRONMENT, ...(cfg.release.enabled ? [RELEASE_ENVIRONMENT] : [])];
  const out: Finding[] = [];
  for (const env of envs) {
    let e: { deployment_branch_policy?: { protected_branches?: boolean; custom_branch_policies?: boolean } | null };
    try {
      e = await gh.get(`repos/${repo}/environments/${env}`);
    } catch (err) {
      if (err instanceof GitHubError && err.kind === "not_found") out.push(fail("C1", `environment ${env} does not exist`, `create it, deploying from ${CONTROL_BRANCH} only`));
      else out.push(unread(skipped("C1", `environment ${env} could not be read: ${why(err)}`, "rerun with an admin token"), err));
      continue;
    }
    const p = e.deployment_branch_policy;
    if (!p?.custom_branch_policies) {
      out.push(fail("C1", `environment ${env} deploys from ${p?.protected_branches ? "any protected branch" : "any branch"}`, `set its deployment branches to ${CONTROL_BRANCH} only`));
      continue;
    }
    try {
      const { branch_policies } = await gh.get<{ branch_policies: { name: string; type?: string }[] }>(`repos/${repo}/environments/${env}/deployment-branch-policies`);
      const names = branch_policies.map((b) => `${b.type ?? "branch"}:${b.name}`);
      out.push(
        names.length === 1 && names[0] === `branch:${CONTROL_BRANCH}`
          ? pass("C1", `environment ${env} deploys from ${CONTROL_BRANCH} only`)
          : fail("C1", `environment ${env} deploys from ${names.join(", ") || "no branch"}`, `leave the one policy branch:${CONTROL_BRANCH}`),
      );
    } catch (err) {
      out.push(unread(skipped("C1", `environment ${env}: its branch policies could not be read: ${why(err)}`, "rerun with an admin token"), err));
    }
  }
  return out;
}

/** C2: no repo-level or organization-level secret the tick could see. */
export async function c2(gh: AuditGh, repo: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [what, path] of [
    ["repo-level", `repos/${repo}/actions/secrets`],
    ["organization", `repos/${repo}/actions/organization-secrets`],
  ] as const) {
    try {
      const r = await gh.get<{ total_count: number; secrets?: { name: string }[] }>(path, { per_page: 100 });
      out.push(r.total_count === 0 ? pass("C2", `no ${what} secrets are visible to the control repo`) : fail("C2", `${r.total_count} ${what} secret(s) are visible to the control repo`, "move them into the environments, or remove the repo from their access list", (r.secrets ?? []).map((s) => s.name)));
    } catch (e) {
      out.push(unread(skipped("C2", `${what} secrets could not be listed: ${why(e)}`, "rerun with an admin token"), e));
    }
  }
  return out;
}

/** C3: GitHub Actions cannot approve pull requests in the control repo. */
export async function c3(gh: AuditGh, repo: string): Promise<Finding> {
  try {
    const p = await gh.get<{ can_approve_pull_request_reviews: boolean }>(`repos/${repo}/actions/permissions/workflow`);
    if (typeof p?.can_approve_pull_request_reviews !== "boolean") throw new Error("the response has no can_approve_pull_request_reviews");
    return p.can_approve_pull_request_reviews ? fail("C3", "GitHub Actions can approve pull requests in the control repo", "turn off \"Allow GitHub Actions to create and approve pull requests\"") : pass("C3", "GitHub Actions cannot approve pull requests in the control repo");
  } catch (e) {
    return unread(skipped("C3", `the Actions workflow permissions could not be read: ${why(e)}`, "rerun with an admin token"), e);
  }
}

/**
 * C5: control main's ruleset, one line per DESIGN §12.2 parameter. A
 * parameter the config relaxes (`control.mainProtection`) and the ruleset
 * does not hold is a WARN naming that key, never a FAIL; one the ruleset
 * holds anyway is a PASS.
 */
export function c5(rulesets: Ruleset[], c: RulesetCtx, want: ControlMainProtection = STRICT_CONTROL_MAIN): Finding[] {
  const b = CONTROL_BRANCH;
  const on = rulesets.filter((r) => appliesTo(r, b, c.defaultBranch));
  const prs = on.flatMap((r) => r.rules.filter((x) => x.type === "pull_request").map((x) => ({ r, p: x.parameters ?? {} })));
  const out: Finding[] = [];
  /** The line for one parameter: `relaxed` names the config key and value that accept its absence. */
  const line = (hit: string | null, label: string, fix: string, relaxed: string | null) => {
    if (hit !== null) return pass("C5", `${b}: ${label}${hit ? ` ("${hit}")` : ""}`);
    if (relaxed) return warn("C5", `${b}: ${label}: not set; accepted by ${relaxed}`, `to require it, remove that key and run setup --step control --apply`);
    return fail("C5", `${b}: ${label}: not set by any active ruleset`, fix);
  };
  const param = (label: string, ok: (p: Record<string, unknown>) => boolean, fix: string, relaxed: string | null = null) => {
    out.push(line(prs.find((x) => ok(x.p))?.r.name ?? null, label, fix, relaxed));
  };
  // A config may also raise the bar above the default.
  const approvals = Math.max(want.requiredApprovals, STRICT_CONTROL_MAIN.requiredApprovals);
  const key = (k: keyof ControlMainProtection, lighter: boolean) => (lighter ? `control.mainProtection.${k}: ${want[k]}` : null);
  param("pull_request is required", () => true, `add a ruleset on ${b} requiring a pull request`);
  param(`required_approving_review_count >= ${approvals}`, (p) => typeof p.required_approving_review_count === "number" && p.required_approving_review_count >= approvals, `require at least ${approvals} approving review${approvals === 1 ? "" : "s"}`, key("requiredApprovals", want.requiredApprovals < STRICT_CONTROL_MAIN.requiredApprovals));
  param("dismiss_stale_reviews_on_push", (p) => p.dismiss_stale_reviews_on_push === true, "dismiss stale approvals when new commits are pushed", key("dismissStaleReviews", !want.dismissStaleReviews));
  param("require_last_push_approval", (p) => p.require_last_push_approval === true, "require approval of the most recent push", key("lastPushApproval", !want.lastPushApproval));
  for (const [rule, relaxed] of [["required_signatures", key("signedCommits", !want.signedCommits)], ["non_fast_forward", null], ["deletion", null]] as const) {
    out.push(line(on.some((r) => r.rules.some((x) => x.type === rule)) ? "" : null, rule, `add ${rule} to the ${b} ruleset`, relaxed));
  }
  const carrying = on.filter((r) => r.rules.some((x) => ["pull_request", "required_signatures", "non_fast_forward", "deletion"].includes(x.type)));
  if (!carrying.length) out.push(fail("C5", `${b}: no bypass actors: there is no ruleset to check`, `add the ${b} ruleset with no bypass actors`));
  else if (!c.admin) out.push(skipped("C5", `${b}: whether the ruleset has no bypass actors needs an admin token`, "rerun with an admin token"));
  else {
    const withBypass = carrying.filter((r) => (r.bypass_actors ?? []).length > 0);
    out.push(withBypass.length ? fail("C5", `${b}: bypass actors on ${withBypass.map((r) => `"${r.name}"`).join(", ")}`, "remove every bypass actor") : pass("C5", `${b}: no bypass actors`));
  }
  return out;
}

const RANK: Record<string, number> = { public: 0, internal: 1, private: 2 };

/** C6: the control repo is at least as private as the target (job logs and mirror issues name PRs and branches). */
export function c6(control: RepoInfo, target: RepoInfo | null): Finding {
  if (!target) return skipped("C6", "the target's visibility could not be read");
  const v = (r: RepoInfo) => r.visibility ?? (r.private ? "private" : "public");
  const cv = v(control);
  const tv = v(target);
  return (RANK[cv] ?? 0) >= (RANK[tv] ?? 0) ? pass("C6", `the control repo is ${cv}, the target ${tv}`) : fail("C6", `the control repo is ${cv} but the target is ${tv}`, `make the control repo ${tv} (or more restrictive)`);
}

/** C7: the control repo's workflows at main match their rendering from this config. */
export async function c7(cfg: LoadedConfig, view: RepoView): Promise<Finding[]> {
  let files: { path: string; text: string }[];
  try {
    files = renderWorkflows(cfg);
  } catch (e) {
    return [fail("C7", `the workflows cannot be rendered from this config: ${why(e)}`, "fix the config")];
  }
  const out: Finding[] = [];
  for (const f of files) {
    let have: Awaited<ReturnType<RepoView["file"]>>;
    try {
      have = await view.file(f.path);
    } catch (e) {
      out.push(couldNotCheck("C7", `${f.path}`, e));
      continue;
    }
    if (!have) {
      out.push(fail("C7", `${f.path} does not exist on the control repo's ${view.ref}`, "run `render` and commit the result"));
      continue;
    }
    const d = firstDifference(f.text, have.text);
    out.push(d ? fail("C7", `${f.path} differs from its rendering at line ${d.line}`, "run `render` and commit the result", [`rendered:   ${d.want}`, `checked in: ${d.have}`]) : pass("C7", `${f.path} matches its rendering`));
  }
  return out;
}

export async function auditControl(gh: AuditGh, cfg: LoadedConfig, apps: AppIdentity[]): Promise<Finding[]> {
  const N = cfg.config.names;
  const repo = `${N.control.owner}/${N.control.name}`;
  const view = new RepoView(gh, repo, CONTROL_BRANCH);
  let info: RepoInfo;
  try {
    info = await view.info();
  } catch (e) {
    return [unread(fail("C0", `cannot read the control repo ${repo}: ${why(e)}`, "check control.repo and the token"), e)];
  }
  if (info.id !== undefined && info.id !== N.control.id) return [fail("C0", `${repo} has id ${info.id}, the config says ${N.control.id}`, "fix control.repoId")];
  const admin = info.permissions?.admin === true;
  const out: Finding[] = [];
  if (!admin) out.push(skipped("C0", `the token is not an admin of ${repo}: rules that need admin are SKIPPED`, "rerun with an admin token for a complete audit"));
  out.push(...(await guard("C1", "C1", () => c1(cfg, gh, repo))), ...(await guard("C2", "C2", () => c2(gh, repo))), ...(await guard("C3", "C3", async () => [await c3(gh, repo)])));
  const stateApp = apps.find((a) => a.role === "state");
  const rs = await readRulesets(gh, repo);
  if (!rs.ok) out.push(unread(warn("C4", `cannot read the control repo's rulesets: ${rs.error}`, "rerun with a token that can read rulesets"), rs.cause));
  else {
    const c: RulesetCtx = { rulesets: rs.rulesets, admin: admin && rs.bypassVisible, defaultBranch: info.default_branch, appNames: new Map(apps.filter((a) => a.id !== null).map((a) => [a.id!, a.slug])) };
    const branches = [N.stateBranch, ...(cfg.release.enabled ? [N.releaseStateBranch] : [])];
    out.push(...(await guard("C4", "C4", () => refsRuleset("C4", "state branch", branches, stateApp, c, ["creation", "update", "deletion", "non_fast_forward"]))));
    out.push(...(await guard("C5", "C5", () => c5(rs.rulesets, c, cfg.controlMain))));
  }
  try {
    out.push(c6(info, await gh.get<RepoInfo>(`repos/${N.target.owner}/${N.target.name}`)));
  } catch (e) {
    out.push(unread(c6(info, null), e));
  }
  out.push(...(await guard("C7", "C7", () => c7(cfg, view))));
  out.push(...(await guard("C8", "C8", () => appChecks(gh, N.control.owner, apps.filter((a) => a.role === "state"), "C8"))));
  return out;
}

