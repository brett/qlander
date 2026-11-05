// `qlander audit`, target side, the static rules: T1–T6 of
// docs/deployment.md §4.1, read from the target's workflow files at main.
// Each rule is a pure function of the config and the parsed workflows.

import type { LoadedConfig } from "../config/load";
import { epochBranchFor } from "../config/runner";
import type { Wf } from "./repo-view";
import { prefixSamples } from "./ruleset-checks";
import { fail, type Finding, pass, warn } from "./types";
import { branchFilterMatches, grantsIdToken, jobs, lineOf, pushPathFilter, runsOnPushTo, secretsIn, steps, stringsIn, triggers, unfilteredPush, type Yaml } from "./workflow";

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** A sample ref under a prefix, as the queue would create it. */
export const sample = (prefix: string, n = "1") => `${prefix}${n}`;

/** The first ref under `prefix` a push to which starts the workflow, if any. */
const anyPush = (wf: Yaml, prefix: string) => prefixSamples(prefix).find((r) => runsOnPushTo(wf, r));

export function t1(cfg: LoadedConfig, wfs: Wf[]): Finding[] {
  const N = cfg.config.names;
  const ref = sample(N.queuePrefix);
  const out: Finding[] = [];
  for (const e of cfg.config.preLanding) {
    const w = wfs.find((x) => x.path === e.path);
    if (!w) {
      out.push(fail("T1", `${e.path} (pre-landing) does not exist on ${N.main}`, "add the workflow, or remove it from queue.preLanding"));
      continue;
    }
    if (!w.wf) {
      out.push(fail("T1", `${e.path} cannot be parsed: ${w.error}`, "fix the workflow file"));
      continue;
    }
    const missed = prefixSamples(N.queuePrefix).find((r) => !runsOnPushTo(w.wf!, r));
    if (missed) {
      out.push(fail("T1", `${e.path} does not run on a push to ${missed}`, `add "${N.queuePrefix}**" to its push branches`));
      continue;
    }
    const pf = pushPathFilter(w.wf);
    if (pf && e.when !== "if_triggered") {
      out.push(fail("T1", `${e.path} has a push ${pf} filter, so a batch can skip it`, `remove the push ${pf} filter, or make the entry when: if_triggered`));
      continue;
    }
    out.push(pass("T1", `${e.path} runs on every push to ${ref}${pf ? ` (${pf} filter; when: if_triggered)` : ""}`));
  }
  return out;
}

/** A line that singles out main and does not mention the queue prefix. */
export function mainOnly(cfg: LoadedConfig): (s: string) => boolean {
  const N = cfg.config.names;
  const main = new RegExp(`refs/heads/${esc(N.main)}(?![\\w./-])|ref_name\\s*==\\s*['"]${esc(N.main)}['"]`);
  const queue = new RegExp(esc(N.queuePrefix));
  return (s) => main.test(s) && !queue.test(s);
}

/**
 * A condition that runs its job or step only on main, for T4: a plain
 * `github.ref == 'refs/heads/<main>'` (or `github.ref_name == '<main>'`),
 * with no `||` that could let another ref through and no mention of the
 * queue prefix. Anything else (`!=`, an `||`, a negation) is not trusted to
 * exclude queue pushes.
 */
export function gatesToMain(cfg: LoadedConfig): (cond: unknown) => boolean {
  const N = cfg.config.names;
  const eq = new RegExp(`github\\.ref\\s*==\\s*['"]refs/heads/${esc(N.main)}['"]|github\\.ref_name\\s*==\\s*['"]${esc(N.main)}['"]`);
  return (cond) => typeof cond === "string" && eq.test(cond) && !/\|\||!/.test(cond) && !cond.includes(N.queuePrefix);
}

/** Runner and environment routing are privileges (T4), not suite gates. */
const SKIP_T2 = /(^|\.)(runs-on|environment)(\.|\[|$)/;

export function t2(cfg: LoadedConfig, wfs: Wf[]): Finding[] {
  const N = cfg.config.names;
  const only = mainOnly(cfg);
  const out: Finding[] = [];
  for (const e of cfg.config.preLanding) {
    const w = wfs.find((x) => x.path === e.path);
    if (!w?.wf) continue; // T1 reports it
    const hits: string[] = [];
    for (const { path, value } of stringsIn(w.wf)) {
      if (SKIP_T2.test(path)) continue;
      for (const line of value.split("\n")) if (only(line)) hits.push(`${w.path}:${lineOf(w.text, line)} ${path}: ${line.trim().slice(0, 160)}`);
    }
    out.push(
      hits.length
        ? warn("T2", `${w.path}: ${hits.length} condition(s) single out ${N.main} without the queue prefix`, `a full-suite gate must accept "${N.queuePrefix}" pushes as well as ${N.main}; main-only privileges (caches, deploys) stay as they are`, hits)
        : pass("T2", `${w.path}: no condition singles out ${N.main} without the queue prefix`),
    );
  }
  return out;
}

export function t3(cfg: LoadedConfig, wfs: Wf[]): Finding[] {
  const N = cfg.config.names;
  const r = cfg.runner;
  const pre = new Set(cfg.config.preLanding.map((e) => e.path));
  const epochs = [epochBranchFor(r, "queue"), epochBranchFor(r, "release")];
  const out: Finding[] = [];
  for (const w of wfs) {
    if (!w.wf) {
      out.push(warn("T3", `${w.path} cannot be parsed: ${w.error}`, "fix the workflow file; its triggers could not be checked"));
      continue;
    }
    if (unfilteredPush(w.wf)) {
      out.push(fail("T3", `${w.path} has an unfiltered push trigger: every ref the queue creates or moves starts it`, "give its push trigger a branches (or tags) filter"));
      continue;
    }
    const build = anyPush(w.wf, N.buildPrefix);
    if (build) out.push(fail("T3", `${w.path} runs on a push to ${build}`, `exclude "${N.buildPrefix}**" from its push branches`));
    for (const b of epochs)
      if (runsOnPushTo(w.wf, b)) {
        const sev = r.epochFence ? fail : warn;
        out.push(sev("T3", `${w.path} runs on a push to the epoch branch ${b}${r.epochFence ? "" : " (epochFence is off)"}`, `exclude "${r.epochPrefix}**" from its push branches`));
      }
    if (!pre.has(w.path) && anyPush(w.wf, N.queuePrefix))
      out.push(warn("T3", `${w.path} runs on queue pushes but is not in queue.preLanding`, `add it to queue.preLanding, or drop "${N.queuePrefix}**" from its push branches`));
    for (const ev of ["create", "delete"])
      if (triggers(w.wf).has(ev)) out.push(warn("T3", `${w.path} triggers on ${ev}, which fires for every branch the queue ${ev}s`, `add an if: on github.ref to its jobs, or drop the ${ev} trigger`));
  }
  if (!out.length) out.push(pass("T3", `no workflow runs on ${N.buildPrefix}** or ${r.epochPrefix}** or has an unfiltered push; only queue.preLanding runs on ${N.queuePrefix}**`));
  return out;
}

export function t4(cfg: LoadedConfig, wfs: Wf[]): Finding[] {
  const gated = gatesToMain(cfg);
  const out: Finding[] = [];
  for (const w of wfs) {
    if (!w.wf || !anyPush(w.wf, cfg.config.names.queuePrefix)) continue;
    const hits: string[] = [];
    const wfSecrets = secretsIn({ env: w.wf.env });
    if (wfSecrets.length) hits.push(`${w.path}:${lineOf(w.text, "env:")} workflow env: secrets ${wfSecrets.join(", ")}`);
    for (const j of jobs(w.wf)) {
      if (gated(j.job.if)) continue;
      const at = `${w.path}:${lineOf(w.text, `${j.id}:`)} job ${j.id}`;
      if (j.job.environment !== undefined) {
        const env = typeof j.job.environment === "string" ? j.job.environment : (j.job.environment as Yaml | null)?.name;
        if (!gated(env)) hits.push(`${at}: environment ${JSON.stringify(env)}`);
      }
      const perms = j.job.permissions !== undefined ? j.job.permissions : w.wf.permissions;
      if (grantsIdToken(perms)) hits.push(`${at}: id-token: write`);
      const jobLevel = secretsIn({ env: j.job.env, with: j.job.with, secrets: j.job.secrets, services: j.job.services, container: j.job.container });
      if (jobLevel.length) hits.push(`${at}: secrets ${jobLevel.join(", ")}`);
      for (const s of steps(j.job)) {
        if (gated(s.if)) continue;
        const sec = secretsIn(s);
        if (sec.length) hits.push(`${at}, step ${JSON.stringify(s.name ?? s.uses ?? s.id ?? "?")}: secrets ${sec.join(", ")}`);
      }
    }
    out.push(
      hits.length
        ? warn("T4", `${w.path} runs on queue pushes and has ${hits.length} privilege(s) with no main-only condition`, `give each an if: that excludes "${cfg.config.names.queuePrefix}" pushes, or confirm the secret is read-only and the environment harmless`, hits)
        : pass("T4", `${w.path}: every environment, id-token and secret is main-only`),
    );
  }
  return out;
}

const BASELINE = /github\.event\.before|HEAD\^|HEAD~1?(?!\d)|--first-parent/;

export function t5(cfg: LoadedConfig, wfs: Wf[]): Finding[] {
  const N = cfg.config.names;
  const out: Finding[] = [];
  for (const w of wfs) {
    if (!w.wf || !anyPush(w.wf, N.queuePrefix)) continue;
    const hits = w.text
      .split("\n")
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => !l.trim().startsWith("#") && BASELINE.test(l))
      .map(({ l, i }) => `${w.path}:${i + 1} ${l.trim().slice(0, 160)}`);
    out.push(
      hits.length
        ? warn("T5", `${w.path}: ${hits.length} line(s) diff against the previous commit`, `on a "${N.queuePrefix}" push, compare with git merge-base HEAD origin/${N.main} instead (a batch is several commits)`, hits)
        : pass("T5", `${w.path}: no diff baseline assumes one commit per push`),
    );
  }
  return out;
}

export function t6(cfg: LoadedConfig, wfs: Wf[]): Finding[] {
  const fl = cfg.config.fastLane;
  const main = cfg.config.names.main;
  const w = wfs.find((x) => x.path === fl.workflowPath);
  if (!w) return [fail("T6", `the fast-lane workflow ${fl.workflowPath} does not exist on ${main}`, "add it, or fix queue.admission.fastLane.workflow")];
  if (!w.wf) return [fail("T6", `${fl.workflowPath} cannot be parsed: ${w.error}`, "fix the workflow file")];
  const t = triggers(w.wf);
  const out: Finding[] = [];
  if (!t.has(fl.event) || !branchFilterMatches(t.get(fl.event) ?? null, main))
    out.push(fail("T6", `${fl.workflowPath} does not run on ${fl.event} for PRs into ${main}`, `add a ${fl.event} trigger whose branches include ${main}`));
  if (!jobs(w.wf).some((j) => j.name === fl.job)) out.push(fail("T6", `${fl.workflowPath} has no job named exactly "${fl.job}"`, `name the fast-lane aggregate job "${fl.job}", or fix queue.admission.fastLane.job`));
  if (!out.length) out.push(pass("T6", `${fl.workflowPath} runs on ${fl.event} into ${main} and has the job "${fl.job}"`));
  return out;
}
