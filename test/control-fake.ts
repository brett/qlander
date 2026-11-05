// Test support for the operator controls: the fake GitHub behind them (the
// control repo's issues and tick runs, both state refs and the target's
// PRs), with a tick that a dispatch starts and that reports `paused` while a
// pause issue is open.

import { CONFIG_PATH } from "../src/config/load";
import type { ControlApi } from "../src/control";
import { controlCommand } from "../src/control-cli";
import type { ControlCommand } from "../src/control-usage";
import { emptyReleaseState, type ReleaseState } from "../src/release-state";
import { emptyState, type State } from "../src/state";
import { FakeStateRef, FakeTarget } from "./fake-github";
import { APPROVERS, NAMES, sha } from "./sim";
import { ago, FakeRepo, NOW, run } from "./watchdog-fake";

export const PAUSE = NAMES.controlLabels.pause;
export const RPAUSE = NAMES.releaseLabels.pause;
export const STATUS = NAMES.watchdogLabels.status;
export const ME = APPROVERS[0]!;

export class ControlWorld {
  repo = new FakeRepo();
  queueRef = new FakeStateRef();
  releaseRef = new FakeStateRef();
  target = new FakeTarget("read");
  /** Every write, and every sleep, in order. */
  log: string[] = [];
  clock = NOW.getTime();
  /** Called on each sleep, to move the world on while a command waits. */
  onSleep: (() => void) | null = null;
  /** What a dispatched tick reports, and how its run ends, when no pause issue is open. */
  liveOutcome = "idle";
  liveConclusion = "success";
  /** The tick's report: live (an outcome), dry-run (what it read of the pause issues), or dry-run from a release whose report does not say. */
  tickMode: "live" | "dry-run" | "dry-run-unsaid" = "live";
  /** A live tick that decides to pause: its issue, opened by the tick, with an outcome that doesn't say so. */
  tickOpensPause = false;
  /** Dispatched runs never start (ghosts). */
  ghostDispatch = false;
  me = { login: ME.login, id: ME.id };
  /** The config the command loads (default: the control repo's own). */
  configPath = CONFIG_PATH;

  constructor(state: State | null = emptyState(), release: ReleaseState | null = emptyReleaseState()) {
    this.queueRef.current = state ? { version: sha("queue-v"), text: JSON.stringify(state) } : null;
    this.releaseRef.current = release ? { version: sha("release-v"), text: JSON.stringify(release) } : null;
    this.repo.seed("qlander status", [STATUS], 600);
  }
  open(label: string) {
    return this.repo.issues.filter((i) => i.open && i.labels.includes(label));
  }
  get status() {
    return this.repo.issues.find((i) => i.labels.includes(STATUS))!;
  }
  /** Writes only (no sleeps). */
  writes() {
    return this.log.filter((l) => !l.startsWith("sleep"));
  }

  api(): ControlApi {
    const w = this;
    const r = this.repo;
    const write = (s: string) => void w.log.push(s);
    const at = () => new Date(w.clock).toISOString();
    return {
      queueState: this.queueRef,
      releaseState: this.releaseRef,
      whoami: async () => w.me,
      workflowState: () => r.workflowState(),
      async setTickEnabled(on) {
        r.state = on ? "active" : "disabled_manually";
        write(on ? "enable" : "disable");
      },
      async dispatchTick() {
        write("dispatch");
        if (w.ghostDispatch) {
          r.runs.push(run({ event: "workflow_dispatch", status: "queued", conclusion: null, createdAt: at() }, null, null));
          return;
        }
        const paused = w.open(PAUSE).length > 0;
        if (!paused && w.tickOpensPause) r.seed("qlander paused: window budget used", [PAUSE], 0);
        const conclusion = paused ? "success" : w.liveConclusion;
        const x = run({ event: "workflow_dispatch", createdAt: at(), conclusion }, { conclusion });
        r.runs.push(x);
        const report = w.tickMode === "live" ? `"outcome": "${paused ? "paused" : w.liveOutcome}",` : w.tickMode === "dry-run" ? `"mode": "dry-run",\n "paused": ${paused},` : `"mode": "dry-run",`;
        r.logs.set(x.jobs![0]!.id, `2026-10-22T12:00:00.0000000Z starting\n{\n ${report}\n "log": []\n}\n`);
      },
      listRecentRuns: () => r.listRecentRuns(),
      listUnfinishedRuns: () => r.listUnfinishedRuns(),
      listJobs: (id) => r.listJobs(id),
      jobLog: (id) => r.jobLog(id),
      listOpenIssues: (l) => r.listOpenIssues(l),
      async createIssue(title, body, labels) {
        write(`create ${labels.join(",")}`);
        return r.createIssue(title, body, labels);
      },
      async closeIssue(n) {
        write(`close #${n}`);
        return r.closeIssue(n);
      },
      async comment(n, body) {
        write(`comment #${n}`);
        return r.comment(n, body);
      },
      getPr: (n) => w.target.getPr(n),
      async addPrLabel(n, label) {
        write(`label #${n} ${label}`);
        w.target.prs.get(n)!.pr.labels.push(label);
      },
      async commentPr(n, body) {
        write(`pr comment #${n} ${body}`);
      },
    };
  }

  async run(cmd: ControlCommand, args: string[] = [], env: Record<string, string> = { GH_TOKEN: "operator-token" }) {
    const out: string[] = [];
    const err: string[] = [];
    const code = await controlCommand(
      cmd,
      args,
      { out: (t) => out.push(t), err: (l) => err.push(l) },
      {
        env,
        connect: async () => this.api(),
        now: () => new Date(this.clock),
        sleep: async (ms) => {
          this.log.push(`sleep ${ms}`);
          this.clock += ms;
          this.onSleep?.();
        },
        pollMs: 10_000,
        waitMs: 60_000,
      },
      this.configPath,
      (p) => p,
    );
    return { code, out: out.join("\n"), err: err.join("\n") };
  }
}

const auth = (n: number): State["auth"][string] => ({ head: sha(`h${n}`), baseRepoId: NAMES.target.id, policy: "p", policyPr: false, admittedAt: ago(30), labelledAt: ago(31), evidence: [], reviewRun: null });
/** A queue state; every PR in a batch gets an authorisation record. */
export const withState = (over: Partial<State>): State => {
  const s = { ...emptyState(), ...over };
  for (const n of [...(s.active?.prs ?? []), ...(s.concurrent ?? []).flatMap((b) => b.prs), ...s.pending.flatMap((p) => p.prs)]) s.auth[String(n)] = auth(n);
  for (const l of [s.active?.lineage, ...(s.concurrent ?? []).map((b) => b.lineage), ...s.pending.map((p) => p.lineage)]) if (l !== undefined) s.lineages[String(l)] ??= { runs: 1 };
  if (s.concurrent?.length) s.nextLineage = Math.max(s.nextLineage, ...s.concurrent.map((b) => b.lineage + 1));
  return s;
};
export const ACTIVE: NonNullable<State["active"]> = { n: 7, base: sha("m"), head: sha("q7"), depth: 0, prs: [11, 12], lineage: 1, rerun: null, rerunAt: null, cancels: [], builtAt: ago(5) };
