// GitHub state → Snapshot and Observation, over the in-memory fake.

import { describe, expect, test } from "bun:test";
import { cfg, NAMES, HUMAN, APPROVERS, REVIEW_WORKFLOW } from "./sim";
import { admit } from "../src/admission";
import { decide } from "../src/machine";
import { interpretObservation } from "../src/ops";
import { buildSnapshot, observe, prsOfInterest } from "../src/snapshot";
import { emptyState, type State } from "../src/state";
import { FakeTarget } from "./fake-github";
import { TARGET, job, sha } from "./sim";

const NOW = new Date("2026-10-21T12:00:00Z");
// These tests exercise the producer-bound review adapter, so it is switched on here (off by default in v1).
const C = cfg({ reviewRequired: true });
const REVIEW = REVIEW_WORKFLOW;

/** A PR with a green fast lane on its head and a review job from a main run. */
function readyPr(
  f: FakeTarget,
  n: number,
  opts: { reviewOnBranch?: boolean; reviewFor?: string; fast?: string; files?: string[]; pushes?: { verified?: boolean; files?: string[] }[] } = {},
) {
  const p = f.addPr(n, {}, opts.files ? { files: opts.files } : {});
  for (const push of opts.pushes ?? []) f.push(n, push);
  const head = p.pr.head.sha;
  f.addRun({ head_sha: head, event: "pull_request", head_branch: p.pr.head.ref }, [job("fast", opts.fast ?? "success")]);
  const reviewRevision = opts.reviewOnBranch ? f.commit([f.refs.get("main")!], `branch-rev-${n}`) : f.refs.get("main")!;
  const subject = opts.reviewFor ?? head;
  f.addRun({ head_sha: reviewRevision, path: REVIEW, event: "workflow_run", head_branch: "main", display_title: `Review ${subject}` }, [job(`Reviewed ${subject}`)]);
  return p;
}

const snap = (f: FakeTarget, state: State = emptyState()) => buildSnapshot({ api: f, cfg: C, state, now: NOW, paused: false, policyHash: "p1" });

describe("PR evidence", () => {
  test("a ready PR with a green fast lane and a main-hosted review is admitted and built", async () => {
    const f = new FakeTarget();
    readyPr(f, 1);
    const s = await snap(f);
    const pr = s.prs["1"]!;
    expect(pr.fastLane.ok).toBe(true);
    expect(pr.review.ok).toBe(true);
    expect(pr.commitsVerified).toBe(true);
    expect(pr.policyPr).toBe(false);
    expect(pr.ready).toMatchObject({ actorLogin: HUMAN, actorPermission: "admin" });
    const d = decide(emptyState(), s, C);
    expect(d.state.journal?.op).toMatchObject({ kind: "build", base: f.refs.get("main"), pins: [{ pr: 1, head: f.prs.get(1)!.pr.head.sha }] });
  });

  test("the review run's own sha is main, not the PR head, and still binds the PR by job name", async () => {
    const f = new FakeTarget();
    const p = readyPr(f, 1);
    const reviewRun = f.runs.find((r) => r.path === REVIEW)!;
    expect(reviewRun.head_sha).not.toBe(p.pr.head.sha);
    expect((await snap(f)).prs["1"]!.review.ok).toBe(true);
  });

  test("a review from a revision that is not on main, or for another sha, does not count", async () => {
    const a = new FakeTarget();
    readyPr(a, 1, { reviewOnBranch: true });
    expect((await snap(a)).prs["1"]!.review.ok).toBe(false);
    const b = new FakeTarget();
    readyPr(b, 1, { reviewFor: sha("someone-else") });
    expect((await snap(b)).prs["1"]!.review.ok).toBe(false);
  });

  test("a failed fast lane and an unsigned commit are reported", async () => {
    const f = new FakeTarget();
    readyPr(f, 1, { fast: "failure", pushes: [{ verified: false }] });
    const pr = (await snap(f)).prs["1"]!;
    expect(pr.fastLane.ok).toBe(false);
    expect(pr.commitsVerified).toBe(false);
  });

  test("ready from a person: their permission is looked up; from the producer it is not", async () => {
    const f = new FakeTarget();
    const p = readyPr(f, 1);
    p.events = [{ id: 1, actor: "a-writer", at: "2026-10-21T10:00:00Z" }];
    f.permissions.set("a-writer", "write");
    expect((await snap(f)).prs["1"]!.ready).toMatchObject({ actorLogin: "a-writer", actorPermission: "write" });
  });

  test("policy PRs: classified by files (renames, truncation fail closed) and SHA-bound approval", async () => {
    const f = new FakeTarget();
    const p = readyPr(f, 1, { files: ["docs/x.md", ".github/workflows/ci.yml"] });
    let pr = (await snap(f)).prs["1"]!;
    expect(pr.policyPr).toBe(true);
    expect(pr.policyApproval).toBe(false);
    p.comments.push({ id: 5, user: { login: APPROVERS[1]!.login, id: APPROVERS[1]!.id }, body: `/qlander approve-policy ${p.pr.head.sha}`, created_at: "t", updated_at: "t" });
    pr = (await snap(f)).prs["1"]!;
    expect(pr.policyApproval).toBe(true);

    const g = new FakeTarget();
    readyPr(g, 2);
    g.compareTruncated = true;
    expect((await snap(g)).prs["2"]!.policyPr).toBe(true);
  });

  test("PRs that are closed or not ready are described without evidence lookups", async () => {
    const f = new FakeTarget();
    f.addPr(3, { labels: [] });
    f.addPr(4, { state: "closed", merged: true });
    const state: State = { ...emptyState(), verify: [{ pr: 4, pin: f.prs.get(4)!.pr.head.sha, landedIn: f.refs.get("main")!, since: "2026-10-21T11:00:00.000Z", ticks: 0, notified: false }] };
    const s = await snap(f, state);
    expect(Object.keys(s.prs)).toEqual(["4"]); // #3 has no ready label and is not in state
    expect(s.prs["4"]).toMatchObject({ open: false, merged: true, fastLane: { ok: false } });
    expect(f.calls.some((c) => c.startsWith("listJobs"))).toBe(false);
  });

  test("a PR that no longer exists is left out, so revalidation drops it", async () => {
    const f = new FakeTarget();
    readyPr(f, 1);
    const state: State = { ...emptyState(), solo: [{ pr: 9, lineage: 1, reason: "split" }], lineages: { "1": { runs: 1 } }, auth: { "9": { head: sha("gone"), baseRepoId: TARGET, policy: "p1", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: null } } };
    const s = await snap(f, state);
    expect(s.prs["9"]).toBeUndefined();
    const d = decide(state, s, C);
    expect(d.state.auth["9"]).toBeUndefined();
    expect(d.state.journal?.op).toMatchObject({ kind: "build", pins: [{ pr: 1 }] });
  });

  test("prsOfInterest covers ready PRs and everything state refers to", () => {
    const state: State = {
      ...emptyState(),
      pending: [{ prs: [5, 6], depth: 1, lineage: 1 }],
      solo: [{ pr: 7, lineage: 1, reason: "split" }],
      verify: [{ pr: 8, pin: sha("p"), landedIn: sha("q"), since: "t", ticks: 0, notified: false }],
    };
    expect(prsOfInterest(state, [1, 5])).toEqual([1, 5, 6, 7, 8]);
  });
});

describe("batch CI, main's failures, pin reachability", () => {
  function activeState(f: FakeTarget): State {
    f.addPr(1);
    const base = f.refs.get("main")!;
    const head = f.commit([base, sha("pr1")], "queue-head");
    f.refs.set("queue/9", head);
    return {
      ...emptyState(),
      auth: { "1": { head: sha("pr1"), baseRepoId: TARGET, policy: "p1", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: null } },
      active: { n: 9, base, head, depth: 0, prs: [1], lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T11:00:00.000Z" },
      lineages: { "1": { runs: 1 } },
    };
  }

  test("the active batch is classified from its queue push runs only", async () => {
    const f = new FakeTarget();
    const state = activeState(f);
    const jobs = C.preLanding[0]!.required_jobs.map((n) => job(n));
    f.addRun({ head_sha: state.active!.head, head_branch: "queue/9" }, jobs);
    f.addRun({ head_sha: state.active!.head, head_branch: "queue/9", event: "pull_request", conclusion: "failure" }, [job("Test", "failure")]);
    expect((await snap(f, state)).ci).toEqual({ kind: "green" });
  });

  test("a red queue run is red; main's own failures are reported", async () => {
    const f = new FakeTarget();
    const state = activeState(f);
    f.addRun({ head_sha: state.active!.head, head_branch: "queue/9", conclusion: "failure" }, [job("Test", "failure")]);
    f.addRun({ head_sha: f.refs.get("main")!, head_branch: "main", conclusion: "failure" }, [job("Lint"), job("Test", "failure")]);
    const s = await snap(f, state);
    expect(s.ci?.kind).toBe("red");
    expect(s.mainFailedJobs).toEqual(["Test"]);
  });

  test("pins reachable from main, and not", async () => {
    const f = new FakeTarget();
    const inMain = f.refs.get("main")!;
    const outside = f.commit([inMain], "outside");
    const state: State = {
      ...emptyState(),
      verify: [
        { pr: 1, pin: inMain, landedIn: inMain, since: "2026-10-21T11:00:00.000Z", ticks: 0, notified: false },
        { pr: 2, pin: outside, landedIn: inMain, since: "2026-10-21T11:00:00.000Z", ticks: 0, notified: false },
      ],
    };
    f.addPr(1, { state: "closed", merged: true });
    f.addPr(2, { state: "closed", merged: true });
    const s = await snap(f, state);
    expect(s.pinReachable).toEqual({ [inMain]: true, [outside]: false });
  });
});

describe("observe (recovery input)", () => {
  async function built(f: FakeTarget, prs: number[]) {
    const base = f.refs.get("main")!;
    f.refs.set("qlander-build/5", base);
    const pins = prs.map((n) => ({ pr: n, head: f.addPr(n).pr.head.sha }));
    for (const p of pins) await f.merge("qlander-build/5", p.head, `Merge #${p.pr}`);
    const chainHead = f.refs.get("qlander-build/5")!;
    return { base, pins, chainHead };
  }

  test("a queue ref whose chain is base plus the recorded survivors is adopted", async () => {
    const f = new FakeTarget();
    const { base, pins, chainHead } = await built(f, [1, 2]);
    f.refs.set("queue/5", chainHead);
    const j = { seq: 1, op: { kind: "build" as const, n: 5, base, pins, depth: 0, lineage: 1, source: { kind: "candidates" as const }, rebuild: false }, reserved: true, at: "t", checkpoint: { survivors: pins, dropped: [], chainHead }, tries: 0 };
    const o = await observe(f, j, NAMES);
    expect(o).toEqual({ queueHead: chainHead, queueRef: "queue/5", queueChainMatches: true });
    expect(interpretObservation(j, o).kind).toBe("built");
  });

  test("a queue ref with the right head but the wrong second parents does not match", async () => {
    const f = new FakeTarget();
    const { base, pins, chainHead } = await built(f, [1, 2]);
    f.refs.set("queue/5", chainHead);
    const wrong = [pins[1]!, pins[0]!]; // recorded in the other order
    const j = { seq: 1, op: { kind: "build" as const, n: 5, base, pins, depth: 0, lineage: 1, source: { kind: "candidates" as const }, rebuild: false }, reserved: true, at: "t", checkpoint: { survivors: wrong, dropped: [], chainHead }, tries: 0 };
    expect((await observe(f, j, NAMES)).queueChainMatches).toBe(false);
  });

  test("no queue ref yet: recovery resumes the build", async () => {
    const f = new FakeTarget();
    const { base, pins, chainHead } = await built(f, [1]);
    const j = { seq: 1, op: { kind: "build" as const, n: 5, base, pins, depth: 0, lineage: 1, source: { kind: "candidates" as const }, rebuild: false }, reserved: true, at: "t", checkpoint: { survivors: pins, dropped: [], chainHead }, tries: 0 };
    expect(interpretObservation(j, await observe(f, j, NAMES))).toEqual({ kind: "resumeBuild", head: chainHead });
  });

  test("land: main at or past the tested head is landed; main still at base is not applied", async () => {
    const f = new FakeTarget("queue");
    const base = f.refs.get("main")!;
    const q = f.commit([base], "Q");
    const j = { seq: 1, op: { kind: "land" as const, before: base, after: q }, reserved: false, at: "t", checkpoint: null, tries: 0 };
    expect(await observe(f, j, NAMES)).toEqual({ main: base, afterReachable: false });
    await f.updateRef("main", base, q);
    expect(await observe(f, j, NAMES)).toEqual({ main: q, afterReachable: true });
    const later = f.commit([q], "later");
    f.refs.set("main", later);
    expect((await observe(f, j, NAMES)).afterReachable).toBe(true);
  });

  test("rerun: a deleted run is reported missing, not as an unchanged attempt", async () => {
    const f = new FakeTarget();
    const j = { seq: 1, op: { kind: "rerun" as const, runs: [{ runId: 424242, attempt: 1 }] }, reserved: true, at: "t", checkpoint: null, tries: 0 };
    expect(await observe(f, j, NAMES)).toEqual({ attempts: {}, missingRuns: [424242] });
    expect(interpretObservation(j, await observe(f, j, NAMES)).kind).toBe("targetMissing");
  });

  test("rerun: current attempts per run", async () => {
    const f = new FakeTarget();
    const r = f.addRun({ head_sha: sha("q") });
    await f.rerunFailedJobs(r.id);
    const j = { seq: 1, op: { kind: "rerun" as const, runs: [{ runId: r.id, attempt: 1 }] }, reserved: true, at: "t", checkpoint: null, tries: 0 };
    expect(await observe(f, j, NAMES)).toEqual({ attempts: { [String(r.id)]: 2 }, missingRuns: [] });
  });
});

describe("the fake enforces the same guards as the real client", () => {
  test("CAS, fast-forward only, role allowlist, indirect merge detection", async () => {
    const f = new FakeTarget("queue");
    const base = f.refs.get("main")!;
    const p = f.addPr(1);
    f.refs.set("qlander-build/2", base);
    const m = await f.merge("qlander-build/2", p.pr.head.sha, "Merge #1");
    if (m.kind !== "merged") throw new Error("expected a merge");
    await expect(f.updateRef("main", sha("not-main"), m.sha)).rejects.toMatchObject({ kind: "conflict" });
    await expect(f.updateRef("main", base, f.commit([], "unrelated"))).rejects.toMatchObject({ kind: "validation" });
    await expect(f.updateRef("release", base, m.sha)).rejects.toThrow("may not write release");
    await f.updateRef("main", base, m.sha);
    expect(f.prs.get(1)!.pr).toMatchObject({ merged: true, state: "closed" });
  });
});

describe("review fixes (snapshot)", () => {
  test("#2: a force-push between reads discards the snapshot", async () => {
    const f = new FakeTarget();
    readyPr(f, 1);
    f.afterGetPr = (n, calls) => {
      if (n === 1 && calls === 1) f.push(1, { verified: false, files: [".github/workflows/ci.yml"] });
    };
    await expect(snap(f)).rejects.toThrow("#1 moved while the snapshot was read");
  });

  test("#2: commits and files are judged for the captured head, by sha", async () => {
    const f = new FakeTarget();
    readyPr(f, 1, { pushes: [{ verified: false, files: [".github/workflows/ci.yml"] }] });
    const pr = (await snap(f)).prs["1"]!;
    expect(pr.commitsVerified).toBe(false);
    expect(pr.policyPr).toBe(true);
  });

  test("#2: main moving during the read discards the snapshot", async () => {
    const f = new FakeTarget();
    readyPr(f, 1);
    f.afterGetPr = () => f.refs.set("main", f.commit([f.refs.get("main")!], "moved"));
    await expect(snap(f)).rejects.toThrow("main moved");
  });

  test("#3: an incomplete job list is never green, and never evidence", async () => {
    const f = new FakeTarget();
    f.addPr(1);
    const base = f.refs.get("main")!;
    const head = f.commit([base, sha("pr1")], "qh");
    const state: State = {
      ...emptyState(),
      auth: { "1": { head: sha("pr1"), baseRepoId: TARGET, policy: "p1", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: null } },
      active: { n: 9, base, head, depth: 0, prs: [1], lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T11:00:00.000Z" },
      lineages: { "1": { runs: 1 } },
    };
    const run = f.addRun({ head_sha: head, head_branch: "queue/9" }, C.preLanding[0]!.required_jobs.map((n) => job(n)));
    f.incompleteJobs.add(run.id);
    const ci = (await snap(f, state)).ci;
    expect(ci?.kind).toBe("config");

    const g = new FakeTarget();
    readyPr(g, 2);
    const fast = g.runs.find((r) => r.event === "pull_request")!;
    g.incompleteJobs.add(fast.id);
    expect((await snap(g)).prs["2"]!.fastLane.ok).toBe(false);
  });

  test("#4: unrelated newer reviews cannot push out a recorded review run", async () => {
    const f = new FakeTarget();
    const p = readyPr(f, 1);
    const reviewRun = f.runs.find((r) => r.path === REVIEW)!;
    for (let k = 0; k < 25; k++) f.addRun({ head_sha: f.refs.get("main")!, path: REVIEW, event: "workflow_run", head_branch: "main", display_title: `Review ${sha(`other${k}`)}` }, [job(`Reviewed ${sha(`other${k}`)}`)]);
    f.pageSize = 10; // searchPages 10 → 100 runs: still found by name
    expect((await snap(f)).prs["1"]!.review.ok).toBe(true);

    f.pageSize = 1; // search sees only 10 runs: not found, and the limit was hit
    const fresh = (await snap(f)).prs["1"]!.review;
    expect(fresh).toMatchObject({ ok: false, unknown: true });

    const state: State = {
      ...emptyState(),
      auth: { "1": { head: p.pr.head.sha, baseRepoId: TARGET, policy: "p1", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: reviewRun.id } },
    };
    expect((await snap(f, state)).prs["1"]!.review).toMatchObject({ ok: true, run: { runId: reviewRun.id } });
  });

  test("#4: the recorded run is recorded at admission", async () => {
    const f = new FakeTarget();
    readyPr(f, 1);
    const reviewRun = f.runs.find((r) => r.path === REVIEW)!;
    const d = decide(emptyState(), await snap(f), C);
    expect(d.state.auth["1"]!.reviewRun).toBe(reviewRun.id);
  });

  test("#5: unknown label provenance is not admitted", async () => {
    const f = new FakeTarget();
    const p = readyPr(f, 1);
    p.eventsTruncated = true;
    const s = await snap(f);
    expect(s.prs["1"]!.ready).toBeNull();
    expect(decide(emptyState(), s, C).state.auth["1"]).toBeUndefined();
  });

  test("ready whose newest application has no readable actor is not admitted, even after a writer's", async () => {
    const f = new FakeTarget();
    readyPr(f, 1); // applied by a writer first
    f.label(1, "ready", null);
    const s = await snap(f);
    expect(s.prs["1"]!.ready).toBeNull();
    expect(admit(s.prs["1"]!, C)).toMatchObject({ ok: false, reason: "who applied ready is not readable" });
    expect(decide(emptyState(), s, C).state.auth["1"]).toBeUndefined();
  });
});
