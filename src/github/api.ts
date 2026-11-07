// The typed surface qlander uses. The real clients (target.ts,
// state-repo.ts) and the test fake (test/fake-github.ts) both implement it,
// and the snapshot and runner code depends only on these interfaces.

import type { CheckRun, IssueComment, Job, Run } from "../types";

export interface Commit {
  sha: string;
  parents: string[];
  verified: boolean;
  reason: string;
  /** The commit's tree (absent when the read did not return one). Linear landing (DESIGN.md §7.4) builds each stack commit on a merge commit's tree. */
  tree?: string;
}

/** A commit's author as the git data API takes it (linear landing, `queue.landing.author: author`). No committer is passed, so GitHub makes the author the committer too. */
export interface CommitAuthor {
  name: string;
  email: string;
}

/** A GitHub account as the API resolves it (a commit's author is null when its email maps to no account). */
export interface Account {
  login: string;
  id: number;
}

export type CompareStatus = "ahead" | "behind" | "identical" | "diverged";

export interface Compare {
  status: CompareStatus;
  aheadBy: number;
  behindBy: number;
  /** Commits in base...head, oldest first (GitHub's chronological order), with their signature state. */
  commits: { sha: string; parents: string[]; verified: boolean; author: Account | null }[];
  /** Files changed between the merge base and head; renames under both names. */
  files: string[];
  /** Some commits or files were not listed. Callers must fail closed. */
  truncated: boolean;
  /** Some commits were not listed (pages ran out, or fewer than aheadBy). Files are not considered. */
  commitsTruncated: boolean;
}

export interface PullRequest {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  head: { sha: string; ref: string; repoId: number | null };
  base: { ref: string; repoId: number };
  labels: string[];
  /** The account that opened the PR (null if unreadable). */
  user: Account | null;
  /** The PR's title as GitHub returns it (absent if not a string). Untrusted text. */
  title?: string;
}

/** One ref update from the repository activity API: who moved the branch, from what to what. */
export interface RefActivity {
  id: number;
  ref: string;
  before: string;
  after: string;
  /** push, force_push, branch_creation, branch_deletion, pr_merge, merge_queue_merge */
  activityType: string;
  actor: Account | null;
  timestamp: string;
}

export interface LabelEvent {
  id: number;
  /** null: GitHub returned the event without a readable actor; the label then counts as not validly applied. */
  actor: string | null;
  at: string;
}

export interface Review {
  id: number;
  user: { login: string; id: number };
  state: string;
  commitId: string;
  submittedAt: string;
}

export interface Status {
  context: string;
  state: string;
  targetUrl: string | null;
  creator: string | null;
}

/** One commit status from the full history (newest first), with its creator's account id. */
export interface StatusEntry {
  context: string;
  state: string;
  targetUrl: string | null;
  creatorId: number | null;
}

export type MergeResult = { kind: "merged"; sha: string } | { kind: "noop" } | { kind: "conflict" };

export interface Listed<T> {
  items: T[];
  truncated: boolean;
}

/**
 * One entry of an atomic ref update (GraphQL updateRefs, force false). A zero
 * `before` means the branch must not exist (a create); a zero `after` deletes it.
 */
export interface RefUpdate {
  branch: string;
  before: string;
  after: string;
}

/** A guard in an atomic ref update: `branch` must be at `at`, and stays there. */
export interface BranchAt {
  branch: string;
  at: string;
}

/** The target repository, as the queue or release App sees it. */
export interface TargetApi {
  readonly repoId: number;
  /**
   * The epoch branch this client's role owns (docs/deployment.md §3.4), or
   * null when the epoch fence is off. While it is set, createRef, deleteRef
   * and updateRef refuse: every ref write goes through epochUpdateRefs.
   */
  readonly epochBranch: string | null;

  // refs and commits
  getRef(branch: string): Promise<string | null>;
  listRefs(prefix: string): Promise<{ branch: string; sha: string }[]>;
  getCommit(sha: string): Promise<Commit>;
  compare(base: string, head: string): Promise<Compare>;

  // pull requests
  listOpenPrNumbersWithLabel(label: string): Promise<number[]>;
  getPr(n: number): Promise<PullRequest>;
  /** The newest labeled event for the label, attributable or not; "unknown" when the event history could not be read completely. */
  latestLabelEvent(n: number, label: string): Promise<LabelEvent | null | "unknown">;
  permission(login: string): Promise<string>;
  /** Who pushed what to a branch, newest first (repository activity API). truncated: older entries were not read. */
  listBranchActivity(branch: string): Promise<Listed<RefActivity>>;
  listComments(n: number): Promise<IssueComment[]>;
  listReviews(n: number): Promise<Review[]>;

  // CI
  /** truncated: the listing is incomplete (page limit, or fewer runs than total_count) and must not be trusted as the whole set. */
  listRuns(q: { headSha: string; branch?: string; event?: string }): Promise<Listed<Run>>;
  /** Newest first. truncated: more runs exist past maxPages. `created`: only runs created at or after this time. */
  listWorkflowRuns(workflowPath: string, q: { branch?: string; event?: string; maxPages?: number; created?: Date }): Promise<Listed<Run>>;
  getRun(id: number): Promise<Run | null>;
  /** The latest attempt's jobs. truncated: the list is incomplete and must not be trusted. */
  listJobs(runId: number): Promise<Listed<Job>>;
  /** A job's plain-text log (its tail, when long), read as data only (flaky tracking). Throws a GitHubError if it cannot be read. */
  jobLog(jobId: number): Promise<string>;
  listCheckRuns(sha: string): Promise<CheckRun[]>;
  listStatuses(sha: string): Promise<Status[]>;
  /** Every status on sha, newest first, with creator ids. truncated: older entries were not read. */
  listCommitStatuses(sha: string): Promise<Listed<StatusEntry>>;
  getDataFile(path: string, ref: string): Promise<{ blobSha: string; text: string } | null>;

  // the epoch fence (docs/deployment.md §3.4); each refused while epochBranch is null
  /** The epoch branch's commit; null if the branch does not exist. */
  readEpoch(): Promise<string | null>;
  /**
   * Advance the epoch: a new empty-tree commit whose parent is `before` (a
   * root commit when `before` is null, i.e. the branch is missing), moved
   * there with a fast-forward compare-and-swap. Returns the new epoch.
   */
  advanceEpoch(before: string | null, message: string): Promise<string>;
  /**
   * Void a predecessor's epoch branch, one that is not this client's (an
   * earlier epochPrefix, or the fence since turned off): a new empty-tree
   * commit on its current commit, moved there with a fast-forward
   * compare-and-swap, so every ref write still carrying the old epoch is
   * rejected. Refused unless the branch's commit has the empty tree (an
   * epoch chain, never a code branch). A branch that reads as missing is
   * created at a new root commit with a create-only CAS, so a lagging read
   * that hides it can never pass for "nothing to void": GitHub refuses the
   * create if it exists. Returns the new commit. Allowed with the fence off.
   */
  voidEpoch(branch: string, message: string): Promise<string>;
  /**
   * One atomic updateRefs call: `writes` plus `{epoch: E -> E}`. If the
   * epoch branch is no longer at `epoch`, GitHub rejects the whole call and
   * nothing moves.
   */
  epochUpdateRefs(writes: RefUpdate[], epoch: string): Promise<void>;
  /**
   * Whether the epoch branch is still at `epoch`, asked on GitHub's write
   * path: a lone no-op updateRefs `{epoch: E -> E}`, which GitHub accepts
   * only while the branch is at E. Unlike a ref read, it cannot be served by
   * a lagging replica. True: held. False: GitHub refused it (the epoch
   * moved, or, rarely, another refusal). Throws on anything else (network,
   * server, auth).
   */
  epochHeld(epoch: string): Promise<boolean>;

  /**
   * A PR's head branch, read only for linear landing (DESIGN.md §7.4): the
   * commit it points at, or null if it does not exist. Refused for main,
   * release, the batch refs and anything else qlander reserves.
   */
  getPrBranch(branch: string): Promise<string | null>;
  /**
   * Linear landing's admission check (src/force-update.ts): the rules GitHub
   * applies to a PR branch (GET /rules/branches/{branch}, repository and
   * organization rulesets alike), each with its ruleset id (null if GitHub
   * names none). Metadata read; never a reserved branch.
   */
  branchRules(branch: string): Promise<{ type: string; rulesetId: number | null }[]>;
  /** A ruleset that applies to the repo (its own or its organization's): its name and `current_user_can_bypass` for this App (null when absent). */
  rulesetBypass(id: number): Promise<{ name: string; bypass: string | null }>;
  /** Whether a PR branch has classic branch protection (a ruleset alone is not it); false if the branch does not exist. */
  branchProtected(branch: string): Promise<boolean>;

  // writes (each refused unless the client's role allows it)
  createRef(branch: string, sha: string): Promise<void>;
  deleteRef(branch: string): Promise<void>;
  updateRef(branch: string, before: string, after: string): Promise<void>;
  merge(base: string, headSha: string, message: string): Promise<MergeResult>;
  /**
   * Linear landing (DESIGN.md §7.4): a new commit with this tree and exactly
   * one parent, through the git data API, with GitHub's own author and
   * signature. Returns its sha. Queue only.
   */
  createCommit(tree: string, parent: string, message: string, author?: CommitAuthor): Promise<string>;
  /**
   * Linear landing, first write and settling (DESIGN.md §7.4): one atomic
   * GraphQL updateRefs with main as a no-op guard, each move `force: true`
   * but still with its beforeOid (a branch someone pushed to is refused, and
   * with it the whole call), and an entry with `before === after` a no-op
   * guard on that branch. `epoch` is the epoch entry's commit with the epoch
   * fence on, and null with it off; the fenced client (src/fenced.ts) fills it
   * in, so callers pass null.
   */
  moveBranches(guard: BranchAt, moves: RefUpdate[], epoch: string | null): Promise<void>;
  /**
   * Linear landing, second write (DESIGN.md §7.4): one atomic GraphQL updateRefs
   * that moves main by fast-forward (`force: false`, beforeOid `main.before`),
   * with each PR head branch in `pinned` a no-op guard at its stack commit.
   * `epoch` as for moveBranches.
   */
  landStack(main: RefUpdate, pinned: BranchAt[], epoch: string | null): Promise<void>;
  rerunFailedJobs(runId: number): Promise<void>;
  cancelRun(runId: number): Promise<void>;
  /** Post a comment on a PR or an issue; returns its id (the delivery receipt). */
  comment(n: number, body: string): Promise<number>;
  /**
   * The issues in this repository a PR says it closes, as GitHub resolves
   * them (GraphQL `closingIssuesReferences`: closing keywords in the body and
   * issues linked by hand). Issues in other repositories are left out.
   * truncated: more were named than were read. Needs Issues: read.
   */
  closingIssues(pr: number): Promise<Listed<{ number: number; open: boolean }>>;
  /** Close an issue as completed (src/outbox.ts closeIssues). Needs Issues: write. Queue only. */
  closeIssue(n: number): Promise<void>;
  removeLabel(n: number, label: string): Promise<void>;
  /** A repository_dispatch event on this repo (lifecycle hooks, src/hooks.ts). Needs Contents: write. */
  dispatch(eventType: string, clientPayload: object): Promise<void>;

  // the release dispatch mode (DESIGN.md §8.1); each refused unless the client's role is "dispatch"
  /**
   * POST /actions/workflows/{file}/dispatches: start `workflowPath` on
   * `ref` with string `inputs`. GitHub answers 204 with no run id, so the
   * caller finds the run itself (by a dispatch id the run name echoes).
   * Needs Actions: write. Never retried: a lost response is ambiguous.
   */
  dispatchWorkflow(workflowPath: string, ref: string, inputs: Record<string, string>): Promise<void>;
  /** A repository variable's value, or null when it is not set (404). Needs Variables: read. */
  readVariable(name: string): Promise<string | null>;
}

/** Every TargetApi method that writes to GitHub. */
export type TargetWriteMethod =
  | "createRef"
  | "deleteRef"
  | "updateRef"
  | "epochUpdateRefs"
  | "advanceEpoch"
  | "voidEpoch"
  | "merge"
  | "createCommit"
  | "moveBranches"
  | "landStack"
  | "rerunFailedJobs"
  | "cancelRun"
  | "comment"
  | "closeIssue"
  | "removeLabel"
  | "dispatch"
  | "dispatchWorkflow";

/** The target's reads only: what discovery and qualification need. */
export type TargetReads = Omit<TargetApi, TargetWriteMethod>;

/**
 * The store of record for qlander's state (DESIGN.md §3.1): one JSON
 * file in a commit on a dedicated ref in the qlander repo. Every write is
 * a new commit moved with a compare-and-swap, so a stale writer fails instead
 * of overwriting.
 */
export interface StateRefApi {
  /** The ref's commit (the version), the state text in it, and GitHub's clock at the read; null if the ref does not exist. */
  read(): Promise<{ version: string; text: string; serverTime: Date } | null>;
  /** GitHub's clock (the Date header of a cheap request). Leases never use the runner's clock. */
  serverNow(): Promise<Date>;
  /** Create the ref with a first commit. Throws a conflict GitHubError if it already exists. */
  create(text: string): Promise<string>;
  /** Commit text on top of `before` and move the ref only if it is still `before`. Throws a conflict GitHubError otherwise. */
  cas(before: string, text: string): Promise<string>;
}

export interface StateIssue {
  number: number;
  title: string;
  body: string;
}

/** Qlander's own repo, through its workflow GITHUB_TOKEN (issues only). */
export interface StateRepoApi {
  /**
   * Every open issue with the label, oldest first, through a strongly
   * consistent read (src/github/issues.ts). `complete` is false when some may
   * be missing: callers fail closed (paused, nothing created). Throws a
   * GitHubError if the listing cannot be read.
   */
  listOpenIssues(label: string): Promise<{ issues: StateIssue[]; complete: boolean }>;
  getIssue(n: number): Promise<StateIssue & { open: boolean }>;
  /** A qlander Actions job's state, by run, attempt and job name: never "completed" unless GitHub says so. */
  jobState(runId: number, attempt: number, job: string): Promise<"completed" | "running" | "unknown">;
  createIssue(title: string, body: string, labels: string[]): Promise<number>;
  updateIssueBody(n: number, body: string): Promise<void>;
  /** An issue's comments, oldest first; truncated: some were not read. (The release dispatch mode reads approvals on the status issue.) */
  listIssueComments(n: number): Promise<Listed<IssueComment>>;
  /** Comment on an issue; only a release-candidate report (it starts with RELEASE_REPORT_MARKER). Returns the comment id. */
  commentIssue(n: number, body: string): Promise<number>;
}

/** Every release-candidate report on the status issue starts with this, then the sha (src/release-dispatch.ts). */
export const RELEASE_REPORT_MARKER = "<!-- qlander-release-candidate:";
