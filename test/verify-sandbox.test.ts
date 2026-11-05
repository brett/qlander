// verify-sandbox (src/sandbox/): G1 and H1 checks 2 to 4 against an in-memory
// sandbox (test/sandbox-fake.ts) whose rulesets behave per actor, so every
// check is shown passing on a correct sandbox and failing when the property
// it checks is broken. No network.

import { describe, expect, spyOn, test } from "bun:test";
import { defaultConfig, type Names } from "../src/config";
import { GitHubError } from "../src/github/http";
import { isRemoteRefusal, plan, type Phase, PHASES, PushRejected, Recorder, refNumbers, summarize, verdict } from "../src/sandbox/checks";
import { forbiddenTarget, parseArgs, phaseTokens, runPhase, UsageError, verifySandbox, type Deps } from "../src/sandbox/command";
import { ADMIN_ID, APPS, FakeSandbox, OTHER_REPO, SANDBOX } from "./sandbox-fake";

const NAMES: Names = {
  ...defaultConfig.names,
  control: { owner: "acme", name: "control", id: 1 },
  target: { owner: "acme", name: "widgets", id: 2 },
  main: "main",
  release: "release",
  queuePrefix: "queue/",
  buildPrefix: "qlander-build/",
  stateBranch: "qlander-state",
  releaseStateBranch: "qlander-release-state",
};
const PREFIX = "qlander-epoch/";
const EQ = `${PREFIX}queue`;
const ER = `${PREFIX}release`;
const PN = { names: NAMES, epochQueue: EQ, epochRelease: ER };

const ENV: Record<Phase, Record<string, string>> = {
  queue: { VERIFY_QUEUE_TOKEN: "queue-token", VERIFY_STATE_TOKEN: "state-token" },
  release: { VERIFY_RELEASE_TOKEN: "release-token" },
  cross: { VERIFY_QUEUE_TOKEN: "queue-token" },
  admin: { VERIFY_ADMIN_TOKEN: "admin-token" },
};

function deps(fake: FakeSandbox): Deps {
  return { http: { fetch: fake.fetch, sleep: fake.sleep }, now: fake.now, pusher: (_s, token) => fake.pusher(token), log: () => {}, mergeWaitMs: 0, runsWaitMs: 0 };
}
const run = (fake: FakeSandbox, phase: Phase, env: Record<string, string> = ENV[phase]) => runPhase(phase, SANDBOX, NAMES, PREFIX, env, deps(fake));
const byId = (s: { checks: { id: string; pass: boolean; observed: string }[] }) => Object.fromEntries(s.checks.map((c) => [c.id, c]));

async function allPhases(fake: FakeSandbox) {
  const out: Record<string, Awaited<ReturnType<typeof run>>> = {};
  for (const p of PHASES) out[p] = await run(fake, p);
  return out;
}

describe("plans", () => {
  test("ids are unique per phase; refusals are planned only for writes that must be refused", () => {
    for (const p of PHASES) {
      const ids = plan(p, PN).map((c) => c.id);
      expect(new Set(ids).size, p).toBe(ids.length);
    }
    const refused = (p: Phase) => plan(p, PN).filter((c) => c.expected === "refused").map((c) => c.id);
    expect(refused("queue")).toEqual(["c2", "c3", "f1", "f3", "f2", "f4", "f5", "f6", "hq6", "hq7", "hq8", "hq9", "hq10", "hq11", "hq12"]);
    expect(refused("release")).toEqual(["hr4", "hr5", "hr6", "hr7", "hr8", "hr9", "hr10"]);
    expect(refused("cross")).toEqual(["hc1", "hc2", "hc3"]);
    expect(refused("admin")).toEqual(["haq1", "haq2", "haq3", "haq4", "haq5", "har1", "har2", "har3", "har4", "har5"]);
  });

  test("titles come from the config's names, not constants", () => {
    const other = { names: { ...NAMES, main: "trunk", queuePrefix: "mq/" }, epochQueue: "fence/queue", epochRelease: "fence/release" };
    const text = plan("queue", other).map((c) => c.title).join("\n");
    expect(text).toContain("trunk");
    expect(text).toContain("mq/<n>");
    expect(text).toContain("fence/queue");
    expect(text).not.toContain("qlander-epoch/");
  });
});

describe("verdicts", () => {
  test("pass only on the expected outcome with no postcondition problem; a skip only when acceptable", () => {
    expect(verdict("refused", "refused", [])).toBe(true);
    expect(verdict("refused", "ok", [])).toBe(false);
    expect(verdict("refused", "refused", ["moved"])).toBe(false);
    expect(verdict("refused", "error", [])).toBe(false);
    expect(verdict("refused", "skipped", [])).toBe(false);
    expect(verdict("refused", "skipped", [], true)).toBe(true);
  });

  test("only GitHub's own refusals count, and a rejected push", () => {
    expect(isRemoteRefusal(new GitHubError("validation", 422, "Repository rule violations found"))).toBe(true);
    expect(isRemoteRefusal(new GitHubError("validation", 200, "Something went wrong"))).toBe(true);
    expect(isRemoteRefusal(new PushRejected("[remote rejected]"))).toBe(true);
    expect(isRemoteRefusal(new GitHubError("validation", null, "refused locally"))).toBe(false);
    expect(isRemoteRefusal(new GitHubError("network", null, "timeout"))).toBe(false);
    expect(isRemoteRefusal(new GitHubError("server", 502, "bad gateway"))).toBe(false);
    expect(isRemoteRefusal(new Error("git: not found"))).toBe(false);
  });

  test("a failed, missing, unplanned or duplicate check fails the phase", () => {
    const planned = plan("cross", PN);
    const all = planned.map((p) => ({ ...p, observed: p.expected, pass: true, evidence: {} }));
    expect(summarize(all, planned).ok).toBe(true);
    expect(summarize(all.slice(1), planned)).toMatchObject({ ok: false, notRun: ["s1"] });
    expect(summarize([...all, all[0]!], planned)).toMatchObject({ ok: false, unexpected: ["s1"] });
    expect(summarize([{ ...all[0]!, pass: false }, ...all.slice(1)], planned)).toMatchObject({ ok: false, failed: ["s1"] });
    expect(() => new Recorder(planned, () => {}).skip("zz", "x", true)).toThrow("unplanned");
  });

  test("batch numbers are distinct and fit the 9-digit batch pattern, in and outside Actions", () => {
    for (const n of [refNumbers("999999", "24"), refNumbers(undefined, undefined, 4_102_444_800_000)]) {
      const all = [n.queue, n.probe, n.epoch, n.stale];
      expect(new Set(all).size).toBe(4);
      for (const x of all) expect(String(x)).toMatch(/^[1-9][0-9]{0,8}$/);
    }
    expect(refNumbers("7", "1").queue).not.toBe(refNumbers("7", "2").queue);
  });
});

describe("the target guard", () => {
  test("refuses the config's target or control repo, by id or by name (any case)", () => {
    expect(forbiddenTarget({ owner: "x", repo: "y", repoId: NAMES.target.id }, NAMES)).toContain("target");
    expect(forbiddenTarget({ owner: "x", repo: "y", repoId: NAMES.control.id }, NAMES)).toContain("control");
    expect(forbiddenTarget({ owner: "ACME", repo: "Widgets", repoId: 999 }, NAMES)).toContain("target");
    expect(forbiddenTarget(SANDBOX, NAMES)).toBeNull();
  });

  test("runPhase refuses the target before reading a token or making any request", async () => {
    const fake = new FakeSandbox();
    let calls = 0;
    const spy = (async (...a: Parameters<typeof fetch>) => { calls++; return fake.fetch(...a); }) as typeof fetch;
    for (const p of PHASES) {
      const target = { owner: "x", repo: "y", repoId: NAMES.target.id };
      await expect(runPhase(p, target, NAMES, PREFIX, ENV[p], { http: { fetch: spy }, log: () => {} })).rejects.toThrow(UsageError);
      await expect(runPhase(p, target, NAMES, PREFIX, {}, { http: { fetch: spy }, log: () => {} })).rejects.toThrow("target repo");
    }
    expect(calls).toBe(0);
  });

  test("the command refuses the loaded config's target.repoId and control repo (exit 2), with no request", async () => {
    const t = defaultConfig.names.target;
    const c = defaultConfig.names.control;
    let calls = 0;
    const d: Deps = { http: { fetch: (async () => { calls++; return new Response("{}"); }) as unknown as typeof fetch }, log: () => {} };
    expect(await verifySandbox(["queue", "--repo", "acme/sandbox", "--repo-id", String(t.id)], ENV.queue, d)).toBe(2);
    expect(await verifySandbox(["admin", "--repo", `${t.owner}/${t.name}`, "--repo-id", "4242"], ENV.admin, d)).toBe(2);
    expect(await verifySandbox(["cross", "--repo", "acme/sandbox", "--repo-id", String(c.id)], ENV.cross, d)).toBe(2);
    expect(calls).toBe(0);
  });
});

describe("arguments and tokens", () => {
  test("usage errors", () => {
    expect(() => parseArgs([])).toThrow(UsageError);
    expect(() => parseArgs(["deploy", "--repo", "a/b", "--repo-id", "1"])).toThrow("unknown phase");
    expect(() => parseArgs(["queue", "--repo", "a", "--repo-id", "1"])).toThrow("--repo");
    expect(() => parseArgs(["queue", "--repo", "a/b/c", "--repo-id", "1"])).toThrow("--repo");
    expect(() => parseArgs(["queue", "--repo", "a/b", "--repo-id", "0x1"])).toThrow("--repo-id");
    expect(() => parseArgs(["queue", "--repo", "a/b", "--repo-id", "1", "--repo", "c/d"])).toThrow("unexpected");
    expect(parseArgs(["admin", "--repo", "acme/sandbox", "--repo-id", "4242"])).toMatchObject({ phase: "admin", sandbox: SANDBOX });
  });

  test("each phase sees only its own tokens", () => {
    expect(() => phaseTokens("release", { ...ENV.release, VERIFY_QUEUE_TOKEN: "q" })).toThrow("VERIFY_QUEUE_TOKEN");
    expect(() => phaseTokens("cross", { ...ENV.cross, VERIFY_STATE_TOKEN: "s" })).toThrow("VERIFY_STATE_TOKEN");
    expect(() => phaseTokens("admin", { ...ENV.admin, VERIFY_RELEASE_TOKEN: "r" })).toThrow("VERIFY_RELEASE_TOKEN");
    expect(() => phaseTokens("queue", { VERIFY_QUEUE_TOKEN: "q" })).toThrow("VERIFY_STATE_TOKEN");
    expect(phaseTokens("queue", ENV.queue)).toEqual(ENV.queue);
  });
});

describe("a correct sandbox", () => {
  test("every phase passes, in order; the epochs end at E2 with E1 their parent, and nothing is left over", async () => {
    const fake = new FakeSandbox();
    const out = await allPhases(fake);
    for (const p of PHASES) expect({ phase: p, ...out[p], checks: out[p]!.checks.filter((c) => !c.pass) }).toMatchObject({ phase: p, ok: true, failed: [], notRun: [], unexpected: [] });
    // Re-creation is skipped (acceptably) because each delete was refused.
    expect(byId(out.queue!).hq9).toMatchObject({ observed: "skipped", pass: true });
    for (const e of [EQ, ER]) {
      const e2 = fake.refs.get(e)!;
      expect(fake.commits.get(e2)!.parents).toHaveLength(1);
    }
    const left = [...fake.refs.keys()].filter((b) => /^(queue|qlander-build|verify-sandbox)\//.test(b));
    expect(left).toEqual([]);
    expect(fake.refs.has("release")).toBe(true);
  });

  test("a second run advances from the epochs the first left, and passes again", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    const first = fake.refs.get(EQ)!;
    const out = await allPhases(fake);
    for (const p of PHASES) expect(out[p]!.ok, p).toBe(true);
    expect(fake.isAncestor(first, fake.refs.get(EQ)!)).toBe(true);
    expect(byId(out.queue!).e1).toMatchObject({ observed: "skipped", pass: true }); // the state branches already exist
  });
});

describe("each check fails when its property does not hold", () => {
  test("a token that reaches another repo: the phase stops before writing anything", async () => {
    const fake = new FakeSandbox();
    fake.tokenRepos.get("queue-token")!.push(OTHER_REPO);
    const s = await run(fake, "queue");
    expect(s.ok).toBe(false);
    expect(byId(s).s1!.pass).toBe(false);
    expect(s.notRun).toContain("a1");
    expect(fake.writes).toEqual([]);
  });

  test("check 3: without the integrity ruleset, the owning App can put its epoch back, and the checks say so", async () => {
    const fake = new FakeSandbox();
    fake.rulesets = fake.rulesets.filter((r) => r.name !== "epoch-integrity");
    const s = await run(fake, "queue");
    expect(s.ok).toBe(false);
    expect(s.failed).toEqual(expect.arrayContaining(["hq6"]));
  });

  test("check 3: the other App with a bypass on the epoch's write ruleset is caught by the ruleset check, even though integrity still refuses its reset", async () => {
    const fake = new FakeSandbox();
    fake.rulesets.find((r) => r.name === "epoch-write-release")!.bypass.push({ type: "Integration", id: APPS.queue });
    const out = await allPhases(fake);
    expect(out.cross!.ok).toBe(true);
    expect(out.admin!.failed).toEqual(["ha0"]);
  });

  test("check 3: an admin who can bypass both epoch rulesets resets the epoch with each method, and every admin check fails", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    for (const r of fake.rulesets) if (r.name.startsWith("epoch-")) r.bypass.push({ type: "User", id: ADMIN_ID });
    const s = await run(fake, "admin");
    expect(s.ok).toBe(false);
    expect(s.failed).toEqual(expect.arrayContaining(["ha0", "haq1"]));
  });

  test("check 3: git push --force is its own check", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    const real = fake.pusher.bind(fake);
    // A push path that bypasses the rules (as a misconfigured push ruleset would).
    fake.pusher = (token: string) => ({ forcePush: async (b: string, sha: string) => { fake.refs.set(b, sha); void real; void token; } });
    const s = await run(fake, "admin");
    expect(s.failed).toEqual(expect.arrayContaining(["haq3"]));
  });

  test("check 1's property: if an unchanged epoch entry were not checked, the stale calls would land and fail", async () => {
    const fake = new FakeSandbox();
    fake.skipUnchanged = true;
    const s = await run(fake, "queue");
    expect(s.failed).toEqual(expect.arrayContaining(["hq10", "hq11"]));
  });

  test("check 4: a workflow run for an epoch commit fails the phase", async () => {
    const fake = new FakeSandbox();
    const orig = fake.fetch;
    // Every epoch commit gets a run.
    (fake as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/actions/runs")) return new Response(JSON.stringify({ total_count: 1 }), { status: 200 });
      return orig(input, init);
    }) as typeof fetch;
    const s = await run(fake, "queue");
    expect(s.failed).toEqual(["hq13"]);
  });

  test("check 3: a 403 (the token could not even try) is not a ruleset refusal", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    fake.readOnly.add("queue-token");
    const s = await run(fake, "cross");
    expect(s.failed).toEqual(["hc1", "hc2", "hc3"]);
    expect(s.checks.filter((c) => c.id.startsWith("hc")).map((c) => c.observed)).toEqual(["error", "error", "error"]);
  });

  test("a stale call refused for another reason does not pass: the control write with E2 must land", async () => {
    const fake = new FakeSandbox();
    // Every write to main from M' (the stale probe's base) is refused, whatever the epoch.
    let m1: string | null = null;
    fake.refuseUpdate = (es) => {
      const main = es.find((e) => e.branch === "main");
      if (main && es.length === 2 && m1 === null && main.before !== main.after) m1 = main.after; // hq4 lands M'
      return main && main.before === m1 ? { message: "Something went wrong" } : null;
    };
    const s = await run(fake, "queue");
    expect(s.failed).toEqual(["hq10"]);
  });

  test("a 403 or 404 on a stale call or on another App's reset is not a refusal", async () => {
    const fake = new FakeSandbox();
    fake.refuseUpdate = (es) => (es.some((e) => e.branch.startsWith("queue/")) && es.some((e) => e.before === e.after && e.branch.startsWith("qlander-epoch/")) && es[0]!.before === "0".repeat(40) && fake.refs.has("qlander-epoch/queue") && fake.commits.get(fake.refs.get("qlander-epoch/queue")!)!.parents[0] === es[1]!.before ? { message: "not found", type: "NOT_FOUND" } : null);
    fake.readOnly.add("state-token");
    const s = await run(fake, "queue");
    expect(s.failed).toEqual(expect.arrayContaining(["hq11", "hq12"]));
    expect(byId(s).hq11!.observed).toBe("error");
    expect(byId(s).hq12!.observed).toBe("error");
  });

  test("the admin phase needs a sandbox admin's token", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    fake.adminIsAdmin = false;
    const s = await run(fake, "admin");
    expect(s.failed).toEqual(["ha0"]);
  });

  test("check 4: a run that appears only by the second look still fails", async () => {
    const fake = new FakeSandbox();
    const orig = fake.fetch;
    const looks = new Map<string, number>();
    (fake as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith("/actions/runs")) {
        const sha = u.searchParams.get("head_sha")!;
        looks.set(sha, (looks.get(sha) ?? 0) + 1);
        return new Response(JSON.stringify({ total_count: looks.get(sha)! > 1 ? 1 : 0 }), { status: 200 });
      }
      return orig(input, init);
    }) as typeof fetch;
    const s = await run(fake, "queue");
    expect(s.failed).toEqual(["hq13"]);
  });

  test("the release phase needs the queue epoch to attack as the other App", async () => {
    const fake = new FakeSandbox();
    const s = await run(fake, "release");
    expect(s.failed).toEqual(["hr9", "hr10"]);
  });

  test("the cross phase needs the release epoch", async () => {
    const s = await run(new FakeSandbox(), "cross");
    expect(s.ok).toBe(false);
    expect(s.notRun).toEqual(["hc1", "hc2", "hc3"]);
  });

  test("G1: the state App able to move main is caught", async () => {
    const fake = new FakeSandbox();
    fake.rulesets.find((r) => r.name === "main-landing")!.bypass.push({ type: "Integration", id: APPS.state });
    const s = await run(fake, "queue");
    expect(s.failed).toEqual(["f5"]);
  });
});

describe("the CLI runs verify-sandbox", () => {
  test("`cli.ts verify-sandbox` refuses the config's own target before any request", async () => {
    const { main } = await import("../src/cli");
    const { names } = (await import("../src/config/load")).loadConfig().config;
    const target = `${names.target.owner}/${names.target.name}`;
    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((l: string) => void lines.push(l));
    const net = spyOn(globalThis, "fetch").mockImplementation((() => {
      throw new Error("verify-sandbox made a request");
    }) as unknown as typeof fetch);
    try {
      const code = await main(["verify-sandbox", "queue", "--repo", target, "--repo-id", String(names.target.id)]);
      expect(code).toBe(2);
      expect(net).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      net.mockRestore();
    }
    expect(lines.join("\n")).toMatch(/never runs against the config.s own repos: .* is the config.s target repo/);
  });
});

describe("read-after-write lag (a REST read can show a ref's previous value for a while)", () => {
  const runWith = (fake: FakeSandbox, phase: Phase, extra: Partial<Deps> = {}) => runPhase(phase, SANDBOX, NAMES, PREFIX, ENV[phase], { ...deps(fake), ...extra });

  for (const lag of [1, 3]) {
    test(`with ${lag} lagging read(s) after every write, every phase still passes, and the lag is recorded`, async () => {
      const fake = new FakeSandbox();
      fake.lagReads = lag;
      for (const p of PHASES) {
        const s = await runWith(fake, p);
        expect({ phase: p, failed: s.failed, notRun: s.notRun }).toEqual({ phase: p, failed: [], notRun: [] });
      }
      const q = await runPhase("queue", SANDBOX, NAMES, PREFIX, { ...ENV.queue, GITHUB_RUN_NUMBER: "77", GITHUB_RUN_ATTEMPT: "1" }, deps(fake));
      expect(q.ok).toBe(true);
      expect(q.lags!.length).toBeGreaterThan(0);
      expect(q.lags!.every((l) => l.ms > 0 && l.reads > 1)).toBe(true);
    });
  }

  test("the lag is really exercised: with no time to settle, the same run fails", async () => {
    const fake = new FakeSandbox();
    fake.lagReads = 3;
    const s = await runWith(fake, "queue", { settleMs: 0 });
    expect(s.ok).toBe(false);
  });

  test("a reset that lands behind a lagging read is still caught by the owner's no-op proof", async () => {
    const fake = new FakeSandbox();
    fake.rulesets = fake.rulesets.filter((r) => r.name !== "epoch-integrity");
    fake.lagReads = 5; // a single read after the reset would still show E2
    const s = await runWith(fake, "queue");
    expect(s.failed).toEqual(expect.arrayContaining(["hq6"]));
  });

  test("and by the read window where no identity can prove it (the other App, the admin)", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    fake.rulesets = fake.rulesets.filter((r) => r.name !== "epoch-integrity");
    fake.rulesets.find((r) => r.name === "epoch-write-release")!.bypass.push({ type: "Integration", id: APPS.queue });
    fake.lagReads = 5;
    const s = await runWith(fake, "cross");
    expect(s.failed).toEqual(expect.arrayContaining(["hc1"]));
    const fake2 = new FakeSandbox();
    await allPhases(fake2);
    for (const r of fake2.rulesets) if (r.name.startsWith("epoch-")) r.bypass.push({ type: "User", id: ADMIN_ID });
    fake2.rulesets = fake2.rulesets.filter((r) => r.name !== "epoch-integrity");
    fake2.lagReads = 5;
    const a = await runWith(fake2, "admin");
    expect(a.failed).toEqual(expect.arrayContaining(["haq1"]));
  });

  test("a forbidden reset that GitHub applies but reports as an error is caught even when lagging reads show E2 again", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    // The queue App can reset the release epoch (both protections gone), and the call reports an error anyway.
    fake.rulesets = fake.rulesets.filter((r) => r.name !== "epoch-integrity");
    fake.rulesets.find((r) => r.name === "epoch-write-release")!.bypass.push({ type: "Integration", id: APPS.queue });
    const e2 = fake.refs.get(ER)!;
    const orig = fake.fetch;
    (fake as { fetch: typeof fetch }).fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const r = await orig(input, init);
      if (String(input).endsWith("/graphql") && String(init?.body ?? "").includes("\"force\":true")) {
        // Reads: the reset value once, then E2 again (a lagging replica).
        const seq = [fake.refs.get(ER)!, e2, e2, e2, e2, e2, e2, e2, e2, e2, e2, e2, e2];
        const read = fake.readRef.bind(fake);
        fake.readRef = (b: string) => (b === ER && seq.length ? seq.shift()! : read(b));
        return new Response(JSON.stringify({ errors: [{ message: "Something went wrong" }] }), { status: 200 });
      }
      return r;
    }) as typeof fetch;
    const s = await runWith(fake, "cross");
    expect(byId(s).hc1!.pass).toBe(false);
  });

  test("a window shorter than the lag is not trusted: unproven refusals then fail rather than pass", async () => {
    const fake = new FakeSandbox();
    await allPhases(fake);
    fake.rulesets = fake.rulesets.filter((r) => r.name !== "epoch-integrity");
    fake.rulesets.find((r) => r.name === "epoch-write-release")!.bypass.push({ type: "Integration", id: APPS.queue });
    fake.lagReads = 50; // longer than the 10 s window at one read a second
    const s = await runWith(fake, "cross");
    // The window ends on stale reads that show E2: this is the documented bound of an unproven check.
    expect(byId(s).hc1!.observed).toBe("ok"); // the reset was accepted, so the check fails on the outcome itself
    expect(s.failed).toEqual(expect.arrayContaining(["hc1"]));
  });
});
