// The shapes `qlander audit` works with (docs/deployment.md §4.2): one
// finding per check, and the read-only view of GitHub every check uses.

import { GitHubError } from "../github/http";
import { EXIT_INCONCLUSIVE } from "../operator";

export type AuditStatus = "PASS" | "WARN" | "FAIL" | "SKIPPED";

export interface Finding {
  /** The requirement: T1..T12 for the target (§4.1), C1..C7 for the control repo. */
  id: string;
  status: AuditStatus;
  /** What was checked and what was seen, in one line. */
  message: string;
  /** What to change, for anything but a PASS. */
  fix?: string;
  /** Supporting lines (a workflow line, an expression, a path). */
  details?: string[];
  /** A read failed for a reason other than the token's permissions, so this finding is not an answer. The status stays as it was. */
  inconclusive?: true;
}

/**
 * GitHub, read-only. The only verb is GET: the audit never writes, and the
 * real implementation (src/audit/reader.ts) cannot send anything else.
 * Errors are GitHubErrors (src/github/http.ts), so a check can tell a
 * missing object (not_found) from a token that may not read it (auth).
 */
export interface AuditGh {
  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  /** Every page of a list; `pick` takes the items out of one page. */
  list<T = unknown>(path: string, query: Record<string, string | number | undefined>, pick: (page: unknown) => T[] | undefined): Promise<{ items: T[]; truncated: boolean }>;
}

export const pass = (id: string, message: string, details?: string[]): Finding => ({ id, status: "PASS", message, ...(details?.length ? { details } : {}) });
export const warn = (id: string, message: string, fix: string, details?: string[]): Finding => ({ id, status: "WARN", message, fix, ...(details?.length ? { details } : {}) });
export const fail = (id: string, message: string, fix: string, details?: string[]): Finding => ({ id, status: "FAIL", message, fix, ...(details?.length ? { details } : {}) });
export const skipped = (id: string, message: string, fix?: string): Finding => ({ id, status: "SKIPPED", message, ...(fix ? { fix } : {}) });

/**
 * Whether an error means the read failed: a 5xx, a network failure, a rate
 * limit, a revoked token (401) or anything unexpected. A 404 is an answer, and
 * a 403 is the token's permissions, which the audit reports as designed.
 */
export const readFailed = (e: unknown): boolean => !(e instanceof GitHubError && (e.kind === "not_found" || (e.kind === "auth" && e.status !== 401)));

/** The finding, marked inconclusive when the error that produced it is a failed read. */
export const unread = (f: Finding, e: unknown): Finding => (readFailed(e) ? { ...f, inconclusive: true } : f);

/** 1 on any FAIL that is an answer; else 3 if a read failed; else 0. WARN and SKIPPED alone never fail. */
export function auditExitCode(findings: Finding[]): number {
  if (findings.some((f) => f.status === "FAIL" && !f.inconclusive)) return 1;
  return findings.some((f) => f.inconclusive) ? EXIT_INCONCLUSIVE : 0;
}

/** What `setup --step verify` stops on: a FAIL or a failed read. */
export const unsettled = (findings: Finding[]): number => findings.filter((f) => f.status === "FAIL" || f.inconclusive).length;

/** A WARN for a check an error stopped: marked inconclusive when the error is a failed read. */
export const couldNotCheck = (id: string, what: string, e: unknown): Finding =>
  unread(warn(id, `${what} could not be checked: ${e instanceof Error ? e.message : String(e)}`, "fix the cause and rerun; this requirement is unverified"), e);

/** Run one rule; an error it did not turn into a finding becomes a WARN, so the rest of the audit still runs. */
export async function guard(id: string, what: string, rule: () => Finding[] | Promise<Finding[]>): Promise<Finding[]> {
  try {
    return await rule();
  } catch (e) {
    return [couldNotCheck(id, what, e)];
  }
}
