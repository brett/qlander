// The repo steps of `setup` (docs/deployment.md §5.2): `control` (Actions
// settings, environments, secrets, labels, the `main` and state-branch
// rulesets), `target` (labels and rulesets) and `verify` (every App mints its
// tick token, and the state branches refuse the operator).

import { GitHubError } from "../github/http";
import type { Ctx } from "./context";
import { rulesetDiff } from "./rulesets";
import { controlLabels, controlRulesets, DEPLOY_BRANCH, environmentSpecs, full, permissionDiff, type Repo, samePermissions, secretNames, targetLabels, targetRulesets } from "./expected";
import { appJwt } from "./jwt";

export async function controlStep(c: Ctx): Promise<void> {
  const n = c.d.config.config.names;
  const repo = { owner: n.control.owner, name: n.control.name };
  const rulesets = controlRulesets(c.d.config);
  // Before any write: the state-branch ruleset names the state App, which GitHub accepts only once it is installed here.
  const appIds = await c.requireInstalled(rulesets.flatMap((r) => r.needsInstalled), `the control rulesets on ${full(repo)}`);
  await c.checkRepo(repo, n.control.id);

  const wf = await c.d.api.workflowPermissions(repo);
  if (wf.can_approve_pull_request_reviews) {
    await c.change(`${full(repo)}: turn off "Allow GitHub Actions to create and approve pull requests"`, () =>
      c.d.api.putWorkflowPermissions(repo, { default_workflow_permissions: wf.default_workflow_permissions, can_approve_pull_request_reviews: false }),
    );
  } else c.ok(`${full(repo)}: GitHub Actions cannot approve pull requests`);

  for (const env of environmentSpecs(c.d.config)) {
    if (!(await environment(c, repo, env.name))) continue;
    const have = new Set(await c.d.api.environmentSecrets(repo, env.name));
    for (const role of env.roles) {
      const spec = c.spec(role)!;
      const [idName, keyName] = secretNames(spec) as [string, string];
      const todo = c.d.rotate ? [idName, keyName] : [idName, keyName].filter((s) => !have.has(s));
      if (todo.length === 0) {
        c.ok(`${env.name}: ${idName} and ${keyName} are set`);
        continue;
      }
      const app = await c.existing(spec);
      const pem = c.key(spec);
      await c.byKey(spec, app, pem);
      for (const name of todo) {
        await c.change(`${env.name}: set ${name}${have.has(name) ? " (replacing it)" : ""}`, () => c.d.setSecret(repo, env.name, name, name === idName ? app.clientId : pem));
      }
    }
  }

  const secrets = await c.d.api.repoSecretCount(repo);
  if (secrets > 0) c.todo([`${full(repo)} has ${secrets} repo-level Actions secret(s); App keys belong only in the environments. Review and remove them: gh secret list -R ${full(repo)}`]);
  else c.ok(`${full(repo)}: no repo-level Actions secrets`);

  await c.labels(repo, controlLabels(c.d.config));
  for (const r of rulesets) await c.ensureRuleset(r, appIds);
}

/** An environment deployable from DEPLOY_BRANCH only. False in plan mode when it does not exist yet (nothing more to read). */
async function environment(c: Ctx, repo: Repo, name: string): Promise<boolean> {
  const env = await c.d.api.environment(repo, name);
  if (!env || env.protectedBranches || !env.customBranchPolicies) {
    await c.change(`${full(repo)}: ${env ? "limit" : "create"} the environment ${name}, deployable from selected branches`, () => c.d.api.putEnvironment(repo, name));
    if (!c.d.apply) {
      c.d.out(`plan  ${name}: allow deployments from ${DEPLOY_BRANCH} only`);
      if (!env) c.d.out(`plan  ${name}: set its secrets`);
      return env !== null;
    }
  } else c.ok(`${full(repo)}: the environment ${name} exists`);
  const policies = await c.d.api.branchPolicies(repo, name);
  for (const p of policies) {
    if (p.name !== DEPLOY_BRANCH || p.type !== "branch") await c.change(`${name}: remove the deployment rule ${p.type} ${p.name}`, () => c.d.api.deleteBranchPolicy(repo, name, p.id));
  }
  if (policies.some((p) => p.name === DEPLOY_BRANCH && p.type === "branch")) c.ok(`${name}: deployable from ${DEPLOY_BRANCH}`);
  else await c.change(`${name}: allow deployments from ${DEPLOY_BRANCH}`, () => c.d.api.addBranchPolicy(repo, name, DEPLOY_BRANCH));
  return true;
}

export async function targetStep(c: Ctx): Promise<void> {
  const n = c.d.config.config.names;
  const repo = { owner: n.target.owner, name: n.target.name };
  const rulesets = targetRulesets(c.d.config, c.d.targetRulesets);
  const appIds = await c.requireInstalled(rulesets.flatMap((r) => r.needsInstalled), `the target rulesets on ${full(repo)}`);
  await c.checkRepo(repo, n.target.id);
  await c.labels(repo, targetLabels(c.d.config));
  for (const r of rulesets) await c.ensureRuleset(r, appIds);
  if (!c.d.targetRulesets) {
    c.todo([`the ${n.main} landing and integrity rulesets are opt-in: rerun with --apply-target-rulesets once the target's CI meets docs/deployment.md §4.1`]);
    return;
  }
  if (await c.d.api.classicProtection(repo, n.main)) {
    c.todo([`${full(repo)}'s ${n.main} still has classic branch protection. Once the rulesets are active, remove it yourself:`, `gh api -X DELETE repos/${full(repo)}/branches/${n.main}/protection`]);
  }
}

export async function verifyStep(c: Ctx): Promise<void> {
  let failed = 0;
  const bad = (what: string) => {
    failed++;
    c.d.out(`FAIL  ${what}`);
  };
  const n = c.d.config.config.names;
  const control = { owner: n.control.owner, name: n.control.name };
  const stateBranches = [n.stateBranch, ...(c.d.config.release.enabled ? [n.releaseStateBranch] : [])];
  for (const spec of c.specs) {
    const app = await c.existing(spec);
    const pem = c.key(spec);
    const seen = await c.byKey(spec, app, pem);
    const diff = (have: Record<string, string>) => permissionDiff(have, spec.permissions).map((p) => `${p.name} ${p.have}→${p.want}`).join(", ");
    if (!samePermissions(seen.permissions, spec.permissions)) {
      bad(`${spec.slug}: registration permissions differ (${diff(seen.permissions)}): run setup --step permissions`);
      continue;
    }
    const jwt = appJwt(app.clientId, pem, c.d.now());
    const installs = await c.d.api.installationsByJwt(jwt);
    const inst = installs[0];
    if (installs.length !== 1 || !inst || inst.account.toLowerCase() !== spec.owner.toLowerCase()) {
      bad(`${spec.slug}: installed on [${installs.map((i) => i.account).join(", ")}], expected ${spec.owner} only`);
      continue;
    }
    if (!samePermissions(inst.permissions, spec.permissions)) {
      bad(`${spec.slug}: installation ${inst.id} has not accepted its permissions (${diff(inst.permissions)}): run setup --step permissions`);
      continue;
    }
    // The whole installation, before a token narrowed to the one repo could hide a wider one.
    const coverage = await c.installProblems(spec, app);
    if (coverage.problems.length) {
      bad(`${spec.slug}: installation ${inst.id} ${coverage.problems.join("; ")}`);
      continue;
    }
    let token: string;
    try {
      const minted = await c.d.api.mintToken(jwt, inst.id, { repositories: [spec.repo.name], permissions: spec.tokenPermissions });
      token = minted.token;
      // GitHub adds metadata: read to every installation token.
      if (!samePermissions(minted.permissions, { ...spec.tokenPermissions, metadata: "read" }) && !samePermissions(minted.permissions, spec.tokenPermissions)) bad(`${spec.slug}: the minted token has ${JSON.stringify(minted.permissions)}, not ${JSON.stringify(spec.tokenPermissions)}`);
    } catch (e) {
      bad(`${spec.slug}: minting a token with ${JSON.stringify(spec.tokenPermissions)} for ${full(spec.repo)} was refused: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const repos = (await c.d.api.tokenRepos(token)).map((r) => r.toLowerCase());
    if (repos.length !== 1 || repos[0] !== full(spec.repo).toLowerCase()) bad(`${spec.slug}: its token reaches [${repos.join(", ")}], not ${full(spec.repo)} alone`);
    else c.ok(`${spec.slug}: minted a token with exactly the tick's permissions, for ${full(spec.repo)} only`);
    if (spec.role !== "state") continue;
    for (const b of stateBranches) {
      try {
        await c.d.api.refReadable(control, b, token);
        c.ok(`${spec.slug}: can read ${b}`);
      } catch (e) {
        bad(`${spec.slug}: cannot read ${b}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  // The state-branch ruleset must be exactly right before the negative test, which never runs against a branch it does not protect.
  const stateRuleset = controlRulesets(c.d.config).find((r) => r.needsInstalled.includes("state"))!;
  const found = (await c.d.api.rulesets(control)).filter((r) => r.name === stateRuleset.name);
  const stateApp = c.spec("state") ? await c.d.api.app(c.spec("state")!.slug) : null;
  const rsProblems = found.length !== 1 || !stateApp ? [`${found.length} rulesets are named ${stateRuleset.name}`] : rulesetDiff(stateRuleset, await c.d.api.ruleset(control, found[0]!.id), { state: stateApp.id });
  if (rsProblems.length) bad(`${full(control)}: ruleset ${stateRuleset.name} is not right (${rsProblems.join("; ")}): run setup --step control; the negative test was not run`);
  else
    for (const b of stateBranches) {
      const problem = await stateBranchRefused(c, control, b);
      if (problem) bad(problem);
    }
  if (failed) c.fail(`${failed} verification(s) failed`);
  // Last, the whole audit: the target's CI requirements and the control repo's protection.
  const audit = await c.d.audit();
  for (const l of audit.lines) c.d.out(`        ${l}`);
  if (audit.failed) c.fail(`audit: ${audit.failed} finding(s) failed or could not be read (above)`);
  c.ok("audit: no FAIL, no failed read");
}

const siblingOf = (branch: string) => `${branch}-setup-probe`;

/** The negative test: the operator's own token must not create a state branch. Null when it is refused, as it must be. */
async function stateBranchRefused(c: Ctx, control: Repo, branch: string): Promise<string | null> {
  if ((await c.d.api.branchSha(control, branch)) !== null) {
    const rules = new Set(await c.d.api.branchRules(control, branch));
    const missing = ["creation", "update", "deletion", "non_fast_forward"].filter((r) => !rules.has(r));
    if (missing.length) return `${branch} exists, and these rules do not apply to it: ${missing.join(", ")}`;
    c.ok(`${branch} exists and its ruleset applies (the create attempt is skipped)`);
    return null;
  }
  if (!c.d.apply) {
    c.d.out(`plan  try to create ${branch} with the operator's token, expecting the ruleset to refuse it, then create and delete ${siblingOf(branch)} beside it`);
    return null;
  }
  const head = await c.d.api.branchSha(control, DEPLOY_BRANCH);
  if (!head) return `${full(control)} has no ${DEPLOY_BRANCH} branch to point a test branch at`;
  try {
    await c.d.api.createRef(control, branch, head);
  } catch (e) {
    // A token or permission error proves nothing. GitHub's words for a refusal vary, so they aren't the test.
    if (!(e instanceof GitHubError && e.kind === "validation" && e.status === 422)) return `creating ${branch} with the operator's token failed, but not by a ruleset: ${e instanceof Error ? e.message : String(e)}`;
    const why = e.message.split("\n")[0];
    if ((await c.d.api.branchSha(control, branch)) !== null) return `creating ${branch} with the operator's token answered "${why}", but the branch exists`;
    const problem = await siblingCreated(c, control, branch, head);
    if (problem) return `creating ${branch} with the operator's token answered "${why}", which proves nothing: ${problem}`;
    c.ok(`creating ${branch} with the operator's token was refused by a ruleset (${why}): the same token created ${siblingOf(branch)} on the same commit`);
    return null;
  }
  // It landed, so the ruleset does not protect the branch. Remove it at once: the first live tick creates it.
  await c.d.api.deleteRef(control, branch);
  return `the operator's token created ${branch} (deleted again): its ruleset does not restrict creation to the state App`;
}

/**
 * The control for that refusal: the same token and commit, and a name beside
 * the branch that no ruleset of ours covers. If this works too, the token, the
 * commit and the path were fine, so what refused the other was its name. Null
 * when it worked. The ruleset was checked to be exactly right before this. One
 * left by a run that died before deleting it is replaced, so a rerun ends clean.
 */
async function siblingCreated(c: Ctx, control: Repo, branch: string, sha: string): Promise<string | null> {
  const sibling = siblingOf(branch);
  try {
    if ((await c.d.api.branchSha(control, sibling)) !== null) await c.d.api.deleteRef(control, sibling);
    await c.d.api.createRef(control, sibling, sha);
  } catch (e) {
    return `${sibling}, which no ruleset here covers, failed too: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    await c.d.api.deleteRef(control, sibling);
  } catch (e) {
    return `${sibling} was created but could not be deleted, so delete it yourself: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}
