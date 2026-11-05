// Generic identities (docs/deployment.md §1.1) and policyHash v2 (§8.2).
//
// - The policy hash is v2 and nothing accepts a pre-v2 one: a PR admitted
//   under another hash is dropped (§8.2).
// - A second config with different repos, branches, prefixes and labels runs
//   the end-to-end world, so no value of the default config is left in the
//   code paths.
// - No identity from the default config is a literal in src/.

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { revalidate } from "../src/admission";
import { type Config, defaultConfig } from "../src/config";
import { CONFIG_PATH, loadConfig } from "../src/config/load";
import { defaultReleaseConfig } from "../src/release-config";
import { DEFAULT_RULES_PATH, readRules, scanLine } from "../scripts/public-scrub";
import { policyHash } from "../src/queue";
import { type Auth, parseState } from "../src/state";
import { isForbiddenHeadRef, isWritableRef, queueRef, runIdFromTargetUrl } from "../src/validate";
import { lenientLabels, readWatchdogConfig } from "../src/watchdog";
import { BASE_CONFIG, cfg, job, livePr, NAMES, run, sha } from "./sim";
import { proofChain, type ReleaseCandidate } from "../src/release";
import { World } from "./world";

/** A pre-v2 hash: what an authorisation recorded before policyHash v2. */
const PRE_V2 = "57acd443a2f80ea3";
const acme = loadConfig(`${import.meta.dir}/fixtures/acme.qlander.yml`);
const A = acme.config.names;

const auth = (policy: string, n = 1): Auth => ({
  head: sha(`pr${n}`),
  baseRepoId: NAMES.target.id,
  policy,
  policyPr: false,
  admittedAt: "2026-10-21T10:00:00Z",
  labelledAt: "2026-10-21T10:00:00Z",
  evidence: [],
  reviewRun: null,
});

describe("policyHash v2 (§8.2)", () => {
  const v2 = policyHash(defaultConfig);

  test("v2 is prefixed", () => {
    expect(v2.startsWith("v2:")).toBe(true);
    expect(revalidate(auth(v2), livePr(1), defaultConfig, v2)).toEqual({ ok: true });
  });

  test("a pre-v2 hash is never accepted, even one computed from the same config: v2 merges only with nothing admitted", () => {
    for (const recorded of [PRE_V2, "0123456789abcdef", `v2:${PRE_V2}`, "v2:0000000000000000"]) {
      expect(revalidate(auth(recorded), livePr(1), defaultConfig, v2)).toMatchObject({ ok: false, headMoved: true, reason: "qlander policy changed" });
    }
  });

  test("any policy change drops an auth", () => {
    const changed = cfg({ minBatch: 3 });
    const now = policyHash(changed);
    expect(now).not.toBe(v2);
    expect(revalidate(auth(v2), livePr(1), changed, now)).toMatchObject({ ok: false, headMoved: true, reason: "qlander policy changed" });
  });

  test("an identity change (a label, a prefix, a repo name) changes the v2 hash", () => {
    const n = defaultConfig.names;
    for (const names of [{ ...n, labels: { ...n.labels, solo: "solo" } }, { ...n, labels: { ...n.labels, go: "go" } }, { ...n, queuePrefix: "q/" }, { ...n, target: { ...n.target, name: `${n.target.name}2` } }]) {
      expect(policyHash(cfg({ names }))).not.toBe(v2);
    }
  });

  test("trusted automations are in the v2 hash when set, and absent leaves it unchanged", () => {
    const bot = { login: "deps-bot[bot]", id: 9001, paths: ["deps.lock"] };
    const withBot = (b: typeof bot): Config => ({ ...BASE_CONFIG, trustedAutomations: [b] });
    expect("trustedAutomations" in BASE_CONFIG).toBe(false);
    expect(policyHash(BASE_CONFIG)).not.toBe(policyHash(withBot(bot)));
    expect(policyHash(withBot(bot))).not.toBe(v2);
    expect(policyHash(withBot({ ...bot, id: 9002 }))).not.toBe(policyHash(withBot(bot)));
  });

  test("end to end: PRs admitted under a pre-v2 hash are unreadied with a comment, not landed", async () => {
    const w = new World();
    w.readyPr(1);
    w.readyPr(2);
    await w.untilBuilt();
    const raw = JSON.parse(w.stateRef.current!.text) as { auth: Record<string, { policy: string }> };
    for (const a of Object.values(raw.auth)) {
      expect(a.policy).toBe(policyHash(w.config));
      a.policy = PRE_V2; // as if admitted before policyHash v2
    }
    w.stateRef.current!.text = `${JSON.stringify(raw, null, 1)}\n`;
    await w.runUntilIdle();
    expect(w.landed()).toEqual([]);
    for (const n of [1, 2]) expect(w.target.prs.get(n)!.pr.labels).not.toContain(NAMES.labels.ready);
  });
});

describe("a second config: acme/widgets, every identity different", () => {
  test("loads, and shares nothing with the default names", () => {
    expect(A.target).toEqual({ owner: "acme", name: "widgets", id: 1002 });
    expect(A.main).toBe("trunk");
    const own = JSON.stringify(NAMES);
    for (const v of [A.main, A.release, A.queuePrefix, A.buildPrefix, A.stateBranch, A.labels.ready, A.controlLabels.pause]) expect(own).not.toContain(`"${v}"`);
  });

  test("validators use the config's names", () => {
    expect(queueRef(A, 7)).toBe("mq/batch/7");
    expect(isWritableRef(A, "trunk", "queue")).toBe(true);
    expect(isWritableRef(A, "mq/build/7", "queue")).toBe(true);
    expect(isWritableRef(A, "main", "queue")).toBe(false);
    expect(isWritableRef(A, "queue/7", "queue")).toBe(false);
    expect(isWritableRef(A, "mq/batch/7/x", "queue")).toBe(false);
    expect(isWritableRef(A, "stable", "release")).toBe(true);
    expect(isWritableRef(A, "release", "release")).toBe(false);
    expect(isForbiddenHeadRef(A, "mq/batch/feature")).toBe(true);
    expect(isForbiddenHeadRef(A, "queue/1")).toBe(false);
    expect(runIdFromTargetUrl(A.target, "https://github.com/acme/widgets/actions/runs/9")).toBe(9);
    expect(runIdFromTargetUrl(A.target, `https://github.com/${NAMES.target.owner}/${NAMES.target.name}/actions/runs/9`)).toBeNull();
    expect(runIdFromTargetUrl(A.target, "https://github.com/acmeXwidgets/actions/runs/9")).toBeNull();
  });

  test("happy path: two PRs land on trunk through mq/ refs; the default names appear nowhere", async () => {
    const w = new World(() => "pass", acme.config);
    w.readyPr(1);
    w.readyPr(2);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1, 2]]);
    for (const n of [1, 2]) {
      expect(w.target.prs.get(n)!.pr.merged).toBe(true);
      expect(w.comments(n).some((c) => c.startsWith("Landed in trunk at"))).toBe(true);
      expect(w.comments(n).some((c) => /`mq\/batch\/\d+`, on trunk/.test(c))).toBe(true);
    }
    expect(w.target.calls.some((c) => /^createRef mq\/build\/\d+ /.test(c))).toBe(true);
    expect(w.target.calls.some((c) => /^createRef mq\/batch\/\d+ /.test(c))).toBe(true);
    expect(w.target.calls.some((c) => c.startsWith("updateRef trunk "))).toBe(true);
    expect(w.target.calls.filter((c) => /\b(main|queue\/|qlander-build\/)/.test(c))).toEqual([]);
    expect([...w.target.refs.keys()].filter((k) => k.startsWith("mq/"))).toEqual([]); // retired
    expect(w.repo.issues.map((i) => i.labels).flat().every((l) => l.startsWith("mq:"))).toBe(true);
  });

  test("a culprit is bounced and loses acme's ready label; the others land", async () => {
    const w = new World((b) => (b.prs.includes(2) ? "fail" : "pass"), acme.config);
    for (const n of [1, 2, 3]) w.readyPr(n);
    await w.runUntilIdle();
    expect(w.bounced()).toEqual([2]);
    expect(w.landed().flat().sort()).toEqual([1, 3]);
    expect(w.target.prs.get(2)!.pr.labels).not.toContain("merge-queue");
  });

  test("an operator command is acme's label, and it is removed once applied", async () => {
    const w = new World(() => "pass", acme.config);
    w.readyPr(1);
    w.readyPr(2);
    w.command("bounce", 2);
    expect(w.target.prs.get(2)!.pr.labels).toContain("mq:bounce");
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.target.prs.get(2)!.pr.labels).not.toContain("mq:bounce");
    expect(w.target.prs.get(2)!.pr.labels).not.toContain("merge-queue");
  });

  test("a PR from a batch ref is never admitted; the default ready label means nothing here", async () => {
    const w = new World(() => "pass", acme.config);
    w.readyPr(1, { headRef: "mq/batch/9" });
    const p2 = w.readyPr(2);
    p2.pr.labels = ["ready"];
    w.readyPr(3);
    w.readyPr(4);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[3, 4]]);
  });

  test("a client for the default names refuses acme's refs, and the acme client refuses the default ones", async () => {
    const { FakeTarget } = await import("./fake-github");
    const c = new FakeTarget("queue", A);
    await expect(c.createRef("queue/1", c.refs.get("trunk")!)).rejects.toThrow("may not write");
    const d = new FakeTarget("queue", NAMES);
    await expect(d.createRef("mq/batch/1", d.refs.get("main")!)).rejects.toThrow("may not write");
  });
});

describe("the watchdog with an invalid file keeps watching the same issues", () => {
  test("labels are read leniently from the control repo's file when it fails validation", () => {
    const own = readFileSync(CONFIG_PATH, "utf8");
    const broken = own.replace("version: 1", "version: 2");
    expect(lenientLabels(broken)).toEqual({ controlLabels: NAMES.controlLabels, releaseLabels: NAMES.releaseLabels, watchdogLabels: NAMES.watchdogLabels });
  });

  test("a file that is not YAML at all still yields its labels, line by line", () => {
    const own = readFileSync(CONFIG_PATH, "utf8");
    const broken = own.replace("queue:\n", "queue: [unclosed\nqueue:\n");
    expect(lenientLabels(broken)).toEqual({ controlLabels: NAMES.controlLabels, releaseLabels: NAMES.releaseLabels, watchdogLabels: NAMES.watchdogLabels });
  });

  test("colliding labels in an invalid file never give the watchdog another label's issues", () => {
    const own = readFileSync(CONFIG_PATH, "utf8");
    const l = lenientLabels(own.replace("    status: qlander-status", "    status: pause"));
    expect(l.watchdogLabels.status).toBe("qlander:status");
    expect(l.controlLabels.pause).toBe("qlander:pause");
  });

  test("a fallback label the invalid file uses for something else is refused, not guessed", () => {
    const own = readFileSync(CONFIG_PATH, "utf8");
    const text = own.replace("    pause: pause\n", "    pause: qlander:status\n").replace("    status: qlander-status\n", "");
    expect(() => lenientLabels(text)).toThrow("refusing to guess");
  });

  test("an unreadable or nonsense file falls back to fixed defaults, never to the control repo's names", () => {
    const l = lenientLabels("not: [yaml");
    expect(l.watchdogLabels.alert).toBe("qlander:alert");
    expect(lenientLabels("watchdog:\n  labels:\n    alert: 'has space'\n").watchdogLabels.alert).toBe("qlander:alert");
    expect(readWatchdogConfig(join(import.meta.dir, "no-such-file.yml"))).toMatchObject({ ok: false, labels: { watchdogLabels: { alert: "qlander:alert" } } });
  });

  test("a valid file gives its own labels and control repo", () => {
    expect(readWatchdogConfig(`${import.meta.dir}/fixtures/acme.qlander.yml`)).toMatchObject({ ok: true, control: A.control, labels: { watchdogLabels: { alert: "mq:alert", status: "mq:status" } } });
  });
});

describe("no identity of the control repo's config is a literal in src/", () => {
  // The deny list is built, not written: every repo, id, approver, label, ref
  // prefix and workflow path in qlander.yml, plus the scrub check's
  // identity rules (scripts/public-scrub.rules.json). Values that are also
  // product words (main, release, pause, the state-block marker) are skipped.
  const c = defaultConfig;
  const n = c.names;
  const q = defaultReleaseConfig.qualification;
  const product = new Set(["main", "release", "pause", "qlander-state"]);
  const quoted = [
    ...Object.values(n.labels),
    ...Object.values(n.controlLabels),
    ...Object.values(n.releaseLabels),
    ...Object.values(n.watchdogLabels),
    n.stateBranch,
    n.releaseStateBranch,
  ].filter((v) => !product.has(v));
  const denied = [
    n.control.owner,
    n.target.owner,
    `${n.target.owner}/${n.target.name}`,
    `${n.control.owner}/${n.control.name}`,
    String(n.control.id),
    String(n.target.id),
    ...c.humans.flatMap((h) => [h.login, String(h.id)]),
    ...quoted.map((v) => `"${v}"`),
    // A namespaced label (a:b) is distinctive enough to match unquoted too.
    ...quoted.filter((v) => v.includes(":")),
    ...[n.queuePrefix, n.buildPrefix].flatMap((p) => [`"${p}`, `\`${p}`]),
    ...[...(c.review.adapter === "job@main" ? [c.review.workflowPath] : []), ...(q.provider === "manifest" && q.proof ? [q.proof.workflow] : [])].map((w) => w.split("/").pop()!),
    ...(q.provider === "manifest" ? [q.path, ...(q.proof ? [`"${q.proof.statusContext}"`] : [])] : []),
  ];
  // The rules file stays private (it is on its own exclude list); the public tree checks the config's identities only.
  const root = join(import.meta.dir, "..");
  const scrub = existsSync(join(root, DEFAULT_RULES_PATH)) ? readRules(undefined, {}, root) : null;
  const rules = scrub && { ...scrub, rules: scrub.rules.filter((r) => ["ci-host", "host-ip", "github-id", "person"].includes(r.id)) };
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

  test("the deny list covers the config's identities", () => {
    expect(denied.length).toBeGreaterThan(20);
    expect(denied).toContain(String(n.target.id));
    for (const l of [n.labels.bounce, n.labels.solo, n.labels.unsolo, n.labels.go]) expect(denied).toContain(l); // unquoted
    if (c.review.adapter === "job@main") expect(denied).toContain(c.review.workflowPath.split("/").pop()!);
  });

  test("code lines (comments aside) name no repo, id, person, label, ref prefix or path from it", () => {
    const hits: string[] = [];
    for (const f of files(join(import.meta.dir, "..", "src"))) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.replace(/^\s*(\/\/|\*|\/\*\*?).*$/, "").replace(/\s\/\/ .*$/, "");
          for (const d of denied) if (code.includes(d)) hits.push(`${f}:${i + 1}: ${d}`);
          if (rules) for (const h of scanLine(rules, code)) hits.push(`${f}:${i + 1}: ${h.rule}`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
  });
});

describe("release proof under another config's names", () => {
  const S = sha("cand");
  const at = { repoId: A.target.id, target: A.target, mainBranch: A.main };
  const proof = { workflow: ".github/workflows/certify.yml", events: ["workflow_run"], jobTemplate: "Qualified {sha}" };
  const cand = (branch: string, url = "https://github.com/acme/widgets/actions/runs/7"): ReleaseCandidate => ({
    sha: S,
    firstParent: true,
    fromRelease: "ahead",
    status: { state: "success", target_url: url },
    proofRun: run({ id: 7, path: proof.workflow, event: "workflow_run", head_branch: branch, repository: { id: A.target.id }, head_repository: { id: A.target.id } }),
    proofJobs: [job(`Qualified ${S}`)],
    runs: [],
    jobs: {},
  });

  test("a proof run on the configured main (trunk) of the configured target is accepted", () => {
    expect(proofChain(cand(A.main), at, proof)).toBeNull();
  });

  test("a run on a branch called main, or a status pointing at another repo, is refused", () => {
    expect(proofChain(cand("main"), at, proof)).toContain("not a trunk run");
    expect(proofChain(cand(A.main, `https://github.com/${NAMES.target.owner}/${NAMES.target.name}/actions/runs/7`), at, proof)).toContain("widgets Actions run");
  });
});
