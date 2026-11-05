// Repository rulesets, as the audit reads them (docs/deployment.md §4.1 T8,
// T10; §4.2 control checks). Pure helpers over the API's JSON plus one
// reader; nothing here writes.

import { type AuditGh, readFailed } from "./types";
import { fnmatchPattern } from "./workflow";

export interface BypassActor {
  actor_id: number | null;
  actor_type: string;
  bypass_mode?: string;
}

export interface Rule {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface Ruleset {
  id: number;
  name: string;
  target?: string;
  enforcement: string;
  source_type?: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  /** Absent when the token may not see it (bypass lists need admin). */
  bypass_actors?: BypassActor[];
  rules: Rule[];
}

/** Whether one ruleset ref pattern (`~DEFAULT_BRANCH`, `~ALL`, `refs/heads/<glob>`) matches `branch`. */
function refPatternMatches(p: string, branch: string, defaultBranch: string): boolean {
  if (p === "~ALL") return true;
  if (p === "~DEFAULT_BRANCH") return branch === defaultBranch;
  const ref = `refs/heads/${branch}`;
  return fnmatchPattern(p).test(ref);
}

/** Whether an active branch ruleset applies to `branch`. */
export function appliesTo(rs: Ruleset, branch: string, defaultBranch: string): boolean {
  if (rs.enforcement !== "active" || (rs.target && rs.target !== "branch")) return false;
  const inc = rs.conditions?.ref_name?.include ?? [];
  const exc = rs.conditions?.ref_name?.exclude ?? [];
  return inc.some((p) => refPatternMatches(p, branch, defaultBranch)) && !exc.some((p) => refPatternMatches(p, branch, defaultBranch));
}

export const hasRule = (rs: Ruleset, type: string): Rule | undefined => rs.rules.find((r) => r.type === type);

/** A bypass actor in words, for output. */
export function actorLabel(a: BypassActor, apps: Map<number, string>): string {
  if (a.actor_type === "Integration" && a.actor_id !== null) return `App ${apps.get(a.actor_id) ?? a.actor_id}`;
  if (a.actor_type === "OrganizationAdmin") return "organization admins";
  if (a.actor_type === "DeployKey") return "deploy keys";
  return `${a.actor_type} ${a.actor_id ?? ""}`.trim();
}

export type RulesetRead = { ok: true; rulesets: Ruleset[]; bypassVisible: boolean } | { ok: false; error: string; cause: unknown };

/**
 * Every ruleset that applies to the repo (its own and its organization's),
 * with rules and, when the token may see them, bypass lists.
 */
export async function readRulesets(gh: AuditGh, repo: string): Promise<RulesetRead> {
  try {
    const { items, truncated } = await gh.list<{ id: number; source_type?: string; source?: string }>(`repos/${repo}/rulesets`, { includes_parents: "true" }, (p) => (Array.isArray(p) ? p : undefined));
    if (truncated) throw new Error("the ruleset listing was incomplete");
    const rulesets: Ruleset[] = [];
    for (const { id, source_type, source } of items) {
      const r = await gh.get<Ruleset>(`repos/${repo}/rulesets/${id}`);
      if (source_type === "Organization" || r.source_type === "Organization") {
        // An organization's bypass list is the organization's to show: trust
        // it only from the org endpoint (org admins), never from the repo's.
        try {
          r.bypass_actors = (await gh.get<Ruleset>(`orgs/${source ?? repo.split("/")[0]}/rulesets/${id}`)).bypass_actors;
        } catch (e) {
          if (readFailed(e)) throw e; // not the token's permissions: the list is unread, not hidden
          delete r.bypass_actors;
        }
      }
      rulesets.push(r);
    }
    return { ok: true, rulesets, bypassVisible: rulesets.every((r) => Array.isArray(r.bypass_actors)) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), cause: e };
  }
}
