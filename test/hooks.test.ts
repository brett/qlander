// Lifecycle event hooks (docs/hooks.md, src/hooks.ts): the config is outside
// the policy hash, each event is dispatched once per subscribed hook with a
// stable idempotency key, delivery is at least once, and a failed delivery
// never touches landing.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020";
import { CONFIG_PATH, parseConfig, SCHEMA_PATH } from "../src/config/load";
import { schemaProblems } from "../src/config/schema";
import { GitHubError } from "../src/github/http";
import { type ClientPayload, deliverHooks, enqueueHooks, fitPayload, type Hook, HOOK_EVENTS, type LifecycleEvent, MAX_PAYLOAD_BYTES, GIVE_UP_HOURS, BUDGET_WARN_SHARE, DELIVERY_BUDGET_MS, OUTBOX_BYTES } from "../src/hooks";
import { defaultConfig } from "../src/config";
import { CrashError, policyHash } from "../src/queue";
import { emptyState, parseState } from "../src/state";
import { summariseHooks, WINDOW_WARN_SHARE } from "../src/watchdog-render";
import { WRITER, FakeTarget } from "./fake-github";
import { cfg, job, NAMES, sha, TARGET_SLUG, APPROVERS, HUMAN, TRUSTED, BOT_FILE, LANE } from "./sim";
import { decide } from "../src/machine";
import { buildSnapshot } from "../src/snapshot";
import { World } from "./world";

const controlYaml = readFileSync(CONFIG_PATH, "utf8");
const ALL: Hook[] = [{ events: [...HOOK_EVENTS], eventType: "qlander" }];
const HOOKS_YAML = "\nhooks:\n  - events:\n      - landed\n      - bounced\n    eventType: qlander\n";

function world(oracle?: ConstructorParameters<typeof World>[0], over?: ConstructorParameters<typeof World>[1]): World {
  const w = new World(oracle, over);
  w.hooks = ALL;
  return w;
}
const author = (w: World, n: number) => {
  w.target.prs.get(n)!.pr.user = { login: `dev${n}`, id: 9000 + n };
};
const sent = (w: World, event?: string) => w.target.dispatches.map((d) => d.payload as unknown as ClientPayload).filter((p) => event === undefined || p.event === event);

describe("hooks config", () => {
  test("absent: no hooks, and the control repo's Config and policy hash are unchanged", () => {
    const loaded = parseConfig(controlYaml);
    expect(loaded.hooks).toEqual([]);
    expect(policyHash(loaded.config)).toBe(policyHash(defaultConfig));
  });

  test("present: parsed, and still outside the policy hash", () => {
    const loaded = parseConfig(controlYaml + HOOKS_YAML);
    expect(loaded.hooks).toEqual([{ events: ["landed", "bounced"], eventType: "qlander" }]);
    expect(loaded.config).toEqual(parseConfig(controlYaml).config);
    expect(policyHash(loaded.config)).toBe(policyHash(defaultConfig));
  });

  const bad: [string, string, RegExp][] = [
    ["an unknown event", HOOKS_YAML.replace("- bounced", "- merged"), /events\[1\]: must be one of/],
    ["no events", "\nhooks:\n  - events: []\n    eventType: qlander\n", /needs at least 1 item/],
    ["an event_type with a space", HOOKS_YAML.replace("eventType: qlander", 'eventType: "hover craft"'), /eventType: must match/],
    ["an event_type over 100 characters", HOOKS_YAML.replace("eventType: qlander", `eventType: ${"x".repeat(101)}`), /eventType: must match/],
    ["an unknown key", HOOKS_YAML.replace("    eventType: qlander", `    eventType: qlander\n    repo: ${TARGET_SLUG}`), /unknown key/],
    ["the same event twice to one event_type", HOOKS_YAML + "  - events:\n      - landed\n    eventType: qlander\n", /event landed is already sent as qlander/],
  ];
  for (const [name, extra, want] of bad) {
    test(`refused: ${name}`, () => expect(() => parseConfig(controlYaml + extra)).toThrow(want));
  }

  test("the runtime schema check agrees with ajv on hooks", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
    const base = () => YAML.parse(controlYaml) as Record<string, unknown>;
    const cases: [boolean, unknown][] = [
      [true, []],
      [true, ALL],
      [false, [{ events: [] , eventType: "x" }]],
      [false, [{ events: ["landed"] }]],
      [false, [{ events: ["nope"], eventType: "x" }]],
      [false, [{ events: ["landed"], eventType: "" }]],
      [false, { events: ["landed"], eventType: "x" }],
    ];
    for (const [valid, hooks] of cases) {
      const doc = { ...base(), hooks };
      expect(validate(doc)).toBe(valid);
      expect(schemaProblems(schema, doc).length === 0).toBe(valid);
    }
  });

  test("the budget warning share matches the status issue's", () => {
    expect(BUDGET_WARN_SHARE).toBe(WINDOW_WARN_SHARE);
  });
});

describe("events through the real runner", () => {
  test("no hooks: nothing is dispatched and the state has no hooks key", async () => {
    const w = new World();
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    expect(w.target.dispatches).toEqual([]);
    expect("hooks" in w.state()).toBe(false);
  });

  test("happy path: admitted, batch_started, landed, each once, with heads, authors and the merge sha", async () => {
    const w = world();
    for (const n of [1, 2]) {
      w.readyPr(n);
      author(w, n);
    }
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    expect(sent(w).map((p) => p.event)).toEqual(["admitted", "admitted", "batch_started", "landed"]);
    expect(new Set(sent(w).map((p) => p.idempotencyKey)).size).toBe(4);
    expect(w.target.dispatches.every((d) => d.eventType === "qlander")).toBe(true);
    const head = (n: number) => w.target.prs.get(n)!.pr.head.sha;
    const started = sent(w, "batch_started")[0]!;
    const n = started.batch!.n;
    expect(started.batch!.depth).toBe(0);
    expect(started.prs).toEqual([{ number: 1, head: head(1), author: "dev1" }, { number: 2, head: head(2), author: "dev2" }]);
    expect(started.details).toMatchObject({ ref: `queue/${n}`, rebuild: false, dropped: [] });
    const landed = sent(w, "landed")[0]!;
    const main = w.target.refs.get("main")!;
    expect(landed).toMatchObject({ v: 1, batch: { n, head: main } });
    expect(landed.prs).toEqual([1, 2].map((n) => ({ number: n, head: head(n), mergeSha: main, author: `dev${n}` })));
    expect(landed.idempotencyKey).toBe(`landed:${n}:${main}`);
    expect(Object.keys(landed).length).toBeLessThanOrEqual(10);
    expect(w.state().hooks!.outbox).toEqual([]);
  });

  test("a culprit is bounced with its failed jobs; split halves start their own batches", async () => {
    const w = world((b) => (b.prs.includes(2) ? "fail" : "pass"));
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.bounced()).toEqual([2]);
    const b = sent(w, "bounced");
    expect(b.length).toBe(1);
    expect(b[0]!.prs.map((p) => p.number)).toEqual([2]);
    expect(b[0]!.details).toMatchObject({ failedOnRerun: true, failedJobs: [{ name: LANE, url: `https://github.com/x/${encodeURIComponent(LANE)}` }] });
    expect(sent(w, "batch_started").length).toBe(3);
    expect(sent(w, "flaky")).toEqual([]);
  });

  test("flaky: a red batch that passes on rerun reports the red run's failed jobs, then lands", async () => {
    const w = world((b) => (b.attempt === 1 ? "fail" : "pass"));
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    const f = sent(w, "flaky");
    expect(f.length).toBe(1);
    expect(f[0]!.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(f[0]!.details).toEqual({ failedJobs: [{ name: LANE, url: `https://github.com/x/${encodeURIComponent(LANE)}` }] });
    expect(sent(w, "landed")[0]!.details).toMatchObject({ rerun: true });
  });

  test("dequeued: a head that moves while queued, and a build conflict", async () => {
    const w = world();
    for (const n of [1, 2, 3]) w.readyPr(n);
    await w.untilBuilt();
    w.target.push(2);
    await w.runUntilIdle();
    const d = sent(w, "dequeued");
    expect(d.map((p) => [p.prs[0]!.number, p.details.kind])).toEqual([[2, "head_moved"]]);

    const c = world();
    for (const n of [1, 2]) c.readyPr(n);
    c.target.conflicts.add(c.target.prs.get(2)!.pr.head.sha);
    await c.runUntilIdle();
    expect(sent(c, "dequeued").map((p) => [p.prs[0]!.number, p.details.kind])).toEqual([[2, "conflict"]]);
    expect(sent(c, "batch_started")[0]!.details).toMatchObject({ dropped: [{ number: 2, outcome: "conflict" }] });
  });

  test("approval_needed: once per policy PR head, with the exact command", async () => {
    const w = world();
    const p = w.readyPr(1, { files: [".github/workflows/ci.yml"] });
    for (let i = 0; i < 5; i++) await w.tick();
    const a = sent(w, "approval_needed");
    expect(a.length).toBe(1);
    expect(a[0]!.details).toEqual({ command: `/qlander approve-policy ${p.pr.head.sha}`, approvers: APPROVERS.map((a) => a.login) });
    expect(a[0]!.prs).toEqual([{ number: 1, head: p.pr.head.sha, author: HUMAN }]);
  });

  test("budget_warning: once, when a reservation reaches 75% of the window budget", async () => {
    const w = world((b) => (b.prs.includes(2) ? "fail" : "pass"), { windowBudget: 6 });
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    const b = sent(w, "budget_warning");
    expect(b.length).toBe(1);
    expect(b[0]!.details).toEqual({ used: 5, budget: 6, windowHours: 24, share: 0.75 });
    expect(b[0]!.prs).toEqual([]);
  });

  test("a hook subscribed to some events hears only those", async () => {
    const w = world();
    w.hooks = [{ events: ["landed"], eventType: "landed-only" }];
    for (const n of [1, 2]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.target.dispatches.map((d) => [d.eventType, d.payload.event])).toEqual([["landed-only", "landed"]]);
  });
});

describe("delivery", () => {
  test("a transient failure is retried on the next tick; landing is unaffected", async () => {
    const w = world();
    w.hooks = [{ events: ["landed"], eventType: "qlander" }];
    for (const n of [1, 2]) w.readyPr(n);
    w.target.dispatchErrors.push(new GitHubError("server", 502, "bad gateway"));
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    expect(sent(w, "landed").length).toBe(1);
    expect(w.state().hooks).toMatchObject({ outbox: [], failed: [] });
  });

  test("a permanent failure is recorded (and shown in the status issue), never paused on, never resent", async () => {
    const w = world();
    w.hooks = [{ events: ["landed"], eventType: "qlander" }];
    for (const n of [1, 2]) w.readyPr(n);
    w.target.dispatchErrors.push(new GitHubError("auth", 403, "Resource not accessible by integration"));
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    expect(w.paused()).toBe(false);
    expect(w.target.dispatches).toEqual([]);
    const h = w.state().hooks!;
    expect(h.outbox).toEqual([]);
    expect(h.failed).toMatchObject([{ event: "landed", eventType: "qlander", error: expect.stringContaining("403") }]);
    const lines = summariseHooks(h, w.now);
    expect(lines.join("\n")).toContain("**warning:** 1 hook delivery failed in the last 24h; latest: landed as qlander");
    expect(summariseHooks(h, new Date(w.now.getTime() + 25 * 3_600_000))).toEqual([]);
  });

  test("at least once: a tick that dies after sending, before recording it, sends it again with the same key", async () => {
    const w = world();
    w.hooks = [{ events: ["landed"], eventType: "qlander" }];
    for (const n of [1, 2]) w.readyPr(n);
    const real = w.target.dispatch.bind(w.target);
    let crashed = false;
    w.target.dispatch = async (t, p) => {
      await real(t, p);
      if (!crashed) {
        crashed = true;
        throw new CrashError("after-effect");
      }
    };
    await w.runUntilIdle();
    expect(crashed).toBe(true);
    const keys = sent(w, "landed").map((p) => p.idempotencyKey);
    expect(keys.length).toBe(2);
    expect(keys[0]).toBe(keys[1]!);
    expect(w.landed()).toEqual([[1, 2]]);
  });

  test("deliverHooks keeps retrying a transient failure for GIVE_UP_HOURS, then records it", async () => {
    const target = new FakeTarget("queue");
    const ev: LifecycleEvent = { event: "landed", key: "landed:1:x", at: "2026-10-21T12:00:00.000Z", batch: null, prs: [], details: {} };
    const t0 = new Date("2026-10-21T12:00:00Z");
    let h = enqueueHooks(emptyState(), [ev], ALL, t0).state.hooks!;
    for (let i = 0; i < 20; i++) {
      target.dispatchErrors.push(new GitHubError("server", 503, "unavailable"));
      h = (await deliverHooks(h, { target, now: new Date(t0.getTime() + i * 3_600_000), rethrow: () => false })).hooks;
    }
    expect(h.outbox.length).toBe(1);
    expect(h.outbox[0]!.tries).toBe(20);
    target.dispatchErrors.push(new GitHubError("server", 503, "unavailable"));
    h = (await deliverHooks(h, { target, now: new Date(t0.getTime() + GIVE_UP_HOURS * 3_600_000), rethrow: () => false })).hooks;
    expect(h.outbox).toEqual([]);
    expect(h.failed[0]!.error).toContain(`gave up after ${GIVE_UP_HOURS}h`);
    // a re-emitted event that already failed is not queued again
    expect(enqueueHooks({ ...emptyState(), hooks: h }, [ev], ALL, new Date()).state.hooks!.outbox).toEqual([]);
  });

  test("delivery is time-boxed, and a refusing lease fence stops it without losing anything", async () => {
    const target = new FakeTarget("queue");
    const evs: LifecycleEvent[] = [1, 2, 3].map((i) => ({ event: "landed", key: `landed:${i}:x`, at: "t", batch: null, prs: [], details: {} }));
    const h = enqueueHooks(emptyState(), evs, ALL, new Date()).state.hooks!;
    let t = 0;
    const slow = { ...target, dispatch: async (et: string, p: object) => { t += DELIVERY_BUDGET_MS; await target.dispatch(et, p); } } as typeof target;
    const out = await deliverHooks(h, { target: slow, now: new Date(), rethrow: () => false, clock: () => t });
    expect(target.dispatches.length).toBe(1);
    expect(out.hooks.outbox.length).toBe(2);
    class Fence extends Error {}
    target.dispatchErrors.push(new Fence("lease too short") as unknown as GitHubError);
    const stopped = await deliverHooks(out.hooks, { target, now: new Date(), rethrow: () => false, stop: (e) => e instanceof Fence });
    expect(stopped.hooks.outbox.length).toBe(2);
    expect(stopped.hooks.outbox[0]!.tries).toBe(0);
    expect(stopped.hooks.failed).toEqual([]);
  });

  test("the waiting deliveries are bounded in bytes: the oldest are dropped and recorded", () => {
    const evs: LifecycleEvent[] = [...Array(100).keys()].map((i) => ({ event: "landed", key: `landed:${i}:x`, at: "t", batch: null, prs: [], details: { pad: "x".repeat(1000) } }));
    const h = enqueueHooks(emptyState(), evs, ALL, new Date()).state.hooks!;
    expect(JSON.stringify(h.outbox).length).toBeLessThanOrEqual(OUTBOX_BYTES);
    expect(h.outbox.at(-1)!.payload.idempotencyKey).toBe("landed:99:x");
    expect(h.failed.length).toBeGreaterThan(0);
    expect(h.failed.at(-1)!.error).toContain("dropped undelivered");
  });

  test("a delivered event re-emitted later is not sent again", async () => {
    const target = new FakeTarget("queue");
    const ev: LifecycleEvent = { event: "admitted", key: "admitted:1:x:t", at: "t", batch: null, prs: [], details: {} };
    const h1 = enqueueHooks(emptyState(), [ev], ALL, new Date()).state.hooks!;
    const h2 = (await deliverHooks(h1, { target, now: new Date(), rethrow: () => false })).hooks;
    expect(target.dispatches.length).toBe(1);
    expect(enqueueHooks({ ...emptyState(), hooks: h2 }, [ev, ev], ALL, new Date()).state.hooks!.outbox).toEqual([]);
  });

  test("a payload over the size limit is cut: failed jobs first, then the details", () => {
    const jobs = [...Array(2000).keys()].map((i) => ({ name: `job ${i}`, url: `https://github.com/x/${i}` }));
    const p: ClientPayload = { v: 1, event: "bounced", idempotencyKey: "k", at: "t", batch: null, prs: [], details: { reason: "r", failedJobs: jobs } };
    const fit = fitPayload(p);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(fit.details.truncated).toBe(true);
    expect((fit.details.failedJobs as unknown[]).length).toBeGreaterThan(0);
    const huge = fitPayload({ ...p, details: { reason: "x".repeat(70_000) } });
    expect(huge.details).toEqual({ truncated: true });
    const prs = [...Array(1000).keys()].map((i) => ({ number: i + 1, head: "a".repeat(40), mergeSha: "b".repeat(40), author: "someone" }));
    const many = fitPayload({ ...p, prs });
    expect(JSON.stringify(many).length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(many.details).toEqual({ truncated: true, prsTotal: 1000 });
    expect(many.prs.length).toBeGreaterThan(0);
  });

  test("state with hooks round-trips through the strict parser; a malformed hooks section is refused", () => {
    const ev: LifecycleEvent = { event: "landed", key: "k", at: "t", batch: null, prs: [{ number: 1, head: "a".repeat(40) }], details: {} };
    const s = enqueueHooks(emptyState(), [ev], ALL, new Date("2026-10-21T12:00:00Z")).state;
    expect(parseState(JSON.stringify(s), NAMES)).toEqual(s);
    expect(() => parseState(JSON.stringify({ ...s, hooks: { ...s.hooks, extra: 1 } }), NAMES)).toThrow("hooks: unexpected key");
    expect(() => parseState(JSON.stringify({ ...s, hooks: { ...s.hooks, sent: ["nothex"] } }), NAMES)).toThrow("hooks.sent");
  });
});

describe("hooks and trusted automations", () => {
  const BOT = { login: TRUSTED.login, id: TRUSTED.id };
  const BRANCH = "deps-bot/update";
  const C = cfg({ trustedAutomations: [{ ...BOT, paths: [BOT_FILE] }] });
  const NOW = new Date("2026-10-21T12:00:00Z");
  function botPr(readyBy = BOT.login): { f: FakeTarget; n: number } {
    const f = new FakeTarget();
    const n = 7;
    const p = f.addPr(n, { user: BOT }, { files: [BOT_FILE], events: [{ id: 1, actor: readyBy, at: "2026-10-21T10:00:00Z" }] });
    p.pr.head.ref = BRANCH;
    f.commitAuthors.set(p.pr.head.sha, BOT);
    f.moveBranch(BRANCH, sha("prior"), p.pr.head.sha, BOT, "force_push");
    f.addRun({ head_sha: p.pr.head.sha, event: "pull_request", head_branch: BRANCH }, [job("fast")]);
    return { f, n };
  }
  const events = async (f: FakeTarget) => decide(emptyState(), await buildSnapshot({ api: f, cfg: C, state: emptyState(), now: NOW, paused: false, policyHash: "p1" }), C).events ?? [];

  test("a waived admission emits admitted, says what was waived, and never approval_needed", async () => {
    const { f, n } = botPr();
    const ev = await events(f);
    const admitted = ev.filter((e) => e.event === "admitted");
    expect(admitted.length).toBe(1);
    expect(admitted[0]!.prs).toEqual([{ number: n, head: f.prs.get(n)!.pr.head.sha, author: BOT.login }]);
    expect(admitted[0]!.details).toEqual({ policyPr: true, waiver: { rule: "trusted-automation", login: BOT.login, readyByBot: true, policyWaived: true } });
    expect(ev.some((e) => e.event === "approval_needed")).toBe(false);
  });

  test("a bot PR that loses its trust (a human pushed) and was readied by a writer needs approval: approval_needed fires", async () => {
    const { f, n } = botPr(HUMAN);
    const before = f.prs.get(n)!.pr.head.sha;
    const after = f.push(n, { files: [BOT_FILE] });
    f.commitAuthors.set(after, BOT);
    f.moveBranch(BRANCH, before, after, WRITER);
    f.addRun({ head_sha: after, event: "pull_request", head_branch: BRANCH }, [job("fast")]);
    const ev = await events(f);
    expect(ev.some((e) => e.event === "admitted")).toBe(false);
    const a = ev.filter((e) => e.event === "approval_needed");
    expect(a.length).toBe(1);
    expect(a[0]!.details.command).toBe(`/qlander approve-policy ${after}`);
  });
});
