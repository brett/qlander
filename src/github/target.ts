// The real client for the target repo. Every input is validated
// before a request is made; every write is checked against the client's role
// and the config's branch names (DESIGN.md §11, §12.1).
// Reads only return data: nothing is checked out or executed, and the one
// download (a failed job's log, for flaky tracking) is only matched as text.

import type { CheckRun, IssueComment, Job, Run } from "../types";
import type { Names } from "../config";
import { refsOverlap } from "../config/runner";
import { EVENT_TYPE_RE } from "../hooks";
import { BRANCH_NAME_RE, isBuildRef, isCommandLabel, isForbiddenHeadRef, isGitBranchName, isQlanderBranch, isPrNumber, isRealSha, isSha, isWritableRef, ZERO_SHA } from "../validate";
import type { Account, CommitAuthor, TargetApi, Commit, Compare, LabelEvent, Listed, MergeResult, PullRequest, RefActivity, RefUpdate, Review, Status, StatusEntry } from "./api";

/** git's empty tree: every epoch commit has it (docs/deployment.md §3.4). */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const UPDATE_REFS = "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }";

/** A job log is read only up to its last this-many bytes: failure summaries are printed at the end. */
const MAX_LOG_BYTES = 2_000_000;
/** One job log download, both requests and the body, must finish within this. */
const LOG_TIMEOUT_MS = 15_000;
/** The most PR branches one linear landing moves: a batch is never larger (queue.batch.max and the adaptive ceiling are far below it). */
export const LAND_STACK_MAX = 100;
/** GitHub lists at most this many files in a compare; reaching it means the list may be cut. */
const COMPARE_FILE_CAP = 300;
import { GitHubError, Http, type HttpOptions, isGraphqlInternal } from "./http";

/**
 * queue and release write their own refs. dispatch (the release job in
 * release.mode dispatch, DESIGN.md §8.1) writes no ref at all, only its epoch
 * branch, and may dispatch exactly one configured workflow. read writes nothing.
 */
export type Role = "queue" | "release" | "dispatch" | "read";

/** What a dispatch-role client may start: one workflow, on one ref, with exactly these input names. */
export interface DispatchAllow {
  workflow: string;
  ref: string;
  inputs: readonly string[];
}

/** A workflow_dispatch input value qlander sends: a sha, true/false, or a dispatch id. */
const INPUT_VALUE_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const VARIABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const WORKFLOW_RE = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(\[bot\])?$/;

/** An account's GitHub noreply address (`<id>+<login>@users.noreply.github.com`), or null for anything that is not a login and an id. */
export function noreplyEmail(login: string, id: number): string | null {
  return LOGIN_RE.test(login) && Number.isSafeInteger(id) && id > 0 ? `${id}+${login}@users.noreply.github.com` : null;
}

/** Pages of branch activity read when judging a trusted automation's PR; more than that fails closed. */
const ACTIVITY_PAGES = 5;

type RawAccount = { login: string; id: number };
const account = (a: RawAccount | null | undefined): Account | null =>
  a && typeof a.login === "string" && Number.isSafeInteger(a.id) ? { login: a.login, id: a.id } : null;

function bad(msg: string): never {
  throw new GitHubError("validation", null, msg);
}
const sha = (s: string, what: string) => (isSha(s) ? s : bad(`${what}: not a 40-hex sha`));
/** For anything written: a real object, never the zero OID (create/delete sentinel). */
const oid = (s: string, what: string) => (isRealSha(s) ? s : bad(`${what}: not a real object id (zero or malformed)`));
const prn = (n: number) => (isPrNumber(n) ? n : bad(`not a PR number: ${n}`));
const runId = (n: number) => (Number.isSafeInteger(n) && n > 0 ? n : bad(`not a run id: ${n}`));

interface RawRun {
  id: number;
  run_attempt: number;
  path: string;
  event: string;
  head_branch: string | null;
  head_sha: string;
  status: string;
  conclusion: string | null;
  repository: { id: number };
  head_repository: { id: number } | null;
  created_at: string;
  run_started_at: string;
  display_title?: string;
  actor?: RawAccount | null;
  triggering_actor?: RawAccount | null;
}

const toRun = (r: RawRun): Run => ({
  id: r.id,
  run_attempt: r.run_attempt,
  path: r.path,
  event: r.event,
  head_branch: r.head_branch,
  head_sha: r.head_sha,
  status: r.status,
  conclusion: r.conclusion,
  repository: { id: r.repository?.id },
  head_repository: r.head_repository ? { id: r.head_repository.id } : null,
  created_at: r.created_at,
  run_started_at: r.run_started_at ?? r.created_at,
  display_title: r.display_title ?? "",
  actor: account(r.actor),
  triggering_actor: account(r.triggering_actor),
});

export class TargetClient implements TargetApi {
  private constructor(
    private readonly http: Http,
    private readonly path: string,
    readonly repoId: number,
    private readonly nodeId: string,
    readonly role: Role,
    private readonly names: Names,
    /** Target files qlander may read, as data only (a target-hosted qualification manifest). */
    private readonly dataFiles: ReadonlySet<string>,
    readonly epochBranch: string | null,
    private readonly dispatchAllow: DispatchAllow | null = null,
  ) {}

  /** Connect and verify the repository id before anything else (DESIGN.md §11). */
  static async connect(o: HttpOptions & { owner: string; repo: string; repoId: number; role: Role; names: Names; dataFiles: readonly string[]; epochBranch?: string | null; dispatch?: DispatchAllow | null }): Promise<TargetClient> {
    if (!NAME_RE.test(o.owner) || !NAME_RE.test(o.repo)) bad("bad owner or repo name");
    const allow = o.dispatch ?? null;
    if ((o.role === "dispatch") !== (allow !== null)) bad("a dispatch allowance goes with the dispatch role, and only with it");
    if (allow && (!WORKFLOW_RE.test(allow.workflow) || (allow.ref !== o.names.main && allow.ref !== o.names.release) || allow.inputs.length === 0)) bad("bad dispatch allowance");
    const epoch = o.epochBranch ?? null;
    if (epoch !== null) {
      if (o.role === "read") bad("a read-only client has no epoch branch");
      if (!BRANCH_NAME_RE.test(epoch) || epoch.split("/").some((c) => c.endsWith(".lock"))) bad(`bad epoch branch ${epoch}`);
      const n = o.names;
      if ([n.main, n.release, n.queuePrefix, n.buildPrefix].some((x) => refsOverlap(epoch, x))) bad(`the epoch branch ${epoch} overlaps a branch qlander writes`);
    }
    const http = new Http(o);
    const path = `repos/${o.owner}/${o.repo}`;
    const res = await http.request<{ id: number; node_id: string }>("GET", path);
    if (res.json.id !== o.repoId) bad(`${o.owner}/${o.repo} has id ${res.json.id}, expected ${o.repoId}`);
    return new TargetClient(http, path, o.repoId, res.json.node_id, o.role, o.names, new Set(o.dataFiles), epoch, allow);
  }

  private can(action: "refs" | "queueOps", ref?: string): void {
    if (this.role === "read") bad("this client is read-only");
    // The dispatch role writes no target ref (its epoch branch goes through advanceEpoch and epochHeld, never here).
    if (this.role === "dispatch") bad("role dispatch writes no ref and makes no queue write");
    if (action === "queueOps" && this.role !== "queue") bad(`role ${this.role} may not do this`);
    if (ref !== undefined && !isWritableRef(this.names, ref, this.role)) bad(`role ${this.role} may not write ${ref}`);
  }

  /** main, release and the batch refs: the only target branches qlander reads or writes. */
  private branchName(b: string): string {
    return isQlanderBranch(this.names, b) ? b : bad(`branch '${b}' is not one qlander reads or writes`);
  }

  /** The only labels qlander lists and removes: the ready label and the operator command labels. */
  private removable(label: string): boolean {
    return label === this.names.labels.ready || isCommandLabel(this.names, label);
  }

  // ---------------------------------------------------------------- refs and commits

  async getRef(branch: string): Promise<string | null> {
    try {
      const r = await this.http.request<{ object: { sha: string } }>("GET", `${this.path}/git/ref/heads/${this.branchName(branch)}`);
      return sha(r.json.object.sha, `ref ${branch}`);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  async listRefs(prefix: string): Promise<{ branch: string; sha: string }[]> {
    if (prefix !== this.names.queuePrefix && prefix !== this.names.buildPrefix) bad("bad ref prefix");
    const { items } = await this.http.paginate(`${this.path}/git/matching-refs/heads/${prefix}`, {}, (p) => p as { ref: string; object: { sha: string } }[]);
    return items
      .map((r) => ({ branch: r.ref.replace(/^refs\/heads\//, ""), sha: r.object.sha }))
      .filter((r) => isQlanderBranch(this.names, r.branch) && isSha(r.sha));
  }

  async getCommit(s: string): Promise<Commit> {
    const r = await this.http.request<{ sha: string; parents: { sha: string }[]; commit: { tree?: { sha?: unknown }; verification?: { verified: boolean; reason: string } } }>(
      "GET",
      `${this.path}/commits/${sha(s, "commit")}`,
    );
    const tree = r.json.commit.tree?.sha;
    return {
      sha: sha(r.json.sha, "commit"),
      parents: r.json.parents.map((p) => sha(p.sha, "parent")),
      verified: r.json.commit.verification?.verified === true,
      reason: r.json.commit.verification?.reason ?? "unknown",
      ...(typeof tree === "string" ? { tree: sha(tree, "tree") } : {}),
    };
  }

  async compare(base: string, head: string): Promise<Compare> {
    type RawCommit = { sha: string; parents: { sha: string }[]; commit: { verification?: { verified: boolean } }; author: RawAccount | null };
    type Page = { status: Compare["status"]; ahead_by: number; behind_by: number; commits: RawCommit[]; files?: { filename: string; previous_filename?: string }[] };
    let first: Page | null = null;
    const files: string[] = [];
    let fileCount = 0;
    const { items, truncated } = await this.http.paginate(`${this.path}/compare/${sha(base, "base")}...${sha(head, "head")}`, {}, (p) => {
      const page = p as Page;
      first ??= page;
      for (const f of page.files ?? []) {
        fileCount++;
        files.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
      }
      return page.commits;
    });
    const f = first as Page | null;
    if (!f) bad("empty compare");
    return {
      status: f.status,
      aheadBy: f.ahead_by,
      behindBy: f.behind_by,
      commits: items.map((c) => ({ sha: sha(c.sha, "commit"), parents: c.parents.map((p) => sha(p.sha, "parent")), verified: c.commit.verification?.verified === true, author: account(c.author) })),
      files: [...new Set(files)],
      truncated: truncated || items.length < f.ahead_by || fileCount >= COMPARE_FILE_CAP,
      commitsTruncated: truncated || items.length < f.ahead_by,
    };
  }

  /**
   * A PR head branch (linear landing, DESIGN.md §7.4): a branch name git
   * accepts, and never one qlander reserves (main, release, the batch
   * prefixes) or the epoch branch.
   */
  private prBranch(b: string): string {
    if (!isGitBranchName(b)) bad(`bad branch name ${JSON.stringify(b)}`);
    if (isForbiddenHeadRef(this.names, b) || isQlanderBranch(this.names, b)) bad(`'${b}' is reserved, never a PR head qlander moves`);
    if (this.epochBranch !== null && refsOverlap(b, this.epochBranch)) bad(`'${b}' overlaps the epoch branch`);
    return b;
  }

  async getPrBranch(branch: string): Promise<string | null> {
    try {
      // Each component encoded: git allows `#`, `%` and `+` in a branch name, which a URL path does not take as they are.
      const path = this.branchPath(branch);
      const r = await this.http.request<{ object: { sha: string } }>("GET", `${this.path}/git/ref/heads/${path}`);
      return sha(r.json.object.sha, `ref ${branch}`);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  /** A PR branch, as a URL path: each component encoded. */
  private branchPath(b: string): string {
    return this.prBranch(b).split("/").map(encodeURIComponent).join("/");
  }

  async branchRules(branch: string): Promise<{ type: string; rulesetId: number | null }[]> {
    const { items, truncated } = await this.http.paginate(`${this.path}/rules/branches/${this.branchPath(branch)}`, {}, (p) => p as { type: string; ruleset_id?: number }[]);
    if (truncated) bad(`the rules for ${branch} were not read completely`);
    return items.map((r) => ({ type: String(r.type), rulesetId: Number.isSafeInteger(r.ruleset_id) ? r.ruleset_id! : null }));
  }

  async rulesetBypass(id: number): Promise<{ name: string; bypass: string | null }> {
    if (!Number.isSafeInteger(id) || id <= 0) bad(`not a ruleset id: ${id}`);
    const r = (await this.http.request<{ name?: unknown; current_user_can_bypass?: unknown }>("GET", `${this.path}/rulesets/${id}`, { query: { includes_parents: "true" } })).json;
    return { name: typeof r.name === "string" ? r.name : `#${id}`, bypass: typeof r.current_user_can_bypass === "string" ? r.current_user_can_bypass : null };
  }

  async branchProtected(branch: string): Promise<boolean> {
    try {
      return (await this.http.request<{ protected?: unknown }>("GET", `${this.path}/branches/${this.branchPath(branch)}`)).json.protected === true;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return false;
      throw e;
    }
  }

  // ---------------------------------------------------------------- pull requests

  async listOpenPrNumbersWithLabel(label: string): Promise<number[]> {
    if (!this.removable(label)) bad(`unexpected label ${label}`);
    // Through /pulls, not /issues?labels=: the queue App has Pull requests but
    // no Issues permission, and the issues endpoint 403s without it.
    const { items, truncated } = await this.http.paginate(`${this.path}/pulls`, { state: "open" }, (p) => p as { number: number; labels: { name: string }[] }[]);
    // A PR past the last page read would be missed silently: refuse a partial list (the tick pauses and says why).
    if (truncated) bad(`the open PR list stopped at ${this.http.maxPages} pages (${items.length} PRs), so PRs labelled ${label} may be missing`);
    return items.filter((i) => isPrNumber(i.number) && i.labels.some((l) => l.name === label)).map((i) => i.number);
  }

  async getPr(n: number): Promise<PullRequest> {
    type Raw = {
      number: number;
      state: "open" | "closed";
      draft: boolean;
      merged: boolean;
      mergeable: boolean | null;
      head: { sha: string; ref: string; repo: { id: number } | null };
      base: { ref: string; repo: { id: number } };
      labels: { name: string }[];
      user: RawAccount | null;
      title?: unknown;
    };
    const r = (await this.http.request<Raw>("GET", `${this.path}/pulls/${prn(n)}`)).json;
    if (r.number !== n) bad(`asked for #${n}, got #${r.number}`);
    return {
      number: r.number,
      state: r.state,
      draft: r.draft === true,
      merged: r.merged === true,
      mergeable: r.mergeable,
      head: { sha: sha(r.head.sha, "PR head"), ref: r.head.ref, repoId: r.head.repo?.id ?? null },
      base: { ref: r.base.ref, repoId: r.base.repo.id },
      labels: r.labels.map((l) => l.name),
      user: account(r.user),
      ...(typeof r.title === "string" ? { title: r.title } : {}),
    };
  }

  async latestLabelEvent(n: number, label: string): Promise<LabelEvent | null | "unknown"> {
    const { items, truncated } = await this.http.paginate(`${this.path}/issues/${prn(n)}/events`, {}, (p) => p as { id: number; event: string; label?: { name: string }; actor: { login: string } | null; created_at: string }[]);
    // The newest event may be past the pages read: provenance is then unknown, never a stale answer.
    if (truncated) return "unknown";
    const hits = items.filter((e) => e.event === "labeled" && e.label?.name === label);
    // Pick the newest application first: an older attributable one never stands in for it.
    const last = hits.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id).at(-1);
    return last ? { id: last.id, actor: last.actor?.login ?? null, at: last.created_at } : null;
  }

  async listBranchActivity(branch: string): Promise<Listed<RefActivity>> {
    if (!/^[A-Za-z0-9._\/-]{1,255}$/.test(branch)) bad(`bad branch name ${branch}`);
    type Raw = { id: number; ref: string; before: string; after: string; activity_type: string; actor: RawAccount | null; timestamp: string };
    const { items, truncated } = await this.http.paginate(
      `${this.path}/activity`,
      { ref: `refs/heads/${branch}`, direction: "desc" },
      (p) => p as Raw[],
      ACTIVITY_PAGES,
    );
    return {
      items: items.map((a) => ({ id: a.id, ref: a.ref, before: a.before, after: a.after, activityType: a.activity_type, actor: account(a.actor), timestamp: a.timestamp })),
      truncated,
    };
  }

  async permission(login: string): Promise<string> {
    if (!LOGIN_RE.test(login)) bad(`bad login ${login}`);
    try {
      const r = await this.http.request<{ permission: string; role_name?: string }>("GET", `${this.path}/collaborators/${login}/permission`);
      return r.json.role_name ?? r.json.permission;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return "none";
      throw e;
    }
  }

  async listComments(n: number): Promise<IssueComment[]> {
    const { items } = await this.http.paginate(`${this.path}/issues/${prn(n)}/comments`, {}, (p) => p as IssueComment[]);
    return items.map((c) => ({ id: c.id, user: { login: c.user.login, id: c.user.id }, body: c.body ?? "", created_at: c.created_at, updated_at: c.updated_at }));
  }

  async listReviews(n: number): Promise<Review[]> {
    const { items } = await this.http.paginate(`${this.path}/pulls/${prn(n)}/reviews`, {}, (p) => p as { id: number; user: { login: string; id: number }; state: string; commit_id: string; submitted_at: string }[]);
    return items.map((r) => ({ id: r.id, user: { login: r.user.login, id: r.user.id }, state: r.state, commitId: r.commit_id, submittedAt: r.submitted_at }));
  }

  // ---------------------------------------------------------------- CI

  async listRuns(q: { headSha: string; branch?: string; event?: string }): Promise<Listed<Run>> {
    if (q.branch !== undefined) this.branchName(q.branch);
    let total: number | null = null;
    const { items, truncated } = await this.http.paginate(
      `${this.path}/actions/runs`,
      { head_sha: sha(q.headSha, "head_sha"), branch: q.branch, event: q.event },
      (p) => {
        const page = p as { total_count?: number; workflow_runs: RawRun[] };
        total ??= typeof page.total_count === "number" ? page.total_count : null;
        return page.workflow_runs;
      },
    );
    // Complete only when every page was read and the count matches GitHub's total.
    return { items: items.map(toRun), truncated: truncated || total === null || items.length !== total };
  }

  async listWorkflowRuns(workflowPath: string, q: { branch?: string; event?: string; maxPages?: number; created?: Date }): Promise<Listed<Run>> {
    if (!WORKFLOW_RE.test(workflowPath)) bad(`bad workflow path ${workflowPath}`);
    if (q.branch !== undefined) this.branchName(q.branch);
    if (q.created !== undefined && Number.isNaN(q.created.getTime())) bad("bad created time");
    const file = workflowPath.slice(".github/workflows/".length);
    let total: number | null = null;
    const { items, truncated } = await this.http.paginate(
      `${this.path}/actions/workflows/${file}/runs`,
      { branch: q.branch, event: q.event, created: q.created ? `>=${q.created.toISOString().replace(/\.\d{3}Z$/, "Z")}` : undefined },
      (p) => {
        const page = p as { total_count?: number; workflow_runs: RawRun[] };
        total ??= typeof page.total_count === "number" ? page.total_count : null;
        return page.workflow_runs;
      },
      q.maxPages ?? 2,
    );
    // As listRuns: complete only when every page was read and the count matches GitHub's total (a filtered search stops at 1,000 runs).
    return { items: items.map(toRun), truncated: truncated || total === null || items.length !== total };
  }

  async getRun(id: number): Promise<Run | null> {
    try {
      return toRun((await this.http.request<RawRun>("GET", `${this.path}/actions/runs/${runId(id)}`)).json);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  async listJobs(id: number): Promise<Listed<Job>> {
    let total: number | null = null;
    const { items, truncated } = await this.http.paginate(`${this.path}/actions/runs/${runId(id)}/jobs`, { filter: "latest" }, (p) => {
      const page = p as { total_count?: number; jobs: Job[] };
      total ??= typeof page.total_count === "number" ? page.total_count : null;
      return page.jobs;
    });
    const jobs = items.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion, html_url: j.html_url, started_at: j.started_at ?? null, completed_at: j.completed_at ?? null, ...(typeof j.run_attempt === "number" ? { run_attempt: j.run_attempt } : {}) }));
    // Complete only when every page was read and the count matches GitHub's total.
    return { items: jobs, truncated: truncated || total === null || jobs.length !== total };
  }

  async jobLog(id: number): Promise<string> {
    return this.http.download(`${this.path}/actions/jobs/${Number.isSafeInteger(id) && id > 0 ? id : bad(`not a job id: ${id}`)}/logs`, MAX_LOG_BYTES, LOG_TIMEOUT_MS);
  }

  async listCheckRuns(s: string): Promise<CheckRun[]> {
    const { items } = await this.http.paginate(`${this.path}/commits/${sha(s, "sha")}/check-runs`, { filter: "latest" }, (p) => (p as { check_runs: CheckRun[] }).check_runs);
    return items.map((c) => ({ id: c.id, name: c.name, head_sha: c.head_sha, status: c.status, conclusion: c.conclusion, app: c.app ? { id: c.app.id } : null }));
  }

  async listStatuses(s: string): Promise<Status[]> {
    const { items } = await this.http.paginate(`${this.path}/commits/${sha(s, "sha")}/status`, {}, (p) => (p as { statuses: { context: string; state: string; target_url: string | null; creator?: { login: string } | null }[] }).statuses);
    return items.map((x) => ({ context: x.context, state: x.state, targetUrl: x.target_url, creator: x.creator?.login ?? null }));
  }

  async listCommitStatuses(s: string): Promise<Listed<StatusEntry>> {
    const { items, truncated } = await this.http.paginate(`${this.path}/commits/${sha(s, "sha")}/statuses`, {}, (p) => p as { context: string; state: string; target_url: string | null; creator?: { id: number } | null }[]);
    return { items: items.map((x) => ({ context: x.context, state: x.state, targetUrl: x.target_url, creatorId: typeof x.creator?.id === "number" ? x.creator.id : null })), truncated };
  }

  async getDataFile(path: string, ref: string): Promise<{ blobSha: string; text: string } | null> {
    if (!this.dataFiles.has(path)) bad(`${path} is not a data file qlander reads`);
    try {
      const r = await this.http.request<{ sha: string; encoding: string; content: string; type: string }>("GET", `${this.path}/contents/${path}`, { query: { ref: sha(ref, "ref") } });
      if (r.json.type !== "file" || r.json.encoding !== "base64") bad(`${path} is not a base64 file`);
      return { blobSha: sha(r.json.sha, "blob"), text: Buffer.from(r.json.content, "base64").toString("utf8") };
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  // ---------------------------------------------------------------- writes

  /**
   * The checks every ref write passes, plain or epoch-fenced: the role may
   * write the branch; main and release are only moved (never created or
   * deleted), and the batch refs are only created or deleted.
   */
  private checkRefWrite(u: RefUpdate): void {
    this.can("refs", this.branchName(u.branch));
    const trunk = u.branch === this.names.main || u.branch === this.names.release;
    if (!isSha(u.before) || !isSha(u.after)) bad(`${u.branch}: not a 40-hex sha`);
    if (u.before === ZERO_SHA && u.after === ZERO_SHA) bad(`${u.branch}: an update from nothing to nothing`);
    if (u.before === ZERO_SHA) {
      if (trunk) bad("main and release are only moved with updateRef");
    } else if (u.after === ZERO_SHA) {
      if (trunk) bad("main and release are never deleted");
    } else if (!trunk) bad("updateRef moves only main or release");
  }

  /** While the epoch fence is on, no ref write may bypass it. */
  private notFenced(): void {
    if (this.epochBranch !== null) bad("the epoch fence is on: ref writes go only through epochUpdateRefs");
  }

  async createRef(branch: string, s: string): Promise<void> {
    this.notFenced();
    this.checkRefWrite({ branch, before: ZERO_SHA, after: oid(s, "sha") });
    await this.http.request("POST", `${this.path}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: s } });
  }

  async deleteRef(branch: string): Promise<void> {
    this.notFenced();
    this.can("refs", this.branchName(branch));
    if (branch === this.names.main || branch === this.names.release) bad("main and release are never deleted");
    try {
      await this.http.request("DELETE", `${this.path}/git/refs/heads/${branch}`);
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return; // already gone
      // A 422 is ambiguous ("does not exist", or a rejection): only confirmed absence counts.
      if (e instanceof GitHubError && e.kind === "validation" && (await this.getRef(branch)) === null) return;
      throw e;
    }
  }

  /** Compare-and-swap: GraphQL updateRefs with beforeOid, force false (DESIGN.md §7.2). */
  async updateRef(branch: string, before: string, after: string): Promise<void> {
    this.notFenced();
    this.checkRefWrite({ branch, before: oid(before, "before"), after: oid(after, "after") });
    await this.http.graphql(UPDATE_REFS, { input: { repositoryId: this.nodeId, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: before, afterOid: after, force: false }] } }, true);
  }

  // ---------------------------------------------------------------- the epoch fence (docs/deployment.md §3.4)

  private epoch(): string {
    if (this.role === "read") bad("this client is read-only");
    return this.epochBranch ?? bad("the epoch fence is off");
  }

  async readEpoch(): Promise<string | null> {
    const b = this.epoch();
    try {
      const r = await this.http.request<{ object: { sha: string; type: string } }>("GET", `${this.path}/git/ref/heads/${b}`);
      if (r.json.object.type !== "commit") bad("the epoch branch does not point at a commit");
      return oid(r.json.object.sha, "epoch");
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  async advanceEpoch(before: string | null, message: string): Promise<string> {
    const b = this.epoch();
    if (!/^[\x20-\x7e]{1,200}$/.test(message)) bad("bad epoch commit message");
    const parents = before === null ? [] : [oid(before, "epoch")];
    const c = await this.http.request<{ sha: string }>("POST", `${this.path}/git/commits`, { body: { message, tree: EMPTY_TREE, parents } });
    const after = oid(c.json.sha, "epoch commit");
    // A fast-forward (or, for a missing branch, a create): never force.
    await this.http.graphql(UPDATE_REFS, { input: { repositoryId: this.nodeId, refUpdates: [{ name: `refs/heads/${b}`, beforeOid: before ?? ZERO_SHA, afterOid: after, force: false }] } }, true);
    return after;
  }

  async voidEpoch(branch: string, message: string): Promise<string> {
    if (this.role === "read") bad("this client is read-only");
    if (!BRANCH_NAME_RE.test(branch) || branch.split("/").some((c) => c.endsWith(".lock"))) bad(`bad epoch branch ${branch}`);
    if (branch === this.epochBranch) bad("voidEpoch is for a predecessor's epoch branch, not this client's own");
    const n = this.names;
    if ([n.main, n.release, n.queuePrefix, n.buildPrefix].some((x) => refsOverlap(branch, x))) bad(`the epoch branch ${branch} overlaps a branch qlander writes`);
    if (!/^[\x20-\x7e]{1,200}$/.test(message)) bad("bad epoch commit message");
    let head: string | null;
    try {
      const r = await this.http.request<{ object: { sha: string; type: string } }>("GET", `${this.path}/git/ref/heads/${branch}`);
      if (r.json.object.type !== "commit") bad(`${branch} does not point at a commit`);
      head = oid(r.json.object.sha, "epoch");
    } catch (e) {
      if (!(e instanceof GitHubError && e.kind === "not_found")) throw e;
      head = null; // perhaps a lagging read: the create below is refused if it exists
    }
    if (head !== null) {
      const c = await this.http.request<{ tree: { sha: string } }>("GET", `${this.path}/git/commits/${head}`);
      if (c.json.tree?.sha !== EMPTY_TREE) bad(`${branch} is not an epoch chain: its commit does not have the empty tree; not voiding it`);
    }
    const made = await this.http.request<{ sha: string }>("POST", `${this.path}/git/commits`, { body: { message, tree: EMPTY_TREE, parents: head === null ? [] : [head] } });
    const after = oid(made.json.sha, "epoch commit");
    await this.http.graphql(UPDATE_REFS, { input: { repositoryId: this.nodeId, refUpdates: [{ name: `refs/heads/${branch}`, beforeOid: head ?? ZERO_SHA, afterOid: after, force: false }] } }, true);
    return after;
  }

  async epochUpdateRefs(writes: RefUpdate[], epoch: string): Promise<void> {
    const b = this.epoch();
    if (writes.length === 0) bad("no ref writes");
    const seen = new Set<string>();
    for (const w of writes) {
      this.checkRefWrite(w);
      if (seen.has(w.branch)) bad(`${w.branch} twice in one update`);
      seen.add(w.branch);
    }
    const e = oid(epoch, "epoch");
    const refUpdates = [...writes.map((w) => ({ name: `refs/heads/${w.branch}`, beforeOid: w.before, afterOid: w.after, force: false })), { name: `refs/heads/${b}`, beforeOid: e, afterOid: e, force: false }];
    await this.http.graphql(UPDATE_REFS, { input: { repositoryId: this.nodeId, refUpdates } }, true);
  }

  async epochHeld(epoch: string): Promise<boolean> {
    const b = this.epoch();
    const e = oid(epoch, "epoch");
    try {
      await this.http.graphql(UPDATE_REFS, { input: { repositoryId: this.nodeId, refUpdates: [{ name: `refs/heads/${b}`, beforeOid: e, afterOid: e, force: false }] } }, true);
      return true;
    } catch (err) {
      // GitHub reports a stale beforeOid as an untyped GraphQL error on a 200. A fault in the same words reads as a lost lease too, which only ends the tick early.
      if (isGraphqlInternal(err) || (err instanceof GitHubError && err.status !== null && (err.kind === "validation" || err.kind === "conflict"))) return false;
      throw err;
    }
  }

  async merge(base: string, headSha: string, message: string): Promise<MergeResult> {
    this.can("queueOps", this.branchName(base));
    if (!isBuildRef(this.names, base)) bad("merges go only onto a qlander-build branch");
    try {
      const r = await this.http.request<{ sha: string } | null>("POST", `${this.path}/merges`, { body: { base, head: oid(headSha, "head"), commit_message: message } });
      if (r.status === 204) return { kind: "noop" };
      return { kind: "merged", sha: sha(r.json!.sha, "merge") };
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "conflict") return { kind: "conflict" };
      throw e;
    }
  }

  async createCommit(tree: string, parent: string, message: string, author?: CommitAuthor): Promise<string> {
    this.can("queueOps");
    if (message.length === 0 || message.length > 65_000 || message.includes("\0")) bad("bad commit message");
    // Only a GitHub noreply identity: never a real address.
    if (author && !(LOGIN_RE.test(author.name) && author.email === noreplyEmail(author.name, Number(author.email.split("+")[0])))) bad("a commit author must be a login at its GitHub noreply address");
    const r = await this.http.request<{ sha: string }>("POST", `${this.path}/git/commits`, { body: { message, tree: oid(tree, "tree"), parents: [oid(parent, "parent")], ...(author ? { author } : {}) } });
    return oid(r.json.sha, "commit");
  }

  async landStack(main: RefUpdate, heads: RefUpdate[], epoch: string | null): Promise<void> {
    this.can("queueOps");
    if (main.branch !== this.names.main) bad("landStack moves main");
    if (heads.length === 0 || heads.length > LAND_STACK_MAX) bad(`landStack takes 1 to ${LAND_STACK_MAX} PR branches`);
    const all = [main, ...heads];
    for (const u of all) if (!isRealSha(u.before) || !isRealSha(u.after) || u.before === u.after) bad(`${u.branch}: not a move between two real object ids`);
    for (const h of heads) this.prBranch(h.branch);
    if (new Set(all.map((u) => u.branch)).size !== all.length) bad("a branch twice in one update");
    if ((epoch === null) !== (this.epochBranch === null)) bad(epoch === null ? "the epoch fence is on: landStack needs the epoch" : "the epoch fence is off");
    const refUpdates = [
      { name: `refs/heads/${main.branch}`, beforeOid: main.before, afterOid: main.after, force: false },
      // A PR branch moves to a commit that does not contain its old head: force, but only from the recorded beforeOid.
      ...heads.map((h) => ({ name: `refs/heads/${h.branch}`, beforeOid: h.before, afterOid: h.after, force: true })),
      ...(epoch !== null ? [{ name: `refs/heads/${this.epochBranch}`, beforeOid: oid(epoch, "epoch"), afterOid: epoch, force: false }] : []),
    ];
    await this.http.graphql(UPDATE_REFS, { input: { repositoryId: this.nodeId, refUpdates } }, true);
  }

  async rerunFailedJobs(id: number): Promise<void> {
    this.can("queueOps");
    await this.http.request("POST", `${this.path}/actions/runs/${runId(id)}/rerun-failed-jobs`);
  }

  async cancelRun(id: number): Promise<void> {
    this.can("queueOps");
    try {
      await this.http.request("POST", `${this.path}/actions/runs/${runId(id)}/cancel`);
    } catch (e) {
      if (!(e instanceof GitHubError && e.kind === "conflict")) throw e; // already finished
    }
  }

  async comment(n: number, body: string): Promise<number> {
    this.can("queueOps");
    if (body.length === 0 || body.length > 60_000) bad("comment body length");
    const r = await this.http.request<{ id: number }>("POST", `${this.path}/issues/${prn(n)}/comments`, { body: { body } });
    return r.json.id;
  }

  /**
   * POST /repos/{owner}/{repo}/dispatches (GitHub App permission: Contents,
   * write). GitHub's limits are checked first: event_type at most 100
   * characters, at most 10 top-level client_payload keys, a body under 64 KB.
   */
  async dispatch(eventType: string, clientPayload: object): Promise<void> {
    this.can("queueOps");
    if (!EVENT_TYPE_RE.test(eventType)) bad(`bad event_type '${eventType}'`);
    if (typeof clientPayload !== "object" || clientPayload === null || Array.isArray(clientPayload)) bad("client_payload must be an object");
    if (Object.keys(clientPayload).length > 10) bad("client_payload has more than 10 top-level keys");
    const body = { event_type: eventType, client_payload: clientPayload };
    if (new TextEncoder().encode(JSON.stringify(body)).length >= 64_000) bad("dispatch body is 64 KB or more");
    await this.http.request("POST", `${this.path}/dispatches`, { body });
  }

  /**
   * POST /actions/workflows/{file}/dispatches (Actions: write). Only the
   * configured workflow, on the configured ref, with exactly the configured
   * input names, each value a sha, true/false or a dispatch id. A POST is
   * never retried (src/github/http.ts), so a lost response stays ambiguous.
   */
  async dispatchWorkflow(workflowPath: string, ref: string, inputs: Record<string, string>): Promise<void> {
    if (this.role !== "dispatch" || !this.dispatchAllow) bad(`role ${this.role} may not dispatch workflows`);
    const a = this.dispatchAllow;
    if (workflowPath !== a.workflow || ref !== a.ref) bad(`only ${a.workflow} on ${a.ref} may be dispatched`);
    const keys = Object.keys(inputs).sort();
    if (!Bun.deepEquals(keys, [...a.inputs].sort())) bad(`dispatch inputs must be exactly ${a.inputs.join(", ")}`);
    for (const v of Object.values(inputs)) if (typeof v !== "string" || !INPUT_VALUE_RE.test(v)) bad("bad dispatch input value");
    const file = workflowPath.slice(".github/workflows/".length);
    await this.http.request("POST", `${this.path}/actions/workflows/${file}/dispatches`, { body: { ref, inputs } });
  }

  async readVariable(name: string): Promise<string | null> {
    if (this.role !== "dispatch") bad(`role ${this.role} reads no variables`);
    if (!VARIABLE_RE.test(name)) bad(`bad variable name ${name}`);
    try {
      const r = await this.http.request<{ name: string; value: unknown }>("GET", `${this.path}/actions/variables/${name}`);
      if (typeof r.json.value !== "string") bad(`variable ${name} has no string value`);
      return r.json.value;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return null;
      throw e;
    }
  }

  async removeLabel(n: number, label: string): Promise<void> {
    this.can("queueOps");
    if (!this.removable(label)) bad(`qlander does not remove '${label}'`);
    try {
      await this.http.request("DELETE", `${this.path}/issues/${prn(n)}/labels/${encodeURIComponent(label)}`);
    } catch (e) {
      if (!(e instanceof GitHubError && e.kind === "not_found")) throw e; // already removed
    }
  }
}
