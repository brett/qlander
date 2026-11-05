// Comparing a ruleset GitHub has with the one setup wants, and the body that
// fixes it. A ruleset is found by name. Setup only ever tightens: each wanted
// rule must be present and at least as strict as wanted, field by field
// (more required reviews, a `true` protection, extra required checks and
// other rules already on the ruleset are all kept). A field weaker than
// wanted is raised to it. Bypass actors are exact for Apps; on a landing
// ruleset individual people (break-glass users) already there are kept, and
// any broader actor (a role, a team, org admins) is removed.

import type { BypassActor, Ruleset, RulesetBody } from "./client";
import type { Role, Rule, RulesetSpec } from "./expected";

/** Deep equality on JSON values; arrays compare as sets (GitHub may reorder them). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const rest = [...b];
    for (const x of a) {
      const i = rest.findIndex((y) => jsonEqual(x, y));
      if (i < 0) return false;
      rest.splice(i, 1);
    }
    return true;
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** GitHub requires every one of these on a pull_request rule; absent ones are the weakest setting. */
const PULL_REQUEST_DEFAULTS: Record<string, unknown> = {
  required_approving_review_count: 0,
  dismiss_stale_reviews_on_push: false,
  require_code_owner_review: false,
  require_last_push_approval: false,
  required_review_thread_resolution: false,
};

/** Booleans that allow something, so false is the stricter value. */
const PERMISSIVE = new Set(["update_allows_fetch_and_merge", "do_not_enforce_on_create"]);

type Check = { context: string; integration_id?: number | null };

/** One wanted parameter against what GitHub has: the value to send (at least as strict as both), and whether `have` was weaker. */
function tighten(key: string, want: unknown, have: unknown): { value: unknown; weaker: boolean } {
  if (typeof want === "number") {
    const h = typeof have === "number" ? have : -Infinity;
    return { value: Math.max(want, h), weaker: h < want };
  }
  if (typeof want === "boolean") {
    // A protection is stricter when true; a permission (an allowance) is stricter when false.
    const allowance = PERMISSIVE.has(key);
    const h = have === true;
    if (allowance) return { value: want && h, weaker: !want && h };
    return { value: want || h, weaker: want && !h };
  }
  if (key === "required_status_checks" && Array.isArray(want)) {
    const h = Array.isArray(have) ? (have as Check[]) : [];
    const missing = (want as Check[]).filter((w) => !h.some((x) => x.context === w.context));
    return { value: [...h, ...missing], weaker: missing.length > 0 };
  }
  if (key === "allowed_merge_methods" && Array.isArray(want)) {
    // Fewer methods is stricter: keep what is already narrower than wanted.
    const h = Array.isArray(have) ? (have as string[]) : [];
    const ok = h.length > 0 && h.every((m) => (want as string[]).includes(m));
    return { value: ok ? h : want, weaker: !ok };
  }
  return { value: want, weaker: !jsonEqual(have, want) };
}

function ruleParams(want: Rule, got: Rule | undefined): { params: Record<string, unknown>; weaker: string[] } {
  const have = got?.parameters ?? {};
  const params: Record<string, unknown> = { ...(want.type === "pull_request" ? PULL_REQUEST_DEFAULTS : {}), ...have };
  const weaker: string[] = [];
  for (const [k, v] of Object.entries(want.parameters ?? {})) {
    const t = tighten(k, v, have[k]);
    params[k] = t.value;
    if (t.weaker) weaker.push(`rule ${want.type}: ${k} is ${JSON.stringify(have[k] ?? null)}, needs ${JSON.stringify(v)}`);
  }
  return { params, weaker };
}

const appActor = (id: number): BypassActor => ({ actor_id: id, actor_type: "Integration", bypass_mode: "always" });

/** Bypass actors kept from the live ruleset: individual people on a landing ruleset, nobody else. */
const keptActor = (spec: RulesetSpec, a: BypassActor) => spec.extraBypass === "keep" && a.actor_type === "User";

/** Every way `have` falls short of `spec`, one line each; empty when it matches. */
export function rulesetDiff(spec: RulesetSpec, have: Ruleset, appIds: Partial<Record<Role, number>>): string[] {
  const out: string[] = [];
  if (have.enforcement !== "active") out.push(`enforcement is ${have.enforcement}, not active`);
  if (have.target !== "branch") out.push(`target is ${have.target}, not branch`);
  const include = have.conditions?.ref_name?.include ?? [];
  if (!jsonEqual([...include].sort(), [...spec.include].sort())) out.push(`includes ${JSON.stringify(include)}, not ${JSON.stringify(spec.include)}`);
  const exclude = have.conditions?.ref_name?.exclude ?? [];
  if (exclude.length) out.push(`excludes ${JSON.stringify(exclude)}`);
  for (const want of spec.rules) {
    const got = have.rules.find((r) => r.type === want.type);
    if (!got) out.push(`rule ${want.type} is missing`);
    else out.push(...ruleParams(want, got).weaker);
  }
  const wantIds = spec.bypass.map((r) => appIds[r]);
  for (const [i, id] of wantIds.entries()) {
    if (!have.bypass_actors.some((a) => a.actor_type === "Integration" && a.actor_id === id && a.bypass_mode === "always")) out.push(`bypass actor missing: the ${spec.bypass[i]} App (${id ?? "unknown id"})`);
  }
  for (const a of have.bypass_actors) {
    if (a.actor_type === "Integration" && wantIds.includes(a.actor_id ?? -1)) continue;
    if (!keptActor(spec, a)) out.push(`unexpected bypass actor: ${a.actor_type} ${a.actor_id ?? ""}`.trim());
  }
  return out;
}

/** The body that makes a ruleset match `spec`, keeping whatever is stricter on `have`. */
export function rulesetBody(spec: RulesetSpec, have: Ruleset | null, appIds: Partial<Record<Role, number>>): RulesetBody {
  const rules: Rule[] = [];
  for (const want of spec.rules) {
    const { params } = ruleParams(want, have?.rules.find((r) => r.type === want.type));
    rules.push(Object.keys(params).length ? { type: want.type, parameters: params } : { type: want.type });
  }
  for (const r of have?.rules ?? []) if (!spec.rules.some((w) => w.type === r.type)) rules.push(r);
  const bypass = spec.bypass.map((r) => {
    const id = appIds[r];
    if (id === undefined) throw new Error(`the ${r} App's id is unknown`);
    return appActor(id);
  });
  for (const a of have?.bypass_actors ?? []) if (keptActor(spec, a)) bypass.push(a);
  return {
    name: spec.name,
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: spec.include, exclude: [] } },
    rules,
    bypass_actors: bypass,
  };
}
