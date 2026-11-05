// Trusted automations, continued: the snapshot reads the evidence over the
// fake GitHub, and qlander.yml carries the opt-in without moving the control
// repo's policy hash while it is absent.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { parseConfig, SCHEMA_PATH } from "../src/config/load";
import { schemaProblems } from "../src/config/schema";
import { TargetClient } from "../src/github/target";
import { decide } from "../src/machine";
import { policyHash } from "../src/queue";
import { buildSnapshot } from "../src/snapshot";
import { emptyState } from "../src/state";
import { WRITER, FakeTarget } from "./fake-github";
import { TARGET, cfg, job, OPT_IN_FREE_HASH, OPT_IN_FREE_YAML, sha, TARGET_OPTS, pathRe, TARGET_SLUG, NAMES, HUMAN, TRUSTED, BOT_FILE, reEscape } from "./sim";
import type { TrustedAutomation } from "../src/config";
import type { Account } from "../src/github/api";

const BOT: Account = { login: TRUSTED.login, id: TRUSTED.id };
const BOT_RULE: TrustedAutomation = { ...BOT, paths: [BOT_FILE] };
const BRANCH = "deps-bot/update";

const C = cfg({ trustedAutomations: [BOT_RULE] });
const NOW = new Date("2026-10-21T12:00:00Z");

/** The bot's routine bump as GitHub shows it: opened, authored, pushed and labelled by the bot. */
function botWorld(): { f: FakeTarget; n: number } {
  const f = new FakeTarget();
  const n = 7;
  const p = f.addPr(n, { user: BOT }, { files: [BOT_FILE], events: [{ id: 1, actor: BOT.login, at: "2026-10-21T10:00:00Z" }] });
  p.pr.head.ref = BRANCH;
  const head = p.pr.head.sha;
  f.commitAuthors.set(head, BOT);
  f.moveBranch(BRANCH, sha("prior"), head, BOT, "force_push");
  f.addRun({ head_sha: head, event: "pull_request", head_branch: BRANCH }, [job("fast")]);
  return { f, n };
}
const snapOf = (f: FakeTarget, c = C) => buildSnapshot({ api: f, cfg: c, state: emptyState(), now: NOW, paused: false, policyHash: "p1" });

describe("the snapshot reads the evidence", () => {
  test("the weekly bump is admitted and built alone, with no human and no approval comment", async () => {
    const { f, n } = botWorld();
    const s = await snapOf(f);
    expect(s.prs[String(n)]!.policyPr).toBe(true);
    expect(s.prs[String(n)]!.automation).toMatchObject({ ok: true });
    const d = decide(emptyState(), s, C);
    expect(d.state.auth[String(n)]?.waiver).toMatchObject({ readyByBot: true, policyWaived: true, files: [BOT_FILE] });
    expect(d.state.journal?.op).toMatchObject({ kind: "build", pins: [{ pr: n }] });
  });

  test("a human push onto the bot's branch takes the trust away, even with the bot forged as author", async () => {
    const { f, n } = botWorld();
    const before = f.prs.get(n)!.pr.head.sha;
    const after = f.push(n, { files: [BOT_FILE] });
    f.commitAuthors.set(after, BOT);
    f.moveBranch(BRANCH, before, after, WRITER);
    f.addRun({ head_sha: after, event: "pull_request", head_branch: BRANCH }, [job("fast")]);
    const s = await snapOf(f);
    expect(s.prs[String(n)]!.automation).toMatchObject({ ok: false, why: `${HUMAN} moved ${BRANCH} to ${after}` });
    expect(decide(emptyState(), s, C).state.auth[String(n)]).toBeUndefined();
  });

  test("a human's PR from the bot's branch name is not considered at all", async () => {
    const { f, n } = botWorld();
    f.prs.get(n)!.pr.user = WRITER;
    const s = await snapOf(f);
    expect(s.prs[String(n)]!.automation).toBeUndefined();
    expect(f.calls.some((c) => c.startsWith("activity"))).toBe(false);
  });

  test("an unreadable activity log is 'not trusted', never a failed tick", async () => {
    const { f, n } = botWorld();
    f.activityError = new Error("403 Resource not accessible by integration");
    const s = await snapOf(f);
    expect(s.prs[String(n)]!.automation).toMatchObject({ ok: false, why: expect.stringContaining("branch activity not readable") });
  });

  test("a non-Error thrown by the activity read is still 'not trusted'", async () => {
    const { f, n } = botWorld();
    f.listBranchActivity = async () => {
      throw null;
    };
    expect((await snapOf(f)).prs[String(n)]!.automation).toMatchObject({ ok: false, why: "branch activity not readable (null)" });
  });

  test("without the config, a bot PR is read exactly as before (no activity call)", async () => {
    const { f, n } = botWorld();
    const s = await snapOf(f, cfg());
    expect(s.prs[String(n)]!.automation).toBeUndefined();
    expect(f.calls.some((c) => c.startsWith("activity"))).toBe(false);
  });
});

const baseYaml = OPT_IN_FREE_YAML;
const withAutomations = (block: string) => baseYaml.replace("    approvers: #", `    trustedAutomations:\n${block}    approvers: #`);
const botBlock = `      - login: "${TRUSTED.login}"\n        id: ${TRUSTED.id}\n        paths:\n          - ${BOT_FILE}\n`;
const problems = (text: string) => {
  try {
    parseConfig(text);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

describe("config", () => {
  test("absent: the control repo's config has no key and its hash is unchanged", () => {
    const { config } = parseConfig(baseYaml);
    expect("trustedAutomations" in config).toBe(false);
    expect(policyHash(config)).toBe(OPT_IN_FREE_HASH);
  });

  test("present: loaded last, and part of the policy hash", () => {
    const { config } = parseConfig(withAutomations(botBlock));
    expect(config.trustedAutomations).toEqual([BOT_RULE]);
    expect(Object.keys(config).at(-1)).toBe("trustedAutomations");
    expect(policyHash(config)).not.toBe(OPT_IN_FREE_HASH);
    const wider = parseConfig(withAutomations(`${botBlock}          - app/pnpm-lock.yaml\n`)).config;
    expect(policyHash(wider)).not.toBe(policyHash(config));
  });

  const cases: [string, string, RegExp][] = [
    ["a login without [bot]", botBlock.replace(`"${TRUSTED.login}"`, TRUSTED.login.replace("[bot]", "")), /login: must match/],
    ["no paths", `      - login: "a[bot]"\n        id: 1\n        paths: []\n`, /paths: needs at least 1 item/],
    ["a missing id", `      - login: "a[bot]"\n        paths:\n          - deps.lock\n`, /missing id/],
    ["a bot listed twice", botBlock + botBlock, new RegExp(`login ${reEscape(TRUSTED.login)} is listed twice`)],
    ["a path into .github", `${botBlock}          - .github/workflows/ci.yml\n`, /must not reach into \.github/],
    ["a recursive glob", `${botBlock}          - tools/**\n`, /must not use '\*\*'/],
    ["a top-level wildcard", `${botBlock}          - "*"\n`, /must not reach into \.github/],
    ["a brace glob", `${botBlock}          - deps.{lock,nix}\n`, /must match/],
    ["a path listed twice", `${botBlock}          - ${BOT_FILE}\n`, new RegExp(`${reEscape(BOT_FILE)} is listed twice`)],
  ];
  for (const [name, block, want] of cases) test(`refused: ${name}`, () => expect(problems(withAutomations(block))).toMatch(want));

  test("refused: a path matching a gate file outside .github", () => {
    const moved = withAutomations(botBlock.replace(BOT_FILE, "gates/*.json"))
      .replace("path: .github/qualification.json", "path: gates/qualification.json")
      .replace("      - .github/**\n", "      - .github/**\n      - gates/**\n");
    expect(problems(moved)).toMatch(/matches the gate file gates\/qualification\.json/);
  });

  test("the runtime schema check agrees with ajv on the new key", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
    const set = (v: unknown) => {
      const c = YAML.parse(baseYaml) as Record<string, any>;
      if (v !== undefined) c.queue.policy.trustedAutomations = v;
      return c;
    };
    const corpus: [unknown, boolean][] = [
      [set(undefined), true],
      [set([{ login: "a[bot]", id: 1, paths: [BOT_FILE] }]), true],
      [set([]), false],
      [set([{ login: "a", id: 1, paths: ["x"] }]), false],
      [set([{ login: "a[bot]x", id: 1, paths: ["x"] }]), false],
      [set([{ login: "a[bot]", id: 0, paths: ["x"] }]), false],
      [set([{ login: "a[bot]", id: 1, paths: [] }]), false],
      [set([{ login: "a[bot]", id: 1, paths: ["a b"] }]), false],
      [set([{ login: "a[bot]", id: 1, paths: ["x"], extra: 1 }]), false],
    ];
    for (const [doc, valid] of corpus) {
      expect(validate(doc)).toBe(valid);
      expect(schemaProblems(schema, doc).length === 0).toBe(valid);
    }
  });
});

describe("the target client reads what the rule needs", () => {
  const routes = (extra: { match: RegExp; body: unknown; headers?: Record<string, string> }[]) => {
    const seen: string[] = [];
    const all = [{ match: pathRe(`/repos/${TARGET_SLUG}`), body: { id: TARGET } }, ...extra];
    const fakeFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      const r = all.find((x) => x.match.test(url));
      return new Response(JSON.stringify(r ? r.body : { message: "unrouted" }), { status: r ? 200 : 599, headers: r?.headers });
    }) as typeof fetch;
    return { seen, connect: () => TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "queue", fetch: fakeFetch, sleep: async () => {} }) };
  };

  test("branch activity: the ref filter, newest first, actors as accounts", async () => {
    const raw = { id: 9, ref: `refs/heads/${BRANCH}`, before: sha("a"), after: sha("b"), activity_type: "force_push", actor: { login: BOT.login, id: BOT.id, type: "Bot" }, timestamp: "2026-10-20T08:21:26Z" };
    const { seen, connect } = routes([{ match: /\/activity\?/, body: [raw, { ...raw, id: 8, actor: null }] }]);
    const c = await connect();
    expect(await c.listBranchActivity(BRANCH)).toEqual({
      items: [
        { id: 9, ref: raw.ref, before: raw.before, after: raw.after, activityType: "force_push", actor: BOT, timestamp: raw.timestamp },
        { id: 8, ref: raw.ref, before: raw.before, after: raw.after, activityType: "force_push", actor: null, timestamp: raw.timestamp },
      ],
      truncated: false,
    });
    const url = new URL(seen.at(-1)!);
    expect(url.pathname).toBe(`/repos/${TARGET_SLUG}/activity`);
    expect(url.searchParams.get("ref")).toBe(`refs/heads/${BRANCH}`);
    expect(url.searchParams.get("direction")).toBe("desc");
    await expect(c.listBranchActivity("a b")).rejects.toThrow("bad branch name");
  });

  test("activity past three pages is reported as truncated", async () => {
    const { connect } = routes([{ match: /\/activity/, body: [], headers: { link: `<https://api.github.com/repos/${TARGET_SLUG}/activity?page=n>; rel="next"` } }]);
    expect((await (await connect()).listBranchActivity(BRANCH)).truncated).toBe(true);
  });

  test("the PR author and each compared commit's resolved author are read", async () => {
    const h = sha("h");
    const { connect } = routes([
      { match: /pulls\/3$/, body: { number: 3, state: "open", draft: false, merged: false, mergeable: true, head: { sha: h, ref: BRANCH, repo: { id: TARGET } }, base: { ref: "main", repo: { id: TARGET } }, labels: [], user: { login: BOT.login, id: BOT.id } } },
      { match: /pulls\/4$/, body: { number: 4, state: "open", draft: false, merged: false, mergeable: true, head: { sha: h, ref: BRANCH, repo: { id: TARGET } }, base: { ref: "main", repo: { id: TARGET } }, labels: [], user: null } },
      {
        match: /\/compare\//,
        body: {
          status: "ahead", ahead_by: 2, behind_by: 0, files: [{ filename: BOT_FILE }],
          commits: [
            { sha: sha("c1"), parents: [{ sha: sha("m") }], commit: { verification: { verified: true } }, author: { login: BOT.login, id: BOT.id } },
            { sha: h, parents: [{ sha: sha("c1") }], commit: { verification: { verified: true } }, author: null },
          ],
        },
      },
    ]);
    const c = await connect();
    expect((await c.getPr(3)).user).toEqual(BOT);
    expect((await c.getPr(4)).user).toBeNull();
    expect((await c.compare(sha("m"), h)).commits.map((x) => x.author)).toEqual([BOT, null]);
  });
});
