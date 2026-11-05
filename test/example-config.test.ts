// The neutral example config and the script that runs the suite on it
// (scripts/test-on-example.ts).

import { describe, expect, test } from "bun:test";
import { isPolicyChange } from "../src/evidence";
import { loadConfig } from "../src/config/load";
import { excludeList } from "../scripts/test-on-example";

describe("test/fixtures/example.qlander.yml", () => {
  const c = loadConfig(`${import.meta.dir}/fixtures/example.qlander.yml`);

  test("loads, with the default token variables", () => {
    expect(c.tokens).toEqual({ queue: "TARGET_TOKEN", release: "TARGET_RELEASE_TOKEN" });
  });

  test("has what test/sim.ts needs: a trusted automation whose file is a policy path, and the two test lanes", () => {
    const bot = c.config.trustedAutomations?.[0];
    expect(bot).toBeDefined();
    expect(isPolicyChange([bot!.paths[0]!], c.config.policyBoundary)).toBe(true);
    expect(c.config.preLanding[0]!.required_jobs.length).toBeGreaterThanOrEqual(13);
  });
});

describe("excludeList", () => {
  test("no rules file: nothing is deleted", () => {
    expect(excludeList(null)).toEqual([]);
  });

  test("the rules file's exclude list, as written", () => {
    expect(excludeList(JSON.stringify({ exclude: ["private/", "test/pinned.test.ts"] }))).toEqual(["private/", "test/pinned.test.ts"]);
  });
});
