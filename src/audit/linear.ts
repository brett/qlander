// T13 (docs/deployment.md §4.1, DESIGN.md §7.4): what linear landing needs
// from the target. Only with queue.landing.mode linear; no finding otherwise.
//
//   - author: author makes unsigned commits, so main must not require
//     signatures: a ruleset on main with required_signatures, or classic
//     protection's required signatures, FAILs. Rulesets' rules are readable
//     without admin; classic protection needs an admin token, and without one
//     that half is SKIPPED, never assumed off.
//   - The landing force-updates same-repo PR head branches: every ruleset
//     with a rule that refuses that (blockingRules, the list admission uses)
//     and covers such a branch must list the queue App as a bypass actor, by
//     App id, with bypass mode "always".
//     An open PR's branch proven blocked FAILs; a pattern that could cover a
//     future PR branch WARNs; an unreadable bypass list is SKIPPED (marked
//     inconclusive when the read failed), never a guess. Classic protection
//     on an open PR's branch that disallows force pushes FAILs. main,
//     release, the queue and build prefixes and the epoch branches are
//     never PR branches, so they are left out.

import type { LoadedConfig } from "../config/load";
import { epochBranchFor } from "../config/runner";
import { GitHubError } from "../github/http";
import { blockingRules, classicProtection } from "../force-update";
import { isForbiddenHeadRef, isGitBranchName } from "../validate";
import type { AppIdentity } from "./apps";
import { why } from "./repo-view";
import type { RulesetCtx } from "./ruleset-checks";
import { appliesTo, hasRule, type Ruleset } from "./rulesets";
import { type AuditGh, fail, type Finding, pass, skipped, unread, warn } from "./types";

const ID = "T13";

/** The queue App, by id, may always bypass this ruleset (a direct update, not only through a PR). */
const appBypasses = (r: Ruleset, app: AppIdentity | undefined) =>
  app?.id != null && (r.bypass_actors ?? []).some((a) => a.actor_type === "Integration" && a.actor_id === app.id && (a.bypass_mode === undefined || a.bypass_mode === "always"));

/** Branch names qlander itself uses, which are never a PR's head. */
function reserved(cfg: LoadedConfig): (b: string) => boolean {
  const N = cfg.config.names;
  const epochs = cfg.runner.epochFence ? [epochBranchFor(cfg.runner, "queue"), epochBranchFor(cfg.runner, "release")] : [];
  return (b) => isForbiddenHeadRef(N, b) || epochs.includes(b);
}

/**
 * Whether a ruleset's include patterns could cover a branch qlander does not
 * reserve: `~ALL`, or any `refs/heads/` pattern other than an exact reserved
 * name or a glob inside a reserved prefix. Over-inclusive on purpose: it only
 * decides a WARN.
 */
export function couldCoverPrBranches(r: Ruleset, isReserved: (b: string) => boolean, prefixes: string[], defaultBranch: string): boolean {
  for (const p of r.conditions?.ref_name?.include ?? []) {
    if (p === "~ALL") return true;
    if (p === "~DEFAULT_BRANCH") {
      if (!isReserved(defaultBranch)) return true;
      continue;
    }
    const name = p.replace(/^refs\/heads\//, "");
    const glob = name.search(/[*?[]/);
    if (glob < 0) {
      if (!isReserved(name)) return true;
      continue;
    }
    const fixed = name.slice(0, glob);
    if (!prefixes.some((x) => x !== "" && fixed.startsWith(x))) return true;
  }
  return false;
}

interface OpenPr {
  number: number;
  head: { ref: string; repo: { id: number } | null };
}

export async function t13(cfg: LoadedConfig, gh: AuditGh, repo: string, c: RulesetCtx | null, queueApp: AppIdentity | undefined, admin: boolean): Promise<Finding[]> {
  const landing = cfg.config.landing;
  // Merge mode moves no PR branch and makes no unsigned commit: nothing to check, and nothing printed.
  if (!landing) return [];
  const N = cfg.config.names;
  const out: Finding[] = [];
  const blocking = (r: Ruleset) => blockingRules(landing.author).filter((t) => hasRule(r, t));

  // --- unsigned commits by the PR's author
  if (landing.author === "author") {
    if (c) {
      const sig = c.rulesets.filter((r) => appliesTo(r, N.main, c.defaultBranch) && hasRule(r, "required_signatures"));
      if (sig.length) out.push(fail(ID, `queue.landing.author is author, whose commits are unsigned, but ${N.main} requires signed commits (${sig.map((r) => `"${r.name}"`).join(", ")})`, "use queue.landing.author: app, or remove required signatures from main"));
      else out.push(pass(ID, `${N.main}: no ruleset requires signed commits, as queue.landing.author: author needs`));
    } else out.push(skipped(ID, `${N.main}: whether a ruleset requires signed commits is unknown (the rulesets were not read)`));
    if (!admin) out.push(skipped(ID, `${N.main}: classic protection's required signatures not read (needs an admin token)`, "rerun with an admin token"));
    else {
      try {
        const r = await gh.get<{ enabled?: boolean }>(`repos/${repo}/branches/${encodeURIComponent(N.main)}/protection/required_signatures`);
        out.push(r.enabled === true ? fail(ID, `queue.landing.author is author, whose commits are unsigned, but ${N.main}'s classic protection requires signed commits`, "use queue.landing.author: app, or turn off required signatures") : pass(ID, `${N.main}: classic protection does not require signed commits`));
      } catch (e) {
        if (e instanceof GitHubError && e.kind === "not_found") out.push(pass(ID, `${N.main}: no classic protection requires signed commits`));
        else out.push(unread(skipped(ID, `${N.main}: classic protection's required signatures could not be read: ${why(e)}`), e));
      }
    }
  }

  // --- force updates of PR head branches
  const isReserved = reserved(cfg);
  let prs: string[] | null = null;
  try {
    const { items, truncated } = await gh.list<OpenPr>(`repos/${repo}/pulls`, { state: "open", base: N.main }, (p) => (Array.isArray(p) ? (p as OpenPr[]) : undefined));
    if (truncated) throw new Error("the open PR list was incomplete");
    prs = [...new Set(items.filter((p) => p.head.repo?.id === N.target.id && isGitBranchName(p.head.ref) && !isReserved(p.head.ref)).map((p) => p.head.ref))];
  } catch (e) {
    out.push(unread(skipped(ID, `open PRs could not be listed: ${why(e)}; only ruleset patterns are checked`), e));
  }
  if (!c) out.push(skipped(ID, "PR branch rulesets: the rulesets were not read"));
  else {
    const prefixes = [N.queuePrefix, N.buildPrefix, ...(cfg.runner.epochFence ? [cfg.runner.epochPrefix ?? ""] : [])];
    const relevant = c.rulesets.filter((r) => r.enforcement === "active" && (!r.target || r.target === "branch") && blocking(r).length > 0);
    let clean = true;
    for (const r of relevant) {
      const covered = (prs ?? []).filter((b) => appliesTo(r, b, c.defaultBranch));
      const future = couldCoverPrBranches(r, isReserved, prefixes, c.defaultBranch);
      if (!covered.length && !future) continue;
      const rules = blocking(r).join(" and ");
      if (!Array.isArray(r.bypass_actors) || !c.admin) {
        clean = false;
        out.push(skipped(ID, `ruleset "${r.name}" has ${rules} on ${covered.length ? `open PR branch(es) ${covered.join(", ")}` : "branches PRs could use"}; whether the queue App may bypass it needs an admin token`, "rerun with an admin token"));
        continue;
      }
      if (appBypasses(r, queueApp)) continue;
      clean = false;
      const fix = `add the queue App (${queueApp?.slug ?? "unknown"}) to "${r.name}" as a bypass actor with bypass mode "always", or exclude PR branches from it`;
      const f = covered.length
        ? fail(ID, `ruleset "${r.name}" has ${rules} on open PR branch(es) ${covered.join(", ")}, and the queue App may not bypass it: their linear landing would be refused`, fix)
        : warn(ID, `ruleset "${r.name}" has ${rules} on a pattern that could cover future PR branches, and the queue App may not bypass it`, fix, r.conditions?.ref_name?.include ?? []);
      out.push(queueApp?.unread ? { ...f, inconclusive: true } : f);
    }
    if (clean) out.push(pass(ID, `no ruleset blocks the queue App's force updates of PR branches${prs ? ` (${prs.length} open)` : ""}`));
  }

  // --- classic protection on open PR branches
  for (const b of prs ?? []) {
    try {
      const br = await gh.get<{ protected?: unknown; protection?: { enabled?: unknown } }>(`repos/${repo}/branches/${b.split("/").map(encodeURIComponent).join("/")}`);
      if (!classicProtection(br)) continue;
      if (!admin) {
        out.push(skipped(ID, `${b}: classic branch protection not read (needs an admin token)`, "rerun with an admin token"));
        continue;
      }
      const p = await gh.get<{ allow_force_pushes?: { enabled?: boolean } }>(`repos/${repo}/branches/${b.split("/").map(encodeURIComponent).join("/")}/protection`);
      if (p.allow_force_pushes?.enabled !== true) out.push(fail(ID, `${b}: classic branch protection does not allow force pushes, so its linear landing would be refused`, "allow force pushes for the queue App on that branch, or remove the protection"));
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") continue;
      out.push(unread(skipped(ID, `${b}: classic branch protection could not be read: ${why(e)}`), e));
    }
  }
  return out;
}

