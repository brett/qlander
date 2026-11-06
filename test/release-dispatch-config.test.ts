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
import { appSpecs } from "../src/setup/expected";
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
    expect(releaseTokenPermissions(c.release)).toEqual({ contents: "write", workflows: "write", actions: "read", checks: "read", statuses: "read" });
  });

  test("dispatch: the block with its defaults filled in", () => {
    const c = parseConfig(withRelease(DISPATCH));
    expect(c.release.mode).toBe("dispatch");
    expect(c.release.dispatch).toEqual({
      workflow: ".github/workflows/promote.yml",
      ref: c.config.names.main,
      inputs: { sha: "sha", dryRun: "dry_run", dispatchId: "dispatch_id" },
      approvers: [{ login: "alice", id: 1001 }],
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
    ["no approver", DISPATCH.slice(0, 7).concat(["    approvers: []"]), /needs at least 1/],
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

describe("the release App's permissions in dispatch mode", () => {
  test("Actions: write for the release App only; Variables: read only with a freeze", () => {
    const d = parseConfig(withRelease(DISPATCH));
    expect(releaseTokenPermissions(d.release)).toEqual({ contents: "write", workflows: "write", actions: "write", checks: "read", statuses: "read" });
    const f = parseConfig(withRelease([...DISPATCH, "    freeze:", "      - variable: RELEASE_FREEZE", "        value: \"true\""]));
    expect(releaseTokenPermissions(f.release)).toMatchObject({ actions: "write", actions_variables: "read" });
    expect(expectedPermissions("queue", d.release)).toEqual(EXPECTED_PERMISSIONS.queue);
    expect(expectedPermissions("state", d.release)).toEqual(EXPECTED_PERMISSIONS.state);
    expect(expectedPermissions("release", parseConfig(base).release)).toEqual(EXPECTED_PERMISSIONS.release);
  });

  test("tick.yml requests them, setup registers them, and audit expects them", () => {
    for (const c of [parseConfig(withRelease(DISPATCH)), parseConfig(withRelease([...DISPATCH, "    freeze:", "      - variable: RELEASE_FREEZE", "        value: \"true\""]))]) {
      const tick = renderTick(c);
      const step = tick.split(/\n(?=      - name: )/).find((s) => s.includes("secrets.RELEASE_APP_CLIENT_ID"))!;
      const requested = Object.fromEntries([...step.matchAll(/permission-([a-z-]+): (\w+)/g)].map((m) => [m[1]!.replace(/-/g, "_"), m[2]!]));
      const spec = appSpecs(c, "acme").find((s) => s.role === "release")!;
      expect(requested).toEqual(spec.tokenPermissions);
      expect(spec.permissions).toEqual(expectedPermissions("release", c.release));
      expect(spec.permissions.actions).toBe("write");
      expect(appSpecs(c, "acme").find((s) => s.role === "queue")!.permissions).toEqual(EXPECTED_PERMISSIONS.queue);
    }
  });

  test("audit fails a release App still registered with actions: read in dispatch mode, and passes one with actions: write", async () => {
    const c = parseConfig(withRelease(DISPATCH));
    const gh = {
      get: async () => ({}),
      list: async () => ({ items: [], truncated: false }),
    } as unknown as AuditGh;
    const app = (permissions: Record<string, string>): AppIdentity => ({ role: "release", slug: "acme-release", id: 7, permissions });
    const old = await appChecks(gh, "acme", [app(EXPECTED_PERMISSIONS.release)], "T11", c.release);
    expect(old.find((f) => f.status === "FAIL")?.message).toContain("for release.mode dispatch");
    expect(old.find((f) => f.status === "FAIL")?.details).toEqual(["actions: read, expected write"]);
    const ok = await appChecks(gh, "acme", [app(expectedPermissions("release", c.release))], "T11", c.release);
    expect(ok[0]!.status).toBe("PASS");
    // And in advance mode, actions: write on the release App is one permission too many.
    const adv = await appChecks(gh, "acme", [app(expectedPermissions("release", c.release))], "T11", parseConfig(base).release);
    expect(adv[0]!.status).toBe("FAIL");
  });
});
