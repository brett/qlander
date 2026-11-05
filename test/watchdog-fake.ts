// Test support for the watchdog: builders for runs, jobs and issues, and an
// in-memory qlander (tick runs, jobs, logs, issues, pins) that records
// every write so tests can check what the watchdog changed.

import { QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "../src/main";
import type { WatchdogApi } from "../src/watchdog";
import type { IssueInfo, Observation, TickJob, TickRun } from "../src/watchdog-core";
import { CONTROL_SLUG } from "./sim";

export const NOW = new Date("2026-10-22T12:00:00Z");
/** An ISO time `min` minutes before NOW, at whole seconds (as the API returns). */
export const ago = (min: number) => new Date(NOW.getTime() - Math.round(min * 60) * 1000).toISOString().replace(".000Z", "Z");
export const SEC = 1 / 60;

let nextId = 1000;
export function job(name: string, over: Partial<TickJob> = {}): TickJob {
  const id = nextId++;
  return {
    id,
    name,
    status: "completed",
    conclusion: "success",
    createdAt: ago(10),
    startedAt: ago(10),
    completedAt: ago(9),
    url: `https://github.com/${CONTROL_SLUG}/actions/runs/1/job/${id}`,
    runnerName: "runner-1",
    steps: [{ name: "Run one queue tick", conclusion: "success" }],
    ...over,
  };
}
export const SKIPPED: Partial<TickJob> = { conclusion: "skipped", steps: [], runnerName: null };
export const WAITING: Partial<TickJob> = { status: "queued", conclusion: null, steps: [], runnerName: null, completedAt: null, startedAt: null };

/** A tick run: its queue job (null for none), its release job (skipped by default). updatedAt follows the latest job completion. */
export function run(over: Partial<TickRun> = {}, queue: Partial<TickJob> | null = {}, release: Partial<TickJob> | null = SKIPPED): TickRun {
  const id = nextId++;
  // A skipped release job completes when its run is created; by default, with the queue job.
  const rel = release === SKIPPED ? { ...SKIPPED, completedAt: queue?.completedAt ?? ago(9) } : release;
  const jobs = [...(queue ? [job(QUEUE_JOB_NAME, queue)] : []), ...(rel ? [job(RELEASE_JOB_NAME, rel)] : [])];
  const lastDone = jobs.map((j) => j.completedAt ?? "").sort().at(-1) || null;
  return {
    id,
    url: `https://github.com/${CONTROL_SLUG}/actions/runs/${id}`,
    event: "schedule",
    branch: "main",
    status: "completed",
    conclusion: "success",
    createdAt: ago(10),
    runStartedAt: ago(10),
    updatedAt: lastDone,
    jobs,
    ...over,
  };
}

export const issue = (n: number, title: string, minutesOld: number, body = ""): IssueInfo => ({
  number: n,
  nodeId: `I_${n}`,
  title,
  body,
  url: `https://github.com/${CONTROL_SLUG}/issues/${n}`,
  createdAt: ago(minutesOld),
});

export const obs = (over: Partial<Observation> = {}): Observation => ({
  now: NOW,
  workflowState: "active",
  runs: [run({}, { completedAt: ago(5) })],
  jobsComplete: true,
  unfinishedComplete: true,
  pause: [],
  releasePause: [],
  releaseBlocked: [],
  pausesComplete: true,
  pauseLabels: { queue: "pause", release: "release-pause" },
  ...over,
});

type FakeIssue = IssueInfo & { labels: string[]; open: boolean; comments: string[]; pinned: boolean };

export class FakeRepo implements WatchdogApi {
  state = "active";
  runs: TickRun[] = [];
  logs = new Map<number, string>();
  logsReadable = true;
  pinAllowed = true;
  unfinishedTruncated = false;
  /** How many runs the recent listing returns (the real one: 100). */
  recentPage = 100;
  issues: FakeIssue[] = [];
  writes: string[] = [];
  jobCalls = 0;

  constructor(private readonly createdAt: string = NOW.toISOString()) {}

  async workflowState() {
    return this.state;
  }
  private strip = ({ jobs: _, ...r }: TickRun): TickRun => r;
  async listRecentRuns() {
    return [...this.runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, this.recentPage).map(this.strip);
  }
  async listUnfinishedRuns() {
    return { runs: this.runs.filter((r) => r.status !== "completed").map(this.strip), truncated: this.unfinishedTruncated };
  }
  async listJobs(id: number) {
    this.jobCalls++;
    return this.runs.find((r) => r.id === id)?.jobs ?? [];
  }
  async jobLog(id: number) {
    if (!this.logsReadable) throw new Error("auth (403): Resource not accessible by integration");
    return this.logs.get(id) ?? "";
  }
  /** Per label: how many upcoming listings miss every issue (an eventually consistent read), come back incomplete, or fail. */
  misses = new Map<string, number>();
  incomplete = new Set<string>();
  failing = new Set<string>();
  pinnedFails = false;
  private view = ({ labels: _l, open: _o, comments: _c, pinned: _p, ...i }: FakeIssue): IssueInfo => ({ ...i });
  async listOpenIssues(label: string) {
    if (this.failing.has(label)) throw new Error("server (502): listing failed");
    const miss = this.misses.get(label) ?? 0;
    if (miss > 0) {
      this.misses.set(label, miss - 1);
      return { issues: [], complete: true };
    }
    const all = this.issues.filter((i) => i.open && i.labels.includes(label)).map(this.view);
    return this.incomplete.has(label) ? { issues: all.slice(0, 1), complete: false } : { issues: all, complete: true };
  }
  async listPinnedIssues() {
    if (this.pinnedFails) throw new Error("server (502): pinned failed");
    return this.issues.filter((i) => i.pinned).map((i) => ({ ...this.view(i), open: i.open, labels: [...i.labels] }));
  }
  async createIssue(title: string, body: string, labels: string[]) {
    const n = this.issues.length + 1;
    const url = `https://github.com/${CONTROL_SLUG}/issues/${n}`;
    const i: FakeIssue = { number: n, nodeId: `I_${n}`, title, body, url, createdAt: this.createdAt, labels, open: true, comments: [], pinned: false };
    this.issues.push(i);
    this.writes.push(`create #${n} ${title}`);
    return { number: n, nodeId: i.nodeId, title, body, url, createdAt: i.createdAt };
  }
  issue(n: number): FakeIssue {
    return this.issues.find((i) => i.number === n)!;
  }
  /** Seed an issue someone else opened. */
  seed(title: string, labels: string[], minutesOld: number, body = ""): FakeIssue {
    const n = this.issues.length + 1;
    const i: FakeIssue = { ...issue(n, title, minutesOld, body), labels, open: true, comments: [], pinned: false };
    this.issues.push(i);
    return i;
  }
  async updateIssueBody(n: number, body: string) {
    this.issue(n).body = body;
    this.writes.push(`edit #${n}`);
  }
  async comment(n: number, body: string) {
    this.issue(n).comments.push(body);
    this.writes.push(`comment #${n}`);
  }
  async closeIssue(n: number) {
    this.issue(n).open = false;
    this.writes.push(`close #${n}`);
  }
  async pinIssue(id: string) {
    if (!this.pinAllowed) throw new Error("auth: Resource not accessible by integration");
    this.issues.find((i) => i.nodeId === id)!.pinned = true;
    this.writes.push(`pin ${id}`);
  }
  async unpinIssue(id: string) {
    this.issues.find((i) => i.nodeId === id)!.pinned = false;
    this.writes.push(`unpin ${id}`);
  }
}
