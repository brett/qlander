// The release advance runner end to end against the fake GitHub (DESIGN.md
// §8): advancing, refusals (unqualified, forged proof, non-ancestor) and
// discovery limits. Safety (CAS, crashes, pause, lease, dry run, keys) is in
// release-safety.test.ts.

import { describe, expect, test } from "bun:test";
import { TargetClient } from "../src/github/target";
import { firstParentChain } from "../src/release-runner";
import { BLOB, ReleaseWorld, runUrl } from "./release-world";
import { TARGET, job, sha, TARGET_OPTS, pathRe, TARGET_SLUG, NAMES } from "./sim";

describe("release advance: the happy path", () => {
  test("fast-forwards release to the newest qualified first-parent commit, by CAS, and records the receipt", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    const b = w.land();
    w.qualified(a);
    w.qualified(b);
    const r = await w.ok();
    expect(r.outcome).toBe("advanced");
    expect(w.release).toBe(b);
    expect(w.releaseWrites()).toEqual([`updateRef release ${w.R} -> ${b}`]);
    const s = w.state();
    expect(s.journal).toBeNull();
    expect(s.lease).toBeNull();
    expect(s.history.at(-1)).toMatchObject({ outcome: "advanced", from: w.R, to: b, receipt: { policyBlob: BLOB, from: w.R, to: b } });
    expect(s.history.at(-1)!.receipt!.evidence[0]).toMatchObject({ workflow: "CI", branch: "main", run_attempt: 1 });
    expect(w.issues("qlander-release-state")).toHaveLength(1);
    expect(w.target.calls.some((c) => c.startsWith("updateRef main"))).toBe(false);
  });

  test("skips an unqualified newest commit for an older qualified one", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    const b = w.land();
    w.qualified(a);
    w.ci(b); // CI green, qualify has not run yet: no status
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.release).toBe(a);
  });

  test("the runner binds the proof job by the configured template", async () => {
    // Each proof run carries exactly one job, so a call site still using another template would refuse.
    const cases: [string, (s: string) => string, "advanced" | "none"][] = [
      ["Evaluate {sha}", (s) => `Evaluate ${s}`, "advanced"],
      ["Qualified {sha}", (s) => `Qualified ${s}`, "advanced"],
      ["Evaluate {sha}", (s) => `Qualified ${s}`, "none"],
      ["Qualified {sha}", (s) => `Evaluate ${s}`, "none"],
    ];
    for (const [tpl, name, outcome] of cases) {
      const w = new ReleaseWorld();
      const q = w.cfg.qualification;
      if (q.provider !== "manifest" || !q.proof) throw new Error("the world is a manifest world with a proof");
      w.cfg = { ...w.cfg, qualification: { ...q, proof: { ...q.proof, jobTemplate: tpl } } };
      const a = w.land();
      w.ci(a);
      w.proof(a, { jobNames: [name(a)] });
      const r = await w.ok();
      expect(r.outcome).toBe(outcome);
      if (outcome === "advanced") expect(w.release).toBe(a);
      else expect(r.decision).toMatchObject({ kind: "none", reason: expect.stringContaining(`no successful job '${tpl.replace("{sha}", a)}'`) });
    }
  });

  test("nothing to do when release is main; nothing at all when release is absent", async () => {
    const w = new ReleaseWorld();
    expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: "release is main" });
    w.target.refs.delete("release");
    w.qualified(w.land());
    expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: "release branch does not exist" });
    expect(w.releaseWrites()).toEqual([]);
  });

  test("off-first-parent commits are never candidates", () => {
    const m0 = sha("m0");
    const side = sha("side");
    const m1 = sha("m1");
    expect(firstParentChain(m1, [{ sha: side, parents: [m0] }, { sha: m1, parents: [m0, side] }])).toEqual([m1]);
  });
});

describe("refusals", () => {
  test("an unqualified commit: no status, a pending status, or a red re-evaluation behind a valid proof", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.ci(a);
    expect((await w.ok()).outcome).toBe("none");
    w.status(a, runUrl(1), "pending");
    expect((await w.ok()).outcome).toBe("none");
    // The status and the proof chain say yes, but the CI qlander re-reads failed.
    const w2 = new ReleaseWorld();
    const b = w2.land();
    w2.ci(b, [job("Test", "failure")]);
    w2.proof(b);
    const r = await w2.ok();
    expect(r.outcome).toBe("none");
    expect(JSON.stringify(r.decision)).toContain("re-evaluation failure");
    for (const x of [w, w2]) {
      expect(x.releaseWrites()).toEqual([]);
      expect(x.release).toBe(x.R);
      expect(x.issues("release-blocked")).toEqual([]); // "none" is not an alert
    }
  });

  test("a required job missing from the push run, or its job list incomplete, fails closed", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.ci(a, [job("Lint")]);
    w.proof(a);
    expect((await w.ok()).outcome).toBe("none");
    const w2 = new ReleaseWorld();
    const b = w2.land();
    w2.qualified(b);
    // Only CI's job list is cut; the qualification proof stays complete.
    for (const r of w2.target.runs) if (r.head_sha === b && r.path === ".github/workflows/ci.yml") w2.target.incompleteJobs.add(r.id);
    const r2 = await w2.ok();
    expect(r2.outcome).toBe("none");
    expect(JSON.stringify(r2.decision)).toContain("job list incomplete");
    expect(w.releaseWrites().length + w2.releaseWrites().length).toBe(0);
  });

  test("a failed run with a cut job list is not outvoted by a green run on another branch", async () => {
    const w = new ReleaseWorld();
    const b = w.land();
    w.proof(b); // complete proof
    const red = w.target.addRun({ head_sha: b, path: ".github/workflows/ci.yml", event: "push", head_branch: "main", conclusion: "failure" }, [job("Test", "failure")]);
    w.target.incompleteJobs.add(red.id);
    w.target.addRun({ head_sha: b, path: ".github/workflows/ci.yml", event: "push", head_branch: "queue/7" }, [job("Test")]);
    const r = await w.ok();
    expect(r.outcome).toBe("none");
    expect(JSON.stringify(r.decision)).toContain(`run ${red.id} job list incomplete`);
    expect(w.releaseWrites()).toEqual([]);
  });

  test("a failing queue-branch run past the run list's page limit: incomplete evidence qualifies nothing", async () => {
    const setup = () => {
      const w = new ReleaseWorld();
      const b = w.land();
      w.qualified(b); // green CI on main, a genuine proof
      w.target.addRun({ head_sha: b, path: ".github/workflows/ci.yml", event: "push", head_branch: "queue/7", conclusion: "failure" }, [job("Test", "failure")]);
      return w;
    };
    const complete = setup();
    expect((await complete.ok()).outcome).toBe("none"); // the red queue run is seen
    const cut = setup();
    cut.target.runListLimit = 1; // the listing stops before the red run, and says so
    const r = await cut.ok();
    expect(r.outcome).toBe("none");
    expect(JSON.stringify(r.decision)).toContain("push run list incomplete");
    expect(complete.releaseWrites().length + cut.releaseWrites().length).toBe(0);
  });

  test("a forged `qualified` status never advances release", async () => {
    const forgeries: [string, (w: ReleaseWorld, c: string) => void][] = [
      ["status points at another repository", (w, c) => w.status(c, runUrl(w.proof(c), `evil/${NAMES.target.name}`))],
      ["status points at a genuine qualify run that qualified another commit", (w, c) => void w.proof(c, { jobFor: w.R })],
      ["status points at a pull_request run whose job is named for c", (w, c) => void w.proof(c, { event: "pull_request" })],
      ["status points at a qualify run on a branch", (w, c) => void w.proof(c, { branch: "feat/evil" })],
      ["status points at another workflow", (w, c) => void w.proof(c, { path: ".github/workflows/evil.yml" })],
      ["status points at a run that does not exist", (w, c) => w.status(c, runUrl(987654))],
      ["status has no target", (w, c) => w.status(c, null)],
    ];
    for (const [why, forge] of forgeries) {
      const w = new ReleaseWorld();
      const c = w.land();
      w.ci(c); // CI itself is green: only the proof is forged
      forge(w, c);
      const r = await w.ok();
      expect(r.outcome, why).toBe("none");
      expect(w.releaseWrites(), why).toEqual([]);
    }
  });

  test("a non-ancestor: a qualified first-parent commit that does not contain release is refused", async () => {
    // release took a hotfix H; main later merges it back (M2 = main + H).
    // The older first-parent commit A is qualified but does not contain release.
    const w = new ReleaseWorld();
    const a = w.land();
    const h = w.target.commit([w.R], "hotfix");
    w.target.refs.set("release", h);
    w.qualified(a);
    expect((await w.ok()).outcome).toBe("alert"); // release...main is diverged before the merge-back
    expect(w.issues("release-blocked")).toHaveLength(1);
    const m2 = w.land([h]);
    w.ci(m2, [job("Test", "failure")]); // the merge-back itself is not qualifiable
    const r = await w.ok();
    expect(r.outcome).toBe("none");
    expect(JSON.stringify(r.decision)).toContain("not a descendant of release");
    expect(w.releaseWrites()).toEqual([]);
    expect(w.release).toBe(h);
  });
});

describe("discovery: a limit hit is not 'none'", () => {
  test("a cut compare listing is `truncated`, an alert, and nothing is written", async () => {
    const w = new ReleaseWorld();
    const cs = [w.land(), w.land(), w.land(), w.land()];
    for (const c of cs) w.qualified(c);
    w.target.compareCommitLimit = 2; // the listing stops before main itself
    const r = await w.ok();
    expect(r.outcome).toBe("alert");
    expect(JSON.stringify(r.decision)).toContain("truncated");
    expect(w.releaseWrites()).toEqual([]);
    expect(w.issues("release-blocked")).toHaveLength(1);
    await w.ok(); // alerts are idempotent
    expect(w.issues("release-blocked")).toHaveLength(1);
    w.target.compareCommitLimit = null;
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.release).toBe(cs[3]!);
  });

  test("running out of candidates to examine is an alert, not 'none'", async () => {
    const w = new ReleaseWorld({ maxCandidates: 2 });
    w.qualified(w.land());
    w.land();
    w.land(); // the newest two are unqualified
    const r = await w.ok();
    expect(r.outcome).toBe("alert");
    expect(JSON.stringify(r.decision)).toContain("search limit");
    expect(w.releaseWrites()).toEqual([]);
  });

  test("the real client: >300 files does not truncate discovery; fewer commits than ahead_by does", async () => {
    const base = sha("base");
    const a = sha("A");
    const commit = { sha: a, parents: [{ sha: base }], commit: { verification: { verified: true } } };
    const client = (aheadBy: number) =>
      TargetClient.connect({
        ...TARGET_OPTS,
        token: "t",
        owner: NAMES.target.owner,
        repo: NAMES.target.name,
        repoId: TARGET,
        role: "read",
        fetch: (async (input: string | URL | Request) => {
          if (pathRe(`/repos/${TARGET_SLUG}`).test(String(input))) return new Response(JSON.stringify({ id: TARGET, node_id: "R" }));
          const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` }));
          return new Response(JSON.stringify({ status: "ahead", ahead_by: aheadBy, behind_by: 0, commits: [commit], files }));
        }) as typeof fetch,
      });
    const full = await (await client(1)).compare(base, a);
    expect(full.truncated).toBe(true); // the file list is capped
    expect(full.commitsTruncated).toBe(false);
    expect((await (await client(5)).compare(base, a)).commitsTruncated).toBe(true);
  });
});
