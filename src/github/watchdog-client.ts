// The watchdog's client for qlander itself, through the watchdog
// workflow's GITHUB_TOKEN (contents: read, issues: write, actions: read). It reads tick.yml's
// runs, jobs and logs, and reads and writes issues with the labels below.
// It never touches the target, refs or state.
//
// Issues are listed through the shared GraphQL listing (src/github/issues.ts),
// never the REST issues list: that list can return an empty page while issues
// are open, and taking that for "none" would open duplicate status issues.

import type { WatchdogApi } from "../watchdog";
import type { IssueInfo, TickJob, TickRun } from "../watchdog-core";
import { type AssignOn, GitHubError, Http, type HttpOptions, postIssue } from "./http";
import { listOpenIssuesByLabel } from "./issues";

const TICK_WORKFLOW = "tick.yml";
const UNFINISHED = ["queued", "in_progress", "waiting", "pending", "requested"] as const;
const UNFINISHED_PAGES = 5;

interface RawRun {
  id: number;
  html_url: string;
  event: string;
  head_branch: string | null;
  status: string;
  conclusion: string | null;
  created_at: string;
  run_started_at?: string | null;
  updated_at?: string | null;
}

const toRun = (x: RawRun): TickRun => ({
  id: x.id,
  url: x.html_url,
  event: x.event,
  branch: x.head_branch ?? "",
  status: x.status,
  conclusion: x.conclusion,
  createdAt: x.created_at,
  runStartedAt: x.run_started_at ?? null,
  updatedAt: x.updated_at ?? null,
});
/** Larger logs are not read: the report is printed last, but a runaway log is not worth the memory. */
const MAX_LOG_BYTES = 5_000_000;

function bad(msg: string): never {
  throw new GitHubError("validation", null, msg);
}

const issueNumber = (n: number) => (Number.isSafeInteger(n) && n > 0 ? n : bad("bad issue number"));

interface RawIssue {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  html_url: string;
  created_at: string;
}

const ISSUE_FIELDS = "number id title body url createdAt";

interface GqlIssue {
  number: number;
  id: string;
  title: string;
  body: string | null;
  url: string;
  createdAt: string;
}

const fromGql = (i: GqlIssue): IssueInfo => ({ number: i.number, nodeId: i.id, title: i.title, body: i.body ?? "", url: i.url, createdAt: i.createdAt });

const toIssue = (i: RawIssue): IssueInfo => ({ number: i.number, nodeId: i.node_id, title: i.title, body: i.body ?? "", url: i.html_url, createdAt: i.created_at });

export class WatchdogClient implements WatchdogApi {
  private constructor(
    private readonly http: Http,
    private readonly path: string,
    private readonly opts: HttpOptions & { owner: string; repo: string },
    private readonly readLabels: ReadonlySet<string>,
    private readonly writeLabels: ReadonlySet<string>,
    private readonly assign?: AssignOn,
  ) {}

  /** `readLabels`: the issue labels it may list; `writeLabels`: the ones it may create issues with (its alert and status labels only). */
  static async connect(o: HttpOptions & { owner: string; repo: string; repoId: number; readLabels: readonly string[]; writeLabels: readonly string[]; assign?: AssignOn }): Promise<WatchdogClient> {
    const http = new Http(o);
    const path = `repos/${o.owner}/${o.repo}`;
    const res = await http.request<{ id: number }>("GET", path);
    if (res.json.id !== o.repoId) bad(`${o.owner}/${o.repo} has id ${res.json.id}, expected ${o.repoId}`);
    return new WatchdogClient(http, path, o, new Set(o.readLabels), new Set(o.writeLabels), o.assign);
  }

  async workflowState(): Promise<string> {
    const r = await this.http.request<{ state: string }>("GET", `${this.path}/actions/workflows/${TICK_WORKFLOW}`);
    return r.json.state;
  }

  async listRecentRuns(): Promise<TickRun[]> {
    const r = await this.http.request<{ total_count?: number; workflow_runs?: RawRun[] }>("GET", `${this.path}/actions/workflows/${TICK_WORKFLOW}/runs`, { query: { per_page: 100 } });
    const listed = r.json?.workflow_runs;
    if (!Array.isArray(listed) || listed.length < Math.min(r.json.total_count ?? 0, 100)) throw new GitHubError("server", null, `${TICK_WORKFLOW}: the run listing is incomplete`);
    return listed.map(toRun);
  }

  /** Each unfinished status listed on its own, paginated: a run waiting behind many newer ones is still found. */
  async listUnfinishedRuns(): Promise<{ runs: TickRun[]; truncated: boolean }> {
    const runs: TickRun[] = [];
    let truncated = false;
    for (const status of UNFINISHED) {
      let total = 0;
      const page = await this.http.paginate(
        `${this.path}/actions/workflows/${TICK_WORKFLOW}/runs`,
        { status },
        (p) => {
          const j = p as { total_count?: number; workflow_runs: RawRun[] };
          total = Math.max(total, j.total_count ?? 0);
          return j.workflow_runs;
        },
        UNFINISHED_PAGES,
      );
      truncated ||= page.truncated || page.items.length < total;
      runs.push(...page.items.map(toRun));
    }
    return { runs, truncated };
  }

  async listJobs(runId: number): Promise<TickJob[]> {
    if (!Number.isSafeInteger(runId) || runId < 1) bad("bad run id");
    type Raw = {
      id: number;
      name: string;
      status: string;
      conclusion: string | null;
      created_at?: string | null;
      started_at?: string | null;
      completed_at: string | null;
      html_url: string | null;
      runner_name: string | null;
      steps?: { name: string; conclusion: string | null }[];
    };
    let total: unknown;
    const { items, truncated } = await this.http.paginate(`${this.path}/actions/runs/${runId}/jobs`, {}, (p) => {
      total ??= (p as { total_count?: unknown }).total_count;
      return (p as { jobs: Raw[] }).jobs;
    });
    // An empty listing marks a run as a possible ghost (watchdog-core ghostTick); trust it only when GitHub says there are none.
    if (items.length === 0 && (truncated || total !== 0)) throw new GitHubError("server", 200, `run ${runId}: empty jobs listing with total_count ${String(total)}`);
    return items.map((j) => ({
      id: j.id,
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      createdAt: j.created_at ?? null,
      startedAt: j.started_at ?? null,
      completedAt: j.completed_at ?? null,
      url: j.html_url ?? "",
      runnerName: j.runner_name || null,
      steps: (j.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion })),
    }));
  }

  /**
   * The logs endpoint answers with a redirect to a short-lived signed URL.
   * The token goes only to the API; the signed URL is fetched without it.
   */
  async jobLog(jobId: number): Promise<string> {
    if (!Number.isSafeInteger(jobId) || jobId < 1) bad("bad job id");
    const f = this.opts.fetch ?? fetch;
    const base = this.opts.baseUrl ?? "https://api.github.com";
    const res = await f(`${base}/${this.path}/actions/jobs/${jobId}/logs`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.opts.token}`, "x-github-api-version": "2022-11-28", "user-agent": "qlander-watchdog" },
    });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !location) throw new GitHubError(res.status === 403 || res.status === 401 ? "auth" : "validation", res.status, `job log: HTTP ${res.status}`);
    if (!location.startsWith("https://")) bad("job log redirect is not https");
    const log = await f(location, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(60_000) });
    if (!log.ok) throw new GitHubError("server", log.status, `job log download: HTTP ${log.status}`);
    const text = await log.text();
    return text.length > MAX_LOG_BYTES ? text.slice(-MAX_LOG_BYTES) : text;
  }

  /** Every open issue with the label, oldest first, through the shared GraphQL listing (src/github/issues.ts). Throws if it could not be read. */
  async listOpenIssues(label: string): Promise<{ issues: IssueInfo[]; complete: boolean }> {
    if (!this.readLabels.has(label)) bad(`unexpected label ${label}`);
    return listOpenIssuesByLabel(this.http, this.opts.owner, this.opts.repo, label);
  }

  /** The repo's pinned issues, open or closed, with their labels. Throws if they could not be read. */
  async listPinnedIssues(): Promise<(IssueInfo & { open: boolean; labels: string[] })[]> {
    const d: { repository: { pinnedIssues: { nodes: { issue: GqlIssue & { state: string; labels: { nodes: { name: string }[] } } }[] } } | null } = await this.http.graphql(
      `query($owner: String!, $name: String!) {
        repository(owner: $owner, name: $name) {
          pinnedIssues(first: 10) { nodes { issue { ${ISSUE_FIELDS} state labels(first: 20) { nodes { name } } } } }
        }
      }`,
      { owner: this.opts.owner, name: this.opts.repo },
      false,
    );
    if (!d.repository) bad("no repository in the pinned issues response");
    return d.repository.pinnedIssues.nodes.map((n) => ({ ...fromGql(n.issue), open: n.issue.state === "OPEN", labels: n.issue.labels.nodes.map((l) => l.name) }));
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<IssueInfo> {
    if (labels.length === 0 || labels.some((l) => !this.writeLabels.has(l))) bad("unexpected label");
    const r = await postIssue<RawIssue>(this.http, this.path, { title, body, labels }, this.assign);
    return toIssue(r.json);
  }

  async updateIssueBody(n: number, body: string): Promise<void> {
    await this.http.request("PATCH", `${this.path}/issues/${issueNumber(n)}`, { body: { body } });
  }

  async comment(n: number, body: string): Promise<void> {
    await this.http.request("POST", `${this.path}/issues/${issueNumber(n)}/comments`, { body: { body } });
  }

  async closeIssue(n: number): Promise<void> {
    await this.http.request("PATCH", `${this.path}/issues/${issueNumber(n)}`, { body: { state: "closed", state_reason: "completed" } });
  }

  async pinIssue(nodeId: string): Promise<void> {
    await this.http.graphql("mutation($id: ID!) { pinIssue(input: { issueId: $id }) { issue { id } } }", { id: nodeId }, true);
  }

  async unpinIssue(nodeId: string): Promise<void> {
    await this.http.graphql("mutation($id: ID!) { unpinIssue(input: { issueId: $id }) { issue { id } } }", { id: nodeId }, true);
  }
}
