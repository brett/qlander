// Release advance, the pure decision (DESIGN.md §8).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultConfig } from "../src/config";
import { decideRelease, isWorkflowEntry, parseQualificationManifest, type ReleaseCandidate, type ReleaseInput } from "../src/release";
import { TARGET, job, NAMES, run, sha, TARGET_SLUG } from "./sim";

const R = sha("release");
const M = sha("main");
const QUALIFY = ".github/workflows/proof.yml";
const manifest = {
  schema: 1,
  branch: "main",
  evidence_branch_patterns: ["^main$", "^queue/[A-Za-z0-9._-]+$"],
  required: [{ path: ".github/workflows/ci.yml", name: "CI", when: "always", required_jobs: ["Test"], allow_skipped_jobs: {} }],
};

function cand(s: string, over: Partial<ReleaseCandidate> = {}): ReleaseCandidate {
  const proofId = 9000 + s.charCodeAt(0);
  return {
    sha: s,
    firstParent: true,
    fromRelease: "ahead",
    status: { state: "success", target_url: `https://github.com/${TARGET_SLUG}/actions/runs/${proofId}` },
    proofRun: run({ id: proofId, path: QUALIFY, event: "workflow_run", head_branch: "main", head_sha: M }),
    proofJobs: [job(`Evaluate ${s}`), job(`Qualified ${s}`)],
    runs: [run({ id: 1, head_sha: s, head_branch: "main" })],
    jobs: { "1": [job("Test")] },
    ...over,
  };
}

function input(cands: ReleaseCandidate[], over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    release: R,
    main: M,
    releaseToMain: "ahead",
    truncated: false,
    candidates: cands,
    manifest,
    manifestBlob: sha("blob"),
    repoId: TARGET,
    target: NAMES.target,
    mainBranch: NAMES.main,
    proof: { workflow: QUALIFY, events: ["workflow_run", "workflow_dispatch"], jobTemplate: "Qualified {sha}" },
    ...over,
  };
}

describe("decideRelease", () => {
  test("advances to the newest qualified descendant and records a receipt", () => {
    const d = decideRelease(input([cand(M)]));
    expect(d.kind).toBe("advance");
    if (d.kind === "advance") {
      expect(d.to).toBe(M);
      expect(d.receipt.policyBlob).toBe(sha("blob"));
      expect(d.receipt.evidence[0]).toMatchObject({ run_id: 1, run_attempt: 1 });
    }
  });

  test("skips an unqualified newest commit for an older qualified one", () => {
    const older = sha("older");
    const d = decideRelease(input([cand(M, { status: null }), cand(older)]));
    expect(d).toMatchObject({ kind: "advance", to: older });
  });

  test("refuses a non-qualified sha", () => {
    expect(decideRelease(input([cand(M, { status: { state: "pending", target_url: null } })])).kind).toBe("none");
    expect(decideRelease(input([cand(M, { status: null })])).kind).toBe("none");
  });

  test("refuses a forged status: other repo URL, PR-event run, branch run, wrong workflow, job for another sha", () => {
    const forged: Partial<ReleaseCandidate>[] = [
      { status: { state: "success", target_url: `https://github.com/evil/${NAMES.target.name}/actions/runs/9001` } },
      { proofRun: run({ id: 9000 + M.charCodeAt(0), path: QUALIFY, event: "pull_request", head_branch: "main" }) },
      { proofRun: run({ id: 9000 + M.charCodeAt(0), path: QUALIFY, event: "workflow_dispatch", head_branch: "feat/x" }) },
      { proofRun: run({ id: 9000 + M.charCodeAt(0), path: ".github/workflows/other.yml", event: "workflow_run", head_branch: "main" }) },
      { proofJobs: [job(`Qualified ${sha("A")}`)] },
      { proofJobs: [job(`Qualified ${M}`, "skipped")] },
    ];
    for (const f of forged) {
      const d = decideRelease(input([cand(M, f)]));
      expect(d.kind).toBe("none");
    }
  });

  test("a genuine proof run that qualified A is no proof for B (job name binds the sha)", () => {
    const A = sha("A");
    const d = decideRelease(input([cand(M, { proofJobs: [job(`Qualified ${A}`)] })]));
    expect(d.kind).toBe("none");
  });

  test("the proof job's name comes from the configured template", () => {
    const own = { proof: { workflow: QUALIFY, events: ["workflow_run", "workflow_dispatch"], jobTemplate: "Check {sha} done" } };
    expect(decideRelease(input([cand(M, { proofJobs: [job(`Check ${M} done`)] })], own)).kind).toBe("advance");
    // The default name is not proof under another template, nor is the template's job for another sha.
    const d = decideRelease(input([cand(M, { proofJobs: [job(`Qualified ${M}`), job(`Check ${sha("A")} done`)] })], own));
    expect(d.kind).toBe("none");
    if (d.kind === "none") expect(d.reason).toContain(`no successful job 'Check ${M} done'`);
    // Every {sha} is replaced.
    expect(decideRelease(input([cand(M, { proofJobs: [job(`${M}/${M}`)] })], { proof: { workflow: QUALIFY, events: ["workflow_run", "workflow_dispatch"], jobTemplate: "{sha}/{sha}" } })).kind).toBe("advance");
  });

  test("refuses when qlander's own re-evaluation disagrees with the status", () => {
    const d = decideRelease(input([cand(M, { jobs: { "1": [job("Test", "failure")] } })]));
    expect(d.kind).toBe("none");
    if (d.kind === "none") expect(d.reason).toContain("re-evaluation failure");
  });

  test("refuses a non-ancestor: candidate behind or diverged from release", () => {
    expect(decideRelease(input([cand(M, { fromRelease: "behind" })])).kind).toBe("none");
    expect(decideRelease(input([cand(M, { fromRelease: "diverged" })])).kind).toBe("none");
    expect(decideRelease(input([cand(M, { fromRelease: "identical" })])).kind).toBe("none");
  });

  test("ignores commits off main's first-parent chain", () => {
    expect(decideRelease(input([cand(M, { firstParent: false })])).kind).toBe("none");
  });

  test("diverged release (unmerged hotfix), truncated listing and a bad manifest alert", () => {
    expect(decideRelease(input([cand(M)], { releaseToMain: "diverged" })).kind).toBe("alert");
    expect(decideRelease(input([cand(M)], { releaseToMain: "behind" })).kind).toBe("alert");
    expect(decideRelease(input([cand(M)], { truncated: true })).kind).toBe("alert");
    expect(decideRelease(input([cand(M)], { manifest: { ...manifest, schema: 2 } })).kind).toBe("alert");
    expect(decideRelease(input([cand(M)], { manifest: null })).kind).toBe("alert");
  });

  test("nothing to do when release is main or does not exist", () => {
    expect(decideRelease(input([], { releaseToMain: "identical" }))).toMatchObject({ kind: "none", reason: "release is main" });
    expect(decideRelease(input([], { release: null })).kind).toBe("none");
  });
});

describe("review #7: the qualification manifest is validated strictly", () => {
  const target = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/qualification.json`, "utf8"));

  test("the qualification.json fixture is accepted", () => {
    expect(parseQualificationManifest(target)).not.toBeNull();
  });

  test("an array allow_skipped_jobs is refused, so a skipped job named '0' cannot pass", () => {
    const m = { ...manifest, required: [{ ...manifest.required[0], allow_skipped_jobs: ["reason"] }] };
    const c = cand(M, { jobs: { "1": [job("Test"), job("0", "skipped")] } });
    expect(decideRelease(input([c], { manifest: m })).kind).toBe("alert");
  });

  test("non-string reasons, unknown fields and bad types are refused", () => {
    const entry = manifest.required[0]!;
    const bads: unknown[] = [
      { ...manifest, required: [{ ...entry, allow_skipped_jobs: { a: 1 } }] },
      { ...manifest, required: [{ ...entry, allow_skipped_jobs: null }] },
      { ...manifest, required: [{ ...entry, surprise: true }] },
      { ...manifest, surprise: true },
      { ...manifest, required: [{ ...entry, when: "sometimes" }] },
      { ...manifest, required: [{ ...entry, required_jobs: [1] }] },
      { ...manifest, evidence_branch_patterns: "^main$" },
      { ...manifest, evidence_branch_patterns: ["("] },
      [],
    ];
    for (const b of bads) expect(parseQualificationManifest(b)).toBeNull();
  });
});

test("qlander's own pre-landing manifest passes the same entry schema", () => {
  for (const e of defaultConfig.preLanding) expect(isWorkflowEntry(e)).toBe(true);
});
