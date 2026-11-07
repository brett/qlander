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
import { epochHandover, fenced, LAG_WAITS_MS, takeEpoch } from "./fenced";
import { actives, type Snapshot, type Verdict } from "./ctx";
import type { TargetApi, StateRefApi, StateRepoApi } from "./github/api";
import { GitHubError, isGraphqlInternal } from "./github/http";
import { decide } from "./machine";
import { applyOpResult, interpretObservation, isObservedOutcome, type OpResult, type Recovery } from "./ops";
import { drain, isTransient, openPause, pauseReason } from "./outbox";
import { buildSnapshot, observe, StaleSnapshotError } from "./snapshot";
import type { CommentSettings } from "./config/load";
import { deliverHooks, enqueueHooks, type Hook, type LifecycleEvent } from "./hooks";
import { type BuildRecord, commitPrefix, type Executor, type Op, OWN_MAX, type StackCommit, type State } from "./state";
import { CorruptStateError, LeaseHeldError, LostLockError, mirror, queueCodec, StateStore } from "./store";
import { buildRef, queueRef } from "./validate";
import { retickAt, type Wake, wakeFor } from "./wake";
import { noreplyEmail } from "./github/target";

/** How long a GitHub-internal GraphQL error counts towards a pause (Tick.countInternalError). */
export const INTERNAL_ERROR_WINDOW_MS = 60 * 60_000;

/** Named points where tests inject a crash (the process dying). */
export type CrashPoint =
  | "after-intent"
  | "after-build-ref"
  | "after-merges"
  | "after-stack"
  | "after-checkpoint"
  | "after-queue-ref"
  | "after-branches"
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
  /** How a landing waits between reads of its PRs (default: the real clock); tests pass their own. */
  sleep?: (ms: number) => Promise<void>;
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
 * Whether a flattened title could read as the fixed merge subject or as a
 * trailer once it starts a line: `Merge pull request`, a hyphenated token and a
 * colon (git's trailer shape, without the one-word tokens conventional commit
 * types use), or `Title:`; or start with `---`, git's patch divider, which
 * hides the real trailers from `git interpret-trailers`. Judged with
 * compatibility forms and dashes folded and invisible characters gone, so none
 * of them can hide the words.
 */
function readsAsMergeLine(title: string): boolean {
  const s = title.normalize("NFKC").replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").replace(/\p{Pd}/gu, "-").replace(/\s+/g, " ").trim().toLowerCase();
  return s.startsWith("---") || /^merge pull request\b/.test(s) || /^(?:title|[a-z0-9]+(?:-[a-z0-9]+)+) ?:/.test(s);
}

/**
 * The message of a build's merge commit for one PR: the subject
 * `<title> (#<pr>)`, then the admitted head and the `Landed-by:` line. A title
 * is one line, so it adds no line of its own. Without a usable title, or with
 * one that could read as this message's other lines, the subject is the fixed
 * `Merge pull request #<pr> at <head>`, and such a title goes on a last `Title:`
 * line. Nothing in qlander reads a message back: identity is the commit's
 * parents (DESIGN.md §7.1).
 */
export function mergeMessage(pr: number, head: string, n: number, title?: string): string {
  const t = mergeTitle(title);
  const landedBy = `Landed-by: qlander batch ${n}`;
  if (t === null) return `Merge pull request #${pr} at ${head}\n\n${landedBy}`;
  if (readsAsMergeLine(t)) return `Merge pull request #${pr} at ${head}\n\n${landedBy}\nTitle: ${t}`;
  return `${t} (#${pr})\n\nMerged from #${pr} at ${head}.\n\n${landedBy}`;
}

/**
 * The message of a linear stack commit (DESIGN.md §7.4): the subject
 * `<title> (#<pr>)`, the title flattened and cut as for a merge commit (or
 * `Pull request #<pr>` when there is none), a blank line, then
 * queue.landing.body with its placeholders filled in. A title that could read
 * as one of this message's lines gets the neutral subject and a `Title:` line
 * after the body, as in mergeMessage.
 */
export function linearMessage(pr: number, head: string, n: number, title: string | undefined, body: string, coAuthor?: { login: string; email: string }): string {
  const t = mergeTitle(title);
  const forged = t !== null && readsAsMergeLine(t);
  const subject = t === null || forged ? `Pull request #${pr}` : `${t} (#${pr})`;
  const trailer = coAuthor ? `\n\nCo-authored-by: ${coAuthor.login} <${coAuthor.email}>` : "";
  return `${subject}\n\n${body.replaceAll("{number}", String(pr)).replaceAll("{head}", head).replaceAll("{batch}", String(n))}${forged ? `\nTitle: ${t}` : ""}${trailer}`;
}

/**
 * Who a stack commit credits (DESIGN.md §7.4): the PR's author at their
 * GitHub noreply address, or null when GitHub returned no usable account.
 * With `author: app` it is a Co-authored-by trailer on an App-authored,
 * signed commit; with `author: author` it is the commit's author, and the
 * commit is unsigned. Never a real address.
 */
export function prAuthor(live: { author?: string; authorId?: number } | undefined): { login: string; email: string } | null {
  if (!live?.author || live.authorId === undefined) return null;
  const email = noreplyEmail(live.author, live.authorId);
  return email ? { login: live.author, email } : null;
}

/** How long, and how often, a landing waits for GitHub to process its PR branch moves (DESIGN.md §7.4). */
export const LAND_HEAD_WAIT_MS = 120_000;
export const LAND_HEAD_POLL_MS = 500;
/** Shorter than the wait above, so a tick that does both still fits a job. */
export const LAND_SETTLE_WAIT_MS = 30_000;

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
    // A PR's own read still at its stack commit, with its branch read back at the admitted head: GitHub has not processed the move back (DESIGN.md §7.4). Not a push, so nothing is dropped.
    if (r.kind === "retryLand" && j.op.kind === "land" && j.op.heads?.some((h) => snap.prs[String(h.pr)]?.head === h.after)) {
      await this.apply(this.unsettled(j.op, j.at, "a PR still reads at its stack commit"));
      return;
    }
    if (j.tries >= this.d.cfg.maxOpTries) {
      await this.endLinear(j.op, { kind: "opAbandoned", reason: `${j.op.kind} re-executed ${j.tries} times without completing` });
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
    // A linear landing is resent only as a fresh one would be sent (DESIGN.md §7.4): main still its base,
    // the batch's latest CI attempt green on that head (§5.3 rule 5), and every PR revalidated (§4.2).
    if (r.kind === "retryLand" && op.kind === "land") {
      const a = this.state.active;
      if (a?.head !== op.after || snap.ci?.kind !== "green") {
        await this.endLinear(op, { kind: "opDropped", reason: `the batch's CI is ${snap.ci?.kind ?? "unread"} now, not green` });
        return;
      }
      if (snap.main !== op.before || !valid((op.heads ?? []).map((h) => ({ pr: h.pr, head: h.before })))) {
        await this.endLinear(op, { kind: "opDropped", reason: "the batch no longer revalidates on this main" });
        return;
      }
    }
    if (op.kind === "rerun" && !valid((this.state.active?.prs ?? []).map((pr) => ({ pr })))) {
      await this.apply({ kind: "opDropped", reason: "the batch is no longer valid" });
      return;
    }
    await this.perform(snap);
  }

  private unsettled(op: Extract<Op, { kind: "land" }>, since: string, why: string): OpResult {
    const heads = op.heads ?? [];
    return {
      kind: "landUnsettled",
      overdue: this.d.now().getTime() - Date.parse(since) >= this.d.cfg.reconcileMinutes * 60_000,
      reason: `the linear landing could not settle its PR branches (${why}). Qlander retries each tick; each should read at its admitted head: ${heads.map((h) => `${h.ref} (#${h.pr}) ${h.before}`).join(", ")}, and ${heads.map((h) => h.after).join(", ")} are its stack commits. The journal is kept, so a landing that did apply is still recorded`,
    };
  }

  /**
   * Linear landing (DESIGN.md §7.4), on every way out that is not a landing:
   * is it on main, and if not, prove where everything is with one guarded write
   * that also moves back each PR branch read at its stack commit. Accepted, the
   * write says that at one instant main was as read and each branch was as read,
   * so a lagging read cannot end the op with a branch left behind, and a landing
   * cannot be unwound. Refused, nothing is proved and the journal stays.
   * Returns null when main is at its base and every branch back at its admitted
   * head; a pushed branch is guarded, never moved.
   */
  private async settle(op: Extract<Op, { kind: "land" }>, since: string): Promise<OpResult | null> {
    const c = this.d.target;
    const name = this.d.cfg.names.main;
    const main = await c.getRef(name);
    if (main === op.after) return { kind: "landed" };
    const heads = op.heads ?? [];
    const unsettled = (why: string) => this.unsettled(op, since, why);
    if (main === null) return unsettled(`${name} did not read`);
    const seen = await c.compare(op.after, main);
    if (seen.status === "ahead" || seen.status === "identical") return { kind: "landed" };
    const now = new Map<number, string | null>();
    for (const h of heads) {
      let at = await c.getPrBranch(h.ref);
      // An absent branch can have no guard in the write below, so one read is not enough: it must stay absent.
      for (const ms of at === null ? LAG_WAITS_MS : []) {
        await this.pause(ms);
        at = await c.getPrBranch(h.ref);
        if (at !== null) break;
      }
      now.set(h.pr, at);
    }
    const moves = heads.flatMap((h) => {
      const at = now.get(h.pr)!;
      return at === null ? [] : [{ branch: h.ref, before: at, after: at === h.after ? h.before : at }];
    });
    try {
      await c.moveBranches({ branch: name, at: main }, moves, null);
    } catch (e) {
      if (e instanceof CrashError || e instanceof LostLockError) throw e;
      return unsettled(String(e));
    }
    // The next decision reads PRs, not branches: none may still read at its stack commit, or it would pass for an author's push. Until then the journal stays.
    if (!(await this.waitForPrs(heads.filter((h) => now.get(h.pr) !== null), (h, sha) => sha !== h.after, LAND_SETTLE_WAIT_MS))) return unsettled("a PR still reads at its stack commit");
    if (main !== op.before) return { kind: "baseMoved" };
    const pushed = heads.filter((h) => now.get(h.pr) !== h.before && now.get(h.pr) !== h.after).map((h) => h.pr);
    return pushed.length > 0 ? { kind: "headMoved", prs: pushed } : null;
  }

  /**
   * Linear landing (DESIGN.md §7.4): main moves only once GitHub has processed each
   * PR branch's move, which a PR's own read shows. A main push that overtakes that
   * closes the PR without the merged mark, for good. Too slow, or a push: the error
   * takes it to settle, and a head that was pushed to refuses landStack anyway.
   */
  private async headsProcessed(op: Extract<Op, { kind: "land" }>): Promise<void> {
    const heads = op.heads ?? [];
    // Somebody's push: no reason to wait for a head that will not come, and landStack refuses it.
    if (!(await this.waitForPrs(heads, (h, sha) => sha === h.after || sha !== h.before, LAND_HEAD_WAIT_MS))) throw new GitHubError("server", null, `GitHub has not processed the move of ${heads.map((h) => `${h.ref} (#${h.pr})`).join(", ")} after ${LAND_HEAD_WAIT_MS / 1000} seconds`);
  }

  private pause(ms: number): Promise<void> {
    return (this.d.sleep ?? ((x) => this.store.sleep(x)))(ms);
  }

  /** Read each PR until `done` holds for its head, up to `ms` by the clock or by the waits alone. False when time ran out. */
  private async waitForPrs(heads: NonNullable<Extract<Op, { kind: "land" }>["heads"]>, done: (h: { before: string; after: string }, sha: string) => boolean, ms: number): Promise<boolean> {
    const started = Date.now();
    let left = heads;
    for (let i = 0; ; i++) {
      const seen = await Promise.all(left.map((h) => this.d.target.getPr(h.pr)));
      left = left.filter((h, k) => !done(h, seen[k]!.head.sha));
      if (left.length === 0) return true;
      if (Date.now() - started >= ms || i * LAND_HEAD_POLL_MS >= ms) return false;
      await this.pause(LAND_HEAD_POLL_MS);
    }
  }

  /** End a journalled op with `result`; a linear landing settles first, and only a clean result lets it end this way. */
  private async endLinear(op: Op, result: OpResult): Promise<void> {
    const j = this.state.journal!;
    if (op.kind === "land" && op.heads) await this.apply((await this.settle(op, j.at)) ?? result);
    else await this.apply(result);
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
        const main = this.d.cfg.names.main;
        try {
          if (op.heads) {
            // Linear (DESIGN.md §7.4): GitHub marks a PR merged only if its head already reads where the main push reaches, so the branches move first, each write guarding the other's refs.
            await c.moveBranches({ branch: main, at: op.before }, op.heads.map((h) => ({ branch: h.ref, before: h.before, after: h.after })), null);
            this.crash("after-branches");
            await this.headsProcessed(op);
            await c.landStack({ branch: main, before: op.before, after: op.after }, op.heads.map((h) => ({ branch: h.ref, at: h.after })), null);
          } else await c.updateRef(main, op.before, op.after); // CAS: beforeOid, force false
          this.crash("after-effect");
          result = { kind: "landed" };
        } catch (e) {
          // A crash, or a lost lease at the fence: not a landing outcome. The tick ends quietly.
          if (e instanceof CrashError || e instanceof LostLockError) throw e;
          if (op.heads) {
            // Linear: every ref where the batch left it is a refusal the next tick retries.
            result = (await this.settle(op, j.at)) ?? { kind: "landRefused", counted: isGraphqlInternal(e) || !isTransient(e), reason: String(e) };
          } else {
            // Judge by the ref, not the error text: did it move, and where to?
            const now = await c.getRef(main);
            if (now === op.after) result = { kind: "landed" };
            else if (now !== op.before) result = { kind: "baseMoved" };
            // The write may have applied and this read may lag: the journal stays, and the next tick judges again.
            else if (isGraphqlInternal(e)) throw e;
            else result = { kind: "landRejected", retry: isTransient(e), reason: String(e) };
          }
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
    const landing = this.d.cfg.landing;
    // What landed squashed, and what will if the batches under this base land (DESIGN.md §7.4). A batch beside this one is not under it: if it lands first, this one rebuilds on the new main.
    const squashed = new Set(this.state.squashed);
    const all = actives(this.state);
    for (let a = all.find((x) => x.head === op.base); a; a = all.find((x) => x.n === a!.on)) for (const x of a.stack ?? []) for (const p of x.own) squashed.add(p);
    const own = new Map<number, string[]>();
    for (const pin of op.pins) {
      if (landing || squashed.size > 0) {
        let carried;
        try {
          carried = await c.compare(op.base, pin.head);
        } catch (e) {
          if (e instanceof GitHubError && e.kind === "not_found") {
            await this.apply({ kind: "buildAborted", reason: `comparing #${pin.pr}: ${e.message}` });
            return;
          }
          throw e;
        }
        const tooMany = carried.commitsTruncated || (landing !== undefined && carried.commits.length > OWN_MAX);
        // A head that already contains the base merges to its own tree: nothing can vanish.
        const hit = carried.status === "ahead" ? undefined : [...carried.commits].reverse().find((x) => squashed.has(commitPrefix(x.sha)));
        if (tooMany || hit) {
          dropped.push({ pr: pin.pr, pin: pin.head, outcome: "squashed", ...(hit ? { commit: hit.sha } : {}) });
          continue;
        }
        own.set(pin.pr, carried.commits.map((x) => commitPrefix(x.sha)));
      }
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
    // Linear (DESIGN.md §7.4): the merge chain stays on the build ref; the stack, one commit per PR on its tree, is what is pushed.
    const stack: StackCommit[] = [];
    /** Stack commits with the PR's author as author: GitHub does not sign those (queue.landing.author: author). */
    const authored = new Set<string>();
    if (landing) {
      let parent = op.base;
      const recorded = new Set<string>();
      for (const [i, m] of merges.entries()) {
        const pin = survivors[i]!;
        const tree = (await c.getCommit(m)).tree;
        if (!tree) {
          await this.apply({ kind: "buildFailed", reason: `merge commit ${m} for #${pin.pr} came back without a tree` });
          return;
        }
        const live = snap.prs[String(pin.pr)];
        const who = prAuthor(live);
        const byAuthor = landing.author === "author" && who !== null;
        // author mode credits through authorship, so a trailer naming the same person again would add nothing.
        const message = linearMessage(pin.pr, pin.head, op.n, live?.title, landing.body, !byAuthor && who ? who : undefined);
        const commit = await c.createCommit(tree, parent, message, byAuthor ? { name: who.login, email: who.email } : undefined);
        if (byAuthor) authored.add(commit);
        const mine = (own.get(pin.pr) ?? []).filter((p) => !recorded.has(p));
        for (const p of mine) recorded.add(p);
        stack.push({ pr: pin.pr, commit, parent, tree, own: mine });
        parent = commit;
      }
      this.crash("after-stack");
    }
    // What reaches main must be signed: the merge commits in merge mode, the stack commits in linear mode.
    for (const m of landing ? stack.map((x) => x.commit).filter((x) => !authored.has(x)) : merges) {
      const commit = await c.getCommit(m);
      if (!commit.verified || commit.reason !== "valid") {
        await this.apply({ kind: "buildFailed", reason: `${landing ? "stack" : "merge"} commit ${m} is not signed and verified (${commit.reason})` });
        return;
      }
    }
    const chainHead = landing ? (stack.at(-1)?.commit ?? null) : (merges.at(-1) ?? null);
    await this.apply({ kind: "checkpoint", record: { survivors, dropped, chainHead, ...(landing ? { stack } : {}) } });
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
      if (outstanding.kind === "settleLand" && paused && outstanding.stranded) this.log.push(`paused with PR branches at their stack commits, moved back once the pause closes: ${outstanding.stranded}`);
      if (paused) return "paused";
      if (outstanding.kind === "rerunReconcile" && (this.state.journal.op.kind !== "rerun" || (this.state.journal.op.requested ?? []).length > 0)) return "waiting";
      // A linear landing that did not land and cannot simply be resent (DESIGN.md §7.4): settled first, needing no snapshot.
      if (outstanding.kind === "settleLand" && this.state.journal.op.kind === "land") {
        const j = this.state.journal;
        this.acted = true;
        const r = await this.settle(this.state.journal.op, j.at);
        await this.apply(r ?? { kind: "landRestored" });
        await this.drainOutbox();
        return r?.kind === "landUnsettled" ? "waiting" : "acted";
      }
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
