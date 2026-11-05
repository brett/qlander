// The manifest verdict (docs/qualification-manifest.md), in TypeScript. One
// verdict function for both the pre-landing manifest (DESIGN.md §6.1) and the
// release re-evaluation (§8). The semantics are "all jobs": every job in the
// newest evidence run must succeed, skipped only where allow_skipped_jobs
// says, and every required job must be present.

import type { Manifest, WorkflowEntry } from "./config";
import type { Job, JobsByRun, Run } from "./types";
import { isSha } from "./validate";

export type VerdictState = "success" | "pending" | "failure";

interface Problem {
  kind: "failure" | "pending";
  red: boolean;
  msg: string;
}

export interface Evidence {
  workflow: string;
  branch: string | null;
  run_id: number | null;
  run_attempt?: number;
  conclusion: string;
}

export interface Verdict {
  sha: string;
  state: VerdictState;
  problems: string[];
  evidence: Evidence[];
}

const isRed = (c: string | null) => c === "failure" || c === "timed_out";

export function eligible(run: Run, sha: string, repoId: number, patterns: RegExp[]): boolean {
  const branch = run.head_branch ?? "";
  return (
    run.head_sha === sha &&
    run.event === "push" &&
    run.repository?.id === repoId &&
    run.head_repository?.id === repoId &&
    patterns.some((p) => p.test(branch))
  );
}

function judgeRun(wf: WorkflowEntry, run: Run, jobs: Job[] | undefined): Problem[] {
  const at = `${wf.name} on ${run.head_branch}`;
  if (run.status !== "completed") {
    return [{ kind: "pending", red: false, msg: `${at}: run ${run.id} is ${run.status}` }];
  }
  if (jobs === undefined) {
    return [{ kind: "failure", red: false, msg: `${at}: run ${run.id} has no job list` }];
  }
  const names = new Set(jobs.map((j) => j.name));
  const out: Problem[] = [];
  if (run.conclusion !== "success") {
    out.push({
      kind: "failure",
      red: isRed(run.conclusion),
      msg: `${at}: run ${run.id} concluded ${run.conclusion ?? "unknown"}`,
    });
  }
  for (const n of wf.required_jobs) {
    if (!names.has(n)) out.push({ kind: "failure", red: false, msg: `${at}: required job '${n}' is missing` });
  }
  for (const j of jobs) {
    if (j.status !== "completed") {
      out.push({ kind: "pending", red: false, msg: `${at}: job '${j.name}' is ${j.status}` });
    } else if (j.conclusion === "success") {
      // ok
    } else if (j.conclusion === "skipped" && Object.hasOwn(wf.allow_skipped_jobs, j.name)) {
      // ok
    } else {
      out.push({
        kind: "failure",
        red: isRed(j.conclusion),
        msg: `${at}: job '${j.name}' is ${j.conclusion ?? "unknown"}`,
      });
    }
  }
  return out;
}

/** Newest run per head branch, for one workflow (jq: group_by(.head_branch) | max_by(.id)). */
function candidates(wf: WorkflowEntry, runs: Run[]): Run[] {
  const byBranch = new Map<string, Run>();
  for (const r of runs) {
    if (r.path !== wf.path) continue;
    const key = r.head_branch ?? "";
    const cur = byBranch.get(key);
    if (!cur || r.id > cur.id) byBranch.set(key, r);
  }
  return [...byBranch.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
}

export function judgeWorkflow(
  wf: WorkflowEntry,
  runs: Run[],
  jobsByRun: JobsByRun,
): { evidence: Evidence[]; problems: Problem[] } {
  const cands = candidates(wf, runs);
  if (cands.length === 0) {
    return {
      evidence: [
        {
          workflow: wf.name,
          branch: null,
          run_id: null,
          conclusion: wf.when === "if_triggered" ? "not triggered" : "missing",
        },
      ],
      problems:
        wf.when === "if_triggered"
          ? []
          : [{ kind: "pending", red: false, msg: `${wf.name}: no push run for this commit` }],
    };
  }
  const judged = cands.map((r) => ({ run: r, problems: judgeRun(wf, r, jobsByRun[String(r.id)]) }));
  const all = judged.flatMap((j) => j.problems);
  let problems: Problem[];
  if (all.some((p) => p.kind === "pending")) problems = all.filter((p) => p.kind === "pending");
  else if (all.some((p) => p.red)) problems = all.filter((p) => p.red);
  else if (judged.some((j) => j.problems.length === 0)) problems = [];
  else problems = all;
  return {
    evidence: cands.map((r) => ({
      workflow: wf.name,
      branch: r.head_branch,
      run_id: r.id,
      run_attempt: r.run_attempt,
      conclusion: r.conclusion ?? r.status,
    })),
    problems,
  };
}

export interface QualifyInput {
  manifest: { required: Manifest; evidence_branch_patterns?: string[]; branch?: string };
  sha: string;
  repo_id: number;
  on_main: boolean;
  runs: Run[];
  jobs: JobsByRun;
}

/** The verdict's top level. */
export function qualify(input: QualifyInput): Verdict {
  const patterns = (input.manifest.evidence_branch_patterns ?? ["^main$"]).map((p) => new RegExp(p));
  const runs = input.runs.filter((r) => eligible(r, input.sha, input.repo_id, patterns));
  const verdicts = input.manifest.required.map((wf) => judgeWorkflow(wf, runs, input.jobs));
  const problems: Problem[] = verdicts.flatMap((v) => v.problems);
  if (!input.on_main) {
    problems.push({ kind: "pending", red: false, msg: `not on ${input.manifest.branch ?? "main"} (yet)` });
  }
  const full = isSha(input.sha);
  const some = input.manifest.required.length > 0;
  const state: VerdictState =
    !(full && some)
      ? "failure"
      : problems.some((p) => p.kind === "failure")
        ? "failure"
        : problems.some((p) => p.kind === "pending")
          ? "pending"
          : "success";
  return {
    sha: input.sha,
    state,
    problems: [
      ...(full ? [] : ["not a full commit sha"]),
      ...(some ? [] : ["the manifest requires nothing"]),
      ...problems.map((p) => p.msg),
    ],
    evidence: verdicts.flatMap((v) => v.evidence),
  };
}
