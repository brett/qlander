// `qlander audit`, target side (docs/deployment.md §4.1): the static
// workflow rules (target-static.ts), the newest queue run's jobs (T7), the
// rulesets (T8, T10), the labels (T9), the Apps (T11) and policy coverage
// (T12, policy-coverage.ts). Read-only, with the token in GH_TOKEN.

import type { WorkflowEntry } from "../config";
import type { LoadedConfig } from "../config/load";
import { epochBranchFor } from "../config/runner";
import { GitHubError } from "../github/http";
import { parseQualificationManifest } from "../release";
import type { Job, Run } from "../types";
import { appChecks, type AppIdentity } from "./apps";
import { t12 } from "./policy-coverage";
import { releaseRequiredChecks } from "../setup/expected";
import { type RepoInfo, RepoView, type Wf, why } from "./repo-view";
import { branchRulesets, landingRequirements, noBypassRule, prefixRuleset, refsRuleset, type RulesetCtx } from "./ruleset-checks";
import { appliesTo, hasRule, readRulesets } from "./rulesets";
import { t1, t2, t3, t4, t5, t6 } from "./target-static";
import { type AuditGh, couldNotCheck, fail, type Finding, guard, pass, readFailed, skipped, unread, warn } from "./types";
import { branchFilterMatches, triggers } from "./workflow";

// --- T7: the newest completed run's jobs against the pre-landing manifest ---------

/**
 * A required job that is missing, or a skip that allow_skipped_jobs does not
 * list. In a run that did not succeed, a job can be skipped because one it
 * needs failed, so only missing jobs count there.
 */
export function jobProblems(e: WorkflowEntry, seen: Job[], succeeded = true): string[] {
  const names = new Set(seen.map((j) => j.name));
  const out: string[] = [];
  for (const n of e.required_jobs) if (!names.has(n)) out.push(`required job "${n}" is missing`);
  if (succeeded) for (const j of seen) if (j.conclusion === "skipped" && !Object.hasOwn(e.allow_skipped_jobs, j.name)) out.push(`job "${j.name}" was skipped and is not in allow_skipped_jobs`);
  return out;
}

/** The newest completed (not cancelled) push run of a workflow on a branch `want` accepts. */
async function newestRun(gh: AuditGh, repo: string, path: string, want: (branch: string) => boolean): Promise<Run | null> {
  const file = encodeURIComponent(path.split("/").pop()!);
  const page = await gh.get<{ workflow_runs?: Run[] }>(`repos/${repo}/actions/workflows/${file}/runs`, { event: "push", status: "completed", per_page: 100 });
  if (!Array.isArray(page?.workflow_runs)) throw new GitHubError("server", null, `${path}: the run listing has no list`);
  const runs = page.workflow_runs
    .filter((r) => r.path?.split("@")[0] === path && r.head_branch !== null && want(r.head_branch) && r.conclusion !== "cancelled" && r.conclusion !== "skipped")
    .sort((a, b) => b.id - a.id);
  return runs[0] ?? null;
}

export async function t7(cfg: LoadedConfig, gh: AuditGh, repo: string): Promise<Finding[]> {
  const N = cfg.config.names;
  const out: Finding[] = [];
  for (const e of cfg.config.preLanding) {
    try {
      let run = await newestRun(gh, repo, e.path, (b) => b.startsWith(N.queuePrefix));
      let where = "queue";
      if (!run) {
        run = await newestRun(gh, repo, e.path, (b) => b === N.main);
        where = N.main;
      }
      if (!run) {
        out.push(warn("T7", `${e.path}: no completed push run on a queue ref or ${N.main} to check the job names against`, "rerun audit once the workflow has run"));
        continue;
      }
      const { items, truncated } = await gh.list<Job>(`repos/${repo}/actions/runs/${run.id}/jobs`, { filter: "latest" }, (p) => (p as { jobs?: Job[] } | null)?.jobs);
      if (truncated) throw new Error(`the job listing of run ${run.id} was incomplete`);
      const ok = run.conclusion === "success";
      const problems = jobProblems(e, items, ok);
      const label = `${e.path}: run ${run.id} (${where} push, ${run.head_branch}, ${run.conclusion})`;
      out.push(
        problems.length
          ? fail("T7", `${label} does not match queue.preLanding`, "fix required_jobs / allow_skipped_jobs, or the job names in the workflow", problems)
          : pass("T7", ok ? `${label} has every required job and skips only listed ones (${items.length} jobs)` : `${label} has every required job (skips not judged: the run did not succeed)`),
      );
    } catch (err) {
      out.push(unread(warn("T7", `${e.path}: could not read its runs: ${why(err)}`, "rerun with a token that can read the target's Actions"), err));
    }
  }
  return out;
}

// --- T8: rulesets on main, the queue refs and the epoch branches -------------

export function t8(cfg: LoadedConfig, c: RulesetCtx, queueApp: AppIdentity | undefined, release: AppIdentity | undefined, classic: boolean | null): Finding[] {
  const N = cfg.config.names;
  const out = branchRulesets("T8", N.main, queueApp, c);
  out.push(...landingRequirements("T8", N.main, c, { contexts: [cfg.config.fastLane.job], strict: false, mergeOnly: false }));
  out.push(...prefixRuleset("T8", "queue refs", N.queuePrefix, queueApp, c), ...prefixRuleset("T8", "build refs", N.buildPrefix, queueApp, c));
  if (cfg.runner.epochFence) {
    const owners: [string, AppIdentity | undefined][] = [[epochBranchFor(cfg.runner, "queue"), queueApp]];
    if (cfg.release.enabled) owners.push([epochBranchFor(cfg.runner, "release"), release]);
    for (const [b, app] of owners) {
      out.push(...refsRuleset("T8", "epoch-write", [b], app, c));
      for (const rule of ["non_fast_forward", "deletion"]) out.push(noBypassRule("T8", "epoch-integrity", b, rule, c));
    }
  } else out.push(skipped("T8", "epoch rulesets: not checked, runner.epochFence is off"));
  const mq = c.rulesets.filter((r) => appliesTo(r, N.main, c.defaultBranch) && hasRule(r, "merge_queue"));
  out.push(mq.length ? fail("T8", `${N.main}: GitHub's merge queue is on (${mq.map((r) => r.name).join(", ")})`, "turn the native merge queue off") : pass("T8", `${N.main}: GitHub's merge queue is off`));
  if (classic === null) out.push(skipped("T8", `${N.main}: classic branch protection not read (needs an admin token)`));
  else if (classic) out.push(warn("T8", `${N.main} still has classic branch protection`, "replace it with the rulesets"));
  return out;
}

// --- T9: labels ---------------------------------------------------------------

export async function t9(cfg: LoadedConfig, gh: AuditGh, repo: string): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [role, name] of Object.entries(cfg.config.names.labels)) {
    if (typeof name !== "string") continue;
    try {
      await gh.get(`repos/${repo}/labels/${encodeURIComponent(name)}`);
      out.push(pass("T9", `label "${name}" (${role}) exists`));
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") out.push(fail("T9", `label "${name}" (${role}) does not exist`, "create it (setup --step target does)"));
      else out.push(unread(warn("T9", `label "${name}" (${role}) could not be read: ${why(e)}`, "rerun with a token that can read the target's issues"), e));
    }
  }
  return out;
}

// --- T10: release ---------------------------------------------------------------

export async function t10(cfg: LoadedConfig, view: RepoView, wfs: Wf[], c: RulesetCtx | null, releaseApp: AppIdentity | undefined): Promise<Finding[]> {
  if (!cfg.release.enabled) return [skipped("T10", "release advance is off (release.enabled: false)")];
  const out: Finding[] = [];
  try {
    await t10Checks(out, cfg, view, wfs, c, releaseApp);
  } catch (e) {
    out.push(couldNotCheck("T10", "T10", e)); // what it had found still counts
  }
  return out;
}

async function t10Checks(out: Finding[], cfg: LoadedConfig, view: RepoView, wfs: Wf[], c: RulesetCtx | null, releaseApp: AppIdentity | undefined): Promise<void> {
  const R = cfg.release;
  // In dry run nothing ships through release advance, so its gaps are warnings.
  const sev = R.dryRun ? warn : fail;
  const tag = R.dryRun ? " (release.dryRun)" : "";
  const main = cfg.config.names.main;
  const branch = cfg.config.names.release;
  try {
    await view.gh.get(`repos/${view.repo}/branches/${encodeURIComponent(branch)}`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.kind === "not_found")) throw e;
    out.push(sev("T10", `the release branch ${branch} does not exist${tag}`, `create ${branch} at a qualified commit of ${main}`));
  }
  if (c) out.push(...[...branchRulesets("T10", branch, releaseApp, c, sev, true, R.mode === "dispatch", R.dispatch?.promoterApps ?? []), ...landingRequirements("T10", branch, c, { contexts: releaseRequiredChecks(cfg), strict: true, mergeOnly: true }, sev)].map((f) => (f.status === "WARN" ? { ...f, message: f.message + tag } : f)));
  for (const e of cfg.config.preLanding) {
    const w = wfs.find((x) => x.path === e.path);
    if (!w?.wf) continue;
    const t = triggers(w.wf);
    out.push(
      t.has("pull_request") && branchFilterMatches(t.get("pull_request") ?? null, branch)
        ? pass("T10", `${e.path} runs on PRs into ${branch} (whether that run is the full suite is not checked statically)`)
        : sev("T10", `${e.path} does not run on PRs into ${branch}${tag}`, `add ${branch} to its pull_request branches, running the full suite (the hotfix path)`),
    );
  }
  const need = async (path: string, what: string) => {
    const f = await view.file(path);
    out.push(f ? pass("T10", `${what} ${path} exists on ${main}`) : sev("T10", `${what} ${path} does not exist on ${main}${tag}`, "add it, or fix release.qualification"));
    return f;
  };
  // The provider's evidence has been seen on main: its proof workflow has run, and its status context is on a recent commit.
  const ran = async (path: string) => {
    try {
      const r = await view.gh.get<{ total_count?: number; workflow_runs?: unknown[] }>(`repos/${view.repo}/actions/workflows/${encodeURIComponent(path.split("/").pop()!)}/runs`, { branch: main, per_page: 1 });
      const n = r?.total_count ?? r?.workflow_runs?.length ?? 0;
      out.push(n > 0 ? pass("T10", `${path} has run on ${main}`) : sev("T10", `${path} has never run on ${main}${tag}`, "let it run on main before release advance relies on it"));
    } catch (e) {
      out.push(unread(warn("T10", `${path}: its runs could not be read: ${why(e)}`, "rerun with a token that can read the target's Actions"), e));
    }
  };
  const seen = async (context: string) => {
    try {
      const commits = await view.gh.get<{ sha: string }[]>(`repos/${view.repo}/commits`, { sha: main, per_page: 5 });
      for (const c of commits ?? []) {
        const st = await view.gh.get<{ statuses?: { context: string }[] }>(`repos/${view.repo}/commits/${c.sha}/status`);
        if (!Array.isArray(st?.statuses)) throw new GitHubError("server", null, `${c.sha}: the status listing has no list`);
        if (st.statuses.some((s) => s.context === context)) {
          out.push(pass("T10", `status "${context}" seen on ${main} (${c.sha.slice(0, 12)})`));
          return;
        }
      }
      out.push(sev("T10", `status "${context}" is on none of the newest ${(commits ?? []).length} commits of ${main}${tag}`, "check that the producer posts it on main"));
    } catch (e) {
      out.push(unread(warn("T10", `status "${context}" could not be looked for: ${why(e)}`, "rerun with a token that can read commit statuses"), e));
    }
  };
  const q = R.qualification;
  if (q.provider === "manifest") {
    if (q.source === "target") {
      const f = await need(q.path, "the qualification manifest");
      if (f) {
        let m: ReturnType<typeof parseQualificationManifest> = null;
        try {
          m = parseQualificationManifest(JSON.parse(f.text));
        } catch {
          m = null;
        }
        if (!m) out.push(sev("T10", `${q.path} is not a valid qualification manifest${tag}`, "fix it (schema 1, at least one when: always entry)"));
        else {
          out.push(pass("T10", `${q.path} parses (${m.required.length} required workflow(s))`));
          for (const r of m.required) await need(r.path, "the manifest's workflow");
        }
      }
    }
    if (q.proof) {
      if (await need(q.proof.workflow, "the proof workflow")) await ran(q.proof.workflow);
      await seen(q.proof.statusContext);
    }
  } else if (q.provider === "checks-green") {
    for (const r of q.required) await need(r.path, "the required workflow");
  } else {
    if (q.producerWorkflow && (await need(q.producerWorkflow, "the status producer workflow"))) await ran(q.producerWorkflow);
    if (q.proof && (await need(q.proof.workflow, "the proof workflow"))) await ran(q.proof.workflow);
    await seen(q.context);
  }
}

// --- the whole target audit ---------------------------------------------------------

export async function auditTarget(gh: AuditGh, cfg: LoadedConfig, apps: AppIdentity[]): Promise<Finding[]> {
  const N = cfg.config.names;
  const repo = `${N.target.owner}/${N.target.name}`;
  const view = new RepoView(gh, repo, N.main);
  let info: RepoInfo;
  try {
    info = await view.info();
  } catch (e) {
    return [unread(fail("T0", `cannot read the target ${repo}: ${why(e)}`, "check target.repo and the token"), e)];
  }
  if (info.id !== undefined && info.id !== N.target.id) return [fail("T0", `${repo} has id ${info.id}, the config says ${N.target.id}`, "fix target.repoId")];
  const out: Finding[] = [];
  const admin = info.permissions?.admin === true;
  if (!admin) out.push(skipped("T0", `the token is not an admin of ${repo}: rules that need admin are SKIPPED`, "rerun with an admin token for a complete audit"));
  let wfs: Wf[] | null = null;
  try {
    wfs = await view.workflows();
  } catch (e) {
    out.push(unread(warn("T1", `the target's workflows could not be read: ${why(e)}; T1 to T6 are unverified`, "rerun with a token that can read the target's contents"), e));
  }
  if (wfs) {
    const w = wfs;
    for (const [id, rule] of [["T1", t1], ["T2", t2], ["T3", t3], ["T4", t4], ["T5", t5], ["T6", t6]] as const) out.push(...(await guard(id, id, () => rule(cfg, w))));
  }
  out.push(...(await guard("T7", "T7", () => t7(cfg, gh, repo))));
  const queueApp = apps.find((a) => a.role === "queue");
  const releaseApp = apps.find((a) => a.role === "release");
  const rs = await readRulesets(gh, repo);
  let rc: RulesetCtx | null = null;
  if (!rs.ok) out.push(unread(warn("T8", `cannot read the target's rulesets: ${rs.error}`, "rerun with a token that can read the repo's rulesets"), rs.cause));
  else {
    rc = { rulesets: rs.rulesets, admin: admin && rs.bypassVisible, defaultBranch: info.default_branch, appNames: new Map(apps.filter((a) => a.id !== null).map((a) => [a.id!, a.slug])) };
    let classic: boolean | null = null;
    if (admin) {
      try {
        await gh.get(`repos/${repo}/branches/${encodeURIComponent(N.main)}/protection`);
        classic = true;
      } catch (e) {
        classic = e instanceof GitHubError && e.kind === "not_found" ? false : null;
        if (readFailed(e)) out.push(unread(skipped("T8", `${N.main}: classic branch protection could not be read: ${why(e)}`), e));
      }
    }
    const ctx = rc;
    out.push(...(await guard("T8", "T8", () => t8(cfg, ctx, queueApp, releaseApp, classic))));
  }
  out.push(...(await guard("T9", "T9", () => t9(cfg, gh, repo))));
  out.push(...(await guard("T10", "T10", () => t10(cfg, view, wfs ?? [], rc, releaseApp))));
  out.push(...(await guard("T11", "T11", () => appChecks(gh, N.target.owner, apps.filter((a) => a.role === "queue" || (a.role === "release" && cfg.release.enabled)), "T11", cfg.release, cfg.runner.epochFence))));
  out.push(...(await guard("T12", "T12", () => t12(cfg, view))));
  return out;
}
