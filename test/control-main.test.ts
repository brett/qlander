// A configured control-main protection (`control.mainProtection`): the
// loader's defaults and limits, audit C5's verdicts under a lighter rule, and
// setup's control step neither tightening nor weakening that rule.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runAudit } from "../src/audit/command";
import { auditExitCode } from "../src/audit/types";
import { type ControlMainProtection, ConfigError, type LoadedConfig, parseConfig, STRICT_CONTROL_MAIN } from "../src/config/load";
import { runSetup } from "../src/setup/command";
import { policyHash } from "../src/queue";
import { acmeConfig, C_REPO, fakeGh, lines, type Routes, world as auditWorld } from "./audit-fake";
import type { FakeRuleset } from "./fake-github-setup";
import { exampleConfig, installAll, world as setupWorld } from "./setup-world";

const ACME_YAML = readFileSync(`${import.meta.dir}/fixtures/acme.qlander.yml`, "utf8");
const LIGHT: ControlMainProtection = { requiredApprovals: 0, dismissStaleReviews: false, lastPushApproval: false, signedCommits: false };

/** The fixture with a mainProtection block under control. */
function withProtection(block: string): string {
  const out = ACME_YAML.replace(/^(control:\n  repo: .*\n  repoId: .*\n)/m, `$1  mainProtection:\n${block}`);
  if (out === ACME_YAML) throw new Error("control block not found");
  return out;
}

describe("the config", () => {
  test("absent, every parameter is the strict default; each key overrides only itself", () => {
    expect(parseConfig(ACME_YAML).controlMain).toEqual(STRICT_CONTROL_MAIN);
    expect(parseConfig(withProtection("    requiredApprovals: 0\n")).controlMain).toEqual({ ...STRICT_CONTROL_MAIN, requiredApprovals: 0 });
    const light = parseConfig(withProtection("    requiredApprovals: 0\n    dismissStaleReviews: false\n    lastPushApproval: false\n    signedCommits: false\n"));
    expect(light.controlMain).toEqual(LIGHT);
  });

  test("it is not policy: the policy hash is the same with or without it", () => {
    const light = parseConfig(withProtection("    requiredApprovals: 0\n    signedCommits: false\n"));
    expect(policyHash(light.config)).toBe(policyHash(parseConfig(ACME_YAML).config));
  });

  test("a fractional count, more than GitHub allows, or an unknown key is refused", () => {
    const problems = (text: string) => {
      try {
        parseConfig(text);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as ConfigError).problems.join("\n");
      }
      throw new Error("accepted");
    };
    expect(problems(withProtection("    requiredApprovals: 1.5\n"))).toContain("control.mainProtection.requiredApprovals");
    expect(problems(withProtection("    requiredApprovals: 11\n"))).toContain("control.mainProtection.requiredApprovals: at most 10");
    expect(problems(withProtection("    bypassActors: true\n"))).toContain("bypassActors");
  });
});

// ------------------------------------------------------------------ audit C5

const C = C_REPO;
const audit = (routes: Routes, cfg: LoadedConfig) => runAudit(fakeGh(routes), cfg, "control", {});
const withMain = (m: ControlMainProtection): LoadedConfig => ({ ...acmeConfig(), controlMain: m });
/** A lighter control main: a PR with no review, required checks, no force push or deletion, no bypass. */
const lightRules = () => [
  { type: "deletion" },
  { type: "non_fast_forward" },
  { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_last_push_approval: false, allowed_merge_methods: ["merge", "squash", "rebase"] } },
  { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "unit tests" }] } },
];
const lightWorld = () => {
  const r = auditWorld();
  (r[`${C}/rulesets/5`] as { rules: unknown[] }).rules = lightRules();
  return r;
};

describe("audit C5 with a configured lighter rule", () => {
  test("the strict default still FAILs the lighter ruleset, once per missing parameter", async () => {
    expect(lines(await audit(lightWorld(), acmeConfig()), "C5").filter((l) => l.startsWith("FAIL"))).toEqual([
      "FAIL main: required_approving_review_count >= 1: not set by any active ruleset",
      "FAIL main: dismiss_stale_reviews_on_push: not set by any active ruleset",
      "FAIL main: require_last_push_approval: not set by any active ruleset",
      "FAIL main: required_signatures: not set by any active ruleset",
    ]);
  });

  test("configured to match it: no FAIL, and a WARN naming each relaxed key", async () => {
    const f = (await audit(lightWorld(), withMain(LIGHT))).filter((x) => x.id === "C5");
    expect(f.map((x) => `${x.status} ${x.message}`)).toEqual([
      'PASS main: pull_request is required ("main")',
      "WARN main: required_approving_review_count >= 1: not set; accepted by control.mainProtection.requiredApprovals: 0",
      "WARN main: dismiss_stale_reviews_on_push: not set; accepted by control.mainProtection.dismissStaleReviews: false",
      "WARN main: require_last_push_approval: not set; accepted by control.mainProtection.lastPushApproval: false",
      "WARN main: required_signatures: not set; accepted by control.mainProtection.signedCommits: false",
      "PASS main: non_fast_forward",
      "PASS main: deletion",
      "PASS main: no bypass actors",
    ]);
    expect(f.find((x) => x.status === "WARN")!.fix).toBe("to require it, remove that key and run setup --step control --apply");
  });

  test("a relaxed parameter the ruleset holds anyway is a PASS", async () => {
    expect(lines(await audit(auditWorld(), withMain(LIGHT)), "C5").every((l) => l.startsWith("PASS"))).toBe(true);
  });

  test("what is never configurable still FAILs: the pull request, force pushes, deletion, bypass actors", async () => {
    const r = lightWorld();
    const rs = r[`${C}/rulesets/5`] as { rules: { type: string }[]; bypass_actors: unknown[] };
    rs.rules = rs.rules.filter((x) => x.type !== "deletion" && x.type !== "pull_request");
    rs.bypass_actors = [{ actor_id: 1, actor_type: "User", bypass_mode: "always" }];
    expect(lines(await audit(r, withMain(LIGHT)), "C5").filter((l) => l.startsWith("FAIL"))).toEqual([
      "FAIL main: pull_request is required: not set by any active ruleset",
      "FAIL main: deletion: not set by any active ruleset",
      'FAIL main: bypass actors on "main"',
    ]);
  });

  test("a configured relaxation exits 0: its WARNs aren't failed reads", async () => {
    const f = await audit(lightWorld(), withMain(LIGHT));
    expect(f.filter((x) => x.inconclusive)).toEqual([]);
    expect(f.some((x) => x.status === "WARN")).toBe(true);
    expect(auditExitCode(f)).toBe(0);
  });

  test("a mixed config: only the relaxed parameter is a WARN, the rest still FAIL", async () => {
    const f = lines(await audit(lightWorld(), withMain({ ...STRICT_CONTROL_MAIN, requiredApprovals: 0 })), "C5").filter((l) => !l.startsWith("PASS"));
    expect(f).toEqual([
      "WARN main: required_approving_review_count >= 1: not set; accepted by control.mainProtection.requiredApprovals: 0",
      "FAIL main: dismiss_stale_reviews_on_push: not set by any active ruleset",
      "FAIL main: require_last_push_approval: not set by any active ruleset",
      "FAIL main: required_signatures: not set by any active ruleset",
    ]);
  });

  test("a config may ask for more approvals than the default", async () => {
    const f = lines(await audit(auditWorld(), withMain({ ...STRICT_CONTROL_MAIN, requiredApprovals: 2 })), "C5");
    expect(f).toContain("FAIL main: required_approving_review_count >= 2: not set by any active ruleset");
  });
});

// ------------------------------------------------------- setup --step control

const CONTROL_MAIN = "qlander-control-main";

async function setUp(c: LoadedConfig) {
  const w = setupWorld(c);
  w.operator = () => installAll(w.f, w.specs);
  expect(await runSetup(w.deps(), ["apps", "install"])).toBe(0);
  const n = c.config.names;
  return { w, repo: w.f.repo(`${n.control.owner}/${n.control.name}`) };
}

/** An existing control main ruleset, as an operator configured it by hand. */
function seed(repo: { rulesets: Map<number, FakeRuleset> }, rules: FakeRuleset["rules"]): FakeRuleset {
  const rs: FakeRuleset = { id: 9001, name: CONTROL_MAIN, target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } }, rules, bypass_actors: [] };
  repo.rulesets.set(rs.id, structuredClone(rs));
  return rs;
}

const PR_DEFAULTS = { require_code_owner_review: false, required_review_thread_resolution: false };

describe("setup's control step with a configured lighter rule", () => {
  const light = (): LoadedConfig => ({ ...exampleConfig(), controlMain: LIGHT });

  test("leaves a matching lighter ruleset exactly as it is", async () => {
    const { w, repo } = await setUp(light());
    const before = seed(repo, lightRules().map((r) => (r.type === "pull_request" ? { ...r, parameters: { ...PR_DEFAULTS, ...r.parameters } } : r)));
    const mutations = w.f.mutations.length;
    w.out.length = 0;
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    expect(w.f.mutations.slice(mutations).filter((m) => m.includes(CONTROL_MAIN))).toEqual([]);
    expect(repo.rulesets.get(before.id)).toEqual(before);
  });

  test("an update it does make keeps every stricter setting and other rule already there", async () => {
    const { w, repo } = await setUp(light());
    const rs = seed(repo, [
      { type: "pull_request", parameters: { ...PR_DEFAULTS, required_approving_review_count: 2, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true } },
      { type: "required_signatures" },
      { type: "non_fast_forward" },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "unit tests" }] } },
    ]); // no deletion rule: setup must update it
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    const fixed = repo.rulesets.get(rs.id)!;
    expect(fixed.rules.map((r) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "pull_request", "required_signatures", "required_status_checks"]);
    expect(fixed.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ required_approving_review_count: 2, dismiss_stale_reviews_on_push: true, require_last_push_approval: true, required_review_thread_resolution: true });
    expect(fixed.rules.find((r) => r.type === "required_status_checks")).toMatchObject(rs.rules[3]!);
  });

  test("a mixed config relaxes only what it names", async () => {
    const mixed = { ...STRICT_CONTROL_MAIN, requiredApprovals: 0 };
    const { w, repo } = await setUp({ ...exampleConfig(), controlMain: mixed });
    const rs = seed(repo, lightRules().map((r) => (r.type === "pull_request" ? { ...r, parameters: { ...PR_DEFAULTS, ...r.parameters } } : r)));
    w.out.length = 0;
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    expect(w.out).toContain("        rule pull_request: require_last_push_approval is false, needs true");
    expect(w.out.some((l) => l.includes("required_approving_review_count"))).toBe(false);
    expect(repo.rulesets.get(rs.id)!.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_last_push_approval: true });
  });

  test("never weakens a ruleset stricter than the config asks", async () => {
    const { w, repo } = await setUp(light());
    const strict = seed(repo, [
      { type: "pull_request", parameters: { ...PR_DEFAULTS, required_approving_review_count: 2, dismiss_stale_reviews_on_push: true, require_last_push_approval: true } },
      { type: "required_signatures" },
      { type: "non_fast_forward" },
      { type: "deletion" },
    ]);
    const mutations = w.f.mutations.length;
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    expect(w.f.mutations.slice(mutations).filter((m) => m.includes(CONTROL_MAIN))).toEqual([]);
    expect(repo.rulesets.get(strict.id)).toEqual(strict);
  });

  test("still adds what is never configurable, keeping the relaxed parameters as they were", async () => {
    const { w, repo } = await setUp(light());
    const rs = seed(repo, [{ type: "pull_request", parameters: { ...PR_DEFAULTS, required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_last_push_approval: false } }]);
    w.out.length = 0;
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    expect(w.out).toContain("        rule non_fast_forward is missing");
    expect(w.out).toContain("        rule deletion is missing");
    expect(w.out.some((l) => l.includes("required_signatures") || l.includes("needs true") || l.includes("needs 1"))).toBe(false);
    const fixed = repo.rulesets.get(rs.id)!;
    expect(fixed.rules.map((r) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "pull_request"]);
    expect(fixed.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_last_push_approval: false });
  });

  test("creates a missing ruleset at the configured level", async () => {
    const { w, repo } = await setUp(light());
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    const rs = [...repo.rulesets.values()].find((r) => r.name === CONTROL_MAIN)!;
    expect(rs.rules.map((r) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "pull_request"]);
    expect(rs.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_last_push_approval: false });
    expect(rs.bypass_actors).toEqual([]);
  });

  test("the strict default still tightens the lighter ruleset", async () => {
    const { w, repo } = await setUp(exampleConfig());
    const rs = seed(repo, lightRules().map((r) => (r.type === "pull_request" ? { ...r, parameters: { ...PR_DEFAULTS, ...r.parameters } } : r)));
    w.out.length = 0;
    expect(await runSetup(w.deps(), ["control"])).toBe(0);
    expect(w.out).toContain("        rule required_signatures is missing");
    const fixed = repo.rulesets.get(rs.id)!;
    expect(fixed.rules.find((r) => r.type === "pull_request")!.parameters).toMatchObject({ required_approving_review_count: 1, dismiss_stale_reviews_on_push: true, require_last_push_approval: true });
    expect(fixed.rules.some((r) => r.type === "required_signatures")).toBe(true);
    expect(fixed.rules.some((r) => r.type === "required_status_checks")).toBe(true); // other rules are kept
  });
});
