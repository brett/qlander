// The config loader's validation, on whichever qlander.yml the suite runs
// with (the control repo's own, or the neutral example in
// scripts/test-on-example.ts): a malformed file is refused with every
// problem named, the tick and the watchdog react to it as designed, and the
// runtime schema check agrees with ajv. The control repo's own pins (its
// values and hashes) are in its equivalence test, not here.

import { describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { CONFIG_PATH, ConfigError, loadConfig, parseConfig, SCHEMA_PATH } from "../src/config/load";
import { schemaProblems } from "../src/config/schema";
import { yamlTextProblems } from "../src/config/yaml";
import { defaultReleaseConfig } from "../src/release-config";
import { APPROVERS, CI_JOBS, CONTROL_SLUG, LS, NAMES, TARGET, TARGET_SLUG } from "./sim";

const root = `${import.meta.dir}/..`;
const controlYaml = readFileSync(CONFIG_PATH, "utf8");
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
const q = defaultReleaseConfig.qualification;
/** The proof job template the config sets (the tests below need a manifest provider with a proof). */
const PROOF_TEMPLATE = q.provider === "manifest" && q.proof ? q.proof.jobTemplate : "";
if (!PROOF_TEMPLATE) throw new Error("the test config must have a manifest qualification with a proof");

/** The config with one textual change; the change must apply. */
function edit(from: string | RegExp, to: string): string {
  const out = controlYaml.replace(from, to);
  if (out === controlYaml) throw new Error(`edit did not apply: ${from}`);
  return out;
}

function problems(text: string): string {
  try {
    parseConfig(text);
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as ConfigError).problems.join("\n");
  }
  throw new Error("expected the config to be refused");
}

describe("a malformed qlander.yml is refused", () => {
  const cases: [string, string, RegExp][] = [
    ["not YAML", "queue: [unclosed", /value must be a one-line plain or quoted scalar/],
    ["empty file", "", /\$: must be a mapping/],
    ["a list, not a mapping", "- version: 1\n", /\$: must be a mapping/],
    ["two documents", controlYaml + "\n---\nversion: 1\n", /duplicate key "version"/],
    ["an unknown version", edit("version: 1", "version: 2"), /\$\.version: must be 1/],
    ["an unknown top-level key", edit("version: 1", "version: 1\nextra: true"), /\$\.extra: unknown key/],
    ["an unknown nested key", edit("  historyLimit: 100\n\nrelease:", "  historyLimit: 100\n  histroyLimit: 5\n\nrelease:"), /\$\.queue\.histroyLimit: unknown key/],
    ["a missing key", edit("    maxOpTries: 3\n", ""), /\$\.queue\.timeouts: missing maxOpTries/],
    ["a string for a number", edit("minutes: 8", 'minutes: "8"'), /\$\.lease\.minutes: must be a\(n\) integer/],
    ["a fraction", edit("windowHours: 24", "windowHours: 1.5"), /windowHours: must be a\(n\) integer/],
    ["zero where a positive number is needed", edit("searchPages: 10", "searchPages: 0"), /searchPages: must be at least 1/],
    ["a YAML 1.1 boolean, which is a string here", edit("dryRun: true", "dryRun: yes"), /\$\.release\.dryRun: must be a\(n\) boolean/],
    ["an empty pre-landing manifest", edit(/  preLanding:[^\n]*\n(?: {4}.*\n)+/, "  preLanding: []\n"), /preLanding: needs at least 1 item/],
    ["a pre-landing path outside .github/workflows", edit("    - path: .github/workflows/ci.yml", "    - path: ci.yml"), /preLanding\[0\]\.path: must match/],
    ["an unknown `when`", edit("      when: always", "      when: sometimes"), /when: must be one of/],
    ["an unknown review adapter", edit("adapter: job@main", "adapter: job@subject"), /producer: matches none of the allowed forms/],
    ["a duplicate block key", edit("  dryRun: true", "  dryRun: true\n  dryRun: false"), /line \d+: duplicate key "dryRun"/],
    ["a duplicate key in a nested mapping", edit("    min: 2\n", "    min: 2\n    min: 1\n"), /duplicate key "min"/],
    ["a duplicate key in a list item", edit("      name: CI\n", "      name: CI\n      name: Other\n"), /duplicate key "name"/],
    ["an anchor", edit("  verify:\n", "  verify: &v\n"), /anchors, aliases or tags/],
    ["an alias", edit("  historyLimit: 100\n\nrelease:", "  historyLimit: *h\n\nrelease:"), /anchors, aliases or tags/],
    ["a tag", edit("statusContext: qualified", "statusContext: !!str qualified"), /anchors, aliases or tags/],
    ["a merge key", edit("  verify:\n", "  verify:\n    <<: *v\n"), /not in the YAML subset/],
    ["a tab", edit("  dryRun: true", "  dryRun:\ttrue"), /tabs are not allowed/],
    // Semantic checks (§1.4).
    ["a job that can outlive its lease (R1)", edit("jobTimeoutMinutes: 5", "jobTimeoutMinutes: 7"), /queue: jobTimeoutMinutes \(7\) must be <= leaseMinutes \(8\) - fenceMarginMinutes \(2\)/],
    ["a lease longer than the cron (R6)", edit("  minutes: 8", "  minutes: 12"), /leaseMinutes \(12\) must be shorter than the cron interval/],
    ["reconcile shorter than two ticks (R6)", edit("reconcileMinutes: 30", "reconcileMinutes: 15"), /reconcileMinutes must span at least two ticks/],
    ["a host kill before the job timeout", edit("hostKillMinutes: 6", "hostKillMinutes: 4"), /hostKillMinutes must be at least runner\.jobTimeoutMinutes/],
    ["a missing fill target", edit("    minFill: 4\n", ""), /\$\.queue\.batch: missing minFill/],
    ["a missing fill wait", edit("    maxWaitMinutes: 5\n", ""), /\$\.queue\.batch: missing maxWaitMinutes/],
    ["a zero fill wait", edit("maxWaitMinutes: 5", "maxWaitMinutes: 0"), /maxWaitMinutes: must be at least 1/],
    ["minFill above max", edit("    minFill: 4\n", "    minFill: 9\n"), /batch\.minFill must not exceed queue\.batch\.max/],
    ["batch min above max", edit("    min: 2\n", "    min: 9\n"), /batch\.min must not exceed/],
    ["no `when: always` entry", edit("      when: always", "      when: if_triggered"), /at least one entry with when: always/],
    ["policy paths without approvers", edit(/    approvers:[^\n]*\n(?: {6}.*\n)+/, "    approvers: []\n"), /approvers must not be empty/],
    ["an approver listed twice", edit(`        id: ${APPROVERS[1]!.id}`, `        id: ${APPROVERS[0]!.id}`), new RegExp(`id ${APPROVERS[0]!.id} is listed twice`)],
    ["a review template without {sha}", edit('jobTemplate: "Reviewed {sha}"', 'jobTemplate: "Reviewed"'), /jobTemplate must contain \{sha\}/],
    ["a proof job template without {sha}", edit(`jobTemplate: "${PROOF_TEMPLATE}"`, `jobTemplate: "${PROOF_TEMPLATE.replace("{sha}", "")}"`), /proof\.jobTemplate must contain \{sha\}/],
    ["an empty proof job template", edit(`jobTemplate: "${PROOF_TEMPLATE}"`, 'jobTemplate: ""'), /proof\.jobTemplate: must not be empty/],
    ["a gate workflow outside the policy paths", edit("      - .github/**\n", "      - .github/workflows/ci.yml\n"), /does not cover \.github\/qualification\.json/],
    ["local actions outside the policy paths", edit("      - .github/**\n", "      - .github/workflows/**\n      - .github/qualification.json\n"), /must cover the whole \.github\/actions directory/],
    // Identities (step 3): shape, then the §1.4 semantic checks.
    ["a repo without an owner", edit(`  repo: ${TARGET_SLUG}\n`, `  repo: ${NAMES.target.name}\n`), /\$\.target\.repo: must match/],
    ["a branch name with ..", edit("  main: main\n", "  main: ma..in\n"), /\$\.target\.main: must match/],
    ["a ref prefix without its trailing slash", edit("queuePrefix: queue/", "queuePrefix: queue"), /queuePrefix: must match/],
    ["a label with a space", edit("    ready: ready\n", "    ready: ready now\n"), /labels\.ready: must match/],
    ["a missing watchdog block", edit(/\nwatchdog:\n(?: {2}.*\n)+$/, "\n"), /\$: missing watchdog/],
    ["a missing command label", edit("    unsolo: qlander:unsolo\n", ""), /\$\.queue\.labels: missing unsolo/],
    ["an unknown key under refs", edit("    buildPrefix: qlander-build/\n", "    buildPrefix: qlander-build/\n    epochPrefix: x/\n"), /refs\.epochPrefix: unknown key/],
    ["control and target the same repo", edit(/^  repoId: \d+.*$/m, `  repoId: ${TARGET}`), /control\.repoId and target\.repoId must differ/],
    ["control and target the same name", edit(`  repo: ${CONTROL_SLUG}\n`, `  repo: ${TARGET_SLUG.toUpperCase()}\n`), /control\.repo and target\.repo must differ/],
    ["overlapping ref prefixes", edit("buildPrefix: qlander-build/", "buildPrefix: queue/build/"), /queuePrefix \(queue\/\) and queue\.refs\.buildPrefix \(queue\/build\/\) overlap/],
    ["a ref prefix under main", edit("queuePrefix: queue/", "queuePrefix: main/q/"), /target\.main \(main\) and queue\.refs\.queuePrefix \(main\/q\/\) overlap/],
    ["a ref prefix that is a file next to main's directory", edit("  main: main\n", "  main: queue\n"), /target\.main \(queue\) and queue\.refs\.queuePrefix \(queue\/\) overlap/],
    ["release the same branch as main", edit("  branch: release\n", "  branch: main\n"), /target\.main \(main\) and release\.branch \(main\) overlap/],
    ["a state branch that is the control repo's workflow branch", edit("  stateBranch: qlander-state\n", "  stateBranch: main\n"), /the control repo's workflow branch \(main\) and queue\.stateBranch \(main\) overlap/],
    ["a state branch under the control repo's workflow branch", edit("  stateBranch: qlander-release-state", "  stateBranch: main/state"), /the control repo's workflow branch \(main\) and release\.stateBranch \(main\/state\) overlap/],
    ["one state branch for both jobs", edit("  stateBranch: qlander-release-state", "  stateBranch: qlander-state"), /queue\.stateBranch \(qlander-state\) and release\.stateBranch \(qlander-state\) overlap/],
    ["a command label that is the ready label, in another case", edit("    bounce: qlander:bounce", "    bounce: READY"), /queue\.labels: ready is used twice/],
    ["a branch component ending in .lock", edit("  main: main\n", "  main: main.lock\n"), /target\.main \(main\.lock\): no component may end in \.lock/],
    ["a prefix component ending in .lock", edit("buildPrefix: qlander-build/", "buildPrefix: build.lock/"), /buildPrefix \(build\.lock\/\): no component may end in \.lock/],
    ["two control-repo labels the same", edit("    alert: qlander-alert", "    alert: release-blocked"), /control-repo labels .*: release-blocked is used twice/],
  ];
  for (const [name, text, want] of cases) {
    test(name, () => expect(problems(text)).toMatch(want));
  }

  test("every problem is reported, not just the first", () => {
    const text = edit("version: 1", "version: 2\nextra: 1").replace("searchPages: 10", "searchPages: 0");
    const p = problems(text);
    for (const want of [/version: must be 1/, /extra: unknown key/, /searchPages: must be at least 1/]) expect(p).toMatch(want);
  });

  test("an unreadable file is a ConfigError", () => {
    expect(() => loadConfig(join(tmpdir(), "qlander-no-such-dir", "qlander.yml"))).toThrow(ConfigError);
  });

  test("the config passes the text screen; block scalars and quoted keys are refused", () => {
    expect(yamlTextProblems(controlYaml)).toEqual([]);
    expect(yamlTextProblems("a: |\n  a: 1\n  a: 2\nb: 1\n").length).toBeGreaterThan(0);
    expect(yamlTextProblems('"a": 1\n').length).toBeGreaterThan(0);
    expect(yamlTextProblems("x:\n  a: 1\ny:\n  a: 1\n")).toEqual([]);
    expect(yamlTextProblems("x:\n  - a: 1\n    b: 1\n  - a: 1\n    b: 1\n")).toEqual([]);
  });
});

describe("the tick loads the file before it reads any state", () => {
  /** Run `bun src/main.ts queue` from a copy of the control repo whose qlander.yml is `text`, with no credentials. */
  function runMain(text: string, mode: string): { code: number; err: string } {
    const dir = mkdtempSync(join(tmpdir(), "ls-config-"));
    try {
      cpSync(`${root}/src`, `${dir}/src`, { recursive: true });
      cpSync(`${root}/schema`, `${dir}/schema`, { recursive: true });
      writeFileSync(`${dir}/qlander.yml`, text);
      writeFileSync(`${dir}/event.json`, JSON.stringify({ repository: { id: LS } }));
      const r = Bun.spawnSync([process.execPath, "src/main.ts", "queue"], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
        env: { PATH: process.env.PATH ?? "", QLANDER_MODE: mode, GITHUB_EVENT_NAME: "schedule", GITHUB_EVENT_PATH: `${dir}/event.json`, GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" },
      });
      return { code: r.exitCode, err: r.stderr.toString() };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const mode of ["live", ""]) {
    test(`a malformed file stops the ${mode || "dry-run"} job at import, before credentials, clients or state`, () => {
      const bad = runMain(edit("version: 1", "version: 2"), mode);
      expect(bad.code).not.toBe(0);
      expect(bad.err).toContain("is not a valid qlander config");
      expect(bad.err).not.toContain("STATE_TOKEN");
      // The control: with the config unchanged the same run gets as far as asking for its credentials.
      const good = runMain(controlYaml, mode);
      expect(good.code).not.toBe(0);
      expect(good.err).not.toContain("is not a valid qlander config");
      expect(good.err).toContain("STATE_TOKEN");
    });
  }
});

describe("the runtime schema check agrees with ajv (§1.4)", () => {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(schema);
  const base = () => YAML.parse(controlYaml) as Record<string, any>;
  const corpus: [string, boolean, (c: Record<string, any>) => unknown][] = [
    ["the control repo's config", true, (c) => c],
    ["an app-check review producer", true, (c) => ((c.queue.admission.review.producer = { adapter: "app-check", appId: 99, name: "review" }), c)],
    ["maxSplitDepth 0", true, (c) => ((c.queue.batch.maxSplitDepth = 0), c)],
    ["no skipped jobs allowed", true, (c) => ((c.queue.preLanding[0].allow_skipped_jobs = {}), c)],
    ["a second pre-landing entry", true, (c) => (c.queue.preLanding.push({ path: ".github/workflows/x.yaml", name: "X", when: "if_triggered", required_jobs: [], allow_skipped_jobs: {} }), c)],
    ["empty policy paths and approvers", true, (c) => ((c.queue.policy = { paths: [], approvers: [] }), c)],
    ["null", false, () => null],
    ["a list", false, () => []],
    ["version 2", false, (c) => ((c.version = 2), c)],
    ["version as a string", false, (c) => ((c.version = "1"), c)],
    ["an unknown key", false, (c) => ((c.extra = 1), c)],
    ["a missing section", false, (c) => (delete c.release, c)],
    ["a missing nested key", false, (c) => (delete c.queue.timeouts.maxOpTries, c)],
    ["a fraction", false, (c) => ((c.lease.minutes = 7.5), c)],
    ["infinity", false, (c) => ((c.lease.minutes = Infinity), c)],
    ["zero", false, (c) => ((c.queue.historyLimit = 0), c)],
    ["negative maxSplitDepth", false, (c) => ((c.queue.batch.maxSplitDepth = -1), c)],
    ["a string number", false, (c) => ((c.target.repoId = String(TARGET)), c)],
    ["an empty label", false, (c) => ((c.queue.labels.ready = ""), c)],
    ["a bad workflow path", false, (c) => ((c.queue.admission.fastLane.workflow = ".github/workflows/sub/ci.yml"), c)],
    ["a bad `when`", false, (c) => ((c.queue.preLanding[0].when = "never"), c)],
    ["an empty pre-landing list", false, (c) => ((c.queue.preLanding = []), c)],
    ["a pre-landing `why`", false, (c) => ((c.queue.preLanding[0].why = "because"), c)],
    ["a non-string skip reason", false, (c) => ((c.queue.preLanding[0].allow_skipped_jobs = { x: 1 }), c)],
    ["a non-string required job", false, (c) => (c.queue.preLanding[0].required_jobs.push(3), c)],
    ["a producer mixing both forms", false, (c) => ((c.queue.admission.review.producer.appId = 1), c)],
    ["an unknown adapter", false, (c) => ((c.queue.admission.review.producer.adapter = "x"), c)],
    ["no review events", false, (c) => ((c.queue.admission.review.producer.events = []), c)],
    ["an approver without an id", false, (c) => (delete c.queue.policy.approvers[0].id, c)],
    ["an approver with an extra key", false, (c) => ((c.queue.policy.approvers[0].name = "x"), c)],
    ["dryRun as a string", false, (c) => ((c.release.dryRun = "true"), c)],
    ["the acme fixture", true, () => YAML.parse(readFileSync(`${import.meta.dir}/fixtures/acme.qlander.yml`, "utf8"))],
    ["nested ref prefixes", true, (c) => ((c.queue.refs = { queuePrefix: "mq/batch/", buildPrefix: "mq/build/" }), c)],
    ["a repo with two slashes", false, (c) => ((c.target.repo = "a/b/c"), c)],
    ["a repo id as a string", false, (c) => ((c.control.repoId = "1"), c)],
    ["an empty main", false, (c) => ((c.target.main = ""), c)],
    ["a main with a trailing slash", false, (c) => ((c.target.main = "main/"), c)],
    ["a prefix with a leading dot", false, (c) => ((c.queue.refs.queuePrefix = ".q/"), c)],
    ["a 51-character label", false, (c) => ((c.queue.labels.solo = "x".repeat(51)), c)],
    ["a label starting with a colon", false, (c) => ((c.queue.controlLabels.pause = ":pause"), c)],
    ["a missing state branch", false, (c) => (delete c.release.stateBranch, c)],
    ["an unknown watchdog key", false, (c) => ((c.watchdog.stoppedMinutes = 30), c)],
    ["no watchdog block", false, (c) => (delete c.watchdog, c)],
    ["a hosted runner block", true, (c) => ((c.runner = { mode: "hosted", cronMinutes: 10, jobTimeoutMinutes: 5, takeoverGraceMinutes: 30, epochFence: true, epochPrefix: "ls-epoch/" }), c)],
    ["no runner mode", false, (c) => (delete c.runner.mode, c)],
    ["an unknown runner mode", false, (c) => ((c.runner.mode = "cloud"), c)],
    ["no cron interval", false, (c) => (delete c.runner.cronMinutes, c)],
    ["epochFence as a string", false, (c) => ((c.runner.epochFence = "true"), c)],
    ["an epoch prefix without a slash", false, (c) => ((c.runner.epochPrefix = "epoch"), c)],
  ];
  for (const [name, valid, make] of corpus) {
    test(`${valid ? "valid" : "invalid"}: ${name}`, () => {
      const doc = make(base());
      const ours = schemaProblems(schema, doc);
      expect(validate(doc)).toBe(valid);
      expect(ours.length === 0).toBe(valid);
    });
  }

  test("the interpreter refuses a schema keyword it does not implement", () => {
    expect(() => schemaProblems({ type: "string", format: "uri" }, "x")).toThrow(/keyword format is not supported/);
  });
});

describe("earlier review findings", () => {
  test("1: a duplicate key in a compact flow mapping is refused (it would load dryRun: false)", () => {
    const flow =
      'release: {"dryRun":true,"maxCandidates":30,"historyLimit":100,"qualification":{"manifest":{"path":".github/qualification.json","proof":{"statusContext":"qualified","workflow":".github/workflows/proof.yml"}}},"dryRun":false}\n';
    const text = edit(/^release:\n(?:(?: {2}.*)?\n)+/m, flow);
    expect((YAML.parse(text) as { release: { dryRun: boolean } }).release.dryRun).toBe(false); // what Bun would load
    expect(() => parseConfig(text)).toThrow(ConfigError);
  });

  test("1: the text screen itself refuses flow collections and quoted keys, whatever Bun.YAML would make of them", () => {
    for (const line of ['"dryRun":false', "dryRun: {a: 1}", "events: [a, b]", "- {login: x, id: 1}", '"a": 1']) {
      expect(yamlTextProblems(`${line}\n`).length, line).toBeGreaterThan(0);
    }
  });

  test("1b: a job name with a comma is a plain key, read as Bun reads it", () => {
    const text = "a:\n  Build (linux, arm64): pull-request only\n";
    expect(yamlTextProblems(text)).toEqual([]);
    expect(Object.keys((YAML.parse(text) as any).a)).toEqual(["Build (linux, arm64)"]);
  });

  test("2: a block scalar in a list item cannot hide a sibling key that empties required_jobs", () => {
    const text = edit("    - path: .github/workflows/ci.yml\n      name: CI\n", "    - name: |-\n        CI\n      required_jobs: []\n      path: .github/workflows/ci.yml\n");
    expect((YAML.parse(text) as any).queue.preLanding[0].required_jobs).toHaveLength(CI_JOBS.length); // the later list wins in Bun
    expect(() => parseConfig(text)).toThrow(ConfigError);
    const later = edit("    - path: .github/workflows/ci.yml\n      name: CI\n", "    - name: |-\n        CI\n      path: .github/workflows/ci.yml\n").replace(/required_jobs:\n(?: {8}- .*\n)+/, "required_jobs: []\n");
    expect(() => parseConfig(later)).toThrow(ConfigError);
  });

  test("4: file-pattern policy paths do not cover the workflow and local-action directories", () => {
    const text = edit("      - .github/**\n", "      - .github/workflows/*.yml\n      - .github/actions/*/action.yml\n      - .github/qualification.json\n");
    expect(problems(text)).toMatch(/must cover the whole \.github\/workflows directory/);
    expect(problems(text)).toMatch(/must cover the whole \.github\/actions directory/);
    const dirs = edit("      - .github/**\n", "      - .github/workflows/**\n      - .github/actions/**\n      - .github/qualification.json\n");
    expect(() => parseConfig(dirs)).not.toThrow();
  });

  test("3: the watchdog starts with an invalid qlander.yml (it must not load the tick's config eagerly)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qlander-wd-"));
    try {
      cpSync(`${root}/src`, `${dir}/src`, { recursive: true });
      cpSync(`${root}/schema`, `${dir}/schema`, { recursive: true });
      writeFileSync(`${dir}/qlander.yml`, edit("version: 1", "version: 2"));
      const r = Bun.spawnSync([process.execPath, "src/watchdog.ts"], { cwd: dir, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
      const err = r.stderr.toString();
      expect(err).not.toContain("is not a valid qlander config");
      expect(err).toContain("GITHUB_TOKEN is required");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
