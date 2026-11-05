// Release advance, the pure parts (DESIGN.md §8): the ref preflight, the
// manifest parser, the proof chain and the re-evaluation, which the
// qualification providers (qualification.ts) are built from, and the whole
// decision under the manifest provider (decideRelease). A commit is chosen
// only when it is (1) on main's first-parent chain and a strict descendant of
// the current release head, and (2) qualified by the configured provider.

import type { Manifest, RepoName } from "./config";
import type { ProofRun } from "./qualification";
import type { Job, JobsByRun, Run } from "./types";
import { isSha, runIdFromTargetUrl } from "./validate";
import { qualify } from "./verdict";

export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

export interface ReleaseCandidate {
  sha: string;
  /** On main's first-parent chain. */
  firstParent: boolean;
  /** compare release...sha */
  fromRelease: CompareStatus;
  /** Newest `qualified` status on sha. */
  status: { state: string; target_url: string | null } | null;
  /** The run the status points at, and its jobs (latest attempt). */
  proofRun: Run | null;
  proofJobs: Job[] | null;
  /** Push runs for sha and their jobs (latest attempt), for re-evaluation. */
  runs: Run[];
  jobs: JobsByRun;
}

export interface QualificationManifest {
  schema: number;
  branch?: string;
  evidence_branch_patterns?: string[];
  required: Manifest;
}

export interface ReleaseInput {
  release: string | null;
  main: string;
  /** compare release...main */
  releaseToMain: CompareStatus;
  /** The candidate listing hit its page limit. */
  truncated: boolean;
  /** Commits in release...main, newest first. */
  candidates: ReleaseCandidate[];
  manifest: unknown;
  manifestBlob: string;
  repoId: number;
  /** The target repo, by name, for the status's target_url. */
  target: RepoName;
  /** The target's main branch (target.main): the proof run must be on it. */
  mainBranch: string;
  /** The proof chain to require, or null for none. */
  proof: ProofRun | null;
}

/** Where a proof run must be: the target repo (by id and name) and its main branch. */
export type ProofTarget = Pick<ReleaseInput, "repoId" | "target" | "mainBranch">;

export interface ReceiptEvidence {
  workflow: string;
  branch: string | null;
  run_id: number | null;
  run_attempt?: number;
}

export interface Receipt {
  from: string;
  to: string;
  /** The policy version: the manifest's blob sha, or the blob sha of the config-held policy. */
  policyBlob: string;
  /** The proof run, when the provider requires one. */
  proofRun: number | null;
  evidence: ReceiptEvidence[];
}

export type ReleaseDecision =
  | { kind: "advance"; from: string; to: string; receipt: Receipt }
  | { kind: "none"; reason: string }
  | { kind: "alert"; reason: string };

const isPlain = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const onlyKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));
const isStringMap = (x: unknown) => isPlain(x) && Object.values(x).every(isStr);
const isRegex = (p: unknown) => {
  if (!isStr(p)) return false;
  try {
    new RegExp(p);
    return true;
  } catch {
    return false;
  }
};

const ENTRY_KEYS = ["path", "name", "when", "why", "required_jobs", "allow_skipped_jobs"];
const TOP_KEYS = ["schema", "status_context", "status_meaning", "branch", "evidence_branch_patterns", "required", "not_required"];
/** Keys starting with `$` are annotations (docs/qualification-manifest.md): any JSON value, never read. */
const isAnnotation = (k: string) => k.startsWith("$");
const knownKeys = (o: Record<string, unknown>, allowed: string[]) => onlyKeys(Object.fromEntries(Object.entries(o).filter(([k]) => !isAnnotation(k))), allowed);

/** One `required[]` entry: the same schema for a qualification manifest and the pre-landing manifest. */
export function isWorkflowEntry(x: unknown): boolean {
  if (!isPlain(x) || !knownKeys(x, ENTRY_KEYS)) return false;
  return (
    isStr(x.path) &&
    x.path.startsWith(".github/workflows/") &&
    isStr(x.name) &&
    (x.when === "always" || x.when === "if_triggered") &&
    (x.why === undefined || isStr(x.why)) &&
    Array.isArray(x.required_jobs) &&
    x.required_jobs.every(isStr) &&
    isStringMap(x.allow_skipped_jobs)
  );
}

/**
 * Strict validation of a qualification manifest, schema 1
 * (docs/qualification-manifest.md): unknown fields, wrong types, an array or
 * null where a map belongs, and invalid patterns all fail closed. A manifest
 * with no `when: always` entry is refused too: it could qualify a commit on
 * zero runs (docs/deployment.md §2).
 */
export function parseQualificationManifest(m: unknown): QualificationManifest | null {
  if (!isPlain(m) || !knownKeys(m, TOP_KEYS) || m.schema !== 1) return null;
  for (const k of ["status_context", "status_meaning", "branch"]) if (m[k] !== undefined && !isStr(m[k])) return null;
  const pats = m.evidence_branch_patterns;
  if (pats !== undefined && !(Array.isArray(pats) && pats.length > 0 && pats.every(isRegex))) return null;
  if (m.not_required !== undefined && !isStringMap(m.not_required)) return null;
  if (!Array.isArray(m.required) || m.required.length === 0 || !m.required.every(isWorkflowEntry)) return null;
  if (!m.required.some((e: { when?: unknown }) => e.when === "always")) return null;
  return m as unknown as QualificationManifest;
}

/**
 * qlander's own re-evaluation of a manifest for sha: verdict() must say
 * success AND cite at least one actual run. An absent `if_triggered` workflow
 * counts as satisfied with run_id null, so the evidence list alone proves
 * nothing (docs/deployment.md §2, no qualification from zero evidence).
 */
export function reevaluate(
  manifest: QualificationManifest,
  sha: string,
  repoId: number,
  runs: Run[],
  jobs: JobsByRun,
): { ok: true; evidence: ReceiptEvidence[] } | { ok: false; reason: string } {
  const v = qualify({ manifest, sha, repo_id: repoId, on_main: true, runs, jobs });
  if (v.state !== "success") return { ok: false, reason: `re-evaluation ${v.state}: ${v.problems.slice(0, 3).join("; ")}` };
  if (!v.evidence.some((e) => e.run_id !== null)) return { ok: false, reason: "re-evaluation cites no run (zero evidence)" };
  return { ok: true, evidence: v.evidence.map(({ workflow, branch, run_id, run_attempt }) => ({ workflow, branch, run_id, run_attempt })) };
}

/** The proof job's name for one candidate: every `{sha}` in the template replaced by it. */
export const proofJobName = (template: string, sha: string) => template.replaceAll("{sha}", sha);

/** The proof chain: status → run of the proof workflow on main → the job named by `jobTemplate` for this sha. */
export function proofChain(c: ReleaseCandidate, at: ProofTarget, proof: ProofRun): string | null {
  const { repoId } = at;
  const { workflow: qualifyWorkflowPath, events, jobTemplate } = proof;
  if (!c.status || c.status.state !== "success") return "no qualified=success status";
  const runId = runIdFromTargetUrl(at.target, c.status.target_url);
  if (runId === null) return `status does not point at a ${at.target.name} Actions run`;
  const r = c.proofRun;
  if (!r || r.id !== runId) return `run ${runId} not readable`;
  if (r.path !== qualifyWorkflowPath) return `run ${runId} is ${r.path}, not ${qualifyWorkflowPath}`;
  if (r.head_branch !== at.mainBranch || !events.includes(r.event)) return `run ${runId} is ${r.event} on ${r.head_branch}, not a ${at.mainBranch} run`;
  if (r.repository?.id !== repoId || r.head_repository?.id !== repoId) return `run ${runId} is in another repository, or runs another repository's code`;
  const name = proofJobName(jobTemplate, c.sha);
  const job = c.proofJobs?.find((j) => j.name === name);
  if (!job || job.status !== "completed" || job.conclusion !== "success") return `run ${runId} has no successful job '${name}'`;
  return null;
}

/** The checks before any candidate and before the policy: the refs, their relation and discovery completeness. */
export function preflightRefs(
  i: Pick<ReleaseInput, "release" | "main" | "releaseToMain" | "truncated">,
): { kind: "go"; release: string } | Exclude<ReleaseDecision, { kind: "advance" }> {
  if (i.release === null) return { kind: "none", reason: "release branch does not exist" };
  if (!isSha(i.release) || !isSha(i.main)) return { kind: "alert", reason: "release or main is not a sha" };
  if (i.releaseToMain === "identical") return { kind: "none", reason: "release is main" };
  if (i.releaseToMain === "diverged" || i.releaseToMain === "behind") {
    return { kind: "alert", reason: `release-blocked: main is ${i.releaseToMain} release (an unmerged hotfix?)` };
  }
  if (i.truncated) return { kind: "alert", reason: "release-blocked: candidate listing truncated" };
  return { kind: "go", release: i.release };
}

/** preflightRefs, then the manifest. */
export function preflight(
  i: Pick<ReleaseInput, "release" | "main" | "releaseToMain" | "truncated" | "manifest">,
): { kind: "go"; release: string; manifest: QualificationManifest } | Exclude<ReleaseDecision, { kind: "advance" }> {
  const refs = preflightRefs(i);
  if (refs.kind !== "go") return refs;
  const manifest = parseQualificationManifest(i.manifest);
  if (!manifest) return { kind: "alert", reason: "qualification.json is missing, malformed or not schema 1" };
  return { kind: "go", release: refs.release, manifest };
}

/**
 * One candidate under the manifest provider: on main's first-parent chain, a
 * strict descendant of release, proved by the proof chain (when configured),
 * and qualified again by qlander's own evaluation. Returns the receipt,
 * or why not.
 */
export function judgeCandidate(
  c: ReleaseCandidate,
  ctx: ProofTarget & { release: string; manifest: QualificationManifest; manifestBlob: string; proof: ProofRun | null },
): { ok: true; receipt: Receipt } | { ok: false; reason: string } {
  if (!isSha(c.sha)) return { ok: false, reason: `${String(c.sha)}: not a sha` };
  if (!c.firstParent) return { ok: false, reason: `${c.sha}: not on main's first-parent chain` };
  if (c.fromRelease !== "ahead") return { ok: false, reason: `${c.sha}: not a descendant of release (${c.fromRelease})` };
  if (ctx.proof) {
    const chain = proofChain(c, ctx, ctx.proof);
    if (chain) return { ok: false, reason: `${c.sha}: ${chain}` };
  }
  const v = reevaluate(ctx.manifest, c.sha, ctx.repoId, c.runs, c.jobs);
  if (!v.ok) return { ok: false, reason: `${c.sha}: ${v.reason}` };
  return {
    ok: true,
    receipt: { from: ctx.release, to: c.sha, policyBlob: ctx.manifestBlob, proofRun: ctx.proof ? c.proofRun!.id : null, evidence: v.evidence },
  };
}

export function decideRelease(i: ReleaseInput): ReleaseDecision {
  const pre = preflight(i);
  if (pre.kind !== "go") return pre;
  const ctx = { release: pre.release, manifest: pre.manifest, manifestBlob: i.manifestBlob, repoId: i.repoId, target: i.target, mainBranch: i.mainBranch, proof: i.proof };
  const refused: string[] = [];
  for (const c of i.candidates) {
    if (!isSha(c.sha) || !c.firstParent) continue;
    const j = judgeCandidate(c, ctx);
    if (j.ok) return { kind: "advance", from: pre.release, to: c.sha, receipt: j.receipt };
    refused.push(j.reason);
  }
  return { kind: "none", reason: refused.length ? `no qualified candidate: ${refused.slice(0, 5).join(" | ")}` : "no candidates" };
}
