// Shared batches for approved CI-policy PRs (queue.policy.shareBatch,
// DESIGN.md §4.3 (d)): opt-in; absent, every CI-policy PR runs alone. When
// set, consecutive approved CI-policy PRs at the head of the FIFO share one
// batch of at most `max`, never with ordinary PRs, and never with a trusted
// automation's waived PR or an operator-solo PR. A red shared batch is split
// like any other until the culprit runs alone.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { LivePr } from "../src/admission";
import { parseConfig, SCHEMA_PATH } from "../src/config/load";
import { schemaProblems } from "../src/config/schema";
import { policyHash } from "../src/queue";
import { cfg, cmd, green, livePr, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, red, Sim, sha, HUMAN, BOT_FILE } from "./sim";

const SHARE = cfg({ policyShareBatch: { max: 3 } });
const policy = (n: number, over: Partial<LivePr> = {}) => livePr(n, { policyPr: true, policyApproval: true, ...over });
const batches = (sim: Sim) => sim.builds.map((b) => b.prs);

describe("absent: today's behaviour", () => {
  test("consecutive approved CI-policy PRs each run alone", () => {
    const sim = new Sim(cfg()).add(policy(1), policy(2), policy(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2], [3]]);
  });
});

describe("queue.policy.shareBatch set", () => {
  test("consecutive approved CI-policy PRs share a batch, up to max", () => {
    const sim = new Sim(SHARE).add(policy(1), policy(2), policy(3), policy(4));
    const log = sim.tick();
    expect(log.join("\n")).toContain("build: 3 approved CI-policy PRs share a batch");
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1, 2, 3], [4]]);
    expect(sim.landed).toEqual([[1, 2, 3], [4]]);
  });

  test("a CI-policy PR never shares with an ordinary PR, in either order", () => {
    const sim = new Sim(SHARE).add(livePr(1), policy(2), policy(3), livePr(4), livePr(5));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2, 3], [4, 5]]);
  });

  test("FIFO is kept: a later CI-policy PR does not jump an ordinary PR to join an earlier one", () => {
    const sim = new Sim(SHARE).add(policy(1), livePr(2), policy(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2], [3]]);
  });

  test("a lone CI-policy PR builds at once, as before, without waiting to fill", () => {
    const sim = new Sim(cfg({ minFill: 4, maxWaitMinutes: 20, policyShareBatch: { max: 3 } })).add(policy(1), livePr(2));
    sim.tick();
    expect(batches(sim)).toEqual([[1]]);
  });

  test("an ordinary prefix is closed by a CI-policy PR behind it and builds without waiting", () => {
    const sim = new Sim(cfg({ minFill: 4, maxWaitMinutes: 20, policyShareBatch: { max: 3 } })).add(livePr(1), policy(2), policy(3));
    const log = sim.tick();
    expect(batches(sim)).toEqual([[1]]);
    expect(log.join("\n")).toContain("prefix closed by CI-policy #2");
  });

  test("an unapproved CI-policy PR is never admitted, so it never rides in a shared batch", () => {
    const sim = new Sim(SHARE).add(policy(1), policy(2, { policyApproval: false }), policy(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1, 3]]);
    expect(sim.state.auth["2"]).toBeUndefined();
    expect(sim.prs["2"]!.merged).toBe(false);
  });

  test("an approval that goes away while a shared batch runs drops that PR and abandons the batch", () => {
    const sim = new Sim(SHARE, () => ({ kind: "pending", reason: "running" })).add(policy(1), policy(2));
    sim.tick();
    expect(batches(sim)).toEqual([[1, 2]]);
    sim.prs["2"] = { ...sim.prs["2"]!, policyApproval: false };
    sim.oracle = () => green;
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1]]);
    expect(sim.state.auth["2"]).toBeUndefined();
  });

  test("an operator-solo CI-policy PR still runs alone and closes the shared prefix", () => {
    const sim = new Sim(SHARE).add(policy(1), policy(2), policy(3));
    sim.tick({ commands: [cmd("solo", 2)] });
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1], [2], [3]]);
  });

  test("the shared size is capped by the effective batch size after a red streak", () => {
    const sim = new Sim(cfg({ minBatch: 1, policyShareBatch: { max: 3 } })).add(policy(1), policy(2), policy(3));
    sim.state.redStreak = 2; // maxBatch 8 >> 2 = 2
    sim.tick();
    expect(batches(sim)).toEqual([[1, 2]]);
  });

  test("each PR's queued comment names the other CI-policy PRs it is tested with", () => {
    const sim = new Sim(SHARE).add(policy(1), policy(2), policy(3));
    sim.runUntilIdle();
    const queued = (pr: number) => sim.comments.find((c) => c.pr === pr && c.body.startsWith("Queued in batch"))!.body;
    expect(queued(1)).toContain("Its CI runs together with the approved CI-policy changes in #2, #3.");
    expect(queued(3)).toContain("in #1, #2.");
    const solo = new Sim(SHARE).add(policy(1));
    solo.runUntilIdle();
    expect(solo.comments.find((c) => c.body.startsWith("Queued in batch"))!.body).not.toContain("together with");
  });

  test("red: bisection still isolates the culprit, which is bounced, and the rest land", () => {
    const sim = new Sim(SHARE, (b) => (b.prs.includes(2) ? red() : green)).add(policy(1), policy(2), policy(3));
    sim.runUntilIdle();
    expect(batches(sim)).toEqual([[1, 2, 3], [1], [2, 3], [2], [3]]);
    expect(sim.landed.flat().sort()).toEqual([1, 3]);
    expect(sim.bounced).toEqual([2]);
  });

  test("red at the split depth limit: each CI-policy PR is retried alone", () => {
    const sim = new Sim(cfg({ maxSplitDepth: 0, policyShareBatch: { max: 3 } }), (b) => (b.prs.includes(3) ? red() : green)).add(policy(1), policy(2), policy(3));
    sim.runUntilIdle();
    expect(sim.landed).toEqual([[1], [2]]);
    expect(sim.bounced).toEqual([3]);
  });

  test("turned off with a split half still pending: its CI-policy PRs fall back to running alone", () => {
    const sim = new Sim(SHARE, (b) => (b.prs.length === 3 ? red() : green)).add(policy(1), policy(2), policy(3));
    // [1,2,3] red, rerun red → split [1] / [2,3]; [1] is built at once.
    while (sim.state.pending.length === 0) sim.tick();
    expect(sim.state.pending.map((p) => p.prs)).toEqual([[2, 3]]);
    expect(batches(sim).at(-1)).toEqual([1]);
    sim.config = cfg();
    sim.oracle = () => green;
    sim.runUntilIdle();
    expect(batches(sim).slice(-3)).toEqual([[1], [2], [3]]);
  });
});

describe("a trusted automation's waived PR still runs alone", () => {
  const BOT = { login: "some-automation[bot]", id: 4242 };
  const C = cfg({ trustedAutomations: [{ ...BOT, paths: [BOT_FILE] }], policyShareBatch: { max: 3 } });
  const OK = { ok: true as const, login: BOT.login, id: BOT.id, files: [BOT_FILE], globs: [BOT_FILE] };
  const botReady = { actorLogin: BOT.login, actorPermission: "none", at: "2026-10-21T10:00:01Z" };

  test("waived, it is batched alone even between approved CI-policy PRs", () => {
    const sim = new Sim(C).add(policy(1, { ready: { ...botReady, actorLogin: HUMAN, actorPermission: "admin", at: "2026-10-21T10:00:00Z" } }), policy(2, { ready: botReady, automation: OK, head: sha("bot") }), policy(3));
    sim.runUntilIdle();
    expect(sim.comments.some((c) => c.pr === 2 && c.body.startsWith("Queued in batch") && c.body.includes("Admitted under a trusted-automation waiver"))).toBe(true);
    expect(batches(sim)).toEqual([[1], [2], [3]]);
  });
});

describe("config", () => {
  const baseYaml = OPT_IN_FREE_YAML;
  const withShare = (max: unknown) => baseYaml.replace("    approvers: #", `    shareBatch:\n      max: ${JSON.stringify(max)}\n    approvers: #`);
  const problems = (text: string) => {
    try {
      parseConfig(text);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("absent: no key, and the control repo's policy hash is unchanged", () => {
    const { config } = parseConfig(baseYaml);
    expect("policyShareBatch" in config).toBe(false);
    expect(policyHash(config)).toBe(OPT_IN_FREE_HASH);
  });

  test("present: loaded, and part of the policy hash", () => {
    const { config } = parseConfig(withShare(4));
    expect(config.policyShareBatch).toEqual({ max: 4 });
    expect(policyHash(config)).not.toBe(OPT_IN_FREE_HASH);
    expect(policyHash(parseConfig(withShare(3)).config)).not.toBe(policyHash(config));
  });

  test("refused: max below 2, above queue.batch.max, or not an integer", () => {
    expect(problems(withShare(1))).toMatch(/shareBatch\.max: must be at least 2/);
    expect(problems(withShare(9))).toMatch(/queue\.policy\.shareBatch\.max must not exceed queue\.batch\.max/);
    expect(problems(withShare("4"))).toMatch(/shareBatch\.max/);
    expect(problems(baseYaml.replace("    approvers: #", "    shareBatch: {}\n    approvers: #"))).toMatch(/missing max/);
  });

  test("the runtime schema check agrees with ajv on the new key", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
    const set = (v: unknown) => {
      const c = YAML.parse(baseYaml) as Record<string, any>;
      if (v !== undefined) c.queue.policy.shareBatch = v;
      return c;
    };
    const corpus: [unknown, boolean][] = [
      [set(undefined), true],
      [set({ max: 2 }), true],
      [set({ max: 1 }), false],
      [set({ max: 2.5 }), false],
      [set({}), false],
      [set({ max: 2, extra: 1 }), false],
      [set(3), false],
    ];
    for (const [doc, ok] of corpus) {
      expect(validate(doc)).toBe(ok);
      expect(schemaProblems(schema, doc).length === 0).toBe(ok);
    }
  });
});
