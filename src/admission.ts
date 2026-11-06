// Admission and revalidation of a target PR (DESIGN.md §4.2). Pure: the runner
// fetches the PR and evaluates the evidence adapters, then hands a LivePr here.

import type { AutomationTrust } from "./automation";
import type { Config } from "./config";
import type { Proof } from "./evidence";
import type { Auth, Waiver } from "./state";
import { isForbiddenHeadRef, isSha } from "./validate";

export interface LivePr {
  number: number;
  open: boolean;
  draft: boolean;
  merged: boolean;
  head: string;
  headRef: string;
  baseRef: string;
  baseRepoId: number;
  headRepoId: number | null;
  labels: string[];
  /** The latest `labeled` event for the ready label. */
  ready: { actorLogin: string; actorPermission: string; at: string } | null;
  mergeable: boolean | null;
  commitsVerified: boolean;
  policyPr: boolean;
  fastLane: Proof;
  review: Proof;
  /** A §4.3 approval comment naming exactly this head. */
  policyApproval: boolean;
  /** The PR author's login, for hook payloads only. */
  author?: string;
  /** The PR's title (untrusted), for the merge commit message only. Admission never reads it. */
  title?: string;
  /** Set when a configured trusted automation opened the PR (src/automation.ts); absent otherwise. */
  automation?: AutomationTrust;
  /**
   * The priority label (DESIGN.md §4.4), set only when it counts: its latest
   * `labeled` event is by a user with write access who is not a bot. Absent
   * otherwise. Ordering only: admission never reads it.
   */
  priority?: { actorLogin: string; at: string };
  /** Why a priority label on this PR does not count (for the log); absent when there is none or it counts. */
  priorityIgnored?: string;
  /** Why `ready` is null although the PR carries the label (for the tick's verdict only); admission never reads it. */
  readyUnreadable?: string;
}

export type Admission =
  | { ok: true }
  | { ok: false; kind: "ignore" | "wait" | "unready"; reason: string };

/** The wait reason of a policy PR that has everything but its §4.3 approval (emits approval_needed). */
export const NEEDS_APPROVAL = "CI-policy change needs a SHA-bound approval";

export const WRITERS = new Set(["write", "maintain", "admin"]);

export function admit(pr: LivePr, cfg: Config): Admission {
  const ignore = (reason: string): Admission => ({ ok: false, kind: "ignore", reason });
  const wait = (reason: string): Admission => ({ ok: false, kind: "wait", reason });
  const unready = (reason: string): Admission => ({ ok: false, kind: "unready", reason });

  if (!pr.open || pr.merged) return ignore("not open");
  if (pr.draft) return ignore("draft");
  const n = cfg.names;
  if (pr.baseRef !== n.main || pr.baseRepoId !== n.target.id) return ignore(`base is not ${n.target.name} ${n.main}`);
  if (pr.headRepoId !== n.target.id) return ignore(`head is not in ${n.target.name} (fork)`);
  if (isForbiddenHeadRef(n, pr.headRef)) return ignore(`head branch '${pr.headRef}' is reserved`);
  if (!isSha(pr.head)) return ignore("head is not a sha");
  if (!pr.labels.includes(n.labels.ready)) return ignore("not labelled ready");
  if (!pr.ready) return ignore("who applied ready is not readable");
  // The producer's own label counts only while producer-bound review is required.
  const byProducer = cfg.reviewRequired && cfg.reviewProducerLogins.includes(pr.ready.actorLogin);
  // A trusted automation's own label counts only while every trust condition holds for this head.
  const trusted = pr.automation?.ok === true ? pr.automation : null;
  const byAutomation = trusted !== null && pr.ready.actorLogin === trusted.login;
  if (!byProducer && !byAutomation && !WRITERS.has(pr.ready.actorPermission)) {
    const why = pr.automation && !pr.automation.ok && pr.ready.actorLogin === pr.automation.login ? ` (trusted automation: ${pr.automation.why})` : "";
    return ignore(`ready applied without write access${why}`);
  }
  if (pr.mergeable === null) return wait("mergeability not computed yet");
  if (pr.mergeable === false) return unready("conflicts with main");
  if (!pr.commitsVerified) return unready("has unsigned commits");
  if (!pr.fastLane.ok) return wait(`fast lane: ${pr.fastLane.why}`);
  if (!pr.review.ok) return wait(`review: ${pr.review.why}`);
  if (pr.policyPr && !pr.policyApproval && !trusted) {
    const why = pr.automation && !pr.automation.ok ? ` (trusted automation: ${pr.automation.why})` : "";
    return wait(`${NEEDS_APPROVAL}${why}`);
  }
  return { ok: true };
}

/**
 * The waiver an admission relies on, or null when today's rules admit it
 * alone. Recorded in the authorisation, so the PR runs alone and the landing
 * comment says which rule, which bot and which paths.
 */
export function waiverFor(pr: LivePr, cfg: Config): Waiver | null {
  const t = pr.automation;
  if (!t?.ok || !pr.ready) return null;
  const byProducer = cfg.reviewRequired && cfg.reviewProducerLogins.includes(pr.ready.actorLogin);
  const readyByBot = pr.ready.actorLogin === t.login && !byProducer && !WRITERS.has(pr.ready.actorPermission);
  const policyWaived = pr.policyPr && !pr.policyApproval;
  if (!readyByBot && !policyWaived) return null;
  return { rule: "trusted-automation", login: t.login, id: t.id, readyByBot, policyWaived, files: t.files, globs: t.globs };
}

export type Revalidation =
  | { ok: true }
  | { ok: false; hold: false; headMoved: boolean; reason: string }
  /**
   * Transient: GitHub has not computed mergeability against the current main
   * yet (null, as it is for a while after every landing). The admission stays,
   * but nothing may build or land on this PR until it is known. Callers that do
   * not handle it see `ok: false` and fail closed.
   */
  | { ok: false; hold: true; headMoved: false; reason: string };

/** Everything in admit(), plus: same head, same policy, same policy classification. */
export function revalidate(auth: Auth, pr: LivePr | undefined, cfg: Config, policyHash: string): Revalidation {
  if (!pr) return { ok: false, hold: false, headMoved: false, reason: "PR not readable" };
  if (pr.head !== auth.head) return { ok: false, hold: false, headMoved: true, reason: `head moved from ${auth.head} to ${pr.head}` };
  // Linear landing (DESIGN.md §7.4): the landing moves the branch recorded at admission, so it must still be the PR's head branch.
  if (auth.headRef !== undefined && pr.headRef !== auth.headRef) return { ok: false, hold: false, headMoved: true, reason: `head branch changed from ${auth.headRef} to ${pr.headRef}` };
  if (policyHash !== auth.policy) return { ok: false, hold: false, headMoved: true, reason: "qlander policy changed" };
  if (pr.policyPr !== auth.policyPr) return { ok: false, hold: false, headMoved: true, reason: "policy classification changed" };
  // Admitted under a trusted-automation waiver: it must still hold, for the same bot.
  if (auth.waiver && !(pr.automation?.ok === true && pr.automation.login === auth.waiver.login)) {
    return { ok: false, hold: false, headMoved: false, reason: `trusted-automation waiver no longer holds${pr.automation && !pr.automation.ok ? `: ${pr.automation.why}` : ""}` };
  }
  const a = admit(pr, cfg);
  // Only the mergeability wait is transient for an admitted PR; every other wait still drops it.
  // admit() stops at unknown mergeability, so check everything after it too: a hold must not mask a real failure.
  const hold = !a.ok && a.kind === "wait" && pr.mergeable === null ? a.reason : null;
  const rest = hold !== null ? admit({ ...pr, mergeable: true }, cfg) : a;
  if (!rest.ok) return { ok: false, hold: false, headMoved: false, reason: rest.reason };
  // Still admissible, but now only through a waiver it was not admitted (and batched) under: re-admit it.
  const now = waiverFor(pr, cfg);
  const was = auth.waiver;
  if (now && !(was && was.login === now.login && was.readyByBot === now.readyByBot && was.policyWaived === now.policyWaived)) {
    return { ok: false, hold: false, headMoved: false, reason: "now admissible only under a trusted-automation waiver it was not admitted with" };
  }
  return hold !== null ? { ok: false, hold: true, headMoved: false, reason: hold } : { ok: true };
}
