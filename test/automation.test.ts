// Trusted automations: a configured bot's PR lands
// without a human only while every condition in src/automation.ts holds, and
// each way of borrowing that trust falls back to today's rules. The snapshot
// and config halves are in automation-config.test.ts.

import { describe, expect, test } from "bun:test";
import { admit, type LivePr, revalidate, waiverFor } from "../src/admission";
import { allowedPathProblem, automationFor, automationTrust, describeWaiver } from "../src/automation";
import type { TrustedAutomation } from "../src/config";
import type { Account, Compare, Listed, RefActivity } from "../src/github/api";
import { parseState } from "../src/state";
import { WRITER } from "./fake-github";
import { cfg, livePr, NAMES, Sim, sha, HUMAN } from "./sim";

const BOT: Account = { login: "deps-bot[bot]", id: 4242 };
const BOT_RULE: TrustedAutomation = { ...BOT, paths: ["deps.lock"] };
const BRANCH = "update_flake_lock_action";
const C = cfg({ trustedAutomations: [BOT_RULE] });

const H1 = sha("h1");
const H2 = sha("h2");
const MAIN = sha("main");

function diff(over: Partial<Compare> = {}, commits: { sha: string; author: Account | null }[] = [{ sha: H1, author: BOT }]): Compare {
  return {
    status: "ahead",
    aheadBy: commits.length,
    behindBy: 0,
    commits: commits.map((c, i) => ({ sha: c.sha, parents: [i === 0 ? MAIN : commits[i - 1]!.sha], verified: true, author: c.author })),
    files: ["deps.lock"],
    truncated: false,
    commitsTruncated: false,
    ...over,
  };
}
let actId = 1;
const move = (before: string, after: string, actor: Account | null, ref = `refs/heads/${BRANCH}`, activityType = "force_push"): RefActivity => ({
  id: actId++,
  ref,
  before,
  after,
  activityType,
  actor,
  timestamp: "2026-10-20T08:21:26Z",
});
const acts = (items: RefActivity[], truncated = false): Listed<RefActivity> => ({ items, truncated });
const trust = (d: Compare, a: Listed<RefActivity>, head = H1) => automationTrust(BOT_RULE, { headRef: BRANCH, head }, d, a);
const OLD = sha("old");

describe("the trust rule (src/automation.ts)", () => {
  test("the routine bump: one bot commit, pushed by the bot, changing only deps.lock", () => {
    expect(trust(diff(), acts([move(OLD, H1, BOT)]))).toEqual({ ok: true, login: BOT.login, id: BOT.id, files: ["deps.lock"], globs: ["deps.lock"] });
  });

  test("spoof: a human opens a PR from a branch named like the bot's; only the PR author (login AND id) decides", () => {
    expect(automationFor([BOT_RULE], WRITER)).toBeUndefined();
    expect(automationFor([BOT_RULE], { login: BOT.login, id: 1 })).toBeUndefined();
    expect(automationFor([BOT_RULE], { login: "deps-bot", id: BOT.id })).toBeUndefined();
    expect(automationFor([BOT_RULE], null)).toBeUndefined();
    expect(automationFor(undefined, BOT)).toBeUndefined();
    expect(automationFor([BOT_RULE], BOT)).toBe(BOT_RULE);
  });

  test("spoof: a human pushes their own commit onto the bot's PR", () => {
    const t = trust(diff({}, [{ sha: H1, author: BOT }, { sha: H2, author: WRITER }]), acts([move(H1, H2, WRITER, undefined, "push"), move(OLD, H1, BOT)]), H2);
    expect(t).toMatchObject({ ok: false, why: `commit ${H2} is authored by ${HUMAN}` });
  });

  test("spoof: a human forges the bot as author (contents API, GitHub-signed) and pushes it", () => {
    const t = trust(diff({}, [{ sha: H1, author: BOT }, { sha: H2, author: BOT }]), acts([move(H1, H2, WRITER, undefined, "push"), move(OLD, H1, BOT)]), H2);
    expect(t).toMatchObject({ ok: false, why: `${HUMAN} moved ${BRANCH} to ${H2}` });
  });

  test("spoof: a human edits the branch, then force-pushes the bot's own sha back", () => {
    const t = trust(diff(), acts([move(sha("x"), H1, WRITER), move(H1, sha("x"), WRITER, undefined, "push"), move(OLD, H1, BOT)]));
    expect(t).toMatchObject({ ok: false, why: `${HUMAN} moved ${BRANCH} to ${H1}` });
  });

  test("a forged commit buried under a later bot push is still caught (every commit needs its own bot push)", () => {
    const t = trust(diff({}, [{ sha: H1, author: BOT }, { sha: H2, author: BOT }]), acts([move(H1, H2, BOT, undefined, "push"), move(OLD, H1, WRITER)]), H2);
    expect(t).toMatchObject({ ok: false, why: `${HUMAN} moved ${BRANCH} to ${H1}` });
  });

  test("a commit that arrived inside one multi-commit push is not proven: fails closed", () => {
    const t = trust(diff({}, [{ sha: H1, author: BOT }, { sha: H2, author: BOT }]), acts([move(OLD, H2, BOT)]), H2);
    expect(t).toMatchObject({ ok: false, why: `no push of ${H1} by ${BOT.login} to ${BRANCH}` });
  });

  test("a push to another branch, by an unknown account, or by a same-login account with another id does not count", () => {
    expect(trust(diff(), acts([move(OLD, H1, BOT, "refs/heads/other")]))).toMatchObject({ ok: false });
    expect(trust(diff(), acts([move(OLD, H1, null)]))).toMatchObject({ ok: false, why: `an unknown account moved ${BRANCH} to ${H1}` });
    expect(trust(diff(), acts([move(OLD, H1, { login: BOT.login, id: 7 })]))).toMatchObject({ ok: false });
  });

  test("an activity read that stopped early, a cut compare, an empty change or a missing head fails closed", () => {
    expect(trust(diff(), acts([], true))).toMatchObject({ ok: false, why: "the branch's activity history is longer than qlander reads" });
    // a visible bot push does not outweigh what the unread pages may hold (an older human push of the same sha).
    expect(trust(diff(), acts([move(OLD, H1, BOT)], true))).toMatchObject({ ok: false, why: "the branch's activity history is longer than qlander reads" });
    expect(trust(diff({ truncated: true }), acts([move(OLD, H1, BOT)]))).toMatchObject({ ok: false, why: "the change list may be incomplete" });
    expect(trust(diff({ files: [] }), acts([move(OLD, H1, BOT)]))).toMatchObject({ ok: false, why: "nothing to land" });
    expect(trust(diff(), acts([move(OLD, H1, BOT)]), H2)).toMatchObject({ ok: false, why: "the compare does not include the head" });
  });

  test("a commit whose author email maps to no account is not the bot's", () => {
    expect(trust(diff({}, [{ sha: H1, author: null }]), acts([move(OLD, H1, BOT)]))).toMatchObject({ ok: false, why: `commit ${H1} is authored by an unknown account` });
  });

  test("renames count under both names: moving a file onto or off an allowed path is not allowed", () => {
    // target.ts lists a rename under its new and previous filename.
    expect(trust(diff({ files: ["deps.lock", "tools/evil.sh"] }), acts([move(OLD, H1, BOT)]))).toMatchObject({ ok: false, why: "changes tools/evil.sh, which is not one of its allowed paths" });
  });

  test("a policy path outside the allowlist (deps.nix next to deps.lock) loses the waiver", () => {
    expect(trust(diff({ files: ["deps.lock", "deps.nix"] }), acts([move(OLD, H1, BOT)]))).toMatchObject({ ok: false, why: "changes deps.nix, which is not one of its allowed paths" });
  });

  test("globs match whole paths only: deps.lock is not tools/deps.lock, and * stays in its segment", () => {
    expect(trust(diff({ files: ["tools/deps.lock"] }), acts([move(OLD, H1, BOT)]))).toMatchObject({ ok: false });
    const wide: TrustedAutomation = { ...BOT, paths: ["deps/*.lock"] };
    const t = (files: string[]) => automationTrust(wide, { headRef: BRANCH, head: H1 }, diff({ files }), acts([move(OLD, H1, BOT)]));
    expect(t(["deps/a.lock"]).ok).toBe(true);
    expect(t(["deps/x/a.lock"]).ok).toBe(false);
    expect(t(["deps/a.lock.sh"]).ok).toBe(false);
    expect(t(["Deps/a.lock"]).ok).toBe(false);
  });

  test("allowed-path globs are narrow by construction", () => {
    for (const ok of ["deps.lock", "tools/*.sh", "app/pnpm-lock.yaml", "deps/v1_2/x.lock"]) expect(allowedPathProblem(ok)).toBeNull();
    const bad: [string, RegExp][] = [
      ["**", /must not use '\*\*'/],
      ["tools/**", /must not use '\*\*'/],
      ["*", /\.github/],
      ["*/workflows/ci.yml", /\.github/],
      [".github/workflows/x.yml", /\.github/],
      [".git*/x", /\.github/],
      ["/deps.lock", /relative path/],
      ["./deps.lock", /relative path/],
      ["a/../deps.lock", /relative path/],
      ["a//b", /relative path/],
      ["flake.{lock,nix}", /may use only/],
      ["flake.loc?", /may use only/],
      ["[f]lake.lock", /may use only/],
      ["!deps.lock", /may use only/],
      ["flake\\.lock", /may use only/],
      ["flake lock", /may use only/],
    ];
    for (const [glob, why] of bad) expect(`${glob}: ${allowedPathProblem(glob)}`).toMatch(why);
  });
});

const OK = { ok: true as const, login: BOT.login, id: BOT.id, files: ["deps.lock"], globs: ["deps.lock"] };
const botReady = { actorLogin: BOT.login, actorPermission: "none", at: "2026-10-21T10:00:00Z" };
const humanReady = { actorLogin: HUMAN, actorPermission: "admin", at: "2026-10-21T10:00:00Z" };
const botPr = (over: Partial<LivePr> = {}) => livePr(1, { policyPr: true, ready: botReady, automation: OK, ...over });

describe("admission with a trusted automation", () => {
  test("the bot's own ready counts and the policy approval is waived", () => {
    const pr = botPr();
    expect(admit(pr, C)).toEqual({ ok: true });
    expect(waiverFor(pr, C)).toEqual({ rule: "trusted-automation", login: BOT.login, id: BOT.id, readyByBot: true, policyWaived: true, files: ["deps.lock"], globs: ["deps.lock"] });
  });

  test("a writer's ready plus trust: only the policy approval is waived", () => {
    const pr = botPr({ ready: humanReady });
    expect(admit(pr, C)).toEqual({ ok: true });
    expect(waiverFor(pr, C)).toMatchObject({ readyByBot: false, policyWaived: true });
  });

  test("an approved policy PR readied by a writer needs no waiver", () => {
    expect(waiverFor(botPr({ ready: humanReady, policyApproval: true }), C)).toBeNull();
  });

  test("trust that fails: the bot's ready is ignored, and a writer's ready still waits for approval", () => {
    const failed = { ok: false as const, login: BOT.login, why: "changes deps.nix, which is not one of its allowed paths" };
    expect(admit(botPr({ automation: failed }), C)).toEqual({ ok: false, kind: "ignore", reason: `ready applied without write access (trusted automation: ${failed.why})` });
    const human = botPr({ automation: failed, ready: humanReady });
    expect(admit(human, C)).toMatchObject({ ok: false, kind: "wait", reason: expect.stringContaining("SHA-bound approval (trusted automation: changes deps.nix") });
    expect(admit({ ...human, policyApproval: true }, C)).toEqual({ ok: true });
    expect(waiverFor({ ...human, policyApproval: true }, C)).toBeNull();
  });

  test("another bot's ready does not borrow this bot's trust", () => {
    expect(admit(botPr({ ready: { actorLogin: "other[bot]", actorPermission: "none", at: "x" } }), C)).toMatchObject({ ok: false, kind: "ignore", reason: "ready applied without write access" });
  });

  test("without automation, nothing changes: the bot's ready is ignored and a policy change needs approval", () => {
    expect(admit(botPr({ automation: undefined }), C)).toMatchObject({ ok: false, kind: "ignore" });
    expect(admit(botPr({ automation: undefined, ready: humanReady }), C)).toMatchObject({ ok: false, kind: "wait" });
  });

  test("revalidation drops a waived PR whose trust no longer holds, even if it now has an approval", () => {
    const pr = botPr();
    const auth = { head: pr.head, baseRepoId: pr.baseRepoId, policy: "p", policyPr: true, admittedAt: "x", labelledAt: "x", evidence: [], reviewRun: null, waiver: waiverFor(pr, C)! };
    expect(revalidate(auth, pr, C, "p")).toEqual({ ok: true });
    const lost = botPr({ automation: { ok: false, login: BOT.login, why: `${HUMAN} moved it` }, ready: humanReady, policyApproval: true });
    expect(revalidate(auth, lost, C, "p")).toMatchObject({ ok: false, reason: `trusted-automation waiver no longer holds: ${HUMAN} moved it` });
  });
});

describe("revalidation does not let a waiver appear after admission", () => {
  const authFor = (pr: LivePr) => ({ head: pr.head, baseRepoId: pr.baseRepoId, policy: "p", policyPr: pr.policyPr, admittedAt: "x", labelledAt: "x", evidence: [], reviewRun: null });

  test("admitted on a writer's ready and an approval, then the bot's ready replaces it: dropped for re-admission", () => {
    const pr = botPr({ ready: humanReady, policyApproval: true });
    const auth = authFor(pr);
    expect(revalidate(auth, pr, C, "p")).toEqual({ ok: true });
    expect(revalidate(auth, { ...pr, ready: botReady }, C, "p")).toMatchObject({ ok: false, headMoved: false, reason: expect.stringContaining("not admitted with") });
  });

  test("admitted with an approval, then the approval goes: dropped for re-admission", () => {
    const pr = botPr({ ready: humanReady, policyApproval: true });
    expect(revalidate(authFor(pr), { ...pr, policyApproval: false }, C, "p")).toMatchObject({ ok: false, reason: expect.stringContaining("not admitted with") });
  });

  test("a waiver that becomes unnecessary (an approval arrives) does not drop the PR", () => {
    const pr = botPr();
    const auth = { ...authFor(pr), waiver: waiverFor(pr, C)! };
    expect(revalidate(auth, { ...pr, policyApproval: true, ready: humanReady }, C, "p")).toEqual({ ok: true });
  });

  test("re-admitted on the next tick, the PR records the waiver and runs alone", () => {
    const sim = new Sim(C).add(botPr({ number: 1, ready: humanReady, policyApproval: true, policyPr: false }), livePr(2));
    sim.tick();
    expect(sim.state.auth["1"]?.waiver).toBeUndefined();
    sim.prs["1"] = { ...sim.prs["1"]!, ready: botReady };
    sim.runUntilIdle();
    // The shared batch is abandoned before landing; #1 is re-admitted under the waiver and lands alone.
    expect(sim.builds.map((b) => b.prs)).toEqual([[1, 2], [2], [1]]);
    expect(sim.landed).toEqual([[2], [1]]);
    expect(sim.comments.some((c) => c.pr === 1 && c.body.startsWith("Landed in main") && c.body.includes("its own `ready` counted"))).toBe(true);
  });
});

describe("the queue", () => {
  const line = `trusted-automation waiver for ${BOT.login} (id ${BOT.id}): its own \`ready\` counted; no CI-policy approval was needed; changed \`deps.lock\`, allowed by \`deps.lock\``;

  test("a waived PR runs alone, and its queued and landing comments name the rule, the bot and the paths", () => {
    const sim = new Sim(C).add(livePr(1), botPr({ number: 2, head: sha("bot-head") }), livePr(3));
    sim.runUntilIdle();
    expect(sim.builds.map((b) => b.prs)).toEqual([[2], [1, 3]]); // labelled first, alone; the others batch together
    const mine = sim.comments.filter((c) => c.pr === 2).map((c) => c.body);
    expect(mine.some((b) => b.startsWith("Queued in batch") && b.includes(`Admitted under a ${line}.`))).toBe(true);
    expect(mine.some((b) => b.startsWith("Landed in main") && b.includes(`Landed under a ${line}. It ran the full pre-landing suite in a batch of its own.`))).toBe(true);
    expect(sim.comments.filter((c) => c.pr !== 2).every((c) => !c.body.includes("waiver"))).toBe(true);
  });

  test("a trusted PR outside the policy boundary still runs alone", () => {
    const sim = new Sim(C).add(livePr(1), botPr({ number: 2, policyPr: false }), livePr(3));
    sim.runUntilIdle();
    expect(sim.builds.map((b) => b.prs)).toEqual([[2], [1, 3]]); // labelled first, alone; the others batch together
  });

  test("the waiver round-trips through the state document, and a malformed one is refused", () => {
    const sim = new Sim(C).add(botPr());
    sim.tick();
    const doc = JSON.parse(JSON.stringify(sim.state));
    expect(parseState(JSON.stringify(doc), NAMES).auth["1"]!.waiver).toMatchObject({ login: BOT.login });
    doc.auth["1"].waiver.rule = "anything";
    expect(() => parseState(JSON.stringify(doc), NAMES)).toThrow(/waiver\.rule/);
  });

  test("a writer-readied waiver mentions only the approval", () => {
    expect(describeWaiver({ rule: "trusted-automation", login: "b[bot]", id: 1, readyByBot: false, policyWaived: true, files: ["a"], globs: ["a"] })).toBe(
      "trusted-automation waiver for b[bot] (id 1): no CI-policy approval was needed; changed `a`, allowed by `a`",
    );
  });
});
