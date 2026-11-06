// Whether the queue App may force-update a PR's head branch (linear landing,
// DESIGN.md §7.4), judged at admission from what the App can read with the
// permissions it already has (Metadata and Contents read): the rules GitHub
// says apply to the branch, each ruleset's `current_user_can_bypass` for the
// App itself, and the branch's `protected` flag. Classic protection's
// settings need Administration read, which the queue App does not get, so a
// protected branch is `unknown`, and `unknown` is advisory only. A failed read
// is `unknown` too, never an error that stops the tick.

import type { TargetApi } from "./github/api";

export type ForceUpdate = { kind: "allowed" } | { kind: "denied"; rule: string } | { kind: "unknown"; why: string };

/** Rule types that refuse a forced update by anyone who cannot bypass them. */
export const BLOCKING_RULES = ["non_fast_forward", "update"] as const;

/** One ruleset's answer for the reading App, cached per snapshot. */
export type BypassRead = { name: string; bypass: string | null };

export async function forceUpdateOf(api: Pick<TargetApi, "branchRules" | "rulesetBypass" | "branchProtected">, branch: string, cache: Map<number, Promise<BypassRead>>): Promise<ForceUpdate> {
  try {
    const rules = (await api.branchRules(branch)).filter((r) => (BLOCKING_RULES as readonly string[]).includes(r.type));
    const unknown: string[] = [];
    for (const r of rules) {
      if (r.rulesetId === null) {
        unknown.push(`${r.type} from a ruleset GitHub did not name`);
        continue;
      }
      let read = cache.get(r.rulesetId);
      if (!read) cache.set(r.rulesetId, (read = api.rulesetBypass(r.rulesetId)));
      const { name, bypass } = await read;
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
