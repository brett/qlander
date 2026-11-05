// The queue runner: one tick (DESIGN.md §2, §3.2, §7). It stays thin: every
// decision comes from decide()/applyOpResult()/interpretObservation(), every
// read from buildSnapshot()/observe(). The order is fixed:
//
//   1. take the lease on the state ref (corrupt → pause; held → stop)
//   2. read the durable pause (open pause issue, or a pause in the outbox)
//   3. recovery, observation only: record effects that already happened
//   4. drain the outbox
//   5. an outstanding journalled op (a checkpointed build not yet pushed, a
//      rerun not yet requested, a cancel) runs only if not paused, after a
//      fresh snapshot and revalidation, at most maxOpTries times; such a tick
//      does nothing else
//   6. otherwise: snapshot → decide → persist the intent → perform the one op,
//      with a checkpoint or receipt after every effect → drain
//   7. release the lease; mirror the state to its issue
//
// Nothing here checks out or runs target code.

import { revalidate } from "./admission";
import { type Config, epochClientProblem, invariantProblems } from "./config";
import { epochHandover, fenced, takeEpoch } from "./fenced";
import { actives, type Snapshot, type Verdict } from "./ctx";
import type { TargetApi, StateRefApi, StateRepoApi } from "./github/api";
import { GitHubError, isGraphqlInternal } from "./github/http";
import { decide } from "./machine";
import { applyOpResult, interpretObservation, isObservedOutcome, type OpResult, type Recovery } from "./ops";
import { drain, isTransient, openPause, pauseReason } from "./outbox";
import { buildSnapshot, observe, StaleSnapshotError } from "./snapshot";
import type { CommentSettings } from "./config/load";
import { deliverHooks, enqueueHooks, type Hook, type LifecycleEvent } from "./hooks";
import type { BuildRecord, Executor, Op, State } from "./state";
import { CorruptStateError, LeaseHeldError, LostLockError, mirror, queueCodec, StateStore } from "./store";
import { buildRef, queueRef } from "./validate";
import { retickAt, type Wake, wakeFor } from "./wake";

/** How long a GitHub-internal GraphQL error counts towards a pause (Tick.countInternalError). */
export const INTERNAL_ERROR_WINDOW_MS = 60 * 60_000;

/** Named points where tests inject a crash (the process dying). */
export type CrashPoint =
  | "after-intent"
  | "after-build-ref"
  | "after-merges"
  | "after-checkpoint"
  | "after-queue-ref"
  | "after-effect"
  | "after-receipt"
  | "mid-drain";

export class CrashError extends Error {
  constructor(readonly point: CrashPoint) {
    super(`injected crash at ${point}`);
    this.name = "CrashError";
  }
}

export interface RunnerDeps {
  target: TargetApi;
  /** Qlander's own issues: pause issues and the state mirror. */
  repo: StateRepoApi;
  /** The store of record. */
  stateRef: StateRefApi;
  cfg: Config;
  now: () => Date;
  runId: string;
  /** The Actions job running this tick; recorded in the lease (DESIGN.md §15). Always set in production. */
  executor?: Executor | null;
  crash?: (point: CrashPoint) => void;
  /** Lifecycle hooks (qlander.yml `hooks`, src/hooks.ts). Not policy: not in cfg, so not in the policy hash. */
  hooks?: Hook[];
  /** PR comments to leave out (qlander.yml `comments`). Not policy: not in cfg. Absent: every comment is posted. */
  comments?: CommentSettings;
}

export type TickOutcome = "acted" | "idle" | "waiting" | "stale" | "busy" | "lost-lock" | "retry-later" | "paused";

export interface TickResult {
  outcome: TickOutcome;
  log: string[];
  /** The open PRs GitHub listed with the ready label when this tick decided (src/snapshot.ts); absent when it did not decide. */
  readyListed?: number[];
  /** Every ready PR this tick's decision did not admit, and why (src/machine.ts); absent when there is none. */
  ignored?: Verdict[];
  /** Whether the next tick should start promptly (src/wake.ts); set only once the lease is released. */
  wake?: Wake;
}

/** JSON with every object's keys sorted, recursively; arrays keep their order. */
export function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

/**
 * The policy hash v2 (docs/deployment.md §8.2): `v2:` and 16 hex of sha256
 * over the canonical form of the whole Config, every identity included, so it
 * does not depend on key order. Every authorisation records the hash it was
 * admitted under; revalidation drops a PR whose recorded hash is not this one.
 * No older (unprefixed) hash is accepted, so the change to v2 merges only
 * while no PR is admitted.
 */
export function policyHash(cfg: Config): string {
  // The runner contract is not policy (Config.runner); its timing numbers are hashed under their own keys.
  // Nor is queue.concurrency: it orders and overlaps tested landings, and admits nothing.
  // Nor is queue.strategy: it decides how a red batch is isolated, and admits nothing.
  return `v2:${new Bun.CryptoHasher("sha256").update(canonicalJson({ ...cfg, runner: undefined, concurrency: undefined, strategy: undefined })).digest("hex").slice(0, 16)}`;
}

/** The longest title, in code points, a merge commit message carries. */
export const MERGE_TITLE_MAX = 200;

/**
 * A PR title as one line for a merge commit message: control characters,
 * line and paragraph separators and bidi controls become spaces, whitespace
 * collapses, and a title longer than MERGE_TITLE_MAX code points is cut with
 * an ellipsis. Null when there is no usable title.
 */
export function mergeTitle(title: string | undefined): string | null {
  if (title === undefined) return null;
  const flat = title
    .replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}\ufeff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (flat === "") return null;
  const cps = Array.from(flat);
  return cps.length <= MERGE_TITLE_MAX ? flat : `${cps.slice(0, MERGE_TITLE_MAX - 1).join("").trimEnd()}\u2026`;
}

/**
 * The message of a build's merge commit for one PR. The subject and the
 * `Landed-by:` line are fixed; a `Title:` line follows when the PR's title is
 * known, always last and always one line, so it can never read as another
 * trailer.
 */
export function mergeMessage(pr: number, head: string, n: number, title?: string): string {
  const t = mergeTitle(title);
  return `Merge pull request #${pr} at ${head}\n\nLanded-by: qlander batch ${n}${t === null ? "" : `\nTitle: ${t}`}`;
}

const stableId = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);

class Tick {
  log: string[] = [];
  acted = false;
  private readonly d: RunnerDeps;
  constructor(
    deps: RunnerDeps,
    readonly store: StateStore,
    public state: State,
  ) {
    // Every target write in this tick goes through the lease fence; reads do not.
    // With the epoch fence on, every ref write also carries the epoch taken below.
    this.d = { ...deps, target: fenced(deps.target, () => store.fence(), deps.cfg.runner.epochFence ? () => this.epoch : null, (ms) => store.sleep(ms)) };
  }

  /** The epoch this tick advanced to (docs/deployment.md §3.4); null until taken, and while the fence is off. */
  private epoch: string | null = null;

  /** First act after the lease: advance the epoch, which voids every ref write a predecessor could still send. */
  async takeEpoch(): Promise<void> {
    if (!this.d.cfg.runner.epochFence) return;
    this.epoch = await takeEpoch(this.d.target, this.store.runId);
    this.log.push(`epoch ${this.d.target.epochBranch} advanced to ${this.epoch}`);
  }

  private crash(p: CrashPoint): void {
    this.d.crash?.(p);
  }

  async save(): Promise<void> {
    await this.store.write(this.state);
  }

  /** The kind of the last op result applied (for the wake hint). */
  lastResult: string | null = null;
  /** This tick's selection chose to keep filling until then (ms); null otherwise. */
  fillUntil: number | null = null;
  /** A PR is held on unknown mergeability: re-tick then (ms); null otherwise. */
  retickAt: number | null = null;
  /** What the decision saw and refused, for the tick report (TickResult.readyListed, .ignored). */
  readyListed: number[] | null = null;
  ignored: Verdict[] = [];

  /** TickResult.readyListed and .ignored, present only once the tick decided. */
  report(): Pick<TickResult, "readyListed" | "ignored"> {
    return { ...(this.readyListed !== null ? { readyListed: this.readyListed } : {}), ...(this.ignored.length > 0 ? { ignored: this.ignored } : {}) };
  }

  private async apply(r: OpResult): Promise<void> {
    this.lastResult = r.kind;
    const out = applyOpResult(this.state, r, this.d.cfg, this.d.now(), this.d.comments);
    this.state = this.withHooks(out.state, out.events);
    this.log.push(...out.log);
    await this.save();
  }

  /** Queue the hook deliveries for these events in the same state write as the transition (src/hooks.ts). */
  private withHooks(state: State, events: LifecycleEvent[] | undefined): State {
    const q = enqueueHooks(state, events, this.d.hooks, this.d.now());
    this.log.push(...q.log);
    return q.state;
  }

  /**
   * Send waiting hook deliveries. Never fails the tick: delivery failures are
   * recorded in state.hooks.failed (shown in the status issue). Delivery is
   * time-boxed (DELIVERY_BUDGET_MS) and stops quietly if the lease fence
   * refuses; only an injected crash propagates. The state is persisted by
   * the lease release that follows.
   */
  async deliverHooks(): Promise<void> {
    const h = this.state.hooks;
    if (!h || h.outbox.length === 0) return;
    const out = await deliverHooks(h, {
      target: this.d.target,
      now: this.d.now(),
      rethrow: (e) => e instanceof CrashError,
      // The fence refused (lease too short, or lost): stop sending; the release that follows decides whether the lease is really gone.
      stop: (e) => e instanceof LostLockError,
    });
    this.log.push(...out.log);
    if (out.changed) this.state = { ...this.state, hooks: out.hooks };
  }

  /** Fails closed: an unreadable or incomplete pause listing counts as paused (src/outbox.ts pauseReason). */
  async paused(): Promise<boolean> {
    if (this.state.outbox.some((n) => n.kind === "pause")) return true;
    const why = await pauseReason(this.d.repo, this.d.cfg.names.controlLabels.pause);
    if (why && !this.log.includes(`paused: ${why}`)) this.log.push(`paused: ${why}`);
    return why !== null;
  }

  /** Step 3: record what already happened. Returns what is still outstanding, if anything. */
  async observeJournal(): Promise<Recovery | null> {
    const j = this.state.journal;
    if (!j) return null;
    const r = interpretObservation(j, await observe(this.d.target, j, this.d.cfg.names), this.state.auth, { now: this.d.now(), reconcileMinutes: this.d.cfg.reconcileMinutes });
    this.log.push(`recover ${j.op.kind}: ${r.kind}`);
    if (!isObservedOutcome(r)) return r;
    await this.apply(r as OpResult);
    return this.state.journal ? r : null; // still outstanding (e.g. a rerun being reconciled)
  }

  async drainOutbox(): Promise<void> {
    if (this.state.outbox.length === 0) return;
    const out = await drain(this.state, {
      target: this.d.target,
      repo: this.d.repo,
      names: this.d.cfg.names,
      now: this.d.now(),
      reconcileMinutes: this.d.cfg.reconcileMinutes,
      save: async (outbox) => {
        this.state = { ...this.state, outbox };
        await this.save();
      },
      afterEach: () => this.crash("mid-drain"),
    });
    this.log.push(...out.log);
    this.state = { ...this.state, outbox: out.outbox };
    await this.save();
    if (out.failure) await openPause(this.d.repo, this.d.cfg.names, `outbox:${out.failure.id}`, out.failure.reason);
    if (out.internalError) throw out.internalError; // the tick ends here, and counts it
  }

  /**
   * Step 5: finish an outstanding op, only after revalidating against a fresh
   * snapshot (review #7) and at most maxOpTries times (review #6).
   */
  async resolve(r: Recovery, snap: Snapshot): Promise<void> {
    const j = this.state.journal!;
    if (j.tries >= this.d.cfg.maxOpTries) {
      await this.apply({ kind: "opAbandoned", reason: `${j.op.kind} re-executed ${j.tries} times without completing` });
      return;
    }
    await this.apply({ kind: "tried" });
    const op = j.op;
    const valid = (prs: { pr: number; head?: string }[]) =>
      prs.every((p) => {
        const auth = this.state.auth[String(p.pr)];
        if (!auth || (p.head !== undefined && auth.head !== p.head)) return false;
        return revalidate(auth, snap.prs[String(p.pr)], this.d.cfg, snap.policyHash).ok;
      });
    if (r.kind === "resumeBuild" && op.kind === "build") {
      const survivors = j.checkpoint?.survivors ?? [];
      // Its base must still be main, or (pipelining, DESIGN.md §5.6) the head of a batch still running.
      const baseOk = snap.main === op.base || actives(this.state).some((x) => x.head === op.base);
      if (!baseOk || !valid(survivors)) {
        await this.apply({ kind: "buildAborted", reason: "the recorded batch is no longer valid; not pushed" });
        return;
      }
      this.acted = true;
      await this.d.target.createRef(queueRef(this.d.cfg.names, op.n), r.head);
      this.crash("after-queue-ref");
      await this.apply({ kind: "built", head: r.head });
      return;
    }
    if (op.kind === "rerun" && !valid((this.state.active?.prs ?? []).map((pr) => ({ pr })))) {
      await this.apply({ kind: "opDropped", reason: "the batch is no longer valid" });
      return;
    }
    await this.perform(snap);
  }

  /** Perform the journalled op. Every effect is followed by a checkpoint or receipt. */
  async perform(snap: Snapshot): Promise<void> {
    const j = this.state.journal;
    if (!j) return;
    this.acted = true;
    const c = this.d.target;
    const op = j.op;
    switch (op.kind) {
      case "build":
        return this.build(op, snap);
      case "rerun": {
        // One intent and one receipt per request (review #2).
        for (const run of [...op.runs]) {
          await this.apply({ kind: "rerunSending", run, at: this.d.now().toISOString() });
          try {
            await c.rerunFailedJobs(run.runId);
          } catch (e) {
            if (e instanceof GitHubError && e.kind === "not_found") {
              await this.apply({ kind: "targetMissing", reason: `run ${run.runId} no longer exists` });
              return;
            }
            throw e; // ambiguous: the request stays "requested" and is reconciled, never blindly resent
          }
          this.crash("after-effect");
          await this.apply({ kind: "rerunConfirmed", run });
        }
        await this.apply({ kind: "rerunDone" });
        this.crash("after-receipt");
        return;
      }
      case "cancel":
        for (const r of op.runs) {
          try {
            await c.cancelRun(r.runId);
          } catch (e) {
            if (!(e instanceof GitHubError && e.kind === "not_found")) throw e;
          }
        }
        this.crash("after-effect");
        await this.apply({ kind: "cancelled" });
        this.crash("after-receipt");
        return;
      case "land": {
        let result: OpResult;
        try {
          await c.updateRef(this.d.cfg.names.main, op.before, op.after); // CAS: beforeOid, force false
          this.crash("after-effect");
          result = { kind: "landed" };
        } catch (e) {
          // A crash, or a lost lease at the fence: not a landing outcome. The tick ends quietly.
          if (e instanceof CrashError || e instanceof LostLockError) throw e;
          // Judge by the ref, not the error text: did it move, and where to?
          const main = await c.getRef(this.d.cfg.names.main);
          if (main === op.after) result = { kind: "landed" };
          else if (main !== op.before) result = { kind: "baseMoved" };
          // The write may have applied and this read may lag: the journal stays, and the next tick judges again.
          else if (isGraphqlInternal(e)) throw e;
          else result = { kind: "landRejected", retry: isTransient(e), reason: String(e) };
        }
        await this.apply(result);
        this.crash("after-receipt");
        return;
      }
    }
  }

  private async build(op: Extract<Op, { kind: "build" }>, snap: Snapshot): Promise<void> {
    if (this.state.journal?.checkpoint) return; // recovery owns a recorded build
    const c = this.d.target;
    const build = buildRef(this.d.cfg.names, op.n);
    await c.createRef(build, op.base);
    this.crash("after-build-ref");
    const survivors: BuildRecord["survivors"] = [];
    const dropped: BuildRecord["dropped"] = [];
    const merges: string[] = [];
    for (const pin of op.pins) {
      let r;
      try {
        r = await c.merge(build, pin.head, mergeMessage(pin.pr, pin.head, op.n, snap.prs[String(pin.pr)]?.title));
      } catch (e) {
        if (e instanceof GitHubError && e.kind === "not_found") {
          await this.apply({ kind: "buildAborted", reason: `merging #${pin.pr}: ${e.message}` });
          return;
        }
        throw e;
      }
      if (r.kind === "merged") {
        survivors.push(pin);
        merges.push(r.sha);
      } else dropped.push({ pr: pin.pr, pin: pin.head, outcome: r.kind });
    }
    this.crash("after-merges");
    for (const m of merges) {
      const commit = await c.getCommit(m);
      if (!commit.verified || commit.reason !== "valid") {
        await this.apply({ kind: "buildFailed", reason: `merge commit ${m} is not signed and verified (${commit.reason})` });
        return;
      }
    }
    const chainHead = merges.at(-1) ?? null;
    await this.apply({ kind: "checkpoint", record: { survivors, dropped, chainHead } });
    this.crash("after-checkpoint");
    if (!this.state.journal) return; // the record was rejected (and paused)
    if (chainHead === null) {
      await this.apply({ kind: "empty" });
      return;
    }
    await c.createRef(queueRef(this.d.cfg.names, op.n), chainHead);
    this.crash("after-queue-ref");
    await this.apply({ kind: "built", head: chainHead });
    this.crash("after-receipt");
  }

  async snapshot(paused: boolean): Promise<Snapshot> {
    return buildSnapshot({
      api: this.d.target,
      cfg: this.d.cfg,
      state: this.state,
      now: this.d.now(),
      paused,
      policyHash: policyHash(this.d.cfg),
    });
  }

  /** The main sequence, steps 2 to 6. */
  async run(): Promise<TickOutcome> {
    let paused = await this.paused();
    const outstanding = await this.observeJournal();
    await this.drainOutbox();
    paused = paused || (await this.paused());
    if (this.state.journal && outstanding) {
      this.log.push(`admission not evaluated this tick: a journalled ${this.state.journal.op.kind} is outstanding`);
      if (paused) return "paused";
      if (outstanding.kind === "rerunReconcile" && (this.state.journal.op.kind !== "rerun" || (this.state.journal.op.requested ?? []).length > 0)) return "waiting";
      const snap = await this.snapshot(paused);
      await this.resolve(outstanding, snap);
      await this.drainOutbox();
      return "acted";
    }
    const snap = await this.snapshot(paused);
    const dec = decide(this.state, snap, this.d.cfg);
    this.log.push(...dec.log);
    this.readyListed = snap.readyListed ?? null;
    this.ignored = dec.ignored ?? [];
    this.state = this.withHooks(dec.state, dec.events);
    this.fillUntil = dec.fillUntil ?? null;
    this.retickAt = retickAt(dec.holdSince, this.d.now().getTime());
    await this.save(); // the intent is durable before anything happens
    this.crash("after-intent");
    await this.perform(snap);
    await this.drainOutbox();
    return this.acted ? "acted" : paused ? "paused" : "idle";
  }

  /**
   * Counts a GitHub-internal GraphQL error. One retries next tick, on a green
   * job. The same words are also how GitHub refuses a ref write, which no retry
   * fixes, so each one is recorded durably, and maxOpTries of them within the
   * window pause the queue. Returns the count that stops it, or null to retry.
   */
  countInternalError(): number | null {
    const times = [...this.recentInternalErrors(), this.d.now().toISOString()];
    if (times.length >= this.d.cfg.maxOpTries) {
      this.setInternalErrors([]);
      return times.length;
    }
    this.setInternalErrors(times);
    return null;
  }

  private recentInternalErrors(): string[] {
    const now = this.d.now().getTime();
    return (this.state.internalErrors ?? []).filter((t) => now - Date.parse(t) < INTERNAL_ERROR_WINDOW_MS);
  }

  private setInternalErrors(times: string[]): void {
    const { internalErrors: _old, ...rest } = this.state;
    this.state = times.length > 0 ? { ...rest, internalErrors: times } : rest;
  }

  /** A time older than the window is gone, so the field does not stay in the state. */
  expireInternalErrors(): void {
    if (this.state.internalErrors) this.setInternalErrors(this.recentInternalErrors());
  }

  /**
   * A hard failure: record it as a pause notice in state first, then try to
   * open the issue. A failed issue creation leaves the pause pending, so the
   * next tick is paused too (review #4).
   */
  async halt(e: GitHubError): Promise<void> {
    const id = `halt:${e.kind}:${stableId(e.message)}`;
    if (!this.state.outbox.some((n) => n.id === id)) {
      this.state = { ...this.state, outbox: [...this.state.outbox, { id, kind: "pause", reason: `qlander stopped on a ${e.kind} error: ${e.message}` }] };
    }
    await this.save();
    try {
      await this.drainOutbox();
    } catch (err) {
      if (!(err instanceof GitHubError)) throw err;
    }
  }
}

/**
 * One tick. Transient errors and lost races retry next tick; configuration,
 * permission and validation errors pause durably. A crash (CrashError, or the
 * process dying) leaves the lease to expire and the journal to recovery.
 */
/**
 * A run id unique to one execution: the Actions run id and attempt, plus a
 * random part, so no two executions ever share a lease owner.
 */
export function makeRunId(env: Record<string, string | undefined>, random: () => string = () => crypto.randomUUID().slice(0, 8)): string {
  const id = /^[0-9]{1,20}$/.test(env.GITHUB_RUN_ID ?? "") ? env.GITHUB_RUN_ID : "local";
  const attempt = /^[0-9]{1,5}$/.test(env.GITHUB_RUN_ATTEMPT ?? "") ? env.GITHUB_RUN_ATTEMPT : "0";
  return `${id}.${attempt}.${random().replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;
}

export async function tick(d: RunnerDeps): Promise<TickResult> {
  const refused = epochClientProblem(d.cfg.runner, d.target.epochBranch, "queue");
  if (refused) throw new Error(`refusing to run: ${refused}`);
  const broken = invariantProblems(d.cfg, d.cfg.runner.cronMinutes);
  if (broken.length > 0) throw new Error(`refusing to run: ${broken.join("; ")}`);
  let opened: { store: StateStore; state: State; handover?: string };
  try {
    opened = await StateStore.open(d.stateRef, d.repo, d.runId, d.cfg, d.executor ?? null, queueCodec(d.cfg.names), epochHandover(d.target, d.cfg.runner, "queue", d.runId));
  } catch (e) {
    if (e instanceof CorruptStateError) {
      const log = [e.message];
      try {
        await openPause(d.repo, d.cfg.names, "corrupt-state", e.message);
      } catch (err) {
        if (!isTransient(err)) throw err;
        log.push(`pause issue not opened yet: ${String(err)}`); // the state stays unreadable, so the next tick pauses again
      }
      return { outcome: "paused", log };
    }
    if (e instanceof LeaseHeldError) return { outcome: "busy", log: [e.message] };
    // Taking the lease is the state's first write. An internal GraphQL error here fails the job
    // (ticks-failing in the watchdog): a state write refused for good could not record any count.
    if (isTransient(e) && !isGraphqlInternal(e)) return { outcome: "retry-later", log: [String(e)] };
    throw e;
  }
  const t = new Tick(d, opened.store, opened.state);
  if (opened.handover) t.log.push(opened.handover);
  let outcome: TickOutcome;
  try {
    await t.takeEpoch();
    outcome = await t.run();
    await t.deliverHooks();
  } catch (e) {
    if (e instanceof CrashError) throw e;
    if (e instanceof LostLockError) return { outcome: "lost-lock", log: [...t.log, e.message], ...t.report() };
    const repeated = isGraphqlInternal(e) ? t.countInternalError() : null;
    if (e instanceof StaleSnapshotError) outcome = "stale";
    else if (repeated !== null) {
      await t.halt(new GitHubError("server", 200, `GitHub's generic GraphQL error, ${repeated} times within ${INTERNAL_ERROR_WINDOW_MS / 60_000} minutes, so it may be a refusal and not a fault; the last: ${String(e)}`));
      outcome = "paused";
    } else if (isTransient(e) || (e instanceof GitHubError && e.kind === "conflict")) outcome = "retry-later";
    else if (e instanceof GitHubError) {
      await t.halt(e);
      outcome = "paused";
    } else throw e;
    t.log.push(String(e));
  }
  t.expireInternalErrors();
  let released = false;
  try {
    await t.store.release(t.state);
    released = true;
  } catch (e) {
    if (e instanceof LostLockError) return { outcome: "lost-lock", log: t.log, ...t.report() };
    // The count lives in this write. Failing the job leaves a trace when it cannot be recorded.
    if (!isTransient(e) || isGraphqlInternal(e)) throw e;
  }
  try {
    await mirror(d.repo, d.cfg.names, t.state);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    t.log.push(`mirror not updated: ${String(e)}`);
  }
  // A lease we could not release would make a chained tick busy: leave the next tick to the cron.
  return {
    outcome,
    log: t.log,
    ...t.report(),
    wake: released ? wakeFor(outcome, t.state, t.lastResult, t.fillUntil, t.retickAt, d.cfg.concurrency?.maxActive ?? 1) : { kind: "none" },
  };
}
