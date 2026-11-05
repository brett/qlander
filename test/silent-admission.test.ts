// No ready PR is ignored silently (DESIGN.md §4.2): every tick that decides
// gives a verdict, "#N ignored: <reason>", for every PR that is ready (listed
// with the label, or read carrying it) but not admitted when the decision
// ends, carries the same list in its report, and the status issue shows it.
// One test per reason. Reporting only: the decisions themselves are covered
// elsewhere and must not change.

import { describe, expect, test } from "bun:test";
import type { LivePr } from "../src/admission";
import type { Snapshot } from "../src/ctx";
import { decide } from "../src/machine";
import { QUEUE_JOB_NAME } from "../src/main";
import type { TickResult } from "../src/queue";
import { emptyState, type State } from "../src/state";
import { LostLockError } from "../src/store";
import { renderStatus, type StatusInput } from "../src/watchdog-render";
import { BOT_FILE, cfg, cmd, CONTROL_SLUG, HUMAN, ISSUE_LABELS, livePr, NAMES, sha, Sim } from "./sim";
import { NOW, run } from "./watchdog-fake";
import { World } from "./world";

/** decide() over one PR, listed with ready unless `listed` says otherwise; returns the verdict lines and the decision. */
function verdictOf(pr: LivePr | null, o: { n?: number; listed?: boolean; state?: State; extra?: Partial<Snapshot>; sim?: Sim } = {}) {
  const sim = o.sim ?? new Sim(cfg());
  const n = pr?.number ?? o.n ?? 1;
  if (pr) sim.add(pr);
  if (o.state) sim.state = o.state;
  const d = decide(sim.state, sim.snapshot({ readyListed: o.listed === false ? [] : [n], ...o.extra }), sim.config);
  return { d, lines: d.log.filter((l) => l.includes(" ignored: ")) };
}

/** The one verdict for PR n: its log line and its entry in Decision.ignored agree. */
function expectVerdict(r: ReturnType<typeof verdictOf>, n: number, reason: string | RegExp): void {
  const entry = r.d.ignored?.find((v) => v.pr === n);
  expect(entry).toBeDefined();
  if (typeof reason === "string") expect(entry!.reason).toBe(reason);
  else expect(entry!.reason).toMatch(reason);
  expect(r.lines).toContain(`#${n} ignored: ${entry!.reason}`);
  expect(r.lines.filter((l) => l.startsWith(`#${n} ignored: `))).toHaveLength(1);
}

describe("admission's refusals each produce a verdict", () => {
  test("a listed PR read as closed, or merged", () => {
    expectVerdict(verdictOf(livePr(1, { open: false })), 1, "listed with `ready`, but the PR read is closed");
    expectVerdict(verdictOf(livePr(1, { open: false, merged: true })), 1, "listed with `ready`, but the PR read is merged");
  });

  test("a draft", () => {
    expectVerdict(verdictOf(livePr(1, { draft: true })), 1, "draft");
  });

  test("a base that is not main, a fork, a reserved head branch, a head that is not a sha", () => {
    expectVerdict(verdictOf(livePr(1, { baseRef: "other" })), 1, `base is not ${NAMES.target.name} ${NAMES.main}`);
    expectVerdict(verdictOf(livePr(1, { headRepoId: 999 })), 1, `head is not in ${NAMES.target.name} (fork)`);
    expectVerdict(verdictOf(livePr(1, { headRef: `${NAMES.queuePrefix}7` })), 1, `head branch '${NAMES.queuePrefix}7' is reserved`);
    expectVerdict(verdictOf(livePr(1, { head: "not-a-sha" })), 1, "head is not a sha");
  });

  test("listed with ready, but the PR read does not carry it (a lagging listing)", () => {
    expectVerdict(verdictOf(livePr(1, { labels: [] })), 1, "listed with `ready`, but the PR read does not carry the label");
  });

  test("who applied ready is not readable: each reason the snapshot gives", () => {
    for (const why of ["the PR's event history could not be read completely", "no labeled event for it is in the PR's event history", "its latest labeled event has no actor"]) {
      expectVerdict(verdictOf(livePr(1, { ready: null, readyUnreadable: why })), 1, `who applied ready is not readable: ${why}`);
    }
    expectVerdict(verdictOf(livePr(1, { ready: null })), 1, "who applied ready is not readable");
  });

  test("ready applied without write access names the actor and the permission read", () => {
    const r = verdictOf(livePr(1, { ready: { actorLogin: "someone", actorPermission: "read", at: "2026-10-21T10:00:00Z" } }));
    expectVerdict(r, 1, "ready applied without write access; applied by someone at 2026-10-21T10:00:00Z, whose permission read as 'read'");
  });

  test("mergeability not computed yet, a fast lane or review still missing, a CI-policy approval missing", () => {
    expectVerdict(verdictOf(livePr(1, { mergeable: null })), 1, "waits: mergeability not computed yet");
    expectVerdict(verdictOf(livePr(1, { fastLane: { ok: false, why: "no run" } })), 1, "waits: fast lane: no run");
    expectVerdict(verdictOf(livePr(1, { review: { ok: false, why: "no review" } })), 1, "waits: review: no review");
    expectVerdict(verdictOf(livePr(1, { policyPr: true })), 1, "waits: CI-policy change needs a SHA-bound approval");
  });

  test("conflicts with main, unsigned commits: not queued, and ready is being removed", () => {
    expectVerdict(verdictOf(livePr(1, { mergeable: false })), 1, "not queued: conflicts with main; its `ready` label is being removed");
    expectVerdict(verdictOf(livePr(1, { commitsVerified: false })), 1, "not queued: has unsigned commits; its `ready` label is being removed");
  });
});

describe("skips before admission each produce a verdict", () => {
  test("a ready label removal still pending from an earlier tick", () => {
    const state = { ...emptyState(), outbox: [{ id: "u:1:x", kind: "unready" as const, pr: 1 }] };
    expectVerdict(verdictOf(livePr(1), { state }), 1, "its `ready` label is still being removed (a notice from an earlier tick is pending)");
  });

  test("landed at this head, waiting for GitHub to mark it merged", () => {
    const state = { ...emptyState(), verify: [{ pr: 1, pin: livePr(1).head, landedIn: sha("m"), since: "2026-10-21T11:59:00Z", ticks: 0, notified: false }] };
    expectVerdict(verdictOf(livePr(1), { state }), 1, "landed at this head; waiting for GitHub to mark it merged");
  });

  test("an admitted PR dropped this tick (head moved), or bounced by an operator", () => {
    // Admitted, and the build it journalled set aside, so the next tick decides again.
    const admitted = (s: Sim) => ({ ...decide(s.state, s.snapshot({ readyListed: [1] }), s.config).state, journal: null });
    const sim = new Sim(cfg()).add(livePr(1));
    sim.state = admitted(sim);
    expect(sim.state.auth["1"]).toBeDefined();
    const moved = sha("pr1-new");
    sim.prs["1"] = { ...sim.prs["1"]!, head: moved };
    expectVerdict(verdictOf(null, { sim }), 1, `removed from the queue this tick: head moved from ${livePr(1).head} to ${moved}`);

    const sim2 = new Sim(cfg()).add(livePr(1));
    sim2.state = admitted(sim2);
    expectVerdict(verdictOf(null, { sim: sim2, extra: { commands: [cmd("bounce", 1)] } }), 1, "removed from the queue this tick: bounced by an operator");
  });

  test("a paused queue, and one that pauses this tick", () => {
    const sim = new Sim(cfg());
    sim.paused = true;
    expectVerdict(verdictOf(livePr(1), { sim }), 1, "the queue is paused; admission was not evaluated");

    const pausePending = { ...emptyState(), outbox: [{ id: "p:1", kind: "pause" as const, reason: "x" }] };
    expectVerdict(verdictOf(livePr(1), { state: pausePending }), 1, "the queue is paused; admission was not evaluated");

    const pin = sha("landed");
    const state = { ...emptyState(), verify: [{ pr: 2, pin, landedIn: sha("m"), since: "2026-10-21T11:59:00Z", ticks: 0, notified: false }] };
    const r = verdictOf(livePr(1), { state, extra: { prs: { "1": livePr(1), "2": livePr(2, { labels: [], head: pin }) }, pinReachable: { [pin]: false } } });
    expectVerdict(r, 1, "the queue is pausing; admission was not evaluated");
    expect(r.d.ignored!.map((v) => v.pr)).toEqual([1]); // PR 2 is not ready: no verdict
  });

  test("listed with ready, but the PR could not be read (a snapshot miss)", () => {
    expectVerdict(verdictOf(null, { n: 5 }), 5, "listed with `ready`, but the PR could not be read (not found)");
  });
});

describe("what gets no verdict", () => {
  test("an admitted PR, a PR in flight, and a PR that is not ready", () => {
    const sim = new Sim(cfg()).add(livePr(1), livePr(2, { labels: [] }));
    const d = decide(sim.state, sim.snapshot({ readyListed: [1] }), sim.config);
    expect(d.state.auth["1"]).toBeDefined();
    expect(d.ignored).toBeUndefined();
    expect(d.log.some((l) => l.includes(" ignored: "))).toBe(false);
  });

  test("a PR read carrying ready counts even when the listing missed it", () => {
    expectVerdict(verdictOf(livePr(1, { draft: true }), { listed: false }), 1, "draft");
  });

  test("snapshots without the listing (older callers) still report PRs read as ready", () => {
    const sim = new Sim(cfg()).add(livePr(1, { draft: true }));
    const d = decide(sim.state, sim.snapshot(), sim.config);
    expect(d.ignored).toEqual([{ pr: 1, reason: "draft" }]);
  });

  test("the verdicts never change the decision", () => {
    for (const pr of [livePr(1, { mergeable: null }), livePr(1, { policyPr: true }), livePr(1, { mergeable: false }), livePr(1, { ready: null })]) {
      const sim = new Sim(cfg()).add(pr);
      const a = decide(sim.state, sim.snapshot({ readyListed: [1] }), sim.config);
      const b = decide(sim.state, { ...sim.snapshot(), readyListed: undefined } as Snapshot, sim.config);
      expect(a.state).toEqual(b.state);
      expect(a.events ?? []).toEqual(b.events ?? []);
    }
  });
});

describe("end to end through the tick and its report", () => {
  test("the report lists what GitHub listed with ready, and every ready PR not admitted, with why", async () => {
    const w = new World();
    w.readyPr(1);
    w.readyPr(2);
    w.target.prs.get(2)!.eventsTruncated = true; // provenance unreadable
    w.readyPr(3);
    w.target.prs.get(3)!.events.push({ id: 9_999, actor: "outsider", at: "2026-10-21T10:30:00Z" }); // no write access
    w.target.advance(); // the evidence runs are listed
    const r = (await w.tick()) as TickResult;
    expect(r.readyListed).toEqual([1, 2, 3]);
    expect(r.ignored).toEqual([
      { pr: 2, reason: "who applied ready is not readable: the PR's event history could not be read completely" },
      { pr: 3, reason: "ready applied without write access; applied by outsider at 2026-10-21T10:30:00Z, whose permission read as 'none'" },
    ]);
    expect(r.log).toContain("#2 ignored: who applied ready is not readable: the PR's event history could not be read completely");
    expect(w.state().auth["1"]).toBeDefined();
  });

  test("a PR the listing names but the read cannot find is reported, and the rest of the tick goes on", async () => {
    const w = new World();
    w.readyPr(1);
    const list = w.target.listOpenPrNumbersWithLabel.bind(w.target);
    w.target.listOpenPrNumbersWithLabel = async (label: string) => [...(await list(label)), ...(label === NAMES.labels.ready ? [77] : [])];
    w.target.advance();
    const r = (await w.tick()) as TickResult;
    expect(r.readyListed).toEqual([1, 77]);
    expect(r.ignored).toEqual([{ pr: 77, reason: "listed with `ready`, but the PR could not be read (not found)" }]);
    expect(w.state().auth["1"]).toBeDefined();
  });

  test("a ready PR the listing missed, seen while reading an operator command, is reported", async () => {
    const w = new World();
    w.readyPr(2);
    w.command("solo", 2);
    const list = w.target.listOpenPrNumbersWithLabel.bind(w.target);
    w.target.listOpenPrNumbersWithLabel = async (label: string) => (label === NAMES.labels.ready ? [] : list(label));
    w.target.advance();
    const r = (await w.tick()) as TickResult;
    expect(r.readyListed).toEqual([]);
    expect(r.ignored).toEqual([{ pr: 2, reason: "read carrying `ready`, but GitHub's ready listing missed it, so it was not evaluated this tick" }]);
  });

  test("a tick that loses its lease after deciding still reports its verdicts", async () => {
    const w = new World();
    w.readyPr(1).pr.draft = true;
    w.target.advance();
    const r = (await w.tick({
      crashWhen: (p) => {
        if (p === "after-intent") throw new LostLockError("lost after deciding");
        return false;
      },
    })) as TickResult;
    expect(r.outcome).toBe("lost-lock");
    expect(r.readyListed).toEqual([1]);
    expect(r.ignored).toEqual([{ pr: 1, reason: "draft" }]);
  });

  test("an empty listing is in the report, so a listing that misses a ready PR shows", async () => {
    const w = new World();
    const r = (await w.tick()) as TickResult;
    expect(r.readyListed).toEqual([]);
    expect(r.ignored).toBeUndefined();
    expect(r.log).toContain("idle: nothing to land");
  });

  test("a CI-policy PR waiting for its approval is reported every tick", async () => {
    const w = new World();
    w.readyPr(1, { files: [BOT_FILE] });
    w.target.advance();
    for (let i = 0; i < 2; i++) {
      const r = (await w.tick()) as TickResult;
      expect(r.ignored).toEqual([{ pr: 1, reason: "waits: CI-policy change needs a SHA-bound approval" }]);
    }
  });

  test("a tick recovering a journalled op says admission was not evaluated", async () => {
    const w = new World();
    w.readyPr(1);
    w.target.advance();
    expect(await w.tick({ crash: "after-checkpoint" })).toBe("crashed");
    w.now = new Date(w.now.getTime() + 60 * 60_000); // the crashed lease expires
    const r = (await w.tick()) as TickResult;
    expect(r.log).toContain("admission not evaluated this tick: a journalled build is outstanding");
    expect(r.readyListed).toBeUndefined();
  });
});

describe("the status issue", () => {
  const base = (report: Record<string, unknown>): StatusInput => {
    const r = run({ createdAt: "2026-10-22T11:50:00Z" }, { completedAt: "2026-10-22T11:51:00Z" });
    return {
      now: NOW,
      runUrl: `https://github.com/${CONTROL_SLUG}/actions/runs/1`,
      modeVar: "live",
      releaseHeldByConfig: true,
      evaluation: { alerts: [], warnings: [], unknown: [], notes: [] },
      runs: [r],
      newest: { run: r, reports: [{ job: QUEUE_JOB_NAME, report }] },
      labels: ISSUE_LABELS,
      queueMirror: null,
      releaseMirror: null,
      openIssues: [],
    };
  };

  test("shows the listing and every verdict ahead of the log, even when the log is cut", () => {
    const log = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const b = renderStatus(
      base({
        outcome: "idle",
        log,
        readyListed: [4, 9],
        ignored: [
          { pr: 4, reason: "who applied ready is not readable: no labeled event for it is in the PR's event history" },
          { pr: 9, reason: "waits: mergeability not computed yet" },
        ],
      }),
    );
    expect(b).toContain("- listed with ready: PR 4, PR 9");
    expect(b).toContain("- ready but not admitted: PR 4: who applied ready is not readable: no labeled event for it is in the PR's event history");
    expect(b).toContain("- ready but not admitted: PR 9: waits: mergeability not computed yet");
    expect(b.indexOf("ready but not admitted")).toBeLessThan(b.indexOf("line 0"));
    expect(b).toContain("... 18 more lines in the job log");
  });

  test("an empty listing says none; an older report without the fields shows neither; hostile text is escaped", () => {
    expect(renderStatus(base({ outcome: "idle", log: [], readyListed: [] }))).toContain("- listed with ready: none");
    const old = renderStatus(base({ outcome: "idle", log: ["idle: nothing to land"] }));
    expect(old).not.toContain("listed with ready");
    expect(old).not.toContain("ready but not admitted");
    const hostile = renderStatus(base({ outcome: "idle", log: [], ignored: [{ pr: 3, reason: `@${HUMAN} <img src=x> [x](https://evil)` }], readyListed: "nope" }));
    expect(hostile).toContain("- listed with ready: ?");
    expect(hostile).not.toMatch(/@[A-Za-z0-9]/);
    expect(hostile).not.toContain("<img");
    expect(hostile).not.toContain("](https://evil)");
  });

  test("at most 20 verdicts are listed; the rest are counted", () => {
    const ignored = Array.from({ length: 23 }, (_, i) => ({ pr: i + 1, reason: "draft" }));
    const b = renderStatus(base({ outcome: "idle", log: [], ignored }));
    expect(b.match(/^- ready but not admitted: /gm)).toHaveLength(20);
    expect(b).toContain("- ... 3 more in the job log");
  });
});
