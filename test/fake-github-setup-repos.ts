// The repo endpoints of the setup fake (test/fake-github-setup.ts):
// refs (with ruleset enforcement on creation), branch rules, environments,
// deployment-branch policies, environment secrets, labels, Actions settings
// and rulesets (GitHub refuses an App bypass actor that is not installed).

import { type FakeRepo, type FakeRuleset, type FakeSetupGitHub, HttpError, json } from "./fake-github-setup";

export function repoApi(f: FakeSetupGitHub, method: string, r: FakeRepo, rest: string, body: Record<string, unknown>, token: string): Response {
  const full = `${r.owner}/${r.name}`;
  const installToken = f.tokens.get(token);
  if (installToken) {
    // An installation token reaches only its repos; here it only reads refs.
    if (!installToken.repos.some((x) => x.toLowerCase() === full.toLowerCase())) throw new HttpError(404, "Not Found");
    if (method !== "GET" || !rest.startsWith("git/ref/heads/")) throw new HttpError(403, "Resource not accessible by integration");
  } else f.operatorOnly(token);
  let m: RegExpExecArray | null;
  if (rest === "" && method === "GET") return json(200, { id: r.id, full_name: full, default_branch: "main" });
  if ((m = /^git\/ref\/heads\/(.+)$/.exec(rest)) && method === "GET") {
    const sha = r.refs.get(m[1]!);
    if (!sha) throw new HttpError(404, "Not Found");
    return json(200, { ref: `refs/heads/${m[1]}`, object: { sha } });
  }
  if (rest === "git/refs" && method === "POST") {
    const ref = String(body.ref);
    const branch = ref.replace(/^refs\/heads\//, "");
    if (r.refs.has(branch)) throw new HttpError(422, "Reference already exists");
    // The operator is never a bypass actor here.
    if (f.enforceRulesets && f.activeRulesets(r, ref).some((s) => s.rules.some((x) => x.type === "creation"))) throw new HttpError(422, "Repository rule violations found\n\nCannot create ref due to creations being restricted.");
    r.refs.set(branch, String(body.sha));
    f.mutated(`${full}: create ref ${branch}`);
    return json(201, { ref, object: { sha: body.sha } });
  }
  if ((m = /^git\/refs\/heads\/(.+)$/.exec(rest)) && method === "DELETE") {
    if (!r.refs.delete(m[1]!)) throw new HttpError(422, "Reference does not exist");
    f.mutated(`${full}: delete ref ${m[1]}`);
    return json(204, undefined);
  }
  if ((m = /^rules\/branches\/(.+)$/.exec(rest)) && method === "GET") return json(200, f.activeRulesets(r, `refs/heads/${m[1]}`).flatMap((s) => s.rules.map((x) => ({ type: x.type, ruleset_source_type: "Repository", ruleset_source: full, ruleset_id: s.id }))));
  if ((m = /^branches\/(.+)\/protection$/.exec(rest)) && method === "GET") {
    if (!r.classicProtection.has(m[1]!)) throw new HttpError(404, "Branch not protected");
    return json(200, {});
  }
  if ((m = /^environments\/([^/]+)$/.exec(rest))) {
    const e = r.envs.get(m[1]!);
    if (method === "GET") {
      if (!e) throw new HttpError(404, "Not Found");
      return json(200, { name: m[1], deployment_branch_policy: e.protectedBranches || e.custom ? { protected_branches: e.protectedBranches, custom_branch_policies: e.custom } : null });
    }
    if (method === "PUT") {
      const p = body.deployment_branch_policy as { protected_branches: boolean; custom_branch_policies: boolean } | null;
      const env = e ?? { protectedBranches: false, custom: false, policies: [], secrets: new Map() };
      env.protectedBranches = p?.protected_branches ?? false;
      env.custom = p?.custom_branch_policies ?? false;
      r.envs.set(m[1]!, env);
      f.mutated(`${full}: put environment ${m[1]}`);
      return json(200, {});
    }
  }
  if ((m = /^environments\/([^/]+)\/deployment-branch-policies(?:\/(\d+))?$/.exec(rest))) {
    const e = r.envs.get(m[1]!);
    if (!e) throw new HttpError(404, "Not Found");
    if (method === "GET") return json(200, { total_count: e.policies.length, branch_policies: e.policies });
    if (!e.custom) throw new HttpError(404, "Not Found");
    if (method === "POST") {
      if (e.policies.some((p) => p.name === body.name && p.type === (body.type ?? "branch"))) throw new HttpError(422, "Validation Failed: already exists");
      e.policies.push({ id: ++f.seq, name: String(body.name), type: String(body.type ?? "branch") });
      f.mutated(`${full}: add deployment policy ${m[1]} ${body.name}`);
      return json(200, {});
    }
    if (method === "DELETE") {
      e.policies = e.policies.filter((p) => p.id !== Number(m![2]));
      f.mutated(`${full}: delete deployment policy ${m[1]} ${m[2]}`);
      return json(204, undefined);
    }
  }
  if ((m = /^environments\/([^/]+)\/secrets(?:\/([^/]+))?$/.exec(rest))) {
    const e = r.envs.get(m[1]!);
    if (!e) throw new HttpError(404, "Not Found");
    if (method === "GET" && !m[2]) return json(200, { total_count: e.secrets.size, secrets: [...e.secrets.keys()].map((name) => ({ name })) });
    if (method === "PUT" && m[2]) {
      f.setSecret(full, m[1]!, m[2], String(body.value));
      return json(201, {});
    }
  }
  if (rest === "actions/secrets" && method === "GET") return json(200, { total_count: r.repoSecrets, secrets: [] });
  if ((m = /^labels\/(.+)$/.exec(rest)) && method === "GET") {
    if (!r.labels.has(m[1]!)) throw new HttpError(404, "Not Found");
    return json(200, { name: m[1] });
  }
  if (rest === "labels" && method === "POST") {
    if (r.labels.has(String(body.name))) throw new HttpError(422, "Validation Failed: already_exists");
    r.labels.add(String(body.name));
    f.mutated(`${full}: create label ${body.name}`);
    return json(201, {});
  }
  if (rest === "actions/permissions/workflow") {
    if (method === "GET") return json(200, { default_workflow_permissions: "read", can_approve_pull_request_reviews: r.canApprove });
    if (method === "PUT") {
      r.canApprove = Boolean(body.can_approve_pull_request_reviews);
      f.mutated(`${full}: workflow permissions`);
      return json(204, undefined);
    }
  }
  if (rest === "rulesets" && method === "GET") return json(200, [...r.rulesets.values()].map((s) => ({ id: s.id, name: s.name })));
  if (rest === "rulesets" && method === "POST") {
    const s = checkRuleset(f, r, body, ++f.seq);
    r.rulesets.set(s.id, s);
    f.mutated(`${full}: create ruleset ${s.name}`);
    return json(201, s);
  }
  if ((m = /^rulesets\/(\d+)$/.exec(rest))) {
    const s = r.rulesets.get(Number(m[1]));
    if (!s) throw new HttpError(404, "Not Found");
    if (method === "GET") return json(200, structuredClone(s));
    if (method === "PUT") {
      const next = checkRuleset(f, r, body, s.id);
      r.rulesets.set(s.id, next);
      f.mutated(`${full}: update ruleset ${next.name}`);
      return json(200, next);
    }
  }
  throw new HttpError(404, `no fake route ${method} repos/${full}/${rest}`);
}

const PULL_REQUEST_REQUIRED = ["required_approving_review_count", "dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval", "required_review_thread_resolution"];

/**
 * As GitHub does: refuses an App as a bypass actor until the App is installed
 * on the repo, refuses a pull_request rule missing any required parameter,
 * and answers required checks with `integration_id: null` filled in.
 */
function checkRuleset(f: FakeSetupGitHub, r: FakeRepo, body: Record<string, unknown>, id: number): FakeRuleset {
  const s = { ...(structuredClone(body) as unknown as FakeRuleset), id };
  for (const rule of s.rules ?? []) {
    if (rule.type === "pull_request") {
      const missing = PULL_REQUEST_REQUIRED.filter((k) => rule.parameters?.[k] === undefined);
      if (missing.length) throw new HttpError(422, `Invalid request.\n\nNo subschema in "anyOf" matched: missing ${missing.join(", ")}`);
    }
    if (rule.type === "required_status_checks") {
      const p = rule.parameters as { required_status_checks: { context: string; integration_id?: number | null }[]; strict_required_status_checks_policy?: boolean };
      if (p.strict_required_status_checks_policy === undefined) throw new HttpError(422, "Invalid request: strict_required_status_checks_policy is required");
      p.required_status_checks = p.required_status_checks.map((c) => ({ integration_id: null, ...c }));
    }
  }
  for (const a of s.bypass_actors ?? []) {
    if (a.actor_type === "Integration" && !f.installedOn(a.actor_id ?? -1, r)) throw new HttpError(422, `Validation Failed: actor ${a.actor_id} must be an App installed on this repository`);
  }
  s.conditions.ref_name.exclude ??= [];
  return s;
}
