// An in-memory GitHub at the HTTP level, for verify-sandbox (src/sandbox/):
// a sandbox repo with git objects, refs, PRs, rulesets enforced per actor,
// and GraphQL updateRefs applied atomically, so the production clients and
// the reset attempts run unchanged against it. Each token is one actor.

import { createHash } from "node:crypto";
import { EMPTY_TREE } from "../src/github/target";
import { ZERO_SHA } from "../src/validate";

export type Actor = { type: "Integration" | "User"; id: number };
export interface Ruleset {
  id: number;
  name: string;
  include: string[];
  rules: string[];
  bypass: Actor[];
}

export const SANDBOX = { owner: "acme", repo: "sandbox", repoId: 4242 };
export const OTHER_REPO = { id: 4343, full_name: "acme/other" };
export const APPS = { queue: 101, release: 102, state: 103 } as const;
export const ADMIN_ID = 7;

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", date: new Date().toUTCString() } });
const fail = (status: number, message: string) => json(status, { message });

function globRe(p: string): RegExp {
  const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`);
}

export class FakeSandbox {
  actors = new Map<string, Actor>([
    ["queue-token", { type: "Integration", id: APPS.queue }],
    ["release-token", { type: "Integration", id: APPS.release }],
    ["state-token", { type: "Integration", id: APPS.state }],
    ["admin-token", { type: "User", id: ADMIN_ID }],
  ]);
  /** The repos each installation token reaches. */
  tokenRepos = new Map<string, { id: number; full_name: string }[]>();
  commits = new Map<string, { tree: string; parents: string[]; message: string; verified: boolean }>();
  trees = new Map<string, Map<string, string>>([[EMPTY_TREE, new Map()]]);
  blobs = new Map<string, string>();
  refs = new Map<string, string>();
  prs = new Map<number, { head: string; headSha: string; base: string; state: "open" | "closed" }>();
  rulesets: Ruleset[];
  /** Workflow runs per commit (check 4). */
  runs = new Map<string, number>();
  /** Fault: updateRefs skips an unchanged entry instead of checking its beforeOid. */
  skipUnchanged = false;
  /** Fault: refuse an updateRefs call for a reason of its own (and optionally a GraphQL error type). */
  refuseUpdate: ((entries: { branch: string; before: string; after: string }[]) => { message: string; type?: string } | null) | null = null;
  /**
   * Read-after-write lag: after a ref changes, its next `lagReads` REST reads
   * still return the previous value (as a lagging replica does). Writes and
   * updateRefs' beforeOid checks always see the real value.
   */
  lagReads = 0;
  private lagging = new Map<string, { value: string | null; left: number }>();
  /** A virtual clock for the tests: sleep advances it. */
  clock = 0;
  readonly sleep = async (ms: number) => { this.clock += ms; };
  readonly now = () => this.clock;
  private changed(branch: string, before: string | null): void {
    if (this.lagReads > 0) this.lagging.set(branch, { value: before, left: this.lagReads });
  }
  /** A REST ref read, through the lag. */
  readRef(branch: string): string | null {
    const l = this.lagging.get(branch);
    if (l && l.left > 0) {
      l.left--;
      return l.value;
    }
    return this.refs.get(branch) ?? null;
  }
  /** Whether the user token is a repo admin. */
  adminIsAdmin = true;
  /** Tokens without Contents: write: every write is a 403. */
  readOnly = new Set<string>();
  /** Every write request, for "nothing was written" assertions. */
  writes: string[] = [];
  private seq = 0;
  private prSeq = 0;

  constructor() {
    const b = this.hash("blob", "hello\n");
    this.blobs.set(b, "hello\n");
    const t = this.hash("tree", "README.md", b);
    this.trees.set(t, new Map([["README.md", b]]));
    const c = this.hash("commit", "init");
    this.commits.set(c, { tree: t, parents: [], message: "init", verified: true });
    this.refs.set("main", c);
    for (const tok of ["queue-token", "release-token", "state-token"]) this.tokenRepos.set(tok, [{ id: SANDBOX.repoId, full_name: `${SANDBOX.owner}/${SANDBOX.repo}` }]);
    const app = (id: number): Actor => ({ type: "Integration", id });
    this.rulesets = [
      { id: 1, name: "main-integrity", include: ["~DEFAULT_BRANCH"], rules: ["required_signatures", "non_fast_forward", "deletion"], bypass: [] },
      { id: 2, name: "main-landing", include: ["~DEFAULT_BRANCH"], rules: ["update", "pull_request"], bypass: [{ type: "User", id: ADMIN_ID }, app(APPS.queue)] },
      { id: 3, name: "queue-refs", include: ["refs/heads/queue/**", "refs/heads/qlander-build/**"], rules: ["creation", "update", "deletion"], bypass: [app(APPS.queue)] },
      { id: 4, name: "state-branches", include: ["refs/heads/qlander-state", "refs/heads/qlander-release-state"], rules: ["creation", "update", "deletion", "non_fast_forward"], bypass: [app(APPS.state)] },
      { id: 5, name: "epoch-write-queue", include: ["refs/heads/qlander-epoch/queue"], rules: ["creation", "update", "deletion"], bypass: [app(APPS.queue)] },
      { id: 6, name: "epoch-write-release", include: ["refs/heads/qlander-epoch/release"], rules: ["creation", "update", "deletion"], bypass: [app(APPS.release)] },
      { id: 7, name: "epoch-integrity", include: ["refs/heads/qlander-epoch/**"], rules: ["non_fast_forward", "deletion"], bypass: [] },
    ];
  }

  private hash(...parts: string[]): string {
    return createHash("sha1").update(`${parts.join("\0")}\0${++this.seq}`).digest("hex");
  }

  isAncestor(a: string, b: string): boolean {
    const todo = [b];
    const seen = new Set<string>();
    while (todo.length) {
      const x = todo.pop()!;
      if (x === a) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      todo.push(...(this.commits.get(x)?.parents ?? []));
    }
    return false;
  }

  private matches(r: Ruleset, branch: string): boolean {
    return r.include.some((p) => (p === "~DEFAULT_BRANCH" ? branch === "main" : globRe(p).test(`refs/heads/${branch}`)));
  }

  /** Why `actor` may not make this ref write, or null. */
  violation(actor: Actor, branch: string, op: "create" | "update" | "delete", ff: boolean): string | null {
    for (const r of this.rulesets) {
      if (!this.matches(r, branch) || r.bypass.some((b) => b.type === actor.type && b.id === actor.id)) continue;
      const hit = r.rules.find((rule) => (rule === "creation" && op === "create") || ((rule === "update" || rule === "pull_request") && op === "update") || (rule === "deletion" && op === "delete") || (rule === "non_fast_forward" && op === "update" && !ff));
      if (hit) return `Repository rule violations found: ${r.name} (${hit}) on refs/heads/${branch}`;
    }
    return null;
  }

  /** One ref write; returns an error message, or null after applying it. */
  write(actor: Actor, branch: string, after: string | null, force: boolean): string | null {
    const before = this.refs.get(branch) ?? null;
    if (after !== null && !this.commits.has(after)) return "Object does not exist";
    const op = before === null ? "create" : after === null ? "delete" : "update";
    const ff = before !== null && after !== null && this.isAncestor(before, after);
    if (op === "update" && !ff && !force) return "Update is not a fast forward";
    const v = this.violation(actor, branch, op, ff);
    if (v) return v;
    if (after === null) this.refs.delete(branch);
    else this.refs.set(branch, after);
    this.changed(branch, before);
    return null;
  }

  private repoPath = `repos/${SANDBOX.owner}/${SANDBOX.repo}`;

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const token = String((init?.headers as Record<string, string>)?.authorization ?? "").replace(/^Bearer /, "");
    const actor = this.actors.get(token);
    if (!actor) return fail(401, "Bad credentials");
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (method !== "GET" && this.readOnly.has(token)) return fail(403, "Resource not accessible by integration");
    const path = url.pathname.replace(/^\//, "");
    if (method !== "GET") this.writes.push(`${method} ${path}`);

    if (path === "installation/repositories") {
      const repos = this.tokenRepos.get(token);
      return repos ? json(200, { total_count: repos.length, repositories: repos }) : fail(403, "not an installation token");
    }
    if (path === "graphql") return this.graphql(actor, body);
    if (path === "user") return actor.type === "User" ? json(200, { login: "admin", id: actor.id }) : fail(403, "not a user");
    if (path === this.repoPath) return json(200, { id: SANDBOX.repoId, node_id: "R_sandbox", ...(actor.type === "User" ? { permissions: { admin: this.adminIsAdmin } } : {}) });
    if (!path.startsWith(`${this.repoPath}/`)) return fail(404, "Not Found");
    const rest = path.slice(this.repoPath.length + 1);
    let m: RegExpExecArray | null;

    if (method === "GET" && (m = /^git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = this.readRef(m[1]!);
      return sha ? json(200, { ref: `refs/heads/${m[1]}`, object: { sha, type: "commit" } }) : fail(404, "Not Found");
    }
    if (method === "GET" && (m = /^git\/commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = this.commits.get(m[1]!);
      return c ? json(200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })) }) : fail(404, "Not Found");
    }
    if (method === "GET" && (m = /^commits\/([0-9a-f]{40})$/.exec(rest))) {
      const c = this.commits.get(m[1]!);
      return c ? json(200, { sha: m[1], parents: c.parents.map((sha) => ({ sha })), commit: { verification: { verified: c.verified, reason: c.verified ? "valid" : "unsigned" } } }) : fail(404, "Not Found");
    }
    if (method === "POST" && rest === "git/blobs") {
      const sha = this.hash("blob", body.content);
      this.blobs.set(sha, body.content);
      return json(201, { sha });
    }
    if (method === "POST" && rest === "git/trees") {
      const files = new Map(body.base_tree ? this.trees.get(body.base_tree) ?? [] : []);
      for (const e of body.tree as { path: string; sha: string }[]) files.set(e.path, e.sha);
      const sha = this.hash("tree", JSON.stringify([...files]));
      this.trees.set(sha, files);
      return json(201, { sha });
    }
    if (method === "POST" && rest === "git/commits") {
      if (!this.trees.has(body.tree)) return fail(422, "Tree SHA does not exist");
      if ((body.parents as string[]).some((p) => !this.commits.has(p))) return fail(422, "Parent SHA does not exist");
      const sha = this.hash("commit", body.message);
      this.commits.set(sha, { tree: body.tree, parents: body.parents, message: body.message, verified: true });
      return json(201, { sha });
    }
    if (method === "POST" && rest === "git/refs") {
      const branch = String(body.ref).replace(/^refs\/heads\//, "");
      if (this.refs.has(branch)) return fail(422, "Reference already exists");
      const e = this.write(actor, branch, body.sha, false);
      return e ? fail(422, e) : json(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if ((m = /^git\/refs\/heads\/(.+)$/.exec(rest)) && (method === "PATCH" || method === "DELETE")) {
      const branch = m[1]!;
      if (!this.refs.has(branch)) return fail(422, "Reference does not exist");
      const e = this.write(actor, branch, method === "DELETE" ? null : body.sha, method === "PATCH" && body.force === true);
      return e ? fail(422, e) : method === "DELETE" ? json(204, null) : json(200, { object: { sha: body.sha } });
    }
    if (method === "POST" && rest === "merges") {
      const baseSha = this.refs.get(body.base);
      if (!baseSha || !this.commits.has(body.head)) return fail(404, "Not Found");
      const files = new Map([...(this.trees.get(this.commits.get(baseSha)!.tree) ?? []), ...(this.trees.get(this.commits.get(body.head)!.tree) ?? [])]);
      const tree = this.hash("tree", JSON.stringify([...files]));
      this.trees.set(tree, files);
      const sha = this.hash("commit", body.commit_message);
      this.commits.set(sha, { tree, parents: [baseSha, body.head], message: body.commit_message, verified: true });
      const e = this.write(actor, body.base, sha, false);
      return e ? fail(409, e) : json(201, { sha });
    }
    if (method === "POST" && rest === "pulls") {
      const headSha = this.refs.get(body.head);
      if (!headSha) return fail(422, "head does not exist");
      const n = ++this.prSeq;
      this.prs.set(n, { head: body.head, headSha, base: body.base, state: "open" });
      return json(201, { number: n });
    }
    if (method === "GET" && (m = /^pulls\/(\d+)$/.exec(rest))) {
      const p = this.prs.get(Number(m[1]));
      if (!p) return fail(404, "Not Found");
      const merged = this.isAncestor(p.headSha, this.refs.get("main")!);
      return json(200, {
        number: Number(m[1]), state: merged ? "closed" : p.state, draft: false, merged, mergeable: null,
        head: { sha: p.headSha, ref: p.head, repo: { id: SANDBOX.repoId } }, base: { ref: p.base, repo: { id: SANDBOX.repoId } }, labels: [], user: { login: "queue[bot]", id: APPS.queue },
      });
    }
    if (method === "GET" && rest === "contents/state.json") {
      const c = this.commits.get(url.searchParams.get("ref") ?? "");
      const blob = c && this.trees.get(c.tree)?.get("state.json");
      return blob ? json(200, { type: "file", encoding: "base64", content: Buffer.from(this.blobs.get(blob)!).toString("base64") }) : fail(404, "Not Found");
    }
    if (method === "GET" && rest === "actions/runs") return json(200, { total_count: this.runs.get(url.searchParams.get("head_sha") ?? "") ?? 0, workflow_runs: [] });
    if (method === "GET" && (m = /^rules\/branches\/(.+)$/.exec(rest))) {
      return json(200, this.rulesets.filter((r) => this.matches(r, m![1]!)).flatMap((r) => r.rules.map((type) => ({ type, ruleset_id: r.id, ruleset_source_type: "Repository" }))));
    }
    if (method === "GET" && (m = /^rulesets\/(\d+)$/.exec(rest))) {
      const r = this.rulesets.find((x) => x.id === Number(m![1]));
      if (!r || actor.type !== "User") return fail(404, "Not Found");
      return json(200, { id: r.id, name: r.name, rules: r.rules.map((type) => ({ type })), bypass_actors: r.bypass.map((b) => ({ actor_type: b.type, actor_id: b.id, bypass_mode: "always" })) });
    }
    return fail(404, `fake: no route for ${method} ${rest}`);
  }) as typeof fetch;

  /** updateRefs: every entry checked first (beforeOid, fast-forward, rules), then all applied, or none. Rejections are untyped, as GitHub's are. */
  private graphql(actor: Actor, body: { query: string; variables: { input: { repositoryId: string; refUpdates: { name: string; beforeOid: string; afterOid: string; force: boolean }[] } } }): Response {
    if (!/updateRefs/.test(body.query)) return json(200, { errors: [{ message: "fake: unsupported query" }] });
    const ups = body.variables.input.refUpdates;
    const err = (message: string) => json(200, { data: { updateRefs: null }, errors: [{ message }] });
    const fault = this.refuseUpdate?.(ups.map((u) => ({ branch: u.name.replace(/^refs\/heads\//, ""), before: u.beforeOid, after: u.afterOid })));
    if (fault) return json(200, { data: { updateRefs: null }, errors: [{ message: fault.message, ...(fault.type ? { type: fault.type } : {}) }] });
    for (const u of ups) {
      const branch = u.name.replace(/^refs\/heads\//, "");
      const cur = this.refs.get(branch) ?? ZERO_SHA;
      if (u.beforeOid === u.afterOid && this.skipUnchanged) continue;
      if (cur !== u.beforeOid) return err("Something went wrong while executing your query.");
      if (u.beforeOid === u.afterOid) continue; // checked, nothing to write
      const after = u.afterOid === ZERO_SHA ? null : u.afterOid;
      if (after !== null && !this.commits.has(after)) return err("Object does not exist");
      const op = cur === ZERO_SHA ? "create" : after === null ? "delete" : "update";
      const ff = op === "update" && this.isAncestor(cur, after!);
      if (op === "update" && !ff && !u.force) return err("Something went wrong while executing your query.");
      const v = this.violation(actor, branch, op, ff);
      if (v) return err(v);
    }
    for (const u of ups) {
      if (u.beforeOid === u.afterOid) continue;
      const branch = u.name.replace(/^refs\/heads\//, "");
      const before = this.refs.get(branch) ?? null;
      if (u.afterOid === ZERO_SHA) this.refs.delete(branch);
      else this.refs.set(branch, u.afterOid);
      this.changed(branch, before);
    }
    return json(200, { data: { updateRefs: { clientMutationId: null } } });
  }

  /** An admin's `git push --force`, through the same rules. */
  pusher(token: string) {
    return {
      forcePush: async (branch: string, sha: string) => {
        const actor = this.actors.get(token)!;
        this.writes.push(`PUSH ${branch}`);
        const e = this.write(actor, branch, sha, true);
        if (e) {
          const { PushRejected } = await import("../src/sandbox/checks");
          throw new PushRejected(` ! [remote rejected] ${sha} -> ${branch} (push declined due to repository rule violations)\n${e}`);
        }
      },
    };
  }
}
