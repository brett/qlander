// verify-sandbox: the check lists, verdicts and summary (no network).
//
// Every check a phase makes is planned here, in order, with the outcome it
// expects. A phase passes only when every planned check ran exactly once (or
// was skipped where a skip is explicitly acceptable) and passed, and nothing
// unplanned was recorded.

import type { Names } from "../config";
import { GitHubError, isGraphqlInternal } from "../github/http";

export type Expected = "ok" | "refused";
export type Observed = "ok" | "refused" | "error" | "skipped";
export type Phase = "queue" | "release" | "cross" | "admin";
export const PHASES: readonly Phase[] = ["queue", "release", "cross", "admin"];

export interface Planned {
  id: string;
  title: string;
  expected: Expected;
}

export interface Check extends Planned {
  observed: Observed;
  pass: boolean;
  evidence: Record<string, unknown>;
}

/** The names a plan's titles use: the config's, plus the two epoch branches. */
export interface PlanNames {
  names: Names;
  epochQueue: string;
  epochRelease: string;
}

/** The rollout gate G1 (docs/getting-started.md, "Roll out"): the queue's real write path against target-like rulesets. */
function g1Plan({ names: n }: PlanNames): Planned[] {
  return [
    { id: "a1", title: "queue App creates the workflow-change PR head (blob, tree, commit, ref)", expected: "ok" },
    { id: "a2", title: "workflow-change PR head is verified (reason valid)", expected: "ok" },
    { id: "a3", title: "queue App creates the plain-file PR head (blob, tree, commit, ref)", expected: "ok" },
    { id: "a4", title: "plain-file PR head is verified (reason valid)", expected: "ok" },
    { id: "a5", title: `queue App opens the workflow-change PR to ${n.main}`, expected: "ok" },
    { id: "a6", title: `queue App opens the plain-file PR to ${n.main}`, expected: "ok" },
    { id: "b1", title: `queue App creates ${n.buildPrefix}<n> at ${n.main}`, expected: "ok" },
    { id: "b2", title: "POST /merges merges the workflow-change head (201)", expected: "ok" },
    { id: "b3", title: "first merge commit is verified (reason valid)", expected: "ok" },
    { id: "b4", title: "POST /merges merges the plain-file head (201)", expected: "ok" },
    { id: "b5", title: "second merge commit is verified (reason valid)", expected: "ok" },
    { id: "b6", title: `chain: first parents reach ${n.main}, second parents are the heads in order`, expected: "ok" },
    { id: "b7", title: `queue App creates ${n.queuePrefix}<n> at the chain head`, expected: "ok" },
    { id: "b8", title: `queue App deletes ${n.buildPrefix}<n>`, expected: "ok" },
    { id: "c1", title: `updateRefs fast-forwards ${n.main} to ${n.queuePrefix}<n> (beforeOid = ${n.main}, force false)`, expected: "ok" },
    { id: "c2", title: `updateRefs with a stale beforeOid is refused; ${n.main} does not move`, expected: "refused" },
    { id: "c3", title: `updateRefs to a non-fast-forward target is refused; ${n.main} does not move`, expected: "refused" },
    { id: "d1", title: "workflow-change PR is marked merged", expected: "ok" },
    { id: "d2", title: "plain-file PR is marked merged", expected: "ok" },
    { id: "f1", title: `queue App cannot create ${n.stateBranch}`, expected: "refused" },
    { id: "e1", title: `state App creates ${n.stateBranch}`, expected: "ok" },
    { id: "e2", title: `state App updates ${n.stateBranch} with updateRefs`, expected: "ok" },
    { id: "f3", title: `queue App cannot update ${n.stateBranch} with updateRefs`, expected: "refused" },
    { id: "f2", title: `queue App cannot create ${n.releaseStateBranch}`, expected: "refused" },
    { id: "e3", title: `state App creates ${n.releaseStateBranch}`, expected: "ok" },
    { id: "e4", title: `state App updates ${n.releaseStateBranch} with updateRefs`, expected: "ok" },
    { id: "f4", title: `queue App cannot update ${n.releaseStateBranch} with updateRefs`, expected: "refused" },
    { id: "f5", title: `state App cannot fast-forward ${n.main} with updateRefs`, expected: "refused" },
    { id: "f6", title: `state App cannot create ${n.queuePrefix}<m>`, expected: "refused" },
    { id: "g1", title: `queue App deletes ${n.queuePrefix}<n>`, expected: "ok" },
    { id: "g2", title: "queue App deletes the workflow-change PR branch", expected: "ok" },
    { id: "g3", title: "queue App deletes the plain-file PR branch", expected: "ok" },
  ];
}

/**
 * H1 checks 2 to 4 for one epoch branch and its owning App (docs/deployment.md
 * §3.4): advance, combined writes, the owner's own reset attempts, a stale
 * call, and no workflow run. `p` prefixes the ids.
 */
function ownerPlan(p: string, owner: string, epoch: string, writes: { combined: string[]; stale: string[] }): Planned[] {
  return [
    { id: `${p}1`, title: `${owner} advances ${epoch} to E1 (a root commit when it is absent), fast-forward`, expected: "ok" },
    { id: `${p}2`, title: `${owner} fast-forwards ${epoch} from E1 to E2`, expected: "ok" },
    ...writes.combined.map((w, i) => ({ id: `${p}${3 + i}`, title: `${owner} sends {${epoch} E2→E2, ${w}} in one updateRefs: it lands`, expected: "ok" as const })),
    ...[
      `${owner} resets ${epoch} to E1 with updateRefs force true`,
      `${owner} resets ${epoch} to E1 with PATCH git/refs force true`,
      `${owner} deletes ${epoch}`,
      `${owner} re-creates ${epoch} at E1 (only if the delete went through)`,
    ].map((title, i) => ({ id: `${p}${3 + writes.combined.length + i}`, title: `${title}: refused, ${epoch} stays at E2`, expected: "refused" as const })),
    ...writes.stale.map((w, i) => ({
      id: `${p}${7 + writes.combined.length + i}`,
      title: `${owner} sends the stale {${epoch} E1→E1, ${w}}: refused, nothing moves`,
      expected: "refused" as const,
    })),
  ];
}

/** Each phase's planned checks, in the order the phase makes them. */
export function plan(phase: Phase, pn: PlanNames): Planned[] {
  const n = pn.names;
  const scope = (id: string, who: string): Planned => ({ id, title: `the ${who} token reaches the sandbox repo and no other repo`, expected: "ok" });
  const noRuns = (id: string, epochs: string): Planned => ({ id, title: `no workflow run exists for any epoch commit (E1, E2) of ${epochs}`, expected: "ok" });
  switch (phase) {
    case "queue":
      return [
        scope("s1", "queue App"),
        scope("s2", "state App"),
        ...g1Plan(pn),
        ...ownerPlan("hq", "queue App", pn.epochQueue, {
          combined: [`create ${n.queuePrefix}<k>`, `${n.main} M→M'`, `delete ${n.queuePrefix}<k>`],
          stale: [`${n.main} M'→M''`, `create ${n.queuePrefix}<j>`],
        }),
        { id: "hq12", title: `state App resets ${pn.epochQueue} to E1 with updateRefs force true: refused, it stays at E2`, expected: "refused" },
        noRuns("hq13", pn.epochQueue),
      ];
    case "release":
      return [
        scope("s1", "release App"),
        ...ownerPlan("hr", "release App", pn.epochRelease, { combined: [`${n.release} R→R'`], stale: [`${n.release} R'→R''`] }),
        { id: "hr9", title: `release App (not the owner) resets ${pn.epochQueue} to its E1 with updateRefs force true: refused, it stays at E2`, expected: "refused" },
        { id: "hr10", title: `release App (not the owner) deletes ${pn.epochQueue}: refused, it stays at E2`, expected: "refused" },
        noRuns("hr11", pn.epochRelease),
      ];
    case "cross":
      return [
        scope("s1", "queue App"),
        { id: "hc1", title: `queue App (not the owner) resets ${pn.epochRelease} to its E1 with updateRefs force true: refused, it stays at E2`, expected: "refused" },
        { id: "hc2", title: `queue App (not the owner) resets ${pn.epochRelease} to its E1 with PATCH git/refs force true: refused, it stays at E2`, expected: "refused" },
        { id: "hc3", title: `queue App (not the owner) deletes ${pn.epochRelease}: refused, it stays at E2`, expected: "refused" },
      ];
    case "admin":
      return [
        { id: "ha0", title: "the token's user is an admin of the sandbox; rulesets: each epoch branch has an epoch-write ruleset whose only bypass is one App (a different App per branch), and an integrity ruleset with non-fast-forward and deletion and no bypass at all", expected: "ok" },
        ...([["haq", pn.epochQueue], ["har", pn.epochRelease]] as const).flatMap(([p, e]) =>
          [
            `admin resets ${e} to E1 with updateRefs force true`,
            `admin resets ${e} to E1 with PATCH git/refs force true`,
            `admin runs git push --force E1:${e}`,
            `admin deletes ${e}`,
            `admin re-creates ${e} at E1 (only if the delete went through)`,
          ].map((t, i) => ({ id: `${p}${i + 1}`, title: `${t}: refused, it stays at E2`, expected: "refused" as const })),
        ),
        noRuns("ha6", `${pn.epochQueue} and ${pn.epochRelease}`),
      ];
  }
}

/** A git push the remote rejected (as opposed to one that failed locally). */
export class PushRejected extends Error {}

/**
 * A refusal counts only when GitHub itself refused: a GitHubError carrying an
 * HTTP status (REST 4xx, or a GraphQL error on a 200), or a push the remote
 * rejected. A local validation error (status null), a network error or a 5xx
 * is not evidence of a refusal.
 */
export function isRemoteRefusal(e: unknown): boolean {
  if (e instanceof PushRejected) return true;
  return isGraphqlInternal(e) || (e instanceof GitHubError && e.status !== null && ["auth", "not_found", "conflict", "validation"].includes(e.kind));
}

export function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The verdict for one check: the observed outcome is the one expected and no
 * postcondition problem was found. A skip passes only when it is explicitly
 * acceptable.
 */
export function verdict(expected: Expected, observed: Observed, problems: readonly string[], skipAcceptable = false): boolean {
  if (observed === "skipped") return skipAcceptable && problems.length === 0;
  return observed === expected && problems.length === 0;
}

export interface Summary {
  ok: boolean;
  passed: number;
  failed: string[];
  notRun: string[];
  unexpected: string[];
  checks: Check[];
  /** Reads that lagged behind a write before showing it (src/sandbox/repo.ts). */
  lags?: { what: string; ms: number; reads: number }[];
}

/** The phase passes only when every planned check ran (or was acceptably skipped) and passed, exactly once, and nothing unplanned was recorded. */
export function summarize(checks: readonly Check[], planned: readonly { id: string }[]): Summary {
  const seen = new Set(checks.map((c) => c.id));
  const plannedIds = new Set(planned.map((p) => p.id));
  const ids = checks.map((c) => c.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  const unexpected = [...ids.filter((id) => !plannedIds.has(id)), ...dupes];
  const failed = checks.filter((c) => !c.pass).map((c) => c.id);
  const notRun = planned.map((p) => p.id).filter((id) => !seen.has(id));
  return {
    ok: failed.length === 0 && notRun.length === 0 && unexpected.length === 0,
    passed: checks.filter((c) => c.pass).length,
    failed,
    notRun,
    unexpected,
    checks: [...checks],
  };
}

/**
 * The batch numbers one run uses: queue (G1's queue/<n>), probe (the state
 * App's refused queue/<m>), epoch (the combined create) and stale (the
 * refused stale create). All fit the client's 9-digit batch pattern.
 */
export function refNumbers(runNumber: string | undefined, runAttempt: string | undefined, now = Date.now()): { queue: number; probe: number; epoch: number; stale: number } {
  const r = Number(runNumber);
  const a = Number(runAttempt ?? "1");
  const at = (queue: number) => ({ queue, probe: queue + 1, epoch: queue + 2, stale: queue + 3 });
  if (runNumber !== undefined && Number.isSafeInteger(r) && r >= 1 && r < 1_000_000 && Number.isSafeInteger(a) && a >= 1 && a < 25) return at(r * 100 + a * 4);
  // Outside Actions: time-based, at or above 1e8, above any run's (at most 99,999,996 + 3).
  return at(100_000_000 + (Math.floor(now / 1000) % 200_000_000) * 4);
}

/** Problems with a merge chain: merges[i] must have parents [previous, heads[i]], starting from base. */
export function chainProblems(base: string, heads: readonly string[], merges: readonly { sha: string; parents: readonly string[] }[]): string[] {
  const problems: string[] = [];
  if (merges.length !== heads.length) problems.push(`expected ${heads.length} merges, got ${merges.length}`);
  let prev = base;
  merges.forEach((m, i) => {
    const want = [prev, heads[i]];
    if (m.parents.length !== 2 || m.parents[0] !== want[0] || m.parents[1] !== want[1]) {
      problems.push(`merge ${i + 1} (${m.sha}) has parents ${JSON.stringify(m.parents)}, expected ${JSON.stringify(want)}`);
    }
    prev = m.sha;
  });
  return problems;
}

/** A commit's signature, as the runtime sign check (DESIGN.md §7.1 step 4) demands it. */
export function signatureProblems(c: { verified: boolean; reason: string }): string[] {
  return c.verified && c.reason === "valid" ? [] : [`verified=${c.verified}, reason=${c.reason}`];
}

/** Thrown to stop a phase and go straight to cleanup. */
export class Abort extends Error {}

type Post<T> = (v: T) => Promise<{ evidence?: Record<string, unknown>; problems?: string[] }>;

/** Records each check as PASS or FAIL with its evidence, as it happens. */
export class Recorder {
  readonly checks: Check[] = [];
  private readonly planned: Map<string, Planned>;

  constructor(
    planned: readonly Planned[],
    private readonly log: (line: string) => void = (l) => console.log(l),
  ) {
    this.planned = new Map(planned.map((p) => [p.id, p]));
  }

  private push(id: string, observed: Observed, problems: string[], evidence: Record<string, unknown>, skipAcceptable = false): boolean {
    const p = this.planned.get(id);
    if (!p) throw new Error(`unplanned check ${id}`);
    const pass = verdict(p.expected, observed, problems, skipAcceptable);
    const check: Check = { id, title: p.title, expected: p.expected, observed, pass, evidence: problems.length ? { ...evidence, problems } : evidence };
    this.checks.push(check);
    this.log(`${pass ? "PASS" : "FAIL"} ${id} ${p.title} [expected ${p.expected}, observed ${observed}] ${JSON.stringify(check.evidence)}`);
    return pass;
  }

  /** Run `act` and expect it to succeed; `post` observes afterwards. Returns the value, or undefined if the check failed. */
  async ok<T>(id: string, act: () => Promise<T>, post: Post<T> = async () => ({})): Promise<T | undefined> {
    let v: T;
    try {
      v = await act();
    } catch (e) {
      this.push(id, isRemoteRefusal(e) ? "refused" : "error", [], { error: describeError(e) });
      return undefined;
    }
    let seen: { evidence?: Record<string, unknown>; problems?: string[] };
    try {
      seen = await post(v);
    } catch (e) {
      seen = { problems: [`postcondition read failed: ${describeError(e)}`] };
    }
    return this.push(id, "ok", seen.problems ?? [], seen.evidence ?? {}) ? v : undefined;
  }

  /** Run `act` and expect GitHub to refuse it; `post` checks by observation that nothing moved. */
  async refused(id: string, act: () => Promise<unknown>, post: () => Promise<string[]>, evidence: Record<string, unknown> = {}): Promise<boolean> {
    let observed: Observed;
    let ev: Record<string, unknown>;
    try {
      const v = await act();
      observed = "ok";
      ev = { ...evidence, result: v ?? null };
    } catch (e) {
      observed = isRemoteRefusal(e) ? "refused" : "error";
      ev = { ...evidence, error: describeError(e), ...(e instanceof GitHubError ? { kind: e.kind, status: e.status } : {}) };
    }
    let problems: string[];
    try {
      problems = await post();
    } catch (e) {
      problems = [`postcondition read failed: ${describeError(e)}`];
    }
    return this.push(id, observed, problems, ev);
  }

  skip(id: string, reason: string, acceptable: boolean, evidence: Record<string, unknown> = {}): boolean {
    return this.push(id, "skipped", [], { ...evidence, reason }, acceptable);
  }

  /** A value the rest of the phase depends on: abort (to cleanup) when it is missing. */
  need<T>(v: T | undefined, what: string): T {
    if (v === undefined) throw new Abort(`cannot continue without ${what}`);
    return v;
  }
}
