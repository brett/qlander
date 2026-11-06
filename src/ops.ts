// Outcomes of journalled ops (DESIGN.md §3.2, §7). applyOpResult() folds the
// outcome of the op the runner just performed into the state;
// interpretObservation() works out that outcome after a crash, from what the
// runner can observe, before anything else happens on the next tick.

import type { Config } from "./config";
import type { CommentSettings } from "./config/load";
import { describeWaiver } from "./automation";
import { actives, adaptiveLimit, comment, speculationRefused, type Decision, emit, emitDequeued, hookBatch, hookPr, makeCtx, notify, pause, record, refund, retire, setActives, unready, withEvents } from "./ctx";
import { type Active, type Auth, type BuildRecord, buildRecordProblem, type Journal, type Op, SQUASHED_MAX, type State } from "./state";
import type { RunRef } from "./types";
import { buildRef, queueRef } from "./validate";

export type OpResult =
  | { kind: "checkpoint"; record: BuildRecord }
  | { kind: "built"; head: string }
  | { kind: "empty" }
  | { kind: "buildAborted"; reason: string }
  | { kind: "buildFailed"; reason: string }
  | { kind: "queueMismatch"; head: string; reason: string }
  | { kind: "rerunDone"; confirmed?: RunRef[] }
  /** Intent for one rerun request, persisted before it is sent. */
  | { kind: "rerunSending"; run: RunRef; at: string }
  /** Receipt: GitHub accepted the request. */
  | { kind: "rerunConfirmed"; run: RunRef }
  /** Recovery: requests whose attempt advanced are confirmed; the rest keep waiting (never resent). */
  | { kind: "rerunReconcile"; confirmed: RunRef[] }
  /** The op's target is gone (a deleted run): a terminal outcome that pauses. */
  | { kind: "targetMissing"; reason: string }
  /** An outstanding op not executed because its batch is no longer valid. */
  | { kind: "opDropped"; reason: string }
  /** Recovery is about to re-execute the op: count it. */
  | { kind: "tried" }
  /** Re-executed too often: give up and pause. */
  | { kind: "opAbandoned"; reason: string }
  | { kind: "landed" }
  | { kind: "landRejected"; retry: boolean; reason: string }
  /** Linear landing (DESIGN.md §7.4): refused because these PRs' branches moved since admission; settled, nothing of ours is left on them. */
  | { kind: "headMoved"; prs: number[] }
  /** Linear landing (DESIGN.md §7.4): the write that settles the branches was refused, so nothing is proved. The journal stays; `overdue` also pauses. */
  | { kind: "landUnsettled"; overdue: boolean; reason: string }
  /** Linear landing (DESIGN.md §7.4): main at its base and every branch back at its admitted head, on the write path. The journal stays; the next tick resends. */
  | { kind: "landRestored" }
  /**
   * Linear landing (DESIGN.md §7.4): refused with main and every PR branch
   * reading where the batch left them. The journal stays and the next tick
   * resends it after revalidating; `counted` (not a transient error) adds one
   * to the op's `refused`, and maxRefusals in a row pause.
   */
  | { kind: "landRefused"; counted: boolean; reason: string }
  | { kind: "baseMoved" }
  | { kind: "cancelled" }
  | { kind: "retryOp" };

type BuildOp = Extract<Op, { kind: "build" }>;

/** The priority lane (DESIGN.md §4.4): who applied the label, for queued and landing comments. */
const prioritised = (auth: Auth | undefined) => (auth?.priority ? ` Prioritised by ${auth.priority.by}.` : "");

function restoreSource(s: State, op: BuildOp): void {
  if (op.source.kind === "pending") s.pending.unshift(op.source.item);
  else if (op.source.kind === "solo") s.solo.unshift(op.source.item);
}

/**
 * `comments` (qlander.yml, not policy) may leave out the queued and landed
 * comments. No decision reads a comment back, so leaving one out changes only what
 * the PR's subscribers are told; every comment that asks someone to act is
 * always posted.
 */
/**
 * queue.strategy.skipSeenRed (DESIGN.md §5.7): a landing moves main from
 * `before` to the head tested for `landed`. A seen-red entry on `before` that
 * starts with exactly those PRs at their pinned heads now describes the rest
 * of its PRs on the new main: merging them onto that head gives the same tree
 * as the red batch. Every other entry is stale and goes. Called before the
 * landed PRs' authorisations are removed. With the key off (say, turned off
 * while this landing was journalled) a leftover field is removed instead. A
 * linear landing carries nothing: a PR stacked on one it landed merged with
 * that PR's commits in the red batch and without them now, so the tree can
 * differ, and a split on that inference could test a PR apart from the one it
 * needs (§7.4). The cost is at most one more run.
 */
function carrySeenRed(s: State, landed: number[], before: string, after: string, cfg: Config, linear: boolean): void {
  if (!s.seenRed) return;
  if (!cfg.strategy?.skipSeenRed || linear) {
    delete s.seenRed;
    return;
  }
  const pins = landed.map((pr) => ({ pr, head: s.auth[String(pr)]?.head }));
  const out = s.seenRed.flatMap((e) => {
    const prefix = e.base === before && e.pins.length > pins.length && pins.every((p, i) => e.pins[i]!.pr === p.pr && e.pins[i]!.head === p.head);
    const rest = e.pins.slice(pins.length);
    return prefix && rest.length >= 2 ? [{ n: e.n, base: after, pins: rest }] : [];
  });
  if (out.length > 0) s.seenRed = out;
  else delete s.seenRed;
}

/**
 * queue.strategy.adaptive (DESIGN.md §5.7): a fresh batch that used the whole
 * limit landed green on its first run. Recovery work shares its red parent's
 * lineage, so its lineage has more than one run and never counts (even at
 * depth 0, with maxSplitDepth 0); nor does a rebuilt or rerun batch. After `greens` of them in a row the limit doubles,
 * up to the ceiling. A smaller batch says nothing about a bigger one,
 * so it neither counts nor resets the count. With the key off a leftover
 * field goes.
 */
function countGreen(s: State, a: Active, cfg: Config): void {
  const ad = cfg.strategy?.adaptive;
  if (!ad) {
    delete s.adaptive;
    return;
  }
  const limit = adaptiveLimit(cfg, s);
  if (a.depth !== 0 || a.prs.length < limit || s.lineages[String(a.lineage)]?.runs !== 1) return;
  const greens = (s.adaptive?.greens ?? 0) + 1;
  s.adaptive = greens >= ad.greens ? { size: Math.min(ad.ceiling, limit * 2), greens: 0 } : { size: limit, greens };
}

export function applyOpResult(prev: State, result: OpResult, cfg: Config, now: Date, comments: CommentSettings = { omit: [] }): Decision {
  const j = prev.journal;
  if (!j) throw new Error("applyOpResult: no journal");
  const s = structuredClone(prev);
  const c = makeCtx(
    s,
    { now, paused: false, main: "", policyHash: "", prs: {}, ci: null, mainFailedJobs: null, pinReachable: {} },
    cfg,
  );
  const op = j.op;
  const finish = (line: string): Decision => {
    s.journal = null;
    return withEvents(c, { state: s, log: [...c.log, line] });
  };
  if (result.kind === "retryOp") return { state: s, log: [`retry ${op.kind}`] };
  if (result.kind === "landRefused" && op.kind === "land") {
    const refused = (op.refused ?? 0) + (result.counted ? 1 : 0);
    s.journal = { ...j, op: { ...op, ...(refused > 0 ? { refused } : {}) } };
    const max = cfg.landing?.maxRefusals ?? 1;
    if (refused >= max) pause(c, `batch ${s.active?.n ?? "?"}: the linear landing was refused ${refused} times in a row with main and every PR branch where the batch left them: ${result.reason}`);
    return withEvents(c, { state: s, log: [...c.log, `landing refused (${refused} of ${max} in a row): ${result.reason}; retried next tick`] });
  }
  if (result.kind === "landUnsettled" && op.kind === "land") {
    // Never terminal: the journal stays, so the next tick observes again, paused or not.
    if (result.overdue) pause(c, `batch ${s.active?.n ?? "?"}: ${result.reason}`);
    return withEvents(c, { state: s, log: [...c.log, `landing unsettled: ${result.reason}`] });
  }
  if (result.kind === "landRestored" && op.kind === "land") return { state: s, log: ["landing: PR branches back at their admitted heads; resent next tick"] };

  if (op.kind === "build") {
    const rec = j.checkpoint;
    const applyDrops = () => {
      for (const d of rec?.dropped ?? []) {
        emitDequeued(c, d.pr, d.outcome === "conflict" ? "conflict" : d.outcome === "squashed" ? "squashed" : "already_in_main", d.outcome === "conflict" ? `conflicts with main plus the PRs ahead of it in batch ${op.n}` : d.outcome === "squashed" ? "carries commits that landed squashed" : "already contained in main");
        delete s.auth[String(d.pr)];
        const tag = `${d.outcome}:${op.n}`;
        unready(c, d.pr, tag);
        comment(
          c,
          d.pr,
          tag,
          d.outcome === "conflict"
            ? `Not queued: \`${d.pin}\` conflicts with main plus the PRs ahead of it in batch ${op.n}. Update the branch and re-add \`ready\`.`
            : d.outcome === "squashed"
              ? squashedNotice(d.pin, d.commit)
              : `Not queued: \`${d.pin}\` is already contained in main.`,
        );
      }
    };
    switch (result.kind) {
      case "checkpoint": {
        const problem = buildRecordProblem(op, result.record, s.auth);
        if (problem) {
          // Nothing was pushed yet: refund, put the work back, and pause.
          refund(s, op.lineage, j.at);
          restoreSource(s, op);
          notify(c, { id: `db:${op.n}`, kind: "deleteRef", ref: buildRef(cfg.names, op.n) });
          pause(c, `batch ${op.n}: build record rejected: ${problem}`);
          return finish(`build ${op.n}: record rejected: ${problem}`);
        }
        // Pipelining (DESIGN.md §5.6): a PR that does not merge on top of the running batch is not the PR's fault
        // (that batch may never land), and building without it would let younger PRs pass it. Refuse the whole
        // speculative build, uncharged, keep every PR's admission and place, and speculate no more on that batch.
        const under = actives(s).find((a) => a.head === op.base);
        if (under && result.record.dropped.length > 0) {
          refund(s, op.lineage, j.at);
          notify(c, { id: `db:${op.n}`, kind: "deleteRef", ref: buildRef(cfg.names, op.n) });
          const why = result.record.dropped.map((d) => `#${d.pr} ${d.outcome === "conflict" ? "conflicts" : d.outcome === "squashed" ? "carries squashed commits" : "is already contained"}`).join(", ");
          record(c, { n: op.n, outcome: "empty", prs: op.pins.map((p) => p.pr), head: null, note: `${speculationRefused(under.n)} ${why} on top of it` });
          return finish(`build ${op.n}: speculation on batch ${under.n} refused: ${why}`);
        }
        s.journal = { ...j, checkpoint: result.record };
        return { state: s, log: [`build ${op.n}: checkpoint, ${result.record.survivors.length} survive`] };
      }
      case "built": {
        if (!rec?.chainHead || result.head !== rec.chainHead) throw new Error("built without a matching checkpoint");
        const problem = buildRecordProblem(op, rec, s.auth);
        if (problem) {
          // queue/<n> exists: handle it as a mismatch, never as a batch.
          return applyOpResult(prev, { kind: "queueMismatch", head: result.head, reason: `build record rejected: ${problem}` }, cfg, now, comments);
        }
        applyDrops();
        // Pipelining (DESIGN.md §5.6): a batch built on a running batch's head is stacked on it.
        const under = actives(s).find((a) => a.head === op.base);
        const batch: Active = {
          n: op.n,
          base: op.base,
          head: rec.chainHead,
          depth: op.depth,
          prs: rec.survivors.map((p) => p.pr),
          lineage: op.lineage,
          rerun: null,
          rerunAt: null,
          cancels: [],
          builtAt: c.now,
          ...(under ? { on: under.n } : {}),
          ...(rec.stack ? { stack: rec.stack } : {}),
        };
        setActives(s, [...actives(s), batch]);
        notify(c, { id: `db:${op.n}`, kind: "deleteRef", ref: buildRef(cfg.names, op.n) });
        emit(c, {
          event: "batch_started",
          key: `batch_started:${op.n}`,
          batch: hookBatch(batch),
          prs: rec.survivors.map((p) => hookPr(c, p.pr)),
          details: {
            ref: queueRef(cfg.names, op.n),
            lineage: op.lineage,
            rebuild: op.rebuild,
            dropped: rec.dropped.map((d) => ({ number: d.pr, outcome: d.outcome })),
            // The priority lane (DESIGN.md §4.4): present only when the batch carries a prioritised PR.
            ...(rec.survivors.some((p) => s.auth[String(p.pr)]?.priority) ? { priority: rec.survivors.filter((p) => s.auth[String(p.pr)]?.priority).map((p) => ({ number: p.pr, by: s.auth[String(p.pr)]!.priority!.by })) } : {}),
          },
        });
        for (const p of comments.omit.includes("queued") ? [] : rec.survivors) {
          const w = s.auth[String(p.pr)]?.waiver;
          // A CI-policy PR sharing its batch (queue.policy.shareBatch) is tested under the other policy PRs' gate changes too: say which.
          const others = s.auth[String(p.pr)]?.policyPr ? rec.survivors.filter((o) => o.pr !== p.pr).map((o) => `#${o.pr}`) : [];
          const shared = others.length > 0 ? ` Its CI runs together with the approved CI-policy change${others.length > 1 ? "s" : ""} in ${others.join(", ")}.` : "";
          const on = under ? `on batch ${under.n} (\`${queueRef(cfg.names, under.n)}\`, still being tested; it lands only after that batch)` : `on ${cfg.names.main} \`${op.base}\``;
          comment(c, p.pr, `q:${op.n}`, `Queued in batch ${op.n} at \`${p.head}\` (\`${queueRef(cfg.names, op.n)}\`, ${on}).${w ? ` Admitted under a ${describeWaiver(w)}.` : ""}${shared}${prioritised(s.auth[String(p.pr)])}`);
        }
        return finish(`batch ${op.n} built with ${rec.survivors.length} PR(s)`);
      }
      case "empty":
        applyDrops();
        refund(s, op.lineage, j.at);
        notify(c, { id: `db:${op.n}`, kind: "deleteRef", ref: buildRef(cfg.names, op.n) });
        record(c, { n: op.n, outcome: "empty", prs: op.pins.map((p) => p.pr), head: null, note: "every PR dropped" });
        return finish(`batch ${op.n}: nothing survived the build`);
      case "buildAborted":
      case "buildFailed":
      case "opAbandoned":
        refund(s, op.lineage, j.at);
        restoreSource(s, op);
        notify(c, { id: `db:${op.n}`, kind: "deleteRef", ref: buildRef(cfg.names, op.n) });
        notify(c, { id: `d:${op.n}`, kind: "deleteRef", ref: queueRef(cfg.names, op.n) });
        if (result.kind !== "buildAborted") pause(c, `batch ${op.n}: ${result.reason}`);
        return finish(`build ${op.n} ${result.kind}: ${result.reason}`);
      case "queueMismatch":
        // queue/<n> exists, so CI may have run: keep the charge, stop its
        // runs, record the end, and only then delete the refs.
        restoreSource(s, op);
        notify(c, { id: `x:${op.n}`, kind: "cancelRuns", ref: queueRef(cfg.names, op.n), head: result.head, until: new Date(now.getTime() + cfg.cancelWindowMinutes * 60_000).toISOString(), giveUpAt: new Date(now.getTime() + cfg.cancelGiveUpHours * 3_600_000).toISOString() });
        record(c, { n: op.n, outcome: "abandoned", prs: op.pins.map((p) => p.pr), head: result.head, note: result.reason });
        notify(c, { id: `db:${op.n}`, kind: "deleteRef", ref: buildRef(cfg.names, op.n) });
        notify(c, { id: `d:${op.n}`, kind: "deleteRef", ref: queueRef(cfg.names, op.n) });
        pause(c, `batch ${op.n}: ${result.reason}`);
        return finish(`build ${op.n}: ${result.reason}`);
    }
  }

  if (result.kind === "tried") {
    s.journal = { ...j, tries: j.tries + 1 };
    return { state: s, log: [`retrying ${op.kind} (try ${j.tries + 1})`] };
  }

  if (op.kind === "rerun") {
    const same = (a: RunRef) => (b: RunRef) => a.runId === b.runId && a.attempt === b.attempt;
    const requested = op.requested ?? [];
    const done = op.done ?? [];
    const keep = (ops: Partial<Extract<Op, { kind: "rerun" }>>): Decision => {
      s.journal = { ...j, op: { kind: "rerun", runs: op.runs, done, requested, ...(op.everSent ? { everSent: true } : {}), ...ops } };
      return { state: s, log: [`rerun: ${result.kind}`] };
    };
    if (result.kind === "rerunSending") {
      // Irreversible: from here on this rerun may have executed, so it is never refunded.
      return keep({ runs: op.runs.filter((r) => !same(result.run)(r)), requested: [...requested, { ...result.run, at: result.at }], everSent: true });
    }
    if (result.kind === "rerunConfirmed") {
      return keep({ requested: requested.filter((r) => !same(result.run)(r)), done: [...done, result.run] });
    }
    if (result.kind === "rerunReconcile") {
      return keep({
        requested: requested.filter((r) => !result.confirmed.some((x) => same(x)(r))),
        done: [...done, ...result.confirmed],
      });
    }
    if (result.kind === "rerunDone" && s.active) {
      // The barrier for classification: these runs must show a newer attempt (review #5).
      s.active.rerun = [...done, ...(result.confirmed ?? []), ...op.runs];
      s.active.rerunAt = c.now;
      return finish("rerun requested");
    }
    if (result.kind === "opDropped" || result.kind === "targetMissing" || result.kind === "opAbandoned") {
      // Refund only if no request could ever have been sent (review: possibly-sent is irreversible).
      if (!op.everSent && done.length === 0 && requested.length === 0) refund(s, s.active?.lineage ?? 0, j.at);
      if (s.active && done.length > 0) {
        s.active.rerun = done;
        s.active.rerunAt = c.now;
      }
      if (result.kind !== "opDropped") pause(c, `batch ${s.active?.n ?? "?"}: ${result.reason}`);
      return finish(`rerun ${result.kind}: ${result.reason}`);
    }
  }

  if (op.kind === "cancel" && (result.kind === "targetMissing" || result.kind === "opAbandoned" || result.kind === "opDropped")) {
    if (result.kind !== "opDropped") pause(c, `cancel: ${result.reason}`);
    return finish(`cancel ${result.kind}`);
  }

  if (op.kind === "cancel" && result.kind === "cancelled" && s.active) {
    s.active.cancels.push(...op.runs.map((r) => ({ ...r, cause: op.cause })));
    return finish(`cancelled ${op.runs.length} run(s): ${op.cause}`);
  }

  if (op.kind === "land") {
    const a = s.active;
    if (result.kind === "landed" && a) {
      emit(c, {
        event: "landed",
        key: `landed:${a.n}:${op.after}`,
        batch: { ...hookBatch(a), head: op.after },
        prs: a.prs.filter((pr) => s.auth[String(pr)]).map((pr) => hookPr(c, pr, op.after)),
        details: { main: op.after, previousMain: op.before, rerun: a.rerun !== null },
      });
      carrySeenRed(s, a.prs, op.before, op.after, cfg, op.heads !== undefined);
      if (a.stack) s.squashed = [...new Set([...(s.squashed ?? []), ...a.stack.flatMap((x) => x.own)])].slice(-SQUASHED_MAX);
      countGreen(s, a, cfg);
      for (const pr of a.prs) {
        const auth = s.auth[String(pr)];
        if (!auth) continue;
        // Linear landing (DESIGN.md §7.4): the PR's branch now points at its stack commit, which is what main contains.
        const moved = op.heads?.find((h) => h.pr === pr);
        s.verify.push({ pr, pin: moved?.after ?? auth.head, landedIn: op.after, since: c.now, ticks: 0, notified: false, ...(moved ? { admitted: auth.head } : {}) });
        const waived = auth.waiver ? `\n\nLanded under a ${describeWaiver(auth.waiver)}. It ran the full pre-landing suite in a batch of its own.` : "";
        const as = moved ? `, squashed as \`${moved.after}\`, which its branch now points at` : "";
        if (!comments.omit.includes("landed")) comment(c, pr, `landed:${a.n}`, `Landed in ${cfg.names.main} at \`${op.after}\` (batch ${a.n}, pin \`${auth.head}\`${as}).${prioritised(auth)}${waived}`);
        delete s.auth[String(pr)];
      }
      record(c, { n: a.n, outcome: "landed", prs: a.prs, head: op.after, note: `main ${op.before} -> ${op.after}` });
      s.redStreak = 0;
      s.bounceStreak = 0;
      s.lastLandedAt = c.now;
      retire(c, a);
      return finish(`landed batch ${a.n}`);
    }
    if (result.kind === "landRejected") {
      if (!result.retry) pause(c, `landing batch ${a?.n ?? "?"} rejected: ${result.reason}`);
      return finish(`landing not applied: ${result.reason}`);
    }
    if (result.kind === "baseMoved") return finish("main moved before landing; the next tick rebuilds");
    // Linear (DESIGN.md §7.4): resent too often (maxOpTries), or no longer valid to resend: the next decision starts afresh.
    if (result.kind === "opAbandoned") {
      pause(c, `batch ${a?.n ?? "?"}: ${result.reason}`);
      return finish(`landing abandoned: ${result.reason}`);
    }
    if (result.kind === "opDropped") return finish(`landing not resent: ${result.reason}`);
    // Nothing moved: the next tick's revalidation sees the new head, drops that PR and rebuilds the rest (§5.3 rule 3).
    if (result.kind === "headMoved") return finish(`landing not applied: ${result.prs.map((p) => `#${p}`).join(" ")} moved since admission; the next tick drops ${result.prs.length > 1 ? "them" : "it"} and rebuilds the rest`);
  }

  throw new Error(`applyOpResult: ${result.kind} does not fit op ${op.kind}`);
}

/** The comment on a PR the build refused for carrying commits that landed squashed (DESIGN.md §7.4). */
function squashedNotice(pin: string, commit: string | undefined): string {
  if (!commit) return `Not queued: \`${pin}\` has more commits than this queue can check against what already landed squashed. Squash or rebase it into fewer, and re-add \`ready\`.`;
  return `Not queued: \`${pin}\` carries \`${commit}\`, which already landed squashed as part of another PR. A merge now would start from before that commit, so anything this PR undoes of it would silently not land. Rebase only this PR's own commits onto main, \`git rebase --onto origin/main ${commit} <branch>\`, and re-add \`ready\`.`;
}

export interface Observation {
  /** rerun/cancel: runs that no longer exist. */
  missingRuns?: number[];
  /** build: the queue ref's sha, or null when it does not exist. */
  queueHead?: string | null;
  /** build: the queue ref's name (`<queuePrefix><n>`), for the reason text. */
  queueRef?: string;
  /** build: the queue ref's chain is base plus the recorded survivors, in order. */
  queueChainMatches?: boolean;
  /** rerun: current run_attempt per run id. */
  attempts?: Record<string, number>;
  /** land: current main, and whether op.after is main or an ancestor of it. */
  main?: string;
  afterReachable?: boolean;
  /** land, linear (DESIGN.md §7.4): each PR branch's current commit (null: absent), by PR; read whenever the landing is not reachable. */
  heads?: Record<string, string | null>;
}

/**
 * `settleLand`: a linear landing that did not land and cannot simply be resent
 * (DESIGN.md §7.4). The runner settles the PR branches with one guarded write
 * before anything else; `stranded` names those read at their stack commits.
 */
export type Recovery = OpResult | { kind: "resumeBuild"; head: string } | { kind: "retryLand" } | { kind: "settleLand"; stranded: string };

/** Recovery results that only record effects that already happened (allowed while paused). */
export function isObservedOutcome(r: Recovery): boolean {
  return !(r.kind === "resumeBuild" || r.kind === "retryOp" || r.kind === "retryLand" || r.kind === "settleLand");
}

/**
 * What happened to the journalled op, judged by observation. A rerun request
 * that is not confirmed is never resent: it is reconciled until the deadline,
 * then it is a terminal outcome that pauses. `resumeBuild`
 * tells the runner to create queue/<n> at the recorded chain head and then
 * report `built`. A landing is recovered by ancestry, before any revalidation.
 */
export function interpretObservation(
  j: Journal,
  o: Observation,
  auth?: Record<string, Auth>,
  timing?: { now: Date; reconcileMinutes: number },
): Recovery {
  const op = j.op;
  switch (op.kind) {
    case "build": {
      const rec = j.checkpoint;
      if (!rec) {
        // No record, but a queue ref: someone pushed it (a raced runner). CI may have run, so it is not refundable.
        return o.queueHead != null
          ? { kind: "queueMismatch", head: o.queueHead, reason: `${o.queueRef ?? `batch ${op.n}'s queue ref`} exists but the build was never recorded` }
          : { kind: "buildAborted", reason: "stopped before the build was recorded" };
      }
      const problem = buildRecordProblem(op, rec, auth);
      if (problem) {
        return o.queueHead != null
          ? { kind: "queueMismatch", head: o.queueHead, reason: `build record rejected: ${problem}` }
          : { kind: "buildFailed", reason: `build record rejected: ${problem}` };
      }
      if (!rec.chainHead) return { kind: "empty" };
      if (o.queueHead == null) return { kind: "resumeBuild", head: rec.chainHead };
      if (o.queueHead === rec.chainHead && o.queueChainMatches === true) return { kind: "built", head: rec.chainHead };
      return { kind: "queueMismatch", head: o.queueHead, reason: `${o.queueRef ?? `batch ${op.n}'s queue ref`} exists but does not match the recorded build` };
    }
    case "rerun": {
      if (o.missingRuns && o.missingRuns.length > 0) return { kind: "targetMissing", reason: `run(s) ${o.missingRuns.join(", ")} no longer exist` };
      const moved = (r: { runId: number; attempt: number }) => (o.attempts?.[String(r.runId)] ?? 0) > r.attempt;
      const requested = op.requested ?? [];
      const confirmed = requested.filter(moved).map(({ runId, attempt }) => ({ runId, attempt }));
      const unconfirmed = requested.filter((r) => !moved(r));
      if (op.runs.length === 0 && unconfirmed.length === 0) return { kind: "rerunDone", confirmed };
      // An unconfirmed request is never resent. Past the deadline it is a terminal outcome that pauses.
      const now = timing?.now.getTime() ?? 0;
      const windowMs = (timing?.reconcileMinutes ?? 0) * 60_000;
      const overdue = unconfirmed.filter((r) => now - Date.parse(r.at) >= windowMs);
      if (timing && overdue.length > 0) {
        return { kind: "opAbandoned", reason: `rerun request for run(s) ${overdue.map((r) => r.runId).join(", ")} not confirmed within ${timing.reconcileMinutes} minutes` };
      }
      return { kind: "rerunReconcile", confirmed };
    }
    case "land":
      if (o.afterReachable === true) return { kind: "landed" };
      // Linear (DESIGN.md §7.4): every ref where the batch left it is resent, after revalidation, by the runner (retryLand). Anything else settles the branches first.
      if (op.heads) {
        if (o.main === op.before && op.heads.every((h) => o.heads?.[String(h.pr)] === h.before)) return { kind: "retryLand" };
        return { kind: "settleLand", stranded: op.heads.filter((h) => o.heads?.[String(h.pr)] === h.after).map((h) => `${h.ref} (#${h.pr}) at ${h.after}, admitted ${h.before}`).join(", ") };
      }
      if (o.main === op.before) return { kind: "landRejected", retry: true, reason: "not applied" };
      return { kind: "baseMoved" };
    case "cancel":
      return { kind: "retryOp" };
  }
}
