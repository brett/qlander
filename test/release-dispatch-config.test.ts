// release.mode and release.dispatch (DESIGN.md §8.1, §12.1): the loader's
// defaults and refusals, the release App's extra permission in dispatch mode
// only, and that tick.yml, setup and audit all agree on it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { appChecks, type AppIdentity, EXPECTED_PERMISSIONS, expectedPermissions } from "../src/audit/apps";
import type { AuditGh } from "../src/audit/types";
import { ConfigError, parseConfig } from "../src/config/load";
import { policyHash } from "../src/queue";
import { releaseTokenPermissions } from "../src/release-permissions";
import { renderTick } from "../src/render";
import { appSpecs, targetRulesets } from "../src/setup/expected";
import { qlanderAppsAsExtra, rulesetBody, rulesetDiff } from "../src/setup/rulesets";
import { branchRulesets } from "../src/audit/ruleset-checks";
import { policySet } from "../src/audit/policy-coverage";
import { EXAMPLE } from "./setup-world";

const base = readFileSync(EXAMPLE, "utf8");
const DISPATCH = [
  "  mode: dispatch",
  "  dispatch:",
  "    workflow: .github/workflows/promote.yml",
  "    inputs:",
  "      sha: sha",
  "      dryRun: dry_run",
  "      dispatchId: dispatch_id",
  "    actor:",
  "      login: acme-release[bot]",
  "      id: 90000001",
  "    approvers:",
  "      - login: alice",
  "        id: 1001",
];
/** The example config with lines added at the end of its release block (before watchdog:). */
const withRelease = (lines: string[]) => base.replace(/\nwatchdog:/, `\n${lines.join("\n")}\n\nwatchdog:`);
const problems = (text: string): string[] => {
  try {
    parseConfig(text);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.problems;
    throw e;
  }
};

describe("release.mode", () => {
  test("absent: advance, no dispatch block, and the release App keeps its advance permissions", () => {
    const c = parseConfig(base);
    expect(c.release.mode).toBe("advance");
    expect(c.release.dispatch).toBeNull();
    expect(releaseTokenPermissions(c.release, false)).toEqual({ contents: "write", workflows: "write", actions: "read", checks: "read", statuses: "read" });
  });

  test("dispatch: the block with its defaults filled in", () => {
    const c = parseConfig(withRelease(DISPATCH));
    expect(c.release.mode).toBe("dispatch");
    expect(c.release.dispatch).toEqual({
      workflow: ".github/workflows/promote.yml",
      ref: c.config.names.main,
      inputs: { sha: "sha", dryRun: "dry_run", dispatchId: "dispatch_id" },
      approvers: [{ login: "alice", id: 1001 }],
      actor: { login: "acme-release[bot]", id: 90000001 },
      promoterApps: [],
      dryRunValidMinutes: 1440,
      appearMinutes: 30,
      runHours: 6,
      observeMinutes: 60,
      budget: { window: 8, windowHours: 24 },
      freeze: [],
    });
  });

  test("not policy: the queue's policy hash is the same in either mode", () => {
    expect(policyHash(parseConfig(withRelease(DISPATCH)).config)).toBe(policyHash(parseConfig(base).config));
  });

  test.each([
    ["dispatch without its block", ["  mode: dispatch"], /release.dispatch is required/],
    ["the block without the mode", DISPATCH.slice(1), /release.mode is not dispatch/],
    ["a ref that is neither main nor release", [...DISPATCH, "    ref: develop"], /release.dispatch.ref must be/],
    ["an input name used twice", DISPATCH.map((l) => l.replace("dispatchId: dispatch_id", "dispatchId: sha")), /inputs: sha is used twice/],
    ["no approver", DISPATCH.slice(0, 10).concat(["    approvers: []"]), /needs at least 1/],
    ["no actor", DISPATCH.filter((l, i) => i < 7 || i > 9), /missing actor/],
    ["the GitHub Actions App as the promoter", [...DISPATCH, "    promoterApps:", "      - 15368"], /must not include the GitHub Actions App/],
    ["the job's own bot as an approver", [...DISPATCH, "      - login: acme-release[bot]", "        id: 90000001"], /must not include release.dispatch.actor/],
    ["an approver listed twice", [...DISPATCH, "      - login: alice", "        id: 1001"], /login alice is listed twice/],
    ["appearMinutes under two cron intervals", [...DISPATCH, "    appearMinutes: 5"], /appearMinutes \(5\) must be at least twice/],
    ["a GITHUB_ freeze variable", [...DISPATCH, "    freeze:", "      - variable: GITHUB_FREEZE", "        value: \"1\""], /GITHUB_/],
    ["a bad input name", DISPATCH.map((l) => l.replace("sha: sha", "sha: 'a b'")), /inputs.sha: must match/],
    ["an unknown key", [...DISPATCH, "    retries: 2"], /retries: unknown key/],
  ])("refused: %s", (_, lines, re) => {
    expect(problems(withRelease(lines)).some((p) => re.test(p))).toBe(true);
  });

  test("the dispatched workflow must be inside queue.policy.paths: a change to it is a CI-policy change", () => {
    const c = parseConfig(withRelease(DISPATCH));
    expect(c.config.policyBoundary.some((g) => new Bun.Glob(g).match(".github/workflows/promote.yml"))).toBe(true);
  });
});

describe("the release App's permissions in dispatch mode: least privilege", () => {
  const FREEZE = [...DISPATCH, "    freeze:", "      - variable: RELEASE_FREEZE", "        value: \"true\""];
  test("Actions: write and Contents: read, no Workflows; Contents: write only for the epoch fence; Variables: read only with a freeze", () => {
    const d = parseConfig(withRelease(DISPATCH));
    expect(releaseTokenPermissions(d.release, false)).toEqual({ contents: "read", actions: "write", checks: "read", statuses: "read" });
    expect(releaseTokenPermissions(d.release, true)).toEqual({ contents: "write", actions: "write", checks: "read", statuses: "read" });
    expect(releaseTokenPermissions(parseConfig(withRelease(FREEZE)).release, false)).toMatchObject({ actions: "write", actions_variables: "read" });
    expect(expectedPermissions("queue", d.release)).toEqual(EXPECTED_PERMISSIONS.queue);
    expect(expectedPermissions("state", d.release)).toEqual(EXPECTED_PERMISSIONS.state);
    expect(expectedPermissions("release", parseConfig(base).release)).toEqual(EXPECTED_PERMISSIONS.release);
  });

  test("tick.yml requests them, setup registers them, and audit expects them", () => {
    for (const c of [parseConfig(withRelease(DISPATCH)), parseConfig(withRelease(FREEZE))]) {
      const tick = renderTick(c);
      const step = tick.split(/\n(?=      - name: )/).find((s) => s.includes("secrets.RELEASE_APP_CLIENT_ID"))!;
      const requested = Object.fromEntries([...step.matchAll(/permission-([a-z-]+): (\w+)/g)].map((m) => [m[1]!.replace(/-/g, "_"), m[2]!]));
      const spec = appSpecs(c, "acme").find((s) => s.role === "release")!;
      expect(requested).toEqual(spec.tokenPermissions);
      expect(spec.permissions).toEqual(expectedPermissions("release", c.release, c.runner.epochFence));
      expect(spec.permissions).toMatchObject({ actions: "write", contents: c.runner.epochFence ? "write" : "read" });
      expect(spec.permissions.workflows).toBeUndefined();
      expect(appSpecs(c, "acme").find((s) => s.role === "queue")!.permissions).toEqual(EXPECTED_PERMISSIONS.queue);
    }
  });

  test("audit fails a release App with the advance permissions in dispatch mode, passes the least-privilege set, and checks the bot account", async () => {
    const c = parseConfig(withRelease(DISPATCH));
    const gh = {
      get: async (path: string) => (path === "users/acme-release%5Bbot%5D" ? { id: 90000001 } : {}),
      list: async () => ({ items: [], truncated: false }),
    } as unknown as AuditGh;
    const app = (permissions: Record<string, string>, slug = "acme-release"): AppIdentity => ({ role: "release", slug, id: 7, permissions });
    const old = await appChecks(gh, "acme", [app(EXPECTED_PERMISSIONS.release)], "T11", c.release, false);
    const failed = old.find((f) => f.status === "FAIL" && f.message.includes("registration"));
    expect(failed?.message).toContain("for release.mode dispatch");
    expect(failed?.details).toEqual(["actions: read, expected write", "contents: write, expected read", "workflows: write, not expected"]);
    const ok = await appChecks(gh, "acme", [app(expectedPermissions("release", c.release))], "T11", c.release, false);
    expect(ok.slice(0, 2).map((f) => f.status)).toEqual(["PASS", "PASS"]);
    expect(ok[0]!.message).toContain("release.dispatch.actor is the release App's bot acme-release[bot]");
    const wrongBot = await appChecks(gh, "acme", [app(expectedPermissions("release", c.release), "other-release")], "T11", c.release, false);
    expect(wrongBot[0]).toMatchObject({ status: "FAIL", message: expect.stringContaining("not the release App's bot other-release[bot]") });
    // And in advance mode, the dispatch set is wrong too.
    const adv = await appChecks(gh, "acme", [app(expectedPermissions("release", c.release))], "T11", parseConfig(base).release);
    expect(adv[0]!.status).toBe("FAIL");
  });

  const PROMOTER = 424242;
  const PROMOTED = [...DISPATCH, "    promoterApps:", `      - ${PROMOTER}`];

  test("setup makes the promote App and named users the only bypass actors on release, never the release App, a role or a team", () => {
    const d = parseConfig(withRelease(PROMOTED));
    const spec = targetRulesets(d, true).find((r) => r.name === "release-landing")!;
    expect(spec).toMatchObject({ bypass: [], extraBypass: "keep", apps: [PROMOTER] });
    expect(targetRulesets(parseConfig(base), true).find((r) => r.name === "release-landing")).toMatchObject({ bypass: ["release"], extraBypass: "keep" });
    const ids = { queue: 1, release: 2, state: 3 };
    const live = { id: 9, name: "release-landing", target: "branch", enforcement: "active", conditions: { ref_name: { include: spec.include, exclude: [] } }, rules: spec.rules, bypass_actors: [
      { actor_id: 2, actor_type: "Integration", bypass_mode: "pull_request" },
      { actor_id: 444, actor_type: "Integration", bypass_mode: "always" },
      { actor_id: 4, actor_type: "RepositoryRole", bypass_mode: "always" },
      { actor_id: 7, actor_type: "Team", bypass_mode: "always" },
      { actor_id: 55, actor_type: "User", bypass_mode: "always" },
    ] } as never;
    expect(rulesetDiff(spec, live, ids).sort()).toEqual([
      `bypass actor missing: App ${PROMOTER} (release.dispatch.promoterApps)`,
      "unexpected bypass actor: Integration 2",
      "unexpected bypass actor: Integration 444",
      "unexpected bypass actor: RepositoryRole 4",
      "unexpected bypass actor: Team 7",
    ]);
    expect(rulesetBody(spec, live, ids).bypass_actors.map((a) => `${a.actor_type} ${a.actor_id}`)).toEqual([`Integration ${PROMOTER}`, "User 55"]);
  });

  test("audit, dispatch mode: the release App in any bypass mode fails; so do roles, teams and Apps not configured; the promote App and named users pass", () => {
    const app: AppIdentity = { role: "release", slug: "acme-release", id: 2, permissions: {} };
    const rs = (actors: { actor_id: number; actor_type: string; bypass_mode?: string }[]) => ({
      rulesets: [{ id: 1, name: "release-landing", enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/release"] } }, rules: [{ type: "pull_request" }], bypass_actors: actors.map((a) => ({ bypass_mode: "always", ...a })) }],
      admin: true,
      defaultBranch: "main",
      appNames: new Map([[2, "acme-release"]]),
    }) as never;
    const check = (actors: Parameters<typeof rs>[0]) => branchRulesets("T10", "release", app, rs(actors), undefined, true, { appMustNotBypass: true, promoterApps: [PROMOTER] });
    const failed = (fs: ReturnType<typeof check>, text: string) => fs.some((f) => f.status === "FAIL" && f.message.includes(text));
    expect(failed(check([{ actor_id: 2, actor_type: "Integration", bypass_mode: "pull_request" }]), "release.mode dispatch forbids")).toBe(true);
    expect(failed(check([{ actor_id: 2, actor_type: "Integration" }]), "release.mode dispatch forbids")).toBe(true);
    expect(failed(check([{ actor_id: 4, actor_type: "RepositoryRole" }]), "other than release.dispatch.promoterApps")).toBe(true);
    expect(failed(check([{ actor_id: 7, actor_type: "Team" }]), "other than release.dispatch.promoterApps")).toBe(true);
    expect(failed(check([{ actor_id: 444, actor_type: "Integration" }]), "other than release.dispatch.promoterApps")).toBe(true);
    const good = check([{ actor_id: PROMOTER, actor_type: "Integration" }, { actor_id: 55, actor_type: "User" }]);
    expect(good.some((f) => f.status === "PASS" && f.message.includes("not the release App"))).toBe(true);
    expect(good.some((f) => f.status === "FAIL" && f.message.includes("landing ruleset"))).toBe(false);
    // Advance mode is unchanged: the release App must be there.
    const adv = branchRulesets("T10", "release", app, rs([{ actor_id: 444, actor_type: "Integration" }]), undefined, true);
    expect(adv.some((f) => f.status === "FAIL" && f.message.includes("does not list the release App"))).toBe(true);
  });
  test("linear landing with dispatch: setup restricts updates on release, so only the bypass actors can move it; merge mode and advance mode do not", () => {
    const linear = (text: string) => text.replace(/\nqueue:\n/, "\nqueue:\n  landing:\n    mode: linear\n");
    const rules = (text: string) => targetRulesets(parseConfig(text), true).find((r) => r.name === "release-landing")!.rules;
    const d = rules(linear(withRelease(PROMOTED)));
    expect(d.find((r) => r.type === "update")).toEqual({ type: "update", parameters: { update_allows_fetch_and_merge: false } });
    expect(rules(withRelease(PROMOTED)).map((r) => r.type)).not.toContain("update");
    expect(rules(base).map((r) => r.type)).not.toContain("update");
    // The PR and checks rules stay, and the bypass is unchanged: the promote App and named users.
    expect(d.map((r) => r.type)).toEqual(["pull_request", "required_status_checks", "update"]);
    expect(targetRulesets(parseConfig(linear(withRelease(PROMOTED))), true).find((r) => r.name === "release-landing")).toMatchObject({ bypass: [], extraBypass: "keep", apps: [PROMOTER] });
  });

  test("audit, linear landing with dispatch: release must restrict updates, and each promote App must always bypass every ruleset that would stop it moving release", () => {
    const app: AppIdentity = { role: "release", slug: "acme-release", id: 2, permissions: {} };
    const ruleset = (id: number, name: string, rules: string[], actors: { actor_id: number; actor_type: string; bypass_mode?: string }[]) => ({ id, name, enforcement: "active", target: "branch", conditions: { ref_name: { include: ["refs/heads/release"] } }, rules: rules.map((type) => ({ type })), bypass_actors: actors });
    const ctx = (rulesets: unknown[]) => ({ rulesets, admin: true, defaultBranch: "main", appNames: new Map([[2, "acme-release"]]) }) as never;
    const integrity = ruleset(2, "release-integrity", ["required_signatures", "non_fast_forward", "deletion"], []);
    const promoter = { actor_id: PROMOTER, actor_type: "Integration", bypass_mode: "always" };
    const check = (rulesets: unknown[]) => branchRulesets("T10", "release", app, ctx(rulesets), undefined, false, { appMustNotBypass: true, promoterApps: [PROMOTER], promoterUpdates: true });
    const failed = (fs: ReturnType<typeof check>) => fs.filter((f) => f.status === "FAIL").map((f) => f.message);
    expect(failed(check([ruleset(1, "release-landing", ["pull_request", "required_status_checks", "update"], [promoter]), integrity]))).toEqual([]);
    expect(failed(check([ruleset(1, "release-landing", ["pull_request", "required_status_checks"], [promoter]), integrity]))).toEqual(["release: no active ruleset both restricts updates and requires a PR"]);
    expect(failed(check([ruleset(1, "release-landing", ["pull_request", "update"], [{ ...promoter, bypass_mode: "pull_request" }]), integrity]))).toEqual([`release: the promote App ${PROMOTER} (release.dispatch.promoterApps) cannot always bypass "release-landing", so it cannot move release`]);
    expect(failed(check([ruleset(1, "release-landing", ["pull_request", "update"], []), integrity]))).toEqual([`release: the promote App ${PROMOTER} (release.dispatch.promoterApps) cannot always bypass "release-landing", so it cannot move release`]);
    // Another ruleset that would stop the promote App's update, even when release-landing lets it through.
    const other = ruleset(3, "freeze-release", ["update"], [{ actor_id: 55, actor_type: "User", bypass_mode: "always" }]);
    expect(failed(check([ruleset(1, "release-landing", ["pull_request", "update"], [promoter]), integrity, other]))).toEqual([`release: the promote App ${PROMOTER} (release.dispatch.promoterApps) cannot always bypass "freeze-release", so it cannot move release`]);
    // An update rule that allows fetch and merge is weaker than what setup writes.
    const fetchMerge = { ...ruleset(1, "release-landing", ["pull_request"], [promoter]), rules: [{ type: "pull_request" }, { type: "update", parameters: { update_allows_fetch_and_merge: true } }] };
    expect(failed(check([fetchMerge, integrity]))).toEqual(['release: landing ruleset "release-landing" restricts updates but allows fetch and merge']);
    // Without an admin token the bypass lists are unread: SKIPPED, never a PASS.
    const noAdmin = branchRulesets("T10", "release", app, { ...(ctx([ruleset(1, "release-landing", ["pull_request", "update"], [promoter]), integrity]) as object), admin: false } as never, undefined, false, { appMustNotBypass: true, promoterApps: [PROMOTER], promoterUpdates: true });
    expect(noAdmin.filter((f) => f.message.includes("promote App")).map((f) => f.status)).toEqual(["SKIPPED"]);
  });

  test("[t2] setup refuses a promoterApps entry that is the release App (or any qlander App), in --plan too", () => {
    const d = parseConfig(withRelease([...DISPATCH, "    promoterApps:", "      - 2"]));
    const spec = targetRulesets(d, true).find((r) => r.name === "release-landing")!;
    expect(spec.needsInstalled).toEqual(["release"]); // so its id is known when setup checks
    const ids = { queue: 1, release: 2, state: 3 };
    expect(qlanderAppsAsExtra(spec, ids)).toEqual(["release.dispatch.promoterApps lists 2, which is the release App: in release.mode dispatch it must not bypass release-landing"]);
    expect(() => rulesetBody(spec, null, ids)).toThrow("which is the release App");
    const live = { id: 9, name: "release-landing", target: "branch", enforcement: "active", conditions: { ref_name: { include: spec.include, exclude: [] } }, rules: spec.rules, bypass_actors: [{ actor_id: 2, actor_type: "Integration", bypass_mode: "always" }] } as never;
    expect(rulesetDiff(spec, live, ids)).toContain("release.dispatch.promoterApps lists 2, which is the release App: in release.mode dispatch it must not bypass release-landing");
    expect(qlanderAppsAsExtra(spec, { queue: 1, release: 5, state: 3 })).toEqual([]);
  });
});

describe("policy coverage (T12)", () => {
  test("the dispatched promote workflow is in the policy set, so audit scans what it runs", () => {
    expect(policySet(parseConfig(base))).not.toContain(".github/workflows/promote.yml");
    expect(policySet(parseConfig(withRelease(DISPATCH)))).toContain(".github/workflows/promote.yml");
  });
});
