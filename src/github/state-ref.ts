// The state stores (DESIGN.md §3.1, §15): state.json in a commit on a state
// branch in the control repo (queue.stateBranch for the queue,
// release.stateBranch for the release job), written as new commits and
// moved with GraphQL updateRefs (beforeOid = the commit read, force false).
// A ruleset on each branch lets only the qlander-state App create, update
// or delete it; this client runs with that App's token.

import { BRANCH_NAME_RE, isRealSha } from "../validate";
import type { StateRefApi } from "./api";
import { GitHubError, Http, type HttpOptions } from "./http";

const FILE = "state.json";

function bad(msg: string): never {
  throw new GitHubError("validation", null, msg);
}
const oid = (s: unknown, what: string): string => (isRealSha(s) ? s : bad(`${what}: not a real object id`));

export class StateRefClient implements StateRefApi {
  private constructor(
    private readonly http: Http,
    private readonly path: string,
    private readonly nodeId: string,
    private readonly branch: string,
  ) {}

  private get ref(): string {
    return `refs/heads/${this.branch}`;
  }

  /**
   * `stateBranches` are the only branches this client may touch (the config's
   * two state branches, each protected by its own ruleset); `branch` is the
   * one this job owns.
   */
  static async connect(o: HttpOptions & { owner: string; repo: string; repoId: number; branch: string; stateBranches: readonly string[] }): Promise<StateRefClient> {
    const branch = o.branch;
    if (!o.stateBranches.includes(branch) || !BRANCH_NAME_RE.test(branch)) bad(`${branch} is not a qlander state branch`);
    const http = new Http(o);
    const path = `repos/${o.owner}/${o.repo}`;
    const res = await http.request<{ id: number; node_id: string }>("GET", path);
    if (res.json.id !== o.repoId) bad(`${o.owner}/${o.repo} has id ${res.json.id}, expected ${o.repoId}`);
    return new StateRefClient(http, path, res.json.node_id, branch);
  }

  private static serverTime(headers: Headers): Date {
    const t = Date.parse(headers.get("date") ?? "");
    if (Number.isNaN(t)) bad("no usable Date header from GitHub");
    return new Date(t);
  }

  async serverNow(): Promise<Date> {
    const r = await this.http.request("GET", this.path);
    return StateRefClient.serverTime(r.headers);
  }

  async read(): Promise<{ version: string; text: string; serverTime: Date } | null> {
    let version: string;
    try {
      const r = await this.http.request<{ object: { sha: string; type: string } }>("GET", `${this.path}/git/ref/heads/${this.branch}`);
      if (r.json.object.type !== "commit") bad("state ref does not point at a commit");
      version = oid(r.json.object.sha, "state ref");
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
    const c = await this.http.request<{ type: string; encoding: string; content: string }>("GET", `${this.path}/contents/${FILE}`, { query: { ref: version } });
    if (c.json.type !== "file" || c.json.encoding !== "base64") bad("state.json is not a base64 file");
    return { version, text: Buffer.from(c.json.content, "base64").toString("utf8"), serverTime: StateRefClient.serverTime(c.headers) };
  }

  private async commit(text: string, parents: string[]): Promise<string> {
    const blob = await this.http.request<{ sha: string }>("POST", `${this.path}/git/blobs`, { body: { content: text, encoding: "utf-8" } });
    const tree = await this.http.request<{ sha: string }>("POST", `${this.path}/git/trees`, {
      body: { tree: [{ path: FILE, mode: "100644", type: "blob", sha: oid(blob.json.sha, "blob") }] },
    });
    const commit = await this.http.request<{ sha: string }>("POST", `${this.path}/git/commits`, {
      body: { message: "qlander state", tree: oid(tree.json.sha, "tree"), parents },
    });
    return oid(commit.json.sha, "commit");
  }

  async create(text: string): Promise<string> {
    const c = await this.commit(text, []);
    await this.http.request("POST", `${this.path}/git/refs`, { body: { ref: this.ref, sha: c } }); // 422 "already exists" → conflict
    return c;
  }

  async cas(before: string, text: string): Promise<string> {
    const c = await this.commit(text, [oid(before, "before")]);
    await this.http.graphql(
      "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
      { input: { repositoryId: this.nodeId, refUpdates: [{ name: this.ref, beforeOid: before, afterOid: c, force: false }] } },
      true,
    );
    return c;
  }
}
