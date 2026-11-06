// `qlander audit`, target rules T1–T12 (docs/deployment.md §4.1): each
// rule passes on the fake world and fails (or warns) when its one
// requirement is broken.
import { describe, expect, test } from "bun:test";
import type { LoadedConfig } from "../src/config/load";
import { runAudit } from "../src/audit/command";
import { targetRulesets } from "../src/setup/expected";
import { rulesetBody } from "../src/setup/rulesets";
import { acmeConfig, app, BUILD_YML, CHECKS_YML, fakeGh, file, forbidden, lines, notFound, QUEUE_APP, RELEASE_APP, type Routes, statuses, T_REPO, user, world } from "./audit-fake";

const T = T_REPO;
const audit = (routes: Routes, cfg: LoadedConfig = acmeConfig()) => runAudit(fakeGh(routes), cfg, "target", {});
/** The world with one extra workflow file. */
const withWorkflow = (r: Routes, name: string, text: string) => {
  (r[`${T}/contents/.github/workflows`] as unknown[]).push({ type: "file", path: `.github/workflows/${name}` });
  r[`${T}/contents/.github/workflows/${name}`] = file(text);
  return r;
};
const releaseOn = (dryRun: boolean): LoadedConfig => {
  const c = acmeConfig();
  return { ...c, release: { ...c.release, enabled: true, dryRun } };
};

test("the fake world passes every target rule (only the documented SKIPPED lines remain)", async () => {
  const f = await audit(world());
  expect(f.filter((x) => x.status === "FAIL" || x.status === "WARN")).toEqual([]);
  expect(lines(f).filter((l) => l.startsWith("SKIPPED"))).toEqual([
    "SKIPPED epoch rulesets: not checked, runner.epochFence is off",
    "SKIPPED release advance is off (release.enabled: false)",
    "SKIPPED queue App widgets-control-queue: which repos each installation covers needs the App's JWT",
  ]);
});

describe("T1: pre-landing workflows run on every queue push", () => {
  test("missing on queue pushes", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace(', "mq/batch/**"', ""));
    expect(lines(await audit(r), "T1")).toEqual(["FAIL .github/workflows/build.yml does not run on a push to mq/batch/1"]);
  });
  test("a path filter fails unless the entry is if_triggered", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace('"mq/batch/**"]', '"mq/batch/**"]\n    paths: [src/**]'));
    expect(statuses(await audit(r), "T1")).toEqual(["FAIL"]);
    const c = acmeConfig();
    c.config.preLanding[0]!.when = "if_triggered";
    expect(statuses(await audit(r, c), "T1")).toEqual(["PASS"]);
  });
  test("a pre-landing workflow that does not exist", async () => {
    const r = world();
    delete r[`${T}/contents/.github/workflows/build.yml`];
    expect(lines(await audit(r), "T1")).toEqual(["FAIL .github/workflows/build.yml (pre-landing) does not exist on trunk"]);
  });
});

test("T2: a condition that singles out main without the queue prefix warns, with its line", async () => {
  const r = world();
  r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("  lint:\n    runs-on", "  lint:\n    if: github.ref == 'refs/heads/trunk'\n    runs-on"));
  const f = (await audit(r)).filter((x) => x.id === "T2");
  expect(f.map((x) => x.status)).toEqual(["WARN"]);
  expect(f[0]!.details).toEqual([".github/workflows/build.yml:15 jobs.lint.if: github.ref == 'refs/heads/trunk'"]);
  // naming the queue prefix too is a full-suite gate that accepts batches
  r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("  lint:\n    runs-on", "  lint:\n    if: github.ref == 'refs/heads/trunk' || startsWith(github.ref, 'refs/heads/mq/batch/')\n    runs-on"));
  expect(statuses(await audit(r), "T2")).toEqual(["PASS"]);
});

describe("T3: no workflow triggers on the build or epoch prefix, or on every push", () => {
  test("a workflow on the build prefix fails", async () => {
    const f = await audit(withWorkflow(world(), "x.yml", 'on:\n  push:\n    branches: ["mq/**"]\njobs: {}\n'));
    expect(lines(f, "T3")).toEqual(["FAIL .github/workflows/x.yml runs on a push to mq/build/1", "WARN .github/workflows/x.yml runs on queue pushes but is not in queue.preLanding"]);
  });
  test("an unfiltered push trigger fails", async () => {
    expect(lines(await audit(withWorkflow(world(), "x.yml", "on: push\njobs: {}\n")), "T3")).toEqual(["FAIL .github/workflows/x.yml has an unfiltered push trigger: every ref the queue creates or moves starts it"]);
  });
  test("the epoch prefix: FAIL with the fence on, WARN with it off", async () => {
    const r = withWorkflow(world(), "x.yml", 'on:\n  push:\n    branches: ["qlander-epoch/**"]\njobs: {}\n');
    expect(statuses(await audit(r), "T3")).toEqual(["WARN"]);
    const c = acmeConfig();
    const on = { ...c, runner: { ...c.runner, epochFence: true } };
    expect(lines(await audit(r, on), "T3")).toContain("FAIL .github/workflows/x.yml runs on a push to the epoch branch qlander-epoch/queue");
  });
  test("create and delete triggers warn", async () => {
    expect(lines(await audit(withWorkflow(world(), "x.yml", "on: [create]\njobs: {}\n")), "T3")).toEqual(["WARN .github/workflows/x.yml triggers on create, which fires for every branch the queue creates"]);
  });
});

test("T4: an environment, id-token or secret on a queue-push job without a main-only if warns", async () => {
  const r = world();
  const priv = BUILD_YML.replace(
    "  lint:\n    runs-on: ubuntu-latest\n",
    "  lint:\n    runs-on: ubuntu-latest\n    environment: deploy\n    permissions:\n      id-token: write\n    env:\n      KEY: ${{ secrets.DEPLOY_KEY }}\n",
  );
  r[`${T}/contents/.github/workflows/build.yml`] = file(priv);
  const f = (await audit(r)).filter((x) => x.id === "T4");
  expect(f.map((x) => x.status)).toEqual(["WARN"]);
  expect(f[0]!.details).toEqual([
    '.github/workflows/build.yml:14 job lint: environment "deploy"',
    ".github/workflows/build.yml:14 job lint: id-token: write",
    ".github/workflows/build.yml:14 job lint: secrets DEPLOY_KEY",
  ]);
  r[`${T}/contents/.github/workflows/build.yml`] = file(priv.replace("  lint:\n", "  lint:\n    if: github.ref == 'refs/heads/trunk'\n"));
  expect(statuses(await audit(r), "T4")).toEqual(["PASS"]);
});

test("T5: a first-parent diff baseline warns, with each line", async () => {
  const r = world();
  r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("run: ./build/lint.sh --all", "run: git diff HEAD^ HEAD"));
  const f = (await audit(r)).filter((x) => x.id === "T5");
  expect(f.map((x) => [x.status, x.details])).toEqual([["WARN", [".github/workflows/build.yml:17 - run: git diff HEAD^ HEAD"]]]);
});

describe("T6: the fast lane", () => {
  test("no job of that name", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/checks.yml`] = file(CHECKS_YML.replace("quick:", "fast:"));
    expect(lines(await audit(r), "T6")).toEqual(['FAIL .github/workflows/checks.yml has no job named exactly "quick"']);
  });
  test("not on pull_request into main", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/checks.yml`] = file(CHECKS_YML.replace("branches: [trunk]", "branches: [other]"));
    expect(lines(await audit(r), "T6")).toEqual(["FAIL .github/workflows/checks.yml does not run on pull_request for PRs into trunk"]);
  });
});

describe("T7: the newest green queue run against the manifest", () => {
  test("a run listing with no list is inconclusive, not no runs", async () => {
    const r = world();
    r[`${T}/actions/workflows/build.yml/runs`] = {};
    const f = (await audit(r)).filter((x) => x.id === "T7");
    expect(f.map((x) => [x.status, x.inconclusive])).toEqual([["WARN", true]]);
  });

  test("a required job missing, and an unlisted skip, each fail", async () => {
    const r = world();
    r[`${T}/actions/runs/501/jobs`] = { jobs: [{ id: 1, name: "unit", status: "completed", conclusion: "skipped" }] };
    const f = (await audit(r)).filter((x) => x.id === "T7");
    expect(f.map((x) => [x.status, x.details])).toEqual([["FAIL", ['required job "lint" is missing', 'job "unit" was skipped and is not in allow_skipped_jobs']]]);
  });
  test("no queue run yet: the newest main run is used; none at all warns", async () => {
    const r = world();
    r[`${T}/actions/workflows/build.yml/runs`] = { workflow_runs: [{ id: 501, path: ".github/workflows/build.yml", head_branch: "trunk", conclusion: "success" }] };
    expect(lines(await audit(r), "T7")).toEqual(["PASS .github/workflows/build.yml: run 501 (trunk push, trunk, success) has every required job and skips only listed ones (2 jobs)"]);
    r[`${T}/actions/workflows/build.yml/runs`] = { workflow_runs: [] };
    expect(statuses(await audit(r), "T7")).toEqual(["WARN"]);
  });
});

describe("T8: rulesets", () => {
  test("an integrity rule with a bypass actor fails; a missing one fails", async () => {
    const r = world();
    (r[`${T}/rulesets/2`] as { bypass_actors: unknown[] }).bypass_actors = [user(5)];
    expect(lines(await audit(r), "T8")).toContain("FAIL trunk: required_signatures is only in rulesets with bypass actors (main-integrity)");
    (r[`${T}/rulesets/2`] as { rules: unknown[] }).rules = [];
    expect(lines(await audit(r), "T8")).toContain("FAIL trunk: no active ruleset has deletion");
  });
  test("the landing ruleset must let the queue App bypass it and nobody but users", async () => {
    const r = world();
    (r[`${T}/rulesets/1`] as { bypass_actors: unknown[] }).bypass_actors = [user(1), app(77)];
    const f = lines(await audit(r), "T8");
    expect(f).toContain('FAIL trunk: landing ruleset "main-landing" does not list the queue App (widgets-control-queue) as a bypass actor');
    expect(f).toContain('FAIL trunk: landing ruleset "main-landing" has bypass actors other than the queue App and named users');
  });
  test("queue refs written by another App fail", async () => {
    const r = world();
    (r[`${T}/rulesets/3`] as { bypass_actors: unknown[] }).bypass_actors = [app(QUEUE_APP), app(RELEASE_APP)];
    expect(lines(await audit(r), "T8")).toContain("FAIL queue refs: mq/batch/1 can be written by more than the queue App");
  });
  test("without an admin token the bypass lines are SKIPPED, never PASS", async () => {
    const r = world();
    (r[T] as { permissions: { admin: boolean } }).permissions.admin = false;
    for (const id of [1, 2, 3]) delete (r[`${T}/rulesets/${id}`] as { bypass_actors?: unknown }).bypass_actors;
    const f = await audit(r);
    const t8 = lines(f, "T8");
    // rule presence is readable without admin; only who can bypass is not
    expect(t8.filter((l) => l.startsWith("PASS"))).toEqual(['PASS trunk: requires status checks "quick"', "PASS trunk: GitHub's merge queue is off"]);
    expect(t8.filter((l) => l.startsWith("SKIPPED")).length).toBe(8);
    expect(lines(f, "T0")).toEqual(["SKIPPED the token is not an admin of acme/widgets: rules that need admin are SKIPPED"]);
  });
  test("the native merge queue and classic protection", async () => {
    const r = world();
    (r[`${T}/rulesets/1`] as { rules: unknown[] }).rules.push({ type: "merge_queue" });
    r[`${T}/branches/trunk/protection`] = { url: "x" };
    const f = lines(await audit(r), "T8");
    expect(f).toContain("FAIL trunk: GitHub's merge queue is on (main-landing)");
    expect(f).toContain("WARN trunk still has classic branch protection");
  });
  test("with the epoch fence on, the epoch rulesets are required", async () => {
    const c = acmeConfig();
    const on = { ...c, runner: { ...c.runner, epochFence: true } };
    const f = lines(await audit(world(on), on), "T8");
    expect(f).toContain("FAIL epoch-write: qlander-epoch/queue has no creation, update, deletion rule");
    expect(f).toContain("FAIL epoch-integrity: no active ruleset has non_fast_forward");
  });
});

test("T9: a missing label fails", async () => {
  const r = world();
  delete r[`${T}/labels/mq%3Abounce`];
  expect(lines(await audit(r), "T9")).toContain('FAIL label "mq:bounce" (bounce) does not exist');
});

describe("T10: release", () => {
  const releaseWorld = () => {
    const r = world();
    r[`${T}/branches/stable`] = { name: "stable" };
    r[`${T}/contents/.github/release-manifest.json`] = file(JSON.stringify({ schema: 1, required: [{ path: ".github/workflows/build.yml", name: "Build", when: "always", required_jobs: ["unit"], allow_skipped_jobs: {} }] }));
    r[`${T}/contents/.github/workflows/certify.yml`] = file("on: workflow_dispatch\njobs: {}\n");
    r[`${T}/rulesets`] = [...(r[`${T}/rulesets`] as unknown[]), { id: 6 }, { id: 7 }];
    r[`${T}/rulesets/6`] = { id: 6, name: "release-landing", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/stable"], exclude: [] } }, bypass_actors: [app(RELEASE_APP)], rules: [{ type: "update" }, { type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } }, { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "unit" }, { context: "lint" }] } }] };
    r[`${T}/actions/workflows/certify.yml/runs`] = { total_count: 3 };
    r[`${T}/commits`] = [{ sha: "a".repeat(40) }];
    r[`${T}/commits/${"a".repeat(40)}/status`] = { statuses: [{ context: "release-ok" }] };
    r[`${T}/rulesets/7`] = { id: 7, name: "release-integrity", target: "branch", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/stable"], exclude: [] } }, bypass_actors: [], rules: [{ type: "required_signatures" }, { type: "non_fast_forward" }, { type: "deletion" }] };
    return r;
  };
  test("everything in place passes", async () => {
    expect(statuses(await audit(releaseWorld(), releaseOn(false)), "T10")).toEqual(["PASS"]);
  });
  test.each([[false], [true]])("what setup writes passes (release.dryRun %p): release-landing has no update rule, for the hotfix path", async (dryRun) => {
    const cfg = releaseOn(dryRun);
    const specs = targetRulesets(cfg, true).filter((s) => s.name.startsWith("release-"));
    expect(specs.map((s) => s.name)).toEqual(["release-landing", "release-integrity"]);
    expect(specs[0]!.rules.map((x) => x.type)).not.toContain("update");
    const r = releaseWorld();
    specs.forEach((s, i) => (r[`${T}/rulesets/${6 + i}`] = { id: 6 + i, ...rulesetBody(s, null, { release: RELEASE_APP, queue: QUEUE_APP }) }));
    const f = await audit(r, cfg);
    expect(f.filter((x) => x.status === "FAIL" || x.status === "WARN")).toEqual([]);
    expect(lines(f, "T10")).toContain('PASS stable: landing ruleset "release-landing" requires a PR; bypass: the release App and 0 named user(s)');
  });
  describe("release.mode dispatch", () => {
    const PROMOTER = 424242;
    const dispatchOn = (linear: boolean): LoadedConfig => {
      const c = releaseOn(false);
      const dispatch = { workflow: ".github/workflows/promote.yml", ref: "trunk", inputs: { sha: "sha", dryRun: "dry_run", dispatchId: "dispatch_id" }, actor: { login: "acme-release[bot]", id: 90000001 }, promoterApps: [PROMOTER], approvers: [{ login: "alice", id: 1001 }], dryRunValidMinutes: 1440, appearMinutes: 30, runHours: 6, observeMinutes: 60, budget: { window: 8, windowHours: 24 }, freeze: [] };
      return { ...c, config: { ...c.config, ...(linear ? { landing: { mode: "linear" as const, body: "b", author: "app" as const, maxRefusals: 3 } } : {}) }, release: { ...c.release, mode: "dispatch", dispatch } };
    };
    const setupWorld = (cfg: LoadedConfig) => {
      const r = releaseWorld();
      targetRulesets(cfg, true)
        .filter((s) => s.name.startsWith("release-"))
        .forEach((s, i) => (r[`${T}/rulesets/${6 + i}`] = { id: 6 + i, ...rulesetBody(s, null, { release: RELEASE_APP, queue: QUEUE_APP }) }));
      return r;
    };
    const bad = (f: Awaited<ReturnType<typeof audit>>) => lines(f, "T10").filter((l) => !l.startsWith("PASS"));
    test("merge mode: what setup writes passes without an update rule, and the pre-landing workflows must still run on PRs into release", async () => {
      const cfg = dispatchOn(false);
      const f = await audit(setupWorld(cfg), cfg);
      expect(bad(f)).toEqual([]);
      expect(lines(f, "T10")).toContain('PASS stable: landing ruleset "release-landing" requires a PR; bypass: 1 promote App(s) and 0 named user(s), not the release App (release.mode dispatch)');
      expect(lines(f, "T10").some((l) => l.includes("runs on PRs into stable"))).toBe(true);
      expect(lines(f, "T10").some((l) => l.includes("every ruleset that would stop a direct update"))).toBe(false);
    });
    test("linear landing: what setup writes passes; release restricts updates, the promote App always bypasses, and there are no PRs into release to check", async () => {
      const cfg = dispatchOn(true);
      const f = await audit(setupWorld(cfg), cfg);
      expect(bad(f)).toEqual([]);
      expect(lines(f, "T10")).toContain('PASS stable: landing ruleset "release-landing" restricts updates and requires a PR; bypass: 1 promote App(s) and 0 named user(s), not the release App (release.mode dispatch)');
      expect(lines(f, "T10")).toContain(`PASS stable: every ruleset that would stop a direct update lets the promote App(s) (${PROMOTER}) always bypass it`);
      expect(lines(f, "T10").some((l) => l.includes("PRs into stable"))).toBe(false);
    });
    test("linear landing: the merge-mode ruleset (no update rule) fails; a promote App with only a PR bypass fails", async () => {
      const cfg = dispatchOn(true);
      expect(bad(await audit(setupWorld(dispatchOn(false)), cfg))).toEqual(["FAIL stable: no active ruleset both restricts updates and requires a PR"]);
      const r = setupWorld(cfg);
      (r[`${T}/rulesets/6`] as { bypass_actors: { bypass_mode: string }[] }).bypass_actors[0]!.bypass_mode = "pull_request";
      expect(bad(await audit(r, cfg))).toEqual([`FAIL stable: the promote App ${PROMOTER} (release.dispatch.promoterApps) cannot always bypass "release-landing", so it cannot move stable`]);
    });
  });
  test("on release, only a ruleset that requires a PR counts: without one it fails when live and warns in dry run", async () => {
    const r = releaseWorld();
    (r[`${T}/rulesets/6`] as { rules: { type: string }[] }).rules = [{ type: "update" }];
    const fix = 'add a landing ruleset on stable ("Require a pull request"), bypass: the release App and break-glass humans';
    const live = (await audit(r, releaseOn(false))).filter((x) => x.id === "T10" && x.message === "stable: no active ruleset requires a PR");
    expect(live.map((x) => [x.status, x.fix])).toEqual([["FAIL", fix]]);
    const dry = (await audit(r, releaseOn(true))).filter((x) => x.id === "T10" && x.message.startsWith("stable: no active ruleset requires a PR"));
    expect(dry.map((x) => x.status)).toEqual(["WARN"]);
  });
  test.each([[false, "FAIL"], [true, "WARN"]])("a required check missing from release fails when live and warns in dry run (release.dryRun %p)", async (dryRun, status) => {
    const r = releaseWorld();
    (r[`${T}/rulesets/6`] as { rules: { type: string; parameters?: Record<string, unknown> }[] }).rules = [
      { type: "pull_request", parameters: { allowed_merge_methods: ["merge"] } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "unrelated-lint" }, { context: "unit" }] } },
    ];
    const missing = (await audit(r, releaseOn(dryRun))).filter((x) => x.id === "T10" && x.message.startsWith('stable: required status checks lack "lint"'));
    expect(missing.map((x) => x.status)).toEqual([status as "FAIL" | "WARN"]);
  });
  test("main's landing ruleset still has to restrict updates", async () => {
    const r = world();
    (r[`${T}/rulesets/1`] as { rules: { type: string }[] }).rules = [{ type: "pull_request" }];
    expect(lines(await audit(r), "T8")).toContain("FAIL trunk: no active ruleset both restricts updates and requires a PR");
  });
  test("gaps FAIL when live and WARN in dry run", async () => {
    const r = releaseWorld();
    delete r[`${T}/branches/stable`];
    delete r[`${T}/contents/.github/workflows/certify.yml`];
    const live = lines(await audit(r, releaseOn(false)), "T10").filter((l) => !l.startsWith("PASS"));
    expect(live).toEqual(["FAIL the release branch stable does not exist", "FAIL the proof workflow .github/workflows/certify.yml does not exist on trunk"]);
    expect(statuses(await audit(r, releaseOn(true)), "T10")).toEqual(["PASS", "WARN"]);
  });
  test("a manifest that does not parse", async () => {
    const r = releaseWorld();
    r[`${T}/contents/.github/release-manifest.json`] = file('{"schema": 2}');
    expect(lines(await audit(r, releaseOn(false)), "T10")).toContain("FAIL .github/release-manifest.json is not a valid qualification manifest");
  });
});

describe("T11: Apps, registration and installation reported separately", () => {
  test("a registration that differs fails", async () => {
    const r = world();
    (r["apps/widgets-control-queue"] as { permissions: Record<string, string> }).permissions.issues = "write";
    const f = (await audit(r)).filter((x) => x.id === "T11" && x.status === "FAIL");
    expect(f.map((x) => [x.message, x.details])).toEqual([
      ["queue App widgets-control-queue: registration permissions differ from DESIGN §12.1", ["issues: write, not expected"]],
      ["queue App widgets-control-queue: installation 91 has not accepted the registered permissions (pending acceptance)", ["issues: missing, expected write"]],
    ]);
  });
  test("a saved change not yet accepted shows as pending acceptance", async () => {
    const r = world();
    const inst = (r["orgs/acme/installations"] as { installations: { permissions: Record<string, string> }[] }).installations[0]!;
    inst.permissions.actions = "read";
    expect(lines(await audit(r), "T11")).toContain("FAIL queue App widgets-control-queue: installation 91 has not accepted the registered permissions (pending acceptance)");
    expect(lines(await audit(r), "T11")).toContain("PASS queue App widgets-control-queue: registration permissions are exactly actions:write, checks:read, contents:write, metadata:read, pull_requests:write, statuses:read, workflows:write");
  });
  test("installations the token cannot list are SKIPPED", async () => {
    const r = world();
    r["orgs/acme/installations"] = forbidden();
    expect(lines(await audit(r), "T11")).toContain("SKIPPED queue App widgets-control-queue: installation permissions not read: the token cannot list the organization's installations (it needs org admin read)");
  });
  test("an App installed on every repo fails", async () => {
    const r = world();
    (r["orgs/acme/installations"] as { installations: { repository_selection: string }[] }).installations[0]!.repository_selection = "all";
    expect(lines(await audit(r), "T11")).toContain("FAIL queue App widgets-control-queue: installation 91 covers all repositories");
  });
});

describe("T12: policy coverage", () => {
  test("a script a pre-landing workflow runs, outside policy.paths, fails", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("bash build/test.sh", "bash build/test.sh && bun src/app.ts"));
    expect(lines(await audit(r), "T12")).toEqual(["FAIL src/app.ts is outside queue.policy.paths (.github/workflows/build.yml job unit)"]);
  });
  test("a local action outside policy.paths fails, and so does what it runs", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("./.github/actions/setup", "./tools/setup"));
    r[`${T}/contents/tools/setup/action.yml`] = file("runs:\n  using: composite\n  steps:\n    - run: bash tools/setup/go.sh\n");
    (r[`${T}/git/trees/trunk`] as { tree: unknown[] }).tree.push({ path: "tools/setup/action.yml", type: "blob" }, { path: "tools/setup/go.sh", type: "blob" });
    expect(lines(await audit(r), "T12")).toEqual([
      "FAIL tools/setup/action.yml is outside queue.policy.paths (.github/workflows/build.yml job unit)",
      "FAIL tools/setup/go.sh is outside queue.policy.paths (tools/setup/action.yml)",
    ]);
  });
  test("a qualification manifest outside policy.paths fails", async () => {
    const c = releaseOn(true);
    if (c.release.qualification.provider === "manifest") c.release.qualification = { ...c.release.qualification, path: "release/manifest.json" };
    expect(lines(await audit(world(c), c), "T12")).toContain("FAIL release/manifest.json is outside queue.policy.paths (named in the config)");
  });
  test("a run: path the scan cannot resolve warns", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("bash build/test.sh", 'bash "build/$SUITE.sh"'));
    const f = (await audit(r)).filter((x) => x.id === "T12");
    expect(f.map((x) => [x.status, x.details ?? []])).toEqual([
      ["WARN", [".github/workflows/build.yml job unit: runs build/$SUITE.sh"]],
    ]); // and no PASS: an incomplete scan never claims coverage
  });
});

test("an unreadable target is one FAIL, not a crash", async () => {
  const r = world();
  r[T] = notFound();
  expect(lines(await audit(r))).toEqual(["FAIL cannot read the target acme/widgets: not_found (404): Not Found"]);
});

test("an organization ruleset's bypass list is trusted only from the org endpoint", async () => {
  const r = world();
  (r[`${T}/rulesets`] as { id: number; source_type?: string; source?: string }[])[1] = { id: 2, source_type: "Organization", source: "acme" };
  (r[`${T}/rulesets/2`] as { source_type?: string }).source_type = "Organization";
  // the repo endpoint shows an empty list, but the token cannot read the org's own copy
  expect(lines(await audit(r), "T8")).toContain("SKIPPED trunk: deletion is set (main-integrity); whether nobody can bypass it needs an admin token");
  r["orgs/acme/rulesets/2"] = { ...(r[`${T}/rulesets/2`] as object), bypass_actors: [user(9)] };
  expect(lines(await audit(r), "T8")).toContain("FAIL trunk: deletion is only in rulesets with bypass actors (main-integrity)");
});

describe("review cases", () => {
  test("T8: a queue-refs ruleset on one ref only does not cover the prefix", async () => {
    const r = world();
    (r[`${T}/rulesets/3`] as { conditions: { ref_name: { include: string[] } } }).conditions.ref_name.include = ["refs/heads/mq/batch/1", "refs/heads/mq/build/**"];
    expect(lines(await audit(r), "T8")).toContain("FAIL queue refs: mq/batch/2 has no creation, update, deletion rule");
  });
  test("T8: ruleset patterns are fnmatch: ? is one character, not a quantifier", async () => {
    const r = world();
    (r[`${T}/rulesets/2`] as { conditions: { ref_name: { include: string[] } } }).conditions.ref_name.include = ["refs/heads/trunk?"];
    expect(lines(await audit(r), "T8")).toContain("FAIL trunk: no active ruleset has deletion");
  });
  test("T8: an App that bypasses only through pull requests does not count", async () => {
    const r = world();
    (r[`${T}/rulesets/3`] as { bypass_actors: unknown[] }).bypass_actors = [{ ...app(QUEUE_APP), bypass_mode: "pull_request" }];
    expect(statuses(await audit(r), "T8")).toContain("FAIL");
  });
  test("T8: the fast-lane check must be required on main", async () => {
    const r = world();
    (r[`${T}/rulesets/8`] as { rules: { parameters: { required_status_checks: unknown[] } }[] }).rules[0]!.parameters.required_status_checks = [{ context: "other" }];
    expect(lines(await audit(r), "T8")).toContain('FAIL trunk: required status checks lack "quick"');
  });
  test("T8: epoch-write and epoch-integrity together pass", async () => {
    const c = acmeConfig();
    const on = { ...c, runner: { ...c.runner, epochFence: true } };
    const r = world(on);
    r[`${T}/rulesets`] = [...(r[`${T}/rulesets`] as unknown[]), { id: 20 }, { id: 21 }];
    r[`${T}/rulesets/20`] = { id: 20, name: "epoch-write-queue", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/qlander-epoch/queue"], exclude: [] } }, bypass_actors: [{ ...app(QUEUE_APP), bypass_mode: "always" }], rules: [{ type: "creation" }, { type: "update" }, { type: "deletion" }] };
    r[`${T}/rulesets/21`] = { id: 21, name: "epoch-integrity", enforcement: "active", conditions: { ref_name: { include: ["refs/heads/qlander-epoch/**"], exclude: [] } }, bypass_actors: [], rules: [{ type: "non_fast_forward" }, { type: "deletion" }] };
    expect(lines(await audit(r, on), "T8").filter((l) => l.includes("epoch"))).toEqual([
      "PASS epoch-write: qlander-epoch/queue has creation, update, deletion; only the queue App bypasses them",
      'PASS epoch-integrity: non_fast_forward in "epoch-integrity", which nobody can bypass',
      'PASS epoch-integrity: deletion in "epoch-integrity", which nobody can bypass',
    ]);
  });
  test("T3: a workflow on any build ref fails, not only the first", async () => {
    expect(lines(await audit(withWorkflow(world(), "x.yml", 'on:\n  push:\n    branches: ["mq/build/2"]\njobs: {}\n')), "T3")).toEqual(["FAIL .github/workflows/x.yml runs on a push to mq/build/2"]);
  });
  test("T4: != main is not a main-only gate, and workflow-level secrets count", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("  lint:\n", "  lint:\n    if: github.ref != 'refs/heads/trunk'\n    environment: deploy\n") + "env:\n  KEY: ${{ secrets.DEPLOY_KEY }}\n");
    const f = (await audit(r)).filter((x) => x.id === "T4");
    expect(f[0]!.details).toEqual([".github/workflows/build.yml:20 workflow env: secrets DEPLOY_KEY", '.github/workflows/build.yml:14 job lint: environment "deploy"']);
  });
  test("T7: the newest completed run counts, even when an older one was green", async () => {
    const r = world();
    (r[`${T}/actions/workflows/build.yml/runs`] as { workflow_runs: unknown[] }).workflow_runs.push({ id: 502, path: ".github/workflows/build.yml", head_branch: "mq/batch/8", conclusion: "failure" });
    r[`${T}/actions/runs/502/jobs`] = { jobs: [{ id: 3, name: "unit", status: "completed", conclusion: "failure" }] };
    expect(lines(await audit(r), "T7")).toEqual(["FAIL .github/workflows/build.yml: run 502 (queue push, mq/batch/8, failure) does not match queue.preLanding"]);
  });
  test("T10: a proof workflow that never ran and a status never seen", async () => {
    const r = world();
    r[`${T}/branches/stable`] = { name: "stable" };
    r[`${T}/contents/.github/release-manifest.json`] = file(JSON.stringify({ schema: 1, required: [{ path: ".github/workflows/build.yml", name: "Build", when: "always", required_jobs: ["unit"], allow_skipped_jobs: {} }] }));
    r[`${T}/contents/.github/workflows/certify.yml`] = file("on: workflow_dispatch\njobs: {}\n");
    r[`${T}/actions/workflows/certify.yml/runs`] = { total_count: 0 };
    r[`${T}/commits`] = [{ sha: "b".repeat(40) }];
    r[`${T}/commits/${"b".repeat(40)}/status`] = { statuses: [] };
    const f = lines(await audit(r, releaseOn(false)), "T10");
    expect(f).toContain("FAIL .github/workflows/certify.yml has never run on trunk");
    expect(f).toContain('FAIL status "release-ok" is on none of the newest 1 commits of trunk');
  });
  test("T12: a JavaScript action's main file is checked", async () => {
    const r = world();
    r[`${T}/contents/.github/actions/setup/action.yml`] = file("runs:\n  using: node20\n  main: ../../../src/app.ts\n");
    expect(lines(await audit(r), "T12")).toEqual(["FAIL src/app.ts is outside queue.policy.paths (.github/actions/setup/action.yml)"]);
  });
  test("T12: a dynamic working-directory cannot be resolved", async () => {
    const r = world();
    r[`${T}/contents/.github/workflows/build.yml`] = file(BUILD_YML.replace("      - run: bash build/test.sh", "      - run: bash build/test.sh\n        working-directory: ${{ matrix.dir }}"));
    expect(statuses(await audit(r), "T12")).toEqual(["WARN"]);
  });
  test("malformed input and a failing read become findings, not a stopped audit", async () => {
    const r = world();
    r[`${T}/contents/.github/actions/setup/action.yml`] = file("runs:\n  using: composite\n  steps:\n    - null\n");
    r[`${T}/contents/.github/workflows/checks.yml`] = file(CHECKS_YML.replace("branches: [trunk]", "branches: ['[z-a]']"));
    r[`${T}/labels/mq%3Ago`] = new Error("boom");
    const f = await audit(r);
    expect(lines(f, "T9")).toContain('WARN label "mq:go" (go) could not be read: boom');
    expect(f.length).toBeGreaterThan(20);
    const r2 = world();
    r2[`${T}/contents/.github/workflows`] = forbidden();
    expect(lines(await audit(r2), "T1")).toEqual(["WARN the target's workflows could not be read: auth (403): Resource not accessible; T1 to T6 are unverified"]);
  });
});
