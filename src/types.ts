// Shapes of the GitHub API objects qlander reads (only the fields it uses),
// and the shared domain types. No behaviour here.

export type Sha = string;

export interface Run {
  id: number;
  run_attempt: number;
  path: string;
  event: string;
  head_branch: string | null;
  head_sha: Sha;
  status: string; // queued | in_progress | completed | ...
  conclusion: string | null;
  repository: { id: number };
  head_repository: { id: number } | null;
  created_at: string;
  /** The run name (workflow run-name). The review producer puts the reviewed sha in it. */
  display_title: string;
  /** Start of the current attempt (GitHub resets it on a rerun). */
  run_started_at: string;
}

export interface Job {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  /** When a runner picked the job up (null while queued). */
  started_at: string | null;
  /** When the job finished (null or absent until then). */
  completed_at?: string | null;
  /** The run attempt this job belongs to. */
  run_attempt?: number;
}

export type JobsByRun = Record<string, Job[]>;

export interface CheckRun {
  id: number;
  name: string;
  head_sha: Sha;
  status: string;
  conclusion: string | null;
  app: { id: number } | null;
}

export interface IssueComment {
  id: number;
  user: { login: string; id: number };
  body: string;
  created_at: string;
  updated_at: string;
}

/** A failed job, for bounce comments and flaky tracking. */
export interface FailedJob {
  name: string;
  url: string;
  /** The job id (its log is read when a rerun of it passes); absent in records written before flaky tracking. */
  id?: number;
  /** Failing test ids parsed from the job's log (flaky records only). */
  tests?: string[];
}

export interface RunRef {
  runId: number;
  attempt: number;
}
