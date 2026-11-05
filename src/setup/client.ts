// The GitHub calls `setup` makes. Three identities:
//   - the operator (an org owner's token, from GH_TOKEN or `gh auth token`):
//     reads Apps and installations, and writes the repos' settings;
//   - an App's JWT: GET /app (the registration, proving the key belongs to it)
//     and minting installation tokens;
//   - an installation token: what that token can reach.
// Environment secrets are encrypted with the repo's public key (a sealed box),
// which `gh secret set` does; the caller supplies that as `setSecret`.

import { GitHubError, Http, type HttpOptions } from "../github/http";
import type { Permissions, Repo, Rule } from "./expected";

export interface App {
  id: number;
  slug: string;
  clientId: string;
  owner: string;
  permissions: Permissions;
}

export interface Installation {
  id: number;
  appId: number;
  appSlug: string;
  account: string;
  selection: string;
  permissions: Permissions;
}

export interface Conversion extends App {
  pem: string;
}

export interface BypassActor {
  actor_id: number | null;
  actor_type: string;
  bypass_mode: string;
}

export interface Ruleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  rules: Rule[];
  bypass_actors: BypassActor[];
}

export type RulesetBody = Omit<Ruleset, "id">;

export interface MintedToken {
  token: string;
  permissions: Permissions;
  repositories: string[] | null;
}

interface RawApp {
  id: number;
  slug: string;
  client_id: string;
  owner: { login: string } | null;
  permissions: Permissions;
}

const toApp = (a: RawApp): App => ({ id: a.id, slug: a.slug, clientId: a.client_id, owner: a.owner?.login ?? "", permissions: a.permissions ?? {} });

interface RawInstallation {
  id: number;
  app_id: number;
  app_slug: string;
  account: { login: string } | null;
  repository_selection: string;
  permissions: Permissions;
}

const toInstallation = (i: RawInstallation): Installation => ({
  id: i.id,
  appId: i.app_id,
  appSlug: i.app_slug,
  account: i.account?.login ?? "",
  selection: i.repository_selection,
  permissions: i.permissions ?? {},
});

const enc = encodeURIComponent;
const repoPath = (r: Repo) => `repos/${enc(r.owner)}/${enc(r.name)}`;

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "not_found") return null;
    throw e;
  }
}

export type HttpBase = Omit<HttpOptions, "token">;

/** The operator's client. */
export class SetupApi {
  readonly http: Http;

  constructor(
    token: string,
    readonly base: HttpBase = {},
  ) {
    this.http = new Http({ readAttempts: 3, ...base, token });
  }

  /** A client for another identity (a JWT or an installation token) on the same host. */
  as(token: string): Http {
    return new Http({ readAttempts: 3, ...this.base, token });
  }

  // ---------------------------------------------------------------- Apps

  async app(slug: string): Promise<App | null> {
    const r = await orNull(this.http.request<RawApp>("GET", `apps/${enc(slug)}`));
    return r ? toApp(r.json) : null;
  }

  /** The App manifest flow's last step: the App's id, client id and private key. */
  async convertManifest(code: string): Promise<Conversion> {
    const r = await this.http.request<RawApp & { pem: string }>("POST", `app-manifests/${enc(code)}/conversions`);
    return { ...toApp(r.json), pem: r.json.pem };
  }

  /** The App as its own JWT sees it: proves the key belongs to the App. */
  async appByJwt(jwt: string): Promise<App> {
    return toApp((await this.as(jwt).request<RawApp>("GET", "app")).json);
  }

  async installationsByJwt(jwt: string): Promise<Installation[]> {
    const { items } = await this.as(jwt).paginate("app/installations", {}, (p) => (p as RawInstallation[]).map(toInstallation));
    return items;
  }

  /** Every App installation on an account the operator administers. */
  async orgInstallations(org: string): Promise<Installation[]> {
    const { items } = await this.http.paginate(`orgs/${enc(org)}/installations`, {}, (p) =>
      ((p as { installations?: RawInstallation[] }).installations ?? []).map(toInstallation),
    );
    return items;
  }

  /** An installation token; with an empty body, for every repo and permission the installation has. */
  async mintToken(jwt: string, installationId: number, body: { repositories?: string[]; permissions?: Permissions }): Promise<MintedToken> {
    const r = await this.as(jwt).request<{ token: string; permissions: Permissions; repositories?: { full_name: string }[] }>(
      "POST",
      `app/installations/${installationId}/access_tokens`,
      { body },
    );
    return { token: r.json.token, permissions: r.json.permissions ?? {}, repositories: r.json.repositories?.map((x) => x.full_name) ?? null };
  }

  async tokenRepos(token: string): Promise<string[]> {
    const { items } = await this.as(token).paginate("installation/repositories", {}, (p) =>
      ((p as { repositories?: { full_name: string }[] }).repositories ?? []).map((r) => r.full_name),
    );
    return items;
  }

  // ---------------------------------------------------------------- repos

  async repo(r: Repo): Promise<{ id: number; defaultBranch: string } | null> {
    const x = await orNull(this.http.request<{ id: number; default_branch: string }>("GET", repoPath(r)));
    return x ? { id: x.json.id, defaultBranch: x.json.default_branch } : null;
  }

  async branchSha(r: Repo, branch: string): Promise<string | null> {
    const x = await orNull(this.http.request<{ object: { sha: string } }>("GET", `${repoPath(r)}/git/ref/heads/${branch}`));
    return x?.json.object.sha ?? null;
  }

  async createRef(r: Repo, branch: string, sha: string, http: Http = this.http): Promise<void> {
    await http.request("POST", `${repoPath(r)}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } });
  }

  async deleteRef(r: Repo, branch: string): Promise<void> {
    await this.http.request("DELETE", `${repoPath(r)}/git/refs/heads/${branch}`);
  }

  async refReadable(r: Repo, branch: string, token: string): Promise<boolean> {
    try {
      await this.as(token).request("GET", `${repoPath(r)}/git/ref/heads/${branch}`);
      return true;
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return true; // readable, not created yet
      throw e;
    }
  }

  async branchRules(r: Repo, branch: string): Promise<string[]> {
    const x = await this.http.request<{ type: string }[]>("GET", `${repoPath(r)}/rules/branches/${branch}`);
    return x.json.map((y) => y.type);
  }

  async classicProtection(r: Repo, branch: string): Promise<boolean> {
    return (await orNull(this.http.request("GET", `${repoPath(r)}/branches/${branch}/protection`))) !== null;
  }

  // ---------------------------------------------------------------- environments and secrets

  async environment(r: Repo, name: string): Promise<{ protectedBranches: boolean; customBranchPolicies: boolean } | null> {
    const x = await orNull(
      this.http.request<{ deployment_branch_policy: { protected_branches: boolean; custom_branch_policies: boolean } | null }>("GET", `${repoPath(r)}/environments/${enc(name)}`),
    );
    if (!x) return null;
    const p = x.json.deployment_branch_policy;
    return { protectedBranches: p?.protected_branches ?? false, customBranchPolicies: p?.custom_branch_policies ?? false };
  }

  async putEnvironment(r: Repo, name: string): Promise<void> {
    await this.http.request("PUT", `${repoPath(r)}/environments/${enc(name)}`, {
      body: { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } },
    });
  }

  async branchPolicies(r: Repo, env: string): Promise<{ id: number; name: string; type: string }[]> {
    const { items } = await this.http.paginate(`${repoPath(r)}/environments/${enc(env)}/deployment-branch-policies`, {}, (p) =>
      ((p as { branch_policies?: { id: number; name: string; type?: string }[] }).branch_policies ?? []).map((b) => ({ id: b.id, name: b.name, type: b.type ?? "branch" })),
    );
    return items;
  }

  async addBranchPolicy(r: Repo, env: string, name: string): Promise<void> {
    await this.http.request("POST", `${repoPath(r)}/environments/${enc(env)}/deployment-branch-policies`, { body: { name, type: "branch" } });
  }

  async deleteBranchPolicy(r: Repo, env: string, id: number): Promise<void> {
    await this.http.request("DELETE", `${repoPath(r)}/environments/${enc(env)}/deployment-branch-policies/${id}`);
  }

  async environmentSecrets(r: Repo, env: string): Promise<string[]> {
    const { items } = await this.http.paginate(`${repoPath(r)}/environments/${enc(env)}/secrets`, {}, (p) =>
      ((p as { secrets?: { name: string }[] }).secrets ?? []).map((s) => s.name),
    );
    return items;
  }

  async repoSecretCount(r: Repo): Promise<number> {
    const x = await this.http.request<{ total_count: number }>("GET", `${repoPath(r)}/actions/secrets`, { query: { per_page: 1 } });
    return x.json.total_count;
  }

  // ---------------------------------------------------------------- labels and Actions settings

  async hasLabel(r: Repo, name: string): Promise<boolean> {
    return (await orNull(this.http.request("GET", `${repoPath(r)}/labels/${enc(name)}`))) !== null;
  }

  async createLabel(r: Repo, name: string): Promise<void> {
    await this.http.request("POST", `${repoPath(r)}/labels`, { body: { name, color: "ededed" } });
  }

  async workflowPermissions(r: Repo): Promise<{ default_workflow_permissions: string; can_approve_pull_request_reviews: boolean }> {
    return (await this.http.request<{ default_workflow_permissions: string; can_approve_pull_request_reviews: boolean }>("GET", `${repoPath(r)}/actions/permissions/workflow`)).json;
  }

  async putWorkflowPermissions(r: Repo, body: { default_workflow_permissions: string; can_approve_pull_request_reviews: boolean }): Promise<void> {
    await this.http.request("PUT", `${repoPath(r)}/actions/permissions/workflow`, { body });
  }

  // ---------------------------------------------------------------- rulesets

  async rulesets(r: Repo): Promise<{ id: number; name: string }[]> {
    // This repo's own rulesets only: an org ruleset of the same name is not ours to edit.
    const { items } = await this.http.paginate(`${repoPath(r)}/rulesets`, { includes_parents: "false" }, (p) => (p as { id: number; name: string }[]).map((x) => ({ id: x.id, name: x.name })));
    return items;
  }

  async ruleset(r: Repo, id: number): Promise<Ruleset> {
    return (await this.http.request<Ruleset>("GET", `${repoPath(r)}/rulesets/${id}`)).json;
  }

  async createRuleset(r: Repo, body: RulesetBody): Promise<void> {
    await this.http.request("POST", `${repoPath(r)}/rulesets`, { body });
  }

  async updateRuleset(r: Repo, id: number, body: RulesetBody): Promise<void> {
    await this.http.request("PUT", `${repoPath(r)}/rulesets/${id}`, { body });
  }
}
