// Input validators (DESIGN.md §11). Everything read from an event or the API
// passes through one of these before it is used. Branch names, ref prefixes
// and labels come from the config (Names); none is fixed here.

import type { Names, RepoName } from "./config";

export const SHA_RE = /^[0-9a-f]{40}$/;
/** A branch name as the config schema allows it: no leading, trailing or doubled separator, so never `..`. */
export const BRANCH_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(?:[./][A-Za-z0-9_][A-Za-z0-9_-]*)*$/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** `<prefix><n>` for a batch number n: exactly, never a path under it. */
const batchRe = (prefix: string) => new RegExp(`^${escapeRe(prefix)}[1-9][0-9]{0,8}$`);

export function isSha(x: unknown): x is string {
  return typeof x === "string" && SHA_RE.test(x);
}

/** The all-zero OID: GitHub reads it as "absent" (a zero after deletes, a zero before requires absence). */
export const ZERO_SHA = "0".repeat(40);

/** A sha that names a real object: never the zero OID. Use this for anything written. */
export function isRealSha(x: unknown): x is string {
  return isSha(x) && x !== ZERO_SHA;
}

export function assertSha(x: unknown, what: string): string {
  if (!isSha(x)) throw new Error(`${what}: not a 40-hex sha: ${JSON.stringify(x)}`);
  return x;
}

export function isPrNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 10_000_000;
}

export function parsePrNumber(x: unknown): number {
  const n = typeof x === "string" && /^[0-9]{1,8}$/.test(x) ? Number(x) : x;
  if (!isPrNumber(n)) throw new Error(`not a PR number: ${JSON.stringify(x)}`);
  return n;
}

/** Batch n's queue ref: `<queuePrefix><n>`, the commit CI tests. */
export function queueRef(names: Names, n: number): string {
  const ref = `${names.queuePrefix}${n}`;
  if (!batchRe(names.queuePrefix).test(ref)) throw new Error(`bad batch number ${n}`);
  return ref;
}

/** Batch n's build ref: `<buildPrefix><n>`, where the batch is merged together. */
export function buildRef(names: Names, n: number): string {
  const ref = `${names.buildPrefix}${n}`;
  if (!batchRe(names.buildPrefix).test(ref)) throw new Error(`bad batch number ${n}`);
  return ref;
}

export const isQueueRef = (names: Names, ref: string) => batchRe(names.queuePrefix).test(ref);
export const isBuildRef = (names: Names, ref: string) => batchRe(names.buildPrefix).test(ref);

/** The refs each App may write (DESIGN.md §11). */
export function isWritableRef(names: Names, ref: string, app: "queue" | "release"): boolean {
  if (app === "release") return ref === names.release;
  return ref === names.main || isQueueRef(names, ref) || isBuildRef(names, ref);
}

/** Every target branch qlander reads or writes: main, release and the batch refs. */
export const isQlanderBranch = (names: Names, ref: string) => ref === names.main || ref === names.release || isQueueRef(names, ref) || isBuildRef(names, ref);

/** Head branches that are never admitted (DESIGN.md §4.2). */
export function isForbiddenHeadRef(names: Names, ref: string): boolean {
  return ref === names.main || ref === names.release || ref.startsWith(names.queuePrefix) || ref.startsWith(names.buildPrefix);
}

export type CommandKind = "bounce" | "solo" | "unsolo" | "go";

export const COMMAND_KINDS: readonly CommandKind[] = ["bounce", "solo", "unsolo", "go"];

/**
 * Operator commands are labels on the target PR (DESIGN.md §10), never
 * workflow inputs: a label is durable, so no coalescing of pending runs can
 * lose one. Every tick reads them, applies them in label order, and removes
 * each label once its effect is persisted. Their names are queue.labels.
 */
export function commandLabels(names: Names): Record<CommandKind, string> {
  return { bounce: names.labels.bounce, solo: names.labels.solo, unsolo: names.labels.unsolo, go: names.labels.go };
}

export const isCommandLabel = (names: Names, label: string) => COMMAND_KINDS.some((k) => names.labels[k] === label);

/** One operator command as read from GitHub: the label's latest `labeled` event and whether its actor may command. */
export interface Command {
  kind: CommandKind;
  pr: number;
  label: string;
  /** The labeled event's id: the command's identity, for idempotency. */
  id: number;
  at: string;
  /** null: the label event has no readable actor (never authorized). */
  actor: string | null;
  /** The actor has write, maintain or admin on the target, checked when the command is consumed. */
  authorized: boolean;
}

/** What wakes a tick. It carries nothing: commands come from labels. */
export interface Wake {
  kind: "tick";
}

/**
 * Validate the triggering event. Only `schedule` and `workflow_dispatch` on
 * qlander's own repo are accepted; anything else is refused. A dispatch
 * only wakes the tick: it takes no inputs (an operator command is a PR label).
 */
export function parseEvent(
  eventName: string,
  payload: unknown,
  qlanderRepoId: number,
): Wake {
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    throw new Error(`refusing event ${JSON.stringify(eventName)}`);
  }
  const p = (payload ?? {}) as { repository?: { id?: unknown }; inputs?: Record<string, unknown> | null };
  if (p.repository?.id !== qlanderRepoId) {
    throw new Error(`event is not from the qlander repository (id ${String(p.repository?.id)})`);
  }
  if (p.inputs && Object.keys(p.inputs).length > 0) {
    throw new Error("a dispatch takes no inputs: operator commands are qlander:* labels on the target PR");
  }
  return { kind: "tick" };
}

/** The run id a `qualified` status points at, if it is a run of the target repo, or null (DESIGN.md §8). */
export function runIdFromTargetUrl(target: RepoName, url: string | null | undefined): number | null {
  const re = new RegExp(`^https://github\\.com/${escapeRe(target.owner)}/${escapeRe(target.name)}/actions/runs/([0-9]{1,15})$`);
  const m = url ? re.exec(url) : null;
  return m ? Number(m[1]) : null;
}
