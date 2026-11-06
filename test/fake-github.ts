// An in-memory GitHub for tests. It implements TargetApi and StateRepoApi with
// the same guards as the real clients (ref allowlists, CAS on updateRef, label
// and data-file allowlists), and keeps a call log. The Sim and the snapshot
// tests use it; step 4's runner tests will too.

import { type Account, type TargetApi, type Commit, type Compare, type RefActivity, type RefUpdate, type LabelEvent, type Listed, type MergeResult, type PullRequest, RELEASE_REPORT_MARKER, type Review, type StateIssue, type StateRefApi, type StateRepoApi, type Status, type StatusEntry } from "../src/github/api";
import { GitHubError } from "../src/github/http";
import type { CheckRun, IssueComment, Job, Run } from "../src/types";
import type { Names } from "../src/config";
import { isBuildRef, isCommandLabel, isForbiddenHeadRef, isGitBranchName, isRealSha, isSha, isWritableRef, ZERO_SHA } from "../src/validate";
import { APPROVERS, HUMAN, NAMES, sha } from "./sim";

export interface FakePr {
  pr: PullRequest;
  /** Labeled events; `label` defaults to "ready". */
  events: (LabelEvent & { label?: string })[];
  eventsTruncated?: boolean;
  comments: IssueComment[];
  reviews: Review[];
}

let seq = 1000;
/** The config's first approver, an admin: the default human in the fake. */
export const WRITER: Account = { login: APPROVERS[0]!.login, id: APPROVERS[0]!.id };
const nextId = () => ++seq;

export class FakeTarget implements TargetApi {
  readonly repoId: number;
  refs = new Map<string, string>();
  commits = new Map<string, Commit>();
  /** Files each commit changes, and creation order (for chronological compare). */
  commitFiles = new Map<string, string[]>();
  /** Each commit's author as GitHub resolves it (default: WRITER). */
  commitAuthors = new Map<string, Account | null>();
  /** Branch activity (repository activity API), oldest first here; listed newest first. */
  activity: RefActivity[] = [];
  activityTruncated = false;
  activityError: Error | null = null;
  order = new Map<string, number>();
  compareTruncated = false;
  /** The most commits a compare lists (oldest first, as GitHub pages them); null: all. */
  compareCommitLimit: number | null = null;
  incompleteJobs = new Set<number>();
  /** listRuns stops after this many runs and says so (a page limit). */
  runListLimit: number | null = null;
  rejectDeletes = new Set<string>();
  /** Runs per page for listWorkflowRuns, to exercise search limits. */
  pageSize = 100;
  // ---- eventual consistency (all zero by default; the World turns them on)
  clock = 0;
  /** Ticks before a new run shows up in run lists, and before a changed run's new data does. */
  listLag = 0;
  /** Ticks before our own comment shows up in listComments. */
  commentLag = 0;
  /** Ticks before GitHub marks PRs merged after main moves (indirect merge detection). */
  mergeLag = 0;
  commentClock = new Map<number, number>();
  private runVisibleAt = new Map<number, number>();
  private runPrev = new Map<number, { snapshot: Run; until: number }>();
  private pendingMerges: { at: number; heads: string[] }[] = [];

  /** Advance the clock: published lag elapses, pending merge detection happens. */
  advance(): void {
    this.clock++;
    const due = this.pendingMerges.filter((p) => p.at <= this.clock);
    this.pendingMerges = this.pendingMerges.filter((p) => p.at > this.clock);
    for (const p of due) this.detectMerges(p.heads);
  }

  private detectMerges(inMain: Iterable<string>): void {
    const set = new Set(inMain);
    for (const f of this.prs.values()) if (f.pr.state === "open" && set.has(f.pr.head.sha)) Object.assign(f.pr, { state: "closed", merged: true });
  }

  /** Change a run as GitHub would: lists keep showing the old data for listLag ticks. */
  updateRun(run: Run, patch: Partial<Run>): void {
    // Lists keep showing what they last showed: an older snapshot still in its lag window is kept.
    const prev = this.runPrev.get(run.id);
    if (this.listLag > 0 && !(prev && prev.until > this.clock)) this.runPrev.set(run.id, { snapshot: structuredClone(run), until: this.clock + this.listLag });
    Object.assign(run, patch);
  }

  private listed(runs: Run[]): Run[] {
    return runs
      .filter((r) => (this.runVisibleAt.get(r.id) ?? 0) <= this.clock)
      .map((r) => {
        const prev = this.runPrev.get(r.id);
        return prev && prev.until > this.clock ? prev.snapshot : r;
      });
  }

  /** Called when a ref is created (the world starts CI on queue refs). */
  onRefCreated: ((branch: string, sha: string) => void) | null = null;
  /** Called when a run is rerun (the world finishes it again). */
  onRerun: ((run: Run) => void) | null = null;
  /** Called after each getPr, e.g. to force-push between reads. */
  afterGetPr: ((n: number, calls: number) => void) | null = null;
  private getPrCalls = new Map<number, number>();
  prs = new Map<number, FakePr>();
  permissions = new Map<string, string>();
  runs: Run[] = [];
  jobs = new Map<number, Job[]>();
  checks: CheckRun[] = [];
  statuses = new Map<string, Status[]>();
  /** listCommitStatuses: every status, newest first, with creator ids; statusHistoryTruncated marks the listing cut. */
  statusHistory = new Map<string, StatusEntry[]>();
  statusHistoryTruncated = false;
  files = new Map<string, { blobSha: string; text: string }>();
  conflicts = new Set<string>(); // pinned heads that conflict when merged
  unsignedMerges = false;
  calls: string[] = [];
  posted: { pr: number; body: string }[] = [];
  /** The message of every merge commit made, in order. */
  mergeMessages: string[] = [];

  /** The config's identities: the control repo's by default; the target repo id, main, release, prefixes and labels all come from it. */
  constructor(
    public role: "queue" | "release" | "dispatch" | "read" = "queue",
    readonly names: Names = NAMES,
  ) {
    this.repoId = names.target.id;
    this.permissions.set(HUMAN, "admin");
    const root = sha("root");
    this.commits.set(root, { sha: root, parents: [], verified: true, reason: "valid" });
    this.refs.set(names.main, root);
  }

  // ------------------------------------------------------------ builders

  commit(parents: string[], label = `c${nextId()}`, verified = true, files: string[] = []): string {
    const s = sha(label);
    this.commits.set(s, { sha: s, parents, verified, reason: verified ? "valid" : "unsigned" });
    this.commitFiles.set(s, files);
    if (!this.order.has(s)) this.order.set(s, this.order.size);
    // A merge's tree is its parents' changes together; any other commit adds its own change.
    this.setContent(s, new Set([...parents.flatMap((p) => [...(this.content.get(p) ?? [])]), ...(parents.length >= 2 ? [] : [s])]));
    return s;
  }

  // ---- trees (linear landing): a tree is modelled as the set of changes (non-merge commits) it holds
  /** Each commit's content: the non-merge commits whose change its tree holds. */
  content = new Map<string, Set<string>>();
  /** Tree sha by commit, and content by tree sha. */
  treeOf = new Map<string, string>();
  treeContent = new Map<string, Set<string>>();
  /** Commits made with createCommit (the stack), and their messages in order. */
  created = new Set<string>();
  createdMessages: string[] = [];
  /** createCommit makes commits GitHub does not sign. */
  unsignedCreated = false;
  /**
   * landStack as a GitHub that broke its atomicity promise (DESIGN.md §7.4):
   * the PR branches move, and then the whole call is rejected with main unmoved.
   */
  partialLanding = false;
  /** The next this-many landStack calls are refused whole, with nothing moved (a refusal GitHub does not explain). */
  refuseLandings = 0;
  refusal: () => Error = () => new GitHubError("validation", 422, "Reference update failed");

  private setContent(s: string, c: Set<string>): void {
    this.content.set(s, c);
    const t = sha(`tree:${[...c].sort().join(",")}`);
    this.treeOf.set(s, t);
    this.treeContent.set(t, c);
  }

  /** The PR whose head branch is `branch`, if any (a PR branch's value is its head). */
  private prOnBranch(branch: string): FakePr | undefined {
    return [...this.prs.values()].find((f) => f.pr.head.ref === branch);
  }

  /** Push a commit onto a PR branch (its head moves). */
  push(n: number, o: { verified?: boolean; files?: string[]; label?: string } = {}): string {
    const f = this.pr(n);
    const c = this.commit([f.pr.head.sha], o.label ?? `push${n}-${nextId()}`, o.verified ?? true, o.files ?? [`src/more_${n}.py`]);
    f.pr.head.sha = c;
    return c;
  }

  addPr(n: number, over: Partial<PullRequest> = {}, extra: Partial<Omit<FakePr, "pr">> & { files?: string[]; verified?: boolean } = {}): FakePr {
    const { files, verified, ...rest } = extra;
    const head = this.commit([this.refs.get(this.names.main)!], `pr${n}`, verified ?? true, files ?? [`src/feature_${n}.py`]);
    const pr: PullRequest = {
      number: n,
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      head: { sha: head, ref: `feat/pr-${n}`, repoId: this.repoId },
      base: { ref: this.names.main, repoId: this.repoId },
      labels: [this.names.labels.ready],
      user: WRITER,
      ...over,
    };
    const f: FakePr = {
      pr,
      events: [{ id: nextId(), actor: HUMAN, at: `2026-10-21T10:00:${String(n % 60).padStart(2, "0")}Z` }],
      comments: [],
      reviews: [],
      ...rest,
    };
    this.prs.set(n, f);
    return f;
  }

  /** `visibleAfter`: ticks before it shows up in run lists (default listLag). */
  addRun(r: Partial<Run> & { head_sha: string }, jobs: Job[] = [], visibleAfter = this.listLag): Run {
    const run: Run = {
      id: nextId(),
      run_attempt: 1,
      path: ".github/workflows/ci.yml",
      event: "push",
      head_branch: this.names.main,
      status: "completed",
      conclusion: "success",
      repository: { id: this.repoId },
      head_repository: { id: this.repoId },
      created_at: "2026-10-21T10:00:00Z",
      run_started_at: "2026-10-21T10:00:00Z",
      display_title: "",
      ...r,
    } as Run;
    this.runs.push(run);
    this.jobs.set(run.id, jobs);
    this.runVisibleAt.set(run.id, this.clock + visibleAfter);
    return run;
  }

  private log(s: string): void {
    this.calls.push(s);
  }

  private pr(n: number): FakePr {
    const f = this.prs.get(n);
    if (!f) throw new GitHubError("not_found", 404, `no PR #${n}`);
    return f;
  }

  private ancestors(s: string): Set<string> {
    const seen = new Set<string>();
    const todo = [s];
    while (todo.length) {
      const c = todo.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      todo.push(...(this.commits.get(c)?.parents ?? []));
    }
    return seen;
  }

  private write(branch: string): void {
    // The dispatch role (release.mode dispatch) writes no ref at all, as the real client.
    if (this.role === "read" || this.role === "dispatch" || !isWritableRef(this.names, branch, this.role)) throw new GitHubError("validation", null, `role ${this.role} may not write ${branch}`);
  }

  // ------------------------------------------------------------ TargetApi: reads

  /** The next `reads` reads of main return `value`: a replica that has not seen the latest write. */
  staleMain: { value: string; reads: number } | null = null;

  async getRef(branch: string) {
    this.log(`getRef ${branch}`);
    if (branch === this.names.main && this.staleMain && this.staleMain.reads > 0) {
      this.staleMain.reads--;
      return this.staleMain.value;
    }
    return this.refs.get(branch) ?? null;
  }
  async listRefs(prefix: string) {
    return [...this.refs].filter(([b]) => b.startsWith(prefix)).map(([branch, s]) => ({ branch, sha: s }));
  }
  async getCommit(s: string): Promise<Commit> {
    const c = this.commits.get(s);
    if (!c) throw new GitHubError("not_found", 404, `no commit ${s}`);
    const tree = this.treeOf.get(s);
    return tree ? { ...c, tree } : c;
  }
  /**
   * Rulesets as GitHub applies them to branches (linear landing's admission
   * check): which branches each covers, its rule types, and what
   * current_user_can_bypass says for the queue App (null: absent).
   */
  branchRulesets: { id: number; name: string; covers: (branch: string) => boolean; types: string[]; bypass: string | null }[] = [];
  /** Branches with classic protection. */
  protectedBranches = new Set<string>();
  /** branchRules fails, as a read GitHub could not answer. */
  branchRulesError: Error | null = null;

  async branchRules(branch: string) {
    if (!isGitBranchName(branch) || isForbiddenHeadRef(this.names, branch)) throw new GitHubError("validation", null, "reserved branch");
    if (this.branchRulesError) throw this.branchRulesError;
    return this.branchRulesets.filter((r) => r.covers(branch)).flatMap((r) => r.types.map((type) => ({ type, rulesetId: r.id })));
  }
  async rulesetBypass(id: number) {
    const r = this.branchRulesets.find((x) => x.id === id);
    if (!r) throw new GitHubError("not_found", 404, "no ruleset");
    return { name: r.name, bypass: r.bypass };
  }
  async branchProtected(branch: string) {
    return this.protectedBranches.has(branch);
  }
  async getPrBranch(branch: string) {
    if (!isGitBranchName(branch) || isForbiddenHeadRef(this.names, branch)) throw new GitHubError("validation", null, `'${branch}' is reserved or not a branch name`);
    this.log(`getPrBranch ${branch}`);
    return this.prOnBranch(branch)?.pr.head.sha ?? null;
  }
  async compare(base: string, head: string): Promise<Compare> {
    const a = this.ancestors(head);
    const b = this.ancestors(base);
    const status = base === head ? "identical" : a.has(base) ? "ahead" : b.has(head) ? "behind" : "diverged";
    // GitHub lists base...head oldest first.
    const range = [...a].filter((x) => !b.has(x)).sort((x, y) => this.order.get(x)! - this.order.get(y)!);
    const all = range.map((x) => ({ sha: x, parents: this.commits.get(x)!.parents, verified: this.commits.get(x)!.verified, author: this.commitAuthors.has(x) ? this.commitAuthors.get(x)! : WRITER }));
    const commits = this.compareCommitLimit === null ? all : all.slice(0, this.compareCommitLimit);
    const cut = commits.length < all.length;
    const files = [...new Set(range.flatMap((x) => this.commitFiles.get(x) ?? []))];
    this.log(`compare ${base}...${head}`);
    return { status, aheadBy: all.length, behindBy: [...b].filter((x) => !a.has(x)).length, commits, files, truncated: this.compareTruncated || cut, commitsTruncated: cut };
  }
  async listOpenPrNumbersWithLabel(label: string) {
    return [...this.prs.values()].filter((f) => f.pr.state === "open" && f.pr.labels.includes(label)).map((f) => f.pr.number);
  }
  async getPr(n: number) {
    this.log(`getPr ${n}`);
    const out = structuredClone(this.pr(n).pr);
    const calls = (this.getPrCalls.get(n) ?? 0) + 1;
    this.getPrCalls.set(n, calls);
    this.afterGetPr?.(n, calls);
    return out;
  }
  async latestLabelEvent(n: number, label: string): Promise<LabelEvent | null | "unknown"> {
    const f = this.pr(n);
    if (f.eventsTruncated) return "unknown";
    const e = f.events.filter((x) => (x.label ?? this.names.labels.ready) === label).at(-1);
    return e ? { id: e.id, actor: e.actor, at: e.at } : null;
  }
  /** An operator applies a command label to a PR (DESIGN.md §10). */
  label(n: number, label: string, actor: string | null = HUMAN, at = new Date(Date.UTC(2026, 9, 21, 11, 0, 0) + seq * 1000).toISOString().replace(".000", "")): number {
    const f = this.pr(n);
    if (!f.pr.labels.includes(label)) f.pr.labels.push(label);
    const id = nextId();
    f.events.push({ id, actor, at, label });
    return id;
  }
  /** Record a ref update on a branch, as the activity API would. */
  moveBranch(branch: string, before: string, after: string, actor: Account | null, activityType = "push"): void {
    this.activity.push({ id: nextId(), ref: `refs/heads/${branch}`, before, after, activityType, actor, timestamp: new Date(Date.UTC(2026, 9, 21) + seq * 1000).toISOString() });
  }
  async listBranchActivity(branch: string): Promise<Listed<RefActivity>> {
    this.log(`activity ${branch}`);
    if (this.activityError) throw this.activityError;
    return { items: this.activity.filter((a) => a.ref === `refs/heads/${branch}`).reverse(), truncated: this.activityTruncated };
  }
  async permission(login: string) {
    return this.permissions.get(login) ?? "none";
  }
  async listComments(n: number) {
    return this.pr(n).comments.filter((c) => (this.commentClock.get(c.id) ?? -Infinity) <= this.clock - this.commentLag);
  }
  async listReviews(n: number) {
    return this.pr(n).reviews;
  }
  async listRuns(q: { headSha: string; branch?: string; event?: string }): Promise<Listed<Run>> {
    const all = this.listed(this.runs).filter((r) => r.head_sha === q.headSha && (!q.branch || r.head_branch === q.branch) && (!q.event || r.event === q.event));
    const cap = this.runListLimit ?? all.length;
    return { items: all.slice(0, cap), truncated: all.length > cap };
  }
  async listWorkflowRuns(path: string, q: { branch?: string; event?: string; maxPages?: number; created?: Date }): Promise<Listed<Run>> {
    this.log(`listWorkflowRuns ${path}`);
    const all = this.listed(this.runs)
      .filter((r) => r.path === path && (!q.branch || r.head_branch === q.branch) && (!q.event || r.event === q.event) && (!q.created || Date.parse(r.created_at) >= q.created.getTime()))
      .sort((a, b) => b.id - a.id);
    const cap = (q.maxPages ?? 2) * this.pageSize;
    return { items: all.slice(0, cap), truncated: all.length > cap };
  }
  async getRun(id: number) {
    return this.runs.find((r) => r.id === id) ?? null;
  }
  async listJobs(id: number): Promise<Listed<Job>> {
    this.log(`listJobs ${id}`);
    return { items: this.jobs.get(id) ?? [], truncated: this.incompleteJobs.has(id) };
  }
  /** Job logs by job id; a job without one is not found. */
  logs = new Map<number, string>();
  async jobLog(id: number): Promise<string> {
    this.log(`jobLog ${id}`);
    const l = this.logs.get(id);
    if (l === undefined) throw new GitHubError("not_found", 404, "no log");
    return l;
  }
  async listCheckRuns(s: string) {
    return this.checks.filter((c) => c.head_sha === s);
  }
  async listStatuses(s: string) {
    return this.statuses.get(s) ?? [];
  }
  async listCommitStatuses(s: string) {
    return { items: this.statusHistory.get(s) ?? [], truncated: this.statusHistoryTruncated };
  }
  /** The files getDataFile may read, like the real client's dataFiles. */
  dataFiles = new Set([".github/qualification.json"]);
  async getDataFile(path: string, ref: string) {
    if (!this.dataFiles.has(path)) throw new GitHubError("validation", null, "not a data file");
    return this.files.get(`${path}@${ref}`) ?? null;
  }

  // ------------------------------------------------------------ TargetApi: the epoch fence

  /** The epoch branch (docs/deployment.md §3.4); null: the fence is off, and the epoch methods refuse. */
  epochBranch: string | null = null;
  /** Every epochUpdateRefs call GitHub rejected, with the epoch it carried. */
  epochRejections: { writes: RefUpdate[]; epoch: string }[] = [];

  private epochOnly(): string {
    // The dispatch role holds an epoch branch too: it fences its dispatches, and writes no other ref.
    if (this.role === "read") throw new GitHubError("validation", null, "read-only");
    return this.epochBranch ?? (() => { throw new GitHubError("validation", null, "the epoch fence is off"); })();
  }
  private notFenced(): void {
    if (this.epochBranch !== null) throw new GitHubError("validation", null, "the epoch fence is on: ref writes go only through epochUpdateRefs");
  }

  async readEpoch() {
    return this.refs.get(this.epochOnly()) ?? null;
  }
  async advanceEpoch(before: string | null, message: string) {
    const b = this.epochOnly();
    const c = this.commit(before === null ? [] : [before], `epoch:${message}:${nextId()}`);
    this.log(`advanceEpoch ${b} ${before ?? "(none)"} -> ${c}`);
    this.githubUpdateRefs(b, before ?? ZERO_SHA, c); // force false: a fast-forward, or a create
    this.emptyTree.add(c);
    return c;
  }
  /** Commits with the empty tree: every epoch commit (the fake models no other trees). */
  emptyTree = new Set<string>();
  async voidEpoch(branch: string, message: string) {
    if (this.role === "read") throw new GitHubError("validation", null, "read-only");
    if (branch === this.epochBranch) throw new GitHubError("validation", null, "not a predecessor's epoch branch");
    const head = this.refs.get(branch) ?? null;
    if (head !== null && !this.emptyTree.has(head)) throw new GitHubError("validation", null, `${branch} is not an epoch chain`);
    const c = this.commit(head === null ? [] : [head], `epoch:${message}:${nextId()}`);
    this.log(`voidEpoch ${branch} ${head ?? "(none)"} -> ${c}`);
    this.githubUpdateRefs(branch, head ?? ZERO_SHA, c);
    this.emptyTree.add(c);
    return c;
  }
  async epochHeld(epoch: string) {
    const b = this.epochOnly();
    if (!isRealSha(epoch)) throw new GitHubError("validation", null, "not a real object id");
    this.log(`epochHeld ${b} ${epoch}`);
    return this.refs.get(b) === epoch; // the write path: never lags
  }
  async epochUpdateRefs(writes: RefUpdate[], epoch: string) {
    const b = this.epochOnly();
    // The client-side guards (as TargetClient.checkRefWrite).
    if (writes.length === 0 || new Set(writes.map((w) => w.branch)).size !== writes.length) throw new GitHubError("validation", null, "bad writes");
    for (const w of writes) {
      this.write(w.branch);
      const trunk = w.branch === this.names.main || w.branch === this.names.release;
      if (!isSha(w.before) || !isSha(w.after) || (w.before === ZERO_SHA && w.after === ZERO_SHA)) throw new GitHubError("validation", null, "bad oids");
      if (w.before === ZERO_SHA ? trunk : w.after === ZERO_SHA ? trunk : !trunk) throw new GitHubError("validation", null, `bad write to ${w.branch}`);
    }
    if (!isRealSha(epoch)) throw new GitHubError("validation", null, "not a real object id");
    // GitHub, atomically: every entry is checked before any moves, the unchanged
    // epoch entry included (what experiment H1 check 1 must confirm).
    try {
      if (this.refs.get(b) !== epoch) throw new GitHubError("conflict", 200, "beforeOid does not match");
      for (const w of writes) this.refCheck(w.branch, w.before, w.after);
      if (w0Rejected(this, writes)) throw new GitHubError("validation", 422, "Reference update failed");
    } catch (e) {
      this.epochRejections.push({ writes, epoch });
      this.log(`epochUpdateRefs rejected ${writes.map((w) => w.branch).join(",")} at epoch ${epoch}`);
      throw e;
    }
    for (const w of writes) {
      if (w.before === ZERO_SHA) {
        this.log(`createRef ${w.branch} ${w.after}`);
        this.githubUpdateRefs(w.branch, w.before, w.after);
        this.onRefCreated?.(w.branch, w.after);
      } else if (w.after === ZERO_SHA) {
        this.log(`deleteRef ${w.branch}`);
        this.githubUpdateRefs(w.branch, w.before, w.after);
      } else {
        this.log(`updateRef ${w.branch} ${w.before} -> ${w.after}`);
        this.githubUpdateRefs(w.branch, w.before, w.after);
      }
    }
  }

  // ------------------------------------------------------------ TargetApi: writes

  async createRef(branch: string, s: string) {
    this.notFenced();
    this.write(branch);
    if (!isRealSha(s)) throw new GitHubError("validation", null, "not a real object id");
    if (branch === this.names.main || branch === this.names.release) throw new GitHubError("validation", null, "use updateRef");
    if (this.refs.has(branch)) throw new GitHubError("conflict", 422, "Reference already exists");
    if (!this.commits.has(s)) throw new GitHubError("validation", 422, "Object does not exist");
    this.log(`createRef ${branch} ${s}`);
    this.refs.set(branch, s);
    this.onRefCreated?.(branch, s);
  }
  async deleteRef(branch: string) {
    this.notFenced();
    this.write(branch);
    if (branch === this.names.main || branch === this.names.release) throw new GitHubError("validation", null, "never deleted");
    this.log(`deleteRef ${branch}`);
    if (this.rejectDeletes.has(branch)) throw new GitHubError("validation", 422, "Reference update failed");
    this.refs.delete(branch); // absent already: confirmed absence is success
  }
  async updateRef(branch: string, before: string, after: string) {
    // The client-side guards (same as TargetClient), then GitHub's own semantics.
    this.notFenced();
    this.write(branch);
    if (branch !== this.names.main && branch !== this.names.release) throw new GitHubError("validation", null, "updateRef moves only main or release");
    if (!isRealSha(before) || !isRealSha(after)) throw new GitHubError("validation", null, "not a real object id (zero or malformed)");
    this.log(`updateRef ${branch} ${before} -> ${after}`);
    this.githubUpdateRefs(branch, before, after);
  }

  /**
   * GitHub's updateRefs semantics with force false, below any client guard: a
   * zero beforeOid means "must not exist" (create), a zero afterOid deletes.
   */
  githubUpdateRefs(branch: string, before: string, after: string): void {
    this.refCheck(branch, before, after);
    if (after === ZERO_SHA) {
      this.refs.delete(branch);
      return;
    }
    this.refs.set(branch, after);
    // GitHub's indirect merge detection: PRs whose head is now in the branch, after mergeLag ticks.
    if (branch === this.names.main) {
      const inMain = [...this.ancestors(after)];
      if (this.mergeLag === 0) this.detectMerges(inMain);
      else this.pendingMerges.push({ at: this.clock + this.mergeLag, heads: inMain });
    }
  }
  /** GitHub's per-entry check for updateRefs with force false; throws, changes nothing. */
  refCheck(branch: string, before: string, after: string): void {
    const cur = this.refs.get(branch);
    if (before === ZERO_SHA ? cur !== undefined : cur !== before) throw new GitHubError("conflict", 200, "beforeOid does not match");
    if (after !== ZERO_SHA && !this.commits.has(after)) throw new GitHubError("validation", 200, "Object does not exist");
    if (after !== ZERO_SHA && before !== ZERO_SHA && !this.ancestors(after).has(before)) throw new GitHubError("validation", 200, "not a fast-forward");
  }

  async merge(base: string, headSha: string, message: string): Promise<MergeResult> {
    this.write(base);
    if (!isBuildRef(this.names, base)) throw new GitHubError("validation", null, "merges only onto a build branch");
    const cur = this.refs.get(base);
    if (!cur) throw new GitHubError("not_found", 404, "no base");
    if (!isRealSha(headSha)) throw new GitHubError("validation", null, "not a real object id");
    if (!this.commits.has(headSha)) throw new GitHubError("not_found", 404, "no head");
    if (this.ancestors(cur).has(headSha)) return { kind: "noop" };
    if (this.conflicts.has(headSha)) return { kind: "conflict" };
    // Unique per merge, like GitHub (merge commits carry a timestamp).
    const m = this.commit([cur, headSha], `merge:${cur}:${headSha}:${message}:${nextId()}`, !this.unsignedMerges);
    this.refs.set(base, m);
    this.mergeMessages.push(message);
    this.log(`merge ${base} ${headSha}`);
    return { kind: "merged", sha: m };
  }
  /** The author each created commit was given (absent: the App). */
  createdAuthors = new Map<string, { name: string; email: string }>();

  async createCommit(tree: string, parent: string, message: string, author?: { name: string; email: string }): Promise<string> {
    if (this.role !== "queue") throw new GitHubError("validation", null, "queue only");
    if (!isRealSha(tree) || !isRealSha(parent)) throw new GitHubError("validation", null, "not a real object id");
    const content = this.treeContent.get(tree);
    if (!content || !this.commits.has(parent)) throw new GitHubError("validation", 422, "Tree or parent does not exist");
    // Unique per call, like GitHub (a commit carries its timestamp).
    const s = sha(`created:${tree}:${parent}:${message}:${nextId()}`);
    // GitHub signs a git data API commit only when it is its own author: one with another author is unsigned.
    const verified = !this.unsignedCreated && !author;
    this.commits.set(s, { sha: s, parents: [parent], verified, reason: verified ? "valid" : "unsigned" });
    this.commitFiles.set(s, []);
    this.order.set(s, this.order.size);
    this.setContent(s, content);
    this.created.add(s);
    if (author) this.createdAuthors.set(s, author);
    this.createdMessages.push(message);
    this.log(`createCommit ${s} on ${parent}`);
    return s;
  }

  /** Every landStack call GitHub accepted: main and the PR branches it moved. */
  landings: { main: RefUpdate; heads: RefUpdate[] }[] = [];

  async landStack(main: RefUpdate, heads: RefUpdate[], epoch: string | null): Promise<void> {
    // The client-side guards (as TargetClient.landStack).
    if (this.role !== "queue") throw new GitHubError("validation", null, "queue only");
    if (main.branch !== this.names.main || heads.length === 0) throw new GitHubError("validation", null, "bad landStack");
    const all = [main, ...heads];
    if (all.some((u) => !isRealSha(u.before) || !isRealSha(u.after) || u.before === u.after)) throw new GitHubError("validation", null, "bad oids");
    if (heads.some((h) => !isGitBranchName(h.branch) || isForbiddenHeadRef(this.names, h.branch) || h.branch === this.epochBranch)) throw new GitHubError("validation", null, "reserved branch");
    if (new Set(all.map((u) => u.branch)).size !== all.length) throw new GitHubError("validation", null, "a branch twice");
    if ((epoch === null) !== (this.epochBranch === null)) throw new GitHubError("validation", null, "epoch mismatch");
    this.log(`landStack ${main.before} -> ${main.after} with ${heads.map((h) => h.branch).join(",")}`);
    // GitHub, atomically: every entry checked before any moves. A forced entry still needs its beforeOid.
    const check = () => {
      if (epoch !== null && this.refs.get(this.epochBranch!) !== epoch) throw new GitHubError("conflict", 200, "beforeOid does not match");
      this.refCheck(main.branch, main.before, main.after);
      for (const h of heads) {
        const f = this.prOnBranch(h.branch);
        if (!f || f.pr.head.sha !== h.before) throw new GitHubError("conflict", 200, "beforeOid does not match");
        if (!this.commits.has(h.after)) throw new GitHubError("validation", 200, "Object does not exist");
      }
    };
    const moveHeads = () => {
      for (const h of heads) this.prOnBranch(h.branch)!.pr.head.sha = h.after;
    };
    if (this.refuseLandings > 0) {
      this.refuseLandings--;
      throw this.refusal();
    }
    if (this.partialLanding) {
      moveHeads();
      throw new GitHubError("server", 502, "Bad gateway");
    }
    check();
    moveHeads();
    this.githubUpdateRefs(main.branch, main.before, main.after); // merge detection sees the moved heads
    this.landings.push({ main, heads });
  }

  async rerunFailedJobs(id: number) {
    if (this.role !== "queue") throw new GitHubError("validation", null, "queue only");
    const r = this.runs.find((x) => x.id === id);
    if (!r) throw new GitHubError("not_found", 404, "no run");
    this.updateRun(r, { run_attempt: r.run_attempt + 1, status: "queued", conclusion: null, run_started_at: new Date(Date.parse("2026-10-21T12:00:00Z") + this.clock * 600_000).toISOString() });
    this.log(`rerun ${id}`);
    this.onRerun?.(r);
  }
  async cancelRun(id: number) {
    if (this.role !== "queue") throw new GitHubError("validation", null, "queue only");
    const r = this.runs.find((x) => x.id === id);
    if (r && r.status !== "completed") this.updateRun(r, { status: "completed", conclusion: "cancelled" });
    this.log(`cancel ${id}`);
  }
  async comment(n: number, body: string) {
    if (this.role !== "queue") throw new GitHubError("validation", null, "queue only");
    this.pr(n);
    this.posted.push({ pr: n, body });
    const id = nextId();
    this.pr(n).comments.push({ id, user: { login: "qlander-queue[bot]", id: 1 }, body, created_at: "2026-10-21T12:00:00Z", updated_at: "2026-10-21T12:00:00Z" });
    this.commentClock.set(id, this.clock);
    return id;
  }
  async removeLabel(n: number, label: string) {
    if (this.role !== "queue" || !(label === this.names.labels.ready || isCommandLabel(this.names, label))) throw new GitHubError("validation", null, "not allowed");
    const f = this.pr(n);
    f.pr.labels = f.pr.labels.filter((l) => l !== label);
    this.log(label === this.names.labels.ready ? `unlabel ${n}` : `unlabel ${n} ${label}`);
  }
  // ------------------------------------------------------------ the release dispatch mode

  /** Every workflow_dispatch GitHub accepted, in order (a "lost" one included: GitHub did it). */
  workflowDispatches: { workflow: string; ref: string; inputs: Record<string, string>; clock: number }[] = [];
  /** The next dispatch calls' failures, in order: an error is thrown before anything happens; "lost" does it and then fails as a lost response. */
  workflowDispatchErrors: (GitHubError | "lost")[] = [];
  /** Called for each accepted dispatch: the world's model of the target workflow. */
  onWorkflowDispatch: ((d: { workflow: string; ref: string; inputs: Record<string, string> }) => void) | null = null;
  async dispatchWorkflow(workflow: string, ref: string, inputs: Record<string, string>) {
    if (this.role !== "dispatch") throw new GitHubError("validation", null, "dispatch role only");
    const e = this.workflowDispatchErrors.shift();
    if (e instanceof GitHubError) throw e;
    const d = { workflow, ref, inputs: { ...inputs } };
    this.workflowDispatches.push({ ...d, clock: this.clock });
    this.log(`dispatchWorkflow ${workflow}@${ref} ${JSON.stringify(inputs)}`);
    this.onWorkflowDispatch?.(d);
    if (e === "lost") throw new GitHubError("network", null, "the response was lost");
  }
  /** Repository variables; absent: not set (404). */
  variables = new Map<string, string>();
  variableErrors = new Map<string, GitHubError>();
  async readVariable(name: string) {
    if (this.role !== "dispatch") throw new GitHubError("validation", null, "reads no variables");
    const e = this.variableErrors.get(name);
    if (e) throw e;
    this.log(`readVariable ${name}`);
    return this.variables.get(name) ?? null;
  }

  /** repository_dispatch events accepted, in order. */
  dispatches: { eventType: string; payload: Record<string, unknown> }[] = [];
  /** Set to make the next dispatches fail (each call shifts one error off). */
  dispatchErrors: GitHubError[] = [];
  async dispatch(eventType: string, payload: object) {
    if (this.role !== "queue") throw new GitHubError("validation", null, "queue only");
    const err = this.dispatchErrors.shift();
    if (err) throw err;
    this.dispatches.push({ eventType, payload: structuredClone(payload) as Record<string, unknown> });
    this.log(`dispatch ${eventType} ${(payload as { event?: string }).event}`);
  }
}

export class FakeStateRepo implements StateRepoApi {
  issues: (StateIssue & { labels: string[]; open: boolean })[] = [];
  /** Actions job states by "run/attempt/job"; anything unset is unknown. */
  jobStates = new Map<string, "completed" | "running" | "unknown">();
  async jobState(runId: number, attempt: number, job: string) {
    return this.jobStates.get(`${runId}/${attempt}/${job}`) ?? "unknown";
  }
  /** Called just before an issue body is replaced, to interleave writers in tests. */
  beforeUpdate: ((n: number) => void | Promise<void>) | null = null;
  /** Called just after an issue body is replaced (before the writer reads it back). */
  afterUpdate: ((n: number) => void | Promise<void>) | null = null;
  /** Called after open issues are listed, to interleave runners in tests. */
  afterList: ((label: string) => void | Promise<void>) | null = null;
  async getIssue(n: number) {
    const i = this.issues.find((x) => x.number === n);
    if (!i) throw new GitHubError("not_found", 404, "no issue");
    return { number: i.number, title: i.title, body: i.body, open: i.open };
  }
  /** Per label: how many upcoming listings come back empty but claim to be complete (a short read). */
  misses = new Map<string, number>();
  /** Labels whose listings come back incomplete (the first issue only, complete: false). */
  incomplete = new Set<string>();
  /** Labels whose listings fail. */
  failing = new Set<string>();
  /** Every listing made, by label, in order. */
  listings: string[] = [];
  async listOpenIssues(label: string) {
    this.listings.push(label);
    if (this.failing.has(label)) throw new GitHubError("server", 502, `listing ${label} failed`);
    const miss = this.misses.get(label) ?? 0;
    const all = this.issues.filter((i) => i.open && i.labels.includes(label)).map(({ number, title, body }) => ({ number, title, body }));
    let out = { issues: all, complete: true };
    if (miss > 0) {
      this.misses.set(label, miss - 1);
      out = { issues: [], complete: true };
    } else if (this.incomplete.has(label)) out = { issues: all.slice(0, 1), complete: false };
    await this.afterList?.(label); // the caller now holds this (possibly stale) list
    return out;
  }
  async createIssue(title: string, body: string, labels: string[]) {
    const number = this.issues.length + 1;
    this.issues.push({ number, title, body, labels, open: true });
    return number;
  }
  /** Comments by issue number, oldest first. */
  comments = new Map<number, IssueComment[]>();
  commentsTruncated = false;
  commentError: GitHubError | null = null;
  /** Comment ids handed out; human comments in tests take them too. */
  private commentIds = 5000;
  /** A person's comment on a control-repo issue (an approval, say). */
  addComment(n: number, user: { login: string; id: number }, body: string, at = "2026-10-22T12:00:00Z", editedAt = at): number {
    const id = ++this.commentIds;
    this.comments.set(n, [...(this.comments.get(n) ?? []), { id, user, body, created_at: at, updated_at: editedAt }]);
    return id;
  }
  async listIssueComments(n: number) {
    return { items: structuredClone(this.comments.get(n) ?? []), truncated: this.commentsTruncated };
  }
  /** Bodies the job posted, by issue. */
  posted: { issue: number; body: string }[] = [];
  async commentIssue(n: number, body: string) {
    if (!body.startsWith(RELEASE_REPORT_MARKER)) throw new GitHubError("validation", null, "only a release-candidate report");
    if (this.commentError) throw this.commentError;
    if (!this.issues.some((i) => i.number === n)) throw new GitHubError("not_found", 404, "no issue");
    this.posted.push({ issue: n, body });
    return this.addComment(n, { login: "github-actions[bot]", id: 41898282 }, body);
  }
  async updateIssueBody(n: number, body: string) {
    await this.beforeUpdate?.(n);
    const i = this.issues.find((x) => x.number === n);
    if (!i) throw new GitHubError("not_found", 404, "no issue");
    i.body = body;
    await this.afterUpdate?.(n);
  }
}

/** An in-memory state ref with a real compare-and-swap. */
export class FakeStateRef implements StateRefApi {
  private versions = 0;
  current: { version: string; text: string } | null = null;
  /** Called just before a CAS is applied, to interleave writers in tests. */
  beforeCas: ((before: string) => void | Promise<void>) | null = null;
  writes = 0;
  /** GitHub's clock (the World points it at world time; tests can skew the runner's). */
  clock: () => Date = () => new Date("2026-10-21T12:00:00Z");

  async read() {
    return this.current ? { ...this.current, serverTime: this.clock() } : null;
  }
  async serverNow() {
    return this.clock();
  }
  async create(text: string) {
    if (this.current) throw new GitHubError("conflict", 422, "Reference already exists");
    this.current = { version: sha(`state-${++this.versions}`), text };
    this.writes++;
    return this.current.version;
  }
  async cas(before: string, text: string) {
    await this.beforeCas?.(before);
    if (!this.current || this.current.version !== before) throw new GitHubError("validation", 200, "Reference cannot be updated");
    this.current = { version: sha(`state-${++this.versions}`), text };
    this.writes++;
    return this.current.version;
  }
}

/** A delete the fake is told to reject (rejectDeletes), in an epoch-fenced call. */
function w0Rejected(t: FakeTarget, writes: RefUpdate[]): boolean {
  return writes.some((w) => w.after === ZERO_SHA && t.rejectDeletes.has(w.branch));
}
