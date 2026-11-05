// An HTTP-level fake of the GitHub API that `setup` uses (src/setup/): Apps
// and the manifest flow, App JWTs (verified against the App's public keys),
// installations and their tokens, and (test/fake-github-setup-repos.ts) the
// repo endpoints: environments and secrets, labels, Actions settings,
// rulesets (enforced on ref creation) and refs. It answers a fetch() call
// in-process, or serves the same handler on a local port so that separate
// processes share one fake (the kill-and-resume test).
//
// What a person does in the browser (click Create, install an App, save or
// accept a permission change, generate a key) are plain methods here, never
// API calls, and are not counted as writes. `mutations` lists every API call
// that changed state, and `onMutation` runs after each one is applied and
// before it is answered: the kill-and-resume test kills the caller there.

import { createPublicKey, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { repoApi } from "./fake-github-setup-repos";

export type Perms = Record<string, string>;

export interface FakeApp {
  id: number;
  slug: string;
  name: string;
  clientId: string;
  owner: string;
  permissions: Perms;
  keys: KeyObject[];
}

export interface FakeInstallation {
  id: number;
  appId: number;
  account: string;
  selection: "selected" | "all";
  repos: string[];
  permissions: Perms;
}

export interface FakeEnv {
  protectedBranches: boolean;
  custom: boolean;
  policies: { id: number; name: string; type: string }[];
  secrets: Map<string, string>;
}

export interface FakeRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: { type: string; parameters?: Record<string, unknown> }[];
  bypass_actors: { actor_id: number | null; actor_type: string; bypass_mode: string }[];
}

export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  refs: Map<string, string>;
  envs: Map<string, FakeEnv>;
  repoSecrets: number;
  labels: Set<string>;
  canApprove: boolean;
  rulesets: Map<number, FakeRuleset>;
  classicProtection: Set<string>;
}

const pool: { pem: string; pub: KeyObject }[] = [];
let poolNext = 0;
/** RSA keys are slow to make, so every fake shares a small pool. */
export function keyPair(): { pem: string; pub: KeyObject } {
  if (pool.length < 6) {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    pool.push({ pem, pub: createPublicKey(pem) });
  }
  return pool[poolNext++ % pool.length]!;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A ruleset ref pattern against a full ref: `**` matches anything, `*` anything but `/`. */
export function refMatches(pattern: string, ref: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(ref);
}

export class FakeSetupGitHub {
  readonly operator = "operator-token";
  apps = new Map<string, FakeApp>();
  installations = new Map<number, FakeInstallation>();
  repos = new Map<string, FakeRepo>();
  tokens = new Map<string, { installation: number; perms: Perms; repos: string[] }>();
  codes = new Map<string, { org: string; manifest: { name: string; default_permissions: Perms } }>();
  /** Permissions GitHub silently drops when it creates an App. */
  dropOnCreate: string[] = [];
  /** False: rulesets are stored but not enforced on ref creation (a GitHub that does not do what the ruleset says). */
  enforceRulesets = true;
  mutations: string[] = [];
  onMutation: ((n: number, what: string) => void) | null = null;
  calls: string[] = [];
  seq = 100;

  addRepo(full: string, id: number): FakeRepo {
    const [owner, name] = full.split("/") as [string, string];
    const r: FakeRepo = { id, owner, name, refs: new Map([["main", "a".repeat(40)]]), envs: new Map(), repoSecrets: 0, labels: new Set(), canApprove: true, rulesets: new Map(), classicProtection: new Set() };
    this.repos.set(full.toLowerCase(), r);
    return r;
  }

  repo(full: string): FakeRepo {
    const r = this.repos.get(full.toLowerCase());
    if (!r) throw new Error(`no fake repo ${full}`);
    return r;
  }

  appById(id: number | null): FakeApp | undefined {
    return [...this.apps.values()].find((a) => a.id === id);
  }

  // ------------------------------------------------------------ what a person does

  /** The owner clicks "Create GitHub App" for a manifest: GitHub answers with a one-time code. */
  createFromManifest(org: string, manifest: { name: string; default_permissions: Perms }): string {
    const code = `code${++this.seq}`;
    this.codes.set(code, { org, manifest });
    return code;
  }

  /** A person fills in GitHub's form by hand or from a link, and clicks "Create GitHub App". No key yet. */
  createByHand(org: string, name: string, permissions: Perms): FakeApp {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const app: FakeApp = { id: ++this.seq, slug, name, clientId: `Iv1.${slug}.${this.seq}`, owner: org, permissions: { ...permissions }, keys: [] };
    this.apps.set(slug, app);
    this.mutated(`create app ${slug}`);
    return app;
  }

  /** "New key" under Credentials, Key pairs on the App's page. */
  generateKey(slug: string): string {
    const k = keyPair();
    this.apps.get(slug)!.keys.push(k.pub);
    return k.pem;
  }

  install(slug: string, account: string, repos: string[], selection: "selected" | "all" = "selected"): FakeInstallation {
    const app = this.apps.get(slug)!;
    const existing = [...this.installations.values()].find((i) => i.appId === app.id && i.account === account);
    if (existing) return Object.assign(existing, { repos, selection });
    const inst: FakeInstallation = { id: ++this.seq, appId: app.id, account, selection, repos, permissions: { ...app.permissions } };
    this.installations.set(inst.id, inst);
    return inst;
  }

  /** "Save changes" on the App's permissions page: installations keep the old set until accepted. */
  savePermissions(slug: string, permissions: Perms): void {
    this.apps.get(slug)!.permissions = { ...permissions };
  }

  accept(installationId: number): void {
    const inst = this.installations.get(installationId)!;
    inst.permissions = { ...this.appById(inst.appId)!.permissions };
  }

  /** Every App, installation, environment, secret name, label and ruleset: for comparing end states. */
  snapshot(): unknown {
    const apps = [...this.apps.values()].map((a) => ({ slug: a.slug, owner: a.owner, permissions: a.permissions })).sort((a, b) => a.slug.localeCompare(b.slug));
    const installations = [...this.installations.values()].map((i) => ({ app: this.appById(i.appId)!.slug, account: i.account, repos: i.repos })).sort((a, b) => a.app.localeCompare(b.app));
    const repos = [...this.repos.values()].map((r) => ({
      repo: `${r.owner}/${r.name}`,
      refs: [...r.refs.keys()].sort(),
      envs: [...r.envs.entries()]
        .map(([n, e]) => ({ n, policy: [e.protectedBranches, e.custom], branches: e.policies.map((p) => p.name).sort(), secrets: [...e.secrets.keys()].sort() }))
        .sort((a, b) => a.n.localeCompare(b.n)),
      labels: [...r.labels].sort(),
      canApprove: r.canApprove,
      rulesets: [...r.rulesets.values()]
        .map((s) => ({ ...s, id: 0, bypass_actors: s.bypass_actors.map((b) => ({ ...b, actor_id: this.appById(b.actor_id)?.slug ?? b.actor_id })) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }));
    return { apps, installations, repos };
  }

  // ------------------------------------------------------------ transport

  /** A fetch() for SetupApi's Http. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => this.handle(input instanceof Request ? input : new Request(String(input), init))) as typeof fetch;

  /** Serve on a local port, for child processes. */
  serve(): { url: string; stop(): void } {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => this.handle(req) });
    return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    this.calls.push(`${req.method} ${path}`);
    try {
      // The web form a manifest page posts to: the App is made once the owner clicks, then GitHub redirects with a code.
      const form = /^organizations\/([^/]+)\/settings\/apps\/new$/.exec(path);
      if (form && req.method === "POST") {
        const manifest = JSON.parse(new URLSearchParams(await req.text()).get("manifest") ?? "{}") as { name: string; default_permissions: Perms; redirect_url: string };
        const code = this.createFromManifest(form[1]!, manifest);
        return new Response(null, { status: 302, headers: { location: `${manifest.redirect_url}?code=${code}&state=${url.searchParams.get("state") ?? ""}` } });
      }
      const text = req.method === "GET" ? "" : await req.text();
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      return await this.api(req.method, path, body, req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { message: e.message });
      throw e;
    }
  }

  mutated(what: string): void {
    this.mutations.push(what);
    this.onMutation?.(this.mutations.length, what);
  }

  private appByJwt(token: string): FakeApp {
    const [h, p, s] = token.split(".");
    if (!h || !p || !s) throw new HttpError(401, "A JSON web token could not be decoded");
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; exp: number; iat: number };
    const app = [...this.apps.values()].find((a) => a.clientId === payload.iss);
    if (!app) throw new HttpError(401, "Integration not found");
    if (payload.exp * 1000 < Date.now() || payload.exp - payload.iat > 600) throw new HttpError(401, "'Expiration time' claim ('exp') is invalid");
    if (!app.keys.some((k) => verify("RSA-SHA256", Buffer.from(`${h}.${p}`), k, Buffer.from(s, "base64url")))) throw new HttpError(401, "A JSON web token could not be decoded");
    return app;
  }

  operatorOnly(token: string): void {
    if (token !== this.operator) throw new HttpError(401, "Bad credentials");
  }

  private appJson(a: FakeApp): unknown {
    return { id: a.id, slug: a.slug, name: a.name, client_id: a.clientId, owner: { login: a.owner }, permissions: a.permissions, events: [] };
  }

  private instJson(i: FakeInstallation): unknown {
    return { id: i.id, app_id: i.appId, app_slug: this.appById(i.appId)!.slug, account: { login: i.account }, repository_selection: i.selection, permissions: i.permissions };
  }

  installedOn(appId: number, repo: FakeRepo): boolean {
    const full = `${repo.owner}/${repo.name}`.toLowerCase();
    return [...this.installations.values()].some((i) => i.appId === appId && (i.selection === "all" ? i.account === repo.owner : i.repos.some((r) => r.toLowerCase() === full)));
  }

  private async api(method: string, path: string, body: Record<string, unknown>, token: string): Promise<Response> {
    let m: RegExpExecArray | null;
    if ((m = /^apps\/([^/]+)$/.exec(path)) && method === "GET") {
      const a = this.apps.get(m[1]!);
      if (!a) throw new HttpError(404, "Not Found");
      return json(200, this.appJson(a));
    }
    if ((m = /^app-manifests\/([^/]+)\/conversions$/.exec(path)) && method === "POST") {
      const c = this.codes.get(m[1]!);
      if (!c) throw new HttpError(404, "Not Found");
      this.codes.delete(m[1]!);
      const slug = c.manifest.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
      if (this.apps.has(slug)) throw new HttpError(422, "Name is already in use");
      const permissions = Object.fromEntries(Object.entries(c.manifest.default_permissions).filter(([k]) => !this.dropOnCreate.includes(k)));
      const k = keyPair();
      const app: FakeApp = { id: ++this.seq, slug, name: c.manifest.name, clientId: `Iv1.${slug}.${this.seq}`, owner: c.org, permissions, keys: [k.pub] };
      this.apps.set(slug, app);
      this.mutated(`create app ${slug}`);
      return json(201, { ...(this.appJson(app) as object), pem: k.pem });
    }
    if (path === "app" && method === "GET") return json(200, this.appJson(this.appByJwt(token)));
    if (path === "app/installations" && method === "GET") {
      const app = this.appByJwt(token);
      return json(200, [...this.installations.values()].filter((i) => i.appId === app.id).map((i) => this.instJson(i)));
    }
    if ((m = /^app\/installations\/(\d+)\/access_tokens$/.exec(path)) && method === "POST") {
      const app = this.appByJwt(token);
      const inst = this.installations.get(Number(m[1]));
      if (!inst || inst.appId !== app.id) throw new HttpError(404, "Not Found");
      const covered = inst.selection === "all" ? [...this.repos.values()].filter((r) => r.owner === inst.account).map((r) => `${r.owner}/${r.name}`) : inst.repos;
      const want = (body.repositories as string[] | undefined)?.map((r) => `${inst.account}/${r}`) ?? covered;
      for (const r of want) if (!covered.some((x) => x.toLowerCase() === r.toLowerCase())) throw new HttpError(422, "There is at least one repository that does not exist or is not accessible to the parent installation.");
      const perms = (body.permissions as Perms | undefined) ?? inst.permissions;
      for (const [k, v] of Object.entries(perms)) {
        const have = inst.permissions[k];
        if (!have || (v === "write" && have === "read")) throw new HttpError(422, "The permissions requested are not granted to this installation.");
      }
      const t = `ghs_${++this.seq}`;
      this.tokens.set(t, { installation: inst.id, perms, repos: want });
      // As GitHub does, the token always has metadata: read.
      return json(201, { token: t, permissions: { ...perms, metadata: "read" }, repositories: want.map((full_name) => ({ full_name })) });
    }
    if (path === "installation/repositories" && method === "GET") {
      const t = this.tokens.get(token);
      if (!t) throw new HttpError(401, "Bad credentials");
      return json(200, { total_count: t.repos.length, repositories: t.repos.map((full_name) => ({ full_name })) });
    }
    if ((m = /^orgs\/([^/]+)\/installations$/.exec(path)) && method === "GET") {
      this.operatorOnly(token);
      const list = [...this.installations.values()].filter((i) => i.account === m![1]);
      return json(200, { total_count: list.length, installations: list.map((i) => this.instJson(i)) });
    }
    if ((m = /^repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path))) {
      const r = this.repos.get(`${m[1]}/${m[2]}`.toLowerCase());
      if (!r) throw new HttpError(404, "Not Found");
      return repoApi(this, method, r, m[3] ?? "", body, token);
    }
    throw new HttpError(404, `no fake route ${method} ${path}`);
  }

  /** An environment secret (the fake takes the value in clear; the real API takes a sealed box that `gh` makes). */
  setSecret(repoFull: string, env: string, name: string, value: string): void {
    const e = this.repo(repoFull).envs.get(env);
    if (!e) throw new HttpError(404, "Not Found");
    e.secrets.set(name, value);
    this.mutated(`${repoFull}: set secret ${env}/${name}`);
  }

  activeRulesets(r: FakeRepo, ref: string): FakeRuleset[] {
    return [...r.rulesets.values()].filter((s) => s.enforcement === "active" && s.conditions.ref_name.include.some((p) => refMatches(p, ref)));
  }
}
