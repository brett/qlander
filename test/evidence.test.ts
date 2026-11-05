// Producer-bound evidence (DESIGN.md §4.1), admission (§4.2), the policy
// boundary and approval (§4.3), and the manifest verdict (§6.1, §8).

import { describe, expect, test } from "bun:test";
import { admit, revalidate } from "../src/admission";
import { defaultConfig } from "../src/config";
import { appCheck, isPolicyChange, jobAtMain, jobAtSubject, policyApproval } from "../src/evidence";
import type { Auth } from "../src/state";
import type { IssueComment } from "../src/types";
import { qualify } from "../src/verdict";
import { TARGET, cfg, job, livePr, run, sha, APPROVERS, HUMAN, BOT_FILE } from "./sim";

const H = sha("pr-head");
const M = sha("main-tip");

describe("job@subject (fast lane)", () => {
  const req = { workflowPath: ".github/workflows/ci.yml", event: "pull_request", job: "fast" };
  const pr = (over = {}) => run({ id: 1, event: "pull_request", head_branch: "feat/x", head_sha: H, ...over });

  test("the named job succeeded in the newest matching run", () => {
    expect(jobAtSubject(req, H, TARGET, [pr()], { "1": [job("fast")] }).ok).toBe(true);
  });

  test("another repo, a fork head, another workflow, another sha or another event do not count", () => {
    const jobs = { "1": [job("fast")] };
    expect(jobAtSubject(req, H, TARGET, [pr({ repository: { id: 7 } })], jobs).ok).toBe(false);
    expect(jobAtSubject(req, H, TARGET, [pr({ head_repository: { id: 7 } })], jobs).ok).toBe(false);
    expect(jobAtSubject(req, H, TARGET, [pr({ path: ".github/workflows/other.yml" })], jobs).ok).toBe(false);
    expect(jobAtSubject(req, H, TARGET, [pr({ head_sha: M })], jobs).ok).toBe(false);
    expect(jobAtSubject(req, H, TARGET, [pr({ event: "push" })], jobs).ok).toBe(false);
  });

  test("a job of the right name that failed or was skipped does not count", () => {
    expect(jobAtSubject(req, H, TARGET, [pr()], { "1": [job("fast", "skipped")] }).ok).toBe(false);
    expect(jobAtSubject(req, H, TARGET, [pr()], { "1": [job("fast", "failure")] }).ok).toBe(false);
  });

  test("a newer first-attempt run still queued or running defers to the older verdict", () => {
    const runs = [pr({ id: 1 }), pr({ id: 2, status: "queued" })];
    for (const newer of [[job("fast", null, "queued")], [job("fast", null, "in_progress"), job("Lint")], []]) {
      const p = jobAtSubject(req, H, TARGET, runs, { "1": [job("fast")], "2": newer });
      expect(p.ok).toBe(true);
      expect(p.run?.runId).toBe(1);
    }
  });

  test("a newer run blocks when it cannot be trusted to hide nothing", () => {
    const green = { "1": [job("fast")] };
    const queued = pr({ id: 2, status: "queued" });
    // an unreadable (incomplete) job list could hide a red verdict.
    expect(jobAtSubject(req, H, TARGET, [pr({ id: 1 }), queued], green).ok).toBe(false);
    // a retry (attempt 2) of a failed run must not resurrect the older green.
    expect(jobAtSubject(req, H, TARGET, [pr({ id: 1 }), pr({ id: 2, status: "queued", run_attempt: 2 })], { ...green, "2": [job("fast", null, "queued")] }).ok).toBe(false);
    // a prerequisite already failed in the newer run, even with `fast` cancelled or pending.
    for (const fast of [job("fast", "cancelled"), job("fast", null, "queued")]) {
      expect(jobAtSubject(req, H, TARGET, [pr({ id: 1 }), queued], { ...green, "2": [job("Lint", "failure"), fast] }).ok).toBe(false);
    }
    // A completed newer run that was cancelled or skipped, or lacks the job, blocks.
    for (const newer of [[job("fast", "cancelled")], [job("fast", "skipped")], []]) {
      expect(jobAtSubject(req, H, TARGET, [pr({ id: 1 }), pr({ id: 2 })], { ...green, "2": newer }).ok).toBe(false);
    }
  });

  test("a newer timed-out job beats an older success, and no verdict at all is not a pass", () => {
    const runs = [pr({ id: 1 }), pr({ id: 2 })];
    expect(jobAtSubject(req, H, TARGET, runs, { "1": [job("fast")], "2": [job("fast", "timed_out")] }).ok).toBe(false);
    expect(jobAtSubject(req, H, TARGET, [pr({ id: 1 }), pr({ id: 2, status: "queued" })], { "1": [job("fast", "cancelled")], "2": [] }).ok).toBe(false);
  });

  test("an older success does not rescue a newer failure", () => {
    const runs = [pr({ id: 1 }), pr({ id: 2 })];
    expect(jobAtSubject(req, H, TARGET, runs, { "1": [job("fast")], "2": [job("fast", "failure")] }).ok).toBe(false);
  });
});

describe("job@main (review producer)", () => {
  const req = { workflowPath: ".github/workflows/review.yml", events: ["workflow_run", "workflow_dispatch"], jobTemplate: "Reviewed {sha}" };
  const onMain = (s: string) => s === M;
  const rv = (over = {}) => run({ id: 5, path: req.workflowPath, event: "workflow_run", head_branch: "main", head_sha: M, ...over });

  test("a main run (head_sha = main, not the PR head) binds the subject by job name", () => {
    const p = jobAtMain(req, H, TARGET, [rv()], { "5": [job(`Reviewed ${H}`)] }, onMain, "main");
    expect(p.ok).toBe(true);
    expect(p.run).toEqual({ runId: 5, attempt: 1 });
  });

  test("a job naming another sha does not count", () => {
    expect(jobAtMain(req, H, TARGET, [rv()], { "5": [job(`Reviewed ${M}`)] }, onMain, "main").ok).toBe(false);
  });

  test("a PR-event run with head_branch 'main' (a PR branch named main) does not count", () => {
    const fake = rv({ event: "pull_request" });
    expect(jobAtMain(req, H, TARGET, [fake], { "5": [job(`Reviewed ${H}`)] }, onMain, "main").ok).toBe(false);
  });

  test("a run whose revision is not on main, or from another repo, does not count", () => {
    expect(jobAtMain(req, H, TARGET, [rv({ head_sha: sha("branch") })], { "5": [job(`Reviewed ${H}`)] }, onMain, "main").ok).toBe(false);
    expect(jobAtMain(req, H, TARGET, [rv({ repository: { id: 9 } })], { "5": [job(`Reviewed ${H}`)] }, onMain, "main").ok).toBe(false);
  });
});

describe("app-check", () => {
  const req = { appId: 777, name: "review" };
  const check = (over = {}) => ({ id: 1, name: "review", head_sha: H, status: "completed", conclusion: "success", app: { id: 777 }, ...over });

  test("a successful check by the configured app on the subject counts", () => {
    expect(appCheck(req, H, [check()]).ok).toBe(true);
  });

  test("another app, another sha, or not success does not count", () => {
    expect(appCheck(req, H, [check({ app: { id: 15368 } })]).ok).toBe(false);
    expect(appCheck(req, H, [check({ head_sha: M })]).ok).toBe(false);
    expect(appCheck(req, H, [check({ conclusion: "neutral" })]).ok).toBe(false);
  });
});

describe("policy boundary and SHA-bound approval", () => {
  test("policy paths", () => {
    const b = defaultConfig.policyBoundary;
    expect(isPolicyChange([".github/workflows/ci.yml"], b)).toBe(true);
    expect(isPolicyChange([".github/scripts/check.sh"], b)).toBe(true);
    expect(isPolicyChange([".github/actions/setup/action.yml"], b)).toBe(true);
    expect(isPolicyChange([BOT_FILE], b)).toBe(true);
    // A directory glob outside .github, as the config lists one: anything under it, at any depth.
    const dir = b.find((p) => p.endsWith("/**") && !p.startsWith(".github/"));
    expect(dir).toBeDefined();
    expect(isPolicyChange([`${dir!.slice(0, -2)}deep/file.txt`], b)).toBe(true);
    expect(isPolicyChange(["src/main.py", "app/src/app.tsx"], b)).toBe(false);
  });

  const c = (over: Partial<IssueComment> = {}): IssueComment => ({
    id: 1,
    user: { login: APPROVERS[1]!.login, id: APPROVERS[1]!.id },
    body: `/qlander approve-policy ${H}`,
    created_at: "2026-10-21T10:00:00Z",
    updated_at: "2026-10-21T10:00:00Z",
    ...over,
  });
  const humans = defaultConfig.humans;

  test("an unedited exact comment by a configured human approves that head only", () => {
    expect(policyApproval([c()], humans, H)).toBeDefined();
    expect(policyApproval([c()], humans, M)).toBeUndefined();
  });

  test("edited, wrong body, non-human, or a login/id mismatch do not approve", () => {
    expect(policyApproval([c({ updated_at: "2026-10-21T10:05:00Z" })], humans, H)).toBeUndefined();
    expect(policyApproval([c({ body: `LGTM /qlander approve-policy ${H}` })], humans, H)).toBeUndefined();
    expect(policyApproval([c({ user: { login: "mallory", id: 1 } })], humans, H)).toBeUndefined();
    expect(policyApproval([c({ user: { login: APPROVERS[1]!.login, id: 1 } })], humans, H)).toBeUndefined();
  });
});

describe("admission", () => {
  const C = cfg();
  test("a fully qualified PR is admitted", () => expect(admit(livePr(1), C)).toEqual({ ok: true }));

  test("a PR whose head branch is named main (or another reserved ref) is ignored", () => {
    for (const ref of ["main", "release", "queue/3", "qlander-build/3"]) {
      expect(admit(livePr(1, { headRef: ref }), C)).toMatchObject({ ok: false, kind: "ignore" });
    }
  });

  test("forks, other bases and other repos are ignored", () => {
    expect(admit(livePr(1, { headRepoId: 9 }), C)).toMatchObject({ kind: "ignore" });
    expect(admit(livePr(1, { baseRef: "dev" }), C)).toMatchObject({ kind: "ignore" });
    expect(admit(livePr(1, { baseRepoId: 9 }), C)).toMatchObject({ kind: "ignore" });
  });

  test("ready must come from the review producer or a writer", () => {
    expect(admit(livePr(1, { ready: { actorLogin: "rando", actorPermission: "read", at: "x" } }), C)).toMatchObject({ kind: "ignore" });
    expect(admit(livePr(1, { ready: { actorLogin: HUMAN, actorPermission: "admin", at: "x" } }), C)).toEqual({ ok: true });
  });

  test("conflicts and unsigned commits lose ready; missing evidence waits", () => {
    expect(admit(livePr(1, { mergeable: false }), C)).toMatchObject({ kind: "unready" });
    expect(admit(livePr(1, { commitsVerified: false }), C)).toMatchObject({ kind: "unready" });
    expect(admit(livePr(1, { mergeable: null }), C)).toMatchObject({ kind: "wait" });
    expect(admit(livePr(1, { fastLane: { ok: false, why: "x" } }), C)).toMatchObject({ kind: "wait" });
    expect(admit(livePr(1, { review: { ok: false, why: "x" } }), C)).toMatchObject({ kind: "wait" });
  });

  test("revalidation: same head and policy, or the PR is dropped", () => {
    const auth: Auth = { head: sha("pr1"), baseRepoId: TARGET, policy: "p1", policyPr: false, admittedAt: "t", labelledAt: "t", evidence: [], reviewRun: null };
    expect(revalidate(auth, livePr(1), C, "p1")).toEqual({ ok: true });
    expect(revalidate(auth, livePr(1, { head: M }), C, "p1")).toMatchObject({ ok: false, headMoved: true });
    expect(revalidate(auth, livePr(1), C, "p2")).toMatchObject({ ok: false, headMoved: true });
    expect(revalidate(auth, livePr(1, { draft: true }), C, "p1")).toMatchObject({ ok: false, headMoved: false });
    expect(revalidate(auth, livePr(1, { baseRef: "dev" }), C, "p1")).toMatchObject({ ok: false });
  });
});

describe("qualify (the manifest verdict)", () => {
  const manifest = {
    branch: "main",
    evidence_branch_patterns: ["^main$", "^queue/[A-Za-z0-9._-]+$"],
    required: [{ path: ".github/workflows/ci.yml", name: "CI", when: "always" as const, required_jobs: ["Test"], allow_skipped_jobs: {} }],
  };
  const S = sha("c");
  const base = { manifest, sha: S, repo_id: TARGET, on_main: true };

  test("success from a queue run of the exact commit", () => {
    const r = run({ id: 1, head_sha: S, head_branch: "queue/7" });
    expect(qualify({ ...base, runs: [r], jobs: { "1": [job("Test")] } }).state).toBe("success");
  });

  test("a pull_request run on a branch called main is never evidence", () => {
    const r = run({ id: 1, head_sha: S, event: "pull_request" });
    expect(qualify({ ...base, runs: [r], jobs: { "1": [job("Test")] } }).state).toBe("pending");
  });

  test("not on main is at best pending; a cancelled job is failure; a red queue run fails even if main is green", () => {
    const r = run({ id: 1, head_sha: S });
    expect(qualify({ ...base, on_main: false, runs: [r], jobs: { "1": [job("Test")] } }).state).toBe("pending");
    expect(qualify({ ...base, runs: [r], jobs: { "1": [job("Test", "cancelled")] } }).state).toBe("failure");
    const q = run({ id: 2, head_sha: S, head_branch: "queue/1", conclusion: "failure" });
    expect(qualify({ ...base, runs: [r, q], jobs: { "1": [job("Test")], "2": [job("Test", "failure")] } }).state).toBe("failure");
  });

  test("a short sha or an empty manifest fails closed", () => {
    expect(qualify({ ...base, sha: "abc", runs: [], jobs: {} }).state).toBe("failure");
    expect(qualify({ ...base, manifest: { ...manifest, required: [] }, runs: [], jobs: {} }).state).toBe("failure");
  });
});
