// The runner contract (docs/deployment.md §3): one test per row of the §3.5
// validation table and the takeover arithmetic each mode feeds StateStore.open. Runs on whichever
// qlander.yml the suite runs with; only its runner block is replaced.
// (The last §3.5 row, the rendered tick workflow, is test/render.test.ts.)

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONFIG_PATH, ConfigError, type LoadedConfig, parseConfig } from "../src/config/load";
import { DEFAULT_EPOCH_PREFIX, HOSTED_MIN_GRACE_MINUTES, killBoundMinutes, type RunnerContract } from "../src/config/runner";
import { policyHash, tick } from "../src/queue";
import { releaseDryRun, releaseTick } from "../src/release-runner";
import { runDry, runReleaseDry } from "../src/main";

const controlYaml = readFileSync(CONFIG_PATH, "utf8");
const RUNNER_BLOCK = /^runner:\n(?: {2}.*\n)+/m;
const base = parseConfig(controlYaml);
const { leaseMinutes: LEASE, fenceMarginMinutes: MARGIN, reconcileMinutes: RECONCILE } = base.config;
const J = base.runner.jobTimeoutMinutes;
const CRON = base.runner.cronMinutes;

/** The control repo's config with its runner block replaced by these keys. */
function withRunner(keys: Record<string, string | number | boolean>): string {
  if (!RUNNER_BLOCK.test(controlYaml)) throw new Error("the config has no runner block in the expected form");
  const body = Object.entries(keys)
    .map(([k, v]) => `  ${k}: ${v}\n`)
    .join("");
  return controlYaml.replace(RUNNER_BLOCK, `runner:\n${body}`);
}

const selfHosted = (over: Record<string, string | number | boolean> = {}) =>
  withRunner({ mode: "self-hosted-kill", cronMinutes: CRON, jobTimeoutMinutes: J, hostKillMinutes: J + 1, takeoverGraceMinutes: 2, ...over });
const hosted = (over: Record<string, string | number | boolean> = {}) =>
  withRunner({ mode: "hosted", cronMinutes: CRON, jobTimeoutMinutes: J, takeoverGraceMinutes: HOSTED_MIN_GRACE_MINUTES, epochFence: true, ...over });

function problems(text: string): string {
  try {
    parseConfig(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems.join("\n");
  }
  throw new Error("expected the config to be refused");
}

const without = (text: string, key: string) => text.replace(new RegExp(`^  ${key}: .*\\n`, "m"), "");

describe("§3.5 validation of the runner block", () => {
  test("both base contracts load", () => {
    expect(parseConfig(selfHosted()).runner.mode).toBe("self-hosted-kill");
    const h = parseConfig(hosted()).runner;
    expect([h.mode, h.epochFence, h.epochPrefix, h.hostKillMinutes]).toEqual(["hosted", true, DEFAULT_EPOCH_PREFIX, null]);
  });

  test("row R1 (both modes): a job that can outlive its lease is refused", () => {
    const tooLong = LEASE - MARGIN + 1;
    for (const text of [selfHosted({ jobTimeoutMinutes: tooLong, hostKillMinutes: tooLong }), hosted({ jobTimeoutMinutes: tooLong })]) {
      expect(problems(text)).toContain(`queue: jobTimeoutMinutes (${tooLong}) must be <= leaseMinutes (${LEASE}) - fenceMarginMinutes (${MARGIN})`);
      expect(problems(text)).toContain(`release: jobTimeoutMinutes (${tooLong})`);
    }
  });

  test("row R6 (both modes): the lease must fit the configured cron, and reconcile must span two of its ticks", () => {
    for (const make of [selfHosted, hosted]) {
      // The interval comes from runner.cronMinutes, not a constant.
      expect(problems(make({ cronMinutes: LEASE }))).toContain(`leaseMinutes (${LEASE}) must be shorter than the cron interval (${LEASE})`);
      const wide = Math.floor(RECONCILE / 2) + 1;
      expect(wide).toBeGreaterThan(LEASE);
      expect(problems(make({ cronMinutes: wide }))).toContain("queue: reconcileMinutes must span at least two ticks");
      expect(() => parseConfig(make({ cronMinutes: Math.floor(RECONCILE / 2) }))).not.toThrow();
    }
  });

  test("row self-hosted-kill: hostKillMinutes >= jobTimeoutMinutes (and present); takeoverGraceMinutes >= 1", () => {
    expect(problems(selfHosted({ hostKillMinutes: J - 1 }))).toContain("runner.hostKillMinutes must be at least runner.jobTimeoutMinutes");
    expect(() => parseConfig(selfHosted({ hostKillMinutes: J }))).not.toThrow();
    expect(problems(without(selfHosted(), "hostKillMinutes"))).toContain("runner.hostKillMinutes is required in self-hosted-kill mode");
    expect(problems(selfHosted({ takeoverGraceMinutes: 0 }))).toMatch(/takeoverGraceMinutes: must be at least 1/);
  });

  test("row hosted: epochFence true, grace >= 15, an epoch prefix that overlaps nothing, and no host kill", () => {
    expect(problems(without(hosted(), "epochFence"))).toContain("runner.mode hosted requires runner.epochFence: true");
    expect(problems(hosted({ epochFence: false }))).toContain("runner.mode hosted requires runner.epochFence: true");
    expect(problems(hosted({ takeoverGraceMinutes: HOSTED_MIN_GRACE_MINUTES - 1 }))).toContain(`runner.takeoverGraceMinutes must be at least ${HOSTED_MIN_GRACE_MINUTES} in hosted mode`);
    expect(problems(hosted({ hostKillMinutes: J + 1 }))).toContain("runner.hostKillMinutes is for self-hosted-kill mode only");
    const n = base.config.names;
    for (const [key, clash] of [
      ["queue.refs.queuePrefix", n.queuePrefix],
      ["queue.refs.buildPrefix", `${n.buildPrefix}epoch/`],
      ["target.main", `${n.main}/`],
      ["release.branch", `${n.release}/`],
    ] as const) {
      expect(problems(hosted({ epochPrefix: clash }))).toContain(`runner.epochPrefix (${clash}) and ${key}`);
    }
    // The same check applies whenever the fence is on, in either mode.
    expect(problems(selfHosted({ epochFence: true, epochPrefix: n.queuePrefix }))).toContain("runner.epochPrefix");
    // With the fence off the prefix is unused, so it is not checked.
    expect(() => parseConfig(selfHosted({ epochPrefix: n.queuePrefix }))).not.toThrow();
  });

  test("row hosted: a valid hosted contract is supported (experiment H1 passed), and travels with the config", () => {
    const h = parseConfig(hosted());
    // The contract travels with the config, so a hosted config cannot be run against another file's contract.
    expect(h.config.runner).toBe(h.runner);
    expect(h.release.runner).toBe(h.runner);
    expect({ ...h.config }.runner.mode).toBe("hosted");
    // A whole hosted queue runs end to end against the fake GitHub: test/epoch-handover.test.ts.
  });

  test("an epoch prefix git would refuse (.lock component) is refused while the fence is on", () => {
    expect(problems(hosted({ epochPrefix: "epoch.lock/" }))).toContain("runner.epochPrefix (epoch.lock/): no component may end in .lock");
  });
});

describe("the takeover arithmetic (R5) is the mode's kill bound plus the grace", () => {
  const bound = (l: LoadedConfig) => [l.config.controllerKillMinutes, l.release.controllerKillMinutes, l.config.takeoverGraceMinutes, l.release.takeoverGraceMinutes];

  test("self-hosted-kill: the host kill, exactly the number StateStore.open always waited for", () => {
    const l = parseConfig(selfHosted({ hostKillMinutes: J + 3, takeoverGraceMinutes: 4 }));
    expect(bound(l)).toEqual([J + 3, J + 3, 4, 4]);
    expect(killBoundMinutes(l.runner)).toBe(J + 3);
    // The control repo's own config: Config's kill bound is its runner.hostKillMinutes.
    expect(base.config.controllerKillMinutes).toBe(base.runner.mode === "self-hosted-kill" ? base.runner.hostKillMinutes! : base.runner.jobTimeoutMinutes);
  });

  test("hosted: the job timeout (§3.3)", () => {
    const l = parseConfig(hosted({ takeoverGraceMinutes: 30 }));
    expect(bound(l)).toEqual([J, J, 30, 30]);
  });
});

describe("the runner contract's own keys are outside the policy hash", () => {
  const sameNumbers = (over: Record<string, string | number | boolean>) => policyHash(parseConfig(selfHosted(over)).config);
  const h0 = sameNumbers({});

  test("cronMinutes, epochFence and epochPrefix do not change it", () => {
    expect(sameNumbers({ cronMinutes: Math.floor(RECONCILE / 2) })).toBe(h0);
    expect(sameNumbers({ epochFence: false, epochPrefix: "some-epoch/" })).toBe(h0);
  });

  test("the timing numbers still do", () => {
    expect(sameNumbers({ hostKillMinutes: J + 2 })).not.toBe(h0);
    expect(sameNumbers({ takeoverGraceMinutes: 3 })).not.toBe(h0);
  });

  test("the contract type has every key the schema allows", () => {
    const r: RunnerContract = parseConfig(selfHosted()).runner;
    expect(Object.keys(r).sort()).toEqual(["cronMinutes", "epochFence", "epochPrefix", "hostKillMinutes", "jobTimeoutMinutes", "mode", "takeoverGraceMinutes"]);
  });
});
