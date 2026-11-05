// Draining the outbox (DESIGN.md §3.2). Each notice is performed and then
// removed, or kept for another tick:
//
// - comment: delivery is recorded. Before posting, `sentAt` is persisted;
//   after posting, the returned comment id. If a run dies in between, the
//   delivery is ambiguous: the marker is looked for until the reconcile window
//   ends, and then the delivery is recorded as uncertain. A comment is sent at
//   most once; it is never reposted.
// - cancelRuns: runs can be published late, so cancellation keeps looking
//   until its window closes and every run it found is terminal. A 404 from
//   one run's cancel does not stop the others being cancelled; that run is
//   done only once a later read finds it terminal or gone.
// - pause: keyed to a stable id, so one failure opens one issue. The open
//   pause issues are listed twice before creating, and nothing is created
//   unless both listings were complete (src/github/issues.ts).
//
// - flaky: one issue per flaky test, labelled `flaky`, found by its key
//   marker (listed twice, created only when both listings were complete) and
//   updated by appending an occurrence line that carries its own marker, so a
//   retried notice never adds a line twice. Best effort: its failures never
//   pause and never hold up the notices behind it; it is dropped at giveUpAt.
//
// Failures are classified: absent targets are dropped, transient errors defer
// the notice, and anything else keeps it and raises a pause keyed to it.
// Errors that are not GitHub API errors (bugs, crashes) propagate.

import type { Names } from "./config";
import type { TargetApi, StateRepoApi } from "./github/api";
import { GitHubError, isGraphqlInternal } from "./github/http";
import { incompleteListing, listTwice } from "./github/issues";
import { appendOccurrence, FLAKY_LABEL, issueBody, issueTitle, keyMarker, occurrenceLine, occurrenceMarker, WRITE_BUDGET_MS } from "./flaky";
import type { Notice, State } from "./state";

export const marker = (id: string) => `<!-- qlander:${id} -->`;

/**
 * Best-effort notices: the wait comments (src/machine.ts waitNotice, ids
 * `c:<pr>:wait:...`). They are raised again on every tick while the PR waits,
 * so a failure to post one must never pause the queue or hold up the notices
 * behind it: a transient error leaves it for the next tick, and any other
 * GitHub error drops it.
 */
export const isBestEffort = (n: Notice): boolean => n.kind === "comment" && /^c:[0-9]+:wait:/.test(n.id);

export function isTransient(e: unknown): boolean {
  return e instanceof GitHubError && (e.kind === "server" || e.kind === "network" || e.kind === "rate_limit");
}

/**
 * Open an issue with this label unless one carrying the marker is open. The
 * listing is read twice, and the issue is created only when both reads were
 * complete and neither has it; otherwise a transient error is thrown, so a
 * pending notice stays pending (and a pending pause counts as paused).
 */
export async function openOnce(repo: StateRepoApi, label: string, id: string, title: string, body: string): Promise<void> {
  const m = marker(id);
  const seen = await listTwice(() => repo.listOpenIssues(label));
  if (seen.issues.some((i) => i.body.includes(m))) return;
  if (!seen.complete) throw incompleteListing(label);
  await repo.createIssue(title, `${body}\n\n${m}`, [label]);
}

/** Open a queue pause issue (queue.controlLabels.pause) unless one carrying the same marker is already open. */
export async function openPause(repo: StateRepoApi, names: Names, id: string, reason: string): Promise<void> {
  const title = `qlander paused: ${reason.replace(/\s+/g, " ").slice(0, 80)}`;
  await openOnce(repo, names.controlLabels.pause, id, title, `${reason}\n\nQlander builds, reruns and lands nothing while this issue is open. Close it to resume.`);
}

/**
 * Why this job is paused by an open issue with the label, or null if it is
 * not. Fails closed: a listing that is incomplete or cannot be read counts
 * as paused, never as unpaused.
 */
export async function pauseReason(repo: StateRepoApi, label: string): Promise<string | null> {
  let l: Awaited<ReturnType<StateRepoApi["listOpenIssues"]>>;
  try {
    l = await repo.listOpenIssues(label);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    return `the open ${label} issues could not be read (${e.message}); treating the job as paused`;
  }
  if (l.issues.length > 0) return `an open ${label} issue (#${l.issues[0]!.number})`;
  if (!l.complete) return `the open ${label} issues could not all be listed; treating the job as paused`;
  return null;
}

export interface DrainDeps {
  target: TargetApi;
  repo: StateRepoApi;
  names: Names;
  now: Date;
  reconcileMinutes: number;
  /** Persist the outbox as it stands (used before a comment is posted). */
  save: (outbox: Notice[]) => Promise<void>;
  /** Test hook, called after each performed notice. */
  afterEach?: () => void;
  /** Test hook: milliseconds now, for the flaky write budget (default Date.now). */
  clock?: () => number;
}

type Outcome = "done" | "again" | "uncertain" | "giveUp";

async function perform(n: Notice, d: DrainDeps, outbox: Notice[]): Promise<Outcome> {
  const { target, repo } = d;
  switch (n.kind) {
    case "comment": {
      if (n.commentId !== undefined) return "done";
      const m = marker(n.id);
      const found = (await target.listComments(n.pr)).find((c) => c.body.includes(m));
      if (found) return "done";
      if (n.sentAt) {
        // Sent once, receipt lost: never sent again. Wait for the list; after the
        // window the delivery is uncertain, which is cosmetic, so stop there.
        return d.now.getTime() - Date.parse(n.sentAt) < d.reconcileMinutes * 60_000 ? "again" : "uncertain";
      }
      // Record the attempt durably before sending it.
      const i = outbox.findIndex((x) => x.id === n.id);
      outbox[i] = { ...n, sentAt: d.now.toISOString() };
      await d.save(outbox);
      const id = await target.comment(n.pr, `${n.body}\n\n${m}`);
      outbox[i] = { ...n, sentAt: d.now.toISOString(), commentId: id };
      return "done";
    }
    case "unready":
      await target.removeLabel(n.pr, d.names.labels.ready);
      return "done";
    case "unlabel":
      await target.removeLabel(n.pr, n.label);
      return "done";
    case "pause":
      await openPause(repo, d.names, n.id, n.reason);
      return "done";
    case "cancelRuns": {
      // Every run ever seen is remembered and reconciled to a terminal state,
      // including ones a lagging list no longer shows.
      const listing = await target.listRuns({ headSha: n.head, branch: n.ref, event: "push" });
      const listed = listing.items.filter((r) => r.head_branch === n.ref && r.head_sha === n.head);
      const seen = [...new Set([...(n.seen ?? []), ...listed.map((r) => r.id)])];
      const i = outbox.findIndex((x) => x.id === n.id);
      if (seen.length !== (n.seen ?? []).length) {
        // Remember what was discovered before acting on it, so no failure can forget a run.
        outbox[i] = { ...n, seen };
        await d.save(outbox);
      }
      let running = 0;
      for (const id of seen) {
        const run = listed.find((r) => r.id === id) ?? (await target.getRun(id));
        if (!run || run.status === "completed") continue;
        running++;
        try {
          await target.cancelRun(id);
        } catch (e) {
          // A 404 for one run must not drop the others: keep cancelling them. The run
          // still counts as running until a later read finds it terminal or gone
          // (getRun is null), since a 404 alone does not prove it stopped.
          if (!(e instanceof GitHubError && e.kind === "not_found")) throw e;
        }
      }
      const now = d.now.getTime();
      // An incomplete listing may hide a running run: never "done" on it.
      if (running > 0 || listing.truncated) return now >= Date.parse(n.giveUpAt) ? "giveUp" : "again";
      if (now < Date.parse(n.until)) return "again";
      // A pushed queue ref always starts CI: having seen nothing yet means the
      // lists lag, not that there is nothing to cancel. Keep looking until giveUpAt.
      if (seen.length === 0 && now < Date.parse(n.giveUpAt)) return "again";
      return "done";
    }
    case "deleteRef":
      await target.deleteRef(n.ref);
      return "done";
    case "createRef":
      // It starts CI, so like a build it waits out a pause, and a listing that can't be read counts as one.
      if ((await pauseReason(repo, d.names.controlLabels.pause)) !== null) return "again";
      if ((await target.getRef(n.ref)) !== null) return "done"; // a receipt lost to a crash
      try {
        await target.createRef(n.ref, n.head);
      } catch (e) {
        // The ref exists, and that read lagged: the next tick sees it. Never a reason to pause.
        if (e instanceof GitHubError && e.kind === "conflict") return "again";
        throw e;
      }
      return "done";
    case "flaky":
      // Past its deadline it is dropped before anything is written.
      if (d.now.getTime() >= Date.parse(n.giveUpAt)) return "uncertain";
      return (await recordFlaky(repo, n, d, outbox)) ? "done" : "again";
  }
}

/**
 * Open or update the issue of every item not yet done. Idempotent by marker
 * (a retry adds no second line to an open issue), and each item's receipt is
 * saved as soon as it is written, so a retry never revisits it.
 */
async function recordFlaky(repo: StateRepoApi, n: Extract<Notice, { kind: "flaky" }>, d: DrainDeps, outbox: Notice[]): Promise<boolean> {
  // Bounded per tick (it runs before landing): what is left waits for the next tick.
  const started = (d.clock ?? Date.now)();
  const over = () => (d.clock ?? Date.now)() - started > WRITE_BUDGET_MS;
  const seen = await listTwice(() => repo.listOpenIssues(FLAKY_LABEL));
  const done = new Set(n.done ?? []);
  for (const item of n.items) {
    const id = `${item.byJob ? "job" : "test"}:${item.key}`;
    if (done.has(id)) continue;
    if (over()) return false;
    const line = occurrenceLine(item, n.n, n.at, n.runs);
    const issue = seen.issues.find((i) => i.body.includes(keyMarker(item)));
    if (issue) {
      if (!issue.body.includes(occurrenceMarker(n.n, item))) await repo.updateIssueBody(issue.number, appendOccurrence(issue.body, line));
    } else {
      if (!seen.complete) throw incompleteListing(FLAKY_LABEL);
      const body = issueBody(item, line);
      const number = await repo.createIssue(issueTitle(item), body, [FLAKY_LABEL]);
      seen.issues.push({ number, title: issueTitle(item), body });
    }
    done.add(id);
    const i = outbox.findIndex((x) => x.id === n.id);
    outbox[i] = { ...n, done: [...done] };
    await d.save(outbox);
  }
  return true;
}

export interface Drained {
  outbox: Notice[];
  log: string[];
  /** A notice failed for a non-transient reason: its stable id and why. */
  failure: { id: string; reason: string } | null;
  /** A notice was deferred on GitHub's generic GraphQL error, which the tick must count (src/queue.ts). */
  internalError?: GitHubError;
}

export async function drain(state: State, d: DrainDeps): Promise<Drained> {
  const log: string[] = [];
  const outbox: Notice[] = [...state.outbox];
  let failure: Drained["failure"] = null;
  let deferred = false;
  let internalError: GitHubError | undefined;
  for (const n of [...state.outbox]) {
    if (deferred && n.kind !== "pause") continue; // a pause never waits behind another notice
    const current = outbox.find((x) => x.id === n.id)!;
    try {
      const outcome = await perform(current, d, outbox);
      d.afterEach?.();
      if (outcome === "done" || outcome === "uncertain") {
        outbox.splice(outbox.findIndex((x) => x.id === n.id), 1);
        log.push(`${outcome === "done" ? "done" : "delivery uncertain, not resent:"} ${n.kind} ${n.id}`);
      } else if (outcome === "giveUp") {
        failure ??= { id: n.id, reason: `runs on ${n.kind === "cancelRuns" ? n.ref : n.id} are still running, or could not all be seen, after the cancellation window` };
        log.push(`gave up ${n.kind} ${n.id}`);
      } else log.push(`again ${n.kind} ${n.id}`);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      if (n.kind === "flaky") {
        // Bookkeeping only: never a pause, never a reason to defer other notices.
        if (d.now.getTime() >= Date.parse(n.giveUpAt) || !(isTransient(e) || e.kind === "auth")) {
          outbox.splice(outbox.findIndex((x) => x.id === n.id), 1);
          log.push(`dropped flaky ${n.id}: ${String(e)}`);
        } else log.push(`again flaky ${n.id}: ${String(e)}`);
        continue;
      }
      if (isBestEffort(n)) {
        if (!isTransient(e)) outbox.splice(outbox.findIndex((x) => x.id === n.id), 1);
        log.push(`${isTransient(e) ? "deferred" : "dropped"} best-effort ${n.kind} ${n.id}: ${String(e)}`);
      } else if (e.kind === "not_found" && n.kind !== "pause") {
        outbox.splice(outbox.findIndex((x) => x.id === n.id), 1);
        log.push(`dropped ${n.kind} ${n.id}: target is gone`);
      } else if (isTransient(e)) {
        log.push(`deferred ${n.kind} ${n.id}: ${String(e)}`);
        deferred = true;
        if (isGraphqlInternal(e)) internalError ??= e;
      } else {
        failure ??= { id: n.id, reason: `notice ${n.kind} ${n.id} failed: ${String(e)}` };
      }
    }
  }
  return { outbox, log, failure, ...(internalError ? { internalError } : {}) };
}
