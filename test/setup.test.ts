// `setup` against the fake GitHub (docs/deployment.md §5): a full
// run and an idempotent second run, missing-permission detection, the
// ruleset refusal before install, the control `main` ruleset's parameters,
// verify, and permission changes reported per registration and installation.

import { describe, expect, test } from "bun:test";
import { GitHubError } from "../src/github/http";
import { SetupApi } from "../src/setup/client";
import { runSetup } from "../src/setup/command";
import { controlRulesets, full, targetRulesets } from "../src/setup/expected";
import { installAll, type World, world } from "./setup-world";

const CONTROL_MAIN = "qlander-control-main";
const STATE_RULESET = "qlander-state-branches";

/** A world that has been set up end to end (the operator installs each App when asked). */
async function setUp(o: { targetRulesets?: boolean } = {}) {
  const w = world();
  w.operator = () => installAll(w.f, w.specs);
  const code = await runSetup(w.deps({ targetRulesets: o.targetRulesets ?? false }), ["apps", "install", "control", "target", "verify"]);
  return { w, code };
}

describe("a full run", () => {
  test("reaches the end state, and a second run writes nothing", async () => {
    const { w, code } = await setUp({ targetRulesets: true });
    expect(w.out.filter((l) => l.startsWith("FAIL"))).toEqual([]);
    expect(code).toBe(0);
    const n = w.c.config.names;
    const control = w.f.repo(`${n.control.owner}/${n.control.name}`);
    const target = w.f.repo(`${n.target.owner}/${n.target.name}`);
    expect([...w.f.apps.keys()].sort()).toEqual(w.specs.map((s) => s.slug).sort());
    expect([...control.envs.keys()].sort()).toEqual(["queue-write", "release-write"]);
    expect([...control.envs.get("queue-write")!.secrets.keys()].sort()).toEqual(["QUEUE_APP_CLIENT_ID", "QUEUE_APP_PRIVATE_KEY", "STATE_APP_CLIENT_ID", "STATE_APP_PRIVATE_KEY"]);
    expect([...control.envs.get("release-write")!.secrets.keys()].sort()).toEqual(["RELEASE_APP_CLIENT_ID", "RELEASE_APP_PRIVATE_KEY", "STATE_APP_CLIENT_ID", "STATE_APP_PRIVATE_KEY"]);
    expect(control.envs.get("queue-write")!.policies.map((p) => p.name)).toEqual(["main"]);
    expect(control.canApprove).toBe(false);
    expect([...control.rulesets.values()].map((r) => r.name).sort()).toEqual(controlRulesets(w.c).map((r) => r.name).sort());
    expect([...target.rulesets.values()].map((r) => r.name).sort()).toEqual(targetRulesets(w.c, true).map((r) => r.name).sort());
    expect(target.labels.has(n.labels.ready)).toBe(true);
    // Every secret holds the App's client id or its key (as the fake stores it in clear).
    const queue = w.f.apps.get(w.specs[0]!.slug)!;
    expect(control.envs.get("queue-write")!.secrets.get("QUEUE_APP_CLIENT_ID")).toBe(queue.clientId);
    expect(control.envs.get("queue-write")!.secrets.get("QUEUE_APP_PRIVATE_KEY")).toContain("PRIVATE KEY");

    const before = w.f.mutations.length;
    const snap = JSON.stringify(w.f.snapshot());
    w.out.length = 0;
    expect(await runSetup(w.deps({ targetRulesets: true }), ["apps", "install", "control", "target", "verify"])).toBe(0);
    expect(w.f.mutations.length).toBe(before);
    expect(JSON.stringify(w.f.snapshot())).toBe(snap);
    expect(w.out.filter((l) => /^(done|plan|todo|wait|FAIL)/.test(l))).toEqual([]);
  });

  test("plan mode writes nothing and says what it would do", async () => {
    const w = world();
    const code = await runSetup(w.deps({ apply: false }), ["apps"]);
    expect(code).toBe(0);
    expect(w.f.mutations).toEqual([]);
    expect(w.out.filter((l) => l.startsWith("plan  create the"))).toHaveLength(w.specs.length);
  });

  test("plan mode on a finished setup plans nothing", async () => {
    const { w } = await setUp();
    w.out.length = 0;
    const before = w.f.mutations.length;
    expect(await runSetup(w.deps({ apply: false }), ["apps", "install", "control", "target", "verify"])).toBe(0);
    expect(w.f.mutations.length).toBe(before);
    // Only verify's negative test is left to plan: it is an attempted write.
    expect(w.out.filter((l) => /^(done|plan|wait|FAIL)/.test(l))).toEqual([
      `plan  try to create ${w.c.config.names.stateBranch} with the operator's token, expecting the ruleset to refuse it`,
      `plan  try to create ${w.c.config.names.releaseStateBranch} with the operator's token, expecting the ruleset to refuse it`,
    ]);
  });
});

describe("apps", () => {
  test("detects a permission GitHub dropped when it created the App", async () => {
    const w = world();
    w.f.dropOnCreate = ["workflows"];
    expect(await runSetup(w.deps(), ["apps"])).toBe(1);
    expect(w.out).toContain("        Workflows: has none, needs write");
    expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("run setup --step permissions"))).toBe(true);
  });

  test("an App whose key was lost: prints where to generate one, waits for it, never makes a second App", async () => {
    const w = world();
    expect(await runSetup(w.deps(), ["apps"])).toBe(0);
    const slug = w.specs[0]!.slug;
    const { rmSync, writeFileSync } = await import("node:fs");
    rmSync(`${w.keysDir}/${slug}.pem`);
    const created = w.f.mutations.length;
    w.out.length = 0;
    w.operator = () => writeFileSync(`${w.keysDir}/${slug}.pem`, w.f.generateKey(slug), { mode: 0o644 });
    expect(await runSetup(w.deps(), ["apps"])).toBe(0);
    expect(w.f.mutations.length).toBe(created);
    expect(w.out.some((l) => l.includes(`/settings/apps/${slug}`) && l.includes("Credentials") && l.includes("Key pairs") && l.includes("New key"))).toBe(true);
    expect(w.out).toContain(`        save the downloaded file as ${w.keysDir}/${slug}.pem`);
  });

  test("refuses a key that is not the App's", async () => {
    const w = world();
    expect(await runSetup(w.deps(), ["apps"])).toBe(0);
    const [a, b] = w.specs;
    const { readFileSync, rmSync, writeFileSync } = await import("node:fs");
    const other = readFileSync(`${w.keysDir}/${b!.slug}.pem`, "utf8");
    rmSync(`${w.keysDir}/${a!.slug}.pem`);
    writeFileSync(`${w.keysDir}/${a!.slug}.pem`, other, { mode: 0o600 });
    expect(await runSetup(w.deps(), ["apps"])).toBe(1);
    expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("is not one of its keys"))).toBe(true);
  });

  describe("when a person makes the App from the printed link", () => {
    /** A manifest flow nobody completes: it ends only when setup stops it. */
    const noCode = (stop: AbortSignal) => new Promise<null>((r) => stop.addEventListener("abort", () => r(null), { once: true }));
    const save = async (w: ReturnType<typeof world>, slug: string) => (await import("node:fs")).writeFileSync(`${w.keysDir}/${slug}.pem`, w.f.generateKey(slug), { mode: 0o644 });

    test("setup at the prompt notices the App and its key, and carries on", async () => {
      const w = world();
      const pending = new Map(w.specs.map((s) => [s.slug, s]));
      w.operator = () => {
        const s = [...pending.values()][0];
        if (!s) return;
        pending.delete(s.slug);
        w.f.createByHand(s.owner, s.name, s.permissions);
        void save(w, s.slug);
      };
      expect(await runSetup(w.deps({ manifestCode: (_s, _m, stop) => noCode(stop) }), ["apps"])).toBe(0);
      for (const s of w.specs) {
        expect(w.out.some((l) => l.includes(`/organizations/${s.owner}/settings/apps/new?`) && l.includes(`name=${encodeURIComponent(s.name)}`) && l.includes("webhook_active=false") && l.includes("public=false") && l.includes("contents=write"))).toBe(true);
        expect(w.out.some((l) => l.includes("check them") && l.includes("Contents: Read and write"))).toBe(true);
        expect(w.out.some((l) => l.includes("Key pairs") && l.includes(`${w.keysDir}/${s.slug}.pem`))).toBe(true);
        expect(w.out.some((l) => l.startsWith("done  found the") && l.includes(s.slug))).toBe(true);
        expect(w.out).toContain(`ok    ${s.slug} has exactly its permissions`);
      }
      expect(JSON.parse(await Bun.file(`${w.keysDir}/apps.json`).text()).state.slug).toBe(w.specs.find((s) => s.role === "state")!.slug);
    });

    test("the App without its key does not end the prompt: the manifest flow makes one too, before its code arrives", async () => {
      const w = world();
      const s = w.specs[0]!;
      let stopped = false;
      let polls = 0;
      w.operator = () => {
        if (++polls === 1) w.f.createByHand(s.owner, s.name, s.permissions);
        if (polls === 3) expect(stopped).toBe(false);
        if (polls === 3) void save(w, s.slug);
      };
      // Only the first App matters here; the next prompt ends the step.
      const deps = w.deps({ manifestCode: (spec, _m, stop) => (spec === s || spec.slug === s.slug ? noCode(stop).then((c) => ((stopped = true), c)) : Promise.reject(new Error("next App"))) });
      await runSetup(deps, ["apps"]);
      expect(stopped).toBe(true);
      expect(w.out.some((l) => l.startsWith("wait") && l.includes("waiting for its code, or its key"))).toBe(true);
      expect(w.out.some((l) => l.startsWith("done  found the") && l.includes(s.slug))).toBe(true);
    });

    test("a code that arrives first still wins, and the watch stops", async () => {
      const w = world();
      expect(await runSetup(w.deps(), ["apps"])).toBe(0);
      expect(w.out.some((l) => l.startsWith("done  created the"))).toBe(true);
      expect(w.out.some((l) => l.startsWith("done  found the"))).toBe(false);
    });

    test("a rerun finds an App and key made while setup was not running", async () => {
      const w = world();
      for (const s of w.specs) {
        w.f.createByHand(s.owner, s.name, s.permissions);
        await save(w, s.slug);
      }
      expect(await runSetup(w.deps({ manifestCode: () => Promise.reject(new Error("no prompt expected")) }), ["apps"])).toBe(0);
    });

    test("a permission GitHub dropped from the link fails the step and names it", async () => {
      const w = world();
      const s = w.specs.find((x) => x.permissions.statuses)!;
      for (const x of w.specs) {
        const { statuses: _dropped, ...rest } = x.permissions;
        w.f.createByHand(x.owner, x.name, x === s ? rest : x.permissions);
        await save(w, x.slug);
      }
      expect(await runSetup(w.deps(), ["apps"])).toBe(1);
      expect(w.out).toContain("        Commit statuses: has none, needs read");
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("run setup --step permissions"))).toBe(true);
      w.f.savePermissions(s.slug, s.permissions);
      expect(await runSetup(w.deps(), ["apps"])).toBe(0);
    });
  });

  describe("when the code arrives and a key is already saved for that slug", () => {
    const withSavedKey = async (own: boolean) => {
      const w = world();
      const slug = w.specs[0]!.slug;
      const api = w.deps().api;
      const real = api.convertManifest.bind(api);
      const { readFileSync, writeFileSync } = await import("node:fs");
      const foreign = (await import("./fake-github-setup")).keyPair().pem;
      let saved = "";
      api.convertManifest = async (code) => {
        const conv = await real(code);
        if (conv.slug === slug) {
          saved = own ? w.f.generateKey(slug) : foreign;
          writeFileSync(`${w.keysDir}/${slug}.pem`, saved, { mode: 0o600 });
        }
        return conv;
      };
      const exit = await runSetup(w.deps({ api }), ["apps"]);
      return { w, slug, exit, saved, onDisk: readFileSync(`${w.keysDir}/${slug}.pem`, "utf8") };
    };

    test("this App's key is kept, not overwritten, and setup carries on", async () => {
      const { w, slug, exit, saved, onDisk } = await withSavedKey(true);
      expect(exit).toBe(0);
      expect(onDisk).toBe(saved);
      expect(w.out.some((l) => l.startsWith("done") && l.includes(slug) && l.includes("kept the key already"))).toBe(true);
    });

    test("another App's key is kept too, and the key check refuses it", async () => {
      const { w, exit, saved, onDisk } = await withSavedKey(false);
      expect(exit).toBe(1);
      expect(onDisk).toBe(saved);
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("is not one of its keys"))).toBe(true);
    });
  });

  test("creating an App needs a key directory: a key command cannot keep a new key", async () => {
    const w = world();
    const { CommandKeyStore } = await import("../src/setup/keys");
    expect(await runSetup(w.deps({ keys: new CommandKeyStore("false") }), ["apps"])).toBe(1);
    expect(w.f.mutations).toEqual([]);
    expect(w.out.some((l) => l.includes("needs --keys-dir"))).toBe(true);
  });
});

describe("install", () => {
  test("prints the install link and polls until the App is on its one repo", async () => {
    const w = world();
    await runSetup(w.deps(), ["apps"]);
    let polls = 0;
    w.operator = () => {
      if (++polls === 2) installAll(w.f, w.specs);
    };
    expect(await runSetup(w.deps(), ["install"])).toBe(0);
    expect(w.out.some((l) => l.includes(`/apps/${w.specs[0]!.slug}/installations/new`))).toBe(true);
    const apps = JSON.parse(await Bun.file(`${w.keysDir}/apps.json`).text());
    expect(typeof apps.queue.installationId).toBe("number");
    expect(JSON.stringify(apps)).not.toContain("PRIVATE KEY");
  });

  test("an installation on every repo is not accepted", async () => {
    const w = world();
    await runSetup(w.deps(), ["apps"]);
    for (const s of w.specs) w.f.install(s.slug, s.owner, [], "all");
    expect(await runSetup(w.deps({ waitMs: 0 }), ["install"])).toBe(1);
    expect(w.out.some((l) => l.includes("installed on all repositories"))).toBe(true);
  });
});

describe("rulesets refuse before the App is installed", () => {
  for (const step of ["control", "target"] as const) {
    test(`${step}: refuses before any write`, async () => {
      const w = world();
      await runSetup(w.deps(), ["apps"]);
      const before = w.f.mutations.length;
      expect(await runSetup(w.deps(), [step])).toBe(1);
      expect(w.f.mutations.length).toBe(before);
      expect(w.out.some((l) => l.startsWith("FAIL  refusing the") && l.includes("run setup --step install first"))).toBe(true);
    });
  }
});

describe("the control main ruleset", () => {
  test("has every protection parameter, and no bypass", async () => {
    const { w } = await setUp();
    const n = w.c.config.names;
    const rs = [...w.f.repo(`${n.control.owner}/${n.control.name}`).rulesets.values()].find((r) => r.name === CONTROL_MAIN)!;
    expect(rs.bypass_actors).toEqual([]);
    expect(rs.conditions.ref_name.include).toEqual(["refs/heads/main"]);
    expect(rs.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true });
    expect(rs.rules.map((r) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "pull_request", "required_signatures"]);
  });

  test("an existing ruleset missing a parameter or with a bypass is fixed, keeping stricter extras", async () => {
    const { w } = await setUp();
    const n = w.c.config.names;
    const repo = w.f.repo(`${n.control.owner}/${n.control.name}`);
    const rs = [...repo.rulesets.values()].find((r) => r.name === CONTROL_MAIN)!;
    rs.rules = rs.rules.filter((r) => r.type !== "non_fast_forward");
    rs.rules.find((r) => r.type === "pull_request")!.parameters = { required_approving_review_count: 1, dismiss_stale_reviews_on_push: false, require_last_push_approval: true, required_review_thread_resolution: true };
    rs.bypass_actors = [{ actor_id: 1, actor_type: "OrganizationAdmin", bypass_mode: "always" }];
    w.out.length = 0;
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    expect(w.out).toContain("        rule non_fast_forward is missing");
    expect(w.out).toContain("        rule pull_request: dismiss_stale_reviews_on_push is false, needs true");
    expect(w.out).toContain("        unexpected bypass actor: OrganizationAdmin 1");
    const fixed = repo.rulesets.get(rs.id)!;
    expect(fixed.bypass_actors).toEqual([]);
    expect(fixed.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ dismiss_stale_reviews_on_push: true, required_review_thread_resolution: true });
    expect(fixed.rules.some((r) => r.type === "non_fast_forward")).toBe(true);
  });

  test("the state-branch ruleset has the state App as its only bypass, and covers both state branches", async () => {
    const { w } = await setUp();
    const n = w.c.config.names;
    const rs = [...w.f.repo(`${n.control.owner}/${n.control.name}`).rulesets.values()].find((r) => r.name === STATE_RULESET)!;
    expect(rs.bypass_actors).toEqual([{ actor_id: w.f.apps.get(w.specs.find((s) => s.role === "state")!.slug)!.id, actor_type: "Integration", bypass_mode: "always" }]);
    expect(rs.conditions.ref_name.include.sort()).toEqual([`refs/heads/${n.releaseStateBranch}`, `refs/heads/${n.stateBranch}`].sort());
  });

  test("the landing ruleset keeps a break-glass person but never another App", async () => {
    const { w } = await setUp({ targetRulesets: true });
    const n = w.c.config.names;
    const repo = w.f.repo(`${n.target.owner}/${n.target.name}`);
    const rs = [...repo.rulesets.values()].find((r) => r.name === "main-landing")!;
    const release = w.f.apps.get(w.specs.find((s) => s.role === "release")!.slug)!;
    rs.bypass_actors.push({ actor_id: 7, actor_type: "User", bypass_mode: "always" }, { actor_id: release.id, actor_type: "Integration", bypass_mode: "always" });
    expect(await runSetup(w.deps({ targetRulesets: true }), ["target"])).toBe(0);
    expect(repo.rulesets.get(rs.id)!.bypass_actors.map((a) => a.actor_type).sort()).toEqual(["Integration", "User"]);
    expect(repo.rulesets.get(rs.id)!.bypass_actors.find((a) => a.actor_type === "Integration")!.actor_id).not.toBe(release.id);
  });

  test("classic protection on the target's main is never removed, only reported", async () => {
    const w = world();
    const n = w.c.config.names;
    w.f.repo(`${n.target.owner}/${n.target.name}`).classicProtection.add(n.main);
    w.operator = () => installAll(w.f, w.specs);
    expect(await runSetup(w.deps({ targetRulesets: true }), ["apps", "install", "target"])).toBe(0);
    expect(w.out).toContain(`        gh api -X DELETE repos/${n.target.owner}/${n.target.name}/branches/${n.main}/protection`);
    expect(w.f.repo(`${n.target.owner}/${n.target.name}`).classicProtection.has(n.main)).toBe(true);
  });
});

describe("control secrets", () => {
  test("--rotate sets every secret again (a replaced key)", async () => {
    const { w } = await setUp();
    const before = w.f.mutations.length;
    expect(await runSetup(w.deps({ rotate: true }), ["control"])).toBe(0);
    expect(w.f.mutations.slice(before).filter((m) => m.includes("set secret"))).toHaveLength(8);
  });

  test("a deployment rule other than main is removed", async () => {
    const { w } = await setUp();
    const n = w.c.config.names;
    w.f.repo(`${n.control.owner}/${n.control.name}`).envs.get("queue-write")!.policies.push({ id: 9, name: "feature/*", type: "branch" });
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    expect(w.f.repo(`${n.control.owner}/${n.control.name}`).envs.get("queue-write")!.policies.map((p) => p.name)).toEqual(["main"]);
  });
});

describe("verify", () => {
  test("mints every App's token with exactly the tick's permissions, and the state branch refuses the operator", async () => {
    const { w } = await setUp();
    w.out.length = 0;
    expect(await runSetup(w.deps(), ["verify"])).toBe(0);
    for (const s of w.specs) expect(w.out).toContain(`ok    ${s.slug}: minted a token with exactly the tick's permissions, for ${full(s.repo)} only`);
    expect(w.out.filter((l) => l.includes("with the operator's token was refused") && l.includes("the creation rule of") && l.includes("applies to it"))).toHaveLength(2);
    const minted = [...w.f.tokens.values()].map((t) => t.perms);
    for (const s of w.specs) expect(minted).toContainEqual(s.tokenPermissions);
  });

  test("a wrong state ruleset fails verify before the negative test runs", async () => {
    const { w } = await setUp();
    const n = w.c.config.names;
    const repo = w.f.repo(`${n.control.owner}/${n.control.name}`);
    const rs = [...repo.rulesets.values()].find((r) => r.name === STATE_RULESET)!;
    rs.rules = rs.rules.filter((r) => r.type !== "creation");
    const before = w.f.calls.filter((c) => c.startsWith("POST") && c.endsWith("git/refs")).length;
    expect(await runSetup(w.deps(), ["verify"])).toBe(1);
    expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("rule creation is missing") && l.includes("the negative test was not run"))).toBe(true);
    expect(w.f.calls.filter((c) => c.startsWith("POST") && c.endsWith("git/refs")).length).toBe(before);
  });

  test("a state branch the operator can create anyway fails, and the branch is removed again", async () => {
    const { w } = await setUp();
    const n = w.c.config.names;
    const repo = w.f.repo(`${n.control.owner}/${n.control.name}`);
    w.f.enforceRulesets = false;
    expect(await runSetup(w.deps(), ["verify"])).toBe(1);
    expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("created") && l.includes(n.stateBranch))).toBe(true);
    expect(repo.refs.has(n.stateBranch)).toBe(false);
  });

  test("an installation that has not accepted a permission fails", async () => {
    const { w } = await setUp();
    const q = w.specs[0]!;
    w.f.savePermissions(q.slug, { ...q.permissions, issues: "read" });
    // The registration now has more than expected: verify reports the registration first.
    expect(await runSetup(w.deps(), ["verify"])).toBe(1);
    expect(w.out.some((l) => l.startsWith(`FAIL  ${q.slug}: registration permissions differ`))).toBe(true);
  });

  test("works with keys from a key command", async () => {
    const { w } = await setUp();
    const { CommandKeyStore } = await import("../src/setup/keys");
    const { writeFileSync } = await import("node:fs");
    const script = `${w.keysDir}/../get-key-${process.pid}.sh`;
    writeFileSync(script, `#!/bin/sh\ncat "${w.keysDir}/$1.pem"\n`, { mode: 0o700 });
    w.out.length = 0;
    expect(await runSetup(w.deps({ keys: new CommandKeyStore(script) }), ["verify"])).toBe(0);
  });
});

describe("permissions (§5.3)", () => {
  test("a saved but unaccepted change: registration matches, the installation is reported pending, with its link", async () => {
    const { w } = await setUp();
    const q = w.specs[0]!;
    const inst = [...w.f.installations.values()].find((i) => i.appId === w.f.apps.get(q.slug)!.id)!;
    inst.permissions = { ...inst.permissions, workflows: "read" };
    w.out.length = 0;
    expect(await runSetup(w.deps({ apply: false }), ["permissions"])).toBe(1);
    expect(w.out).toContain(`ok    ${q.slug}: registration permissions match`);
    expect(w.out).toContain(`todo  ${q.slug}: installation ${inst.id} has not accepted the permissions (workflows read→write)`);
    expect(w.out).toContain(`        open https://github.fake.test/organizations/${q.owner}/settings/installations/${inst.id} and accept the new permissions`);
  });

  test("applying: prints the steps, polls the registration, then the installation, separately", async () => {
    const { w } = await setUp();
    const q = w.specs[0]!;
    // The App lacks Workflows, on its registration and its installation (as if GitHub had dropped it on creation).
    const { workflows: _, ...lacking } = q.permissions;
    w.f.savePermissions(q.slug, lacking);
    for (const i of w.f.installations.values()) w.f.accept(i.id);
    let polls = 0;
    w.operator = () => {
      polls++;
      if (polls === 2) w.f.savePermissions(q.slug, q.permissions);
      if (polls === 4) for (const i of w.f.installations.values()) w.f.accept(i.id);
    };
    w.out.length = 0;
    expect(await runSetup(w.deps(), ["permissions"])).toBe(0);
    expect(w.out).toContain(`todo  ${q.slug}: the registration permissions differ. Open https://github.fake.test/organizations/${q.owner}/settings/apps/${q.slug}/permissions:`);
    expect(w.out).toContain("        set Workflows to Read and write under Repository permissions (now No access)");
    expect(w.out).toContain(`wait  ${q.slug} registration: workflows is none, needs write (not saved)`);
    expect(w.out.some((l) => l.startsWith(`wait  ${q.slug} installation`) && l.endsWith("(saved, not accepted)"))).toBe(true);
    expect(w.out).toContain(`ok    ${q.slug}: registration permissions saved`);
    expect(w.out.some((l) => l.startsWith(`ok    ${q.slug}: installation`) && l.endsWith("has accepted them"))).toBe(true);
  });
});

describe("hardening", () => {
  test("plan mode never writes apps.json", async () => {
    const { w } = await setUp();
    const { rmSync, existsSync } = await import("node:fs");
    rmSync(`${w.keysDir}/apps.json`);
    expect(await runSetup(w.deps({ apply: false }), ["apps", "install", "verify"])).toBe(0);
    expect(existsSync(`${w.keysDir}/apps.json`)).toBe(false);
  });

  test("a plan on a fresh org plans the installs too, then the ruleset steps refuse", async () => {
    const w = world();
    expect(await runSetup(w.deps({ apply: false }), ["apps", "install"])).toBe(0);
    expect(w.out.filter((l) => l.startsWith("plan  install"))).toHaveLength(w.specs.length);
    expect(w.f.mutations).toEqual([]);
  });

  test("verify fails an installation that also covers another repo", async () => {
    const { w } = await setUp();
    const q = w.specs[0]!;
    w.f.addRepo(`${q.owner}/other`, 9999);
    w.f.install(q.slug, q.owner, [`${q.owner}/${q.repo.name}`, `${q.owner}/other`]);
    expect(await runSetup(w.deps(), ["verify"])).toBe(1);
    expect(w.out.some((l) => l.startsWith(`FAIL  ${q.slug}: installation`) && l.includes("not ["))).toBe(true);
  });

  test("a create refused for another reason than a ruleset is not a pass", async () => {
    const { w } = await setUp();
    const api = w.deps().api;
    const real = api.createRef.bind(api);
    const { GitHubError } = await import("../src/github/http");
    api.createRef = async () => {
      throw new GitHubError("auth", 401, "Bad credentials");
    };
    expect(await runSetup(w.deps({ api }), ["verify"])).toBe(1);
    expect(w.out.some((l) => l.includes("failed, but not by a ruleset"))).toBe(true);
    api.createRef = real;
  });

  describe("what counts as refused", () => {
    const controlRepo = (w: World) => w.f.repos.get(`${w.c.config.names.control.owner}/${w.c.config.names.control.name}`.toLowerCase())!;
    /** Verify, with GitHub answering `answer` when the state branches are created. */
    const refusing = async (answer: (branch: string, w: World) => Promise<void>) => {
      const { w } = await setUp();
      const api = w.deps().api;
      api.createRef = (_r, branch) => answer(branch, w);
      w.out.length = 0;
      const before = w.f.mutations.length;
      const code = await runSetup(w.deps({ api }), ["verify"]);
      return { w, code, writes: w.f.mutations.slice(before) };
    };

    for (const message of ["Reference update failed", "Repository rule violations found\n\nCannot create ref due to creations being restricted."]) {
      test(`a 422 saying "${message.split("\n")[0]}" passes, and verify writes nothing`, async () => {
        const { w, code, writes } = await refusing(async () => {
          throw new GitHubError("validation", 422, message);
        });
        expect(code).toBe(0);
        expect(w.out.filter((l) => l.startsWith("ok") && l.includes("was refused") && l.includes(message.split("\n")[0]!) && l.includes(`the creation rule of ${STATE_RULESET} applies`))).toHaveLength(2);
        expect(writes).toEqual([]);
      });
    }

    test("a 422 of any wording does not pass unless the ruleset's creation rule is reported on that name", async () => {
      const { w } = await setUp();
      const api = w.deps().api;
      let attempts = 0;
      api.createRef = async () => {
        attempts++;
        throw new GitHubError("validation", 422, "Repository rule violations found");
      };
      api.branchRules = async () => [];
      w.out.length = 0;
      expect(await runSetup(w.deps({ api }), ["verify"])).toBe(1);
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("does not report") && l.includes("creation rule"))).toBe(true);
      expect(attempts).toBe(0);
    });

    test("the rule must come from the expected ruleset: another ruleset's does not count", async () => {
      const { w } = await setUp();
      const api = w.deps().api;
      api.createRef = async () => {
        throw new GitHubError("validation", 422, "Reference update failed");
      };
      api.branchRules = async () => [{ type: "creation", rulesetId: 999_999 }];
      w.out.length = 0;
      expect(await runSetup(w.deps({ api }), ["verify"])).toBe(1);
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("does not report"))).toBe(true);
    });

    for (const [kind, status, message] of [["auth", 403, "Forbidden"], ["server", 502, "Bad gateway"], ["network", null, "connection reset"]] as const) {
      test(`a rules read that fails (${status ?? kind}) fails verification`, async () => {
        const { w } = await setUp();
        const api = w.deps().api;
        api.branchRules = async () => {
          throw new GitHubError(kind, status, message);
        };
        w.out.length = 0;
        expect(await runSetup(w.deps({ api }), ["verify"])).toBe(1);
        expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("could not read the rules") && l.includes(message))).toBe(true);
      });
    }

    /** The same fake GitHub, with the rules read answered first by `otherPages` pages of 30 rules from another ruleset. */
    const pagedRules = (w: World, otherPages: number) => {
      const seen: string[] = [];
      const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (!url.pathname.includes("/rules/branches/")) return w.f.fetch(input as string, init);
        seen.push(url.search);
        const page = Number(url.searchParams.get("page") ?? 1);
        if (page > otherPages) return w.f.fetch(`${url.origin}${url.pathname}`, init);
        url.searchParams.set("page", String(page + 1));
        const others = Array.from({ length: 30 }, () => ({ type: "creation", ruleset_id: 999_999 }));
        return new Response(JSON.stringify(others), { status: 200, headers: { "content-type": "application/json", link: `<${url}>; rel="next"` } });
      }) as typeof fetch;
      return { seen, deps: w.deps({ api: new SetupApi(w.f.operator, { baseUrl: "https://api.fake.test", fetch: fetchFn, readAttempts: 1 }) }) };
    };

    test("the expected rule on a later page is found: 30 other rules and a next link", async () => {
      const { w } = await setUp();
      const { seen, deps } = pagedRules(w, 1);
      w.out.length = 0;
      expect(await runSetup(deps, ["verify"])).toBe(0);
      expect(seen[0]).toContain("per_page=100");
      expect(seen.some((q) => q.includes("page=2"))).toBe(true);
      expect(w.out.filter((l) => l.includes(`the creation rule of ${STATE_RULESET} applies to it`))).toHaveLength(2);
    });

    test("a truncated listing is a failed read, and fails verification", async () => {
      const { w } = await setUp();
      const { deps } = pagedRules(w, Number.MAX_SAFE_INTEGER);
      let attempts = 0;
      deps.api.createRef = async () => {
        attempts++;
      };
      w.out.length = 0;
      expect(await runSetup(deps, ["verify"])).toBe(1);
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("could not read the rules") && l.includes("truncated"))).toBe(true);
      expect(attempts).toBe(0);
    });

    for (const [kind, status, message] of [["auth", 401, "Bad credentials"], ["auth", 403, "Resource not accessible by personal access token"], ["not_found", 404, "Not Found"]] as const) {
      test(`a ${status} on the create is no pass`, async () => {
        const { w, code } = await refusing(async () => {
          throw new GitHubError(kind, status, message);
        });
        expect(code).toBe(1);
        expect(w.out.some((l) => l.includes("failed, but not by a ruleset") && l.includes(message))).toBe(true);
      });
    }

    test("a 422 that left the branch there is no pass", async () => {
      const { w, code } = await refusing(async (branch, world) => {
        controlRepo(world).refs.set(branch, "a".repeat(40));
        throw new GitHubError("validation", 422, "Reference update failed");
      });
      expect(code).toBe(1);
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("but the branch exists"))).toBe(true);
    });

    test("an operator on the bypass list does not pass, and the negative test is not run", async () => {
      const { w } = await setUp();
      const rs = [...controlRepo(w).rulesets.values()].find((r) => r.name === STATE_RULESET)!;
      rs.bypass_actors = [...rs.bypass_actors, { actor_id: 42, actor_type: "User", bypass_mode: "always" }];
      const before = w.f.mutations.length;
      w.out.length = 0;
      expect(await runSetup(w.deps(), ["verify"])).toBe(1);
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("unexpected bypass actor: User 42") && l.includes("the negative test was not run"))).toBe(true);
      expect(w.f.mutations.slice(before)).toEqual([]);
    });

    test("the stated gap: while the rule is reported active, a 422 from another cause reads as a refusal", async () => {
      const { w, code } = await refusing(async () => {
        throw new GitHubError("validation", 422, "Object does not exist");
      });
      expect(code).toBe(0);
      expect(w.out.some((l) => l.includes("was refused (validation (422): Object does not exist)"))).toBe(true);
    });

    test("a ruleset that doesn't refuse: the branch is removed again and verify fails", async () => {
      const { w } = await setUp();
      w.f.enforceRulesets = false;
      const before = w.f.mutations.length;
      w.out.length = 0;
      expect(await runSetup(w.deps(), ["verify"])).toBe(1);
      expect(w.out.some((l) => l.startsWith("FAIL") && l.includes("does not restrict creation"))).toBe(true);
      expect(JSON.stringify(w.f.mutations.slice(before))).toContain("delete ref");
    });
  });
});

describe("verify runs the audit last", () => {
  test("--skip-audit says no audit ran, and does not report one as clean", async () => {
    const { w } = await setUp();
    w.out.length = 0;
    expect(await runSetup(w.deps({ audit: async () => null }), ["verify"])).toBe(0);
    expect(w.out).toContain("skip  audit (--skip-audit): none ran, so run the audit command before going live");
    expect(w.out.some((l) => l.includes("no FAIL, no failed read") || l.includes("src/cli.ts"))).toBe(false);
  });

  test("a FAIL in the audit fails verify, after the token checks pass", async () => {
    const { w } = await setUp();
    w.out.length = 0;
    expect(await runSetup(w.deps({ audit: async () => ({ lines: ["FAIL    T1   a workflow"], failed: 1 }) }), ["verify"])).toBe(1);
    expect(w.out).toContain("        FAIL    T1   a workflow");
    expect(w.out.some((l) => l.startsWith("FAIL  audit: 1 finding(s) failed"))).toBe(true);
  });

  test("setup's expected App permissions are the audit's", async () => {
    const { EXPECTED_PERMISSIONS } = await import("../src/audit/apps");
    const { appSpecs } = await import("../src/setup/expected");
    for (const s of appSpecs(world().c, "x")) expect(s.permissions).toEqual(EXPECTED_PERMISSIONS[s.role]);
  });
});
