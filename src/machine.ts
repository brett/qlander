// The pure decision logic (DESIGN.md §5). decide() turns (state, snapshot) into
// the next state: bookkeeping is applied directly, durable notices go to the
// outbox, and at most one external effect is journalled per tick. The runner
// performs that op and feeds the outcome to applyOpResult() (ops.ts).

import { admit, FORCE_DENIED, type LivePr, NEEDS_APPROVAL, revalidate, waiverFor } from "./admission";

/** A short stable key for a comment marker. */
const stableKey = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);
import { describeWaiver } from "./automation";
import { baselineResult, mainFailures, NOT_RED, ownFailures } from "./baseline";
import { flakyItems, GIVE_UP_HOURS, jobId } from "./flaky";
import type { Config } from "./config";
import {
  because,
  actives,
  ciOf,
  speculationRefused,
  comment,
  type Ctx,
  type Decision,
  emit,
  emitDequeued,
  hookBatch,
  focus,
  hookPr,
  jobsList,
  adaptiveLimit,
  makeCtx,
  maxActive,
  parkedBatch,
  notify,
  pause,
  record,
  reserve,
  retire,
  setActives,
  type Snapshot,
  unready,
  type Verdict,
  withEvents,
} from "./ctx";
import { jobsOf } from "./hooks";
import { type Active, ALONE_RED_MAX, type Baseline, type BaselineResult, type BuildSource, FLAKE_DAYS, type Op, type Pending, type Pin, type SeenRed, type Solo, type State } from "./state";
import type { FailedJob, RunRef } from "./types";
import { type Command, queueRef } from "./validate";

export type { Decision, Snapshot } from "./ctx";

function inFlight(s: State): Set<number> {
  const out = new Set<number>();
  actives(s).forEach((a) => a.prs.forEach((p) => out.add(p)));
  s.pending.forEach((p) => p.prs.forEach((x) => out.add(x)));
  s.solo.forEach((p) => out.add(p.pr));
  return out;
}

/**
 * Which PRs a PR may share a batch with (DESIGN.md §4.3, §5.4 step 2):
 * `alone` runs by itself (a trusted automation's waived PR, an operator-solo
 * PR, and every CI-policy PR unless queue.policy.shareBatch is set);
 * `policy` shares only with other approved CI-policy PRs; `ordinary` only
 * with ordinary PRs.
 */
type BatchClass = "alone" | "policy" | "ordinary";

function batchClass(c: Ctx, pr: number): BatchClass {
  const auth = c.s.auth[String(pr)];
  if (auth?.waiver || c.s.operatorSolo.includes(pr)) return "alone";
  if (auth?.policyPr) return c.cfg.policyShareBatch ? "policy" : "alone";
  return "ordinary";
}

/**
 * How long an admitted PR may be held on unknown mergeability before it is
 * dropped as before. A timing constant, not policy: it is not in Config, so
 * the policy hash is unchanged.
 */
export const HOLD_MINUTES = 10;

/**
 * How long a ready PR may wait, unqueued, for something only a person can
 * give (a CI-policy approval, a fix for a red fast lane) or for GitHub's mergeability, before
 * qlander says so on the PR. A timing constant, not policy: it is not in
 * Config, so the policy hash is unchanged.
 */
export const WAIT_NOTICE_MINUTES = 30;

/** A drop (`hold: false`), or a hold: keep the admission, but build and land nothing with this PR this tick. */
type Check = { ok: true } | { ok: false; hold: boolean; headMoved: boolean; reason: string };

function stillOk(c: Ctx, pr: number): Check {
  const auth = c.s.auth[String(pr)];
  if (!auth) return { ok: false, hold: false, headMoved: false, reason: "no authorisation record" };
  const r = revalidate(auth, c.snap.prs[String(pr)], c.cfg, c.snap.policyHash);
  if (r.ok || !r.hold) return r;
  const since = hold(c, pr, auth.head);
  if (c.snap.now.getTime() - since >= HOLD_MINUTES * 60_000) {
    return { ok: false, hold: false, headMoved: false, reason: `${r.reason} after ${HOLD_MINUTES} minutes` };
  }
  return r;
}

/** Record a mergeability hold for this tick, keeping its start while the head is unchanged. Returns the start (ms). */
function hold(c: Ctx, pr: number, head: string): number {
  const key = String(pr);
  const prev = c.held.get(key) ?? c.s.held?.[key];
  const since = prev && prev.head === head ? prev.since : c.now;
  c.held.set(key, { head, since });
  return Date.parse(since);
}

/** After an evaluating tick, state.held becomes exactly this tick's holds (a paused tick keeps the recorded ones). */
function settleHolds(c: Ctx): void {
  if (c.held.size > 0) c.s.held = Object.fromEntries(c.held);
  else delete c.s.held;
}

/** The newest hold's start (ms), for the re-tick wake; undefined when nothing is held. */
function holdSince(c: Ctx): number | undefined {
  return c.held.size > 0 ? Math.max(...[...c.held.values()].map((h) => Date.parse(h.since))) : undefined;
}

const heldList = (prs: number[]) => prs.map((p) => `#${p}`).join(" ");

/** Why a PR left the queue, for the `dequeued` hook event. */
function dequeueKind(reason: string): string {
  if (reason.startsWith("head moved") || reason.startsWith("head branch changed")) return "head_moved";
  if (reason === "qlander policy changed" || reason === "policy classification changed") return "policy_changed";
  if (reason === "not labelled ready") return "label_removed";
  if (reason === "not open") return "closed";
  if (reason === "bounced by an operator") return "operator";
  return "revalidation_failed";
}

/** Take a PR out of the queue. A moved head or changed policy also loses `ready`. */
function dropPr(c: Ctx, pr: number, why: { headMoved: boolean; reason: string }): void {
  const auth = c.s.auth[String(pr)];
  emitDequeued(c, pr, dequeueKind(why.reason), why.reason);
  because(c, pr, `removed from the queue this tick: ${why.reason}`);
  c.excluded.add(pr);
  delete c.s.auth[String(pr)];
  c.s.pending = c.s.pending
    .map((p) => ({ ...p, prs: p.prs.filter((x) => x !== pr) }))
    .filter((p) => p.prs.length > 0);
  c.s.solo = c.s.solo.filter((x) => x.pr !== pr);
  c.log.push(`drop #${pr}: ${why.reason}`);
  if (why.headMoved) {
    const tag = `moved:${auth?.head ?? "none"}`;
    unready(c, pr, tag);
    comment(
      c,
      pr,
      tag,
      `Removed from the landing queue: ${why.reason}. It must qualify again (fast lane and review on the new head, then \`ready\`).`,
    );
  }
}

/** A lineage with no counter is treated as exhausted, never as unused. */
/** Cancellation keeps looking for late-published runs until then (review #9). */
export const cancelUntil = (c: Ctx) => new Date(c.snap.now.getTime() + c.cfg.cancelWindowMinutes * 60_000).toISOString();

const lineageRuns = (c: Ctx, l: number) => c.s.lineages[String(l)]?.runs ?? Number.POSITIVE_INFINITY;
const windowUsed = (c: Ctx) => c.s.window.reduce((n, w) => n + w.cost, 0);

function exhaustLineage(c: Ctx, lineage: number, prs: number[]): void {
  const all = new Set(prs);
  c.s.pending.filter((p) => p.lineage === lineage).forEach((p) => p.prs.forEach((x) => all.add(x)));
  c.s.solo.filter((p) => p.lineage === lineage).forEach((p) => all.add(p.pr));
  c.s.pending = c.s.pending.filter((p) => p.lineage !== lineage);
  c.s.solo = c.s.solo.filter((p) => p.lineage !== lineage);
  for (const pr of all) {
    emitDequeued(c, pr, "budget_exhausted", `the batch used the retry budget of ${c.cfg.lineageBudget} full-suite runs`);
    delete c.s.auth[String(pr)];
    unready(c, pr, `budget:${lineage}`);
    comment(
      c,
      pr,
      `budget:${lineage}`,
      `Removed from the landing queue: its batch used the retry budget of ${c.cfg.lineageBudget} full-suite runs. Re-add \`ready\` to try again.`,
    );
  }
  c.log.push(`lineage ${lineage} exhausted`);
}

/**
 * Budget gate before every build, rebuild and rerun (DESIGN.md §5.4). On
 * refusal it pauses (window) or exhausts the lineage, and returns false.
 */
function budgetAllows(c: Ctx, lineage: number, prs: number[]): boolean {
  if (windowUsed(c) >= c.cfg.windowBudget) {
    pause(c, `window budget of ${c.cfg.windowBudget} runs per ${c.cfg.windowHours}h used`);
    return false;
  }
  if (lineageRuns(c, lineage) >= c.cfg.lineageBudget) {
    exhaustLineage(c, lineage, prs);
    return false;
  }
  return true;
}

function journal(c: Ctx, op: Op, reserved: boolean): void {
  c.s.journal = { seq: c.s.seq, op, reserved, at: c.now, checkpoint: null, tries: 0 };
  c.log.push(`journal ${op.kind}`);
}

/** Cancel batch n's runs (and any published late) from the outbox. */
function cancelRuns(c: Ctx, n: number, head: string): void {
  notify(c, { id: `x:${n}`, kind: "cancelRuns", ref: queueRef(c.cfg.names, n), head, until: cancelUntil(c), giveUpAt: new Date(c.snap.now.getTime() + c.cfg.cancelGiveUpHours * 3_600_000).toISOString() });
}

/** Give up a parked batch (queue.strategy.reuseGreen): its runs can no longer land it, so they are cancelled now. */
function unpark(c: Ctx, why: string): void {
  const p = c.s.parked;
  if (!p) return;
  cancelRuns(c, p.n, p.head);
  delete c.s.parked;
  c.log.push(`batch ${p.n} unparked: ${why}`);
}

/** Build on `base`: main, or (pipelining, DESIGN.md §5.6) the head of the running batch it is stacked on. */
function startBuild(c: Ctx, prs: number[], depth: number, lineage: number, source: BuildSource, rebuild: boolean, base = c.snap.main): void {
  unpark(c, "a new build goes first");
  reserve(c, lineage);
  const pins = prs.map((pr) => ({ pr, head: c.s.auth[String(pr)]!.head }));
  journal(c, { kind: "build", n: c.s.seq, base, pins, depth, lineage, source, rebuild }, true);
}

/**
 * Journal the landing of a green batch (DESIGN.md §7.2). In linear mode
 * (§7.4) the landing also moves each PR's head branch, the one recorded at
 * admission, from its admitted head to its own stack commit, just before main.
 */
function land(c: Ctx, a: Active): void {
  focus(c.s, a);
  const heads = a.stack?.map((x) => {
    const auth = c.s.auth[String(x.pr)]!;
    return { pr: x.pr, ref: auth.headRef ?? "", before: auth.head, after: x.commit };
  });
  if (heads?.some((h) => h.ref === "")) {
    pause(c, `batch ${a.n}: a PR in its linear stack has no recorded head branch`);
    return;
  }
  journal(c, { kind: "land", before: a.base, after: a.head, ...(heads ? { heads } : {}) }, false);
}

/** A rerun, cancel or landing concerns `state.active`: the batch moves there before the op is journalled. */
function rerun(c: Ctx, a: Active, runs: RunRef[]): void {
  focus(c.s, a);
  reserve(c, a.lineage);
  journal(c, { kind: "rerun", runs }, true);
}

/**
 * The FIFO key of a group of PRs (DESIGN.md §4.4): prioritised first, then
 * the oldest PR's admission order.
 */
function fifoKey(c: Ctx, prs: number[]): string {
  const keys = prs.map((pr) => {
    const au = c.s.auth[String(pr)];
    return `${au?.priority ? 0 : 1}|${au?.admittedAt ?? ""}|${au?.labelledAt ?? ""}|${String(pr).padStart(9, "0")}`;
  });
  return keys.sort()[0] ?? "";
}

/**
 * Put recovery work back at the front of pending or solo. With one batch at
 * a time it goes first (DESIGN.md §5.3). With several, ahead of the first
 * item whose PRs are younger, so the halves of two batches that failed side
 * by side keep the FIFO order between them (§5.6).
 */
function requeue<T>(c: Ctx, list: T[], items: T[], prsOf: (x: T) => number[]): void {
  if (items.length === 0) return;
  if (!c.cfg.concurrency) {
    list.unshift(...items);
    return;
  }
  const key = fifoKey(c, items.flatMap(prsOf));
  const at = list.findIndex((x) => fifoKey(c, prsOf(x)) > key);
  list.splice(at < 0 ? list.length : at, 0, ...items);
}

const requeuePending = (c: Ctx, items: Pending[]) => requeue(c, c.s.pending, items, (p) => p.prs);
const requeueSolo = (c: Ctx, items: Solo[]) => requeue(c, c.s.solo, items, (p) => [p.pr]);

/**
 * Stop a batch: cancel its runs, record it, and put its surviving PRs back as
 * recovery work in their order, with the same lineage. A speculative batch's
 * PRs are not recovery work: they go back among the fresh candidates, in
 * their FIFO place (DESIGN.md §5.6).
 */
function abandon(c: Ctx, a: Active, survivors: number[], note: string): void {
  // queue.strategy.reuseGreen (DESIGN.md §5.7): a whole batch put back as the queue pauses is parked, and its runs are
  // left to finish, since they may still land it; they are cancelled when it is unparked without landing.
  const park = c.cfg.strategy?.reuseGreen && c.pausing && a.on === undefined && survivors.length === a.prs.length;
  if (park) {
    if (c.s.parked) unpark(c, `batch ${a.n} is parked instead`);
    c.s.parked = { n: a.n, base: a.base, head: a.head, pins: pinsOf(c, a.prs), depth: a.depth, lineage: a.lineage, builtAt: a.builtAt, ...(a.stack ? { stack: a.stack } : {}) };
    c.log.push(`batch ${a.n} parked: it lands without a rebuild if its run on ${a.base} is green when the queue resumes`);
  } else cancelRuns(c, a.n, a.head);
  if (survivors.length > 0 && a.on === undefined) requeuePending(c, [{ prs: survivors, depth: a.depth, lineage: a.lineage }]);
  record(c, { n: a.n, outcome: "abandoned", prs: a.prs, head: a.head, note });
  retire(c, a);
}

const running = (c: Ctx, n: number) => actives(c.s).some((a) => a.n === n);

// ---------------------------------------------------------------- phases

function pruneWindow(c: Ctx): void {
  const cutoff = c.snap.now.getTime() - c.cfg.windowHours * 3_600_000;
  c.s.window = c.s.window.filter((w) => Date.parse(w.at) > cutoff);
  if (c.s.flakes) {
    const since = c.snap.now.getTime() - FLAKE_DAYS * 86_400_000;
    c.s.flakes = c.s.flakes.filter((f) => Date.parse(f.at) > since);
  }
}

/**
 * The batch's rerun passed where its first attempt failed: those failures
 * were flaky. Recorded once (redJobs is cleared in the same state write): a
 * history entry, a weekly mark, and one notice for the flaky issues. `runs`
 * are the first attempt's runs that were rerun.
 */
function recordFlaky(c: Ctx, a: Active, redJobs: FailedJob[], runs: RunRef[]): void {
  delete a.redJobs;
  const tests = c.snap.flakyTests ?? {};
  const jobs = redJobs.map((j) => {
    const id = jobId(j);
    const t = id !== null ? tests[String(id)] : undefined;
    return t && t.length > 0 ? { ...j, tests: t } : j;
  });
  const items = flakyItems(jobs);
  record(c, { n: a.n, outcome: "flaky", prs: a.prs, head: a.head, note: `the rerun passed; the first attempt failed ${jobs.map((j) => j.name).join(", ")}`, failedJobs: jobs, runs });
  // Compact, so a busy week cannot push the mirror issue past its size limit.
  c.s.flakes = [...(c.s.flakes ?? []), { at: c.now, n: a.n, count: items.length, keys: items.slice(0, 3).map((i) => i.key.slice(0, 80)) }];
  if (items.length > 0) {
    const giveUpAt = new Date(c.snap.now.getTime() + GIVE_UP_HOURS * 3_600_000).toISOString();
    notify(c, { id: `f:${a.n}`, kind: "flaky", n: a.n, at: c.now, giveUpAt, runs, items });
  }
  c.log.push(`batch ${a.n}: flaky: ${items.map((i) => i.key).join(", ") || "no failed job recorded"}`);
}

/**
 * Operator commands, in label order (DESIGN.md §10). Each one's effect and the
 * removal of its label are one state write: the removal is an outbox notice
 * keyed by the label event, so a command whose label is still visible (the
 * notice not yet drained) is never applied twice. A label applied by anyone
 * without write access is removed and ignored.
 */
function applyCommands(c: Ctx): void {
  for (const cmd of c.snap.commands ?? []) {
    const id = `cmd:${cmd.id}`;
    if (c.s.outbox.some((n) => n.id === id)) continue; // applied already; its label removal is pending
    if (cmd.authorized) applyCommand(c, cmd);
    else if (cmd.actor === null) c.log.push(`ignored ${cmd.label} on #${cmd.pr}: who applied it is not readable`);
    else c.log.push(`ignored ${cmd.label} on #${cmd.pr}: applied by ${cmd.actor}, who has no write access`);
    notify(c, { id, kind: "unlabel", pr: cmd.pr, label: cmd.label });
  }
}

/**
 * operatorSolo holds the PRs an operator marked `solo` while they are in the
 * queue (DESIGN.md §10). A PR that merged (by any route), closed, or lost
 * `ready` has left the queue, so its mark goes (snap.soloLeft, read twice).
 * A moved head on an admitted PR loses `ready` too (dropPr), so the mark goes
 * a tick or two later.
 */
function pruneOperatorSolo(c: Ctx): void {
  const left = c.snap.soloLeft ?? {};
  c.s.operatorSolo = c.s.operatorSolo.filter((pr) => {
    const why = left[String(pr)];
    if (why) c.log.push(`operator solo on #${pr} cleared: ${why}`);
    return !why;
  });
}

function applyCommand(c: Ctx, cmd: Command): void {
  const pr = cmd.pr;
  c.log.push(`operator ${cmd.kind} #${pr} (${cmd.actor}, ${cmd.at})`);
  if (cmd.kind === "solo") {
    if (!c.s.operatorSolo.includes(pr)) c.s.operatorSolo.push(pr);
    // Isolate it now if it is in a running batch with others: abandon the batch
    // (same order and lineage) so selection rebuilds it through the solo filter.
    const a = actives(c.s).find((x) => x.prs.includes(pr));
    if (a && a.prs.length > 1 && a.prs.includes(pr)) abandon(c, a, a.prs, `operator asked for #${pr} alone`);
    return;
  }
  if (cmd.kind === "unsolo") {
    c.s.operatorSolo = c.s.operatorSolo.filter((x) => x !== pr);
    return;
  }
  if (cmd.kind === "go") {
    // Queue-wide and durable in state, so it survives its carrier PR landing or closing.
    c.s.go = true;
    return;
  }
  const a = actives(c.s).find((x) => x.prs.includes(pr));
  dropPr(c, pr, { headMoved: false, reason: "bounced by an operator" });
  unready(c, pr, `op:${cmd.id}`);
  comment(c, pr, `op:${cmd.id}`, "Removed from the landing queue by an operator.");
  if (a?.prs.includes(pr)) abandon(c, a, a.prs.filter((x) => x !== pr), `operator bounced #${pr}`);
}

/**
 * The "not marked merged" notice also waits this long after landing. A timing
 * constant, not policy: it is not in Config, so the policy hash is unchanged.
 */
export const VERIFY_MIN_MINUTES = 15;

/** DESIGN.md §7.3: never closes a PR; reports exactly what landed. */
function processVerify(c: Ctx): void {
  const keep = [];
  for (const v of c.s.verify) {
    const pr = c.snap.prs[String(v.pr)];
    const tag = `v:${v.pin}`;
    const expired = c.snap.now.getTime() - Date.parse(v.since) > c.cfg.verifyDays * 86_400_000;
    if (!pr) {
      if (!expired) keep.push(v);
      continue;
    }
    if (pr.merged) {
      unready(c, v.pr, tag);
      continue;
    }
    if (c.snap.pinReachable[v.pin] === false) {
      pause(c, `#${v.pr}: landed pin ${v.pin} is not reachable from main`);
      continue;
    }
    if (!pr.open) {
      if (!v.admitted) continue;
      // Linear landing (DESIGN.md §7.4): the change is on main, so say so; the wait is for a mark that may still arrive.
      if (c.snap.now.getTime() - Date.parse(v.since) < VERIFY_MIN_MINUTES * 60_000) {
        keep.push(v);
        continue;
      }
      unready(c, v.pr, tag);
      comment(c, v.pr, `${tag}:closed`, `Landed revision \`${v.admitted}\` in main as \`${v.pin}\` (\`${v.landedIn}\`), but GitHub closed this PR without marking it merged. Its change is on main; nothing is lost and nothing needs doing.`);
      continue;
    }
    // Linear landing (DESIGN.md §7.4): the branch still reading at its admitted head is not a push; it waits like an unmarked PR.
    if (pr.head !== v.pin && pr.head !== v.admitted) {
      unready(c, v.pr, tag);
      comment(
        c,
        v.pr,
        tag,
        v.admitted
          ? `Landed revision \`${v.admitted}\` in main as \`${v.pin}\` (\`${v.landedIn}\`). Commits pushed after it are **not** in main; this PR stays open for them.`
          : `Landed revision \`${v.pin}\` in main (\`${v.landedIn}\`). Commits pushed after it are **not** in main; this PR stays open for them.`,
      );
      continue;
    }
    const next = { ...v, ticks: v.ticks + 1 };
    // Chained ticks can be a minute apart (DESIGN.md §11.1), so a tick count alone no longer outlasts GitHub's merge detection.
    const waited = c.snap.now.getTime() - Date.parse(v.since) >= VERIFY_MIN_MINUTES * 60_000;
    if (next.ticks >= c.cfg.verifyTicks && waited && !next.notified) {
      comment(
        c,
        v.pr,
        `${tag}:unmarked`,
        v.admitted
          ? `This PR landed as \`${v.pin}\` (squashed from \`${v.admitted}\`), which is in main at \`${v.landedIn}\`, but GitHub has not marked this PR merged${pr.head === v.admitted ? `, and its branch still reads at \`${v.admitted}\`` : ""}. A maintainer may close it.`
          : `\`${v.pin}\` is in main at \`${v.landedIn}\`, but GitHub has not marked this PR merged. A maintainer may close it.`,
      );
      next.notified = true;
    }
    if (!expired) keep.push(next);
  }
  c.s.verify = keep;
}

/**
 * The priority lane (DESIGN.md §4.4): each admitted PR's priority follows
 * the live label at its authorised head, so adding the label reorders the
 * queue and removing it returns the PR to its FIFO place. Ordering only:
 * nothing here admits, drops or revalidates.
 */
function syncPriority(c: Ctx): void {
  for (const live of Object.values(c.snap.prs)) if (live.priorityIgnored) c.log.push(`#${live.number}: priority label ignored: ${live.priorityIgnored}`);
  for (const [key, auth] of Object.entries(c.s.auth)) {
    const live = c.snap.prs[key];
    const p = c.cfg.names.labels.priority && live && live.head === auth.head ? live.priority : undefined;
    if (p) {
      if (auth.priority?.by === p.actorLogin && auth.priority.at === p.at) continue;
      c.s.auth[key] = { ...auth, priority: { by: p.actorLogin, at: p.at } };
      c.log.push(`#${key} prioritised by ${p.actorLogin}`);
    } else if (auth.priority) {
      const { priority: _, ...rest } = auth;
      c.s.auth[key] = rest;
      c.log.push(`#${key} no longer prioritised`);
    }
  }
}

/** Record new admissions; revalidate admitted PRs that are not yet in a batch. */
function admitAndRevalidate(c: Ctx): void {
  // Keep the recorded review run current: if the same head is now proved by a
  // different run (say the old one was rerun and failed), record that one, so
  // later revalidation re-checks the run that actually proves it.
  for (const [key, auth] of Object.entries(c.s.auth)) {
    const live = c.snap.prs[key];
    const run = live?.review.run;
    if (live && live.head === auth.head && live.review.ok && run && run.runId !== auth.reviewRun) {
      c.s.auth[key] = { ...auth, reviewRun: run.runId };
      c.log.push(`#${key}: review now proved by run ${run.runId}`);
    }
  }
  syncPriority(c);
  const busy = inFlight(c.s);
  for (const key of Object.keys(c.s.auth)) {
    const pr = Number(key);
    if (busy.has(pr)) continue;
    const r = stillOk(c, pr);
    if (r.ok) continue;
    if (r.hold) c.log.push(`#${pr} held: ${r.reason}`);
    else dropPr(c, pr, r);
  }
  for (const live of Object.values(c.snap.prs)) {
    const key = String(live.number);
    if (c.s.auth[key] || busy.has(live.number)) continue;
    if (c.excluded.has(live.number)) {
      because(c, live.number, "removed from the queue this tick");
      continue;
    }
    // Linear landing (DESIGN.md §7.4): the pin is qlander's stack commit; a read showing the admitted head may lag behind the landing.
    if (c.s.verify.some((v) => v.pr === live.number && (v.pin === live.head || v.admitted === live.head))) {
      because(c, live.number, "landed at this head; waiting for GitHub to mark it merged");
      continue;
    }
    const a = admit(live, c.cfg);
    if (!a.ok) because(c, live.number, refusal(c, live, a));
    if (a.ok) {
      c.s.auth[key] = {
        head: live.head,
        baseRepoId: live.baseRepoId,
        policy: c.snap.policyHash,
        policyPr: live.policyPr,
        admittedAt: c.now,
        labelledAt: live.ready!.at,
        evidence: [live.fastLane.why, live.review.why],
        reviewRun: live.review.run?.runId ?? null,
        ...(live.author ? { author: live.author } : {}),
        ...(c.cfg.names.labels.priority && live.priority ? { priority: { by: live.priority.actorLogin, at: live.priority.at } } : {}),
        // Linear landing (DESIGN.md §7.4): the only branch the landing may move for this PR.
        ...(c.cfg.landing ? { headRef: live.headRef } : {}),
      };
      const waiver = waiverFor(live, c.cfg);
      if (waiver) c.s.auth[key] = { ...c.s.auth[key]!, waiver };
      c.log.push(`admit #${live.number} at ${live.head}${waiver ? ` (${describeWaiver(waiver)})` : ""}`);
      // Advisory only: a landing GitHub refuses is classified and retried (DESIGN.md §7.4).
      if (live.forceUpdate?.kind === "unknown") c.log.push(`#${live.number}: whether the queue App may force-update ${live.headRef} is unknown: ${live.forceUpdate.why}`);
      const au = c.s.auth[key]!;
      emit(c, { event: "admitted", key: `admitted:${key}:${au.head}:${au.admittedAt}`, batch: null, prs: [hookPr(c, live.number)], details: { policyPr: au.policyPr, ...(au.priority ? { priority: { by: au.priority.by } } : {}), ...(au.waiver ? { waiver: { rule: au.waiver.rule, login: au.waiver.login, readyByBot: au.waiver.readyByBot, policyWaived: au.waiver.policyWaived } } : {}) } });
      const e = c.s.eligibleSince?.[key];
      if (!e || e.head !== live.head || e.labelledAt !== live.ready!.at) {
        c.s.eligibleSince = { ...c.s.eligibleSince, [key]: { head: live.head, labelledAt: live.ready!.at, since: c.now } };
      }
    } else if (a.kind === "unready") {
      unready(c, live.number, `adm:${live.head}`);
      comment(c, live.number, `adm:${live.head}`, `Not queued: ${a.reason}. Fix it and re-add \`ready\`.`);
    } else if (a.kind === "wait") {
      c.log.push(`#${live.number} waits: ${a.reason}`);
      // Linear landing (DESIGN.md §7.4): said at once, once per head and rule; `ready` stays, so it is evaluated again every tick.
      if (live.forceUpdate?.kind === "denied" && a.reason.startsWith(FORCE_DENIED)) {
        comment(c, live.number, `force:${live.head}:${stableKey(live.forceUpdate.rule)}`, `Labelled \`ready\` but not queued: this queue lands linear, which moves the PR's head branch \`${live.headRef}\` to its squashed commit, and that branch has ${live.forceUpdate.rule}. Let the queue App bypass that rule for this branch (bypass mode "always"), or push the change from a branch it does not cover. \`ready\` stays on: the PR is queued once the rule allows it.`);
      }
      if (live.mergeable === null) waitNotice(c, live, "merge", hold(c, live.number, live.head));
      else if (live.fastLane.red) waitNotice(c, live, "fast", Date.parse(live.ready!.at), live.fastLane.why);
      if (a.reason.startsWith(NEEDS_APPROVAL)) {
        waitNotice(c, live, "approval", Date.parse(live.ready!.at), a.reason);
        const command = `/qlander approve-policy ${live.head}`;
        emit(c, {
          event: "approval_needed",
          key: `approval_needed:${key}:${live.head}`,
          batch: null,
          prs: [{ number: live.number, head: live.head, ...(live.author ? { author: live.author } : {}) }],
          details: { command, approvers: c.cfg.humans.map((h) => h.login) },
        });
      }
    }
  }
  // The fill clock is kept only while the PR stays ready at the same head.
  for (const [key, e] of Object.entries(c.s.eligibleSince ?? {})) {
    const live = c.snap.prs[key];
    if (!live || !live.open || live.head !== e.head || live.ready?.at !== e.labelledAt) delete c.s.eligibleSince![key];
  }
  if (c.s.eligibleSince && Object.keys(c.s.eligibleSince).length === 0) delete c.s.eligibleSince;
}

/**
 * One comment per head and kind once a ready PR has waited WAIT_NOTICE_MINUTES
 * (DESIGN.md §4.2), so a held PR is never silent. Re-raised every tick while
 * it waits; the outbox finds its marker and never posts it twice. Never
 * omittable: it asks someone to act.
 */
function waitNotice(c: Ctx, live: LivePr, kind: "merge" | "approval" | "fast", since: number, reason = ""): void {
  const waited = Math.floor((c.snap.now.getTime() - since) / 60_000);
  if (!(waited >= WAIT_NOTICE_MINUTES)) return;
  const head = live.head;
  const main = c.cfg.names.main;
  const body =
    kind === "merge"
      ? `Labelled \`ready\` but not queued: GitHub has not reported whether this PR merges cleanly into \`${main}\` for ${waited} minutes (head \`${head}\`). It is queued as soon as GitHub does. If this persists, push a new commit so GitHub computes it again.`
      : kind === "fast"
        ? `Labelled \`ready\` but not queued: the fast lane is red at head \`${head}\` (${reason}). \`ready\` stays on, so this PR is queued as soon as \`${c.cfg.fastLane.job}\` passes: rerun it if the failure is a flake, or push a fix. If this PR shouldn't land yet, remove \`ready\`.`
      : `Labelled \`ready\` but not queued: ${reason}. This PR changes CI policy, so it lands only once one of ${c.cfg.humans.map((h) => `\`${h.login}\``).join(", ") || "the configured approvers (none are configured)"} posts a comment whose whole body is:\n\n\`\`\`\n/qlander approve-policy ${head}\n\`\`\`\n\nA push moves the head and needs a new approval.`;
  c.log.push(`#${live.number}: told it waits (${kind}, ${waited}m)`);
  comment(c, live.number, `wait:${kind}:${head}`, body);
}

/**
 * A speculative batch whose base batch is gone (DESIGN.md §5.6): kept, as an
 * ordinary batch, when that batch landed (main is now its base); discarded
 * otherwise. Its run stays charged to the window and to its own lineage,
 * never to its PRs, which go back among the fresh candidates in their place.
 */
function orphaned(c: Ctx, a: Active): boolean {
  if (a.on === undefined || running(c, a.on)) return false;
  if (c.snap.main === a.base) {
    c.log.push(`batch ${a.n}: batch ${a.on} landed; it is now on ${c.cfg.names.main}`);
    delete a.on;
    return false;
  }
  abandon(c, a, a.prs, `discarded: built on batch ${a.on}, which did not land`);
  return true;
}

/** Has this batch failed: red now, or being rerun after a red (not yet green)? A younger batch may then land first (DESIGN.md §5.6). */
function failing(c: Ctx, a: Active): boolean {
  const kind = ciOf(c, a)?.kind;
  return kind === "red" || (a.redJobs !== undefined && kind !== "green");
}

/**
 * The running batch a green batch must let land first (DESIGN.md §5.6), if
 * any: one ahead of it in FIFO order (by its oldest PR, prioritised first,
 * §4.4), on any base, that has not failed. So FIFO gives way only to PRs
 * whose batch has failed; an older batch on a stale base is rebuilt and
 * still goes first.
 */
function landsAfter(c: Ctx, a: Active): Active | undefined {
  const key = fifoKey(c, a.prs);
  return actives(c.s).find((x) => x !== a && !failing(c, x) && fifoKey(c, x.prs) < key);
}

function handleActive(c: Ctx, a: Active): void {
  if (orphaned(c, a)) return;
  // The rerun of a red attempt passed: flaky, recorded once, before anything
  // can retire the batch, and whether it then lands, waits (DESIGN.md §5.6),
  // or is dropped by revalidation.
  if (ciOf(c, a)?.kind === "green" && a.rerun !== null && a.redJobs !== undefined) {
    emit(c, { event: "flaky", key: `flaky:${a.n}`, batch: hookBatch(a), prs: a.prs.map((pr) => hookPr(c, pr)), details: { failedJobs: jobsOf(a.redJobs) } });
    recordFlaky(c, a, a.redJobs, a.rerun);
  }
  const checks = a.prs.map((pr) => ({ pr, r: stillOk(c, pr) }));
  const bad = checks.flatMap(({ pr, r }) => (!r.ok && !r.hold ? [{ pr, r }] : []));
  if (bad.length > 0) {
    for (const { pr, r } of bad) dropPr(c, pr, r);
    const out = new Set(bad.map((b) => b.pr));
    abandon(c, a, a.prs.filter((p) => !out.has(p)), `revalidation dropped ${[...out].map((p) => `#${p}`).join(" ")}`);
    return;
  }
  // Revalidation before landing could not finish: act on this batch (land, rerun, cancel) only once it can.
  const held = checks.filter((x) => !x.r.ok).map((x) => x.pr);
  if (held.length > 0) {
    c.log.push(`batch ${a.n} held: ${heldList(held)} mergeability not computed yet`);
    return;
  }
  const ci = ciOf(c, a);
  if (!ci) return;
  // Speculative (DESIGN.md §5.6): its result is acted on only once the batch under it has landed; a hung run is still cancelled.
  if (a.on !== undefined && ci.kind !== "pending" && ci.kind !== "timeout") {
    c.log.push(`batch ${a.n} ${ci.kind}: waits for batch ${a.on}, which it is built on`);
    return;
  }
  switch (ci.kind) {
    case "pending":
      if (preempt(c, a)) return;
      c.log.push(`batch ${a.n} pending: ${ci.reason}`);
      return;
    case "timeout":
      focus(c.s, a);
      journal(c, { kind: "cancel", runs: ci.runs, cause: ci.cause }, false);
      return;
    case "config":
      pause(c, `batch ${a.n}: configuration problem: ${ci.reason}`);
      abandon(c, a, a.prs, `config: ${ci.reason}`);
      return;
    case "infra":
      if (a.rerun !== null) {
        pause(c, `batch ${a.n}: still inconclusive after a rerun: ${ci.reason}`);
        abandon(c, a, a.prs, `infra: ${ci.reason}`);
      } else if (budgetAllows(c, a.lineage, a.prs)) {
        rerun(c, a, ci.runs);
      } else if (!c.pausing) {
        retire(c, a); // lineage exhausted; its PRs were unreadied
      }
      return;
    case "green": {
      // FIFO among batches on the same base (DESIGN.md §5.6): an earlier one that has not failed lands first.
      const first = c.snap.main === a.base ? landsAfter(c, a) : undefined;
      if (first) {
        c.log.push(`batch ${a.n} green: waits for batch ${first.n}, ahead of it in the queue`);
        return;
      }
      if (c.snap.main !== a.base) {
        record(c, { n: a.n, outcome: "rebuilt", prs: a.prs, head: a.head, note: `main moved from ${a.base} to ${c.snap.main}` });
        retire(c, a);
        if (budgetAllows(c, a.lineage, a.prs)) {
          const item = { prs: a.prs, depth: a.depth, lineage: a.lineage };
          startBuild(c, a.prs, a.depth, a.lineage, { kind: "pending", item }, true);
        } else if (c.pausing) {
          c.s.pending.unshift({ prs: a.prs, depth: a.depth, lineage: a.lineage });
        }
        return;
      }
      land(c, a);
      return;
    }
    case "red":
      if (!ci.policy && a.rerun === null && ci.failedRuns.length > 0) {
        if (budgetAllows(c, a.lineage, a.prs)) {
          a.redJobs = ci.failedJobs; // for flaky tracking and the flaky hook event, if the rerun passes
          rerun(c, a, ci.failedRuns);
        }
        else if (!c.pausing) retire(c, a);
        return;
      }
      handleRed(c, a, ci.failedJobs, ci.reason);
      return;
  }
}

function handleRed(c: Ctx, a: Active, failedJobs: FailedJob[], reason: string): void {
  const mainFailed = c.snap.mainFailedJobs;
  const mainRunRed = a.prs.length === 1 && mainFailed !== null && failedJobs.length > 0 && failedJobs.every((j) => mainFailed.includes(j.name));
  // Main's own run for this batch is in and not red (queue.strategy.mainBaseline): a PR that fails alone now is compared with other PRs that did.
  const mainNotRed = !mainRunRed && a.prs.length === 1 && c.s.baseline?.result?.red === false && c.s.baseline.forBatch === a.n;
  const seen = mainRunRed ? null : againstBaseline(c, a, failedJobs);
  if (seen === "wait") return; // the batch keeps its slot until main's own run is in
  c.s.redStreak += 1;
  if (seen?.own.length === 0) {
    holdOnRedMain(c, a, seen.main);
    return;
  }
  if (a.prs.length === 1) {
    const pr = a.prs[0]!;
    if (mainRunRed) {
      pause(c, `main is red: #${pr} fails only jobs that also fail on main`);
      abandon(c, a, a.prs, "main red");
      return;
    }
    if (mainNotRed && retryAlone(c, a, pr, failedJobs)) return;
    const pin = c.s.auth[String(pr)]?.head ?? "?";
    const tag = `bounce:${a.n}`;
    emit(c, {
      event: "bounced",
      key: `bounced:${a.n}:${pr}:${pin}`,
      batch: hookBatch(a),
      prs: [hookPr(c, pr)],
      details: { reason, failedJobs: jobsOf(failedJobs), failedOnRerun: failedJobs.length > 0 && a.rerun !== null },
    });
    unready(c, pr, tag);
    comment(
      c,
      pr,
      tag,
      `Bounced from the landing queue: batch ${a.n} (this PR alone, at \`${pin}\`, on top of main \`${a.base}\`) failed${failedJobs.length > 0 ? ", and failed again on a rerun" : `: ${reason}`}.\n\n${jobsList(failedJobs)}\n\n${seen ? `Main also fails without this PR (${mainFailures(seen.main)}), but these fail only with it: ${seen.own.slice(0, 5).join(", ")}.\n\n` : ""}Fix it and re-add \`ready\`.`,
    );
    delete c.s.auth[String(pr)];
    c.s.bounceStreak += 1;
    if (mainNotRed) rememberAlone(c, a, pr, failedJobs);
    record(c, { n: a.n, outcome: "bounced", prs: a.prs, head: a.head, note: reason, failedJobs });
    retire(c, a);
    if (c.s.bounceStreak >= c.cfg.breakerBounces) pause(c, `${c.s.bounceStreak} bounces in a row without a landing`);
    return;
  }
  if (a.on === undefined) rememberRed(c, a);
  if (c.cfg.strategy?.adaptive && a.depth === 0) halveLimit(c, a.n);
  split(c, { prs: a.prs, depth: a.depth, lineage: a.lineage }, { n: a.n, head: a.head, note: reason, failedJobs });
  retire(c, a);
}

/**
 * queue.strategy.mainBaseline (DESIGN.md §5.7): does this red batch fail only
 * what main fails on its own? "wait" while main's own run is going; null when
 * there is nothing to compare, and the batch then goes on as it always did.
 * A group is compared only once main is known to be red: it still splits to
 * find a culprit, and the baseline is run only when a PR is about to bounce.
 */
function againstBaseline(c: Ctx, a: Active, failedJobs: FailedJob[]): "wait" | { own: string[]; main: BaselineResult } | null {
  if (!c.cfg.strategy?.mainBaseline || failedJobs.length === 0 || a.on !== undefined || a.base !== c.snap.main) return null;
  if (a.prs.some((pr) => c.s.auth[String(pr)]?.policyPr)) return null; // it may change the gates it was judged by
  const b = c.s.baseline;
  if (!b) {
    if (a.prs.length !== 1 || windowUsed(c) >= c.cfg.windowBudget || lineageRuns(c, a.lineage) >= c.cfg.lineageBudget) return null;
    startBaseline(c, a);
    return "wait";
  }
  if (!b.result) return a.prs.length === 1 ? "wait" : null;
  if (!b.result.red) {
    if (b.forBatch === a.n) delete c.s.baseline; // used: the next PR gets its own run
    return null;
  }
  return { own: ownFailures(failedJobs, c.snap.redTests ?? {}, b.result), main: b.result };
}

/** Could this single PR's red run be compared with other PRs' (aloneRed)? The same limits as a comparison with main's own run. */
const aloneComparable = (c: Ctx, a: Active, failedJobs: FailedJob[]) =>
  c.cfg.strategy?.mainBaseline === true && failedJobs.length > 0 && a.on === undefined && a.base === c.snap.main && !c.s.auth[String(a.prs[0])]?.policyPr;

/** A PR that failed alone on this main while main's own run did not: remember what it failed (retryAlone compares later PRs with it). */
function rememberAlone(c: Ctx, a: Active, pr: number, failedJobs: FailedJob[]): void {
  if (!aloneComparable(c, a, failedJobs)) return;
  const r = c.s.aloneRed?.base === a.base ? c.s.aloneRed : undefined;
  const entry = { pr, n: a.n, result: baselineResult(failedJobs, c.snap.redTests ?? {}) };
  c.s.aloneRed = { base: a.base, seen: [...(r?.seen ?? []).filter((e) => e.pr !== pr), entry].slice(-ALONE_RED_MAX), retried: r?.retried ?? [] };
}

/**
 * Main's own run did not show this PR's failures, but a failure that comes and
 * goes can pass once. If another PR already failed exactly these alone on this
 * main (each after its rerun), the two most likely share main's failure, not
 * one of their own: this PR is tested alone once more instead of bounced, and
 * is not counted. A pin is retried once; failing again bounces it as ever.
 * Nothing is held and nothing lands without a green suite.
 */
function retryAlone(c: Ctx, a: Active, pr: number, failedJobs: FailedJob[]): boolean {
  const r = c.s.aloneRed;
  const head = c.s.auth[String(pr)]?.head;
  if (!r || r.base !== a.base || head === undefined || !aloneComparable(c, a, failedJobs)) return false;
  if (r.retried.some((p) => p.pr === pr && p.head === head)) return false;
  // A marker goes only once its pin has left the queue, never to make room: a full list means no retry.
  r.retried = r.retried.filter((p) => c.s.auth[String(p.pr)]?.head === p.head);
  if (r.retried.length >= ALONE_RED_MAX) return false;
  const tests = c.snap.redTests ?? {};
  const other = r.seen.find((e) => e.pr !== pr && ownFailures(failedJobs, tests, e.result).length === 0);
  if (!other) return false;
  const mine = baselineResult(failedJobs, tests);
  rememberAlone(c, a, pr, failedJobs);
  const failing = (mine.tests.length > 0 ? mine.tests : mine.jobs).slice(0, 10);
  c.s.aloneRed!.retried = [...c.s.aloneRed!.retried.filter((p) => p.pr !== pr), { pr, head, other: other.pr, failing }];
  const what = mainFailures(mine);
  const names = c.cfg.names.main;
  comment(
    c,
    pr,
    `alone-retry:${a.n}`,
    `Still in the landing queue, and not bounced: batch ${a.n} (this PR alone, at \`${head}\`, on top of ${names} \`${a.base}\`) failed, and failed again on a rerun, on ${what}. #${other.pr} failed exactly that alone on the same ${names}, and ${names}'s own run with no PR in it did not, so ${names} most likely fails it on and off. This PR is tested alone once more, and is bounced only if it fails again.`,
  );
  record(c, { n: a.n, outcome: "solo", prs: a.prs, head: a.head, note: `${names} most likely fails ${what} on and off: #${other.pr} failed the same alone on it; tested alone once more`, failedJobs });
  requeueSolo(c, [{ pr, lineage: a.lineage, reason: "split" }]);
  retire(c, a);
  return true;
}

/** Queue a run of the suite on main alone. A ref at a commit that is already on main needs no merge and no journal: a lost ref just reads as no run. */
function startBaseline(c: Ctx, a: Active): void {
  reserve(c, a.lineage);
  const n = c.s.seq++; // a build later this tick must not take the same queue ref
  c.s.baseline = { n, base: a.base, builtAt: c.now, forBatch: a.n, held: [] };
  notify(c, { id: `b:${n}`, kind: "createRef", ref: queueRef(c.cfg.names, n), head: a.base });
  c.log.push(`batch ${a.n} red alone: running ${c.cfg.names.main} ${a.base} with no PR in it (batch ${n}) before judging it`);
}

/** The PRs fail only what main fails: they stay admitted, nothing is bounced or counted, and they wait for main to move. */
function holdOnRedMain(c: Ctx, a: Active, main: BaselineResult): void {
  const b = c.s.baseline!;
  const names = c.cfg.names.main;
  for (const pr of a.prs) {
    b.held.push({ pr, head: c.s.auth[String(pr)]!.head });
    comment(c, pr, `main-red:${a.n}`, `Still in the landing queue, and not bounced: batch ${a.n} failed, but ${names} \`${b.base}\` fails the same way with no PR in it (${mainFailures(main)}). This PR will be tested again once ${names} moves, and lands only on a green suite. Nothing to do here unless you can fix ${names}.`);
  }
  abandon(c, a, [], `${names} is red: it fails ${mainFailures(main)} with no PR in it`);
  if (b.held.length < c.cfg.breakerBounces) return;
  b.stopped = true;
  pause(c, `${names} is broken: \`${b.base}\` fails with no PR in it (${mainFailures(main, 5)}). ${b.held.map((h) => `#${h.pr}`).join(" ")} failed only that and stay admitted. Fix ${names}, then close this issue to test them again.`);
}

/** Read main's own run, and drop a baseline that no longer says anything about main. */
function settleBaseline(c: Ctx): void {
  // What PRs failed alone says something only about this main.
  if (c.s.aloneRed && (c.s.aloneRed.base !== c.snap.main || !c.cfg.strategy?.mainBaseline)) delete c.s.aloneRed;
  const b = c.s.baseline;
  if (!b) return;
  b.held = b.held.filter((h) => c.s.auth[String(h.pr)]?.head === h.head);
  if (b.stopped || b.base !== c.snap.main || !c.cfg.strategy?.mainBaseline) {
    if (!b.result) endBaselineRun(c, b, true);
    delete c.s.baseline;
    return;
  }
  // A result that isn't red is kept only for the batch it was run for (it can be held a while, on mergeability). A red one stays until main moves.
  if (b.result && !b.result.red && !actives(c.s).some((a) => a.n === b.forBatch)) {
    delete c.s.baseline;
    return;
  }
  const ci = c.snap.baselineCi;
  if (b.result || !ci || ci.kind === "pending") return;
  // Green proves little (a flaky failure can pass once) and inconclusive proves nothing: this PR is judged as it always was, and the next one gets its own run.
  b.result = ci.kind === "red" ? baselineResult(ci.failedJobs, c.snap.baselineTests ?? {}) : NOT_RED;
  c.log.push(`${c.cfg.names.main} ${b.base} with no PR in it (batch ${b.n}): ${ci.kind}`);
  endBaselineRun(c, b, ci.kind !== "red" && ci.kind !== "green");
}

function endBaselineRun(c: Ctx, b: Baseline, cancel: boolean): void {
  if (cancel) cancelRuns(c, b.n, b.base);
  notify(c, { id: `d:${b.n}`, kind: "deleteRef", ref: queueRef(c.cfg.names, b.n) });
}

/** Isolate a red group of PRs (§5.3 rule 6): halves on `pending` below the depth limit, else each PR on `solo`. */
function split(c: Ctx, item: Pending, rec: { n: number; head: string | null; note: string; failedJobs?: FailedJob[] }): void {
  const { prs, depth, lineage } = item;
  if (depth < c.cfg.maxSplitDepth) {
    // queue.strategy.firstAlone (DESIGN.md §5.7): a red fresh batch retests its first PR alone, then the rest together.
    const k = c.cfg.strategy?.firstAlone && depth === 0 ? 1 : Math.floor(prs.length / 2);
    const left: Pending = { prs: prs.slice(0, k), depth: depth + 1, lineage };
    const right: Pending = { prs: prs.slice(k), depth: depth + 1, lineage };
    requeuePending(c, [left, right]);
    record(c, { n: rec.n, outcome: "split", prs, head: rec.head, note: rec.note, ...(rec.failedJobs ? { failedJobs: rec.failedJobs } : {}) });
  } else {
    requeueSolo(c, prs.map((pr) => ({ pr, lineage, reason: "split" as const })));
    record(c, { n: rec.n, outcome: "solo", prs, head: rec.head, note: rec.note, ...(rec.failedJobs ? { failedJobs: rec.failedJobs } : {}) });
  }
}

/** queue.strategy.adaptive (DESIGN.md §5.7): a red fresh batch of several PRs halves the fresh batch size limit, and restarts the green count. */
function halveLimit(c: Ctx, n: number): void {
  const before = adaptiveLimit(c.cfg, c.s);
  const size = Math.max(1, c.cfg.minBatch, Math.floor(before / 2));
  c.s.adaptive = { size, greens: 0 };
  c.log.push(`batch ${n} red: fresh batch size limit ${before} -> ${size}`);
}

/** With queue.strategy.adaptive off, a leftover limit goes. */
function pruneAdaptive(c: Ctx): void {
  if (c.s.adaptive && !c.cfg.strategy?.adaptive) delete c.s.adaptive;
}

/** How many seen-red compositions are kept (queue.strategy.skipSeenRed): the newest. */
export const SEEN_RED_MAX = 8;

const pinsOf = (c: Ctx, prs: number[]) => prs.map((pr) => ({ pr, head: c.s.auth[String(pr)]?.head ?? "" }));
const samePins = (x: Pin[], y: Pin[]) => x.length === y.length && x.every((p, i) => p.pr === y[i]!.pr && p.head === y[i]!.head);

/**
 * queue.strategy.skipSeenRed (DESIGN.md §5.7): remember a red batch of several
 * PRs as its base and pinned PRs, so that the same tree is never built again.
 */
function rememberRed(c: Ctx, a: Active): void {
  if (!c.cfg.strategy?.skipSeenRed || a.prs.length < 2) return;
  const pins = pinsOf(c, a.prs);
  const rest = (c.s.seenRed ?? []).filter((e) => !(e.base === a.base && samePins(e.pins, pins)));
  c.s.seenRed = [...rest, { n: a.n, base: a.base, pins }].slice(-SEEN_RED_MAX);
}

/**
 * Keep only what can still match (queue.strategy.skipSeenRed): entries on the
 * current main whose PRs are all still admitted at their pinned heads. A
 * landing moves an entry onto the new main (ops.ts); anything else that moves
 * main makes it stale. With the key off the field goes.
 */
function pruneSeenRed(c: Ctx): void {
  if (!c.s.seenRed) return;
  const keep = c.cfg.strategy?.skipSeenRed
    ? c.s.seenRed.filter((e) => e.base === c.snap.main && e.pins.every((p) => c.s.auth[String(p.pr)]?.head === p.head))
    : [];
  if (keep.length > 0) c.s.seenRed = keep;
  else delete c.s.seenRed;
}

/**
 * queue.strategy.reuseGreen (DESIGN.md §5.7): a parked batch is kept only
 * while it can still land as it was tested: on the current main, with every
 * PR still admitted at its pinned head. With the key off the field goes.
 * Unparking cancels its runs.
 */
function pruneParked(c: Ctx): void {
  const p = c.s.parked;
  if (!p) return;
  if (!c.cfg.strategy?.reuseGreen) unpark(c, "queue.strategy.reuseGreen is off");
  else if (p.base !== c.snap.main) unpark(c, `${c.cfg.names.main} moved from ${p.base}`);
  else if (!p.pins.every((x) => c.s.auth[String(x.pr)]?.head === x.head)) unpark(c, "a PR in it left the queue or moved");
}

/**
 * Land the parked batch instead of selecting (queue.strategy.reuseGreen,
 * DESIGN.md §5.7). Only with no batch running (so FIFO among running
 * batches, §5.6, holds trivially) and no prioritised PR waiting, and only
 * when the work selection would take next is exactly its PRs at their pinned
 * heads (the head of `solo`, or of `pending` as one batch), or fresh
 * candidates that start with them (after a config change readmitted them),
 * each revalidating now, on the main it was built on, with its run there
 * green under the current config. It becomes the running batch, with its
 * own number, base and head, and its landing is journalled as for any green
 * batch. It needs no run, so it comes before the budget checks. Otherwise
 * nothing happens here, and the build that follows unparks it.
 */
function reuseParked(c: Ctx): boolean {
  const p = c.s.parked;
  if (!c.cfg.strategy?.reuseGreen || !p || p.base !== c.snap.main) return false;
  if (actives(c.s).length > 0 || prioritised(c).length > 0 || heldPrioritised(c).length > 0) return false;
  const k = p.pins.length;
  const matches = (prs: number[]) => prs.length >= k && samePins(p.pins, pinsOf(c, prs.slice(0, k)));
  const solo = c.s.solo[0];
  const head = c.s.pending[0];
  let at: { depth: number; lineage: number } | undefined;
  let source: "solo" | "pending" | "candidates";
  if (solo) {
    if (k !== 1 || !matches([solo.pr])) return false;
    at = { depth: c.cfg.maxSplitDepth, lineage: solo.lineage };
    source = "solo";
  } else if (head) {
    if (head.prs.length !== k || !matches(head.prs) || soloCut(c, head.prs, k).length !== k) return false;
    at = { depth: head.depth, lineage: head.lineage };
    source = "pending";
  } else {
    if (!matches(soloCut(c, freshCandidates(c), Math.max(k, batchSize(c))))) return false;
    source = "candidates";
  }
  if (!p.pins.every((x) => stillOk(c, x.pr).ok)) return false;
  const ci = c.snap.parkedCi;
  if (ci?.kind !== "green") {
    c.log.push(`batch ${p.n} not reused: its run on this main is ${ci ? ci.kind : "unread"}`);
    return false;
  }
  const a = parkedBatch(p, at?.depth, at?.lineage);
  if (!(String(a.lineage) in c.s.lineages)) return false;
  if (source === "solo") c.s.solo.shift();
  if (source === "pending") c.s.pending.shift();
  delete c.s.parked;
  setActives(c.s, [a], a.n);
  c.log.push(`batch ${a.n} reused: its run on this main went green while it was parked; landing it without a rebuild`);
  land(c, a);
  return true;
}

/** The seen-red entry this group of PRs would rebuild on main, if any. */
function seenRed(c: Ctx, prs: number[]): SeenRed | undefined {
  if (!c.cfg.strategy?.skipSeenRed || prs.length < 2) return undefined;
  const pins = pinsOf(c, prs);
  return c.s.seenRed?.find((e) => e.base === c.snap.main && samePins(e.pins, pins));
}

/**
 * The prefix of `prs` to take now (DESIGN.md §5.4 step 2): the first PR and
 * the PRs right behind it of the same batch class, so FIFO order is kept. A
 * run-alone PR is taken by itself; CI-policy PRs share up to
 * queue.policy.shareBatch.max.
 */
function soloCut(c: Ctx, prs: number[], max: number): number[] {
  const first = prs[0];
  if (first === undefined) return [];
  const kind = batchClass(c, first);
  if (kind === "alone") return [first];
  const limit = kind === "policy" ? Math.min(max, c.cfg.policyShareBatch!.max) : max;
  const out: number[] = [];
  for (const pr of prs) {
    if (out.length >= limit || batchClass(c, pr) !== kind) break;
    out.push(pr);
  }
  return out;
}

/**
 * Admitted PRs not in any batch or recovery item, in FIFO order (DESIGN.md
 * §4.4). A held PR keeps its admission and its place, but is not built this tick.
 */
/** Held by a red main (queue.strategy.mainBaseline) at this head: not built again for now. */
const heldOnRedMain = (c: Ctx, pr: number) => c.s.baseline?.held.some((h) => h.pr === pr && h.head === c.s.auth[String(pr)]?.head) ?? false;

function freshCandidates(c: Ctx): number[] {
  const busy = inFlight(c.s);
  return Object.entries(c.s.auth)
    .map(([k, au]) => ({ pr: Number(k), au }))
    .filter((x) => !busy.has(x.pr) && !c.excluded.has(x.pr) && !c.held.has(String(x.pr)) && !heldOnRedMain(c, x.pr))
    .sort(
      (x, y) =>
        x.au.admittedAt.localeCompare(y.au.admittedAt) ||
        x.au.labelledAt.localeCompare(y.au.labelledAt) ||
        x.pr - y.pr,
    )
    .map((x) => x.pr);
}

/** The priority lane (DESIGN.md §4.4): fresh candidates carrying a counting priority label, in FIFO order. */
function prioritised(c: Ctx): number[] {
  if (!c.cfg.names.labels.priority) return [];
  return freshCandidates(c).filter((pr) => c.s.auth[String(pr)]?.priority);
}

/** Prioritised fresh PRs held on unknown mergeability this tick (at most HOLD_MINUTES, then dropped). */
function heldPrioritised(c: Ctx): number[] {
  if (!c.cfg.names.labels.priority) return [];
  const busy = inFlight(c.s);
  return Object.entries(c.s.auth)
    .filter(([k, au]) => au.priority && c.held.has(k) && !busy.has(Number(k)) && !c.excluded.has(Number(k)) && !heldOnRedMain(c, Number(k)))
    .map(([k]) => Number(k));
}

/** The fresh batch size: queue.batch.max halved per red in a row, or (queue.strategy.adaptive, DESIGN.md §5.7) the adaptive limit. */
const batchSize = (c: Ctx) => (c.cfg.strategy?.adaptive ? adaptiveLimit(c.cfg, c.s) : Math.max(1, c.cfg.minBatch, c.cfg.maxBatch >> c.s.redStreak));

const prList = (prs: number[]) => prs.map((p) => `#${p}`).join(" ");

/**
 * Preemption (queue.priority.preempt, DESIGN.md §4.4), called only while the
 * running batch's CI is still pending and every PR in it revalidated: the
 * safe point. A batch whose CI finished is landed, rerun, split or bounced
 * first; a landing is a journalled op, and decide() never runs while one is
 * outstanding. The batch is abandoned through the usual path (its runs are
 * cancelled from the outbox, its PRs go back to the front of pending in
 * their order, same lineage; a solo PR to the front of `solo`), and the
 * priority batch builds this tick. Never a batch that carries a prioritised
 * PR, never the same lineage twice, never when the window budget could not
 * pay for the priority build or the lineage for the retest. The
 * cancelled run stays charged to both budgets.
 */
function preempt(c: Ctx, a: Active): boolean {
  if (!c.cfg.priorityPreempt || c.pausing) return false;
  const urgent = prioritised(c);
  if (urgent.length === 0) return false;
  // With several batches running (DESIGN.md §5.6): only when every slot is taken, and only the newest batch.
  const all = actives(c.s);
  if (all.length < maxActive(c.cfg) || all.at(-1) !== a) return false;
  if (a.prs.some((pr) => c.s.auth[String(pr)]?.priority)) {
    c.log.push(`batch ${a.n} not preempted: it carries a prioritised PR`);
    return false;
  }
  const key = String(a.lineage);
  const lineage = c.s.lineages[key];
  if (lineage?.preempted) {
    c.log.push(`batch ${a.n} not preempted: its lineage was preempted once already`);
    return false;
  }
  if (windowUsed(c) >= c.cfg.windowBudget) return false;
  // The retest must be affordable: stopping a lineage's last allowed run would unready its PRs.
  if (lineageRuns(c, a.lineage) >= c.cfg.lineageBudget) {
    c.log.push(`batch ${a.n} not preempted: its lineage has no run left for the retest`);
    return false;
  }
  const by = c.s.auth[String(urgent[0])]!.priority!.by;
  c.s.lineages[key] = { runs: lineage?.runs ?? 0, preempted: true };
  for (const pr of a.prs) {
    comment(c, pr, `preempt:${a.n}`, `Batch ${a.n} was stopped so that prioritised ${prList(urgent)} (priority applied by ${by}) could build first. This PR keeps its place and is retested right after.`);
  }
  // A PR running from `solo` (a split at the depth limit) goes back to the front of `solo`, ahead of its siblings, not into `pending` behind them.
  const fromSolo = a.prs.length === 1 && a.depth >= c.cfg.maxSplitDepth && c.s.solo.length > 0;
  abandon(c, a, fromSolo ? [] : a.prs, `preempted by priority ${prList(urgent)}`);
  if (fromSolo) requeueSolo(c, [{ pr: a.prs[0]!, lineage: a.lineage, reason: "split" }]);
  return true;
}

/**
 * The running batch a fresh batch may be stacked on (pipelining, DESIGN.md
 * §5.6), or undefined. Only on a chain of fresh batches: no recovery work
 * queued or running, the first batch on main and each later one stacked on
 * the one before, fewer than pipelineDepth stacked, and the top one ordinary
 * (no CI-policy, waived or operator-solo PR) with its CI pending or green and
 * no rerun.
 */
function stackTail(c: Ctx, all: Active[]): Active | undefined {
  const depth = c.cfg.concurrency?.pipelineDepth ?? 0;
  if (depth === 0 || c.s.pending.length > 0 || c.s.solo.length > 0) return undefined;
  if (all.some((a) => a.depth > 0) || all[0]?.base !== c.snap.main || all[0].on !== undefined) return undefined;
  for (let i = 1; i < all.length; i++) if (all[i]!.on !== all[i - 1]!.n) return undefined;
  if (all.length - 1 >= depth) return undefined;
  const tail = all.at(-1)!;
  // A PR that would not merge on top of it stops speculation on it (FIFO: nothing behind that PR goes first).
  if (c.s.history.some((h) => h.outcome === "empty" && h.note.startsWith(speculationRefused(tail.n)))) return undefined;
  const ci = ciOf(c, tail);
  if (tail.rerun !== null || !ci || (ci.kind !== "pending" && ci.kind !== "green")) return undefined;
  if (tail.prs.some((pr) => batchClass(c, pr) !== "ordinary")) return undefined;
  return tail;
}

function select(c: Ctx): void {
  const all = actives(c.s);
  if (all.length >= maxActive(c.cfg)) return;
  // queue.strategy.reuseGreen (DESIGN.md §5.7): a parked batch whose run went green lands with no build, so before any budget.
  if (reuseParked(c)) return;
  // A further slot beside running batches (DESIGN.md §5.6): it never pauses the queue, it just stays empty.
  const beside = all.length > 0;
  for (let guard = 0; guard < 1000; guard++) {
    if (windowUsed(c) >= c.cfg.windowBudget) {
      if (beside) {
        c.log.push(`no further batch: window budget of ${c.cfg.windowBudget} runs per ${c.cfg.windowHours}h used`);
        return;
      }
      pause(c, `window budget of ${c.cfg.windowBudget} runs per ${c.cfg.windowHours}h used`);
      return;
    }
    // The priority lane goes first, and never waits to fill (DESIGN.md §4.4).
    const urgent = prioritised(c);
    if (urgent.length > 0) {
      const take = soloCut(c, urgent, batchSize(c));
      const by = [...new Set(take.map((pr) => c.s.auth[String(pr)]!.priority!.by))].join(", ");
      c.log.push(`build: priority ${prList(take)} (applied by ${by})`);
      startBuild(c, take, 0, c.s.nextLineage++, { kind: "candidates" }, false);
      return;
    }
    // A prioritised PR held on unknown mergeability (as every PR is for a while after a landing) still goes next: build nothing else meanwhile.
    const waiting = heldPrioritised(c);
    if (waiting.length > 0) {
      c.log.push(`waiting: prioritised ${prList(waiting)} held until GitHub computes mergeability`);
      return;
    }
    const solo = c.s.solo[0];
    if (solo) {
      const r = stillOk(c, solo.pr);
      if (!r.ok && r.hold) {
        c.log.push(`solo #${solo.pr} held: ${r.reason}; not built this tick`);
        return;
      }
      if (!r.ok) {
        dropPr(c, solo.pr, r);
        continue;
      }
      if (lineageRuns(c, solo.lineage) >= c.cfg.lineageBudget) {
        exhaustLineage(c, solo.lineage, []);
        continue;
      }
      c.s.solo.shift();
      startBuild(c, [solo.pr], c.cfg.maxSplitDepth, solo.lineage, { kind: "solo", item: solo }, false);
      return;
    }
    const head = c.s.pending[0];
    if (head) {
      const checks = head.prs.map((pr) => ({ pr, r: stillOk(c, pr) }));
      const bad = checks.flatMap(({ pr, r }) => (!r.ok && !r.hold ? [{ pr, r }] : []));
      if (bad.length > 0) {
        for (const { pr, r } of bad) dropPr(c, pr, r);
        continue;
      }
      // Keep the recorded batch whole: wait for its held PRs rather than build it without them.
      const held = checks.filter((x) => !x.r.ok).map((x) => x.pr);
      if (held.length > 0) {
        c.log.push(`pending batch held: ${heldList(held)} mergeability not computed yet; not built this tick`);
        return;
      }
      if (lineageRuns(c, head.lineage) >= c.cfg.lineageBudget) {
        exhaustLineage(c, head.lineage, []);
        continue;
      }
      const take = soloCut(c, head.prs, head.prs.length);
      const rest = head.prs.slice(take.length);
      if (rest.length > 0) c.s.pending[0] = { ...head, prs: rest };
      else c.s.pending.shift();
      // queue.strategy.skipSeenRed (DESIGN.md §5.7): this tree is already known red; split it without a run.
      const known = seenRed(c, take);
      if (known) {
        c.log.push(`split ${prList(take)} without a run: already red as batch ${known.n} on this tree`);
        split(c, { ...head, prs: take }, { n: known.n, head: null, note: `already seen red as batch ${known.n} (the same PRs and heads on this main); not rebuilt` });
        continue;
      }
      startBuild(c, take, head.depth, head.lineage, { kind: "pending", item: { ...head, prs: take } }, false);
      return;
    }
    const busy = inFlight(c.s);
    const ordered = freshCandidates(c);
    if (ordered.length === 0) {
      const held = Object.keys(c.s.auth).filter((k) => c.held.has(k) && !busy.has(Number(k)));
      if (held.length > 0) {
        c.log.push(`waiting: ${heldList(held.map(Number))} held until GitHub computes mergeability`);
        return; // an operator go stays for the next fresh selection
      }
      if (c.s.go) c.log.push("operator go: nothing to land");
      delete c.s.go;
      c.log.push("idle: nothing to land");
      return;
    }
    // Beside running batches (DESIGN.md §5.6), only ordinary fresh PRs build: beside
    // recovery batches, one fresh batch on main; beside fresh ones, stacked on their chain.
    const recovering = all.some((a) => a.depth > 0);
    const tail = beside && !recovering ? stackTail(c, all) : undefined;
    const allowed = !beside || (batchClass(c, ordered[0]!) === "ordinary" && (recovering ? all.every((a) => a.depth > 0) : tail !== undefined));
    if (!allowed) {
      c.log.push(`waiting: ${heldList(ordered.slice(0, 10))}${ordered.length > 10 ? " ..." : ""} wait for the running batch${all.length > 1 ? "es" : ""}`);
      return;
    }
    const size = batchSize(c);
    const take = soloCut(c, ordered, size);
    const why = fillReason(c, ordered, take, size);
    if (why === null) return;
    c.log.push(`build: ${why}${tail ? ` (on batch ${tail.n})` : ""}`);
    delete c.s.go;
    const lineage = c.s.nextLineage++;
    startBuild(c, take, 0, lineage, { kind: "candidates" }, false, tail?.head);
    return;
  }
}

/** When a PR became eligible for the fill timer: its persisted eligibleSince, else its admission. */
function eligibleAt(s: State, pr: number): number {
  const a = s.auth[String(pr)]!;
  const e = s.eligibleSince?.[String(pr)];
  const since = e && e.head === a.head && e.labelledAt === a.labelledAt ? e.since : a.admittedAt;
  return Date.parse(since);
}

/**
 * The fill timer for a fresh batch (recovery never reaches here): why to build
 * now, or null to keep filling. The target is minFill, capped by the effective
 * batch size after the red streak. The wait is measured from persisted state
 * (eligibleSince / admittedAt), so it survives restarts and counts time
 * spent behind an active batch.
 */
function fillReason(c: Ctx, ordered: number[], take: number[], size: number): string | null {
  const target = Math.min(c.cfg.minFill, size);
  const head = ordered[0]!;
  const kind = batchClass(c, head);
  if (kind === "alone") return `#${head} runs alone`;
  // CI-policy PRs never wait to fill: they build at once, as when each ran alone, with whichever approved policy PRs are already behind the head.
  if (kind === "policy") return take.length > 1 ? `${take.length} approved CI-policy PRs share a batch` : `#${head} runs alone`;
  if (take.length >= target) return `filled (${take.length} of ${target})`;
  // A PR of another class right after the prefix closes it: later admissions sort behind it, so waiting cannot fill it.
  const next = ordered[take.length];
  if (next !== undefined && batchClass(c, next) !== "ordinary") return `prefix closed by ${batchClass(c, next) === "policy" ? "CI-policy" : "run-alone"} #${next}`;
  const oldest = Math.min(...ordered.map((pr) => eligibleAt(c.s, pr)));
  const deadline = oldest + c.cfg.maxWaitMinutes * 60_000;
  if (!(c.snap.now.getTime() < deadline)) return `oldest eligible PR waited ${c.cfg.maxWaitMinutes}m`;
  if (c.s.go) return "operator go";
  c.fillUntil = deadline;
  c.log.push(`filling: ${take.length} of ${target} PRs; builds by ${new Date(deadline).toISOString()}`);
  return null;
}

/** The verdict line for a PR admit() refused, with what the snapshot read for the refusals a lagging or differing GitHub view can cause. */
function refusal(c: Ctx, live: LivePr, a: { kind: "ignore" | "wait" | "unready"; reason: string }): string {
  if (a.kind === "wait") return `waits: ${a.reason}`;
  if (a.kind === "unready") return `not queued: ${a.reason}; its \`ready\` label is being removed`;
  const listed = c.snap.readyListed?.includes(live.number) === true;
  if (a.reason === "not open" && listed) return `listed with \`ready\`, but the PR read is ${live.merged ? "merged" : "closed"}`;
  if (a.reason === "not labelled ready" && listed) return "listed with `ready`, but the PR read does not carry the label";
  if (!live.ready && live.readyUnreadable) return `${a.reason}: ${live.readyUnreadable}`;
  if (live.ready && a.reason.startsWith("ready applied without write access")) {
    return `${a.reason}; applied by ${live.ready.actorLogin} at ${live.ready.at}, whose permission read as '${live.ready.actorPermission}'`;
  }
  return a.reason;
}

/**
 * Every PR that is ready this tick (listed with the label by GitHub, or read
 * carrying it) but not admitted when the decision ends, and why
 * (DESIGN.md §4.2). Reporting only: nothing here changes the decision. A
 * ready PR is never left silent: one the pass did not reach gets `fallback`.
 */
function verdicts(c: Ctx, fallback: string): Verdict[] {
  const ready = new Set<number>([...(c.snap.readyListed ?? []), ...(c.snap.readyUnlisted ?? [])]);
  for (const live of Object.values(c.snap.prs)) if (live.open && live.labels.includes(c.cfg.names.labels.ready)) ready.add(live.number);
  const busy = inFlight(c.s);
  const out: Verdict[] = [];
  for (const pr of [...ready].sort((a, b) => a - b)) {
    if (c.s.auth[String(pr)] || busy.has(pr)) continue;
    const reason = c.snap.prs[String(pr)]
      ? (c.why.get(pr) ?? fallback)
      : c.snap.readyListed?.includes(pr) === true
        ? "listed with `ready`, but the PR could not be read (not found)"
        : "read carrying `ready`, but GitHub's ready listing missed it, so it was not evaluated this tick";
    out.push({ pr, reason });
    c.log.push(`#${pr} ignored: ${reason}`);
  }
  return out;
}

/** The decision, with this tick's verdicts (present only when there is one). */
function finish(c: Ctx, d: Decision, fallback: string): Decision {
  const ignored = verdicts(c, fallback);
  return withEvents(c, ignored.length > 0 ? { ...d, ignored } : d);
}

export function decide(prev: State, snap: Snapshot, cfg: Config): Decision {
  if (prev.journal) throw new Error("decide: reconcile the journal first");
  const s = structuredClone(prev);
  s.seq += 1;
  const c = makeCtx(s, snap, cfg);
  // A PR whose ready label we have not managed to remove yet still looks ready
  // in the snapshot: keep it out until that notice is done (review #10).
  for (const n of s.outbox) {
    if (n.kind !== "unready") continue;
    because(c, n.pr, "its `ready` label is still being removed (a notice from an earlier tick is pending)");
    c.excluded.add(n.pr);
  }
  pruneWindow(c);
  pruneOperatorSolo(c);
  applyCommands(c);
  processVerify(c);
  // A pause still waiting in the outbox counts as paused: the runner has not
  // opened the pause issue yet, so snap.paused cannot know about it.
  const pausePending = prev.outbox.some((n) => n.kind === "pause");
  if (snap.paused || pausePending) {
    c.log.push(pausePending && !snap.paused ? "paused (pause pending in the outbox): only verification runs" : "paused: only verification runs");
    return finish(c, { state: s, log: c.log }, "the queue is paused; admission was not evaluated"); // nothing was evaluated: recorded holds keep their clocks
  }
  if (c.pausing) return finish(c, { state: s, log: c.log }, "the queue is pausing; admission was not evaluated");
  admitAndRevalidate(c);
  pruneSeenRed(c);
  pruneParked(c);
  pruneAdaptive(c);
  settleBaseline(c);
  // Each running batch in batch-number order, until one journals an op (one effect per tick) or pauses.
  for (const a of actives(s)) {
    if (c.pausing || s.journal) break;
    if (actives(s).includes(a)) handleActive(c, a);
  }
  if (!c.pausing && !s.journal) select(c);
  settleHolds(c);
  const since = c.pausing ? undefined : holdSince(c);
  return finish(
    c,
    {
      state: s,
      log: c.log,
      ...(c.fillUntil !== undefined && !c.pausing ? { fillUntil: c.fillUntil } : {}),
      ...(since !== undefined ? { holdSince: since } : {}),
    },
    "not evaluated for admission this tick",
  );
}
