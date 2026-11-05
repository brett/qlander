// qlander.yml `comments.omit` (docs/operating.md, "PR comments"): the queued and
// landed comments can be left out; every other comment is posted exactly as
// before, and nothing else about the run changes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CONFIG_PATH, ConfigError, parseConfig } from "../src/config/load";
import { policyHash } from "../src/queue";
import { World } from "./world";

const QUIET = { omit: ["queued", "landed"] as const };
/** A pushed commit's sha differs between two worlds; the comment's text must not. */
const shas = (c: string) => c.replace(/\b[0-9a-f]{40}\b/g, "<sha>");
const isProgress = (c: string) => c.startsWith("Queued in batch") || c.startsWith("Landed in ");

type Scenario = (w: World) => Promise<void>;

/** Run one scenario twice, with every comment and with the progress ones left out. */
async function both(oracle: ConstructorParameters<typeof World>[0], scenario: Scenario, prs: number[]) {
  const loud = new World(oracle);
  await scenario(loud);
  const quiet = new World(oracle);
  quiet.commentSettings = QUIET;
  await scenario(quiet);
  return { loud, quiet, prs };
}

const SCENARIOS: [string, ConstructorParameters<typeof World>[0], Scenario, number[]][] = [
  [
    "three PRs land in one batch",
    () => "pass",
    async (w) => {
      for (const n of [1, 2, 3]) w.readyPr(n);
      await w.runUntilIdle();
    },
    [1, 2, 3],
  ],
  [
    "a culprit is bounced",
    (b) => (b.prs.includes(3) ? "fail" : "pass"),
    async (w) => {
      for (const n of [1, 2, 3, 4, 5]) w.readyPr(n);
      await w.runUntilIdle();
    },
    [1, 2, 3, 4, 5],
  ],
  [
    "a conflict is not queued",
    () => "pass",
    async (w) => {
      for (const n of [1, 2, 3]) w.readyPr(n);
      w.target.conflicts.add(w.target.prs.get(2)!.pr.head.sha);
      await w.runUntilIdle();
    },
    [1, 2, 3],
  ],
  [
    "a queued PR's head moves",
    () => "pass",
    async (w) => {
      for (const n of [1, 2, 3]) w.readyPr(n);
      await w.untilBuilt();
      w.target.push(2);
      await w.runUntilIdle();
    },
    [1, 2, 3],
  ],
];

describe("comments.omit", () => {
  for (const [name, oracle, scenario, prs] of SCENARIOS) {
    test(`${name}: the same run, the same other comments, no queued or landed comment`, async () => {
      const { loud, quiet } = await both(oracle, scenario, prs);
      expect(quiet.landed()).toEqual(loud.landed());
      expect(quiet.bounced()).toEqual(loud.bounced());
      expect(quiet.mainHistory.length).toBe(loud.mainHistory.length);
      for (const n of prs) {
        expect(quiet.comments(n).filter(isProgress)).toEqual([]);
        expect(quiet.comments(n).map(shas)).toEqual(loud.comments(n).filter((c) => !isProgress(c)).map(shas));
        expect(quiet.target.prs.get(n)!.pr.labels).toEqual(loud.target.prs.get(n)!.pr.labels);
        expect(quiet.target.prs.get(n)!.pr.merged).toBe(loud.target.prs.get(n)!.pr.merged);
      }
      expect(quiet.state().outbox).toEqual([]);
    });
  }

  test("the default posts both progress comments, and the kept kinds are really exercised", async () => {
    const lands = await both(() => "pass", SCENARIOS[0]![2], [1]);
    expect(lands.loud.comments(1).some((c) => c.startsWith("Queued in batch"))).toBe(true);
    expect(lands.loud.comments(1).some((c) => c.startsWith("Landed in main"))).toBe(true);
    const bounce = await both(SCENARIOS[1]![1], SCENARIOS[1]![2], [3]);
    expect(bounce.quiet.comments(3).some((c) => c.startsWith("Bounced from the landing queue"))).toBe(true);
    const conflict = await both(() => "pass", SCENARIOS[2]![2], [2]);
    expect(conflict.quiet.comments(2).some((c) => c.startsWith("Not queued:") && c.includes("conflicts with main"))).toBe(true);
    const moved = await both(() => "pass", SCENARIOS[3]![2], [2]);
    expect(moved.quiet.comments(2).some((c) => c.startsWith("Removed from the landing queue"))).toBe(true);
  });

  test("each kind is left out on its own", async () => {
    for (const kind of ["queued", "landed"] as const) {
      const w = new World();
      w.commentSettings = { omit: [kind] };
      w.readyPr(1);
      await w.runUntilIdle();
      expect(w.landed()).toEqual([[1]]);
      expect(w.comments(1).some((c) => c.startsWith("Queued in batch"))).toBe(kind !== "queued");
      expect(w.comments(1).some((c) => c.startsWith("Landed in main"))).toBe(kind !== "landed");
    }
  });
});

describe("comments config", () => {
  const text = readFileSync(CONFIG_PATH, "utf8").replace(/\ncomments:\n(?: {2,}.*\n)*/, "\n");
  const withKey = (block: string) => `${text}\ncomments:\n${block}`;

  test("absent: every comment is posted", () => {
    expect(parseConfig(text).comments).toEqual({ omit: [] });
  });

  test("present: the kinds are read, duplicates collapse", () => {
    expect(parseConfig(withKey("  omit:\n    - landed\n    - landed\n")).comments).toEqual({ omit: ["landed"] });
    expect(parseConfig(withKey("  omit:\n    - queued\n    - landed\n")).comments).toEqual({ omit: ["queued", "landed"] });
  });

  test("only the progress comments can be left out", () => {
    expect(() => parseConfig(withKey("  omit:\n    - bounced\n"))).toThrow(ConfigError);
    expect(() => parseConfig(withKey("  quiet: true\n"))).toThrow(ConfigError);
  });

  test("not policy: the hash is the same with and without it", () => {
    const without = policyHash(parseConfig(text).config);
    expect(policyHash(parseConfig(withKey("  omit:\n    - queued\n    - landed\n")).config)).toBe(without);
    expect(policyHash(parseConfig(withKey("  omit:\n    - queued\n")).config)).toBe(without);
  });
});

describe("notify.assignees", () => {
  const text = readFileSync(CONFIG_PATH, "utf8").replace(/^notify:\n( .*\n)*/m, "");
  const withKey = (body: string) => `${text}\nnotify:\n${body}`;

  test("absent: nobody is assigned", () => {
    expect(parseConfig(text).notify).toEqual({ assignees: [] });
  });

  test("read and deduplicated, and outside the policy hash", () => {
    const loaded = parseConfig(withKey("  assignees:\n    - alice\n    - bob\n    - alice\n"));
    expect(loaded.notify).toEqual({ assignees: ["alice", "bob"] });
    expect(policyHash(loaded.config)).toBe(policyHash(parseConfig(text).config));
  });

  test("a login that cannot be one is refused", () => {
    expect(() => parseConfig(withKey("  assignees:\n    - not a login\n"))).toThrow(ConfigError);
  });
});
