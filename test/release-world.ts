// A world for release-advance runner tests: the fake target with the release
// App's role, the release job's own state ref and lease, and helpers to land
// commits on main and qualify them (or forge their proof).

import { CrashError, type CrashPoint } from "../src/queue";
import { defaultReleaseConfig, type DispatchConfig, type ReleaseConfig } from "../src/release-config";
import { releaseTick, type ReleaseResult } from "../src/release-runner";
import { parseReleaseState, type ReleaseState } from "../src/release-state";
import type { Executor } from "../src/state";
import type { Job, Run } from "../src/types";
import { FakeTarget, FakeStateRef, FakeStateRepo } from "./fake-github";
import { APPROVERS, job, sha, TARGET_SLUG } from "./sim";

/** The proof workflow the config names (release.qualification.manifest.proof). */
const q = defaultReleaseConfig.qualification;
export const QUALIFY = q.provider === "manifest" && q.proof ? q.proof.workflow : ".github/workflows/proof.yml";
export const MANIFEST = {
  schema: 1,
  status_context: "qualified",
  branch: "main",
  evidence_branch_patterns: ["^main$", "^queue/[A-Za-z0-9._-]+$"],
  required: [{ path: ".github/workflows/ci.yml", name: "CI", when: "always", required_jobs: ["Test"], allow_skipped_jobs: {} }],
};
export const BLOB = sha("qualification-blob");
export const runUrl = (id: number, repo = `${TARGET_SLUG}`) => `https://github.com/${repo}/actions/runs/${id}`;

export class ReleaseWorld {
  target = new FakeTarget("release");
  repo = new FakeStateRepo();
  stateRef = new FakeStateRef();
  now = new Date("2026-10-22T12:00:00Z");
  cfg: ReleaseConfig;
  R: string;
  private n = 0;

  constructor(over: Partial<ReleaseConfig> = {}) {
    this.cfg = { ...defaultReleaseConfig, dryRun: false, ...over };
    this.stateRef.clock = () => this.now;
    this.R = this.target.refs.get("main")!;
    this.target.refs.set("release", this.R);
    this.manifestAt(this.R);
  }

  get main(): string {
    return this.target.refs.get("main")!;
  }
  get release(): string | undefined {
    return this.target.refs.get("release");
  }

  manifestAt(s: string, text = JSON.stringify(MANIFEST)): void {
    this.target.files.set(`.github/qualification.json@${s}`, { blobSha: BLOB, text });
  }

  /** A new commit on main (first parent = old main), with qualification.json readable at it. */
  land(extraParents: string[] = []): string {
    const c = this.target.commit([this.main, ...extraParents], `main-${++this.n}`);
    this.target.refs.set("main", c);
    this.manifestAt(c);
    return c;
  }

  /** A completed push run of ci.yml on main for s (green by default). */
  ci(s: string, jobs: Job[] = [job("Test")]): void {
    this.target.addRun({ head_sha: s, path: ".github/workflows/ci.yml", event: "push", head_branch: "main" }, jobs);
  }

  /** A proof run and a status pointing at it. Defaults: genuine, on main, binding s. */
  proof(s: string, o: { jobFor?: string; event?: string; branch?: string; path?: string; jobNames?: string[] } = {}): number {
    const r = this.target.addRun(
      { head_sha: this.main, path: o.path ?? QUALIFY, event: o.event ?? "workflow_run", head_branch: o.branch ?? "main" },
      (o.jobNames ?? [`Evaluate ${o.jobFor ?? s}`, `Qualified ${o.jobFor ?? s}`]).map((n) => job(n)),
    );
    this.status(s, runUrl(r.id));
    return r.id;
  }

  status(s: string, url: string | null, state = "success"): void {
    this.target.statuses.set(s, [{ context: "qualified", state, targetUrl: url, creator: "github-actions[bot]" }]);
  }

  /** Fully qualified: CI green and the proof chain in place. */
  qualified(s: string): void {
    this.ci(s);
    this.proof(s);
  }

  async tick(o: { runId?: string; crash?: CrashPoint; executor?: Executor } = {}): Promise<ReleaseResult | "crashed"> {
    const point = o.crash;
    const jobKey = o.executor ? `${o.executor.runId}/${o.executor.attempt}/${o.executor.job}` : null;
    if (jobKey) this.repo.jobStates.set(jobKey, "running");
    try {
      return await releaseTick({
        target: this.target,
        repo: this.repo,
        stateRef: this.stateRef,
        cfg: this.cfg,
        now: () => this.now,
        runId: o.runId ?? `run-${Math.random().toString(36).slice(2, 8)}`,
        ...(o.executor ? { executor: o.executor } : {}),
        ...(point
          ? {
              crash: (p: CrashPoint) => {
                if (p === point) throw new CrashError(p);
              },
            }
          : {}),
      });
    } catch (e) {
      if (e instanceof CrashError) return "crashed";
      throw e;
    } finally {
      if (jobKey) this.repo.jobStates.set(jobKey, "completed"); // the job ends with the tick
    }
  }

  async ok(o: { runId?: string; executor?: Executor } = {}): Promise<ReleaseResult> {
    const r = await this.tick(o);
    if (r === "crashed") throw new Error("unexpected crash");
    return r;
  }

  state(): ReleaseState {
    return parseReleaseState(this.stateRef.current!.text);
  }
  releaseWrites(): string[] {
    return this.target.calls.filter((c) => c.startsWith("updateRef"));
  }
  issues(label: string) {
    return this.repo.issues.filter((i) => i.open && i.labels.includes(label));
  }
  /** Let a crashed runner's lease run out. */
  pastLease(): void {
    this.now = new Date(this.now.getTime() + (this.cfg.leaseMinutes + 1) * 60_000);
  }
}

// ---------------------------------------------------------------- release.mode dispatch (DESIGN.md §8.1)

/** The neutral dispatch settings the dispatch tests start from. */
export const PROMOTE = ".github/workflows/promote.yml";
export const DISPATCH: DispatchConfig = {
  workflow: PROMOTE,
  ref: "main",
  inputs: { sha: "sha", dryRun: "dry_run", dispatchId: "dispatch_id" },
  approvers: [{ login: APPROVERS[0]!.login, id: APPROVERS[0]!.id }],
  actor: { login: "example-release[bot]", id: 90000001 },
  promoterApps: [],
  dryRunValidMinutes: 1440,
  appearMinutes: 30,
  runHours: 6,
  observeMinutes: 60,
  budget: { window: 8, windowHours: 24 },
  freeze: [],
};
/** The listed approver, and an account that is not listed. */
export const APPROVER = DISPATCH.approvers[0]!;
export const STRANGER = { login: `${APPROVER.login}-other`, id: APPROVER.id + 7919 };
/** The release App's bot, which GitHub reports as the actor of every run qlander dispatches. */
export const BOT = DISPATCH.actor;

/** How the target's promote workflow behaves for one dispatch (defaults: appears and finishes a tick later, green, and a green real run moves release). */
export interface Promotion {
  /** Ticks before the run shows in run lists. */
  appearTicks: number;
  /** Ticks before it completes. */
  runTicks: number;
  conclusion: string;
  /** The run-name carries the dispatch id (the contract); false models a workflow that forgot it. */
  echo: boolean;
  /** A green real run fast-forwards release to the sha with the target's own credential. */
  moveRelease: boolean;
  /** No run is ever created (a disabled workflow, a dispatch GitHub dropped). */
  noRun: boolean;
  /** Seconds after the dispatch call that GitHub stamps the run's created_at. */
  createdLagSeconds: number;
}

/** Every ref-writing method on the fake target: a dispatch-mode tick may call only advanceEpoch, on its own epoch branch, with the fence on. */
export const REF_WRITERS = ["createRef", "deleteRef", "updateRef", "epochUpdateRefs", "advanceEpoch", "voidEpoch", "merge", "createCommit", "landStack"] as const;

export interface Dispatched {
  kind: "dry" | "real";
  sha: string;
  id: string;
  run: Run | null;
}

/**
 * A release world whose job runs in dispatch mode: the target client has the
 * dispatch role, every tick moves the clock by one cron interval, and the
 * target's own promote workflow is modelled: a dispatch creates a run (named
 * with the dispatch id) that appears and completes after a delay, and a green
 * real run moves release itself. Every ref writer on the fake is spied on:
 * `refWrites` must stay empty, which ok() checks after every tick.
 */
export class DispatchWorld extends ReleaseWorld {
  behave: (d: { kind: "dry" | "real"; sha: string; id: string }) => Partial<Promotion> = () => ({});
  dispatched: Dispatched[] = [];
  /** Every call any ref writer on the target received (REF_WRITERS), as [method, args]. */
  refWrites: [string, unknown[]][] = [];
  statusIssue: number;
  private due: { at: number; d: Dispatched; p: Promotion }[] = [];

  constructor(over: Partial<DispatchConfig> = {}, rel: Partial<ReleaseConfig> = {}) {
    super({ mode: "dispatch", dispatch: { ...DISPATCH, ...over }, ...rel });
    this.target.role = "dispatch";
    const t = this.target;
    for (const m of REF_WRITERS) {
      const orig = (t[m] as (...a: unknown[]) => Promise<unknown>).bind(t);
      (t as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        this.refWrites.push([m, a]);
        return orig(...a);
      };
    }
    t.onWorkflowDispatch = (d) => this.promote(d);
    this.statusIssue = this.repo.issues.length + 1;
    this.repo.issues.push({ number: this.statusIssue, title: "qlander status", body: "", labels: [this.cfg.names.watchdogLabels.status], open: true });
  }

  get dcfg(): DispatchConfig {
    return this.cfg.dispatch!;
  }

  /** The target's promote workflow receiving a dispatch. */
  private promote(x: { workflow: string; ref: string; inputs: Record<string, string> }): void {
    const i = this.dcfg.inputs;
    const kind = x.inputs[i.dryRun] === "true" ? "dry" : "real";
    const sha = x.inputs[i.sha]!;
    const id = x.inputs[i.dispatchId]!;
    const p: Promotion = { appearTicks: 1, runTicks: 1, conclusion: "success", echo: true, moveRelease: true, noRun: false, createdLagSeconds: 0, ...this.behave({ kind, sha, id }) };
    const created = new Date(this.now.getTime() + p.createdLagSeconds * 1000).toISOString();
    const d: Dispatched = { kind, sha, id, run: null };
    this.dispatched.push(d);
    if (p.noRun) return;
    d.run = this.target.addRun(
      { head_sha: this.main, path: x.workflow, event: "workflow_dispatch", head_branch: x.ref, status: "queued", conclusion: null, created_at: created, run_started_at: created, display_title: p.echo ? `Promote ${sha} (${id})` : `Promote ${sha}`, actor: { ...BOT }, triggering_actor: { ...BOT } },
      [job(kind === "dry" ? "plan" : "promote", null, "queued")],
      p.appearTicks,
    );
    this.due.push({ at: this.target.clock + p.runTicks, d, p });
  }

  /** One tick, then a cron interval passes: lists catch up and the target's runs move on. */
  override async tick(o: Parameters<ReleaseWorld["tick"]>[0] = {}): Promise<ReleaseResult | "crashed"> {
    try {
      return await super.tick(o);
    } finally {
      this.now = new Date(this.now.getTime() + this.cfg.runner.cronMinutes * 60_000);
      this.target.advance();
      for (const x of this.due.filter((x) => x.at <= this.target.clock)) this.finish(x.d, x.p);
      this.due = this.due.filter((x) => x.at > this.target.clock);
    }
  }

  private finish(d: Dispatched, p: Promotion): void {
    const run = d.run!;
    if (run.status === "completed") return;
    this.target.updateRun(run, { status: "completed", conclusion: p.conclusion });
    this.target.jobs.set(run.id, [{ ...job(d.kind === "dry" ? "plan" : "promote", p.conclusion), completed_at: this.now.toISOString(), run_attempt: run.run_attempt }]);
    // The target workflow moves release itself, with its own credential: GitHub's ref update, below every qlander client.
    if (d.kind === "real" && p.conclusion === "success" && p.moveRelease) this.target.githubUpdateRefs("release", this.release!, d.sha);
  }

  override async ok(o: Parameters<ReleaseWorld["ok"]>[0] = {}): Promise<ReleaseResult> {
    const r = await super.ok(o);
    // The property, precisely: never the release ref (nor main, nor a batch ref); with the epoch fence on, only advanceEpoch on the job's own epoch branch.
    const allowed = ([m]: [string, unknown[]]) => m === "advanceEpoch" && this.cfg.runner.epochFence && this.target.epochBranch !== null;
    const bad = this.refWrites.filter((w) => !allowed(w));
    if (bad.length) throw new Error(`a ref writer was called in dispatch mode: ${bad.map(([m, a]) => `${m} ${JSON.stringify(a)}`).join("; ")}`);
    return r;
  }

  /** Tick until `until` holds (or the limit), returning every result. */
  async until(until: (r: ReleaseResult) => boolean, limit = 12): Promise<ReleaseResult[]> {
    const out: ReleaseResult[] = [];
    for (let i = 0; i < limit; i++) {
      const r = await this.ok();
      out.push(r);
      if (until(r)) return out;
    }
    throw new Error(`not reached in ${limit} ticks: ${out.map((r) => r.outcome).join(", ")}`);
  }

  /** A comment on the status issue (an approval, by default from the listed approver, now). */
  approve(sha: string, by: { login: string; id: number } = APPROVER, o: { at?: Date; edited?: boolean; body?: string } = {}): number {
    const at = (o.at ?? this.now).toISOString();
    return this.repo.addComment(this.statusIssue, by, o.body ?? `/qlander approve-release ${sha}`, at, o.edited ? new Date(Date.parse(at) + 60_000).toISOString() : at);
  }

  candidate() {
    return this.state().dispatch?.candidate ?? null;
  }
  /** A person closes every open release-pause issue (resume). */
  resume(): void {
    for (const i of this.repo.issues) if (i.open && i.labels.includes(this.cfg.names.releaseLabels.pause)) i.open = false;
  }
  dispatchHistory() {
    return this.state().dispatch?.history ?? [];
  }
  kinds(): string[] {
    return this.dispatched.map((d) => `${d.kind} ${d.sha.slice(0, 8)}`);
  }
}
