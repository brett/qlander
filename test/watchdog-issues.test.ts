// Exactly one status issue, and one alert issue per kind, however the issue
// listing misbehaves (an empty listing taken for "none" would create another). No network.

import { describe, expect, test } from "bun:test";
import { WatchdogClient } from "../src/github/watchdog-client";
import { runWatchdog } from "../src/watchdog";
import { alertBody, planStatus, type PinnedIssue } from "../src/watchdog-core";
import { ago, FakeRepo, issue, NOW, run } from "./watchdog-fake";
import { watchdogLabelSets } from "../src/watchdog";
import { ISSUE_LABELS, NAMES, CONTROL_SLUG, LS } from "./sim";

const at = (min: number) => ({ now: new Date(NOW.getTime() + min * 60_000), runUrl: `https://github.com/${CONTROL_SLUG}/actions/runs/1`, modeVar: undefined });
const STATUS = "qlander-status";
const ALERT = "qlander-alert";
const openWith = (gh: FakeRepo, label: string) => gh.issues.filter((i) => i.open && i.labels.includes(label));
const healthy = () => {
  const gh = new FakeRepo();
  gh.runs = [run({}, { completedAt: ago(5) })];
  return gh;
};
const stoppedBody = alertBody({ kind: "ticks-stopped", key: "1", detail: "d" }, NOW);
const pinnedView = (i: ReturnType<typeof issue>, open = true, labels = [STATUS]): PinnedIssue => ({ ...i, open, labels });

describe("planStatus (pure)", () => {
  const a = issue(1, "qlander status", 90);
  const b = issue(2, "qlander status", 60);
  const c = issue(3, "qlander status", 30);

  test("keeps the pinned one, else the oldest; closes the rest", () => {
    expect(planStatus({ issues: [c, a, b], complete: true }, [], NAMES.watchdogLabels)).toMatchObject({ keep: a, create: false, close: [b, c] });
    expect(planStatus({ issues: [a, b, c], complete: true }, [pinnedView(b)], NAMES.watchdogLabels)).toMatchObject({ keep: b, close: [a, c] });
  });

  test("an open pinned status issue the listing missed is still found: no create", () => {
    expect(planStatus({ issues: [], complete: true }, [pinnedView(a)], NAMES.watchdogLabels)).toMatchObject({ keep: { number: 1 }, create: false, close: [] });
  });

  test("creates only when nothing is found and the listing was complete", () => {
    expect(planStatus({ issues: [], complete: true }, [], NAMES.watchdogLabels)).toMatchObject({ keep: null, create: true });
    expect(planStatus({ issues: [], complete: false }, [], NAMES.watchdogLabels)).toMatchObject({ keep: null, create: false });
  });

  test("unpins closed status and alert issues, and extras being closed; leaves other pins alone", () => {
    const p = planStatus({ issues: [a, c], complete: true }, [pinnedView(a), pinnedView(c), pinnedView(b, false), pinnedView(issue(9, "x", 1), false, [ALERT]), pinnedView(issue(8, "roadmap", 1), false, ["docs"])], NAMES.watchdogLabels);
    expect(p.unpin.sort()).toEqual(["I_2", "I_3", "I_9"]);
  });
});

describe("whole runs: the status issue", () => {
  test("an eventually consistent listing that misses the pinned status issue does not create a second one", async () => {
    const gh = healthy();
    await runWatchdog(gh, at(0));
    expect(openWith(gh, STATUS).map((i) => i.number)).toEqual([1]);
    for (let m = 15; m <= 105; m += 15) {
      gh.misses.set(STATUS, 2); // both reads this run come back empty
      await runWatchdog(gh, at(m));
    }
    expect(gh.issues.filter((i) => i.labels.includes(STATUS)).map((i) => i.number)).toEqual([1]);
    expect(gh.writes.filter((w) => w.startsWith("create") && w.endsWith("qlander status"))).toEqual(["create #1 qlander status"]);
  });

  test("an unpinned status issue missed by one read is found by the second: no create", async () => {
    const gh = healthy();
    gh.pinAllowed = false;
    await runWatchdog(gh, at(0));
    gh.misses.set(STATUS, 1);
    await runWatchdog(gh, at(15));
    expect(gh.issues.filter((i) => i.labels.includes(STATUS))).toHaveLength(1);
  });

  test("extras are closed with a comment, and closed duplicates give back their pin slots", async () => {
    const gh = healthy();
    const oldest = gh.seed("qlander status", [STATUS], 300);
    const pinned = gh.seed("qlander status", [STATUS], 200);
    pinned.pinned = true;
    const extra = gh.seed("qlander status", [STATUS], 100);
    extra.pinned = true;
    const closedPinned = gh.seed("qlander status", [STATUS], 400);
    closedPinned.open = false;
    closedPinned.pinned = true;
    const r = await runWatchdog(gh, at(0));
    expect(r.statusIssue).toBe(pinned.number);
    expect(openWith(gh, STATUS).map((i) => i.number)).toEqual([pinned.number]);
    expect(oldest.comments).toEqual([`Duplicate of #${pinned.number}: the watchdog keeps one status issue.`]);
    expect(extra.open).toBe(false);
    expect([extra.pinned, closedPinned.pinned, pinned.pinned]).toEqual([false, false, true]);
    expect(gh.writes.filter((w) => w.startsWith("create"))).toEqual([]);
  });

  test("a failed listing creates nothing and fails the run", async () => {
    const gh = healthy();
    gh.failing.add(STATUS);
    await expect(runWatchdog(gh, at(0))).rejects.toThrow("listing failed");
    gh.failing.clear();
    gh.pinnedFails = true;
    await expect(runWatchdog(gh, at(0))).rejects.toThrow("pinned failed");
    expect(gh.issues).toEqual([]);
  });

  test("an incomplete listing that finds nothing creates nothing", async () => {
    const gh = healthy();
    gh.incomplete.add(STATUS);
    const r = await runWatchdog(gh, at(0));
    expect(r.statusIssue).toBeNull();
    expect(r.notes.join(" ")).toContain("none was created");
    expect(gh.issues).toEqual([]);
  });
});

describe("whole runs: alert issues take the same path", () => {
  const stopped = () => {
    const gh = new FakeRepo();
    gh.runs = [run({}, { completedAt: ago(45) })];
    return gh;
  };

  test("a listing that misses the open alert once does not open a second one", async () => {
    const gh = stopped();
    const a = gh.seed("qlander alert: ticks stopped", [ALERT], 60, stoppedBody);
    gh.misses.set(ALERT, 1);
    await runWatchdog(gh, at(0));
    expect(openWith(gh, ALERT).map((i) => i.number)).toEqual([a.number]);
  });

  test("an incomplete alert listing opens nothing and closes nothing it cannot see", async () => {
    const gh = stopped();
    gh.incomplete.add(ALERT);
    const r = await runWatchdog(gh, at(0));
    expect(openWith(gh, ALERT)).toEqual([]);
    expect(r.notes.join(" ")).toContain("none was opened");
  });

  test("a failed alert listing writes nothing", async () => {
    const gh = stopped();
    gh.failing.add(ALERT);
    await expect(runWatchdog(gh, at(0))).rejects.toThrow();
    expect(gh.writes).toEqual([]);
  });

  test("duplicate alert issues of one kind are closed down to one", async () => {
    const gh = stopped();
    const first = gh.seed("qlander alert: ticks stopped", [ALERT], 60, stoppedBody);
    const second = gh.seed("qlander alert: ticks stopped", [ALERT], 30, stoppedBody);
    await runWatchdog(gh, at(0));
    expect([first.open, second.open]).toEqual([true, false]);
  });

  test("an incomplete pause listing keeps the paused alert instead of clearing it", async () => {
    const gh = healthy();
    const a = gh.seed("qlander alert: paused", [ALERT], 60, alertBody({ kind: "paused", key: "9", detail: "d" }, NOW));
    gh.incomplete.add("pause");
    await runWatchdog(gh, at(0));
    expect(a.open).toBe(true);
  });
});

describe("the client lists issues through GraphQL, never the REST issues list", () => {
  function gqlFetch(pages: { totalCount: number; numbers: number[]; next: boolean }[], seen: string[]): typeof fetch {
    let page = 0;
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      seen.push(`${init?.method ?? "GET"} ${u.pathname}`);
      if (u.pathname === `/repos/${CONTROL_SLUG}`) return Response.json({ id: LS });
      if (u.pathname === "/graphql") {
        const p = pages[page++]!;
        const nodes = p.numbers.map((n) => ({ number: n, id: `I_${n}`, title: "qlander status", body: null, url: `https://github.com/${CONTROL_SLUG}/issues/${n}`, createdAt: ago(n) }));
        return Response.json({ data: { repository: { issues: { totalCount: p.totalCount, pageInfo: { hasNextPage: p.next, endCursor: p.next ? `c${page}` : null }, nodes } } } });
      }
      return Response.json({ message: "Not Found" }, { status: 404 });
    }) as unknown as typeof fetch;
  }
  const connect = (f: typeof fetch) => WatchdogClient.connect({ ...watchdogLabelSets(ISSUE_LABELS), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: f });

  test("all pages, oldest first, complete when every counted issue was read", async () => {
    const seen: string[] = [];
    const c = await connect(gqlFetch([{ totalCount: 3, numbers: [12, 13], next: true }, { totalCount: 3, numbers: [16], next: false }], seen));
    const r = await c.listOpenIssues(STATUS);
    expect(r).toMatchObject({ complete: true, issues: [{ number: 12 }, { number: 13 }, { number: 16 }] });
    expect(seen.filter((s) => s.includes("/issues"))).toEqual([]);
  });

  test("fewer issues than totalCount is incomplete", async () => {
    const c = await connect(gqlFetch([{ totalCount: 2, numbers: [12], next: false }], []));
    expect((await c.listOpenIssues(STATUS)).complete).toBe(false);
  });
});

describe("on the shared listing (src/github/issues.ts): nothing opens or closes on a guess", () => {
  test("an incomplete alert listing neither closes a cleared alert nor comments on a changed one", async () => {
    const gh = healthy(); // ticks are fine, so a ticks-stopped alert would normally be closed
    const a = gh.seed("qlander alert: ticks stopped", [ALERT], 60, stoppedBody);
    gh.incomplete.add(ALERT);
    const r = await runWatchdog(gh, at(0));
    expect(a.open).toBe(true);
    expect(a.comments).toEqual([]);
    expect(r.actions).toEqual([]);
    expect(r.notes.join(" ")).toContain("none was opened, changed or closed");
    gh.incomplete.clear();
    await runWatchdog(gh, at(15));
    expect(a.open).toBe(false); // a complete listing clears it as before
  });

  test("an incomplete status listing rewrites the one it found but closes no extras", async () => {
    const gh = healthy();
    const first = gh.seed("qlander status", [STATUS], 300);
    const second = gh.seed("qlander status", [STATUS], 100);
    gh.incomplete.add(STATUS); // the fake returns only the first
    second.pinned = true; // the pinned read still sees the second
    const r = await runWatchdog(gh, at(0));
    expect(r.statusIssue).toBe(second.number);
    expect([first.open, second.open]).toEqual([true, true]);
    gh.incomplete.clear();
    await runWatchdog(gh, at(15));
    expect([first.open, second.open]).toEqual([false, true]);
  });

  test("a status issue is created only after two complete listings both find none", async () => {
    const gh = healthy();
    let calls = 0;
    const list = gh.listOpenIssues.bind(gh);
    gh.listOpenIssues = async (label) => {
      if (label === STATUS) calls++;
      return list(label);
    };
    await runWatchdog(gh, at(0));
    expect(calls).toBe(2);
    expect(openWith(gh, STATUS)).toHaveLength(1);
  });

  test("the client's listing is the shared one: a total that changes mid-scan is not complete", async () => {
    const pages = [
      { total: 3, numbers: [12, 13], next: true },
      { total: 2, numbers: [], next: false },
      { total: 2, numbers: [12, 16], next: false },
    ];
    let i = 0;
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname === `/repos/${CONTROL_SLUG}`) return Response.json({ id: LS });
      const p = pages[i++]!;
      const nodes = p.numbers.map((n) => ({ number: n, id: `I_${n}`, title: "qlander status", body: null, url: `https://github.com/${CONTROL_SLUG}/issues/${n}`, createdAt: ago(n) }));
      return Response.json({ data: { repository: { issues: { totalCount: p.total, pageInfo: { hasNextPage: p.next, endCursor: p.next ? "c" : null }, nodes } } } });
    }) as unknown as typeof fetch;
    const c = await WatchdogClient.connect({ ...watchdogLabelSets(ISSUE_LABELS), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: f });
    expect(await c.listOpenIssues(STATUS)).toMatchObject({ complete: true, issues: [{ number: 12 }, { number: 16 }] }); // restarted after the total moved
    expect(i).toBe(3);
  });
});

describe("notify.assignees", () => {
  test("an alert is assigned; the status issue is not", async () => {
    const bodies: { assignees?: string[] }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ number: 9, node_id: "I", title: "t", body: "b", html_url: "https://example.test/9", created_at: NOW.toISOString() }), { status: 201 });
      }
      return new Response(JSON.stringify({ id: LS }), { status: 200 });
    }) as typeof fetch;
    const c = await WatchdogClient.connect({ ...watchdogLabelSets(ISSUE_LABELS), assign: { labels: [ALERT], logins: ["alice"] }, token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: f });
    await c.createIssue("qlander alert: paused", "b", [ALERT]);
    await c.createIssue("qlander status", "b", [STATUS]);
    expect(bodies.map((b) => b.assignees)).toEqual([["alice"], undefined]);
  });
});
