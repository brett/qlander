// release.mode dispatch end to end against the fake GitHub (DESIGN.md §8.1):
// the release job never writes release, dispatches the target's own promote
// workflow as a dry run and then for real once an approver approves that sha,
// and counts release as advanced only when it sees the ref there. Every
// DispatchWorld tick checks that no ref writer on the target was called.

import { describe, expect, test } from "bun:test";
import { fenced } from "../src/fenced";
import { GitHubError } from "../src/github/http";
import { TargetClient } from "../src/github/target";
import { dispatchOnly, echoesId, dispatchIdFor, DISPATCH_REFUSALS } from "../src/release-dispatch";
import { parseReleaseState } from "../src/release-state";
import { releaseDryRun } from "../src/release-runner";
import { LostLockError } from "../src/store";
import { APPROVER, BOT, DispatchWorld, PROMOTE, STRANGER } from "./release-world";
import { CrashError } from "../src/queue";
import { FakeTarget } from "./fake-github";
import { job, NAMES, sha, TARGET, TARGET_OPTS } from "./sim";

const ALERT = "release-blocked";

/** A world with one qualified commit on main, ticked until its dry run is green and reported. */
async function greenDry(over: ConstructorParameters<typeof DispatchWorld>[0] = {}) {
  const w = new DispatchWorld(over);
  const a = w.land();
  w.qualified(a);
  expect((await w.ok()).outcome).toBe("dispatched");
  const r = await w.ok();
  expect(r.outcome).toBe("waiting");
  expect(w.candidate()).toMatchObject({ sha: a, dry: { conclusion: "success" } });
  return { w, a };
}

describe("dispatch mode: the happy path", () => {
  test("a dry run, a report, an approval, a real run, and release seen at the commit; release is never written", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);

    const t1 = await w.ok();
    expect(t1.outcome).toBe("dispatched");
    expect(w.target.workflowDispatches).toHaveLength(1);
    const d1 = w.target.workflowDispatches[0]!;
    expect(d1).toMatchObject({ workflow: PROMOTE, ref: "main", inputs: { sha: a, dry_run: "true" } });
    expect(d1.inputs.dispatch_id).toMatch(/^qlr-dry-/);
    const c1 = w.candidate()!;
    expect(c1.dry).toMatchObject({ kind: "dry", id: d1.inputs.dispatch_id, sent: "yes", run: null, conclusion: null });
    expect(w.state().journal).toBeNull();
    expect(w.state().dispatch!.window).toHaveLength(1);

    const t2 = await w.ok();
    expect(t2.outcome).toBe("waiting");
    const c2 = w.candidate()!;
    expect(c2.dry).toMatchObject({ conclusion: "success", run: { id: w.dispatched[0]!.run!.id } });
    expect(w.repo.posted).toHaveLength(1);
    const report = w.repo.posted[0]!;
    expect(report.issue).toBe(w.statusIssue);
    expect(report.body).toContain(a);
    expect(report.body).toContain(c2.dry!.run!.url);
    expect(report.body).toContain(`/qlander approve-release ${a}`);
    expect(report.body).toContain("- plan: success");
    expect(c2.reported).toMatchObject({ issue: w.statusIssue });

    // Waiting for an approval reports nothing twice and dispatches nothing.
    expect((await w.ok()).outcome).toBe("waiting");
    expect(w.repo.posted).toHaveLength(1);
    expect(w.target.workflowDispatches).toHaveLength(1);

    w.approve(a);
    expect((await w.ok()).outcome).toBe("dispatched");
    expect(w.target.workflowDispatches[1]).toMatchObject({ inputs: { sha: a, dry_run: "false" } });
    expect(w.candidate()!.approval).toMatchObject({ login: APPROVER.login, id: APPROVER.id });
    expect(w.candidate()!.real).toMatchObject({ kind: "real", sent: "yes", conclusion: null }); // qlander has not seen it run yet

    const t5 = await w.ok();
    expect(t5.outcome).toBe("advanced");
    expect(w.release).toBe(a); // moved by the target workflow, not by qlander
    expect(w.candidate()).toBeNull();
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "released", dryRun: w.dispatched[0]!.run!.id, realRun: w.dispatched[1]!.run!.id });
    expect(w.state().history.at(-1)).toMatchObject({ outcome: "advanced", from: w.R, to: a, receipt: { to: a } });
    expect(w.refWrites).toEqual([]);
    expect(w.releaseWrites()).toEqual([]);
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`]);

    // Nothing more to do: release is main.
    expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: "release is main" });
    expect(w.target.workflowDispatches).toHaveLength(2);
  });

  test("the run is matched by the dispatch id its run name echoes, as a whole token", () => {
    const id = dispatchIdFor("dry", sha("x"), 3, "run-1");
    expect(id).toMatch(/^qlr-dry-[0-9a-f]{12}-[0-9a-f]{12}$/);
    expect(echoesId(`Promote (${id})`, id)).toBe(true);
    expect(echoesId(id, id)).toBe(true);
    expect(echoesId(`${id}x`, id)).toBe(false);
    expect(echoesId(`x-${id}`, id)).toBe(false);
    expect(echoesId("Promote", id)).toBe(false);
    expect(dispatchIdFor("dry", sha("x"), 4, "run-1")).not.toBe(id);
  });
});

describe("dispatch mode: release is never written", () => {
  test("the dispatch-role client refuses every ref write before any request", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.endsWith(`/repos/${NAMES.target.owner}/${NAMES.target.name}`)) return new Response(JSON.stringify({ id: NAMES.target.id, node_id: "R_1" }), { status: 200 });
      return new Response("{}", { status: 204 });
    }) as typeof fetch;
    const c = await TargetClient.connect({ ...TARGET_OPTS, owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, fetch: fetchFn, token: "t", role: "dispatch", names: NAMES, dataFiles: [], dispatch: { workflow: PROMOTE, ref: NAMES.main, inputs: ["sha", "dry_run", "dispatch_id"] } });
    const before = calls.length;
    const s1 = sha("one");
    const s2 = sha("two");
    await expect(c.updateRef(NAMES.release, s1, s2)).rejects.toThrow("writes no ref");
    await expect(c.updateRef(NAMES.main, s1, s2)).rejects.toThrow("writes no ref");
    await expect(c.createRef(`${NAMES.queuePrefix}1`, s1)).rejects.toThrow("writes no ref");
    await expect(c.deleteRef(`${NAMES.queuePrefix}1`)).rejects.toThrow("writes no ref");
    await expect(c.merge(`${NAMES.buildPrefix}1`, s1, "m")).rejects.toThrow("writes no ref");
    await expect(c.comment(1, "x")).rejects.toThrow("writes no ref");
    // Only the configured workflow, ref and input names.
    await expect(c.dispatchWorkflow(".github/workflows/other.yml", NAMES.main, { sha: s1, dry_run: "true", dispatch_id: "qlr-dry-x" })).rejects.toThrow("may be dispatched");
    await expect(c.dispatchWorkflow(PROMOTE, NAMES.release, { sha: s1, dry_run: "true", dispatch_id: "x" })).rejects.toThrow("may be dispatched");
    await expect(c.dispatchWorkflow(PROMOTE, NAMES.main, { sha: s1, dry_run: "true" })).rejects.toThrow("exactly");
    await expect(c.dispatchWorkflow(PROMOTE, NAMES.main, { sha: s1, dry_run: "true", dispatch_id: "a b" })).rejects.toThrow("value");
    expect(calls.length).toBe(before);
    await c.dispatchWorkflow(PROMOTE, NAMES.main, { sha: s1, dry_run: "true", dispatch_id: "qlr-dry-x" });
    expect(calls.at(-1)).toMatch(/^POST .*\/actions\/workflows\/promote\.yml\/dispatches$/);
  });

  test("a release-role client cannot dispatch, and the dispatch allowance goes with the dispatch role only", async () => {
    const fetchFn = (async () => new Response(JSON.stringify({ id: NAMES.target.id, node_id: "R_1" }), { status: 200 })) as unknown as typeof fetch;
    const rel = await TargetClient.connect({ ...TARGET_OPTS, owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, fetch: fetchFn, token: "t", role: "release", names: NAMES, dataFiles: [] });
    await expect(rel.dispatchWorkflow(PROMOTE, NAMES.main, {})).rejects.toThrow("may not dispatch");
    await expect(rel.readVariable("X")).rejects.toThrow("reads no variables");
    await expect(TargetClient.connect({ ...TARGET_OPTS, owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, fetch: fetchFn, token: "t", role: "dispatch", names: NAMES, dataFiles: [] })).rejects.toThrow("allowance");
    await expect(TargetClient.connect({ ...TARGET_OPTS, owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, fetch: fetchFn, token: "t", role: "release", names: NAMES, dataFiles: [], dispatch: { workflow: PROMOTE, ref: NAMES.main, inputs: ["a"] } })).rejects.toThrow("allowance");
  });

  test("the client the dispatch tick gets has no ref writer at all", () => {
    const t = dispatchOnly(new FakeTarget("dispatch"));
    for (const m of ["createRef", "deleteRef", "updateRef", "epochUpdateRefs", "merge", "voidEpoch", "comment", "removeLabel", "dispatch", "rerunFailedJobs", "cancelRun"]) expect(m in t).toBe(false);
    expect(typeof t.dispatchWorkflow).toBe("function");
  });

  test("across every scenario below, no ref writer is called: DispatchWorld.ok() fails the test if one is", async () => {
    for (const m of ["updateRef", "advanceEpoch", "voidEpoch", "merge"] as const) {
      const w = new DispatchWorld();
      (w.target as unknown as Record<string, (...a: unknown[]) => Promise<void>>)[m]!("release", w.R, w.R).catch(() => {});
      await expect(w.ok(), m).rejects.toThrow("a ref writer was called in dispatch mode");
    }
  });
});

describe("dispatch mode: once per sha", () => {
  test("a red dry run is never dispatched again for that commit; a newer one gets its own", async () => {
    const w = new DispatchWorld();
    w.behave = () => ({ conclusion: "failure" });
    const a = w.land();
    w.qualified(a);
    expect((await w.ok()).outcome).toBe("dispatched");
    expect((await w.ok()).outcome).toBe("alert");
    expect(w.issues(ALERT).some((i) => i.title.includes("dry run"))).toBe(true);
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "dry-failed" });
    for (let i = 0; i < 3; i++) expect((await w.ok()).outcome).toBe("none");
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
    w.behave = () => ({});
    const b = w.land();
    w.qualified(b);
    expect((await w.ok()).outcome).toBe("dispatched");
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `dry ${b.slice(0, 8)}`]);
  });

  test("a failed real run is never dispatched again for that commit, approval or not", async () => {
    const { w, a } = await greenDry();
    w.behave = ({ kind }) => (kind === "real" ? { conclusion: "failure" } : {});
    w.approve(a);
    expect((await w.ok()).outcome).toBe("dispatched");
    expect((await w.ok()).outcome).toBe("alert");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "real-failed" });
    expect(w.issues(ALERT).some((i) => i.title.includes("real run"))).toBe(true);
    expect(w.issues("release-pause")).toHaveLength(0); // a run that concluded is known: no pause
    w.approve(a);
    for (let i = 0; i < 3; i++) await w.ok();
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`]);
    expect(w.release).toBe(w.R);
  });

  test("a real run is never dispatched without a green dry run of that sha inside the window", async () => {
    const { w, a } = await greenDry({ dryRunValidMinutes: 30 });
    // The window passes before anyone approves.
    w.now = new Date(w.now.getTime() + 31 * 60_000);
    w.approve(a);
    expect((await w.ok()).outcome).toBe("alert");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "expired" });
    await w.ok();
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
  });
});

describe("dispatch mode: approvals", () => {
  test("refused: another sha, a stranger, an edited comment, and one posted before the dry run", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    const early = w.approve(a, APPROVER, { at: new Date(w.now.getTime() - 60_000) }); // before the dry run exists
    await w.ok();
    await w.ok();
    w.approve(sha("not-the-candidate"));
    w.approve(a, STRANGER);
    w.approve(a, APPROVER, { edited: true });
    w.approve(a, APPROVER, { body: `/qlander approve-release ${a} please` });
    const r = await w.ok();
    expect(r.outcome).toBe("waiting");
    const refused = r.log.filter((l) => l.startsWith("approval refused"));
    expect(refused.some((l) => l.includes(`comment ${early}`) && l.includes("predates"))).toBe(true);
    expect(refused.some((l) => l.includes(`not the candidate ${a}`))).toBe(true);
    expect(refused.some((l) => l.includes(STRANGER.login) && l.includes("not in release.dispatch.approvers"))).toBe(true);
    expect(refused.some((l) => l.includes("was edited"))).toBe(true);
    expect(refused).toHaveLength(5);
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
    // An account with the approver's login but another id is a stranger too.
    w.approve(a, { login: APPROVER.login, id: APPROVER.id + 1 });
    expect((await w.ok()).outcome).toBe("waiting");
    w.approve(a);
    expect((await w.ok()).outcome).toBe("dispatched");
  });

  test("an approval for an older, superseded candidate does not count for the newer one", async () => {
    const { w, a } = await greenDry();
    const b = w.land();
    w.qualified(b);
    expect((await w.ok()).outcome).toBe("dispatched"); // supersedes a, dry run of b
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "superseded" });
    w.approve(a);
    const r = await w.ok();
    expect(r.outcome).toBe("waiting");
    expect(r.log.some((l) => l.includes(`not the candidate ${b}`))).toBe(true);
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `dry ${b.slice(0, 8)}`]);
  });

  test("without an open status issue, nothing is reported and nothing is approved", async () => {
    const w = new DispatchWorld();
    w.repo.issues.find((i) => i.number === w.statusIssue)!.open = false;
    const a = w.land();
    w.qualified(a);
    await w.ok();
    const r = await w.ok();
    expect(r.outcome).toBe("waiting");
    expect(r.log.some((l) => l.includes("no open"))).toBe(true);
    expect(w.repo.posted).toHaveLength(0);
  });
});

describe("dispatch mode: crashes and lost responses", () => {
  test("a crash after the dispatch and before its receipt converges on the same run, never a second dispatch", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    expect(await w.tick({ crash: "after-effect" })).toBe("crashed");
    expect(w.state().journal).toMatchObject({ op: "dispatch", kind: "dry", sha: a });
    expect(w.target.workflowDispatches).toHaveLength(1);
    w.pastLease();
    const r = await w.ok({ executor: undefined });
    expect(r.log.some((l) => l.includes("never resending"))).toBe(true);
    expect(w.state().journal).toBeNull();
    expect(w.candidate()!.dry).toMatchObject({ sent: "unknown", conclusion: "success", id: w.dispatched[0]!.id });
    expect(w.target.workflowDispatches).toHaveLength(1);
    w.approve(a);
    await w.until((x) => x.outcome === "advanced");
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`]);
  });

  test("a crash after the intent and before the request: nothing is resent, and the run that never appears ends that commit's dry run", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    expect(await w.tick({ crash: "after-intent" })).toBe("crashed");
    expect(w.target.workflowDispatches).toHaveLength(0);
    w.pastLease();
    await w.ok();
    expect(w.candidate()!.dry).toMatchObject({ sent: "unknown", conclusion: null });
    await w.until((x) => x.outcome === "alert");
    expect(w.candidate()).toBeNull();
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "dry-failed" });
    expect(w.target.workflowDispatches).toHaveLength(0);
  });

  test("a crash during the real dispatch converges too: one real run", async () => {
    const { w, a } = await greenDry();
    w.approve(a);
    expect(await w.tick({ crash: "after-effect" })).toBe("crashed");
    w.pastLease();
    await w.until((x) => x.outcome === "advanced");
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`]);
    expect(w.release).toBe(a);
  });

  test("a lost response is not resent: the run is looked for and followed", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    w.target.workflowDispatchErrors.push("lost");
    expect((await w.ok()).outcome).toBe("dispatched");
    expect(w.candidate()!.dry).toMatchObject({ sent: "unknown" });
    await w.ok();
    expect(w.candidate()!.dry).toMatchObject({ conclusion: "success" });
    expect(w.target.workflowDispatches).toHaveLength(1);
  });

  test("a definite refusal (4xx) started nothing: it is retried within its limit, then given up for that commit", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    for (let i = 0; i < DISPATCH_REFUSALS + 2; i++) w.target.workflowDispatchErrors.push(new GitHubError("validation", 422, "Unexpected inputs provided"));
    for (let i = 1; i <= DISPATCH_REFUSALS; i++) {
      expect((await w.ok()).outcome).toBe("rejected");
      expect(w.candidate()).toMatchObject({ dry: null, refused: i });
    }
    expect((await w.ok()).outcome).toBe("alert");
    expect(w.target.workflowDispatches).toHaveLength(0);
    expect(w.issues(ALERT).some((i) => i.title.includes("refused"))).toBe(true);
    expect(w.state().dispatch!.window).toHaveLength(DISPATCH_REFUSALS); // each reservation stays spent
  });
});

describe("dispatch mode: runs that go wrong", () => {
  test("a dry run that never appears (no dispatch id in its run name) ends that commit's dry run", async () => {
    const w = new DispatchWorld();
    w.behave = () => ({ echo: false });
    const a = w.land();
    w.qualified(a);
    const rs = await w.until((r) => r.outcome === "alert");
    expect(rs.length).toBe(1 + Math.ceil(w.dcfg.appearMinutes / w.cfg.runner.cronMinutes));
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "dry-failed", note: expect.stringContaining("never-appeared") });
    expect(w.issues("release-pause")).toHaveLength(0);
  });

  test("a real run that never appears pauses: it may be promoting unseen", async () => {
    const { w, a } = await greenDry();
    w.behave = ({ kind }) => (kind === "real" ? { noRun: true } : {});
    w.approve(a);
    await w.ok();
    const rs = await w.until((r) => r.outcome === "paused");
    expect(rs.at(-1)!.outcome).toBe("paused");
    expect(w.issues("release-pause")).toHaveLength(1);
    expect(w.issues("release-pause")[0]!.body).toContain("could not be followed");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "real-failed" });
  });

  test("a cancelled dry run, and a cancelled real run, are release-blocked, not retried", async () => {
    const w = new DispatchWorld();
    w.behave = () => ({ conclusion: "cancelled" });
    const a = w.land();
    w.qualified(a);
    await w.ok();
    expect((await w.ok()).outcome).toBe("alert");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ outcome: "dry-failed", note: expect.stringContaining("cancelled") });

    const { w: v, a: b } = await greenDry();
    v.behave = ({ kind }) => (kind === "real" ? { conclusion: "cancelled" } : {});
    v.approve(b);
    await v.ok();
    expect((await v.ok()).outcome).toBe("alert");
    expect(v.dispatchHistory().at(-1)).toMatchObject({ outcome: "real-failed", note: expect.stringContaining("cancelled") });
  });

  test("a run that never finishes is given up after runHours", async () => {
    const w = new DispatchWorld({ runHours: 1 });
    w.behave = () => ({ runTicks: 1000 });
    const a = w.land();
    w.qualified(a);
    await w.until((r) => r.outcome === "alert");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "dry-failed", note: expect.stringContaining("stuck") });
  });

  test("a green real run that never moves release is release-blocked after observeMinutes, and never dispatched again", async () => {
    const { w, a } = await greenDry();
    w.behave = ({ kind }) => (kind === "real" ? { moveRelease: false } : {});
    w.approve(a);
    await w.ok();
    expect((await w.ok()).outcome).toBe("waiting");
    await w.until((r) => r.outcome === "alert");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "not-observed" });
    await w.ok();
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`]);
  });

  test("a real run that failed although release reached the commit counts as released, with an alert", async () => {
    const { w, a } = await greenDry();
    w.behave = ({ kind }) => (kind === "real" ? { conclusion: "failure" } : {});
    w.approve(a);
    await w.ok();
    w.target.githubUpdateRefs("release", w.R, a); // the workflow moved release, then a later step failed
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ outcome: "released" });
    expect(w.issues(ALERT).some((i) => i.body.includes("check the promotion"))).toBe(true);
  });
});

describe("dispatch mode: release diverged, and a newer candidate mid-flight", () => {
  test("a diverged release is release-blocked and nothing is dispatched, approval or not", async () => {
    const { w, a } = await greenDry();
    const hotfix = w.target.commit([w.R], "hotfix");
    w.target.githubUpdateRefs("release", w.R, hotfix);
    w.approve(a);
    const r = await w.ok();
    expect(r.outcome).toBe("alert");
    expect(r.decision).toMatchObject({ kind: "alert", reason: expect.stringContaining("diverged") });
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
    expect(w.candidate()).toMatchObject({ sha: a }); // kept: once release is merged back it is still the candidate
  });

  test("a newer candidate during the dry run waits for that run, then supersedes it", async () => {
    const w = new DispatchWorld();
    w.behave = ({ sha: s }) => (s === a ? { runTicks: 2 } : {});
    const a = w.land();
    w.qualified(a);
    await w.ok();
    const b = w.land();
    w.qualified(b);
    const r = await w.ok();
    expect(r.outcome).toBe("waiting"); // one target run at a time
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
    expect((await w.ok()).outcome).toBe("dispatched");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "superseded" });
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `dry ${b.slice(0, 8)}`]);
  });

  test("a newer candidate during the real run never supersedes it: it is followed to the end, then the newer one starts", async () => {
    const { w, a } = await greenDry();
    w.behave = ({ kind }) => (kind === "real" ? { runTicks: 2 } : {});
    w.approve(a);
    expect((await w.ok()).outcome).toBe("dispatched");
    const b = w.land();
    w.qualified(b);
    expect((await w.ok()).outcome).toBe("waiting");
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.release).toBe(a);
    expect((await w.ok()).outcome).toBe("dispatched");
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`, `dry ${b.slice(0, 8)}`]);
  });

  test("release moved to the candidate some other way: it is closed without a real run", async () => {
    const { w, a } = await greenDry();
    w.target.githubUpdateRefs("release", w.R, a);
    await w.ok();
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "released-elsewhere" });
  });
});

describe("dispatch mode: pause, freeze, budget, lease and fence", () => {
  test("paused: nothing is dispatched, but a run in flight is still followed", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    await w.ok();
    w.repo.issues.push({ number: 99, title: "hold", body: "", labels: ["release-pause"], open: true });
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.candidate()!.dry).toMatchObject({ conclusion: "success" });
    w.approve(a);
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.target.workflowDispatches).toHaveLength(1);
    w.repo.issues.find((i) => i.number === 99)!.open = false;
    expect((await w.ok()).outcome).toBe("dispatched");
  });

  test("a freeze variable at its value stops new dispatches, dry and real; unset or another value does not", async () => {
    const w = new DispatchWorld({ freeze: [{ variable: "RELEASE_FREEZE", value: "true" }] });
    const a = w.land();
    w.qualified(a);
    w.target.variables.set("RELEASE_FREEZE", "true");
    const r = await w.ok();
    expect(r.outcome).toBe("waiting");
    expect(r.log.some((l) => l.includes("frozen: the target variable RELEASE_FREEZE"))).toBe(true);
    expect(w.target.workflowDispatches).toHaveLength(0);
    w.target.variables.set("RELEASE_FREEZE", "false");
    expect((await w.ok()).outcome).toBe("dispatched");
    await w.ok();
    w.target.variables.delete("RELEASE_FREEZE");
    w.target.variableErrors.set("RELEASE_FREEZE", new GitHubError("auth", 403, "Resource not accessible by integration"));
    w.approve(a);
    const f = await w.ok();
    expect(f.outcome).toBe("waiting");
    expect(f.log.some((l) => l.includes("counts as frozen"))).toBe(true);
    expect(w.target.workflowDispatches).toHaveLength(1);
    w.target.variableErrors.clear();
    expect((await w.ok()).outcome).toBe("dispatched");
  });

  test("the dispatch budget: once spent, nothing more is dispatched and a release-blocked issue says why", async () => {
    const { w, a } = await greenDry({ budget: { window: 1, windowHours: 24 } });
    w.approve(a);
    expect((await w.ok()).outcome).toBe("alert");
    expect(w.issues(ALERT).some((i) => i.title.includes("budget"))).toBe(true);
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
  });

  test("a held lease: the tick is busy and dispatches nothing", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    const executor = { runId: 77, attempt: 1, job: w.cfg.names.release };
    expect(await w.tick({ crash: "after-intent", executor })).toBe("crashed"); // leaves its lease held
    w.repo.jobStates.set(`77/1/${executor.job}`, "running"); // and GitHub still reports its job running
    expect((await w.ok()).outcome).toBe("busy");
    expect(w.target.workflowDispatches).toHaveLength(0);
  });

  test("the fence: a lost lease, or with the epoch fence an epoch a successor moved, stops the dispatch before it is sent", async () => {
    const t = new FakeTarget("dispatch");
    const lost = fenced(t, async () => {
      throw new LostLockError("lease gone");
    });
    await expect(lost.dispatchWorkflow(PROMOTE, "main", {})).rejects.toThrow("lease gone");
    t.epochBranch = "qlander-epoch/release";
    const mine = await t.advanceEpoch(null, "mine");
    const box = { epoch: mine };
    const f = fenced(t, async () => {}, () => box.epoch);
    await t.advanceEpoch(mine, "successor");
    await expect(f.dispatchWorkflow(PROMOTE, "main", {})).rejects.toThrow("successor");
    expect(t.workflowDispatches).toHaveLength(0);
  });

  test("with the epoch fence on, a dispatch-mode tick takes its epoch and still writes no other ref", async () => {
    const w = new DispatchWorld({}, {});
    w.cfg = { ...w.cfg, runner: { ...w.cfg.runner, epochFence: true } };
    w.target.epochBranch = `${w.cfg.runner.epochPrefix}release`;
    const a = w.land();
    w.qualified(a);
    expect((await w.ok()).outcome).toBe("dispatched");
    expect(w.target.calls.some((c) => c.startsWith("epochHeld"))).toBe(true);
    // Exactly one ref write: advanceEpoch on the job's own epoch branch. Never release, main or a batch ref.
    expect(w.refWrites.map(([m]) => m)).toEqual(["advanceEpoch"]);
    expect(w.target.calls.filter((c) => c.startsWith("advanceEpoch"))).toEqual([expect.stringMatching(new RegExp(`^advanceEpoch ${w.target.epochBranch} `))]);
    expect(w.release).toBe(w.R);
  });
});

describe("dispatch mode: dry run and state", () => {
  test("QLANDER_MODE not live (releaseDryRun) dispatches nothing and says what a live tick would do", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    w.target.role = "read";
    const r = await releaseDryRun({ target: w.target, repo: w.repo, stateRef: w.stateRef, cfg: w.cfg });
    expect(r.log).toEqual([`[dry run] a live tick would dispatch a dry run of ${a}`]);
    expect(w.target.workflowDispatches).toHaveLength(0);
    expect(w.stateRef.current).toBeNull();
  });

  test("the state parser refuses a real run with no green dry run or no approval", async () => {
    const { w, a } = await greenDry();
    w.approve(a);
    await w.ok();
    const text = w.stateRef.current!.text;
    expect(parseReleaseState(text).dispatch!.candidate!.real).not.toBeNull();
    const s = JSON.parse(text);
    s.dispatch.candidate.approval = null;
    expect(() => parseReleaseState(JSON.stringify(s))).toThrow("without a green dry run and an approval");
    const t = JSON.parse(text);
    t.dispatch.candidate.dry.conclusion = "failure";
    expect(() => parseReleaseState(JSON.stringify(t))).toThrow("without a green dry run");
    const u = JSON.parse(text);
    u.dispatch.extra = 1;
    expect(() => parseReleaseState(JSON.stringify(u))).toThrow("unknown field extra");
  });

  test("an advance-mode state without the dispatch field still parses unchanged", () => {
    const s = { v: 1, lease: null, seq: 0, journal: null, pausePending: null, last: null, history: [] };
    expect(parseReleaseState(JSON.stringify(s))).toEqual(s as never);
  });
});

describe("dispatch mode: the real clients", () => {
  /** A fetch that records every request and answers the reads these tests make. */
  function recording() {
    const seen: { method: string; url: string; body: unknown }[] = [];
    const json = (b: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(b), { status });
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input).replace("https://api.github.com/", "");
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === `repos/${NAMES.target.owner}/${NAMES.target.name}`) return json({ id: NAMES.target.id, node_id: "R_t" });
      if (url === `repos/${NAMES.control.owner}/${NAMES.control.name}`) return json({ id: NAMES.control.id, node_id: "R_c" });
      if (/actions\/variables\/RELEASE_FREEZE$/.test(url)) return json({ name: "RELEASE_FREEZE", value: "true" });
      if (/actions\/variables\//.test(url)) return json({ message: "Not Found" }, 404);
      if (/issues\/3\/comments(\?|$)/.test(url) && method === "GET") return json([{ id: 1, user: { login: "alice", id: 7 }, body: "hi", created_at: "t", updated_at: "t" }, { id: 2, user: null, body: "ghost", created_at: "t", updated_at: "t" }]);
      if (/issues\/3\/comments$/.test(url) && method === "POST") return json({ id: 5 }, 201);
      if (method !== "GET") return json(null, 204);
      return json({ message: "Not Found" }, 404);
    }) as typeof fetch;
    return { seen, fetchFn };
  }

  test("connectReleaseClients gives a live dispatch-mode job the dispatch role, the configured workflow only, and the status label", async () => {
    const { connectReleaseClients } = await import("../src/main");
    const { defaultReleaseConfig } = await import("../src/release-config");
    const { RELEASE_TOKEN_ENV } = await import("./sim");
    const { DISPATCH } = await import("./release-world");
    const { seen, fetchFn } = recording();
    const cfg = { ...defaultReleaseConfig, dryRun: false, mode: "dispatch" as const, dispatch: DISPATCH };
    const c = await connectReleaseClients({ [RELEASE_TOKEN_ENV]: "r", STATE_TOKEN: "s", GITHUB_TOKEN: "g" }, cfg, "release", fetchFn);
    await expect(c.target.updateRef(NAMES.release, sha("a"), sha("b"))).rejects.toThrow("writes no ref");
    await c.target.dispatchWorkflow(PROMOTE, "main", { sha: sha("a"), dry_run: "true", dispatch_id: "qlr-dry-x" });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: `repos/${NAMES.target.owner}/${NAMES.target.name}/actions/workflows/promote.yml/dispatches`, body: { ref: "main", inputs: { sha: sha("a"), dry_run: "true", dispatch_id: "qlr-dry-x" } } });
    expect(await c.target.readVariable("RELEASE_FREEZE")).toBe("true");
    expect(await c.target.readVariable("OTHER")).toBeNull();
    // The status label is on the issue client's allowlist (this fetch has no GraphQL listing, so it fails later, for another reason).
    expect(await c.repo.listOpenIssues(NAMES.watchdogLabels.status).then(() => "", (e: Error) => e.message)).not.toContain("unexpected label");
    expect(await c.repo.listOpenIssues("bogus").then(() => "", (e: Error) => e.message)).toContain("unexpected label");
    // Held in dry run (release.dryRun), the same config gets a read-only client.
    const dry = await connectReleaseClients({ [RELEASE_TOKEN_ENV]: "r", STATE_TOKEN: "s", GITHUB_TOKEN: "g" }, { ...cfg, dryRun: true }, "release", fetchFn);
    await expect(dry.target.dispatchWorkflow(PROMOTE, "main", {})).rejects.toThrow("may not dispatch");
  });

  test("the state repo client reads issue comments, and posts only a candidate report", async () => {
    const { StateRepoClient } = await import("../src/github/state-repo");
    const { RELEASE_REPORT_MARKER } = await import("../src/github/api");
    const { seen, fetchFn } = recording();
    const c = await StateRepoClient.connect({ labels: [NAMES.watchdogLabels.status], token: "g", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: NAMES.control.id, fetch: fetchFn });
    const l = await c.listIssueComments(3);
    expect(l.items.map((x) => x.id)).toEqual([1]); // a comment with no resolvable author is nobody's
    await expect(c.commentIssue(3, "/qlander approve-release x")).rejects.toThrow("candidate report");
    expect(await c.commentIssue(3, `${RELEASE_REPORT_MARKER}${sha("a")} -->\nbody`)).toBe(5);
    expect(seen.filter((x) => x.method === "POST").map((x) => x.url)).toEqual([`repos/${NAMES.control.owner}/${NAMES.control.name}/issues/3/comments`]);
  });
});

// Regressions from review: each fails on the code before its fix.
describe("dispatch mode: review regressions", () => {
  test("[1] a run carrying a copied dispatch id but started by anyone else is never adopted", async () => {
    const w = new DispatchWorld();
    w.behave = ({ kind }) => (kind === "dry" ? { appearTicks: 3 } : {});
    const a = w.land();
    w.qualified(a);
    await w.ok();
    const id = w.dispatched[0]!.id;
    const forged = w.target.addRun({ head_sha: w.main, path: PROMOTE, event: "workflow_dispatch", head_branch: "main", created_at: w.now.toISOString(), display_title: `copy ${id}`, actor: { ...STRANGER }, triggering_actor: { ...STRANGER } }, [{ ...job("plan"), completed_at: w.now.toISOString() }], 0);
    // Started by the bot but re-run by a stranger: the triggering actor counts too.
    w.target.addRun({ head_sha: w.main, path: PROMOTE, event: "workflow_dispatch", head_branch: "main", created_at: w.now.toISOString(), display_title: `rerun ${id}`, actor: { ...BOT }, triggering_actor: { ...STRANGER } }, [], 0);
    const r = await w.ok();
    expect(r.log.some((l) => l.includes(`ignored run ${forged.id}`))).toBe(true);
    expect(w.candidate()!.dry).toMatchObject({ run: null, conclusion: null });
    w.approve(a);
    await w.ok();
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
    const ok = await w.until((x) => x.outcome === "dispatched");
    expect(ok.length).toBeGreaterThan(0);
    expect(w.candidate()!.dry!.run!.id).toBe(w.dispatched[0]!.run!.id);
  });

  test("[1] nothing is adopted from a listing that may be cut, and two authenticated runs with one id are ambiguous", async () => {
    const w = new DispatchWorld();
    const a = w.land();
    w.qualified(a);
    await w.ok();
    w.target.pageSize = 0; // every listing comes back truncated
    const r = await w.ok();
    expect(r.log.some((l) => l.includes("listing incomplete"))).toBe(true);
    expect(w.candidate()!.dry).toMatchObject({ run: null });
    w.target.pageSize = 100;
    const id = w.dispatched[0]!.id;
    w.target.addRun({ head_sha: w.main, path: PROMOTE, event: "workflow_dispatch", head_branch: "main", created_at: w.now.toISOString(), display_title: `again ${id}`, actor: { ...BOT }, triggering_actor: { ...BOT } }, [], 0);
    await w.ok();
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "dry-failed", note: expect.stringContaining("ambiguous") });
  });

  test("[2] no sha is dispatched again once its record is pruned from history", async () => {
    const w = new DispatchWorld({}, { historyLimit: 1 });
    w.behave = ({ kind, sha: s }) => (kind === "real" || s !== a ? { conclusion: "failure" } : {});
    const a = w.land();
    w.qualified(a);
    await w.ok();
    await w.ok();
    w.approve(a);
    await w.ok();
    expect((await w.ok()).outcome).toBe("alert"); // a: real-failed
    const b = w.land();
    w.qualified(b);
    await w.ok();
    await w.ok(); // b: dry-failed, which prunes a from history
    expect(w.dispatchHistory().map((h) => h.sha)).toEqual([b]);
    w.target.statuses.delete(b); // b loses its qualification: a is the newest qualified commit again
    w.approve(a);
    for (let i = 0; i < 4; i++) await w.ok();
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`, `dry ${b.slice(0, 8)}`]);
  });

  test("[3] closing an unfollowable real run and its pause are one write: an interruption after it cannot lose the pause", async () => {
    const { w, a } = await greenDry();
    w.behave = ({ kind }) => (kind === "real" ? { noRun: true } : {});
    w.approve(a);
    await w.ok();
    // Interrupt the job right after the state write that closes the candidate: the write lands, its response is lost.
    const cas = w.stateRef.cas.bind(w.stateRef);
    let cut = false;
    w.stateRef.cas = async (before, text) => {
      const v = await cas(before, text);
      const s = JSON.parse(text);
      if (!cut && s.dispatch?.candidate === null && s.dispatch.history.at(-1)?.outcome === "real-failed") {
        cut = true;
        throw new CrashError("after-effect");
      }
      return v;
    };
    for (let i = 0; i < 6 && !cut; i++) await w.tick();
    expect(cut).toBe(true);
    w.stateRef.cas = cas;
    expect(w.state().pausePending).not.toBeNull();
    const b = w.land();
    w.qualified(b);
    w.pastLease();
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.issues("release-pause")).toHaveLength(1);
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`, `real ${a.slice(0, 8)}`]);
  });

  test("[4] a dry run rerun to failure, or deleted, after it was recorded green stops the real run", async () => {
    for (const change of ["rerun-red", "deleted"] as const) {
      const { w, a } = await greenDry();
      const run = w.dispatched[0]!.run!;
      if (change === "rerun-red") {
        w.target.updateRun(run, { run_attempt: 2, conclusion: "failure" });
        w.target.jobs.set(run.id, [{ ...job("plan", "failure"), completed_at: w.now.toISOString(), run_attempt: 2 }]);
      } else w.target.runs = w.target.runs.filter((x) => x.id !== run.id);
      w.approve(a);
      expect((await w.ok()).outcome, change).toBe("alert");
      expect(w.kinds(), change).toEqual([`dry ${a.slice(0, 8)}`]);
      expect(w.dispatchHistory().at(-1), change).toMatchObject({ sha: a, outcome: "dry-failed", note: expect.stringContaining("rechecked before the real run") });
    }
  });

  test("[5] the validity window runs from the run's own completion, not from when qlander saw it", async () => {
    const w = new DispatchWorld({ dryRunValidMinutes: 30 });
    const a = w.land();
    w.qualified(a);
    await w.ok(); // the dry run is dispatched and, within the next interval, completes
    w.now = new Date(w.now.getTime() + 2 * 24 * 3_600_000); // an outage: the next tick is two days later
    w.approve(a);
    const r = await w.ok();
    expect(r.outcome).toBe("alert");
    expect(w.dispatchHistory().at(-1)).toMatchObject({ sha: a, outcome: "expired" });
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
  });

  test("[6] an approval posted after the intent but before the dry run started does not count", async () => {
    const w = new DispatchWorld();
    w.behave = () => ({ createdLagSeconds: 4 });
    const a = w.land();
    w.qualified(a);
    const intentAt = w.now;
    await w.ok();
    expect(w.candidate()!.dry!.at).toBe(intentAt.toISOString());
    const early = w.approve(a, APPROVER, { at: new Date(intentAt.getTime() + 2000) });
    const r = await w.ok();
    expect(r.outcome).toBe("waiting");
    expect(r.log.some((l) => l.includes(`comment ${early}`) && l.includes("predates"))).toBe(true);
    expect(w.kinds()).toEqual([`dry ${a.slice(0, 8)}`]);
  });
});
