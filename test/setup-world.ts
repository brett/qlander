// A harness for `setup` tests: the example config, a fresh fake GitHub with
// its control and target repos, a key directory outside any git work tree,
// a fake clock, and an operator who acts in the browser while setup polls.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LoadedConfig, loadConfig } from "../src/config/load";
import { SetupApi } from "../src/setup/client";
import type { SetupDeps } from "../src/setup/context";
import { type AppSpec, appSpecs, full } from "../src/setup/expected";
import { DirKeyStore } from "../src/setup/keys";
import { FakeSetupGitHub } from "./fake-github-setup";

export const EXAMPLE = join(import.meta.dir, "fixtures", "example.qlander.yml");

export function exampleConfig(): LoadedConfig {
  return loadConfig(EXAMPLE);
}

export function freshKeysDir(): string {
  return mkdtempSync(join(tmpdir(), "setup-keys-"));
}

/** A fake GitHub holding the config's control and target repos. */
export function fakeFor(c: LoadedConfig): FakeSetupGitHub {
  const f = new FakeSetupGitHub();
  const n = c.config.names;
  f.addRepo(`${n.control.owner}/${n.control.name}`, n.control.id);
  f.addRepo(`${n.target.owner}/${n.target.name}`, n.target.id);
  return f;
}

/** What the operator does when setup asks: install each existing App on its one repo. */
export function installAll(f: FakeSetupGitHub, specs: AppSpec[]): void {
  for (const s of specs) {
    const app = f.apps.get(s.slug);
    if (app && ![...f.installations.values()].some((i) => i.appId === app.id)) f.install(s.slug, s.owner, [full(s.repo)]);
  }
}

export interface World {
  c: LoadedConfig;
  f: FakeSetupGitHub;
  keysDir: string;
  out: string[];
  specs: AppSpec[];
  /** Called on every poll sleep: the operator's browser actions. */
  operator: (() => void) | null;
  deps(over?: Partial<SetupDeps>): SetupDeps;
}

export function world(c: LoadedConfig = exampleConfig()): World {
  const f = fakeFor(c);
  const keysDir = freshKeysDir();
  // A fake clock that only sleep moves, on top of the real time (the fake checks JWT expiry against the real clock).
  const start = Date.now();
  let elapsed = 0;
  const w: World = {
    c,
    f,
    keysDir,
    out: [],
    specs: appSpecs(c, c.config.names.control.name),
    operator: null,
    deps: (over = {}) => ({
      config: c,
      api: new SetupApi(f.operator, { baseUrl: "https://api.fake.test", fetch: f.fetch, readAttempts: 1 }),
      keys: new DirKeyStore(keysDir),
      prefix: c.config.names.control.name,
      apply: true,
      rotate: false,
      targetRulesets: false,
      web: "https://github.fake.test",
      out: (l) => w.out.push(l),
      setSecret: async (repo, env, name, value) => f.setSecret(full(repo), env, name, value),
      // The owner clicks Create at once.
      manifestCode: async (spec, manifest) => f.createFromManifest(spec.owner, manifest),
      sleep: async (ms) => {
        elapsed += ms;
        w.operator?.();
      },
      now: () => start + elapsed,
      pollMs: 10_000,
      waitMs: 30 * 60_000,
      // The fake GitHub does not serve the contents API the audit reads; its own tests cover it.
      audit: async () => ({ lines: ["audit: (stubbed)"], failed: 0 }),
      ...over,
    }),
  };
  return w;
}
