// T12, policy coverage (docs/deployment.md §4.1, DESIGN.md §4.3): every
// file of the policy set, and every local action, local reusable workflow
// and repo script those files run, must be inside queue.policy.paths, or a
// PR that weakens a gate through it is not treated as a CI-policy PR.
//
// The scan is static: `uses: ./…` lines and the files `run:` scripts execute
// (src/audit/workflow.ts executedPaths). What it cannot resolve is a WARN.

import type { LoadedConfig } from "../config/load";
import { parseQualificationManifest } from "../release";
import type { RepoView } from "./repo-view";
import { fail, type Finding, pass, readFailed, unread, warn } from "./types";
import { executedPaths, jobs, localUses, normalisePath, parseWorkflow, steps, type Yaml } from "./workflow";

/** The files the config names as gates: pre-landing and fast-lane workflows, the review producer, the release provider's inputs. */
export function policySet(cfg: LoadedConfig): string[] {
  const c = cfg.config;
  const set = new Set<string>(c.preLanding.map((e) => e.path));
  set.add(c.fastLane.workflowPath);
  if (c.review.adapter === "job@main") set.add(c.review.workflowPath);
  if (cfg.release.enabled) {
    const q = cfg.release.qualification;
    if (q.provider === "manifest") {
      if (q.source === "target") set.add(q.path);
      if (q.proof) set.add(q.proof.workflow);
    } else if (q.provider === "checks-green") for (const r of q.required) set.add(r.path);
    else {
      if (q.producerWorkflow) set.add(q.producerWorkflow);
      if (q.proof) set.add(q.proof.workflow);
    }
  }
  return [...set];
}

export async function t12(cfg: LoadedConfig, view: RepoView): Promise<Finding[]> {
  const globs = cfg.config.policyBoundary.map((g) => new Bun.Glob(g));
  const covered = (p: string) => globs.some((g) => g.match(p));
  const out: Finding[] = [];
  const uncovered = new Map<string, string>(); // path -> where it was found
  const unresolved: string[] = [];
  let readError = false;
  const named = new Set(policySet(cfg));
  // A target-hosted qualification manifest's listed workflows are read at main.
  const q = cfg.release.qualification;
  if (cfg.release.enabled && q.provider === "manifest" && q.source === "target") {
    const f = await view.file(q.path);
    if (f) {
      try {
        for (const r of parseQualificationManifest(JSON.parse(f.text))?.required ?? []) named.add(r.path);
      } catch {
        // T10 reports a manifest that does not parse
      }
    }
  }
  for (const p of named) if (!covered(p)) uncovered.set(p, "named in the config");
  const tree = await view.tree();
  if ("error" in tree) return [...[...uncovered].map(([p, w]) => fail("T12", `${p} is outside queue.policy.paths (${w})`, "add it to queue.policy.paths")), unread(warn("T12", `cannot read the repo tree at ${view.ref}: ${tree.error}`, "rerun with a token that can read the target's contents"), tree.cause)];
  if (tree.truncated) out.push(warn("T12", "the repo tree is too large to read whole; a script missing from it is reported as unresolved", "check the unresolved paths by hand"));
  const exists = (p: string) => tree.paths.has(p);

  const seen = new Set<string>();
  const todo = [...named].filter((p) => /\.ya?ml$/.test(p));
  const addUse = (u: unknown, where: string) => {
    const l = localUses(u);
    if (l === null) return;
    if (/\.ya?ml$/.test(l)) {
      if (!covered(l)) uncovered.set(l, where);
      todo.push(l);
      return;
    }
    const action = [`${l}/action.yml`, `${l}/action.yaml`].find(exists);
    if (!action) {
      unresolved.push(`${where}: uses ./${l}, which has no action.yml on ${view.ref}`);
      return;
    }
    if (!covered(action)) uncovered.set(action, where);
    todo.push(action);
  };
  const addRun = (run: unknown, wd: unknown, where: string) => {
    if (typeof run !== "string") return;
    const { paths, dynamic } = executedPaths(run);
    for (const d of dynamic) unresolved.push(`${where}: runs ${d}`);
    const dynWd = typeof wd === "string" && /\$|\{\{/.test(wd);
    for (const raw of paths) {
      if (dynWd) {
        unresolved.push(`${where}: runs ${raw} in working-directory ${wd}`);
        continue;
      }
      const full = normalisePath(typeof wd === "string" && wd ? `${wd}/${raw}` : raw);
      if (full === null) unresolved.push(`${where}: runs ${raw}, outside the repo`);
      else if (exists(full)) {
        if (!covered(full)) uncovered.set(full, where);
      } else if (!exists(raw)) unresolved.push(`${where}: runs ${raw}, not a file on ${view.ref}`);
      else if (!covered(raw)) uncovered.set(raw, where);
    }
  };
  while (todo.length) {
    const path = todo.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    let f: Awaited<ReturnType<RepoView["file"]>>;
    try {
      f = await view.file(path);
    } catch (e) {
      unresolved.push(`${path}: could not be read (${e instanceof Error ? e.message : String(e)})`);
      readError ||= readFailed(e);
      continue;
    }
    if (!f) {
      // a missing named file is T1, T6 or T10's finding; one reached through uses: is not
      if (!named.has(path)) unresolved.push(`${path}: not on ${view.ref}`);
      continue;
    }
    const p = parseWorkflow(f.text);
    if (!p.ok) {
      unresolved.push(`${path}: cannot be parsed (${p.error})`);
      continue;
    }
    const wf = p.wf;
    const run = (o: unknown) => ((o as Yaml | undefined)?.run as Yaml | undefined)?.["working-directory"];
    for (const j of jobs(wf)) {
      const at = `${path} job ${j.id}`;
      addUse(j.job.uses, at);
      const wd = run(j.job.defaults) ?? run(wf.defaults);
      for (const s of steps(j.job)) {
        addUse(s.uses, at);
        addRun(s.run, s["working-directory"] ?? wd, at);
      }
    }
    // an action: composite steps, or the files a JavaScript or Docker action runs
    const runs = wf.runs as Yaml | undefined;
    if (runs && typeof runs === "object") {
      if (Array.isArray(runs.steps))
        for (const s of runs.steps.filter((x): x is Yaml => typeof x === "object" && x !== null && !Array.isArray(x))) {
          addUse(s.uses, path);
          addRun(s.run, s["working-directory"], path);
        }
      const dir = path.slice(0, path.lastIndexOf("/"));
      for (const key of ["main", "pre", "post", "image"]) {
        const v = runs[key];
        if (typeof v !== "string" || v.startsWith("docker://")) continue;
        const full = normalisePath(`${dir}/${v}`);
        if (full === null) unresolved.push(`${path}: runs.${key} ${v} is outside the repo`);
        else if (!exists(full)) unresolved.push(`${path}: runs.${key} ${v}, not a file on ${view.ref}`);
        else if (!covered(full)) uncovered.set(full, path);
      }
    }
  }
  for (const [p, where] of [...uncovered].sort()) out.push(fail("T12", `${p} is outside queue.policy.paths (${where})`, "add it, or a glob over it, to queue.policy.paths, so a change to it is a CI-policy PR"));
  if (unresolved.length) {
    const f = warn("T12", `${new Set(unresolved).size} run: or uses: target(s) the static scan cannot resolve`, "check that each is a tool or a generated file, not a repo file outside queue.policy.paths", [...new Set(unresolved)]);
    out.push(readError ? { ...f, inconclusive: true } : f);
  }
  if (!uncovered.size && !unresolved.length) out.push(pass("T12", `the policy set and every local action, reusable workflow and script it runs are inside queue.policy.paths (${seen.size} file(s) scanned)`));
  return out;
}
