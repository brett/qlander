// verify-sandbox: direct REST and GraphQL calls on the sandbox repo, for what
// the production clients never do and refuse locally: reading any branch,
// making probe commits, and the reset attempts the rulesets must refuse.
// Every write here goes to the one repo this object was connected to, after
// its id was checked.

import { EMPTY_TREE } from "../github/target";
import { GitHubError, Http, type HttpOptions } from "../github/http";
import { isRealSha, ZERO_SHA } from "../validate";

const UPDATE_REFS = "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }";

export interface Sandbox {
  owner: string;
  repo: string;
  repoId: number;
}

function bad(msg: string): never {
  throw new GitHubError("validation", null, msg);
}
const oid = (s: unknown, what: string): string => (isRealSha(s) ? s : bad(`${what}: not a real object id`));

export class SandboxRepo {
  private constructor(
    readonly http: Http,
    readonly path: string,
    readonly nodeId: string,
  ) {}

  /** Connect and verify the repository id before anything else. */
  static async connect(o: HttpOptions & Sandbox): Promise<SandboxRepo> {
    const http = new Http(o);
    const path = `repos/${o.owner}/${o.repo}`;
    const res = await http.request<{ id: number; node_id: string }>("GET", path);
    if (res.json.id !== o.repoId) bad(`${o.owner}/${o.repo} has id ${res.json.id}, expected ${o.repoId}`);
    return new SandboxRepo(http, path, res.json.node_id);
  }

  /** Any branch's commit, or null when it is absent. */
  async ref(branch: string): Promise<string | null> {
    try {
      return oid((await this.http.request<{ object: { sha: string } }>("GET", `${this.path}/git/ref/heads/${branch}`)).json.object.sha, branch);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  async commit(sha: string): Promise<{ tree: string; parents: string[] }> {
    const c = (await this.http.request<{ tree: { sha: string }; parents: { sha: string }[] }>("GET", `${this.path}/git/commits/${oid(sha, "commit")}`)).json;
    return { tree: c.tree.sha, parents: c.parents.map((p) => p.sha) };
  }

  /** A new commit with `parent`'s tree on top of it: a fast-forward of `parent` that changes no file. */
  async childCommit(parent: string, message: string): Promise<string> {
    const { tree } = await this.commit(parent);
    return oid((await this.http.request<{ sha: string }>("POST", `${this.path}/git/commits`, { body: { message, tree, parents: [parent] } })).json.sha, "commit");
  }

  /** An empty-tree commit, as an epoch commit is (docs/deployment.md §3.4). */
  async emptyTreeCommit(parents: string[], message: string): Promise<string> {
    return oid((await this.http.request<{ sha: string }>("POST", `${this.path}/git/commits`, { body: { message, tree: EMPTY_TREE, parents } })).json.sha, "commit");
  }

  /** GraphQL updateRefs, exactly as given (force included). */
  async updateRefs(entries: { branch: string; before: string; after: string; force: boolean }[]): Promise<void> {
    const refUpdates = entries.map((e) => ({ name: `refs/heads/${e.branch}`, beforeOid: e.before, afterOid: e.after, force: e.force }));
    await this.http.graphql(UPDATE_REFS, { input: { repositoryId: this.nodeId, refUpdates } }, true);
  }

  async createRef(branch: string, sha: string): Promise<void> {
    await this.http.request("POST", `${this.path}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: oid(sha, "sha") } });
  }

  async patchRef(branch: string, sha: string, force: boolean): Promise<void> {
    await this.http.request("PATCH", `${this.path}/git/refs/heads/${branch}`, { body: { sha: oid(sha, "sha"), force } });
  }

  async deleteRef(branch: string): Promise<void> {
    await this.http.request("DELETE", `${this.path}/git/refs/heads/${branch}`);
  }

  /** Workflow runs GitHub has created for a commit. */
  async runsFor(sha: string): Promise<number> {
    const r = await this.http.request<{ total_count: number }>("GET", `${this.path}/actions/runs`, { query: { head_sha: oid(sha, "sha"), per_page: 1 } });
    if (!Number.isSafeInteger(r.json.total_count)) bad("no total_count in the run list");
    return r.json.total_count;
  }
}

/** The repos an installation token can reach (GET /installation/repositories). */
export async function tokenRepos(o: HttpOptions): Promise<{ id: number; fullName: string }[]> {
  const { items, truncated } = await new Http(o).paginate("installation/repositories", {}, (p) =>
    ((p as { repositories?: { id: number; full_name: string }[] }).repositories ?? []).map((r) => ({ id: r.id, fullName: r.full_name })),
  );
  if (truncated) bad("too many repositories to list");
  return items;
}

export { ZERO_SHA };

// ---------------------------------------------------------------- reading after a write
//
// GitHub can serve a ref read from a replica that has not yet seen a write
// made a moment earlier, so a read can show the ref's previous value for a
// while. A ref here only moves forward, so a lagging read shows an older
// value, never a newer one. Two rules follow:
//   - after a write that should have landed, poll until the new value shows
//     (bounded), and record how long it took;
//   - after a write that must not have landed, one read proves nothing (it
//     may be the lag hiding the write). Either prove the value with a no-op
//     updateRefs {ref: X→X} from an identity allowed to write the ref
//     (GitHub checks beforeOid on the write path, which does not lag), or
//     require every read across a window to show the expected value.

export interface ReadTiming {
  /** How long a landed write may take to show (default 10 s). */
  settleMs?: number;
  /** How long an unproven "unchanged" must hold (default 10 s). */
  windowMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Every settle that needed more than one read: what, and how long it took. */
  lags?: { what: string; ms: number; reads: number }[];
}

const sleepOf = (t: ReadTiming) => t.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

/** Poll `read` until it returns `want`, with backoff, for up to settleMs. A lag is recorded in `t.lags`. */
export async function settle(what: string, read: () => Promise<string | null>, want: string | null, t: ReadTiming = {}): Promise<{ problems: string[]; lagMs: number }> {
  const now = t.now ?? Date.now;
  const start = now();
  const limit = t.settleMs ?? 10_000;
  let got = await read();
  let reads = 1;
  for (let wait = 250; got !== want && now() - start < limit; wait = Math.min(wait * 2, 2000)) {
    await sleepOf(t)(wait);
    got = await read();
    reads++;
  }
  const lagMs = now() - start;
  if (reads > 1 && got === want) t.lags?.push({ what, ms: lagMs, reads });
  return { problems: got === want ? [] : [`${what} is at ${got ?? "(absent)"}, expected ${want ?? "(absent)"} (after ${lagMs} ms and ${reads} reads)`], lagMs };
}

/**
 * After a write that must not have landed: `branch` is at `want`. With a
 * prover (a SandboxRepo whose identity may write the branch) and a present
 * `want`, a no-op updateRefs proves it; otherwise every read across
 * windowMs must show it. Use the window only on a ref that was not
 * written a moment before: there, a lag and a forbidden write look alike.
 */
export async function holds(what: string, read: () => Promise<string | null>, want: string | null, t: ReadTiming = {}, prove?: { repo: SandboxRepo; branch: string }): Promise<string[]> {
  if (prove && want !== null) {
    try {
      await prove.repo.updateRefs([{ branch: prove.branch, before: want, after: want, force: false }]);
      return [];
    } catch (e) {
      return [`${what} is not at ${want}: a no-op updateRefs {${want}→${want}} was rejected (${e instanceof Error ? e.message : String(e)})`];
    }
  }
  // Strict: every read must show `want`. A contrary read is never settled away, because
  // a lagging read of the value before `want` looks exactly like a forbidden reset to it.
  const now = t.now ?? Date.now;
  const start = now();
  const limit = t.windowMs ?? 10_000;
  for (let reads = 1; ; reads++) {
    const got = await read();
    if (got !== want) return [`${what} is at ${got ?? "(absent)"}, expected ${want ?? "(absent)"} (read ${reads}, after ${now() - start} ms)`];
    if (now() - start >= limit) return [];
    await sleepOf(t)(1000);
  }
}

/**
 * A ref's current value, confirmed: with a prover, a value is returned only
 * once a no-op updateRefs accepts it; without one, only once every read
 * across windowMs agrees. Bounded by settleMs (plus one window); throws if
 * no value is confirmed in time.
 */
export async function current(what: string, read: () => Promise<string | null>, t: ReadTiming = {}, prove?: { repo: SandboxRepo; branch: string }): Promise<string | null> {
  const now = t.now ?? Date.now;
  const start = now();
  for (let wait = 250; ; wait = Math.min(wait * 2, 2000)) {
    const v = await read();
    if ((await holds(what, read, v, t, v === null ? undefined : prove)).length === 0) {
      if (now() - start > 0) t.lags?.push({ what: `${what} (confirming the current value)`, ms: now() - start, reads: 0 });
      return v;
    }
    if (now() - start >= (t.settleMs ?? 10_000)) throw new Error(`could not confirm the current value of ${what} within ${t.settleMs ?? 10_000} ms`);
    await sleepOf(t)(wait);
  }
}
