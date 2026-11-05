// The priority lane's inputs (DESIGN.md §4.4): the label's actor, read by the
// snapshot, and the config keys. The decisions are in priority.test.ts.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import type { Config } from "../src/config";
import { parseConfig, SCHEMA_PATH } from "../src/config/load";
import { schemaProblems } from "../src/config/schema";
import { policyHash } from "../src/queue";
import { buildSnapshot } from "../src/snapshot";
import { emptyState } from "../src/state";
import { FakeTarget } from "./fake-github";
import { cfg, NAMES, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, BOT_FILE } from "./sim";

const LABEL = "queue:priority";
const withLabel = (over: Partial<Config> = {}): Config => cfg({ names: { ...NAMES, labels: { ...NAMES.labels, priority: LABEL } }, ...over });

describe("the label's actor (snapshot)", () => {
  const C = withLabel();
  const snap = (f: FakeTarget, config: Config = C) => buildSnapshot({ api: f, cfg: config, state: emptyState(), now: new Date("2026-10-21T12:00:00Z"), paused: false, policyHash: "p1" });
  const setup = (actor: string, permission?: string) => {
    const f = new FakeTarget();
    f.addPr(1);
    f.label(1, LABEL, actor);
    if (permission) f.permissions.set(actor, permission);
    return f;
  };

  test("counts when applied by a user with write, maintain or admin access", async () => {
    for (const perm of ["write", "maintain", "admin"]) {
      const pr = (await snap(setup("someone", perm))).prs["1"]!;
      expect(pr.priority).toEqual({ actorLogin: "someone", at: expect.any(String) });
      expect(pr.priorityIgnored).toBeUndefined();
    }
  });

  test("ignored when applied by a user with read or triage access, or none", async () => {
    for (const perm of ["read", "triage", undefined]) {
      const pr = (await snap(setup("someone", perm))).prs["1"]!;
      expect(pr.priority).toBeUndefined();
      expect(pr.priorityIgnored).toBe("applied by someone, who has no write access");
    }
  });

  test("ignored when a bot applied it, even a trusted automation with write access", async () => {
    const bot = "some-automation[bot]";
    const pr = (await snap(setup(bot, "write"), withLabel({ trustedAutomations: [{ login: bot, id: 4242, paths: [BOT_FILE] }] }))).prs["1"]!;
    expect(pr.priority).toBeUndefined();
    expect(pr.priorityIgnored).toBe(`applied by ${bot}, an automation`);
    expect((await snap(setup("other[bot]", "admin"))).prs["1"]!.priority).toBeUndefined();
  });

  test("ignored when applied by the review producer", async () => {
    const pr = (await snap(setup("review-producer", "admin"), withLabel({ reviewProducerLogins: ["review-producer"] }))).prs["1"]!;
    expect(pr.priority).toBeUndefined();
  });

  test("the latest application counts", async () => {
    const f = setup("writer", "write");
    f.label(1, LABEL, "reader");
    expect((await snap(f)).prs["1"]!.priority).toBeUndefined();
  });

  test("a newest application without a readable actor is no priority, even after a writer's", async () => {
    const f = setup("writer", "write");
    f.label(1, LABEL, null);
    const pr = (await snap(f)).prs["1"]!;
    expect(pr.priority).toBeUndefined();
    expect(pr.priorityIgnored).toBe("who applied it is not readable");
  });

  test("unreadable provenance or a failed lookup is no priority, never a failed tick", async () => {
    const f = setup("writer", "write");
    f.prs.get(1)!.eventsTruncated = true;
    expect((await snap(f)).prs["1"]!.priority).toBeUndefined();
    const g = setup("writer", "write");
    const real = g.permission.bind(g);
    g.permission = async (login: string) => {
      if (login === "writer") throw new Error("boom");
      return real(login);
    };
    const b = await snap(g);
    expect(b.prs["1"]!.priority).toBeUndefined();
    expect(b.prs["1"]!.priorityIgnored).toMatch(/not readable/);
  });

  test("not looked up when the label is not configured, or the PR is not ready", async () => {
    expect((await snap(setup("writer", "write"), cfg())).prs["1"]!.priority).toBeUndefined();
    const g = setup("writer", "write");
    const pr = g.prs.get(1)!.pr;
    pr.labels = pr.labels.filter((l) => l !== NAMES.labels.ready);
    expect((await snap(g)).prs["1"]?.priority).toBeUndefined();
  });
});

describe("config", () => {
  const baseYaml = OPT_IN_FREE_YAML;
  const withYaml = (label: string | null, priority?: string) => {
    let t = baseYaml;
    if (label) t = t.replace(/^( {4}go: .*)$/m, `$1\n    priority: ${label}`);
    if (priority) t = t.replace(/^( {2}controlLabels:)/m, `  priority:\n${priority}\n$1`);
    return t;
  };
  const problems = (text: string) => {
    try {
      parseConfig(text);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };

  test("absent: no keys, and the policy hash is unchanged", () => {
    const { config } = parseConfig(baseYaml);
    expect("priority" in config.names.labels).toBe(false);
    expect("priorityPreempt" in config).toBe(false);
    expect(policyHash(config)).toBe(OPT_IN_FREE_HASH);
  });

  test("the label alone turns the lane on; preempt: false adds nothing; both are in the hash", () => {
    const labelled = parseConfig(withYaml(LABEL)).config;
    expect(labelled.names.labels.priority).toBe(LABEL);
    expect("priorityPreempt" in labelled).toBe(false);
    expect(policyHash(labelled)).not.toBe(OPT_IN_FREE_HASH);
    expect(policyHash(parseConfig(withYaml(LABEL, "    preempt: false")).config)).toBe(policyHash(labelled));
    const preempt = parseConfig(withYaml(LABEL, "    preempt: true")).config;
    expect(preempt.priorityPreempt).toBe(true);
    expect(policyHash(preempt)).not.toBe(policyHash(labelled));
  });

  test("refused: preempt without the label, a label used twice, or an unknown key", () => {
    expect(problems(withYaml(null, "    preempt: true"))).toContain("queue.priority.preempt needs queue.labels.priority");
    expect(problems(withYaml(NAMES.labels.ready))).toMatch(/is used twice/);
    expect(problems(withYaml(LABEL, "    preempt: true\n    extra: 1"))).not.toBe("");
  });

  test("the runtime schema check agrees with ajv on the new keys", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
    const set = (label: unknown, priority: unknown) => {
      const c = YAML.parse(baseYaml) as Record<string, any>;
      if (label !== undefined) c.queue.labels.priority = label;
      if (priority !== undefined) c.queue.priority = priority;
      return c;
    };
    const corpus: [unknown, boolean][] = [
      [set(undefined, undefined), true],
      [set(LABEL, undefined), true],
      [set(LABEL, { preempt: true }), true],
      [set(LABEL, {}), true],
      [set("has space", undefined), false],
      [set(LABEL, { preempt: "yes" }), false],
      [set(LABEL, { other: true }), false],
      [set(LABEL, true), false],
    ];
    for (const [doc, ok] of corpus) {
      expect(validate(doc)).toBe(ok);
      expect(schemaProblems(schema, doc).length === 0).toBe(ok);
    }
  });
});
