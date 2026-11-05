// The App token variables (qlander.yml `tokens`): neutral defaults when
// absent, the configured names when set, refused when they would collide, and
// never part of the policy hash.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConfigError, DEFAULT_TOKENS, parseConfig } from "../src/config/load";
import { assertOwnKeyOnly } from "../src/main";
import { policyHash } from "../src/queue";
import { defaultReleaseConfig, QUEUE_TOKEN_ENV } from "../src/release-config";

const base = readFileSync(`${import.meta.dir}/fixtures/acme.qlander.yml`, "utf8");
const withTokens = (block: string) => `${base}\ntokens:\n${block}`;

describe("tokens", () => {
  test("absent: TARGET_TOKEN and TARGET_RELEASE_TOKEN", () => {
    const c = parseConfig(base);
    expect(c.tokens).toEqual({ queue: "TARGET_TOKEN", release: "TARGET_RELEASE_TOKEN" });
    expect(DEFAULT_TOKENS).toEqual(c.tokens);
    expect(c.release.tokenEnv).toBe("TARGET_RELEASE_TOKEN");
  });

  test("set: the configured names, and the release job's tokenEnv follows", () => {
    const c = parseConfig(withTokens("  queue: ACME_QUEUE_TOKEN\n  release: ACME_RELEASE_TOKEN\n"));
    expect(c.tokens).toEqual({ queue: "ACME_QUEUE_TOKEN", release: "ACME_RELEASE_TOKEN" });
    expect(c.release.tokenEnv).toBe("ACME_RELEASE_TOKEN");
  });

  test("one set, the other defaulted", () => {
    expect(parseConfig(withTokens("  queue: ACME_QUEUE_TOKEN\n")).tokens).toEqual({ queue: "ACME_QUEUE_TOKEN", release: "TARGET_RELEASE_TOKEN" });
  });

  test("not policy: the policy hash is the same with or without them", () => {
    const set = parseConfig(withTokens("  queue: ACME_QUEUE_TOKEN\n  release: ACME_RELEASE_TOKEN\n"));
    expect(policyHash(set.config)).toBe(policyHash(parseConfig(base).config));
  });

  test.each([
    ["the same name twice", "  queue: ACME_TOKEN\n  release: ACME_TOKEN\n", /must differ/],
    ["a default colliding with a set name", "  queue: TARGET_RELEASE_TOKEN\n", /must differ/],
    ["the state App's variable", "  queue: STATE_TOKEN\n", /tokens\.queue: STATE_TOKEN is reserved/],
    ["the workflow token", "  release: GITHUB_TOKEN\n", /tokens\.release: GITHUB_TOKEN is reserved/],
    ["the mode variable", "  queue: QLANDER_MODE\n", /reserved/],
    ["a runner variable", "  queue: RUNNER_TEMP\n", /reserved/],
    ["an Actions variable", "  queue: ACTIONS_RUNTIME_TOKEN\n", /reserved/],
    ["not an environment variable name", "  queue: acme-token\n", /tokens\.queue/],
    ["an unknown key", "  other: ACME_TOKEN\n", /tokens/],
  ])("refused: %s", (_why, block, msg) => {
    expect(() => parseConfig(withTokens(block))).toThrow(ConfigError);
    expect(() => parseConfig(withTokens(block))).toThrow(msg);
  });
});

describe("the jobs read the control repo's configured names", () => {
  test("each job refuses to start when it can see the other job's configured variable", () => {
    expect(() => assertOwnKeyOnly({ [QUEUE_TOKEN_ENV]: "q" }, "release")).toThrow(QUEUE_TOKEN_ENV);
    expect(() => assertOwnKeyOnly({ [defaultReleaseConfig.tokenEnv]: "r" }, "queue")).toThrow(defaultReleaseConfig.tokenEnv);
    expect(() => assertOwnKeyOnly({ [QUEUE_TOKEN_ENV]: "q" }, "queue")).not.toThrow();
  });
});
