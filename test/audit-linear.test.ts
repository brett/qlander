// `qlander audit` T13 (docs/deployment.md §4.1, DESIGN.md §7.4): what linear
// landing needs from the target. Rulesets are read as for T8 (repository and
// organization ones, include and exclude patterns); bypass lists only with an
// admin token, and an unreadable one is SKIPPED, never guessed.

import { describe, expect, test } from "bun:test";
import { runAudit } from "../src/audit/command";
import type { LoadedConfig } from "../src/config/load";
import { DEFAULT_LINEAR_BODY } from "../src/config/load";
import { GitHubError } from "../src/github/http";
import { acmeConfig, app, fakeGh, forbidden, lines, notFound, QUEUE_APP, type Routes, statuses, T_REPO as T, world } from "./audit-fake";

const linear = (author: "app" | "author" = "app"): LoadedConfig => {
  const c = acmeConfig();
  return { ...c, config: { ...c.config, landing: { mode: "linear", body: DEFAULT_LINEAR_BODY, author, maxRefusals: 3 } } };
};
const audit = async (r: Routes, cfg: LoadedConfig) => (await runAudit(fakeGh(r), cfg, "target", {})).filter((f) => f.id === "T13");

/** A ruleset on PR branches, as the API returns it. */
const prRuleset = (id: number, include: string[], bypass: { actor_id: number; actor_type: string; bypass_mode?: string }[] = [], exclude: string[] = []) => ({
  id,
  name: `pr-branches-${id}`,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include, exclude } },
  bypass_actors: bypass,
  rules: [{ type: "non_fast_forward" }],
});
const withRuleset = (r: Routes, rs: ReturnType<typeof prRuleset>) => {
  r[`${T}/rulesets`] = [...(r[`${T}/rulesets`] as { id: number }[]), { id: rs.id }];
  r[`${T}/rulesets/${rs.id}`] = rs;
  return r;
};
const openPr = (n: number, ref: string, repoId = 1002) => ({ number: n, head: { ref, repo: { id: repoId } } });
const withPrs = (r: Routes, prs: ReturnType<typeof openPr>[]) => ((r[`${T}/pulls`] = prs), r);

describe("T13: force updates of PR branches", () => {
  test("merge mode: no T13 finding at all", async () => {
    expect(await audit(world(), acmeConfig())).toEqual([]);
  });

  test("no ruleset on PR branches: PASS, naming the open PRs counted", async () => {
    expect(lines(await audit(withPrs(world(), [openPr(1, "feat/a")]), linear()))).toEqual(["PASS no ruleset blocks the queue App's force updates of PR branches (1 open)"]);
  });

  test("an open PR's branch blocked by a ruleset the queue App cannot bypass: FAIL", async () => {
    const r = withRuleset(withPrs(world(), [openPr(1, "feat/a"), openPr(2, "fix/b")]), prRuleset(60, ["refs/heads/feat/**"]));
    const f = lines(await audit(r, linear()));
    expect(f).toEqual(['FAIL ruleset "pr-branches-60" has non_fast_forward on open PR branch(es) feat/a, and the queue App may not bypass it: their linear landing would be refused']);
  });

  test("bypass by App id with mode always passes; pull_request mode, or another App, does not", async () => {
    const ok = withRuleset(withPrs(world(), [openPr(1, "feat/a")]), prRuleset(60, ["~ALL"], [{ ...app(QUEUE_APP), bypass_mode: "always" }]));
    expect(statuses(await audit(ok, linear()))).toEqual(["PASS"]);
    for (const b of [{ ...app(QUEUE_APP), bypass_mode: "pull_request" }, { ...app(99), bypass_mode: "always" }]) {
      const r = withRuleset(withPrs(world(), [openPr(1, "feat/a")]), prRuleset(60, ["~ALL"], [b]));
      expect(statuses(await audit(r, linear()))).toEqual(["FAIL"]);
    }
  });

  test("a pattern that could cover a future PR branch: WARN; one that covers only reserved refs or excludes the PR: nothing", async () => {
    const future = withRuleset(withPrs(world(), []), prRuleset(60, ["refs/heads/release-*"]));
    expect(statuses(await audit(future, linear()))).toEqual(["WARN"]);
    const reserved = withRuleset(withPrs(world(), [openPr(1, "feat/a")]), prRuleset(61, ["~DEFAULT_BRANCH", "refs/heads/mq/batch/*", "refs/heads/stable"]));
    expect(lines(await audit(reserved, linear()))).toEqual(["PASS no ruleset blocks the queue App's force updates of PR branches (1 open)"]);
    const excluded = withRuleset(withPrs(world(), [openPr(1, "feat/a")]), prRuleset(62, ["refs/heads/feat/**"], [], ["refs/heads/feat/**"]));
    expect(statuses(await audit(excluded, linear()))).toEqual(["WARN"]); // the pattern could still match: a WARN, not a FAIL
  });

  test("forks and reserved head branches are left out", async () => {
    const r = withRuleset(withPrs(world(), [openPr(1, "feat/a", 9999), openPr(2, "trunk")]), prRuleset(60, ["refs/heads/feat/**", "refs/heads/trunk"]));
    expect(statuses(await audit(r, linear()))).toEqual(["WARN"]);
  });

  test("bypass lists unreadable (no admin): SKIPPED, never a guess", async () => {
    const r = withRuleset(withPrs(world(), [openPr(1, "feat/a")]), prRuleset(60, ["refs/heads/feat/**"]));
    (r[T] as { permissions: { admin: boolean } }).permissions.admin = false;
    const f = await audit(r, linear());
    expect(statuses(f)).toEqual(["SKIPPED"]);
    expect(lines(f)[0]).toContain("needs an admin token");
  });

  test("an org ruleset whose bypass list the org endpoint will not show: SKIPPED", async () => {
    const rs = { ...prRuleset(70, ["~ALL"]), source_type: "Organization" };
    const r = withRuleset(withPrs(world(), [openPr(1, "feat/a")]), rs);
    r[`orgs/acme/rulesets/70`] = forbidden();
    expect(statuses(await audit(r, linear()))).toEqual(["SKIPPED"]);
  });

  test("classic protection on an open PR branch that forbids force pushes: FAIL; unreadable: SKIPPED, inconclusive on a failed read", async () => {
    const r = withPrs(world(), [openPr(1, "feat/a")]);
    r[`${T}/branches/feat/a`] = { protected: true };
    r[`${T}/branches/feat/a/protection`] = { allow_force_pushes: { enabled: false } };
    expect(lines(await audit(r, linear()))).toContain("FAIL feat/a: classic branch protection does not allow force pushes, so its linear landing would be refused");
    r[`${T}/branches/feat/a/protection`] = { allow_force_pushes: { enabled: true } };
    expect(statuses(await audit(r, linear()))).toEqual(["PASS"]);
    r[`${T}/branches/feat/a/protection`] = new GitHubError("server", 502, "Bad gateway");
    const f = await audit(r, linear());
    expect(f.find((x) => x.status === "SKIPPED")?.inconclusive).toBe(true);
  });

  test("the open PR list unreadable: SKIPPED and inconclusive; the patterns are still checked", async () => {
    const r = withRuleset(world(), prRuleset(60, ["refs/heads/feat/**"]));
    r[`${T}/pulls`] = new GitHubError("server", 502, "Bad gateway");
    const f = await audit(r, linear());
    expect(f.map((x) => [x.status, x.inconclusive ?? false])).toEqual([["SKIPPED", true], ["WARN", false]]);
  });
});

describe("T13: author mode and signed commits on main", () => {
  test("required signatures in a ruleset on main: FAIL; T8 no longer demands them", async () => {
    const r = withPrs(world(), []);
    r[`${T}/branches/trunk/protection/required_signatures`] = notFound();
    const all = await runAudit(fakeGh(r), linear("author"), "target", {});
    expect(lines(all, "T13")).toContain('FAIL queue.landing.author is author, whose commits are unsigned, but trunk requires signed commits ("main-integrity")');
    expect(lines(all, "T8").some((l) => l.includes("required_signatures"))).toBe(false);
    expect(lines(await runAudit(fakeGh(withPrs(world(), [])), linear("app"), "target", {}), "T8").some((l) => l.includes("required_signatures"))).toBe(true);
  });

  test("no ruleset requires them: classic protection decides; unreadable without admin is SKIPPED", async () => {
    const r = withPrs(world(), []);
    const rs = r[`${T}/rulesets/2`] as { rules: { type: string }[] };
    rs.rules = rs.rules.filter((x) => x.type !== "required_signatures");
    r[`${T}/branches/trunk/protection/required_signatures`] = { enabled: true };
    expect(lines(await audit(r, linear("author")))).toContain("FAIL queue.landing.author is author, whose commits are unsigned, but trunk's classic protection requires signed commits");
    r[`${T}/branches/trunk/protection/required_signatures`] = notFound();
    expect(lines(await audit(r, linear("author")))).toContain("PASS trunk: no classic protection requires signed commits");
    (r[T] as { permissions: { admin: boolean } }).permissions.admin = false;
    expect(lines(await audit(r, linear("author")))).toContain("SKIPPED trunk: classic protection's required signatures not read (needs an admin token)");
  });
});
