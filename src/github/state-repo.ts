// The control repo, through the workflow's GITHUB_TOKEN (issues: write).
// It holds the state issues and the pause issues (DESIGN.md §3.1, §10). The
// queue job's token also has actions: write, for one thing only: dispatching
// the next tick (DESIGN.md §11.1). Writes are an allowlist enforced here,
// before any request, whichever method asks: every other Actions write is refused.

import { type AssignOn, GitHubError, Http, type HttpOptions, postIssue } from "./http";
import { type Listed, RELEASE_REPORT_MARKER, type StateIssue, type StateRepoApi } from "./api";
import type { IssueComment } from "../types";
import type { ChainApi } from "../wake";
import { CONTROL_BRANCH, RELEASE_JOB_NAME } from "../job-names";
import { listOpenIssuesByLabel } from "./issues";

function bad(msg: string): never {
  throw new GitHubError("validation", null, msg);
}

/** The tick workflow, dispatched on main only (the runner group admits tick.yml@refs/heads/main alone). */
const TICK_WORKFLOW = "tick.yml";

/**
 * An Http whose writes are an allowlist: creating and editing issues, GraphQL
 * queries (never mutations), and the tick dispatch with exactly {ref: main}.
 * Anything else that is not a read, including every other Actions write, is
 * refused before any request.
 */
class GuardedHttp extends Http {
  private readonly allowed: { method: string; re: RegExp }[];
  constructor(
    o: HttpOptions,
    repoPath: string,
    private readonly dispatchPath: string,
  ) {
    super(o);
    const r = `/${repoPath}`.replace(/[.]/g, "\\.");
    this.allowed = [
      { method: "POST", re: new RegExp(`^${r}/issues$`) },
      { method: "PATCH", re: new RegExp(`^${r}/issues/[1-9][0-9]*$`) },
      // The release dispatch mode's candidate report on the status issue (commentIssue checks the body).
      { method: "POST", re: new RegExp(`^${r}/issues/[1-9][0-9]*/comments$`) },
      { method: "POST", re: /^\/graphql$/ },
    ];
  }

  private refuse(method: string, what: string): Promise<never> {
    return Promise.reject(new GitHubError("validation", null, `refusing ${method} ${what}: not an allowed write (the only Actions write is the tick dispatch)`));
  }

  override request<T = unknown>(method: string, path: string, init: { query?: Record<string, string | number | undefined>; body?: unknown } = {}) {
    if (method === "GET" || method === "HEAD") return super.request<T>(method, path, init);
    // No encoded characters and no dot segments: the path checked is the path sent.
    if (/%|(^|\/)\.\.?(\/|$)/.test(path)) return this.refuse(method, path);
    const p = new URL(path.replace(/^\//, ""), "https://api.github.com/").pathname;
    const dispatch = p === this.dispatchPath && method === "POST" && Bun.deepEquals(init.body, { ref: CONTROL_BRANCH }, true) && init.query === undefined;
    if (!dispatch && !this.allowed.some((a) => a.method === method && a.re.test(p))) return this.refuse(method, p);
    return super.request<T>(method, path, init);
  }

  override graphql<T>(query: string, variables: Record<string, unknown>, mutation: boolean): Promise<T> {
    if (mutation) return this.refuse("POST", "a GraphQL mutation");
    return super.graphql<T>(query, variables, mutation);
  }
}

export class StateRepoClient implements StateRepoApi, ChainApi {
  private constructor(
    private readonly http: Http,
    private readonly path: string,
    private readonly owner: string,
    private readonly repo: string,
    private readonly labels: ReadonlySet<string>,
    private readonly assign?: AssignOn,
  ) {}

  /** `labels`: the only issue labels this client lists or creates with (the state mirrors and the pause and alert labels). */
  static async connect(o: HttpOptions & { owner: string; repo: string; repoId: number; labels: readonly string[]; assign?: AssignOn }): Promise<StateRepoClient> {
    const path = `repos/${o.owner}/${o.repo}`;
    const http = new GuardedHttp(o, path, `/${path}/actions/workflows/${TICK_WORKFLOW}/dispatches`);
    const res = await http.request<{ id: number }>("GET", path);
    if (res.json.id !== o.repoId) bad(`${o.owner}/${o.repo} has id ${res.json.id}, expected ${o.repoId}`);
    return new StateRepoClient(http, path, o.owner, o.repo, new Set(o.labels), o.assign);
  }

  /** GraphQL, all pages, oldest first, with a completeness check; never the REST issues list (src/github/issues.ts). */
  async listOpenIssues(label: string): Promise<{ issues: StateIssue[]; complete: boolean }> {
    if (!this.labels.has(label)) bad(`unexpected label ${label}`);
    const l = await listOpenIssuesByLabel(this.http, this.owner, this.repo, label);
    return { issues: l.issues.map((i) => ({ number: i.number, title: i.title, body: i.body })), complete: l.complete };
  }

  async getIssue(n: number): Promise<StateIssue & { open: boolean }> {
    if (!Number.isSafeInteger(n) || n < 1) bad("bad issue number");
    const r = await this.http.request<{ number: number; title: string; body: string | null; state: string }>("GET", `${this.path}/issues/${n}`);
    return { number: r.json.number, title: r.json.title, body: r.json.body ?? "", open: r.json.state === "open" };
  }

  async jobState(runId: number, attempt: number, job: string): Promise<"completed" | "running" | "unknown"> {
    if (!Number.isSafeInteger(runId) || runId < 1 || !Number.isSafeInteger(attempt) || attempt < 1) bad("bad run or attempt");
    try {
      const { items } = await this.http.paginate(`${this.path}/actions/runs/${runId}/attempts/${attempt}/jobs`, {}, (p) => (p as { jobs: { name: string; status: string }[] }).jobs);
      const j = items.find((x) => x.name === job);
      if (!j) return "unknown";
      return j.status === "completed" ? "completed" : "running";
    } catch (e) {
      if (e instanceof GitHubError) return "unknown"; // fail closed: no takeover
      throw e;
    }
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<number> {
    if (labels.some((l) => !this.labels.has(l))) bad("unexpected label");
    const r = await postIssue<{ number: number }>(this.http, this.path, { title, body, labels }, this.assign);
    return r.json.number;
  }

  async updateIssueBody(n: number, body: string): Promise<void> {
    if (!Number.isSafeInteger(n) || n < 1) bad("bad issue number");
    if (body.length > 65_000) bad("state too large for an issue body");
    await this.http.request("PATCH", `${this.path}/issues/${n}`, { body: { body } });
  }

  async listIssueComments(n: number): Promise<Listed<IssueComment>> {
    if (!Number.isSafeInteger(n) || n < 1) bad("bad issue number");
    type Raw = { id: number; user: { login: string; id: number } | null; body: string | null; created_at: string; updated_at: string };
    const { items, truncated } = await this.http.paginate(`${this.path}/issues/${n}/comments`, {}, (p) => p as Raw[]);
    // A comment whose author GitHub cannot resolve (a deleted account) is nobody's: it is dropped, never matched.
    const comments = items.flatMap((c) => (c.user && typeof c.user.login === "string" && Number.isSafeInteger(c.user.id) ? [{ id: c.id, user: { login: c.user.login, id: c.user.id }, body: c.body ?? "", created_at: c.created_at, updated_at: c.updated_at }] : []));
    return { items: comments, truncated };
  }

  async commentIssue(n: number, body: string): Promise<number> {
    if (!Number.isSafeInteger(n) || n < 1) bad("bad issue number");
    if (!body.startsWith(RELEASE_REPORT_MARKER) || body.length > 60_000) bad("the only issue comment the release job posts is its candidate report");
    const r = await this.http.request<{ id: number }>("POST", `${this.path}/issues/${n}/comments`, { body: { body } });
    return r.json.id;
  }

  /** Dispatch tick.yml on main, with no inputs. The path and ref are fixed. */
  async dispatchTick(): Promise<void> {
    await this.http.request("POST", `${this.path}/actions/workflows/${TICK_WORKFLOW}/dispatches`, { body: { ref: CONTROL_BRANCH } });
  }

  async recentDispatches(since: Date): Promise<number> {
    if (Number.isNaN(since.getTime())) bad("bad time");
    const r = await this.http.request<{ total_count: number }>("GET", `${this.path}/actions/workflows/${TICK_WORKFLOW}/runs`, {
      query: { event: "workflow_dispatch", created: `>=${since.toISOString()}`, per_page: 1 },
    });
    const n = r.json?.total_count;
    if (!Number.isSafeInteger(n) || n < 0) throw new GitHubError("validation", r.status, "tick runs listing has no total_count");
    return n;
  }

  /**
   * Is a release job waiting for the runner? A cron run creates a queue job
   * and a release job together, so while one waits the cron's own queue job is
   * pending too and continues the chain: the queue then yields instead of
   * dispatching a job that could take the runner first (DESIGN.md §11.1).
   */
  async releaseWaiting(): Promise<boolean> {
    const runs = await this.http.request<{ workflow_runs: { id: number; status: string }[] }>("GET", `${this.path}/actions/workflows/${TICK_WORKFLOW}/runs`, {
      query: { event: "schedule", per_page: 3 },
    });
    for (const r of runs.json?.workflow_runs ?? []) {
      if (r.status === "completed") continue;
      if (!Number.isSafeInteger(r.id) || r.id < 1) bad("bad run id");
      const jobs = await this.http.request<{ jobs: { name: string; status: string }[] }>("GET", `${this.path}/actions/runs/${r.id}/jobs`, { query: { per_page: 100 } });
      if ((jobs.json?.jobs ?? []).some((j) => j.name === RELEASE_JOB_NAME && j.status !== "completed" && j.status !== "in_progress")) return true;
    }
    return false;
  }
}
