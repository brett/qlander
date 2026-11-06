// The parts of `setup` below the steps: key custody (docs/deployment.md §5.1),
// argument parsing, the manifest flow's local page and pasted codes, the
// App JWT, and the expected token permissions against the rendered tick.yml.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { renderTick } from "../src/render";
import { parseSetupArgs, setupCommand, UsageError } from "../src/setup/command";
import { MAX_APP_NAME, tooLongAppNames } from "../src/setup/expected";
import { appSpecs } from "../src/setup/expected";
import { appJwt } from "../src/setup/jwt";
import { CommandKeyStore, DirKeyStore, KeyError } from "../src/setup/keys";
import { browserManifestCode, codeFromLine, newAppLink } from "../src/setup/manifest-flow";
import { EXAMPLE, exampleConfig, freshKeysDir } from "./setup-world";
import { FakeSetupGitHub } from "./fake-github-setup";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n";

describe("key custody (--keys-dir)", () => {
  test("refuses a directory inside a git work tree", () => {
    const repo = mkdtempSync(join(tmpdir(), "setup-repo-"));
    mkdirSync(join(repo, ".git"));
    expect(() => new DirKeyStore(join(repo, "keys"))).toThrow(KeyError);
    expect(() => new DirKeyStore(join(repo, "keys"))).toThrow(/inside the git work tree/);
  });

  test("refuses a directory open to group or others", () => {
    const dir = mkdtempSync(join(tmpdir(), "setup-keys-"));
    Bun.spawnSync(["chmod", "755", dir]);
    expect(() => new DirKeyStore(dir)).toThrow(/readable by group or others/);
  });

  test("creates a missing directory with mode 0700", () => {
    const dir = join(freshKeysDir(), "new");
    new DirKeyStore(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test("writes a key with mode 0600, exclusively, and never overwrites it", () => {
    const s = new DirKeyStore(freshKeysDir());
    s.store("acme-queue", PEM);
    expect(statSync(s.pathFor("acme-queue")).mode & 0o777).toBe(0o600);
    expect(() => s.store("acme-queue", PEM.replace("AAAA", "BBBB"))).toThrow(/refusing to overwrite/);
    expect(s.read("acme-queue")).toBe(PEM);
  });

  test("tightens a downloaded key's mode, and refuses a file that is not a key", () => {
    const s = new DirKeyStore(freshKeysDir());
    writeFileSync(s.pathFor("acme-state"), PEM, { mode: 0o644 });
    expect(s.read("acme-state")).toBe(PEM);
    expect(statSync(s.pathFor("acme-state")).mode & 0o777).toBe(0o600);
    writeFileSync(s.pathFor("acme-release"), "not a key", { mode: 0o600 });
    expect(() => s.read("acme-release")).toThrow(/not a PEM private key/);
  });

  test("apps.json holds ids only, with mode 0600", () => {
    const s = new DirKeyStore(freshKeysDir());
    s.saveApps({ queue: { slug: "acme-queue", id: 1, clientId: "Iv1.x", installationId: 2 } });
    expect(s.apps()).toEqual({ queue: { slug: "acme-queue", id: 1, clientId: "Iv1.x", installationId: 2 } });
    expect(statSync(join(s.dir, "apps.json")).mode & 0o777).toBe(0o600);
  });

  test("refuses a slug that could escape the directory", () => {
    const s = new DirKeyStore(freshKeysDir());
    expect(() => s.pathFor("../x")).toThrow(KeyError);
  });
});

describe("key custody (--key-cmd)", () => {
  test("runs the command with the slug as its last argument", () => {
    const dir = freshKeysDir();
    writeFileSync(join(dir, "acme-queue.pem"), PEM, { mode: 0o600 });
    // `<command> <slug>`: here sh -c with the slug as $0.
    const s = new CommandKeyStore(`sh -c 'cat "${dir}/$0.pem"'`);
    expect(s.read("acme-queue")).toBe(PEM);
    expect(s.read("acme-missing")).toBeNull();
    expect(() => s.store("acme-queue")).toThrow(/use --keys-dir/);
  });
});

describe("arguments", () => {
  test("plan is the default; --dry-run is plan", () => {
    expect(parseSetupArgs([]).apply).toBe(false);
    expect(parseSetupArgs(["--dry-run"]).apply).toBe(false);
    expect(parseSetupArgs(["--apply", "--step", "verify", "--keys-dir", "/k", "--poll-seconds", "0.5"])).toMatchObject({ apply: true, step: "verify", keysDir: "/k", pollMs: 500 });
  });

  for (const [args, why] of [
    [["--apply", "--plan"], /cannot be combined/],
    [["--keys-dir", "/a", "--key-cmd", "x"], /cannot be combined/],
    [["--step", "everything"], /unknown step/],
    [["--rotate"], /--rotate goes with --step control/],
    [["--name", "../x"], /--name/],
    [["--keys-dir"], /needs a value/],
    [["--apply", "--apply"], /given twice/],
  ] as const) {
    test(`refuses ${args.join(" ")}`, () => {
      expect(() => parseSetupArgs([...args])).toThrow(UsageError);
      expect(() => parseSetupArgs([...args])).toThrow(why);
    });
  }

  test("the command exits 2 on a usage error, and without an operator token", async () => {
    const err: string[] = [];
    const io = { out: () => {}, err: (l: string) => err.push(l) };
    expect(await setupCommand(["--bogus"], io, {})).toBe(2);
    expect(await setupCommand(["--config", EXAMPLE], io, { PATH: "/nonexistent" })).toBe(2);
    expect(err.some((l) => l.includes("no operator token"))).toBe(true);
  });
});

describe("the manifest flow", () => {
  const spec = appSpecs(exampleConfig(), "acme")[0]!;
  const manifest = { name: spec.name, url: "https://example.test", hook_attributes: { url: "https://example.test", active: false as const }, public: false as const, default_permissions: spec.permissions, default_events: [] };

  test("codes from a pasted line", () => {
    expect(codeFromLine(" abc123 ")).toBe("abc123");
    expect(codeFromLine("http://127.0.0.1:1234/callback?code=abc_12-3&state=x")).toBe("abc_12-3");
    expect(codeFromLine("not a code at all")).toBeNull();
  });

  test("the local page posts the manifest to GitHub, and the redirect delivers the code", async () => {
    const f = new FakeSetupGitHub();
    const server = f.serve();
    const out: string[] = [];
    try {
      const pending = browserManifestCode(spec, manifest, { web: server.url, out: (l) => out.push(l), timeoutMs: 10_000, input: null });
      await Bun.sleep(10);
      const local = /open (http:\/\/127\.0\.0\.1:\d+\/) in a browser/.exec(out.join("\n"))![1]!;
      const page = await (await fetch(local)).text();
      const action = /action="([^"]+)"/.exec(page)![1]!.replace(/&amp;/g, "&");
      const value = /name="manifest" value="([^"]+)"/.exec(page)![1]!.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      expect(action).toStartWith(`${server.url}/organizations/${spec.owner}/settings/apps/new?state=`);
      expect(JSON.parse(value)).toMatchObject({ name: spec.name, public: false, default_permissions: spec.permissions, redirect_url: `${local}callback` });
      const redirect = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest: value }), redirect: "manual" });
      const back = await fetch(redirect.headers.get("location")!);
      expect(back.status).toBe(200);
      const code = await pending;
      expect(f.codes.has(code!)).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("a callback with the wrong state is refused; a pasted code is accepted", async () => {
    const input = new PassThrough();
    const out: string[] = [];
    const pending = browserManifestCode(spec, manifest, { web: "https://github.example", out: (l) => out.push(l), timeoutMs: 10_000, input });
    await Bun.sleep(10);
    const local = /open (http:\/\/127\.0\.0\.1:\d+\/) in a browser/.exec(out.join("\n"))![1]!;
    expect((await fetch(`${local}callback?code=abc&state=wrong`)).status).toBe(400);
    input.write("garbage line\n");
    input.write("https://x.test/?code=pasted123\n");
    expect(await pending).toBe("pasted123");
  });

  test("a stop ends the wait with no code", async () => {
    const stop = new AbortController();
    const pending = browserManifestCode(spec, manifest, { web: "https://github.example", out: () => {}, timeoutMs: 10_000, input: null, stop: stop.signal });
    stop.abort();
    expect(await pending).toBeNull();
  });

  test("the fallback link carries the name, the home page and every permission, and no webhook", () => {
    const u = new URL(newAppLink("https://github.example", "acme co", { ...manifest, default_permissions: { contents: "write", statuses: "read" } }));
    expect(u.origin + u.pathname).toBe("https://github.example/organizations/acme%20co/settings/apps/new");
    expect(Object.fromEntries(u.searchParams)).toEqual({ name: manifest.name, url: manifest.url, webhook_active: "false", public: "false", contents: "write", statuses: "read" });
  });

  test("gives up after the timeout", async () => {
    await expect(browserManifestCode(spec, manifest, { web: "https://github.example", out: () => {}, timeoutMs: 20, input: null })).rejects.toThrow(/no App was created/);
  });
});

describe("expected permissions", () => {
  test("each App's token permissions are what tick.yml requests, and its registration adds metadata only", () => {
    const c = exampleConfig();
    const tick = renderTick(c);
    const steps = tick.split(/\n(?=      - name: )/);
    const requested = (secret: string) =>
      Object.fromEntries(
        [...(steps.find((s) => s.includes(`secrets.${secret}_CLIENT_ID`)) ?? "").matchAll(/permission-([a-z-]+): (\w+)/g)].map((m) => [m[1]!.replace(/-/g, "_"), m[2]!]),
      );
    for (const s of appSpecs(c, "acme")) {
      expect(s.tokenPermissions).toEqual(requested(s.secret));
      expect(s.permissions).toEqual({ ...s.tokenPermissions, metadata: "read" });
    }
  });
});

describe("the App JWT", () => {
  test("is RS256, issued by the client id, valid for at most ten minutes", () => {
    const { generateKeyPairSync, verify } = require("node:crypto") as typeof import("node:crypto");
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt("Iv1.abc", privateKey.export({ type: "pkcs1", format: "pem" }).toString(), 1_800_000_000_000);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(payload).toEqual({ iss: "Iv1.abc", iat: 1_800_000_000 - 60, exp: 1_800_000_000 + 540 });
    expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });
});

describe("target rulesets", () => {
  test("with the epoch fence on: one write ruleset per epoch branch, each with its own App, and one integrity ruleset with no bypass", async () => {
    const { parseConfig } = await import("../src/config/load");
    const { readFileSync } = await import("node:fs");
    const { targetRulesets } = await import("../src/setup/expected");
    const text = readFileSync(EXAMPLE, "utf8").replace(/\nrunner:\n/, "\nrunner:\n  epochFence: true\n");
    const c = parseConfig(text);
    const p = c.runner.epochPrefix;
    const byName = Object.fromEntries(targetRulesets(c, true).map((r) => [r.name, r]));
    expect(byName["epoch-write-queue"]).toMatchObject({ include: [`refs/heads/${p}queue`], bypass: ["queue"], extraBypass: "none" });
    expect(byName["epoch-write-release"]).toMatchObject({ include: [`refs/heads/${p}release`], bypass: ["release"], extraBypass: "none" });
    expect(byName["epoch-integrity"]).toMatchObject({ bypass: [], rules: [{ type: "non_fast_forward" }, { type: "deletion" }] });
    // Without --apply-target-rulesets, only queue-refs.
    expect(targetRulesets(c, false).map((r) => r.name)).toEqual(["queue-refs"]);
  });
});

describe("ruleset reconciliation only tightens", () => {
  const spec = {
    repo: { owner: "o", name: "r" },
    name: "main-landing",
    include: ["refs/heads/main"],
    rules: [
      { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } },
      { type: "required_status_checks", parameters: { required_status_checks: [{ context: "fast" }], strict_required_status_checks_policy: false } },
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
    ],
    bypass: ["queue" as const],
    extraBypass: "keep" as const,
    needsInstalled: ["queue" as const],
  };
  const live = (o: { rules: { type: string; parameters?: Record<string, unknown> }[]; bypass?: { actor_id: number | null; actor_type: string; bypass_mode: string }[] }) => ({
    id: 1,
    name: "main-landing",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
    rules: o.rules,
    bypass_actors: o.bypass ?? [{ actor_id: 9, actor_type: "Integration", bypass_mode: "always" }],
  });

  test("stricter live settings are kept and are not differences", async () => {
    const { rulesetBody, rulesetDiff } = await import("../src/setup/rulesets");
    const have = live({
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 3, dismiss_stale_reviews_on_push: true, require_code_owner_review: true, require_last_push_approval: false, required_review_thread_resolution: false } },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "fast", integration_id: null }, { context: "producer", integration_id: 42 }], strict_required_status_checks_policy: true } },
        { type: "update", parameters: { update_allows_fetch_and_merge: false } },
        { type: "required_linear_history" },
      ],
    });
    expect(rulesetDiff(spec, have, { queue: 9 })).toEqual([]);
    const body = rulesetBody(spec, have, { queue: 9 });
    expect(body.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ required_approving_review_count: 3, require_code_owner_review: true });
    expect(body.rules.find((r) => r.type === "required_status_checks")!.parameters).toEqual(have.rules[1]!.parameters!);
    expect(body.rules.some((r) => r.type === "required_linear_history")).toBe(true);
  });

  test("weaker live settings are raised; a fresh pull_request rule gets every parameter GitHub requires", async () => {
    const { rulesetBody, rulesetDiff } = await import("../src/setup/rulesets");
    const have = live({
      rules: [
        { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false } },
        { type: "required_status_checks", parameters: { required_status_checks: [{ context: "other" }], strict_required_status_checks_policy: false } },
        { type: "update", parameters: { update_allows_fetch_and_merge: true } },
      ],
    });
    expect(rulesetDiff(spec, have, { queue: 9 })).toHaveLength(4);
    const body = rulesetBody(spec, have, { queue: 9 });
    expect(body.rules.find((r) => r.type === "update")!.parameters).toEqual({ update_allows_fetch_and_merge: false });
    expect((body.rules.find((r) => r.type === "required_status_checks")!.parameters as { required_status_checks: { context: string }[] }).required_status_checks.map((c) => c.context)).toEqual(["other", "fast"]);
    const fresh = rulesetBody(spec, null, { queue: 9 }).rules.find((r) => r.type === "pull_request")!.parameters!;
    expect(Object.keys(fresh).sort()).toEqual(["dismiss_stale_reviews_on_push", "require_code_owner_review", "require_last_push_approval", "required_approving_review_count", "required_review_thread_resolution"]);
  });

  test("on a landing ruleset only individual people are kept as bypass; roles, teams and other Apps are removed", async () => {
    const { rulesetBody, rulesetDiff } = await import("../src/setup/rulesets");
    const bypass = [
      { actor_id: 9, actor_type: "Integration", bypass_mode: "always" },
      { actor_id: 7, actor_type: "User", bypass_mode: "always" },
      { actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: 5, actor_type: "Integration", bypass_mode: "always" },
    ];
    const have = live({ rules: rulesetBody(spec, null, { queue: 9 }).rules, bypass });
    expect(rulesetDiff(spec, have, { queue: 9 })).toEqual(["unexpected bypass actor: RepositoryRole 4", "unexpected bypass actor: Integration 5"]);
    expect(rulesetBody(spec, have, { queue: 9 }).bypass_actors.map((a) => `${a.actor_type} ${a.actor_id}`)).toEqual(["Integration 9", "User 7"]);
  });

  test("release-landing has no update restriction (a person merges a release PR)", () => {
    const { targetRulesets } = require("../src/setup/expected") as typeof import("../src/setup/expected");
    const rl = targetRulesets(exampleConfig(), true).find((r) => r.name === "release-landing")!;
    expect(rl.rules.map((r) => r.type)).not.toContain("update");
  });

  test("main-integrity asks for signatures except with linear landing's author mode, whose commits are unsigned", () => {
    const { targetRulesets } = require("../src/setup/expected") as typeof import("../src/setup/expected");
    const c = exampleConfig();
    const integrity = (cfg: typeof c) => targetRulesets(cfg, true).find((r) => r.name === "main-integrity")!.rules.map((r) => r.type);
    expect(integrity(c)).toEqual(["required_signatures", "non_fast_forward", "deletion"]);
    const linear = (author: "app" | "author") => ({ ...c, config: { ...c.config, landing: { mode: "linear" as const, body: "b", author, maxRefusals: 3 } } });
    expect(integrity(linear("app"))).toEqual(["required_signatures", "non_fast_forward", "deletion"]);
    expect(integrity(linear("author"))).toEqual(["non_fast_forward", "deletion"]);
  });
});

describe("key custody and symlinks", () => {
  test("a key directory reached through a symlink into a git work tree is refused", () => {
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    const repo = mkdtempSync(join(tmpdir(), "setup-repo-"));
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "keys"), { mode: 0o700 });
    const outside = mkdtempSync(join(tmpdir(), "setup-link-"));
    symlinkSync(join(repo, "keys"), join(outside, "keys"));
    expect(() => new DirKeyStore(join(outside, "keys"))).toThrow(/inside the git work tree/);
    expect(() => new DirKeyStore(join(outside, "keys", "deeper"))).toThrow(/inside the git work tree/);
  });

  test("a key file that is a symlink is refused", () => {
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    const s = new DirKeyStore(freshKeysDir());
    const elsewhere = join(freshKeysDir(), "k.pem");
    writeFileSync(elsewhere, PEM, { mode: 0o600 });
    symlinkSync(elsewhere, s.pathFor("acme-queue"));
    expect(() => s.read("acme-queue")).toThrow(/symlink/);
  });

  test("in plan mode a missing directory is not created", () => {
    const dir = join(freshKeysDir(), "later");
    const s = new DirKeyStore(dir, false);
    expect(s.read("acme-queue")).toBeNull();
    expect(require("node:fs").existsSync(dir)).toBe(false);
  });
});

describe("App name length", () => {
  const spec = (name: string) => ({ name }) as Parameters<typeof tooLongAppNames>[0][number];
  test("a name at GitHub's limit passes; one over is named", () => {
    const fits = "a".repeat(MAX_APP_NAME);
    const over = "a".repeat(MAX_APP_NAME + 1);
    expect(tooLongAppNames([spec(fits)])).toEqual([]);
    expect(tooLongAppNames([spec(fits), spec(over)])).toEqual([over]);
  });
});
