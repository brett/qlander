// The queue's and release job's issue reads (src/github/issues.ts): the REST issues
// list has been seen to return an empty page
// while issues were open. Pause detection must never read "empty" as
// "unpaused", and nothing may open a duplicate pause or mirror issue on a
// short read. Every lookup is GraphQL, all pages, completeness-checked; an
// incomplete or failed pause listing means paused.

import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { listOpenIssuesByLabel } from "../src/github/issues";
import { GitHubError, Http } from "../src/github/http";
import { StateRepoClient } from "../src/github/state-repo";
import { runDry } from "../src/main";
import { marker, openPause, pauseReason } from "../src/outbox";
import { releaseDryRun } from "../src/release-runner";
import { FakeTarget, FakeStateRef, FakeStateRepo } from "./fake-github";
import { ReleaseWorld } from "./release-world";
import { World } from "./world";
import { stateRepoLabels } from "../src/main";
import { NAMES, CONTROL_SLUG } from "./sim";

const ACTS = /^(createRef|deleteRef|updateRef|merge|rerun|cancel)/;
const acted = (calls: string[]) => calls.filter((c) => ACTS.test(c));

describe("the queue fails closed on its pause read", () => {
  const ready = () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    return w;
  };

  test("control: with a complete, empty pause listing the queue builds", async () => {
    const w = ready();
    for (let i = 0; i < 3; i++) await w.tick();
    expect(acted(w.target.calls).length).toBeGreaterThan(0);
  });

  test("an incomplete pause listing is paused: nothing built, merged or landed", async () => {
    const w = ready();
    w.repo.incomplete.add("pause");
    for (let i = 0; i < 3; i++) expect(await w.tick()).toMatchObject({ outcome: "paused" });
    expect(acted(w.target.calls)).toEqual([]);
    expect(w.repo.issues.filter((i) => i.labels.includes("pause"))).toEqual([]); // paused by the read, not a new issue
  });

  test("a failed pause listing is paused, not retried as unpaused", async () => {
    const w = ready();
    w.repo.failing.add("pause");
    const r = await w.tick();
    expect(r).toMatchObject({ outcome: "paused" });
    expect(r === "crashed" ? [] : r.log.join("\n")).toContain("could not be read");
    expect(acted(w.target.calls)).toEqual([]);
  });

  test("the dry run reads the pause the same way: incomplete means it would do nothing", async () => {
    const target = new FakeTarget("read");
    const w = new World();
    w.target = target as never;
    w.readyPr(1);
    w.target.advance();
    const repo = new FakeStateRepo();
    repo.incomplete.add("pause");
    const r = await runDry({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: defaultConfig.names.control.id } }, async () => ({ target, repo, stateRef: new FakeStateRef() }));
    expect(r.wouldDo).toBeNull();
  });

  test("pauseReason: open issue, incomplete, failed, and clear", async () => {
    const repo = new FakeStateRepo();
    expect(await pauseReason(repo, "pause")).toBeNull();
    repo.incomplete.add("pause");
    expect(await pauseReason(repo, "pause")).toContain("could not all be listed");
    repo.incomplete.clear();
    repo.failing.add("pause");
    expect(await pauseReason(repo, "pause")).toContain("could not be read");
    repo.failing.clear();
    await repo.createIssue("hold", "operator", ["pause"]);
    expect(await pauseReason(repo, "pause")).toBe("an open pause issue (#1)");
  });
});

describe("the release job fails closed on its release-pause read", () => {
  test("an incomplete release-pause listing is paused: no discovery, no write", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    w.repo.incomplete.add("release-pause");
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.target.calls.some((c) => c.startsWith("compare"))).toBe(false);
    expect(w.releaseWrites()).toEqual([]);
    w.repo.incomplete.clear();
    expect((await w.ok()).outcome).toBe("advanced");
  });

  test("a failed release-pause listing is paused", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    w.repo.failing.add("release-pause");
    expect((await w.ok()).outcome).toBe("paused");
    expect(w.releaseWrites()).toEqual([]);
  });

  test("the release dry run is paused on an incomplete listing too", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    w.repo.incomplete.add("release-pause");
    const r = await releaseDryRun({ target: w.target, repo: w.repo, stateRef: w.stateRef, cfg: { ...w.cfg, dryRun: true } });
    expect(r.decision).toBeNull();
    expect(r.log[0]).toContain("paused");
  });
});

describe("no duplicate pause or mirror issues", () => {
  test("a pause issue missed by one read is not opened twice", async () => {
    const repo = new FakeStateRepo();
    await openPause(repo, NAMES, "halt:x", "boom");
    repo.misses.set("pause", 1);
    await openPause(repo, NAMES, "halt:x", "boom");
    expect(repo.issues.filter((i) => i.body.includes(marker("halt:x")))).toHaveLength(1);
  });

  test("an incomplete pause listing opens nothing and throws transient, so the notice stays pending (still paused)", async () => {
    const repo = new FakeStateRepo();
    repo.incomplete.add("pause");
    await expect(openPause(repo, NAMES, "halt:y", "boom")).rejects.toMatchObject({ kind: "server" });
    expect(repo.issues).toEqual([]);
  });

  test("the queue's mirror issue is never duplicated by a short read; an incomplete listing creates none", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick();
    const mirrors = () => w.repo.issues.filter((i) => i.open && i.labels.includes("qlander-state"));
    expect(mirrors()).toHaveLength(1);
    w.repo.misses.set("qlander-state", 1);
    await w.tick();
    expect(mirrors()).toHaveLength(1);
    // With the mirror gone and the listing incomplete, nothing is created: the mirror waits.
    for (const m of mirrors()) m.open = false;
    w.repo.incomplete.add("qlander-state");
    const r = await w.tick();
    expect(mirrors()).toEqual([]);
    expect(r === "crashed" ? "" : r.log.join("\n")).toContain("mirror not updated");
  });

  test("the release mirror is never duplicated by a short read", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    await w.ok();
    expect(w.issues("qlander-release-state")).toHaveLength(1);
    w.repo.misses.set("qlander-release-state", 1);
    w.qualified(w.land());
    await w.ok();
    expect(w.issues("qlander-release-state")).toHaveLength(1);
  });

  test("a missing state branch with an incomplete state-issue listing refuses to initialise", async () => {
    const w = new World();
    w.repo.incomplete.add("qlander-state");
    expect(await w.tick()).toMatchObject({ outcome: "paused" });
    expect(w.stateRef.current).toBeNull();
  });
});

/** Realistic API payloads through a fake fetch: the REST issues list is flaky (empty), GraphQL is not. */
function apiFetch(seen: string[], gql: { totalCount: number; numbers: number[] }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    seen.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (u.pathname === `/repos/${CONTROL_SLUG}`) return Response.json({ id: defaultConfig.names.control.id });
    if (u.pathname.endsWith("/issues")) return Response.json([]); // the flaky REST page
    if (u.pathname === "/graphql") {
      const nodes = gql.numbers.map((n) => ({ number: n, id: `I_${n}`, title: "pause: hold", body: "operator", url: `https://github.com/${CONTROL_SLUG}/issues/${n}`, createdAt: "2026-10-22T16:00:00Z" }));
      return Response.json({ data: { repository: { issues: { totalCount: gql.totalCount, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as unknown as typeof fetch;
}

describe("the real client reads issues through GraphQL, never the REST list", () => {
  const connect = (f: typeof fetch) => StateRepoClient.connect({ labels: stateRepoLabels(NAMES), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: defaultConfig.names.control.id, fetch: f });

  test("an empty REST page cannot hide an open pause", async () => {
    const seen: string[] = [];
    const repo = await connect(apiFetch(seen, { totalCount: 1, numbers: [21] }));
    expect(await pauseReason(repo, "pause")).toBe("an open pause issue (#21)");
    expect(seen.filter((s) => s.endsWith("/issues"))).toEqual([]);
    expect(seen).toContain("POST /graphql");
  });

  test("fewer issues than GitHub counts is incomplete, and incomplete is paused", async () => {
    const repo = await connect(apiFetch([], { totalCount: 2, numbers: [] }));
    expect(await repo.listOpenIssues("pause")).toEqual({ issues: [], complete: false });
    expect(await pauseReason(repo, "pause")).toContain("could not all be listed");
  });

  test("a GraphQL error is a failed read: paused", async () => {
    const f = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname === "/graphql") return Response.json({ errors: [{ type: "FORBIDDEN", message: "no" }] });
      return Response.json({ id: defaultConfig.names.control.id });
    }) as unknown as typeof fetch;
    const repo = await connect(f);
    expect(await pauseReason(repo, "pause")).toContain("could not be read");
  });

  test("the shared helper pages until the end", async () => {
    let page = 0;
    const f = (async () => {
      page++;
      const nodes = [{ number: page, id: `I_${page}`, title: "t", body: null, url: "u", createdAt: "2026-10-22T16:00:00Z" }];
      return Response.json({ data: { repository: { issues: { totalCount: 3, pageInfo: { hasNextPage: page < 3, endCursor: `c${page}` }, nodes } } } });
    }) as unknown as typeof fetch;
    const l = await listOpenIssuesByLabel(new Http({ token: "t", fetch: f }), NAMES.control.owner, NAMES.control.name, "pause");
    expect(l).toMatchObject({ complete: true, issues: [{ number: 1 }, { number: 2 }, { number: 3 }] });
    expect(GitHubError).toBeDefined();
  });
});

describe("a total that changes mid-scan never certifies a listing", () => {
  type P = { total: number; numbers: number[]; next: boolean };
  /** A scripted GraphQL issues listing: one page per request, in order. */
  function scripted(pages: P[]): { http: Http; requests: () => number } {
    let i = 0;
    const f = (async () => {
      const p = pages[i++];
      if (!p) throw new Error("no more scripted pages");
      const nodes = p.numbers.map((n) => ({ number: n, id: `I_${n}`, title: "pause", body: `marker ${n}`, url: `https://github.com/${CONTROL_SLUG}/issues/${n}`, createdAt: "2026-10-22T16:00:00Z" }));
      return Response.json({ data: { repository: { issues: { totalCount: p.total, pageInfo: { hasNextPage: p.next, endCursor: p.next ? `c${i}` : null }, nodes } } } });
    }) as unknown as typeof fetch;
    return { http: new Http({ token: "t", fetch: f }), requests: () => i };
  }
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
  const list = (h: Http) => listOpenIssuesByLabel(h, NAMES.control.owner, NAMES.control.name, "pause");

  test("Race: #1 reopens and #2, #52 close between pages; the scan restarts and finds #1", async () => {
    const s = scripted([
      { total: 51, numbers: range(2, 51), next: true }, // #2-#51 read with #52 still open
      { total: 50, numbers: [], next: false }, // now #1, #3-#51: the old check counted 50 == 50 and missed #1
      { total: 50, numbers: [1, ...range(3, 51)], next: false }, // the restarted scan
    ]);
    const l = await list(s.http);
    expect(l.complete).toBe(true);
    expect(l.issues.map((i) => i.number)).toEqual([1, ...range(3, 51)]);
    expect(s.requests()).toBe(3);
  });

  test("a total that keeps moving gives up as incomplete after the bounded restarts", async () => {
    const moving: P[] = [];
    for (let k = 0; k <= 2; k++) moving.push({ total: 10 + k * 2, numbers: [1], next: true }, { total: 11 + k * 2, numbers: [2], next: false });
    const l = await list(scripted(moving).http);
    expect(l.complete).toBe(false);
  });

  test("an issue seen on two pages counts once: overlap cannot make up for a missed one", async () => {
    const l = await list(scripted([{ total: 3, numbers: [1, 2], next: true }, { total: 3, numbers: [2], next: false }]).http);
    expect(l).toMatchObject({ complete: false, issues: [{ number: 1 }, { number: 2 }] });
  });

  test("through openPause: the race no longer opens a duplicate pause issue", async () => {
    // The race hits both listings openPause makes (the old check certified each one and created a
    // duplicate); the marker lives on #1. The new scan restarts twice, then reads it.
    const race: P[] = [
      { total: 51, numbers: range(2, 51), next: true },
      { total: 50, numbers: [], next: false },
    ];
    const settled: P = { total: 50, numbers: [1, ...range(3, 51)], next: false };
    const s = scripted([...race, ...race, settled, settled]);
    const created: string[] = [];
    const repo = new FakeStateRepo();
    repo.listOpenIssues = async (label) => {
      const l = await list(s.http);
      return { issues: l.issues.map((i) => ({ number: i.number, title: i.title, body: i.number === 1 ? `held ${marker("halt:z")}` : i.body })), complete: l.complete };
    };
    repo.createIssue = async (t) => (created.push(t), 99);
    await openPause(repo, NAMES, "halt:z", "boom");
    expect(created).toEqual([]);
  });
});
