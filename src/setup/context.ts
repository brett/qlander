// What every `setup` step shares (docs/deployment.md §5): its dependencies,
// output, plan-or-apply writes, polling for a person's action, and the reads
// several steps make. Nothing here is kept between steps: every step reads
// the config, GitHub and the key store afresh, so each can be its own process.

import type { LoadedConfig } from "../config/load";
import { GitHubError } from "../github/http";
import type { App, Installation, SetupApi } from "./client";
import { type AppSpec, appSpecs, full, type Permissions, type Repo, type Role, type RulesetSpec } from "./expected";
import { appJwt } from "./jwt";
import type { AppRecord, KeyStore } from "./keys";
import { rulesetBody, rulesetDiff } from "./rulesets";

/** The App manifest (GitHub's "registering a GitHub App from a manifest"). */
export interface Manifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: false };
  redirect_url?: string;
  public: false;
  default_permissions: Permissions;
  default_events: string[];
}

export interface SetupDeps {
  config: LoadedConfig;
  api: SetupApi;
  /** null when neither --keys-dir nor --key-cmd was given. */
  keys: KeyStore | null;
  /** The App name prefix: Apps are `<prefix>-queue`, `<prefix>-release`, `<prefix>-state`. */
  prefix: string;
  apply: boolean;
  /** Replace the environment secrets even when they exist (a replaced key). */
  rotate: boolean;
  /** Also create the target's landing and integrity rulesets. */
  targetRulesets: boolean;
  /** The web host for printed links, e.g. https://github.com. */
  web: string;
  out(line: string): void;
  /** Store an environment secret (sealed-box encrypted, as `gh secret set` does). */
  setSecret(repo: Repo, env: string, name: string, value: string): Promise<void>;
  /** The App manifest flow up to the code GitHub redirects back with; null if `stop` ends it first. */
  manifestCode(spec: AppSpec, manifest: Manifest, stop: AbortSignal): Promise<string | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
  pollMs: number;
  waitMs: number;
  /** `audit` (docs/deployment.md §4.2), which verify runs last: its report lines, and how many findings failed or could not be read. Null when --skip-audit left it out. */
  audit(): Promise<{ lines: string[]; failed: number } | null>;
}

export class StepFailed extends Error {}

export class Ctx {
  readonly specs: AppSpec[];

  constructor(readonly d: SetupDeps) {
    this.specs = appSpecs(d.config, d.prefix);
  }

  ok(what: string): void {
    this.d.out(`ok    ${what}`);
  }

  todo(lines: string[]): void {
    lines.forEach((l, i) => this.d.out(i === 0 ? `todo  ${l}` : `        ${l}`));
  }

  fail(what: string): never {
    this.d.out(`FAIL  ${what}`);
    throw new StepFailed(what);
  }

  /** A change: made when applying, printed as planned otherwise. */
  async change(what: string, write: () => Promise<void>): Promise<void> {
    if (!this.d.apply) {
      this.d.out(`plan  ${what}`);
      return;
    }
    await write();
    this.d.out(`done  ${what}`);
  }

  /** Poll until `check` finds no problem, printing the problems whenever they change. False when the wait runs out. */
  async poll(what: string, check: () => Promise<string[]>): Promise<boolean> {
    const start = this.d.now();
    let last = "";
    for (;;) {
      const problems = await check();
      if (problems.length === 0) return true;
      const now = problems.join("; ");
      if (now !== last) this.d.out(`wait  ${what}: ${now}`);
      last = now;
      if (this.d.now() - start >= this.d.waitMs) return false;
      await this.d.sleep(this.d.pollMs);
    }
  }

  /** Note an App's public ids in apps.json (a convenience record; never read back as truth). */
  record(role: Role, r: Partial<AppRecord> & Pick<AppRecord, "slug">): void {
    const keys = this.d.keys;
    if (!keys || !this.d.apply) return;
    const apps = keys.apps();
    apps[role] = { ...apps[role], ...r } as AppRecord;
    keys.saveApps(apps);
  }

  appUrl(spec: AppSpec, page = ""): string {
    return `${this.d.web}/organizations/${spec.owner}/settings/apps/${spec.slug}${page}`;
  }

  installationUrl(spec: AppSpec, id: number): string {
    return `${this.d.web}/organizations/${spec.owner}/settings/installations/${id}`;
  }

  spec(role: Role): AppSpec | undefined {
    return this.specs.find((s) => s.role === role);
  }

  /** The App, which must exist. */
  async existing(spec: AppSpec): Promise<App> {
    const app = await this.d.api.app(spec.slug);
    if (!app) this.fail(`the ${spec.role} App ${spec.slug} does not exist: run setup --step apps`);
    return app;
  }

  key(spec: AppSpec): string {
    if (!this.d.keys) this.fail(`the ${spec.slug} key is needed: pass --keys-dir <dir> or --key-cmd <command>`);
    const pem = this.d.keys.read(spec.slug);
    if (!pem) this.fail(`no private key for ${spec.slug} in ${this.d.keys.describe}: run setup --step apps`);
    return pem;
  }

  /** The App as its key sees it (GET /app); refuses a key that is not this App's. */
  async byKey(spec: AppSpec, app: App, pem: string): Promise<App> {
    let seen: App;
    try {
      seen = await this.d.api.appByJwt(appJwt(app.clientId, pem, this.d.now()));
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "auth") this.fail(`the key for ${spec.slug} in ${this.d.keys?.describe} is not one of its keys (GET /app refused it)`);
      throw e;
    }
    if (seen.id !== app.id) this.fail(`the key for ${spec.slug} belongs to App ${seen.id}, not ${app.id}`);
    return seen;
  }

  async installation(spec: AppSpec, app: App): Promise<Installation | null> {
    return (await this.d.api.orgInstallations(spec.owner)).find((i) => i.appId === app.id) ?? null;
  }

  /**
   * Why an App's installation is not exactly its one repo; empty when it is.
   * The repos are listed with the App's own key (an installation token):
   * GitHub lists an installation's repos to an App, or to a user token that
   * an App issued, not to the operator's own token.
   */
  async installProblems(spec: AppSpec, app: App): Promise<{ problems: string[]; inst: Installation | null }> {
    const inst = await this.installation(spec, app);
    if (!inst) return { problems: [`not installed on ${spec.owner}`], inst };
    const problems: string[] = [];
    if (inst.selection !== "selected") problems.push(`installed on ${inst.selection} repositories, not selected ones`);
    const pem = this.key(spec);
    const { token } = await this.d.api.mintToken(appJwt(app.clientId, pem, this.d.now()), inst.id, {});
    const repos = (await this.d.api.tokenRepos(token)).map((r) => r.toLowerCase()).sort();
    const want = full(spec.repo).toLowerCase();
    if (repos.length !== 1 || repos[0] !== want) problems.push(`covers [${repos.join(", ")}], not [${want}] alone`);
    return { problems, inst };
  }

  /**
   * Refuse unless each role's App is installed on exactly its repo: GitHub
   * accepts an App as a ruleset bypass actor only once it is installed on
   * that repo. Returns the App ids, for the bypass lists.
   */
  async requireInstalled(roles: Role[], why: string): Promise<Partial<Record<Role, number>>> {
    const ids: Partial<Record<Role, number>> = {};
    for (const role of [...new Set(roles)]) {
      const spec = this.spec(role);
      if (!spec) continue;
      const app = await this.d.api.app(spec.slug);
      if (!app) this.fail(`refusing ${why}: the ${role} App ${spec.slug} does not exist yet; run setup --step apps, then --step install`);
      const { problems } = await this.installProblems(spec, app);
      if (problems.length) this.fail(`refusing ${why}: the ${role} App ${spec.slug} is not installed on ${full(spec.repo)} alone (${problems.join("; ")}); run setup --step install first`);
      ids[role] = app.id;
    }
    return ids;
  }

  async checkRepo(repo: Repo, id: number): Promise<void> {
    const r = await this.d.api.repo(repo);
    if (!r) this.fail(`${full(repo)} is not visible to the operator's token`);
    if (r.id !== id) this.fail(`${full(repo)} has id ${r.id}, but the config says ${id}`);
  }

  async labels(repo: Repo, names: string[]): Promise<void> {
    for (const l of names) {
      if (await this.d.api.hasLabel(repo, l)) this.ok(`${full(repo)}: label ${l}`);
      else await this.change(`${full(repo)}: create the label ${l}`, () => this.d.api.createLabel(repo, l));
    }
  }

  async ensureRuleset(spec: RulesetSpec, appIds: Partial<Record<Role, number>>): Promise<void> {
    const where = `${full(spec.repo)}: ruleset ${spec.name}`;
    const found = (await this.d.api.rulesets(spec.repo)).filter((r) => r.name === spec.name);
    if (found.length > 1) this.fail(`${where}: ${found.length} rulesets have this name; delete all but one`);
    if (found.length === 0) {
      await this.change(`${where}: create it`, () => this.d.api.createRuleset(spec.repo, rulesetBody(spec, null, appIds)));
      return;
    }
    const have = await this.d.api.ruleset(spec.repo, found[0]!.id);
    const diff = rulesetDiff(spec, have, appIds);
    if (diff.length === 0) {
      this.ok(where);
      return;
    }
    for (const line of diff) this.d.out(`        ${line}`);
    await this.change(`${where}: update it`, () => this.d.api.updateRuleset(spec.repo, have.id, rulesetBody(spec, have, appIds)));
  }
}
