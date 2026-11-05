// The real clients against a scripted fetch: input validation, role guards,
// pagination, error classification, retries (reads only), CAS via GraphQL.

import { describe, expect, test } from "bun:test";
import { TargetClient } from "../src/github/target";
import { classify, GitHubError, Http } from "../src/github/http";
import { StateRefClient } from "../src/github/state-ref";
import { StateRepoClient } from "../src/github/state-repo";
import { TARGET, NAMES, sha, STATE_BRANCHES, TARGET_OPTS, pathRe, TARGET_SLUG, CONTROL_SLUG, LS } from "./sim";
import { stateRepoLabels } from "../src/main";

interface Route {
  method?: string;
  match: RegExp;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class Script {
  seen: { method: string; url: string; body: unknown }[] = [];
  constructor(private routes: Route[]) {}
  fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.seen.push({ method, url, body });
    const i = this.routes.findIndex((r) => (r.method ?? "GET") === method && r.match.test(url));
    if (i < 0) return new Response(JSON.stringify({ message: `unrouted ${method} ${url}` }), { status: 599 });
    const r = this.routes[i]!;
    if (this.routes.filter((x) => x.match.source === r.match.source && (x.method ?? "GET") === method).length > 1) this.routes.splice(i, 1);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status ?? 200, headers: r.headers });
  }) as typeof fetch;
}

const repoRoute: Route = { match: pathRe(`/repos/${TARGET_SLUG}`), body: { id: TARGET, node_id: "R_target" } };
const noSleep = async () => {};

async function client(routes: Route[], role: "queue" | "release" | "read" = "queue") {
  const s = new Script([repoRoute, ...routes]);
  const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role, fetch: s.fetch, sleep: noSleep });
  return { c, s };
}

describe("connect", () => {
  test("refuses a repository whose id is not the configured one", async () => {
    const s = new Script([{ match: pathRe(`/repos/${TARGET_SLUG}`), body: { id: 42, node_id: "x" } }]);
    await expect(TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: s.fetch })).rejects.toThrow(`expected ${TARGET}`);
  });

  test("refuses odd owner or repo names before any request", async () => {
    const s = new Script([]);
    await expect(TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: "../x", repo: "widgets", repoId: TARGET, role: "queue", fetch: s.fetch })).rejects.toThrow("bad owner");
    expect(s.seen).toHaveLength(0);
  });
});

describe("validation and role guards (no request is made)", () => {
  test("SHAs, PR numbers, branches, workflow paths, data files and labels", async () => {
    const { c, s } = await client([]);
    const before = s.seen.length;
    await expect(c.getCommit("abc")).rejects.toThrow("not a 40-hex sha");
    await expect(c.getPr(0)).rejects.toThrow("not a PR number");
    await expect(c.getRef("feature/x")).rejects.toThrow("not one qlander reads or writes");
    await expect(c.listRuns({ headSha: sha("x"), branch: "evil" })).rejects.toThrow();
    await expect(c.listWorkflowRuns("../../x.yml", {})).rejects.toThrow("bad workflow path");
    await expect(c.getDataFile("src/main.py", sha("x"))).rejects.toThrow("not a data file");
    await expect(c.removeLabel(1, "do-not-merge")).rejects.toThrow("does not remove");
    await expect(c.permission("a/b")).rejects.toThrow("bad login");
    expect(s.seen.length).toBe(before);
  });

  test("the queue role cannot touch release; the release role can only move release", async () => {
    const q = (await client([])).c;
    await expect(q.updateRef("release", sha("a"), sha("b"))).rejects.toThrow("may not write release");
    const r = (await client([], "release")).c;
    await expect(r.updateRef("main", sha("a"), sha("b"))).rejects.toThrow("may not write main");
    await expect(r.comment(1, "hi")).rejects.toThrow("may not do this");
    await expect(r.merge("qlander-build/1", sha("a"), "m")).rejects.toThrow();
    const ro = (await client([], "read")).c;
    await expect(ro.createRef("queue/1", sha("a"))).rejects.toThrow("read-only");
  });

  test("main and release are never created, deleted, or moved except by updateRef", async () => {
    const { c } = await client([]);
    await expect(c.createRef("main", sha("a"))).rejects.toThrow("only moved with updateRef");
    await expect(c.deleteRef("main")).rejects.toThrow("never deleted");
    await expect(c.updateRef("queue/1", sha("a"), sha("b"))).rejects.toThrow("only main or release");
    await expect(c.merge("main", sha("a"), "m")).rejects.toThrow("only onto a qlander-build branch");
  });
});

describe("updateRef: GraphQL compare-and-swap", () => {
  test("sends beforeOid, afterOid and force false for the repository node", async () => {
    const { c, s } = await client([{ method: "POST", match: /\/graphql$/, body: { data: { updateRefs: { clientMutationId: null } } } }]);
    await c.updateRef("main", sha("B"), sha("Q"));
    const req = s.seen.at(-1)!;
    expect(req.body).toMatchObject({
      variables: { input: { repositoryId: "R_target", refUpdates: [{ name: "refs/heads/main", beforeOid: sha("B"), afterOid: sha("Q"), force: false }] } },
    });
  });

  test("GraphQL errors are classified and never retried", async () => {
    const { c, s } = await client([{ method: "POST", match: /\/graphql$/, body: { errors: [{ type: "STALE_DATA", message: "stale" }] } }]);
    const e = await c.updateRef("main", sha("B"), sha("Q")).catch((x) => x);
    expect(e).toBeInstanceOf(GitHubError);
    expect(e.kind).toBe("conflict");
    expect(s.seen.filter((x) => x.url.endsWith("/graphql"))).toHaveLength(1);
  });

  test("a 502 on the mutation is not retried", async () => {
    const { c, s } = await client([{ method: "POST", match: /\/graphql$/, status: 502, body: { message: "bad gateway" } }]);
    await expect(c.updateRef("main", sha("B"), sha("Q"))).rejects.toThrow("server");
    expect(s.seen.filter((x) => x.url.endsWith("/graphql"))).toHaveLength(1);
  });
});

describe("merges", () => {
  test("201 merged, 204 no-op, 409 conflict", async () => {
    const m = sha("merge");
    const { c } = await client([
      { method: "POST", match: /\/merges$/, status: 201, body: { sha: m } },
      { method: "POST", match: /\/merges$/, status: 204 },
      { method: "POST", match: /\/merges$/, status: 409, body: { message: "Merge conflict" } },
    ]);
    expect(await c.merge("qlander-build/3", sha("h"), "msg")).toEqual({ kind: "merged", sha: m });
    expect(await c.merge("qlander-build/3", sha("h"), "msg")).toEqual({ kind: "noop" });
    expect(await c.merge("qlander-build/3", sha("h"), "msg")).toEqual({ kind: "conflict" });
  });

  test("a merge is never retried on a server error", async () => {
    const { c, s } = await client([{ method: "POST", match: /\/merges$/, status: 502, body: { message: "x" } }]);
    await expect(c.merge("qlander-build/3", sha("h"), "msg")).rejects.toThrow("server");
    expect(s.seen.filter((x) => x.url.endsWith("/merges"))).toHaveLength(1);
  });
});

describe("reads: pagination, retries, not-found", () => {
  test("follows Link rel=next across pages", async () => {
    const page = (ids: number[]) => ({ total_count: 3, workflow_runs: ids.map((id) => ({ id, run_attempt: 1, path: "p", event: "push", head_branch: "main", head_sha: sha("h"), status: "completed", conclusion: "success", repository: { id: TARGET }, head_repository: { id: TARGET }, created_at: "t", run_started_at: "t" })) });
    const { c } = await client([
      { match: /actions\/runs\?.*page=2/, body: page([3]) },
      { match: /actions\/runs\?/, body: page([1, 2]), headers: { link: `<https://api.github.com/repos/${TARGET_SLUG}/actions/runs?head_sha=x&page=2>; rel="next"` } },
    ]);
    expect(await c.listRuns({ headSha: sha("h") })).toMatchObject({ items: [{ id: 1 }, { id: 2 }, { id: 3 }], truncated: false });
  });

  test("a Link header pointing at another host is refused", async () => {
    const h = new Http({ token: "t", fetch: new Script([{ match: /x/, body: [], headers: { link: '<https://evil.example/steal>; rel="next"' } }]).fetch });
    await expect(h.paginate("x", {}, (p) => p as unknown[])).rejects.toThrow("refusing to call https://evil.example");
  });

  test("pagination stops at maxPages and reports truncation", async () => {
    const loop = { match: /\/x/, body: [1], headers: { link: '<https://api.github.com/x?page=n>; rel="next"' } };
    const h = new Http({ token: "t", fetch: new Script([loop]).fetch, maxPages: 3 });
    expect(await h.paginate("x", {}, (p) => p as number[])).toEqual({ items: [1, 1, 1], truncated: true });
  });

  test("reads retry on 5xx and then succeed", async () => {
    const { c, s } = await client([
      { match: /git\/ref\/heads\/main$/, status: 502, body: { message: "bad gateway" } },
      { match: /git\/ref\/heads\/main$/, body: { object: { sha: sha("main") } } },
    ]);
    expect(await c.getRef("main")).toBe(sha("main"));
    expect(s.seen.filter((x) => x.url.endsWith("/heads/main"))).toHaveLength(2);
  });

  test("reads give up after the configured attempts", async () => {
    const { c, s } = await client([{ match: /git\/ref\/heads\/main$/, status: 500, body: { message: "boom" } }, { match: /git\/ref\/heads\/main$/, status: 500, body: { message: "boom" } }]);
    await expect(c.getRef("main")).rejects.toThrow("server");
    expect(s.seen.filter((x) => x.url.endsWith("/heads/main"))).toHaveLength(3);
  });

  test("missing refs, runs and data files read as null; a missing collaborator as none", async () => {
    const { c } = await client([
      { match: /git\/ref\/heads\/release$/, status: 404, body: { message: "Not Found" } },
      { match: /actions\/runs\/77$/, status: 404, body: { message: "Not Found" } },
      { match: /collaborators\/mallory\/permission$/, status: 404, body: { message: "Not Found" } },
    ]);
    expect(await c.getRef("release")).toBeNull();
    expect(await c.getRun(77)).toBeNull();
    expect(await c.permission("mallory")).toBe("none");
  });

  test("the ready-PR list reads open PRs (never the issues endpoint) and keeps only the label", async () => {
    const { c, s } = await client([{ match: /\/pulls\?/, body: [{ number: 1, labels: [{ name: "ready" }] }, { number: 2, labels: [{ name: "other" }] }, { number: 3, labels: [] }] }]);
    expect(await c.listOpenPrNumbersWithLabel("ready")).toEqual([1]);
    expect(s.seen.some((x) => /\/issues/.test(x.url))).toBe(false);
  });

  test("getPr refuses a response for another PR and a bad head sha", async () => {
    const pr = (n: number, head: string) => ({ number: n, state: "open", draft: false, merged: false, mergeable: true, head: { sha: head, ref: "x", repo: { id: TARGET } }, base: { ref: "main", repo: { id: TARGET } }, labels: [] });
    const { c } = await client([
      { match: /pulls\/5$/, body: pr(6, sha("h")) },
      { match: /pulls\/7$/, body: pr(7, "nope") },
    ]);
    await expect(c.getPr(5)).rejects.toThrow("asked for #5");
    await expect(c.getPr(7)).rejects.toThrow("not a 40-hex sha");
  });

  test("the qualification manifest is read as data from an exact sha", async () => {
    const text = '{"schema":1}';
    const { c, s } = await client([{ match: /contents\/\.github\/qualification\.json\?ref=/, body: { type: "file", encoding: "base64", sha: sha("blob"), content: Buffer.from(text).toString("base64") } }]);
    expect(await c.getDataFile(".github/qualification.json", sha("m"))).toEqual({ blobSha: sha("blob"), text });
    expect(s.seen.at(-1)!.url).toContain(`ref=${sha("m")}`);
  });

  test("dataFiles replaces the files getDataFile may read", async () => {
    const text = '{"schema":1}';
    const s = new Script([repoRoute, { match: /contents\/policy\/q\.json\?ref=/, body: { type: "file", encoding: "base64", sha: sha("blob"), content: Buffer.from(text).toString("base64") } }]);
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "read", fetch: s.fetch, sleep: noSleep, dataFiles: ["policy/q.json"] });
    expect(await c.getDataFile("policy/q.json", sha("m"))).toEqual({ blobSha: sha("blob"), text });
    await expect(c.getDataFile(".github/qualification.json", sha("m"))).rejects.toThrow("not a data file");
  });

  test("the status history is read newest first from the list endpoint, with creator ids", async () => {
    const { c, s } = await client([
      {
        match: /\/commits\/[0-9a-f]{40}\/statuses/,
        body: [
          { context: "ci/verified", state: "success", target_url: null, creator: { login: "bot[bot]", id: 7 } },
          { context: "ci/verified", state: "failure", target_url: "https://x", creator: null },
        ],
      },
    ]);
    expect(await c.listCommitStatuses(sha("a"))).toEqual({
      items: [
        { context: "ci/verified", state: "success", targetUrl: null, creatorId: 7 },
        { context: "ci/verified", state: "failure", targetUrl: "https://x", creatorId: null },
      ],
      truncated: false,
    });
    expect(s.seen.at(-1)!.url).toContain(`/commits/${sha("a")}/statuses`);
  });
});

describe("classify", () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  test("status codes and rate-limit headers", () => {
    expect(classify(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }), "API rate limit exceeded").kind).toBe("rate_limit");
    expect(classify(429, h({ "retry-after": "5" }), "slow down")).toMatchObject({ kind: "rate_limit", retryAfterMs: 5000 });
    expect(classify(403, h(), "Resource not accessible by integration").kind).toBe("auth");
    expect(classify(401, h(), "Bad credentials").kind).toBe("auth");
    expect(classify(404, h(), "Not Found").kind).toBe("not_found");
    expect(classify(409, h(), "Merge conflict").kind).toBe("conflict");
    expect(classify(422, h(), "Reference already exists").kind).toBe("conflict");
    expect(classify(422, h(), "Validation Failed").kind).toBe("validation");
    expect(classify(503, h(), "unavailable").kind).toBe("server");
  });

  test("a network failure is classified and retried for reads", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) throw new TypeError("socket hang up");
      return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const http = new Http({ token: "t", fetch: flaky, sleep: noSleep });
    expect((await http.request("GET", "x")).json).toEqual({ ok: 1 });
    const once = new Http({ token: "t", fetch: (async () => { throw new TypeError("down"); }) as unknown as typeof fetch, sleep: noSleep });
    await expect(once.request("POST", "x")).rejects.toMatchObject({ kind: "network" });
  });
});

describe("state repo client", () => {
  const notifyConnect = async (script: Route[]) => {
    const s = new Script([{ match: pathRe(`/repos/${CONTROL_SLUG}`), body: { id: LS } }, ...script]);
    const c = await StateRepoClient.connect({ labels: stateRepoLabels(NAMES), assign: { labels: ["pause"], logins: ["alice"] }, token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: s.fetch });
    return { c, s };
  };
  const posted = (s: Script) => s.seen.filter((x) => x.method === "POST").map((x) => x.body as { assignees?: string[] });

  test("notify: a pause issue is assigned, and an issue with another label is not", async () => {
    const { c, s } = await notifyConnect([
      { method: "POST", match: /\/issues$/, status: 201, body: { number: 9 } },
      { method: "POST", match: /\/issues$/, status: 201, body: { number: 10 } },
    ]);
    expect(await c.createIssue("paused", "why", ["pause"])).toBe(9);
    expect(await c.createIssue("flaky: t", "why", ["flaky"])).toBe(10);
    expect(posted(s).map((b) => b.assignees)).toEqual([["alice"], undefined]);
  });

  test("notify: a login GitHub refuses never costs the pause, which opens unassigned", async () => {
    const { c, s } = await notifyConnect([
      { method: "POST", match: /\/issues$/, status: 422, body: { message: "Validation Failed" } },
      { method: "POST", match: /\/issues$/, status: 201, body: { number: 9 } },
    ]);
    expect(await c.createIssue("paused", "why", ["pause"])).toBe(9);
    expect(posted(s).map((b) => b.assignees)).toEqual([["alice"], undefined]);
  });

  test("notify: any other failure is not retried here, so the pause stays pending", async () => {
    const { c, s } = await notifyConnect([{ method: "POST", match: /\/issues$/, status: 403, body: { message: "Forbidden" } }]);
    await expect(c.createIssue("paused", "why", ["pause"])).rejects.toThrow();
    expect(posted(s)).toHaveLength(1);
  });

  test("verifies its repo id and only uses qlander labels", async () => {
    const s = new Script([
      { match: pathRe(`/repos/${CONTROL_SLUG}`), body: { id: LS } },
      { method: "POST", match: /\/issues$/, status: 201, body: { number: 9 } },
    ]);
    const c = await StateRepoClient.connect({ labels: stateRepoLabels(NAMES), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: s.fetch });
    await expect(c.createIssue("x", "y", ["bug"])).rejects.toThrow("unexpected label");
    expect(await c.createIssue("paused", "why", ["pause"])).toBe(9);
    expect(await c.createIssue("flaky: t", "why", ["flaky"])).toBe(9);
    await expect(c.updateIssueBody(1, "x".repeat(70_000))).rejects.toThrow("too large");
    const wrong = new Script([{ match: pathRe(`/repos/${CONTROL_SLUG}`), body: { id: 5 } }]);
    await expect(StateRepoClient.connect({ labels: stateRepoLabels(NAMES), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: wrong.fetch })).rejects.toThrow("expected");
  });
});

describe("state repo client: the tick dispatch (DESIGN.md §11.1)", () => {
  const connect = async (routes: Route[]) => {
    const s = new Script([{ match: pathRe(`/repos/${CONTROL_SLUG}`), body: { id: LS } }, ...routes]);
    const c = await StateRepoClient.connect({ labels: stateRepoLabels(NAMES), token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: s.fetch, sleep: noSleep });
    return { c, s };
  };

  test("dispatchTick sends exactly POST .../actions/workflows/tick.yml/dispatches with {ref: main}", async () => {
    const { c, s } = await connect([{ method: "POST", match: /\/dispatches$/, status: 204 }]);
    await c.dispatchTick();
    expect(s.seen.at(-1)).toEqual({ method: "POST", url: `https://api.github.com/repos/${CONTROL_SLUG}/actions/workflows/tick.yml/dispatches`, body: { ref: "main" } });
  });

  test("a failed dispatch is a write: never retried", async () => {
    const { c, s } = await connect([{ method: "POST", match: /\/dispatches$/, status: 500 }]);
    const before = s.seen.length;
    await expect(c.dispatchTick()).rejects.toMatchObject({ kind: "server" });
    expect(s.seen.length - before).toBe(1);
  });

  test("recentDispatches counts dispatched tick runs since a time, by total_count", async () => {
    const { c, s } = await connect([{ match: /\/actions\/workflows\/tick\.yml\/runs\?/, body: { total_count: 12, workflow_runs: [] } }]);
    expect(await c.recentDispatches(new Date("2026-10-23T11:00:00Z"))).toBe(12);
    const u = new URL(s.seen.at(-1)!.url);
    expect(u.pathname).toBe(`/repos/${CONTROL_SLUG}/actions/workflows/tick.yml/runs`);
    expect(u.searchParams.get("event")).toBe("workflow_dispatch");
    expect(u.searchParams.get("created")).toBe(">=2026-10-23T11:00:00.000Z");
    const bad = await connect([{ match: /\/runs\?/, body: {} }]);
    await expect(bad.c.recentDispatches(new Date())).rejects.toThrow("total_count");
  });

  test("every other Actions write through the workflow token is refused before any request", async () => {
    const { c, s } = await connect([]);
    const http = (c as unknown as { http: { request(m: string, p: string, i?: unknown): Promise<unknown> } }).http;
    const before = s.seen.length;
    const refused = [
      ["POST", `repos/${CONTROL_SLUG}/actions/runs/1/cancel`],
      ["POST", `repos/${CONTROL_SLUG}/actions/runs/1/rerun`],
      ["DELETE", `repos/${CONTROL_SLUG}/actions/runs/1`],
      ["DELETE", `repos/${CONTROL_SLUG}/actions/runs/1/logs`],
      ["PUT", `repos/${CONTROL_SLUG}/actions/workflows/tick.yml/disable`],
      ["POST", `repos/${CONTROL_SLUG}/actions/workflows/watchdog.yml/dispatches`],
      ["POST", `repos/${CONTROL_SLUG}/actions/workflows/tick.yml/dispatches/../../watchdog.yml/dispatches`],
      ["PUT", `repos/${CONTROL_SLUG}/actions/variables/QLANDER_MODE`],
      ["POST", `repos/${TARGET_SLUG}/actions/workflows/tick.yml/dispatches`],
      ["POST", `https://api.github.com/repos/${CONTROL_SLUG}/actions/runs/1/cancel`],
      ["POST", `repos/${CONTROL_SLUG}/%61ctions/runs/1/cancel`],
      ["POST", `repos/${CONTROL_SLUG}/actions/workflows/tick.yml/dispatche%73`],
      ["DELETE", `repos/${CONTROL_SLUG}/actions/workflows/tick.yml/dispatches`],
      ["PUT", `repos/${CONTROL_SLUG}/actions/workflows/tick.yml/dispatches`],
      ["POST", `repos/${CONTROL_SLUG}/issues/1/../../actions/runs/1/cancel`],
      ["DELETE", `repos/${CONTROL_SLUG}/issues/1`],
      ["POST", `repos/${CONTROL_SLUG}/git/refs`],
    ];
    for (const [m, p] of refused) await expect(http.request(m!, p!), `${m} ${p}`).rejects.toThrow("not an allowed write");
    const dispatch = `repos/${CONTROL_SLUG}/actions/workflows/tick.yml/dispatches`;
    await expect(http.request("POST", dispatch, { body: { ref: "other" } })).rejects.toThrow("not an allowed write");
    await expect(http.request("POST", dispatch, { body: { ref: "main", inputs: { x: "1" } } })).rejects.toThrow("not an allowed write");
    await expect(http.request("POST", dispatch)).rejects.toThrow("not an allowed write");
    const gql = (c as unknown as { http: { graphql(q: string, v: object, m: boolean): Promise<unknown> } }).http;
    await expect(gql.graphql("mutation { x }", {}, true)).rejects.toThrow("GraphQL mutation");
    expect(s.seen.length).toBe(before);
  });

  test("releaseWaiting: a cron run's release job still queued", async () => {
    const { c } = await connect([
      { match: /\/actions\/workflows\/tick\.yml\/runs\?/, body: { workflow_runs: [{ id: 5, status: "completed" }, { id: 6, status: "in_progress" }] } },
      { match: /\/actions\/runs\/6\/jobs/, body: { jobs: [{ name: "Queue tick", status: "in_progress" }, { name: "Release advance", status: "queued" }] } },
    ]);
    expect(await c.releaseWaiting()).toBe(true);
    const idle = await connect([
      { match: /\/actions\/workflows\/tick\.yml\/runs\?/, body: { workflow_runs: [{ id: 6, status: "in_progress" }] } },
      { match: /\/actions\/runs\/6\/jobs/, body: { jobs: [{ name: "Queue tick", status: "queued" }, { name: "Release advance", status: "in_progress" }] } },
    ]);
    expect(await idle.c.releaseWaiting()).toBe(false);
  });

  test("the allowed writes still go through: issues and GraphQL queries", async () => {
    const { c, s } = await connect([
      { method: "POST", match: /\/issues$/, status: 201, body: { number: 9 } },
      { method: "PATCH", match: /\/issues\/9$/, body: {} },
    ]);
    expect(await c.createIssue("paused", "why", ["pause"])).toBe(9);
    await c.updateIssueBody(9, "x");
    expect(s.seen.filter((x) => x.method !== "GET").map((x) => x.method)).toEqual(["POST", "PATCH"]);
  });
});

describe("review fixes (client)", () => {
  const ZERO = "0".repeat(40);

  test("#1: the zero OID is refused for every ref write, before any request", async () => {
    const { c, s } = await client([]);
    const before = s.seen.length;
    await expect(c.updateRef("main", sha("B"), ZERO)).rejects.toThrow("not a real object id");
    await expect(c.updateRef("main", ZERO, sha("Q"))).rejects.toThrow("not a real object id");
    await expect(c.createRef("queue/4", ZERO)).rejects.toThrow("not a real object id");
    await expect(c.merge("qlander-build/4", ZERO, "m")).rejects.toThrow("not a real object id");
    expect(s.seen.length).toBe(before);
  });

  test("a run list shorter than total_count, cut by the page limit, or without a total, is incomplete", async () => {
    const run = (id: number) => ({ id, run_attempt: 1, path: "p", event: "push", head_branch: "main", head_sha: sha("h"), status: "completed", conclusion: "success", repository: { id: TARGET }, head_repository: { id: TARGET }, created_at: "t", run_started_at: "t" });
    const { c } = await client([
      { match: new RegExp(sha("h1")), body: { total_count: 2, workflow_runs: [run(1)] } },
      { match: new RegExp(sha("h2")), body: { total_count: 1, workflow_runs: [run(1)] } },
      { match: new RegExp(sha("h3")), body: { workflow_runs: [run(1)] } },
    ]);
    const at = (x: string) => c.listRuns({ headSha: sha(x) });
    expect((await at("h1")).truncated).toBe(true);
    expect(await at("h2")).toMatchObject({ truncated: false });
    expect((await at("h3")).truncated).toBe(true);
    const s = new Script([repoRoute, { match: /actions\/runs\?/, body: { total_count: 2, workflow_runs: [run(1)] }, headers: { link: `<https://api.github.com/repos/${TARGET_SLUG}/actions/runs?page=2>; rel="next"` } }]);
    const cut = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "read", fetch: s.fetch, sleep: noSleep, maxPages: 1 });
    expect((await cut.listRuns({ headSha: sha("h") })).truncated).toBe(true);
  });

  test("#3: a job list shorter than total_count, or cut by the page limit, is incomplete", async () => {
    const j = (n: number) => ({ id: n, name: `job ${n}`, status: "completed", conclusion: "success", html_url: "u", started_at: "t" });
    const { c } = await client([
      { match: /runs\/5\/jobs/, body: { total_count: 3, jobs: [j(1), j(2)] } },
      { match: /runs\/6\/jobs/, body: { total_count: 2, jobs: [j(1), j(2)] } },
      { match: /runs\/7\/jobs/, body: { jobs: [j(1)] } },
    ]);
    expect((await c.listJobs(5)).truncated).toBe(true);
    expect(await c.listJobs(6)).toMatchObject({ truncated: false });
    expect((await c.listJobs(7)).truncated).toBe(true); // no total_count: cannot vouch
  });

  test("#5: label provenance is unknown when the event history is cut", async () => {
    const s = new Script([
      repoRoute,
      { match: /issues\/3\/events/, body: [{ id: 1, event: "labeled", label: { name: "ready" }, actor: { login: "github-actions[bot]" }, created_at: "2026-10-01T00:00:00Z" }], headers: { link: `<https://api.github.com/repos/${TARGET_SLUG}/issues/3/events?page=2>; rel="next"` } },
    ]);
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: s.fetch, sleep: noSleep, maxPages: 1 });
    expect(await c.latestLabelEvent(3, "ready")).toBe("unknown");
  });

  test("the newest label application counts even without a readable actor; an older attributable one never stands in", async () => {
    const ev = (id: number, at: string, actor: { login: string } | null, name = "ready") => ({ id, event: "labeled", label: { name }, actor, created_at: at });
    const { c } = await client([
      // Listed out of order: the newest (by time) has no actor.
      { match: /issues\/3\/events/, body: [ev(9, "2026-10-02T00:00:00Z", null), ev(1, "2026-10-01T00:00:00Z", { login: "writer" }), ev(10, "2026-10-03T00:00:00Z", { login: "other" }, "other-label")] },
      { match: /issues\/4\/events/, body: [ev(2, "2026-10-02T00:00:00Z", { login: "writer" }), ev(1, "2026-10-01T00:00:00Z", null)] },
    ]);
    expect(await c.latestLabelEvent(3, "ready")).toEqual({ id: 9, actor: null, at: "2026-10-02T00:00:00Z" });
    expect(await c.latestLabelEvent(4, "ready")).toEqual({ id: 2, actor: "writer", at: "2026-10-02T00:00:00Z" });
  });

  test("#6: delete swallows only confirmed absence", async () => {
    const del = { method: "DELETE", match: /git\/refs\/heads\/queue\/4$/, status: 422, body: { message: "Reference update failed" } };
    const still = await client([del, { match: /git\/ref\/heads\/queue\/4$/, body: { object: { sha: sha("q") } } }]);
    await expect(still.c.deleteRef("queue/4")).rejects.toMatchObject({ kind: "validation" });
    const gone = await client([del, { match: /git\/ref\/heads\/queue\/4$/, status: 404, body: { message: "Not Found" } }]);
    await expect(gone.c.deleteRef("queue/4")).resolves.toBeUndefined();
    const notFound = await client([{ method: "DELETE", match: /git\/refs\/heads\/queue\/4$/, status: 404, body: { message: "Not Found" } }]);
    await expect(notFound.c.deleteRef("queue/4")).resolves.toBeUndefined();
    const forbidden = await client([{ method: "DELETE", match: /git\/refs\/heads\/queue\/4$/, status: 403, body: { message: "Resource not accessible" } }]);
    await expect(forbidden.c.deleteRef("queue/4")).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("state ref client (the store of record)", () => {
  const STATE_REF = `refs/heads/${NAMES.stateBranch}`;
  test("the store of record is the protected branch qlander-state (the config's queue.stateBranch)", () => {
    expect(STATE_REF).toBe("refs/heads/qlander-state");
  });

  const lsRepo: Route = { match: pathRe(`/repos/${CONTROL_SLUG}`), body: { id: LS, node_id: "R_ls" } };
  const connect = (s: Script) => StateRefClient.connect({ stateBranches: STATE_BRANCHES, branch: NAMES.stateBranch, token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: s.fetch, sleep: noSleep });

  test("refuses another repository, and reads a missing ref as null", async () => {
    const wrong = new Script([{ match: pathRe(`/repos/${CONTROL_SLUG}`), body: { id: 5, node_id: "x" } }]);
    await expect(connect(wrong)).rejects.toThrow("expected");
    const s = new Script([lsRepo, { match: /git\/ref\/heads\/qlander-state$/, status: 404, body: { message: "Not Found" } }]);
    expect(await (await connect(s)).read()).toBeNull();
  });

  test("reads state.json from the exact commit the ref points at", async () => {
    const v = sha("v1");
    const s = new Script([
      lsRepo,
      { match: /git\/ref\/heads\/qlander-state$/, body: { object: { sha: v, type: "commit" } } },
      { match: /contents\/state\.json\?ref=/, body: { type: "file", encoding: "base64", content: Buffer.from('{"v":4}').toString("base64") }, headers: { date: "Wed, 21 Oct 2026 12:34:56 GMT" } },
    ]);
    expect(await (await connect(s)).read()).toEqual({ version: v, text: '{"v":4}', serverTime: new Date("2026-10-21T12:34:56Z") });
    expect(s.seen.at(-1)!.url).toContain(`ref=${v}`);
  });

  test("cas: commits on top of before, then updateRefs with beforeOid and force false", async () => {
    const before = sha("v1");
    const s = new Script([
      lsRepo,
      { method: "POST", match: /git\/blobs$/, status: 201, body: { sha: sha("blob") } },
      { method: "POST", match: /git\/trees$/, status: 201, body: { sha: sha("tree") } },
      { method: "POST", match: /git\/commits$/, status: 201, body: { sha: sha("v2") } },
      { method: "POST", match: /\/graphql$/, body: { data: { updateRefs: { clientMutationId: null } } } },
    ]);
    expect(await (await connect(s)).cas(before, "{}")).toBe(sha("v2"));
    const commit = s.seen.find((x) => x.url.endsWith("/git/commits"))!;
    expect(commit.body).toMatchObject({ parents: [before], tree: sha("tree") });
    expect(s.seen.at(-1)!.body).toMatchObject({ variables: { input: { repositoryId: "R_ls", refUpdates: [{ name: STATE_REF, beforeOid: before, afterOid: sha("v2"), force: false }] } } });
  });

  test("cas refuses a zero or malformed before, without a request", async () => {
    const s = new Script([lsRepo]);
    const c = await connect(s);
    const n = s.seen.length;
    await expect(c.cas("0".repeat(40), "{}")).rejects.toThrow("not a real object id");
    expect(s.seen.length).toBe(n);
  });
});

describe("repository_dispatch (lifecycle hooks)", () => {
  test("dispatch posts event_type and client_payload to the target repo; a failure is not retried", async () => {
    const { c, s } = await client([{ method: "POST", match: /\/dispatches$/, status: 204 }]);
    await c.dispatch("qlander", { event: "landed", idempotencyKey: "k" });
    expect(s.seen.at(-1)).toEqual({ method: "POST", url: `https://api.github.com/repos/${TARGET_SLUG}/dispatches`, body: { event_type: "qlander", client_payload: { event: "landed", idempotencyKey: "k" } } });
    const bad = await client([{ method: "POST", match: /\/dispatches$/, status: 500 }]);
    const before = bad.s.seen.length;
    await expect(bad.c.dispatch("qlander", {})).rejects.toMatchObject({ kind: "server" });
    expect(bad.s.seen.length - before).toBe(1);
  });

  test("GitHub's limits are checked before any request, and only the queue role may dispatch", async () => {
    const { c, s } = await client([]);
    const before = s.seen.length;
    await expect(c.dispatch("x".repeat(101), {})).rejects.toThrow("bad event_type");
    await expect(c.dispatch("has space", {})).rejects.toThrow("bad event_type");
    await expect(c.dispatch("ok", Object.fromEntries([...Array(11).keys()].map((i) => [`k${i}`, i])))).rejects.toThrow("more than 10");
    await expect(c.dispatch("ok", { big: "x".repeat(70_000) })).rejects.toThrow("64 KB");
    expect(s.seen.length).toBe(before);
    for (const role of ["release", "read"] as const) {
      const r = await client([], role);
      await expect(r.c.dispatch("ok", {})).rejects.toThrow(/may not|read-only/);
    }
  });

  test("getPr reports the author's login", async () => {
    const pr = { number: 5, state: "open", draft: false, merged: false, mergeable: true, head: { sha: sha("h"), ref: "f", repo: { id: TARGET } }, base: { ref: "main", repo: { id: TARGET } }, labels: [], user: { login: "octo-cat", id: 42 } };
    const { c } = await client([{ match: /\/pulls\/5$/, body: pr }]);
    expect((await c.getPr(5)).user?.login).toBe("octo-cat");
  });

  test("getPr reports the title, and leaves it out when it is not a string", async () => {
    const pr = (n: number, title: unknown) => ({ number: n, state: "open", draft: false, merged: false, mergeable: true, head: { sha: sha("h"), ref: "f", repo: { id: TARGET } }, base: { ref: "main", repo: { id: TARGET } }, labels: [], user: null, title });
    const { c } = await client([
      { match: /\/pulls\/5$/, body: pr(5, "Add a widget") },
      { match: /\/pulls\/6$/, body: pr(6, null) },
    ]);
    expect((await c.getPr(5)).title).toBe("Add a widget");
    expect("title" in (await c.getPr(6))).toBe(false);
  });
});

describe("target job logs (flaky tracking)", () => {
  test("follows the redirect without the token, keeps the tail, and classifies failures", async () => {
    const seen: { url: string; auth: string | null; redirect: string | undefined }[] = [];
    const routes = (status: number) =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
        if (url.endsWith(`/repos/${TARGET_SLUG}`)) return new Response(JSON.stringify({ id: TARGET, node_id: "R" }), { status: 200 });
        if (url.endsWith("/actions/jobs/77/logs")) return status === 302 ? new Response(null, { status: 302, headers: { location: "https://blob.example/log?sig=1" } }) : new Response("{}", { status });
        if (url.startsWith("https://blob.example/")) return new Response("x".repeat(10) + "FAILED tests/a.py::t", { status: 200 });
        return new Response("{}", { status: 599 });
      }) as typeof fetch;
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: routes(302), sleep: noSleep });
    expect(await c.jobLog(77)).toEndWith("FAILED tests/a.py::t");
    expect(seen.at(-2)).toMatchObject({ auth: "Bearer t", redirect: "manual" });
    expect(seen.at(-1)).toMatchObject({ url: "https://blob.example/log?sig=1", auth: null });
    await expect(c.jobLog(0)).rejects.toThrow("not a job id");
    const gone = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: routes(404), sleep: noSleep });
    await expect(gone.jobLog(77)).rejects.toMatchObject({ kind: "not_found" });
  });
});

describe("Http response bodies", () => {
  test("a body that fails mid-read is a network error, not a raw exception", async () => {
    const broken = (async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("{"));
            c.error(new TypeError("socket closed"));
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const http = new Http({ token: "t", fetch: broken });
    await expect(http.request("GET", "/x")).rejects.toMatchObject({ kind: "network" });
  });
});

describe("Http.download", () => {
  const redirecting = (blob: (init?: RequestInit) => Promise<Response>) =>
    (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith("https://blob.example/") ? blob(init) : new Response(null, { status: 302, headers: { location: "https://blob.example/l" } })) as typeof fetch;

  test("keeps only the tail of a long body", async () => {
    const big = `${"a".repeat(3_000_000)}END`;
    const http = new Http({ token: "t", fetch: redirecting(async () => new Response(big)) });
    const out = await http.download("x", 1000, 5_000);
    expect(out.length).toBe(1000);
    expect(out.endsWith("aEND")).toBe(true);
  });

  test("a stalled body fails as a network error within its deadline", async () => {
    const stalled = (init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("partial"));
              init?.signal?.addEventListener("abort", () => c.error(new DOMException("timed out", "TimeoutError")));
            },
          }),
        ),
      );
    const http = new Http({ token: "t", fetch: redirecting(stalled) });
    await expect(http.download("x", 1000, 50)).rejects.toMatchObject({ kind: "network" });
  });
});
