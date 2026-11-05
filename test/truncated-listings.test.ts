// An incomplete listing is never judged as the whole set: the fast lane is
// unknown, batch CI is pending, a cancellation is not done, and a partial
// open-PR list refuses to stand in for the ready PRs.

import { describe, expect, test } from "bun:test";
import { GitHubError } from "../src/github/http";
import { TargetClient } from "../src/github/target";
import { drain } from "../src/outbox";
import { buildSnapshot } from "../src/snapshot";
import { emptyState, type State } from "../src/state";
import { FakeStateRepo, FakeTarget } from "./fake-github";
import { cfg, job, NAMES, pathRe, sha, TARGET, TARGET_OPTS, TARGET_SLUG } from "./sim";
import { World } from "./world";

const NOW = new Date("2026-10-21T12:00:00Z");
const C = cfg();
const snap = (f: FakeTarget, state: State = emptyState()) => buildSnapshot({ api: f, cfg: C, state, now: NOW, paused: false, policyHash: "p1" });

describe("snapshot", () => {
  test("a truncated run list for a PR head makes the fast lane unknown, never green", async () => {
    const f = new FakeTarget();
    const p = f.addPr(1);
    f.addRun({ head_sha: p.pr.head.sha, event: C.fastLane.event, path: C.fastLane.workflowPath, head_branch: p.pr.head.ref }, [job(C.fastLane.job)]);
    expect((await snap(f)).prs["1"]!.fastLane.ok).toBe(true);
    f.runListLimit = 0; // the listing stops before the green run, and says so
    const fast = (await snap(f)).prs["1"]!.fastLane;
    expect(fast).toMatchObject({ ok: false, unknown: true });
    expect(fast.why).toContain("incomplete");
  });

  test("a truncated run list that still shows green fast-lane evidence is not green either", async () => {
    const f = new FakeTarget();
    const p = f.addPr(1);
    const fast = { head_sha: p.pr.head.sha, event: C.fastLane.event, path: C.fastLane.workflowPath, head_branch: p.pr.head.ref };
    f.addRun(fast, [job(C.fastLane.job)]);
    f.addRun(fast, [job(C.fastLane.job, "failure")]); // a newer red run, past the page read
    f.runListLimit = 1;
    expect((await snap(f)).prs["1"]!.fastLane).toMatchObject({ ok: false, unknown: true });
  });

  test("a truncated run list for the active batch is pending, never green", async () => {
    const f = new FakeTarget();
    f.addPr(1);
    const base = f.refs.get("main")!;
    const head = f.commit([base, sha("pr1")], "queue-head");
    f.refs.set("queue/9", head);
    const state: State = {
      ...emptyState(),
      auth: { "1": { head: sha("pr1"), baseRepoId: TARGET, policy: "p1", policyPr: false, admittedAt: "2026-10-21T10:00:00.000Z", labelledAt: "2026-10-21T10:00:00Z", evidence: [], reviewRun: null } },
      active: { n: 9, base, head, depth: 0, prs: [1], lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: "2026-10-21T11:00:00.000Z" },
      lineages: { "1": { runs: 1 } },
    };
    f.addRun({ head_sha: head, head_branch: "queue/9" }, C.preLanding[0]!.required_jobs.map((n) => job(n)));
    f.addRun({ head_sha: head, head_branch: "queue/9" }, C.preLanding[0]!.required_jobs.map((n) => job(n)));
    expect((await snap(f, state)).ci).toEqual({ kind: "green" });
    f.runListLimit = 1;
    expect((await snap(f, state)).ci).toEqual({ kind: "pending", reason: "run list incomplete for queue/9" });
    // Bounded: past the hard cap (queuedHours + inProgressMinutes) it is a configuration problem, never green.
    const late = new Date(Date.parse("2026-10-21T11:00:00.000Z") + (C.queuedHours * 60 + C.inProgressMinutes + 1) * 60_000);
    const ci = (await buildSnapshot({ api: f, cfg: C, state, now: late, paused: false, policyHash: "p1" })).ci;
    expect(ci).toMatchObject({ kind: "config" });
    expect(ci && "reason" in ci ? ci.reason : "").toContain("run list for queue/9 still incomplete");
  });
});

describe("outbox", () => {
  test("a cancellation is not done on a truncated run list: again, then given up", async () => {
    const target = new FakeTarget();
    target.addRun({ head_sha: sha("qh"), head_branch: "queue/9", status: "completed", conclusion: "cancelled" });
    target.addRun({ head_sha: sha("qh"), head_branch: "queue/9", status: "completed", conclusion: "cancelled" });
    const notice = { id: "x:9", kind: "cancelRuns" as const, ref: "queue/9", head: sha("qh"), until: "2026-10-21T11:30:00.000Z", giveUpAt: "2026-10-21T18:00:00.000Z" };
    const run = (now: string) =>
      drain({ ...emptyState(), outbox: [notice] }, { target, repo: new FakeStateRepo(), names: NAMES, now: new Date(now), reconcileMinutes: 30, save: async () => {} });
    expect((await run("2026-10-21T12:00:00Z")).log).toEqual(["done cancelRuns x:9"]);
    target.runListLimit = 1;
    expect((await run("2026-10-21T12:00:00Z")).log).toEqual(["again cancelRuns x:9"]);
    const late = await run("2026-10-21T18:00:00Z");
    expect(late.log).toEqual(["gave up cancelRuns x:9"]);
    expect(late.failure?.reason).toBe("runs on queue/9 are still running, or could not all be seen, after the cancellation window");
  });

  test("a 404 cancelling one run still cancels the others; the notice is done once a read finds that run gone", async () => {
    const target = new FakeTarget();
    const runs = [1, 2, 3].map(() => target.addRun({ head_sha: sha("qh"), head_branch: "queue/9", status: "in_progress", conclusion: null }));
    const gone = runs[0]!.id;
    const cancel = target.cancelRun.bind(target);
    target.cancelRun = async (id: number) => {
      if (id === gone) {
        target.runs = target.runs.filter((r) => r.id !== gone); // deleted between the listing and the cancel
        throw new GitHubError("not_found", 404, "Not Found");
      }
      return cancel(id);
    };
    const notice = { id: "x:9", kind: "cancelRuns" as const, ref: "queue/9", head: sha("qh"), until: "2026-10-21T11:30:00.000Z", giveUpAt: "2026-10-21T18:00:00.000Z" };
    let state = { ...emptyState(), outbox: [notice] as State["outbox"] };
    const run = async () => {
      const r = await drain(state, { target, repo: new FakeStateRepo(), names: NAMES, now: NOW, reconcileMinutes: 30, save: async () => {} });
      state = { ...state, outbox: r.outbox };
      return r;
    };
    const first = await run();
    expect(first.failure).toBeNull();
    expect(first.log).toEqual(["again cancelRuns x:9"]); // kept: every run is confirmed terminal or gone next time
    expect(state.outbox[0]).toMatchObject({ seen: runs.map((r) => r.id) });
    expect(target.calls.filter((c) => c.startsWith("cancel "))).toEqual([`cancel ${runs[1]!.id}`, `cancel ${runs[2]!.id}`]);
    for (const r of runs.slice(1)) expect(target.runs.find((x) => x.id === r.id)).toMatchObject({ status: "completed", conclusion: "cancelled" });
    expect((await run()).log).toEqual(["done cancelRuns x:9"]); // the 404'd run is no longer listed and getRun finds nothing
    expect(state.outbox).toEqual([]);
  });

  test("a run that answers 404 to its cancel but still reads as running is never taken as done: again, then given up", async () => {
    const target = new FakeTarget();
    const stuck = target.addRun({ head_sha: sha("qh"), head_branch: "queue/9", status: "in_progress", conclusion: null });
    const other = target.addRun({ head_sha: sha("qh"), head_branch: "queue/9", status: "in_progress", conclusion: null });
    const cancel = target.cancelRun.bind(target);
    target.cancelRun = async (id: number) => {
      if (id === stuck.id) throw new GitHubError("not_found", 404, "Not Found");
      return cancel(id);
    };
    const notice = { id: "x:9", kind: "cancelRuns" as const, ref: "queue/9", head: sha("qh"), until: "2026-10-21T11:30:00.000Z", giveUpAt: "2026-10-21T18:00:00.000Z" };
    const run = (now: string) => drain({ ...emptyState(), outbox: [notice] }, { target, repo: new FakeStateRepo(), names: NAMES, now: new Date(now), reconcileMinutes: 30, save: async () => {} });
    const first = await run("2026-10-21T12:00:00Z");
    expect(first.log).toEqual(["again cancelRuns x:9"]);
    expect(first.failure).toBeNull();
    expect(target.runs.find((r) => r.id === other.id)).toMatchObject({ status: "completed", conclusion: "cancelled" });
    const late = await run("2026-10-21T18:00:00Z");
    expect(late.log).toEqual(["gave up cancelRuns x:9"]);
    expect(late.failure?.reason).toBe("runs on queue/9 are still running, or could not all be seen, after the cancellation window");
  });
});

describe("the open PR list", () => {
  test("a list that stops at the page limit is refused, not read as complete", async () => {
    const next = { link: `<https://api.github.com/repos/${TARGET_SLUG}/pulls?state=open&page=2>; rel="next"` };
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (pathRe(`/repos/${TARGET_SLUG}`).test(url)) return new Response(JSON.stringify({ id: TARGET, node_id: "R_target" }));
      if (/\/pulls\?/.test(url)) return new Response(JSON.stringify([{ number: 1, labels: [{ name: "ready" }] }]), { headers: next });
      return new Response("{}", { status: 599 });
    }) as typeof globalThis.fetch;
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "read", fetch, sleep: async () => {}, maxPages: 1 });
    const err = await c.listOpenPrNumbersWithLabel("ready").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).kind).toBe("validation");
    expect(String(err)).toContain("the open PR list stopped at 1 pages");
  });

  test("the tick pauses and says why, instead of missing ready PRs silently", async () => {
    const w = new World();
    w.readyPr(1);
    w.target.listOpenPrNumbersWithLabel = async () => {
      throw new GitHubError("validation", null, "the open PR list stopped at 30 pages (3000 PRs), so PRs labelled ready may be missing");
    };
    const r = await w.tick();
    expect(r === "crashed" ? r : r.outcome).toBe("paused");
    expect(w.paused()).toBe(true);
    expect(w.repo.issues.map((i) => i.body).join(" ")).toContain("the open PR list stopped at 30 pages");
    expect(w.target.calls.filter((c) => c.startsWith("createRef"))).toEqual([]);
  });
});
