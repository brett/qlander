// Qualification providers for release advance (docs/deployment.md §2). The
// release job's discovery, strict-descendant check, CAS and receipt are
// shared (release-runner.ts); only "is this commit qualified?" is pluggable,
// and the config selects one provider:
//
//   manifest       a JSON qualification manifest (docs/qualification-manifest.md),
//                  read from the target's main or from this repo, re-evaluated
//                  with verdict(); optionally behind a proof chain
//   checks-green   a manifest held in the config itself (default: a copy of
//                  queue.preLanding), re-evaluated the same way
//   commit-status  the newest status of one context, posted by a listed account;
//                  optionally behind the same proof chain
//
// A provider that evaluates a manifest never qualifies a commit on zero
// evidence runs (§2): parseQualificationManifest refuses a manifest with no
// `when: always` entry, and reevaluate() refuses a verdict that cites no run.

import { readFileSync } from "node:fs";
import type { Manifest, Names } from "./config";
import type { TargetApi } from "./github/api";
import { parseQualificationManifest, proofChain, type ProofTarget, type QualificationManifest, type ReleaseCandidate, reevaluate, type ReceiptEvidence } from "./release";
import type { JobsByRun, Run } from "./types";
import { runIdFromTargetUrl } from "./validate";
import { eligible } from "./verdict";

/** A run of `workflow` on main, for one of `events`, whose latest attempt has a successful job named `jobTemplate` with {sha} = the candidate. */
export interface ProofRun {
  workflow: string;
  events: string[];
  jobTemplate: string;
}

/** The proof chain: the newest `statusContext` status on the candidate is success and points at a ProofRun. */
export interface Proof extends ProofRun {
  statusContext: string;
}

export type Qualification =
  | { provider: "manifest"; source: "target" | "control"; path: string; proof: Proof | null }
  | { provider: "checks-green"; required: Manifest }
  | {
      provider: "commit-status";
      context: string;
      /** Account ids (users or App bots) whose status counts. Never empty. */
      creators: number[];
      /** The workflow that posts the status, when a creator is github-actions[bot]; a gate, so a policy path. */
      producerWorkflow: string | null;
      /** "actions-run": the status's target_url must be an Actions run in the target repo. */
      targetUrl: "actions-run" | null;
      proof: ProofRun | null;
    };

export type Refusal = { ok: false; reason: string };
export type Screened = { ok: true; proofRun: number | null; evidence?: ReceiptEvidence[] };

export interface QualificationProvider {
  /** Once per tick, at main: the policy version recorded in the receipt (a 40-hex sha), or why nothing can be judged (an alert). */
  policy(main: string): Promise<{ ok: true; version: string } | Refusal>;
  /** The cheap check, before ancestry is read: a status and its proof run. */
  screen(sha: string): Promise<Screened | Refusal>;
  /** The full judgement: the evidence the receipt records. */
  judge(sha: string, screened: Screened): Promise<{ ok: true; evidence: ReceiptEvidence[] } | Refusal>;
}

/** Git's blob id of a text: the policy version of a config-held or control-hosted policy. */
export function blobSha(text: string): string {
  const body = Buffer.from(text, "utf8");
  return new Bun.CryptoHasher("sha1").update(Buffer.concat([Buffer.from(`blob ${body.length}\0`), body])).digest("hex");
}

/** Push runs of sha for the listed workflows, with complete job lists for the runs verdict() judges; or why not. */
async function gather(c: TargetApi, sha: string, m: QualificationManifest): Promise<{ runs: Run[]; jobs: JobsByRun } | Refusal> {
  const patterns = (m.evidence_branch_patterns ?? ["^main$"]).map((p) => new RegExp(p));
  const paths = new Set(m.required.map((w) => w.path));
  const listed = await c.listRuns({ headSha: sha, event: "push" });
  // A failing run past the page limit would be invisible: an incomplete listing qualifies nothing.
  if (listed.truncated) return { ok: false, reason: `${sha}: push run list incomplete` };
  const runs = listed.items.filter((r) => paths.has(r.path) && eligible(r, sha, c.repoId, patterns));
  // The runs verdict() judges: the newest per workflow and branch. Their job
  // lists must be complete: a missing list is not red, so a green run on
  // another branch would otherwise outvote a failed run whose jobs were cut.
  const selected = new Map<string, Run>();
  for (const r of runs) {
    const k = `${r.path}\n${r.head_branch ?? ""}`;
    const cur = selected.get(k);
    if (!cur || r.id > cur.id) selected.set(k, r);
  }
  const jobs: JobsByRun = {};
  for (const r of selected.values()) {
    const l = await c.listJobs(r.id);
    if (l.truncated) return { ok: false, reason: `${sha}: run ${r.id} job list incomplete` };
    jobs[String(r.id)] = l.items;
  }
  return { runs, jobs };
}

/** A candidate with only the proof fields filled, for proofChain. */
async function proofCandidate(c: TargetApi, at: ProofTarget, sha: string, status: { state: string; target_url: string | null } | null): Promise<ReleaseCandidate> {
  const cand: ReleaseCandidate = { sha, firstParent: true, fromRelease: "diverged", status, proofRun: null, proofJobs: null, runs: [], jobs: {} };
  const runId = status?.state === "success" ? runIdFromTargetUrl(at.target, status.target_url) : null;
  if (runId !== null) {
    cand.proofRun = await c.getRun(runId);
    if (cand.proofRun) {
      const jobs = await c.listJobs(runId);
      cand.proofJobs = jobs.truncated ? null : jobs.items; // an incomplete list proves nothing
    }
  }
  return cand;
}

/** Re-evaluation of a parsed manifest for sha, shared by `manifest` and `checks-green`. */
function evaluator(c: TargetApi, current: () => QualificationManifest) {
  return async (sha: string): Promise<{ ok: true; evidence: ReceiptEvidence[] } | Refusal> => {
    const m = current();
    const g = await gather(c, sha, m);
    if ("ok" in g) return g;
    const v = reevaluate(m, sha, c.repoId, g.runs, g.jobs);
    return v.ok ? v : { ok: false, reason: `${sha}: ${v.reason}` };
  };
}

export interface ProviderDeps {
  target: TargetApi;
  /** The target repo's name and main branch (the config's names). */
  names: Pick<Names, "target" | "main">;
  /** Reads a control-repo file (source: control), or null when it is missing. */
  readControlFile: (path: string) => string | null;
}

/** Where proof runs must be, for this target. */
const proofTarget = (d: ProviderDeps): ProofTarget => ({ repoId: d.target.repoId, target: d.names.target, mainBranch: d.names.main });

function manifestProvider(q: Extract<Qualification, { provider: "manifest" }>, d: ProviderDeps): QualificationProvider {
  const c = d.target;
  let manifest: QualificationManifest | null = null;
  const bad = { ok: false as const, reason: `${q.path} is missing, malformed or not schema 1 (or has no when: always entry)` };
  return {
    async policy(main) {
      let text: string | null = null;
      let version = "";
      if (q.source === "target") {
        const file = await c.getDataFile(q.path, main);
        if (file) ({ text, blobSha: version } = file);
      } else {
        text = d.readControlFile(q.path);
        if (text !== null) version = blobSha(text);
      }
      if (text === null) return bad;
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return bad;
      }
      manifest = parseQualificationManifest(raw);
      return manifest ? { ok: true, version } : bad;
    },
    async screen(sha) {
      if (!q.proof) return { ok: true, proofRun: null };
      const proof = q.proof;
      const st = (await c.listStatuses(sha)).find((s) => s.context === proof.statusContext);
      const cand = await proofCandidate(c, proofTarget(d), sha, st ? { state: st.state, target_url: st.targetUrl } : null);
      const chain = proofChain(cand, proofTarget(d), proof);
      return chain === null ? { ok: true, proofRun: cand.proofRun!.id } : { ok: false, reason: `${sha}: ${chain}` };
    },
    judge: evaluator(c, () => manifest!),
  };
}

function checksGreenProvider(q: Extract<Qualification, { provider: "checks-green" }>, d: ProviderDeps): QualificationProvider {
  // Evidence from the target's main only, with the queue's rules (push, both repository ids).
  const main = d.names.main;
  const manifest: QualificationManifest = { schema: 1, branch: main, evidence_branch_patterns: [`^${main.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`], required: q.required };
  return {
    async policy() {
      return { ok: true, version: blobSha(JSON.stringify(q.required)) };
    },
    async screen() {
      return { ok: true, proofRun: null };
    },
    judge: evaluator(d.target, () => manifest),
  };
}

function commitStatusProvider(q: Extract<Qualification, { provider: "commit-status" }>, d: ProviderDeps): QualificationProvider {
  const c = d.target;
  return {
    async policy() {
      return { ok: true, version: blobSha(JSON.stringify(q)) };
    },
    async screen(sha) {
      const listed = await c.listCommitStatuses(sha);
      // Newest first: the first entry for the context is its current state.
      const st = listed.items.find((s) => s.context === q.context);
      if (!st) return { ok: false, reason: `${sha}: no ${q.context} status${listed.truncated ? " (status history incomplete)" : ""}` };
      if (st.state !== "success") return { ok: false, reason: `${sha}: the newest ${q.context} status is ${st.state}` };
      if (st.creatorId === null || !q.creators.includes(st.creatorId)) return { ok: false, reason: `${sha}: the ${q.context} status was posted by account ${st.creatorId ?? "unknown"}, not a listed creator` };
      const runId = runIdFromTargetUrl(d.names.target, st.targetUrl);
      if ((q.targetUrl === "actions-run" || q.proof) && runId === null) return { ok: false, reason: `${sha}: the ${q.context} status does not point at an Actions run in the target repo` };
      let proofRun: number | null = null;
      if (q.proof) {
        const cand = await proofCandidate(c, proofTarget(d), sha, { state: st.state, target_url: st.targetUrl });
        const chain = proofChain(cand, proofTarget(d), q.proof);
        if (chain !== null) return { ok: false, reason: `${sha}: ${chain}` };
        proofRun = cand.proofRun!.id;
      }
      return { ok: true, proofRun, evidence: [{ workflow: `status ${q.context}`, branch: null, run_id: runId }] };
    },
    async judge(_sha, screened) {
      return { ok: true, evidence: screened.evidence ?? [] };
    },
  };
}

/** The configured provider, fresh for one discovery (it keeps the manifest read by policy()). */
export function qualificationProvider(q: Qualification, d: ProviderDeps): QualificationProvider {
  switch (q.provider) {
    case "manifest":
      return manifestProvider(q, d);
    case "checks-green":
      return checksGreenProvider(q, d);
    case "commit-status":
      return commitStatusProvider(q, d);
  }
}

/** Reads a file under root, refusing anything that escapes it. */
export function controlFileReader(root: string): (path: string) => string | null {
  return (path) => {
    if (path.startsWith("/") || path.split("/").includes("..")) return null;
    try {
      return readFileSync(`${root}/${path}`, "utf8");
    } catch {
      return null;
    }
  };
}
