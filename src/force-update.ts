// Whether the queue App may force-update a PR's head branch (linear landing,
// DESIGN.md §7.4), judged at admission from what the App can read with the
// permissions it already has (Metadata and Contents read): the rules GitHub
// says apply to the branch, each ruleset's `current_user_can_bypass` for the
// App itself, and whether the branch has classic protection. Classic
// protection's settings need Administration read, which the queue App does not
// get, so such a branch is `unknown`, and `unknown` is advisory only. A failed
// read is `unknown` too, never an error that stops the tick.

import type { TargetApi } from "./github/api";

export type ForceUpdate = { kind: "allowed" } | { kind: "denied"; rule: string } | { kind: "unknown"; why: string };

/** Rules that stop any direct (non-PR) update of a branch by an actor that does not bypass them, fast-forward or not. */
export const BLOCKS_DIRECT_UPDATE = ["update", "pull_request", "required_status_checks", "required_deployments", "merge_queue", "workflows", "code_scanning"] as const;

/**
 * Rule types that refuse the landing's forced update of a PR branch by anyone
 * who cannot bypass them, for this commit author. The stack commit is new, so
 * no check, deployment or scan has reported on it. Seen refusing on GitHub:
 * non_fast_forward, update, pull_request, required_status_checks. From GitHub's
 * documentation: required_deployments, merge_queue, workflows, code_scanning,
 * and required_signatures for `author`'s unsigned commits.
 *
 * Not counted, because the landing meets them: creation and deletion (the
 * branch stays), required_linear_history (a stack commit has one parent) and
 * required_signatures for `app`'s signed commits. Not counted, because the
 * answer depends on the content: the *_pattern and file rules, which only a
 * real landing can judge; a refusal there is retried and then pauses as usual.
 */
export function blockingRules(author: "app" | "author" = "app"): readonly string[] {
  return ["non_fast_forward", ...BLOCKS_DIRECT_UPDATE, ...(author === "author" ? ["required_signatures"] : [])];
}

/**
 * `GET /branches/{b}` sets `protected` for a ruleset as well as for classic
 * protection; `protection.enabled` is true only for classic protection, and any
 * reader may see it. A protected branch without that field stays possibly classic.
 */
export const classicProtection = (b: { protected?: unknown; protection?: { enabled?: unknown } }) => b.protected === true && b.protection?.enabled !== false;

/** One ruleset's answer for the reading App, cached per snapshot. */
export type BypassRead = { name: string; bypass: string | null };

export async function forceUpdateOf(api: Pick<TargetApi, "branchRules" | "rulesetBypass" | "branchProtected">, branch: string, cache: Map<number, Promise<BypassRead>>, author: "app" | "author" = "app"): Promise<ForceUpdate> {
  try {
    const blocking = blockingRules(author);
    const rules = (await api.branchRules(branch)).filter((r) => blocking.includes(r.type));
    const unknown: string[] = [];
    for (const r of rules) {
      if (r.rulesetId === null) {
        unknown.push(`${r.type} from a ruleset GitHub did not name`);
        continue;
      }
      let read = cache.get(r.rulesetId);
      if (!read) cache.set(r.rulesetId, (read = api.rulesetBypass(r.rulesetId)));
      // Per ruleset: one unreadable answer must not hide a definite denial from another. Denied wins over unknown.
      let answer: BypassRead;
      try {
        answer = await read;
      } catch (e) {
        unknown.push(`${r.type} in ruleset ${r.rulesetId}: not readable (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      const { name, bypass } = answer;
      // "exempt": the ruleset does not apply to the App at all; "always": it may bypass a direct update.
      if (bypass === "always" || bypass === "exempt") continue;
      if (bypass === "never" || bypass === "pull_requests_only") return { kind: "denied", rule: `${r.type} in ruleset "${name}" (${r.rulesetId}), which the queue App ${bypass === "never" ? "cannot bypass" : "may bypass only through a pull request"}` };
      unknown.push(`${r.type} in ruleset "${name}" (${r.rulesetId}): whether the queue App may bypass it is not readable`);
    }
    if (unknown.length > 0) return { kind: "unknown", why: unknown.join("; ") };
    if (await api.branchProtected(branch)) return { kind: "unknown", why: `${branch} has classic branch protection, whose force-push setting the queue App cannot read` };
    return { kind: "allowed" };
  } catch (e) {
    return { kind: "unknown", why: `not readable (${e instanceof Error ? e.message : String(e)})` };
  }
}
