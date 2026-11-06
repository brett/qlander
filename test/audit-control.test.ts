// `qlander audit`, control checks C1–C8 (docs/deployment.md §4.2), the
// command (flags, output, exit codes, the token), and the read-only reader.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditCommand, runAudit } from "../src/audit/command";
import { auditReader } from "../src/audit/reader";
import type { LoadedConfig } from "../src/config/load";
import { auditExitCode, type Finding, readFailed, unsettled } from "../src/audit/types";
import { HAND_WORKFLOWS, renderWorkflows, withBundleDownload } from "../src/render";
import { GitHubError } from "../src/github/http";
import { ACME, acmeConfig, app, C_REPO, fakeGh, file, forbidden, lines, type Routes, statuses, user, world } from "./audit-fake";

const C = C_REPO;
const audit = (routes: Routes, cfg: LoadedConfig = acmeConfig()) => runAudit(fakeGh(routes), cfg, "control", {});
const mainRules = (r: Routes) => r[`${C}/rulesets/5`] as { rules: { type: string; parameters?: Record<string, unknown> }[]; bypass_actors?: unknown[] };

test("the fake world passes every control rule", async () => {
  const f = await audit(world());
  expect(f.filter((x) => x.status === "FAIL" || x.status === "WARN")).toEqual([]);
});

describe("C1: environments", () => {
  test("missing, and deploying from any branch, each fail", async () => {
    const r = world();
    delete r[`${C}/environments/queue-write`];
    expect(lines(await audit(r), "C1")).toEqual(["FAIL environment queue-write does not exist"]);
    r[`${C}/environments/queue-write`] = { deployment_branch_policy: null };
    expect(lines(await audit(r), "C1")).toEqual(["FAIL environment queue-write deploys from any branch"]);
  });
  test("a second allowed branch fails; the release environment is checked when release is on", async () => {
    const r = world();
    r[`${C}/environments/queue-write/deployment-branch-policies`] = { branch_policies: [{ name: "main", type: "branch" }, { name: "dev", type: "branch" }] };
    const c = acmeConfig();
    const rel = { ...c, release: { ...c.release, enabled: true } };
    expect(lines(await audit(r, rel), "C1")).toEqual(["FAIL environment queue-write deploys from branch:main, branch:dev", "PASS environment release-write deploys from main only"]);
  });
});

test("C2: a visible secret fails; an unreadable list is SKIPPED", async () => {
  const r = world();
  r[`${C}/actions/organization-secrets`] = { total_count: 1, secrets: [{ name: "NPM_TOKEN" }] };
  r[`${C}/actions/secrets`] = forbidden();
  const f = (await audit(r)).filter((x) => x.id === "C2");
  expect(f.map((x) => [x.status, x.details ?? []])).toEqual([
    ["SKIPPED", []],
    ["FAIL", ["NPM_TOKEN"]],
  ]);
});

test("C3: Actions able to approve PRs fails", async () => {
  const r = world();
  r[`${C}/actions/permissions/workflow`] = { can_approve_pull_request_reviews: true };
  expect(statuses(await audit(r), "C3")).toEqual(["FAIL"]);
});

test("C4: the state branches' ruleset must have exactly the state App as bypass", async () => {
  const r = world();
  (r[`${C}/rulesets/4`] as { bypass_actors: unknown[] }).bypass_actors = [app(13), user(1)];
  expect(lines(await audit(r), "C4")).toEqual(["FAIL state branch: mq-state can be written by more than the state App"]);
  (r[`${C}/rulesets/4`] as { rules: { type: string }[] }).rules = [{ type: "creation" }, { type: "update" }, { type: "deletion" }];
  expect(lines(await audit(r), "C4")).toEqual(["FAIL state branch: mq-state has no non_fast_forward rule"]);
});

describe("C5: control main, one line per parameter", () => {
  test("each missing parameter is its own FAIL", async () => {
    const r = world();
    mainRules(r).rules = [{ type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false, require_last_push_approval: false } }];
    expect(lines(await audit(r), "C5").filter((l) => l.startsWith("FAIL"))).toEqual([
      "FAIL main: required_approving_review_count >= 1: not set by any active ruleset",
      "FAIL main: dismiss_stale_reviews_on_push: not set by any active ruleset",
      "FAIL main: require_last_push_approval: not set by any active ruleset",
      "FAIL main: required_signatures: not set by any active ruleset",
      "FAIL main: non_fast_forward: not set by any active ruleset",
      "FAIL main: deletion: not set by any active ruleset",
    ]);
  });
  test("no ruleset at all: every parameter fails", async () => {
    const r = world();
    r[`${C}/rulesets`] = [{ id: 4 }];
    expect(lines(await audit(r), "C5").every((l) => l.startsWith("FAIL"))).toBe(true);
    expect(lines(await audit(r), "C5").length).toBe(8);
  });
  test("a bypass actor fails; without admin it is SKIPPED", async () => {
    const r = world();
    mainRules(r).bypass_actors = [user(1)];
    expect(lines(await audit(r), "C5")).toContain('FAIL main: bypass actors on "main"');
    (r[C] as { permissions: { admin: boolean } }).permissions.admin = false;
    expect(lines(await audit(r), "C5")).toContain("SKIPPED main: whether the ruleset has no bypass actors needs an admin token");
  });
});

test("C6: a control repo less private than the target fails", async () => {
  const r = world();
  (r[C] as { visibility: string }).visibility = "public";
  expect(lines(await audit(r), "C6")).toEqual(["FAIL the control repo is public but the target is private"]);
});

test("C7: a checked-in workflow that drifted from its rendering fails", async () => {
  const r = world();
  r[`${C}/contents/.github/workflows/tick.yml`] = file("name: something else\n");
  const f = (await audit(r)).filter((x) => x.id === "C7");
  expect(f.map((x) => x.status)).toEqual(["FAIL", "PASS"]);
  expect(f[0]!.message).toBe(".github/workflows/tick.yml differs from its rendering at line 1");
});

test("C7: a hand-edited workflow's download only warns when it differs from bundle, and is left out in source mode", async () => {
  const b = { repo: "acme/qlander", private: false, watchdog: true };
  const cfg = { ...acmeConfig(), bundle: b };
  const path = HAND_WORKFLOWS[0]!;
  const template = readFileSync(join(import.meta.dir, "..", "template", path), "utf8");
  const download = (repo: string) => withBundleDownload(template, { ...b, repo });
  const rendered = renderWorkflows(cfg);
  const routes = (text: string | null) => {
    const r = world();
    for (const w of rendered) r[`${C}/contents/${w.path}`] = file(w.text);
    if (text !== null) r[`${C}/contents/${path}`] = file(text);
    return r;
  };
  const c7Lines = async (r: Routes, c: LoadedConfig = cfg) => (await runAudit(fakeGh(r), c, "control", {})).filter((x) => x.id === "C7" && x.message.includes(path)).map((x) => `${x.status} ${x.message}`);
  expect(await c7Lines(routes(download("acme/qlander")))).toEqual([`PASS ${path}: its qlander download matches bundle`]);
  expect(await c7Lines(routes(download("someone/else")))).toEqual([`WARN ${path}: its qlander download differs from bundle`]);
  expect(await c7Lines(routes(null))).toEqual([]);
  expect(await c7Lines(routes("name: ci\n"))).toEqual([]);
  expect(await c7Lines(routes(download("someone/else")), acmeConfig())).toEqual([]);
});

test("C8: the state App's permissions", async () => {
  const r = world();
  (r["apps/widgets-control-state"] as { permissions: Record<string, string> }).permissions.issues = "write";
  expect(lines(await audit(r), "C8")).toContain("FAIL state App widgets-control-state: registration permissions differ from DESIGN §12.1");
});

describe("the command", () => {
  const run = async (args: string[], env: Record<string, string | undefined>, routes: Routes = world()) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await auditCommand(["--config", ACME, ...args], { out: (l) => out.push(l), err: (l) => err.push(l) }, { env, connect: () => fakeGh(routes) });
    return { code, out, err };
  };
  // The fixture has no runner labels, so its workflows cannot be rendered: C7 fails.
  test("exit 1 on any FAIL, with a summary line", async () => {
    const r = await run([], { GH_TOKEN: "ghp_example_token_value" });
    expect(r.code).toBe(1);
    expect(r.out.at(-1)).toMatch(/^\d+ PASS, 0 WARN, 1 FAIL, \d+ SKIPPED$/);
    expect(r.out).toContain("FAIL    C7   the workflows cannot be rendered from this config: runner.runsOn is required to render the tick workflow in self-hosted-kill mode: the labels of the runners the host kills");
  });
  test("exit 0 with --target-only on a clean target; --json prints one document", async () => {
    const r = await run(["--target-only", "--json"], { GH_TOKEN: "ghp_example_token_value" });
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(1);
    const doc = JSON.parse(r.out[0]!);
    expect(doc.target).toBe("acme/widgets");
    expect(doc.findings.some((f: { id: string }) => f.id.startsWith("C"))).toBe(false);
  });
  test("App slugs can be given; a wrong one fails", async () => {
    const r = await run(["--target-only", "--queue-app", "other-queue"], { GH_TOKEN: "ghp_example_token_value" });
    expect(r.code).toBe(1);
    expect(r.out.some((l) => l.includes("queue App other-queue: cannot read its registration"))).toBe(true);
  });
  test("usage errors exit 2; no token exits 3", async () => {
    expect((await run(["--target-only", "--control-only"], { GH_TOKEN: "x" })).code).toBe(2);
    expect((await run(["--bogus"], { GH_TOKEN: "x" })).code).toBe(2);
    const r = await run([], {});
    expect(r.code).toBe(3);
    expect(r.err[0]).toContain("GH_TOKEN");
  });
  describe("the exit code", () => {
    const TOKEN = { GH_TOKEN: "ghp_example_token_value" };
    const boom = () => new GitHubError("server", 500, "boom");
    const allFailing = (routes: Routes) => Object.fromEntries(Object.keys(routes).map((k) => [k, boom()]));
    const json = (r: { out: string[] }) => JSON.parse(r.out[0]!).findings as Finding[];

    test("every read failing exits 3: the FAILs stay FAILs, marked as no answer, in JSON and text", async () => {
      const r = await run(["--json"], TOKEN, allFailing(world()));
      expect(r.code).toBe(3);
      expect(json(r).filter((f) => f.status === "FAIL").length).toBeGreaterThan(0);
      expect(json(r).filter((f) => f.status === "FAIL" && !f.inconclusive)).toEqual([]);
      const text = await run([], TOKEN, allFailing(world()));
      expect(text.code).toBe(3);
      expect(text.out.at(-1)).toContain("failed reads: inconclusive");
      expect(text.out.some((l) => l.includes("(read failed)"))).toBe(true);
    });

    test("one failed read exits 3, with no FAIL", async () => {
      const routes = world();
      routes["repos/acme/widgets/labels/merge-queue"] = boom();
      const r = await run(["--target-only", "--json"], TOKEN, routes);
      expect(r.code).toBe(3);
      const bad = json(r).filter((f) => f.inconclusive);
      expect(bad.map((f) => [f.id, f.status])).toEqual([["T9", "WARN"]]);
      expect(json(r).some((f) => f.status === "FAIL")).toBe(false);
    });

    test("a network failure, a rate limit and a revoked token are failed reads", async () => {
      for (const e of [new GitHubError("network", null, "reset"), new GitHubError("rate_limit", 403, "slow down"), new GitHubError("auth", 401, "Bad credentials")]) {
        const routes = world();
        routes["repos/acme/widgets/labels/merge-queue"] = e;
        expect((await run(["--target-only"], TOKEN, routes)).code).toBe(3);
      }
    });

    test("a failed read of an App is no answer about the rulesets that name it", async () => {
      const routes = world();
      routes["apps/widgets-control-queue"] = boom();
      const r = await run(["--target-only", "--json"], TOKEN, routes);
      expect(r.code).toBe(3);
      expect(json(r).filter((f) => f.status === "FAIL" && !f.inconclusive)).toEqual([]);
    });

    test("one failing route at a time: whichever read fails, the audit doesn't exit 0", async () => {
      const baseline = fakeGh(world());
      await runAudit(baseline, acmeConfig(), "both", {});
      const clean = auditExitCode(await runAudit(fakeGh(world()), acmeConfig(), "both", {}));
      expect(clean).toBe(0);
      const silent: string[] = [];
      const routesRead = [...new Set(baseline.calls)].filter((route) => route in world()); // the rest are 404s for paths the fake doesn't hold
      expect(routesRead.length).toBeGreaterThan(20);
      for (const route of routesRead) {
        const routes = world();
        routes[route] = boom();
        if (auditExitCode(await runAudit(fakeGh(routes), acmeConfig(), "both", {})) === 0) silent.push(route);
      }
      expect(silent).toEqual([]);
    });

    test("a truncated listing is a failed read", async () => {
      const gh = fakeGh(world());
      const truncating = { ...gh, list: async <T,>(p: string, q: Record<string, string | number | undefined>, pick: (x: unknown) => T[]) => ({ ...(await gh.list<T>(p, q, pick)), truncated: true }) };
      expect(auditExitCode(await runAudit(truncating, acmeConfig(), "both", {}))).toBe(3);
    });

    test("a failed read doesn't lose a FAIL its check had already found", async () => {
      const cfg = acmeConfig();
      const routes = world(cfg);
      const [first, second] = renderWorkflows(cfg);
      routes[`${C}/contents/${first!.path.split("/").map(encodeURIComponent).join("/")}`] = file("drifted\n");
      for (const e of [boom(), forbidden()]) {
        routes[`${C}/contents/${second!.path.split("/").map(encodeURIComponent).join("/")}`] = e;
        const f = await runAudit(fakeGh(routes), cfg, "control", {});
        expect(f.filter((x) => x.id === "C7" && x.status === "FAIL").length).toBe(1);
        expect(auditExitCode(f)).toBe(1);
      }
    });

    test("a forbidden actor is a FAIL even when the App couldn't be read", async () => {
      const routes = world();
      routes["apps/widgets-control-queue"] = boom();
      const landing = Object.values(routes).find((v) => (v as { rules?: { type: string }[] })?.rules?.some((r) => r.type === "pull_request") && (v as { name?: string }).name !== "main") as { bypass_actors: unknown[] };
      landing.bypass_actors.push({ actor_type: "Team", actor_id: 9, bypass_mode: "always" });
      const f = await runAudit(fakeGh(routes), acmeConfig(), "target", {});
      expect(f.some((x) => x.status === "FAIL" && !x.inconclusive && x.message.includes("bypass actors other than"))).toBe(true);
      expect(auditExitCode(f)).toBe(1);
    });

    test("a real FAIL wins over a failed read: exit 1", async () => {
      const routes = world();
      routes["repos/acme/widgets/labels/merge-queue"] = boom();
      routes["repos/acme/widgets/labels/mq%3Ago"] = new GitHubError("not_found", 404, "Not Found");
      const r = await run(["--target-only", "--json"], TOKEN, routes);
      expect(json(r).some((f) => f.status === "FAIL" && !f.inconclusive)).toBe(true);
      expect(r.code).toBe(1);
    });

    test("a token-permission skip stays as designed: SKIPPED or WARN, not marked, exit 0", async () => {
      const f = await audit({ ...world(), [`${C}/actions/secrets`]: forbidden() });
      const c2 = f.filter((x) => x.id === "C2" && x.status === "SKIPPED");
      expect(c2.length).toBe(1);
      expect(c2[0]!.inconclusive).toBeUndefined();
      const routes = world();
      routes["repos/acme/widgets/labels/merge-queue"] = forbidden();
      const r = await run(["--target-only", "--json"], TOKEN, routes);
      expect(r.code).toBe(0);
      expect(json(r).filter((x) => x.inconclusive)).toEqual([]);
      const skips = await run(["--target-only", "--json"], TOKEN, { ...world(), "repos/acme/widgets": { ...(world()["repos/acme/widgets"] as object), permissions: { admin: false } } });
      expect(skips.code).toBe(0);
      expect(json(skips).some((x) => x.status === "SKIPPED" && x.id === "T0")).toBe(true);
    });

    test("a failure in the same list as a permission skip still counts", () => {
      const skip: Finding = { id: "T0", status: "SKIPPED", message: "needs admin" };
      const warned: Finding = { id: "C5", status: "WARN", message: "accepted by control.mainProtection" };
      expect(auditExitCode([skip, warned])).toBe(0);
      expect(auditExitCode([skip, { ...warned, inconclusive: true }])).toBe(3);
      expect(auditExitCode([{ id: "C0", status: "FAIL", message: "x", inconclusive: true }])).toBe(3);
      expect(auditExitCode([{ id: "C0", status: "FAIL", message: "x" }, { ...warned, inconclusive: true }])).toBe(1);
    });

    test("setup --step verify stops on a FAIL or a failed read, not on a skip or a relaxation", () => {
      const skip: Finding = { id: "T0", status: "SKIPPED", message: "needs admin" };
      expect(unsettled([skip, { id: "C5", status: "WARN", message: "accepted" }])).toBe(0);
      expect(unsettled([{ ...skip, inconclusive: true }, { id: "C0", status: "FAIL", message: "x" }])).toBe(2);
    });
  });

  test("the token is never printed", async () => {
    const token = "ghp_secret_value_123456";
    const routes = world();
    routes["repos/acme/widgets"] = new Error(`bad credentials ${token}`);
    const r = await run(["--target-only"], { GH_TOKEN: token }, routes);
    expect([...r.out, ...r.err].join("\n")).not.toContain(token);
    expect(r.out.join("\n")).toContain("[token]");
  });
});

test("the reader sends GET and nothing else", async () => {
  const methods: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    methods.push(`${init?.method} ${String(url)}`);
    return new Response(JSON.stringify(String(url).includes("/list") ? [{ id: 1 }] : { ok: true }), { status: 200 });
  }) as typeof globalThis.fetch;
  const gh = auditReader({ token: "t", fetch });
  await gh.get("repos/acme/widgets", { ref: "trunk" });
  await gh.list("repos/acme/widgets/list", {}, (p) => p as unknown[]);
  expect(methods).toEqual(["GET https://api.github.com/repos/acme/widgets?ref=trunk", "GET https://api.github.com/repos/acme/widgets/list?per_page=100"]);
  expect(Object.keys(gh).sort()).toEqual(["get", "list"]);
});

test("a 200 with no JSON body is a failed read, not an answer", async () => {
  const fetch = (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof globalThis.fetch;
  const e = await auditReader({ token: "t", fetch }).get("repos/acme/widgets").catch((x) => x);
  expect(readFailed(e)).toBe(true);
  expect(e).toBeInstanceOf(GitHubError);
});

test("a list page with no list is a failed read, not an empty list", async () => {
  for (const body of ["<html>gateway</html>", "{}"]) {
    const fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch;
    const e = await auditReader({ token: "t", fetch })
      .list("repos/acme/widgets/rulesets", {}, (p) => (p as { items?: unknown[] } | null)?.items)
      .catch((x) => x);
    expect(e).toBeInstanceOf(GitHubError);
    expect(readFailed(e)).toBe(true);
  }
});

test("C3 needs the setting in the response", async () => {
  const f = await audit({ ...world(), [`${C}/actions/permissions/workflow`]: {} });
  expect(f.filter((x) => x.id === "C3").map((x) => [x.status, x.inconclusive])).toEqual([["SKIPPED", true]]);
});

test("a whole audit makes only reads", async () => {
  const gh = fakeGh(world());
  await runAudit(gh, acmeConfig(), "both", {});
  // The fake has only get and list; every path it was asked for is a read endpoint.
  expect(gh.calls.length).toBeGreaterThan(30);
  expect(gh.calls.every((p) => !/\/(merges|dispatches|git\/refs)$/.test(p))).toBe(true);
});
