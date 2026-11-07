// qlander.yml `linkedIssues.close`: a landing closes the issues each landed
// PR says it closes, with one comment naming the PR, as a merge by a person
// would. Only once main holds the landing, only issues in the target, never
// twice, and never a reason to pause.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { expectedPermissions } from "../src/audit/apps";
import type { Config } from "../src/config";
import { CONFIG_PATH, ConfigError, DEFAULT_LINEAR_BODY, parseConfig } from "../src/config/load";
import { GitHubError } from "../src/github/http";
import { CLOSING_ISSUES_PAGES, TargetClient } from "../src/github/target";
import { LINKED_ISSUES_GIVE_UP_HOURS } from "../src/ops";
import { drain, type DrainDeps } from "../src/outbox";
import { policyHash } from "../src/queue";
import { renderTick } from "../src/render";
import { appSpecs } from "../src/setup/expected";
import { emptyState, type Notice, parseState, type State } from "../src/state";
import { FakeStateRepo, FakeTarget } from "./fake-github";
import { exampleConfig } from "./setup-world";
import { NAMES, pathRe, sha, TARGET, TARGET_OPTS, TARGET_SLUG } from "./sim";
import { World } from "./world";

const LINEAR: NonNullable<Config["landing"]> = { mode: "linear", body: DEFAULT_LINEAR_BODY, author: "app", maxRefusals: 3 };

/** A world with the key on, where each PR n says it closes issue 100 + n. */
function world(over: Partial<Config> = {}, on = true): World {
  const w = new World(() => "pass", over);
  w.closeLinkedIssues = on;
  return w;
}

function linked(w: World, pr: number, ...issues: { number: number; open?: boolean; repo?: "other" }[]): void {
  for (const i of issues) if (i.repo !== "other") w.target.issues.set(i.number, { open: i.open ?? true, comments: [] });
  w.target.closing.set(pr, issues.map((i) => ({ number: i.number, ...(i.repo ? { repo: i.repo } : {}) })));
}

const closedBy = (pr: number) => (c: string) => c.startsWith(`Closed by #${pr}, which qlander landed in \`${NAMES.main}\` at `);

describe("a landing closes the issues its PRs say they close", () => {
  test("each open issue gets one comment naming its PR and is closed; an issue already closed is left alone", async () => {
    const w = world();
    for (const n of [1, 2]) w.readyPr(n);
    linked(w, 1, { number: 101 }, { number: 102, open: false });
    linked(w, 2, { number: 201 });
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    const main = w.target.refs.get(NAMES.main)!;
    for (const [issue, pr] of [[101, 1], [201, 2]] as const) {
      const i = w.target.issues.get(issue)!;
      expect(i.open).toBe(false);
      expect(i.comments).toHaveLength(1);
      expect(closedBy(pr)(i.comments[0]!)).toBe(true);
      expect(i.comments[0]).toContain(main);
    }
    expect(w.target.issues.get(102)).toEqual({ open: false, comments: [] });
    expect(w.paused()).toBe(false);
    expect(w.state().outbox).toEqual([]);
  });

  test("off (the default): nothing is read or closed", async () => {
    const w = world({}, false);
    w.readyPr(1);
    linked(w, 1, { number: 101 });
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.issues.get(101)).toEqual({ open: true, comments: [] });
    expect(w.target.calls.some((c) => c.startsWith("closing "))).toBe(false);
  });

  test("a bounced PR's issues stay open; the PRs that landed close theirs", async () => {
    const w = new World((b) => (b.prs.includes(3) ? "fail" : "pass"));
    w.closeLinkedIssues = true;
    for (const n of [1, 2, 3, 4]) {
      w.readyPr(n);
      linked(w, n, { number: 100 + n });
    }
    await w.runUntilIdle();
    expect(w.bounced()).toContain(3);
    expect(w.target.issues.get(103)).toEqual({ open: true, comments: [] });
    for (const n of w.landed().flat()) expect(w.target.issues.get(100 + n)!.open).toBe(false);
    expect(w.landed().flat().sort()).toEqual([1, 2, 4]);
  });

  test("linear landing: a refused landing closes nothing, and the landing that follows closes each issue once", async () => {
    const w = world({ landing: LINEAR });
    for (const n of [1, 2]) {
      w.readyPr(n).pr.title = `Change number ${n}`;
      linked(w, n, { number: 100 + n });
    }
    w.target.refuseLandings = 1;
    let refusedOpen = false;
    for (let i = 0; i < 80; i++) {
      await w.tick();
      const s = w.state();
      if (s.journal?.op.kind === "land" && w.landed().length === 0) refusedOpen ||= w.target.issues.get(101)!.open && w.target.issues.get(101)!.comments.length === 0;
      if (w.landed().length > 0 && s.verify.length === 0 && s.outbox.length === 0) break;
    }
    expect(refusedOpen).toBe(true);
    expect(w.landed()).toEqual([[1, 2]]);
    for (const n of [1, 2]) {
      const i = w.target.issues.get(100 + n)!;
      expect(i.open).toBe(false);
      expect(i.comments.filter(closedBy(n))).toHaveLength(1);
    }
  });

  test("an author push before a linear landing drops that PR, whose issue stays open", async () => {
    const w = world({ landing: LINEAR });
    for (const n of [1, 2, 3]) {
      w.readyPr(n).pr.title = `Change number ${n}`;
      linked(w, n, { number: 100 + n });
    }
    const move = w.target.moveBranches.bind(w.target);
    let pushed = false;
    w.target.moveBranches = async (g, m, e) => {
      if (!pushed) {
        pushed = true;
        w.target.push(2);
      }
      return move(g, m, e);
    };
    for (let i = 0; i < 80; i++) {
      await w.tick();
      if (w.landed().length > 0 && w.state().verify.length === 0 && w.state().outbox.length === 0) break;
    }
    expect(w.landed()).toEqual([[1, 3]]);
    expect(w.target.issues.get(102)).toEqual({ open: true, comments: [] });
    for (const n of [1, 3]) expect(w.target.issues.get(100 + n)!.open).toBe(false);
  });
});

describe("the closeIssues notice (src/outbox.ts)", () => {
  const NOW = new Date("2026-10-21T12:00:00Z");
  type CloseNotice = Extract<Notice, { kind: "closeIssues" }>;
  const notice = (over: Partial<CloseNotice> = {}): CloseNotice => ({
    id: "li:7:3",
    kind: "closeIssues",
    pr: 7,
    landedIn: sha("landed"),
    giveUpAt: new Date(NOW.getTime() + LINKED_ISSUES_GIVE_UP_HOURS * 3_600_000).toISOString(),
    ...over,
  });
  const stateWith = (n: Notice): State => ({ ...emptyState(), outbox: [n] });

  function setup(...issues: { number: number; open?: boolean; repo?: "other" }[]) {
    const target = new FakeTarget("queue", NAMES);
    for (const i of issues) if (i.repo !== "other") target.issues.set(i.number, { open: i.open ?? true, comments: [] });
    target.closing.set(7, issues.map((i) => ({ number: i.number, ...(i.repo ? { repo: i.repo } : {}) })));
    const saved: Notice[][] = [];
    const deps = (over: Partial<DrainDeps> = {}): DrainDeps => ({ target, repo: new FakeStateRepo(), names: NAMES, now: NOW, reconcileMinutes: 30, save: async (o) => void saved.push(structuredClone(o)), ...over });
    return { target, saved, deps };
  }

  test("a crash after the comment and before the close: the next drain closes without commenting again", async () => {
    const { target, saved, deps } = setup({ number: 11 }, { number: 12 });
    const close = target.closeIssue.bind(target);
    let crash = true;
    target.closeIssue = async (n) => {
      if (crash) {
        crash = false;
        throw new Error("the runner died");
      }
      return close(n);
    };
    await expect(drain(stateWith(notice()), deps())).rejects.toThrow("the runner died");
    const persisted = saved.at(-1)!;
    expect(persisted).toEqual([{ ...notice(), sent: [11] }]);
    expect(target.issues.get(11)!.comments).toHaveLength(1);
    // The next tick starts from what was saved. No comment listing is read, so a lagging one cannot cause a second post.
    const out = await drain({ ...emptyState(), outbox: persisted }, deps());
    expect(out.outbox).toEqual([]);
    expect(out.failure).toBeNull();
    for (const n of [11, 12]) {
      expect(target.issues.get(n)!.open).toBe(false);
      expect(target.issues.get(n)!.comments).toHaveLength(1);
    }
  });

  test("an issue in another repository is never touched", async () => {
    const { target, deps } = setup({ number: 11 }, { number: 12, repo: "other" });
    const out = await drain(stateWith(notice()), deps());
    expect(out.outbox).toEqual([]);
    expect(target.issues.get(11)!.open).toBe(false);
    expect(target.issues.has(12)).toBe(false);
  });

  test("without Issues permission: dropped with a log line that names it, never a pause", async () => {
    const { target, deps } = setup({ number: 11 });
    target.closingErrors.push(new GitHubError("auth", 403, "Resource not accessible by integration"));
    const out = await drain(stateWith(notice()), deps());
    expect(out.failure).toBeNull();
    expect(out.outbox).toEqual([]);
    expect(out.log.some((l) => l.startsWith("dropped closeIssues li:7:3") && l.includes("Issues: write"))).toBe(true);
    expect(target.issues.get(11)).toEqual({ open: true, comments: [] });
  });

  test("a transient error keeps the notice for the next tick and holds up nothing behind it", async () => {
    const { target, deps } = setup({ number: 11 });
    target.closingErrors.push(new GitHubError("server", 502, "bad gateway"));
    const after: Notice = { id: "u:9:x", kind: "unready", pr: 9 };
    target.addPr(9);
    const out = await drain({ ...emptyState(), outbox: [notice(), after] }, deps());
    expect(out.outbox).toEqual([notice()]);
    expect(out.log).toContain("done unready u:9:x");
    expect((await drain({ ...emptyState(), outbox: out.outbox }, deps())).outbox).toEqual([]);
    expect(target.issues.get(11)!.open).toBe(false);
  });

  test("one issue GitHub refuses is skipped; the others are still closed", async () => {
    const { target, deps } = setup({ number: 11 }, { number: 12 });
    target.issueErrors.push(new GitHubError("validation", 422, "issue is locked"));
    const out = await drain(stateWith(notice()), deps());
    expect(out.outbox).toEqual([]);
    expect(target.issues.get(11)).toEqual({ open: true, comments: [] });
    expect(target.issues.get(12)!.open).toBe(false);
  });

  test("a truncated reference list closes what was read and says the rest were not", async () => {
    const { target, deps } = setup({ number: 11 });
    target.closingTruncated = true;
    const out = await drain(stateWith(notice()), deps());
    expect(out.outbox).toEqual([]);
    expect(target.issues.get(11)!.open).toBe(false);
    expect(out.log).toContain("closeIssues li:7:3: #7 names more issues than could be read; closed the first 1, left the rest open");
  });

  test("past its deadline it is dropped before anything is read", async () => {
    const { target, deps } = setup({ number: 11 });
    const out = await drain(stateWith(notice({ giveUpAt: NOW.toISOString() })), deps());
    expect(out.outbox).toEqual([]);
    expect(target.calls.some((c) => c.startsWith("closing "))).toBe(false);
    expect(target.issues.get(11)!.open).toBe(true);
  });

  test("bounded per tick: what is left waits for the next, with the finished issues saved", async () => {
    const { target, saved, deps } = setup({ number: 11 }, { number: 12 });
    let t = 0;
    const clock = () => (t += 15_000);
    const out = await drain(stateWith(notice()), deps({ clock }));
    expect(out.outbox).toEqual([{ ...notice(), sent: [11], done: [11] }]);
    expect(saved.length).toBeGreaterThan(0);
    expect(target.issues.get(12)!.open).toBe(true);
    const next = await drain({ ...emptyState(), outbox: out.outbox }, deps());
    expect(next.outbox).toEqual([]);
    expect(target.issues.get(11)!.comments).toHaveLength(1);
    expect(target.issues.get(12)!.open).toBe(false);
  });

  test("the state accepts the notice and refuses a malformed one", () => {
    const ok = stateWith(notice({ sent: [11], done: [11] }));
    expect(parseState(JSON.stringify(ok), NAMES).outbox).toEqual(ok.outbox);
    expect(() => parseState(JSON.stringify(stateWith({ ...notice(), landedIn: "main" } as Notice)), NAMES)).toThrow();
    expect(() => parseState(JSON.stringify(stateWith({ ...notice(), done: [0] } as Notice)), NAMES)).toThrow();
  });
});

describe("the real client's closingIssues", () => {
  const repoRoute = { match: pathRe(`/repos/${TARGET_SLUG}`), body: { id: TARGET, node_id: "R_target" } };
  function scripted(pages: unknown[]) {
    const seen: { url: string; body: unknown }[] = [];
    let page = 0;
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, body });
      if (repoRoute.match.test(url)) return new Response(JSON.stringify(repoRoute.body));
      if (url.endsWith("/graphql")) return new Response(JSON.stringify(pages[page++] ?? {}));
      return new Response(JSON.stringify({ message: `unrouted ${url}` }), { status: 599 });
    }) as typeof globalThis.fetch;
    return { fetch, seen };
  }
  const page = (nodes: unknown[], next: string | null) => ({ data: { node: { pullRequest: { closingIssuesReferences: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } } } } } });
  const issue = (number: number, state: string, repo = TARGET) => ({ number, state, repository: { databaseId: repo } });

  test("pages through every reference and keeps only this repository's issues", async () => {
    const s = scripted([page([issue(1, "OPEN"), issue(2, "OPEN", TARGET + 1)], "c1"), page([issue(3, "CLOSED")], null)]);
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: s.fetch, sleep: async () => {} });
    expect(await c.closingIssues(5)).toEqual({ items: [{ number: 1, open: true }, { number: 3, open: false }], truncated: false });
    const queries = s.seen.filter((x) => x.url.endsWith("/graphql")).map((x) => (x.body as { variables: Record<string, unknown> }).variables);
    expect(queries).toEqual([{ id: "R_target", pr: 5, after: null }, { id: "R_target", pr: 5, after: "c1" }]);
  });

  test("more references than it reads is truncated, never a silent whole", async () => {
    const s = scripted(Array.from({ length: CLOSING_ISSUES_PAGES + 1 }, (_, i) => page([issue(i + 1, "OPEN")], `c${i}`)));
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: s.fetch, sleep: async () => {} });
    expect((await c.closingIssues(5)).truncated).toBe(true);
  });

  test("closeIssue closes as completed, and only the queue role may", async () => {
    const s = scripted([]);
    const q = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: s.fetch, sleep: async () => {} });
    await expect(q.closeIssue(9)).rejects.toThrow(); // unrouted, but the request was made
    expect(s.seen.at(-1)).toEqual({ url: expect.stringMatching(/\/issues\/9$/), body: { state: "closed", state_reason: "completed" } });
    const r = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "release", fetch: s.fetch, sleep: async () => {} });
    const before = s.seen.length;
    await expect(r.closeIssue(9)).rejects.toThrow("may not");
    expect(s.seen.length).toBe(before);
  });
});

describe("linkedIssues config and the queue App's permissions", () => {
  const text = readFileSync(CONFIG_PATH, "utf8").replace(/^linkedIssues:\n( .*\n)*/m, "");
  const withKey = (body: string) => `${text}\nlinkedIssues:\n${body}`;

  test("absent: off; present: read; anything else refused", () => {
    expect(parseConfig(text).closeLinkedIssues).toBe(false);
    expect(parseConfig(withKey("  close: true\n")).closeLinkedIssues).toBe(true);
    expect(parseConfig(withKey("  close: false\n")).closeLinkedIssues).toBe(false);
    expect(() => parseConfig(withKey("  close: yes please\n"))).toThrow(ConfigError);
    expect(() => parseConfig(withKey("  reopen: true\n"))).toThrow(ConfigError);
  });

  test("not policy: the hash is the same with and without it", () => {
    expect(policyHash(parseConfig(withKey("  close: true\n")).config)).toBe(policyHash(parseConfig(text).config));
  });

  test("on: render, setup and audit all add Issues: write to the queue App, and nothing else changes", () => {
    const off = { ...exampleConfig(), closeLinkedIssues: false };
    const on = { ...exampleConfig(), closeLinkedIssues: true };
    const queue = (c: typeof on) => appSpecs(c, "acme").find((s) => s.role === "queue")!;
    expect(queue(on).tokenPermissions).toEqual({ ...queue(off).tokenPermissions, issues: "write" });
    expect(queue(on).permissions).toEqual({ ...queue(off).permissions, issues: "write" });
    expect(appSpecs(on, "acme").filter((s) => s.role !== "queue")).toEqual(appSpecs(off, "acme").filter((s) => s.role !== "queue"));
    expect(renderTick(off)).not.toContain("permission-issues");
    expect(renderTick(on).split("\n").filter((l) => !renderTick(off).split("\n").includes(l))).toEqual(["          permission-issues: write"]);
    const release = { mode: "advance" as const, dispatch: null };
    expect(expectedPermissions("queue", release, false, true)).toEqual(queue(on).permissions);
    expect(expectedPermissions("queue", release, false, false)).toEqual(queue(off).permissions);
    expect(expectedPermissions("state", release, false, true)).toEqual(expectedPermissions("state", release, false, false));
  });
});
