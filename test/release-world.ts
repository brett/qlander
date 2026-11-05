// A world for release-advance runner tests: the fake target with the release
// App's role, the release job's own state ref and lease, and helpers to land
// commits on main and qualify them (or forge their proof).

import { CrashError, type CrashPoint } from "../src/queue";
import { defaultReleaseConfig, type ReleaseConfig } from "../src/release-config";
import { releaseTick, type ReleaseResult } from "../src/release-runner";
import { parseReleaseState, type ReleaseState } from "../src/release-state";
import type { Executor } from "../src/state";
import type { Job } from "../src/types";
import { FakeTarget, FakeStateRef, FakeStateRepo } from "./fake-github";
import { job, sha, TARGET_SLUG } from "./sim";

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
