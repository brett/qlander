// Test fixtures and a small simulator. The simulator stands in for the
// runner and GitHub: it performs journalled ops against a fake world, drains
// the outbox, and asks an oracle for each batch's CI class. All decisions are
// made by the real decide()/applyOpResult().

import type { LivePr } from "../src/admission";
import type { CiClass } from "../src/classify";
import { readFileSync } from "node:fs";
import { type Config, defaultConfig } from "../src/config";
import { CONFIG_PATH, controlConfig, parseConfig } from "../src/config/load";
import { policyHash } from "../src/queue";
import { decide, type Snapshot } from "../src/machine";
import { applyOpResult, type OpResult } from "../src/ops";
import { isPolicyChange } from "../src/evidence";
import { emptyState, parseState, type State } from "../src/state";
import type { Job, Run } from "../src/types";
import type { Command, CommandKind } from "../src/validate";

/** The control repo's identities, from qlander.yml. */
export const NAMES = defaultConfig.names;
export const TARGET = NAMES.target.id;
/** The control repo's id. */
export const LS = NAMES.control.id;
/** The target and control repos as `owner/name`, for URLs and API paths. */
export const TARGET_SLUG = `${NAMES.target.owner}/${NAMES.target.name}`;
export const CONTROL_SLUG = `${NAMES.control.owner}/${NAMES.control.name}`;
/** A pattern matching exactly one of those API paths' tail, such as `/repos/<owner>/<name>$`. */
export const pathRe = (path: string) => new RegExp(`${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`);
/** A string matched literally inside a RegExp. */
export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** The config's approvers; the first is also the default human actor (an admin) in the fakes. */
export const APPROVERS = defaultConfig.humans;
export const HUMAN = APPROVERS[0]!.login;
/** The tests need these from the config they run on; anything less is a setup error, not a test failure. */
function shapeError(what: string): never {
  throw new Error(`the test config must have ${what}`);
}
/** The two App token variables the config names (qlander.yml `tokens`). */
export const QUEUE_TOKEN_ENV = controlConfig().tokens.queue;
export const RELEASE_TOKEN_ENV = controlConfig().tokens.release;
/** The config's first trusted automation: a bot account and the one file it may change (a policy path). */
export const TRUSTED = defaultConfig.trustedAutomations?.[0] ?? shapeError("a trusted automation");
export const BOT_FILE = TRUSTED.paths[0]!;
if (!isPolicyChange([BOT_FILE], defaultConfig.policyBoundary)) shapeError("the first trusted automation's first path to be a policy path");
/**
 * The pre-landing jobs the config requires. The world fails LANE (and, for a
 * second real failure, OTHER_LANE) when it makes a batch red.
 */
export const CI_JOBS = defaultConfig.preLanding[0]!.required_jobs;
if (CI_JOBS.length < 2) shapeError("at least two required pre-landing jobs");
// The twelfth and thirteenth jobs where the list is that long (two test lanes in
// the control repo's config), else the last two.
const lane = Math.min(11, CI_JOBS.length - 2);
export const LANE = CI_JOBS[lane]!;
export const OTHER_LANE = CI_JOBS[lane + 1]!;
/** The review producer's workflow, when the config names one (job@main). */
export const REVIEW_WORKFLOW = defaultConfig.review.adapter === "job@main" ? defaultConfig.review.workflowPath : ".github/workflows/review.yml";
/** What the real target client needs besides the repo: the config's names and the one data file it may read. */
export const TARGET_OPTS = { names: NAMES, dataFiles: [".github/qualification.json"] };
/** The real state-ref client's allowlist: the config's two state branches. */
export const STATE_BRANCHES = [NAMES.stateBranch, NAMES.releaseStateBranch];
/** The control repo's issue labels, as qlander.yml names them. */
export const ISSUE_LABELS = { controlLabels: NAMES.controlLabels, releaseLabels: NAMES.releaseLabels, watchdogLabels: NAMES.watchdogLabels };

export function sha(s: string): string {
  return new Bun.CryptoHasher("sha1").update(s).digest("hex");
}

/**
 * The control repo's config without its opt-ins (trusted automations, shared
 * CI-policy batches, the priority lane): the baseline the machine tests start
 * from, so they exercise the default rules unless a test turns an opt-in on.
 */
export const BASE_CONFIG: Config = (() => {
  const { trustedAutomations: _t, policyShareBatch: _s, priorityPreempt: _p, concurrency: _c, ...rest } = defaultConfig;
  const { priority: _l, ...labels } = defaultConfig.names.labels;
  return { ...rest, names: { ...defaultConfig.names, labels } };
})();

export function cfg(over: Partial<Config> = {}): Config {
  // minFill 1: the machine tests predate the fill timer and expect a batch at once.
  return { ...BASE_CONFIG, minFill: 1, ...over };
}

/**
 * qlander.yml as it was before it turned on its opt-ins (the four blocks
 * below removed, the fill wait back at 10), for the tests that add an opt-in
 * to the file. Its policy hash is OPT_IN_FREE_HASH.
 */
export const OPT_IN_FREE_YAML: string = (() => {
  let t = readFileSync(CONFIG_PATH, "utf8");
  const cut = (re: RegExp, to = "") => {
    const out = t.replace(re, to);
    if (out === t) throw new Error(`qlander.yml no longer has ${re}`);
    t = out;
  };
  cut(/^ {4}priority: .*\n/m);
  cut(/^ {2}priority:\n {4}preempt: .*\n/m);
  cut(/^ {4}trustedAutomations:\n(?: {6}.*\n)+/m);
  cut(/^ {4}shareBatch:\n {6}max: .*\n/m);
  // queue.concurrency is not policy (outside the hash); a config may or may not set it.
  t = t.replace(/^ {2}concurrency:\n(?: {4}.*\n)+/m, "");
  cut(/^ {4}maxWaitMinutes: \d+\n/m, "    maxWaitMinutes: 10\n");
  return t;
})();
/** The policy hash of OPT_IN_FREE_YAML: the config's hash with its opt-ins off. */
export const OPT_IN_FREE_HASH = policyHash(parseConfig(OPT_IN_FREE_YAML).config);

export function livePr(n: number, over: Partial<LivePr> = {}): LivePr {
  return {
    number: n,
    open: true,
    draft: false,
    merged: false,
    head: sha(`pr${n}`),
    headRef: `feat/pr-${n}`,
    baseRef: "main",
    baseRepoId: TARGET,
    headRepoId: TARGET,
    labels: ["ready"],
    ready: { actorLogin: HUMAN, actorPermission: "admin", at: `2026-10-21T10:00:${String(n % 60).padStart(2, "0")}Z` },
    mergeable: true,
    commitsVerified: true,
    policyPr: false,
    fastLane: { ok: true, why: `fast:${n}` },
    review: { ok: true, why: `review:${n}` },
    policyApproval: false,
    ...over,
  };
}

export function run(over: Partial<Run> & { id: number }): Run {
  return {
    run_attempt: 1,
    path: ".github/workflows/ci.yml",
    event: "push",
    head_branch: "main",
    head_sha: sha("x"),
    status: "completed",
    conclusion: "success",
    repository: { id: TARGET },
    head_repository: { id: TARGET },
    created_at: "2026-10-21T10:00:00Z",
    run_started_at: over.created_at ?? "2026-10-21T10:00:00Z",
    display_title: "run",
    ...over,
  };
}

export function job(name: string, conclusion: string | null = "success", status = "completed", started_at: string | null = "2026-10-21T10:01:00Z"): Job {
  return { id: Math.floor(Math.random() * 1e9), name, status, conclusion, html_url: `https://github.com/x/${encodeURIComponent(name)}`, started_at };
}

export const red = (names: string[] = ["Test"]): CiClass => ({
  kind: "red",
  policy: false,
  failedRuns: [{ runId: 1, attempt: 1 }],
  failedJobs: names.map((n) => ({ name: n, url: `https://github.com/j/${n}` })),
  reason: "failed",
});
export const green: CiClass = { kind: "green" };

export interface BatchView {
  n: number;
  prs: number[];
  rerun: boolean;
  /** PRs already landed in main when this batch was built. */
  mainHas: number[];
}

export type Oracle = (b: BatchView) => CiClass;

export class Sim {
  state: State = emptyState();
  main = sha("main0");
  prs: Record<string, LivePr> = {};
  paused = false;
  now = new Date("2026-10-21T12:00:00Z");
  landed: number[][] = [];
  bounced: number[] = [];
  builds: { n: number; base: string; prs: number[]; rebuild: boolean }[] = [];
  lands: { before: string; mainAtLand: string }[] = [];
  reruns = 0;
  comments: { pr: number; body: string }[] = [];
  pauses: string[] = [];
  conflicts = new Set<number>();
  mainHas: number[] = [];
  /** Called before land is performed, to simulate a race. */
  beforeLand: (() => void) | null = null;
  mainFailedJobs: string[] | null = null;
  /** Parse the state through the strict schema after every step. */
  strict = true;
  private builtWithMain = new Map<number, number[]>();

  constructor(
    public config: Config = cfg(),
    public oracle: Oracle = () => green,
  ) {}

  add(...prs: LivePr[]): this {
    for (const p of prs) this.prs[String(p.number)] = p;
    return this;
  }

  snapshot(extra: Partial<Snapshot> = {}): Snapshot {
    const a = this.state.active;
    const ci = a
      ? this.oracle({ n: a.n, prs: a.prs, rerun: a.rerun !== null, mainHas: this.builtWithMain.get(a.n) ?? [] })
      : null;
    const pinReachable: Record<string, boolean> = {};
    for (const v of this.state.verify) pinReachable[v.pin] = true;
    // As the runner reads it (src/snapshot.ts): a parked batch's CI, only while unpaused and main is its base.
    const p = this.state.parked;
    const parkedCi =
      this.config.strategy?.reuseGreen && p && !this.paused && p.base === this.main
        ? this.oracle({ n: p.n, prs: p.pins.map((x) => x.pr), rerun: false, mainHas: this.builtWithMain.get(p.n) ?? [] })
        : undefined;
    return {
      now: this.now,
      paused: this.paused,
      main: this.main,
      policyHash: "policy-1",
      prs: structuredClone(this.prs),
      ci,
      ...(parkedCi !== undefined ? { parkedCi } : {}),
      mainFailedJobs: this.mainFailedJobs,
      pinReachable,
      ...extra,
    };
  }

  private check(): void {
    if (this.strict) parseState(JSON.stringify(this.state), NAMES);
  }

  private apply(r: OpResult): void {
    this.state = applyOpResult(this.state, r, this.config, this.now).state;
    this.check();
  }

  /** Perform the journalled op, as the runner would. */
  perform(): void {
    const j = this.state.journal;
    if (!j) return;
    const op = j.op;
    if (op.kind === "build") {
      this.builds.push({ n: op.n, base: op.base, prs: op.pins.map((p) => p.pr), rebuild: op.rebuild });
      const survivors = op.pins.filter((p) => !this.conflicts.has(p.pr));
      const dropped = op.pins.filter((p) => this.conflicts.has(p.pr)).map((p) => ({ ...p, pin: p.head, outcome: "conflict" as const }));
      const chainHead = survivors.length ? sha(`${op.base}:${survivors.map((p) => p.head).join(",")}`) : null;
      this.apply({ kind: "checkpoint", record: { survivors, dropped: dropped.map(({ pr, pin, outcome }) => ({ pr, pin, outcome })), chainHead } });
      if (chainHead) {
        this.builtWithMain.set(op.n, [...this.mainHas]);
        this.apply({ kind: "built", head: chainHead });
      } else this.apply({ kind: "empty" });
    } else if (op.kind === "rerun") {
      this.reruns++;
      this.apply({ kind: "rerunDone" });
    } else if (op.kind === "cancel") {
      this.apply({ kind: "cancelled" });
    } else if (op.kind === "land") {
      this.beforeLand?.();
      this.lands.push({ before: op.before, mainAtLand: this.main });
      if (this.main === op.before) {
        const a = this.state.active!;
        this.main = op.after;
        this.landed.push([...a.prs]);
        this.mainHas.push(...a.prs);
        this.apply({ kind: "landed" });
        for (const pr of a.prs) this.prs[String(pr)] = { ...this.prs[String(pr)]!, merged: true, open: false };
      } else {
        this.apply({ kind: "baseMoved" });
      }
    }
  }

  /** Drain the outbox, as the runner would. */
  drain(): void {
    for (const n of this.state.outbox) {
      if (n.kind === "unready") {
        const p = this.prs[String(n.pr)];
        if (p) this.prs[String(n.pr)] = { ...p, labels: p.labels.filter((l) => l !== "ready"), ready: null };
      } else if (n.kind === "comment") {
        this.comments.push({ pr: n.pr, body: n.body });
        if (n.body.startsWith("Bounced")) this.bounced.push(n.pr);
      } else if (n.kind === "pause") {
        this.pauses.push(n.reason);
        this.paused = true;
      }
    }
    this.state = { ...this.state, outbox: [] };
  }

  tick(extra: Partial<Snapshot> = {}): string[] {
    const d = decide(this.state, this.snapshot(extra), this.config);
    this.state = d.state;
    this.check();
    this.perform();
    this.drain();
    this.now = new Date(this.now.getTime() + 10 * 60_000);
    return d.log;
  }

  /** Tick until nothing is left to do (or a pause, or the limit). */
  runUntilIdle(limit = 60): void {
    for (let i = 0; i < limit; i++) {
      this.tick();
      const s = this.state;
      if (this.paused) return;
      const waiting = Object.keys(s.auth).length + s.pending.length + s.solo.length;
      if (!s.active && !s.journal && waiting === 0) return;
    }
    throw new Error("simulation did not settle");
  }
}

let commandEvents = 0;
/** An authorised operator command, as the snapshot reads it from a PR label (DESIGN.md §10). */
export function cmd(kind: CommandKind, pr: number, o: { actor?: string; authorized?: boolean } = {}): Command {
  const id = ++commandEvents;
  return { kind, pr, label: NAMES.labels[kind], id, at: new Date(Date.UTC(2026, 9, 21, 11, 0, id)).toISOString(), actor: o.actor ?? HUMAN, authorized: o.authorized ?? true };
}
