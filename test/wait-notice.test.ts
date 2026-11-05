// A ready PR is never held silently (DESIGN.md §4.2): one that waits
// WAIT_NOTICE_MINUTES for a CI-policy approval, or for GitHub's mergeability,
// gets one comment per head saying why and what to do. And operatorSolo
// (DESIGN.md §10) holds only PRs still in the queue.

import { describe, expect, test } from "bun:test";
import { decide, WAIT_NOTICE_MINUTES } from "../src/machine";
import { GitHubError } from "../src/github/http";
import { drain } from "../src/outbox";
import { emptyState, type State } from "../src/state";
import { buildSnapshot } from "../src/snapshot";
import { FakeStateRepo, FakeTarget } from "./fake-github";
import { APPROVERS, BOT_FILE, cfg, cmd, livePr, NAMES, sha, Sim } from "./sim";
import { World } from "./world";

const MIN = 60_000;
const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * MIN).toISOString().replace(".000", "");
const policyPr = (n: number, readyAt: string) => livePr(n, { policyPr: true, ready: { actorLogin: APPROVERS[0]!.login, actorPermission: "admin", at: readyAt } });
const waitComments = (sim: Sim, n: number) => sim.state.outbox.filter((o) => o.kind === "comment" && o.pr === n && o.id.includes(":wait:"));

describe("a CI-policy PR waiting for its approval", () => {
  test("is told nothing while young, then once what to post, naming the head and the approvers", () => {
    const sim = new Sim(cfg());
    sim.add(policyPr(1, minutesAgo(sim.now, WAIT_NOTICE_MINUTES - 1)));
    let d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.log).toContain("#1 waits: CI-policy change needs a SHA-bound approval");
    expect(d.state.outbox.filter((o) => o.kind === "comment")).toEqual([]);

    sim.now = new Date(sim.now.getTime() + MIN);
    d = decide(sim.state, sim.snapshot(), sim.config);
    const notes = d.state.outbox.filter((o) => o.kind === "comment");
    expect(notes).toHaveLength(1);
    const n = notes[0]!;
    if (n.kind !== "comment") throw new Error("not a comment");
    expect(n.id).toBe(`c:1:wait:approval:${livePr(1).head}`);
    expect(n.body).toContain(`/qlander approve-policy ${livePr(1).head}`);
    for (const h of APPROVERS) expect(n.body).toContain(`\`${h.login}\``);
    expect(n.body).toContain("CI-policy change needs a SHA-bound approval");
  });

  test("an approved one is admitted and never told", () => {
    const sim = new Sim(cfg());
    sim.add({ ...policyPr(1, minutesAgo(sim.now, 600)), policyApproval: true });
    const d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.state.auth["1"]).toBeDefined();
    expect(d.state.outbox.filter((o) => o.kind === "comment" && o.id.includes(":wait:"))).toEqual([]);
  });

  test("end to end: one comment however many ticks it waits, and a new one for a new head", async () => {
    const w = new World();
    w.commentSettings = { omit: ["queued", "landed"] }; // never omittable: it asks someone to act
    w.readyPr(1, { files: [BOT_FILE] });
    for (let i = 0; i < 6; i++) await w.tick();
    const told = w.comments(1).filter((b) => b.includes("approve-policy"));
    expect(told).toHaveLength(1);
    const head = w.target.prs.get(1)!.pr.head.sha;
    expect(told[0]).toContain(`/qlander approve-policy ${head}`);
    expect(w.state().auth["1"]).toBeUndefined();

    const next = w.target.push(1, { files: [BOT_FILE] });
    w.evidence(1);
    for (let i = 0; i < 6; i++) await w.tick();
    const again = w.comments(1).filter((b) => b.includes("approve-policy"));
    expect(again).toHaveLength(2);
    expect(again[1]).toContain(`/qlander approve-policy ${next}`);
  });
});

describe("a ready PR whose mergeability GitHub never computes", () => {
  test("is told once it has been held WAIT_NOTICE_MINUTES at this head, measured from the hold", () => {
    const sim = new Sim(cfg());
    sim.add(livePr(1, { mergeable: null }));
    const start = sim.now.getTime();
    const told: number[] = [];
    for (let m = 0; m <= WAIT_NOTICE_MINUTES + 10; m += 5) {
      sim.now = new Date(start + m * MIN);
      const d = decide(sim.state, sim.snapshot(), sim.config);
      sim.state = { ...d.state, outbox: [] };
      if (d.state.outbox.some((o) => o.kind === "comment" && o.id === `c:1:wait:merge:${livePr(1).head}`)) told.push(m);
    }
    expect(told[0]).toBe(WAIT_NOTICE_MINUTES); // never before; re-raised after, and deduplicated by the outbox marker
    expect(sim.state.held?.["1"]?.since).toBe(new Date(start).toISOString());
  });

  test("end to end: an admitted PR held past the hold limit is dropped, then told once", async () => {
    const w = new World();
    w.readyPr(1);
    w.target.prs.get(1)!.pr.mergeable = null;
    for (let i = 0; i < 8; i++) await w.tick();
    const told = w.comments(1).filter((b) => b.includes("has not reported whether this PR merges cleanly"));
    expect(told).toHaveLength(1);
    expect(w.landed()).toEqual([]);
    w.target.prs.get(1)!.pr.mergeable = true;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });
});

describe("operatorSolo holds only PRs still in the queue", () => {
  function soloOn(...prs: number[]): Sim {
    const sim = new Sim(cfg());
    for (const n of prs) sim.add(livePr(n));
    const d = decide(sim.state, sim.snapshot({ commands: prs.map((n) => cmd("solo", n)) }), sim.config);
    sim.state = { ...d.state, outbox: [], journal: null, active: null };
    expect(sim.state.operatorSolo).toEqual(prs);
    return sim;
  }

  test("decide clears exactly the marks the snapshot reports as left, even while paused", () => {
    const sim = soloOn(1, 2, 3, 4);
    const soloLeft = { "1": "merged", "2": "closed", "3": "not labelled ready" };
    const d = decide(sim.state, sim.snapshot({ soloLeft }), sim.config);
    expect(d.state.operatorSolo).toEqual([4]);
    expect(d.log).toContain("operator solo on #1 cleared: merged");
    expect(d.log).toContain("operator solo on #2 cleared: closed");
    expect(d.log).toContain("operator solo on #3 cleared: not labelled ready");
    sim.paused = true;
    expect(decide(sim.state, sim.snapshot({ soloLeft }), sim.config).state.operatorSolo).toEqual([4]);
    expect(decide(sim.state, sim.snapshot(), sim.config).state.operatorSolo).toEqual([1, 2, 3, 4]);
  });

  async function left(f: FakeTarget, operatorSolo: number[]) {
    const state: State = { ...emptyState(), operatorSolo };
    return (await buildSnapshot({ api: f, cfg: cfg(), state, now: new Date("2026-10-21T12:00:00Z"), paused: false, policyHash: "p" })).soloLeft;
  }

  test("the snapshot reads every operatorSolo PR: merged, closed and unready ones have left; ready ones have not", async () => {
    const f = new FakeTarget("queue", NAMES);
    f.addPr(1, { state: "closed", merged: true });
    f.addPr(2, { state: "closed" });
    f.addPr(3, { labels: [] });
    f.addPr(4);
    expect(await left(f, [1, 2, 3, 4])).toEqual({ "1": "merged", "2": "closed", "3": "not labelled ready" });
    expect(await left(f, [4])).toBeUndefined();
  });

  test("one lagging read never clears a mark, and an unreadable PR keeps it without failing the snapshot", async () => {
    const f = new FakeTarget("queue", NAMES);
    f.addPr(1);
    f.addPr(2, { labels: [] });
    const get = f.getPr.bind(f);
    let reads = 0;
    f.getPr = async (n) => {
      const p = structuredClone(await get(n));
      if (n === 1 && ++reads === 1) p.labels = []; // a stale first read
      if (n === 2) throw new GitHubError("auth", 403, "forbidden");
      return p;
    };
    expect(await left(f, [1, 2])).toBeUndefined();
  });

  test("a solo PR that is not otherwise read moving its head never discards the snapshot", async () => {
    const f = new FakeTarget("queue", NAMES);
    f.addPr(1, { labels: [] });
    const get = f.getPr.bind(f);
    let reads = 0;
    f.getPr = async (n) => {
      const p = structuredClone(await get(n));
      if (n === 1 && ++reads === 2) p.head.sha = sha("moved");
      return p;
    };
    expect(await left(f, [1])).toEqual({ "1": "not labelled ready" });
  });

  test("end to end: a solo PR that lands is cleared", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    w.command("solo", 1);
    await w.runUntilIdle();
    expect(w.landed().flat().sort()).toEqual([1, 2]);
    expect(w.state().operatorSolo).toEqual([]);
  });
});

describe("a wait comment is best effort", () => {
  test("a comment GitHub refuses is dropped without pausing the queue or holding up landing", async () => {
    const w = new World();
    w.readyPr(1, { files: [BOT_FILE] });
    w.readyPr(2);
    const post = w.target.comment.bind(w.target);
    w.target.comment = async (n, body) => {
      if (body.includes("approve-policy")) throw new GitHubError("auth", 403, "forbidden");
      return post(n, body);
    };
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[2]]);
  });

  test("a transient failure leaves it for the next tick and does not defer the notices behind it", async () => {
    const C = cfg();
    const f = new FakeTarget("queue", C.names);
    f.addPr(1);
    f.addPr(2);
    f.comment = async () => {
      throw new GitHubError("server", 502, "Bad Gateway");
    };
    const state: State = {
      ...emptyState(),
      outbox: [
        { id: "c:1:wait:approval:x", kind: "comment", pr: 1, body: "b" },
        { id: "u:2:t", kind: "unready", pr: 2 },
      ],
    };
    const out = await drain(state, { target: f, repo: new FakeStateRepo(), names: C.names, now: new Date(), reconcileMinutes: 10, save: async () => {} });
    expect(out.failure).toBeNull();
    expect(out.outbox.map((n) => n.id)).toEqual(["c:1:wait:approval:x"]);
    expect(f.prs.get(2)!.pr.labels).not.toContain("ready");
  });
});
