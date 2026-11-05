// The release job's state document (DESIGN.md §3.1, §3.2), held on its own
// protected branch, qlander-release-state, with its own lease. Pure: types, an
// empty state, and a strict parser.

import type { Receipt } from "./release";
import { checkEpochBranch, checkLease, type Lease } from "./state";
import type { StateCodec } from "./store";
import type { StateRepoApi } from "./github/api";
import { isSha } from "./validate";

/** The intent of `advance(R → C)`, persisted before the CAS (§3.2). */
export interface AdvanceJournal {
  seq: number;
  op: "advance";
  before: string;
  after: string;
  receipt: Receipt;
  at: string;
}

export type ReleaseHistoryOutcome = "advanced" | "not-applied" | "moved" | "rejected";

export interface ReleaseHistoryItem {
  at: string;
  outcome: ReleaseHistoryOutcome;
  from: string;
  to: string;
  note: string;
  receipt: Receipt | null;
}

export interface LastCheck {
  at: string;
  kind: "advance" | "none" | "alert";
  reason: string;
  release: string | null;
  main: string | null;
}

export interface ReleaseState {
  v: 1;
  lease: Lease | null;
  seq: number;
  journal: AdvanceJournal | null;
  /** A pause that must be applied (its issue opened). Pending counts as paused. */
  pausePending: { id: string; reason: string } | null;
  last: LastCheck | null;
  history: ReleaseHistoryItem[];
  /** As State.epochBranch: the branch the last holder fenced on; absent when it wrote without the fence. */
  epochBranch?: string;
}

export function emptyReleaseState(): ReleaseState {
  return { v: 1, lease: null, seq: 0, journal: null, pausePending: null, last: null, history: [] };
}

class Bad extends Error {}
const fail = (m: string): never => {
  throw new Bad(m);
};
const obj = (x: unknown, w: string, keys: string[]): Record<string, unknown> => {
  if (typeof x !== "object" || x === null || Array.isArray(x)) fail(`${w}: not an object`);
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(`${w}: unknown field ${k}`);
  for (const k of keys) if (!(k in o)) fail(`${w}: missing ${k}`);
  return o;
};
const str = (x: unknown, w: string): string => (typeof x === "string" ? x : fail(`${w}: not a string`));
const sha = (x: unknown, w: string): string => (isSha(x) ? x : fail(`${w}: not a sha`));
const int = (x: unknown, w: string): number => (Number.isSafeInteger(x) && (x as number) >= 0 ? (x as number) : fail(`${w}: not a non-negative integer`));
const time = (x: unknown, w: string): string => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? x : fail(`${w}: not a time`));
const oneOf = <T extends string>(x: unknown, w: string, vals: readonly T[]): T => (vals.includes(x as T) ? (x as T) : fail(`${w}: not one of ${vals.join(", ")}`));

function epochBranchOf(x: unknown): string {
  try {
    return checkEpochBranch(x);
  } catch (e) {
    return fail(e instanceof Error ? e.message.replace(/^state: /, "") : String(e));
  }
}

/** The shared lease check (owner, until, and the executor that holds it), as a release-state failure. */
function leaseOf(x: unknown): Lease {
  try {
    return checkLease(x);
  } catch (e) {
    return fail(e instanceof Error ? e.message.replace(/^state: /, "") : String(e));
  }
}

function receipt(x: unknown, w: string): Receipt {
  const o = obj(x, w, ["from", "to", "policyBlob", "proofRun", "evidence"]);
  if (!Array.isArray(o.evidence)) fail(`${w}.evidence: not an array`);
  return {
    from: sha(o.from, `${w}.from`),
    to: sha(o.to, `${w}.to`),
    policyBlob: sha(o.policyBlob, `${w}.policyBlob`),
    proofRun: o.proofRun === null ? null : int(o.proofRun, `${w}.proofRun`),
    evidence: (o.evidence as unknown[]).map((e, i) => {
      const ew = `${w}.evidence[${i}]`;
      if (typeof e !== "object" || e === null) fail(`${ew}: not an object`);
      const r = e as Record<string, unknown>;
      for (const k of Object.keys(r)) if (!["workflow", "branch", "run_id", "run_attempt"].includes(k)) fail(`${ew}: unknown field ${k}`);
      return {
        workflow: str(r.workflow, `${ew}.workflow`),
        branch: r.branch === null ? null : str(r.branch, `${ew}.branch`),
        run_id: r.run_id === null ? null : int(r.run_id, `${ew}.run_id`),
        ...(r.run_attempt === undefined ? {} : { run_attempt: int(r.run_attempt, `${ew}.run_attempt`) }),
      };
    }),
  };
}

/** Strict: unknown fields, wrong types, a bad sha or another version are refused. */
export function parseReleaseState(text: string): ReleaseState {
  try {
    const raw = JSON.parse(text);
    const optional = raw !== null && typeof raw === "object" && "epochBranch" in raw ? ["epochBranch"] : [];
    const o = obj(raw, "state", ["v", "lease", "seq", "journal", "pausePending", "last", "history", ...optional]);
    if (o.v !== 1) fail(`state: version ${String(o.v)} is not 1`);
    const lease = o.lease === null ? null : leaseOf(o.lease);
    const journal = o.journal === null ? null : (() => {
      const j = obj(o.journal, "journal", ["seq", "op", "before", "after", "receipt", "at"]);
      const out: AdvanceJournal = {
        seq: int(j.seq, "journal.seq"),
        op: oneOf(j.op, "journal.op", ["advance"] as const),
        before: sha(j.before, "journal.before"),
        after: sha(j.after, "journal.after"),
        receipt: receipt(j.receipt, "journal.receipt"),
        at: time(j.at, "journal.at"),
      };
      if (out.receipt.from !== out.before || out.receipt.to !== out.after) fail("journal: receipt does not match the op");
      return out;
    })();
    const pausePending = o.pausePending === null ? null : (() => {
      const p = obj(o.pausePending, "pausePending", ["id", "reason"]);
      return { id: str(p.id, "pausePending.id"), reason: str(p.reason, "pausePending.reason") };
    })();
    const last = o.last === null ? null : (() => {
      const l = obj(o.last, "last", ["at", "kind", "reason", "release", "main"]);
      return {
        at: time(l.at, "last.at"),
        kind: oneOf(l.kind, "last.kind", ["advance", "none", "alert"] as const),
        reason: str(l.reason, "last.reason"),
        release: l.release === null ? null : sha(l.release, "last.release"),
        main: l.main === null ? null : sha(l.main, "last.main"),
      };
    })();
    if (!Array.isArray(o.history)) fail("history: not an array");
    const history = (o.history as unknown[]).map((h, i) => {
      const x = obj(h, `history[${i}]`, ["at", "outcome", "from", "to", "note", "receipt"]);
      return {
        at: time(x.at, `history[${i}].at`),
        outcome: oneOf(x.outcome, `history[${i}].outcome`, ["advanced", "not-applied", "moved", "rejected"] as const),
        from: sha(x.from, `history[${i}].from`),
        to: sha(x.to, `history[${i}].to`),
        note: str(x.note, `history[${i}].note`),
        receipt: x.receipt === null ? null : receipt(x.receipt, `history[${i}].receipt`),
      };
    });
    const epochBranch = o.epochBranch === undefined ? {} : { epochBranch: epochBranchOf(o.epochBranch) };
    return { v: 1, lease, seq: int(o.seq, "seq"), journal, pausePending, last, history, ...epochBranch };
  } catch (e) {
    if (e instanceof Bad || e instanceof SyntaxError) throw new Error(`release state: ${e.message}`);
    throw e;
  }
}

export function renderReleaseState(s: ReleaseState): string {
  return `<!-- qlander-release-state -->\n\`\`\`json\n${JSON.stringify({ ...s, lease: null }, null, 1)}\n\`\`\``;
}

export const releaseCodec = (mirrorLabel: string): StateCodec<ReleaseState> => ({
  empty: emptyReleaseState,
  parse: parseReleaseState,
  /**
   * The ref is missing. If a mirror issue is open, the ref existed and was
   * lost: do not start from empty (that could forget an unreconciled
   * advance). An operator decides.
   */
  refuseInit: async (repo: StateRepoApi) => {
    const open = await repo.listOpenIssues(mirrorLabel);
    if (open.issues.length > 0) return `the release state branch is missing but release state issue #${open.issues[0]!.number} exists; refusing to initialise`;
    if (!open.complete) return "the release state branch is missing and the release state issues could not all be listed; refusing to initialise";
    return null;
  },
});
