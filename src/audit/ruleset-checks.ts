// The ruleset rules of `qlander audit` (docs/deployment.md §4.1 T8 and
// T10, DESIGN.md §13): the landing and integrity rulesets on a branch, and
// the rulesets that keep a set of refs to one App. Bypass lists are only
// visible to an admin token; without one those lines are SKIPPED, never a
// guessed PASS.

import type { AppIdentity } from "./apps";
import { actorLabel, appliesTo, hasRule, type Ruleset } from "./rulesets";
import { fail, type Finding, pass, skipped } from "./types";

export interface RulesetCtx {
  rulesets: Ruleset[];
  /** The token may read bypass lists. */
  admin: boolean;
  defaultBranch: string;
  /** App ids to slugs, for output. */
  appNames: Map<number, string>;
}

type Sev = typeof fail;

/** The App, as a bypass actor that may always bypass (not only through a pull request: the Apps move refs directly). */
const isApp = (a: { actor_type: string; actor_id: number | null; bypass_mode?: string }, app: AppIdentity | undefined) =>
  a.actor_type === "Integration" && app?.id != null && a.actor_id === app.id && (a.bypass_mode === undefined || a.bypass_mode === "always");

/** A finding about whether the App is a bypass actor is no answer when the App itself could not be read. */
const aboutApp = (f: Finding, app: AppIdentity | undefined): Finding => (app?.unread ? { ...f, inconclusive: true } : f);

/** The same, unless an actor that is no App at all is among them: that one is forbidden whichever App this is. */
const aboutActors = (f: Finding, app: AppIdentity | undefined, actors: { actor_type: string }[]): Finding => (actors.some((a) => a.actor_type !== "Integration") ? f : aboutApp(f, app));

/** One rule that must sit in a ruleset nobody can bypass. */
export function noBypassRule(id: string, label: string, ref: string, rule: string, c: RulesetCtx, sev: Sev = fail): Finding {
  const carrying = c.rulesets.filter((r) => appliesTo(r, ref, c.defaultBranch) && hasRule(r, rule));
  if (!carrying.length) return sev(id, `${label}: no active ruleset has ${rule}`, `add ${rule} to a ruleset on ${ref} with no bypass actors`);
  if (!c.admin) return skipped(id, `${label}: ${rule} is set (${carrying.map((r) => r.name).join(", ")}); whether nobody can bypass it needs an admin token`, "rerun with an admin token");
  const clean = carrying.find((r) => (r.bypass_actors ?? []).length === 0);
  return clean ? pass(id, `${label}: ${rule} in "${clean.name}", which nobody can bypass`) : sev(id, `${label}: ${rule} is only in rulesets with bypass actors (${carrying.map((r) => r.name).join(", ")})`, `move ${rule} to a ruleset with no bypass actors`);
}

/**
 * A landing ruleset (PR, plus restrict updates where only the App may move the
 * branch: `personMerges` is false; bypass: the App and humans) and an integrity
 * ruleset (signatures, no force push, no deletion; no bypass). With `personMerges`
 * (`release`, DESIGN.md §9) a person merges a green PR there, which restrict
 * updates would stop.
 */
export function branchRulesets(id: string, branch: string, app: AppIdentity | undefined, c: RulesetCtx, sev: Sev = fail, personMerges = false, integrity: string[] = ["required_signatures", "non_fast_forward", "deletion"]): Finding[] {
  const out: Finding[] = [];
  const role = app?.role ?? "queue";
  const landing = c.rulesets.filter((r) => appliesTo(r, branch, c.defaultBranch) && (personMerges || hasRule(r, "update")) && hasRule(r, "pull_request"));
  const does = personMerges ? "requires a PR" : "restricts updates and requires a PR";
  if (!landing.length) out.push(sev(id, personMerges ? `${branch}: no active ruleset requires a PR` : `${branch}: no active ruleset both restricts updates and requires a PR`, `add a landing ruleset on ${branch} (${personMerges ? "" : '"Restrict updates" and '}"Require a pull request"), bypass: the ${role} App and break-glass humans`));
  else if (!c.admin) out.push(skipped(id, `${branch}: landing ruleset ${landing.map((r) => `"${r.name}"`).join(", ")} exists; its bypass list needs an admin token`, "rerun with an admin token"));
  else
    for (const r of landing) {
      const bypass = r.bypass_actors ?? [];
      const others = bypass.filter((a) => a.actor_type !== "User" && !isApp(a, app));
      const hasApp = bypass.some((a) => isApp(a, app));
      if (!hasApp) out.push(aboutApp(sev(id, `${branch}: landing ruleset "${r.name}" does not list the ${role} App (${app?.slug ?? "unknown"}) as a bypass actor`, `add the ${role} App as a bypass actor`), app));
      if (others.length) out.push(aboutActors(sev(id, `${branch}: landing ruleset "${r.name}" has bypass actors other than the ${role} App and named users`, "remove them", others.map((a) => actorLabel(a, c.appNames))), app, others));
      if (hasApp && !others.length) out.push(pass(id, `${branch}: landing ruleset "${r.name}" ${does}; bypass: the ${role} App and ${bypass.filter((a) => a.actor_type === "User").length} named user(s)`));
    }
  for (const rule of integrity) out.push(noBypassRule(id, branch, branch, rule, c, sev));
  return out;
}

/** Refs only one App may write: `rules` restricted on each ref, and that App the only bypass actor. */
export function refsRuleset(id: string, label: string, refs: string[], app: AppIdentity | undefined, c: RulesetCtx, rules: string[] = ["creation", "update", "deletion"], sev: Sev = fail): Finding[] {
  const out: Finding[] = [];
  const role = app?.role ?? "?";
  for (const ref of refs) out.push(...oneRef(id, label, ref, ref, app, c, rules, sev, role));
  return out;
}

/**
 * Refs under a prefix, as the queue names them (`<prefix><n>`): a ruleset
 * must cover every one of these samples for the prefix to count as covered.
 */
export const prefixSamples = (prefix: string) => ["1", "2", "10", "99", "1234", "987654321"].map((n) => `${prefix}${n}`);

/** A prefix's refs only one App may write: every sample must pass; the first that does not is reported. */
export function prefixRuleset(id: string, label: string, prefix: string, app: AppIdentity | undefined, c: RulesetCtx, sev: Sev = fail): Finding[] {
  const role = app?.role ?? "?";
  for (const ref of prefixSamples(prefix)) {
    const f = oneRef(id, label, ref, ref, app, c, ["creation", "update", "deletion"], sev, role);
    if (f.some((x) => x.status !== "PASS")) return f;
  }
  return oneRef(id, label, prefixSamples(prefix)[0]!, `${prefix}<n>`, app, c, ["creation", "update", "deletion"], sev, role);
}

function oneRef(id: string, label: string, ref: string, shown: string, app: AppIdentity | undefined, c: RulesetCtx, rules: string[], sev: Sev, role: string): Finding[] {
  const on = c.rulesets.filter((r) => appliesTo(r, ref, c.defaultBranch));
  const missing = rules.filter((t) => !on.some((r) => hasRule(r, t)));
  if (missing.length) return [sev(id, `${label}: ${shown} has no ${missing.join(", ")} rule`, `add a ruleset on ${shown} with ${rules.join(", ")}, bypass: the ${role} App only`)];
  if (!c.admin) return [skipped(id, `${label}: ${shown} has ${rules.join(", ")}; the bypass list needs an admin token`, "rerun with an admin token")];
  const carrying = on.filter((r) => rules.some((t) => hasRule(r, t)));
  const bad = carrying.flatMap((r) => (r.bypass_actors ?? []).filter((a) => !isApp(a, app)).map((a) => `${r.name}: ${actorLabel(a, c.appNames)}${a.bypass_mode && a.bypass_mode !== "always" ? ` (${a.bypass_mode})` : ""}`));
  // The App must be able to create and move the refs. A ruleset that only forbids
  // deletion or force pushes, with no bypass at all, binds the App too, as intended.
  const appMissing = carrying.filter((r) => (hasRule(r, "creation") || hasRule(r, "update")) && !(r.bypass_actors ?? []).some((a) => isApp(a, app)));
  if (bad.length) return [aboutActors(sev(id, `${label}: ${shown} can be written by more than the ${role} App`, `leave the ${role} App (${app?.slug ?? "unknown"}) as the only bypass actor, with bypass mode "always"`, bad), app, carrying.flatMap((r) => (r.bypass_actors ?? []).filter((a) => !isApp(a, app))))];
  if (appMissing.length) return [aboutApp(sev(id, `${label}: the ${role} App (${app?.slug ?? "unknown"}) cannot always bypass ${appMissing.map((r) => `"${r.name}"`).join(", ")} on ${shown}`, `add the ${role} App as the bypass actor, bypass mode "always"`), app)];
  return [pass(id, `${label}: ${shown} has ${rules.join(", ")}; only the ${role} App bypasses them`)];
}

/**
 * What the landing rules require of a PR (DESIGN.md §13): on main, the
 * fast-lane check; on release, the full checks with strict up-to-date and
 * merge commits only.
 */
export function landingRequirements(id: string, branch: string, c: RulesetCtx, want: { contexts: string[]; strict: boolean; mergeOnly: boolean }, sev: Sev = fail): Finding[] {
  const on = c.rulesets.filter((r) => appliesTo(r, branch, c.defaultBranch));
  const checks = on.flatMap((r) => r.rules.filter((x) => x.type === "required_status_checks").map((x) => ({ r, p: x.parameters ?? {} })));
  const contexts = new Set(checks.flatMap(({ p }) => (Array.isArray(p.required_status_checks) ? (p.required_status_checks as { context?: string }[]).map((s) => s.context ?? "") : [])));
  const out: Finding[] = [];
  if (!checks.length) out.push(sev(id, `${branch}: no active ruleset requires status checks`, `require ${want.contexts.length ? want.contexts.map((x) => `"${x}"`).join(", ") : "the full suite's checks"} on ${branch}`));
  else {
    const missing = want.contexts.filter((x) => !contexts.has(x));
    out.push(missing.length ? sev(id, `${branch}: required status checks lack ${missing.map((x) => `"${x}"`).join(", ")}`, `add them to the ${branch} ruleset's required status checks`) : pass(id, `${branch}: requires status checks ${[...contexts].map((x) => `"${x}"`).join(", ")}`));
    if (want.strict)
      out.push(checks.some(({ p }) => p.strict_required_status_checks_policy === true) ? pass(id, `${branch}: status checks are strict (the branch must be up to date)`) : sev(id, `${branch}: status checks are not strict`, "require branches to be up to date before merging"));
  }
  if (want.mergeOnly) {
    const prs = on.flatMap((r) => r.rules.filter((x) => x.type === "pull_request").map((x) => x.parameters ?? {}));
    const ok = prs.some((p) => Array.isArray(p.allowed_merge_methods) && p.allowed_merge_methods.length === 1 && p.allowed_merge_methods[0] === "merge");
    out.push(ok ? pass(id, `${branch}: PRs merge with merge commits only`) : sev(id, `${branch}: PRs may merge other than by merge commit`, `allow only merge commits in the ${branch} ruleset's pull_request rule`));
  }
  return out;
}
