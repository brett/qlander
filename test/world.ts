// A whole world for end-to-end runner tests: the fake target and state repo,
// plus a CI simulator. When the runner creates queue/<n>, the world reads
// which PRs the batch merged (from the commit chain) and asks an oracle how
// CI goes; reruns ask again with the new attempt.

import type { Config } from "../src/config";
import { CrashError, type CrashPoint, tick, type TickResult } from "../src/queue";
import { parseState, type State } from "../src/state";
import type { Run } from "../src/types";
import type { CommandKind } from "../src/validate";
import type { Executor } from "../src/state";
import { FakeTarget, FakeStateRef, FakeStateRepo } from "./fake-github";
import { cfg, job, HUMAN, LANE, OTHER_LANE, REVIEW_WORKFLOW } from "./sim";
import type { Hook } from "../src/hooks";
import type { CommentSettings } from "../src/config/load";

export type CiOutcome = "pass" | "fail" | "skip" | "cancel" | "hang" | "starve" | "cancelAggregate" | "failCancelAggregate";
export interface BatchCi {
  n: number;
  prs: number[];
  attempt: number;
  /** PRs already in main when the batch was built. */
  mainHas: number[];
}

const REVIEW = REVIEW_WORKFLOW;

export class World {
  /** The fake target repo. */
  target: FakeTarget;
  repo = new FakeStateRepo();
  stateRef = new FakeStateRef();
  now = new Date("2026-10-21T12:00:00Z");
  config: Config;
  runs = 0;
  /** Every queue/<n> CI verdict the world produced: [n, attempt, outcome]. */
  verdicts: [number, number, CiOutcome][] = [];
  /** Heads that ever got a passing CI verdict. */
  greenHeads = new Set<string>();
  /** Every value main took, in order. */
  mainHistory: string[] = [];
  /** The log a failed queue job prints, by batch and attempt (none: its log cannot be read). */
  failLog: ((n: number, attempt: number, job: string) => string | undefined) | null = null;
  /** Lifecycle hooks passed to every tick (docs/hooks.md); none by default. */
  hooks: Hook[] | undefined;
  /** PR comments left out (qlander.yml `comments`); every comment is posted by default. */
  commentSettings: CommentSettings | undefined;
  /**
   * How many ticks a queue CI run (or rerun) takes to finish: 0 (default)
   * finishes it as soon as it starts. With more, the run stays in progress
   * for that many ticks, so batches whose CI overlaps can be told apart.
   */
  ciTicks = 0;
  /** Per batch (optional): its CI's duration in ticks, overriding ciTicks. */
  ciTicksFor: ((b: BatchCi) => number) | null = null;
  /** Ticks run so far. */
  ticks = 0;
  private due: { at: number; run: Run; outcome: CiOutcome }[] = [];

  constructor(
    public oracle: (b: BatchCi) => CiOutcome = () => "pass",
    over: Partial<Config> = {},
  ) {
    this.config = cfg(over);
    this.target = new FakeTarget("queue", this.config.names);
    const n = this.config.names;
    this.mainHistory.push(this.target.refs.get(n.main)!);
    // GitHub is eventually consistent: lists lag, runs appear late, merges are detected late.
    this.target.listLag = 1;
    this.target.commentLag = 1;
    this.target.mergeLag = 1;
    // GitHub's clock is world time.
    this.stateRef.clock = () => this.now;
    this.target.onRefCreated = (branch, sha) => {
      if (branch.startsWith(n.queuePrefix)) this.startCi(branch, sha);
    };
    this.target.onRerun = (r) => this.finishCi(r);
    const update = this.target.githubUpdateRefs.bind(this.target);
    this.target.githubUpdateRefs = (branch, before, after) => {
      update(branch, before, after);
      if (branch === n.main) this.mainHistory.push(after);
    };
  }

  /** A PR with a green fast lane and a clean main-hosted review on its head. */
  readyPr(n: number, o: { files?: string[]; verified?: boolean; headRef?: string } = {}) {
    const p = this.target.addPr(n, {}, { ...(o.files ? { files: o.files } : {}), ...(o.verified === false ? { verified: false } : {}) });
    if (o.headRef) p.pr.head.ref = o.headRef;
    this.evidence(n);
    return p;
  }

  /** Fast lane and review for a PR's current head (e.g. after a push). */
  evidence(n: number): void {
    const p = this.target.prs.get(n)!;
    const head = p.pr.head.sha;
    const f = this.config.fastLane;
    this.target.addRun({ head_sha: head, path: f.workflowPath, event: f.event, head_branch: p.pr.head.ref }, [job(f.job)]);
    const main = this.config.names.main;
    const review = this.config.review.adapter === "job@main" ? this.config.review.workflowPath : REVIEW;
    this.target.addRun({ head_sha: this.target.refs.get(main)!, path: review, event: "workflow_run", head_branch: main, display_title: `Review ${head}` }, [job(`Reviewed ${head}`)]);
  }

  /** The PRs a queue head merged, from its chain: second parent = a PR head. */
  batchPrs(sha: string): number[] {
    const out: number[] = [];
    let cur = sha;
    for (;;) {
      const c = this.target.commits.get(cur);
      if (!c || c.parents.length !== 2) break;
      const pr = [...this.target.prs.values()].find((f) => f.pr.head.sha === c.parents[1]);
      if (pr) out.unshift(pr.pr.number);
      cur = c.parents[0]!;
    }
    return out;
  }

  private mainHas(): number[] {
    const main = this.target.refs.get(this.config.names.main)!;
    const seen = new Set<string>();
    const todo = [main];
    while (todo.length) {
      const c = todo.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      todo.push(...(this.target.commits.get(c)?.parents ?? []));
    }
    return [...this.target.prs.values()].filter((f) => seen.has(f.pr.head.sha)).map((f) => f.pr.number);
  }

  private setRun(run: Run, outcome: CiOutcome): void {
    const n = Number(run.head_branch!.slice(this.config.names.queuePrefix.length));
    this.verdicts.push([n, run.run_attempt, outcome]);
    const names = this.config.preLanding[0]!.required_jobs;
    const t = "2026-10-21T10:00:00Z";
    const jobs = names.map((name) => job(name, "success", "completed", t));
    const test = jobs.find((j) => j.name === LANE) ?? jobs[0]!;
    let conclusion: string | null = "success";
    let status = "completed";
    if (outcome === "fail") Object.assign(test, { conclusion: (conclusion = "failure") });
    if (outcome === "skip") Object.assign(test, { conclusion: "skipped" });
    if (outcome === "cancel") Object.assign(test, { conclusion: (conclusion = "cancelled") });
    if (outcome === "hang") {
      Object.assign(test, { status: "in_progress", conclusion: null, started_at: "2026-10-01T00:00:00Z" });
      status = "in_progress";
      conclusion = null;
    }
    if (outcome === "starve") {
      // A target on a saturated CI host: the quick jobs ran, a lane waits for a runner.
      Object.assign(test, { status: "queued", conclusion: null, started_at: null });
      status = "in_progress";
      conclusion = null;
    }
    if (outcome === "cancelAggregate" || outcome === "failCancelAggregate") {
      // A lane cancelled, and a `full` aggregate (needs: the lanes, if: always())
      // failing because of it. failCancelAggregate also has a real lane failure.
      Object.assign(test, { conclusion: "cancelled", completed_at: "2026-10-21T10:30:00Z" });
      if (outcome === "failCancelAggregate") Object.assign(jobs.find((j) => j.name === OTHER_LANE)!, { conclusion: "failure" });
      jobs.push(job("full", "failure", "completed", "2026-10-21T10:31:00Z"));
      conclusion = "failure";
    }
    if (outcome === "pass") this.greenHeads.add(run.head_sha);
    for (const j of jobs) j.run_attempt = run.run_attempt;
    for (const j of jobs) {
      const l = j.conclusion === "failure" ? this.failLog?.(n, run.run_attempt, j.name) : undefined;
      if (l !== undefined) this.target.logs.set(j.id, l);
    }
    this.target.updateRun(run, { status, conclusion });
    this.target.jobs.set(run.id, jobs);
  }

  private startCi(branch: string, sha: string): void {
    const n = Number(branch.slice(this.config.names.queuePrefix.length));
    const run = this.target.addRun({ head_sha: sha, path: this.config.preLanding[0]!.path, head_branch: branch, created_at: this.now.toISOString(), run_started_at: this.now.toISOString() });
    const b = { n, prs: this.batchPrs(sha), attempt: 1, mainHas: this.mainHas() };
    this.settle(run, this.oracle(b), this.ciTicksFor?.(b));
  }

  private finishCi(run: Run): void {
    const n = Number(run.head_branch!.slice(this.config.names.queuePrefix.length));
    const b = { n, prs: this.batchPrs(run.head_sha), attempt: run.run_attempt, mainHas: this.mainHas() };
    this.settle(run, this.oracle(b), this.ciTicksFor?.(b));
  }

  /** The verdict now, or (ciTicks > 0) a run in progress that gets it ciTicks ticks later. */
  private settle(run: Run, outcome: CiOutcome, ticks = this.ciTicks): void {
    if (ticks === 0) return this.setRun(run, outcome);
    const jobs = this.config.preLanding[0]!.required_jobs.map((name) => ({ ...job(name, null, "in_progress", this.now.toISOString()), run_attempt: run.run_attempt }));
    this.target.updateRun(run, { status: "in_progress", conclusion: null });
    this.target.jobs.set(run.id, jobs);
    this.due.push({ at: this.ticks + ticks, run, outcome });
  }

  /** Finish the runs whose time has come (called after each tick). */
  private finishDue(): void {
    const now = this.due.filter((d) => d.at <= this.ticks);
    this.due = this.due.filter((d) => d.at > this.ticks);
    for (const d of now) if (d.run.status !== "completed") this.setRun(d.run, d.outcome);
  }

  /** The store of record (the state ref), never the mirror issue. */
  state(): State {
    return parseState(this.stateRef.current!.text, this.config.names);
  }

  paused(): boolean {
    return this.repo.issues.some((i) => i.open && i.labels.includes(this.config.names.controlLabels.pause));
  }

  pauseReasons(): string[] {
    return this.repo.issues.filter((i) => i.labels.includes(this.config.names.controlLabels.pause)).map((i) => i.title);
  }

  async tick(o: { crash?: CrashPoint; crashAt?: number; crashWhen?: (p: CrashPoint) => boolean; runId?: string; skewMinutes?: number; executor?: Executor } = {}): Promise<TickResult | "crashed"> {
    let hits = 0;
    const jobKey = o.executor ? `${o.executor.runId}/${o.executor.attempt}/${o.executor.job}` : null;
    if (jobKey) this.repo.jobStates.set(jobKey, "running");
    try {
      const r = await tick({
        target: this.target,
        repo: this.repo,
        stateRef: this.stateRef,
        cfg: this.config,
        now: () => new Date(this.now.getTime() + (o.skewMinutes ?? 0) * 60_000), // the runner's own clock
        runId: o.runId ?? `run-${++this.runs}`,
        ...(this.hooks ? { hooks: this.hooks } : {}),
        ...(this.commentSettings ? { comments: this.commentSettings } : {}),
        ...(o.executor ? { executor: o.executor } : {}),
        crash: (p) => {
          if (o.crashWhen?.(p)) throw new CrashError(p);
          if (p === o.crash && ++hits === (o.crashAt ?? 1)) throw new CrashError(p);
        },
      });
      return r;
    } catch (e) {
      if (e instanceof CrashError) return "crashed";
      throw e;
    } finally {
      if (jobKey) this.repo.jobStates.set(jobKey, "completed"); // the job ends with the tick
      this.now = new Date(this.now.getTime() + 10 * 60_000);
      this.target.advance();
      this.ticks++;
      this.finishDue();
    }
  }

  /**
   * Tick until nothing is left, or a pause (returns the tick count). Lists lag,
   * so "nothing left" must hold for three ticks in a row.
   */
  async runUntilIdle(limit = 80): Promise<number> {
    let quiet = 0;
    for (let i = 1; i <= limit; i++) {
      await this.tick();
      if (this.paused()) return i;
      const s = this.state();
      const idle = !s.active && !s.concurrent && !s.journal && s.outbox.length === 0 && s.verify.length === 0 && Object.keys(s.auth).length === 0 && s.pending.length === 0 && s.solo.length === 0;
      quiet = idle ? quiet + 1 : 0;
      if (quiet >= 3) return i;
    }
    throw new Error("world did not settle");
  }

  /** An operator command: a qlander:* label on the target PR, applied by `actor`. Returns the label event id. */
  command(kind: CommandKind, pr: number, actor: string | null = HUMAN): number {
    return this.target.label(pr, this.config.names.labels[kind], actor);
  }

  /** Tick until a batch is active (lists lag, so admission can take a tick or two). */
  async untilBuilt(o: { executor?: Executor } = {}, limit = 6): Promise<void> {
    for (let i = 0; i < limit; i++) {
      await this.tick(o);
      if (this.state().active) return;
    }
    throw new Error("no batch was built");
  }

  /** PR numbers landed, per batch, from the state history. */
  landed(): number[][] {
    return this.state().history.filter((h) => h.outcome === "landed").map((h) => h.prs);
  }

  bounced(): number[] {
    return this.state().history.filter((h) => h.outcome === "bounced").flatMap((h) => h.prs);
  }

  /** The runner's comments on a PR (markers stripped). */
  comments(n: number): string[] {
    return this.target.posted.filter((c) => c.pr === n).map((c) => c.body);
  }
}
