// The workflow renderer (src/render.ts) and the command line (src/cli.ts).
// Every check reads its expected values from the config it renders, so the
// suite passes on any config: the control repo's own and the neutral
// fixtures.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { type Io, main } from "../src/cli";
import { controlConfig, type LoadedConfig, parseConfig, SCHEMA_PATH } from "../src/config/load";
import { schemaProblems } from "../src/config/schema";
import { CONTROL_BRANCH, QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "../src/job-names";
import { policyHash } from "../src/queue";
import { firstDifference, HOSTED_RUNS_ON, qlanderCommand, watchdogInput, RenderError, renderTick, tickCron, renderWatchdog, renderWorkflows, scalar, TICK_WORKFLOW, WATCHDOG_WORKFLOW } from "../src/render";

type Obj = Record<string, any>;
const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
const acmeText = readFileSync(`${import.meta.dir}/fixtures/acme.qlander.yml`, "utf8");
const exampleText = readFileSync(`${import.meta.dir}/fixtures/example.qlander.yml`, "utf8");

/** acme's runner block replaced. */
const withRunner = (text: string, block: string) => text.replace(/^runner:\n(?: {2}.*\n)+/m, `runner:\n${block}`);
const SELF_HOSTED = "  mode: self-hosted-kill\n  cronMinutes: 10\n  jobTimeoutMinutes: 5\n  hostKillMinutes: 6\n  takeoverGraceMinutes: 2\n";
const HOSTED = "  mode: hosted\n  cronMinutes: 15\n  jobTimeoutMinutes: 5\n  takeoverGraceMinutes: 15\n  epochFence: true\n";
const runsOn = (...labels: string[]) => `  runsOn:\n${labels.map((l) => `    - ${l}\n`).join("")}`;
const acme = (runner = SELF_HOSTED + runsOn("self-hosted", "acme-queue")) => parseConfig(withRunner(acmeText, runner));

const steps = (job: Obj): Obj[] => job.steps;
const runStep = (job: Obj) => steps(job).find((s) => s.run)!;
const mints = (job: Obj) => steps(job).filter((s) => String(s.uses ?? "").startsWith("actions/create-github-app-token@"));
const secretsOf = (job: Obj) => [...new Set(JSON.stringify(job).match(/secrets\.[A-Z_]+/g) ?? [])].sort();

/** The properties the code relies on, for any config. */
function checkTick(c: LoadedConfig) {
  const n = c.config.names;
  const wf = YAML.parse(renderTick(c)) as Obj;
  const jobs = c.release.enabled ? ["queue", "release"] : ["queue"];
  expect(Object.keys(wf.jobs).sort()).toEqual(jobs);
  expect(wf.permissions).toEqual({});
  expect(wf.on.schedule).toEqual([{ cron: tickCron(c.runner.cronMinutes) }]);
  expect(wf.on.workflow_dispatch ?? {}).toEqual({});
  const want = {
    queue: { name: QUEUE_JOB_NAME, env: "queue-write", app: "QUEUE_APP", token: c.tokens.queue, other: c.tokens.release, actions: "write" },
    release: { name: RELEASE_JOB_NAME, env: "release-write", app: "RELEASE_APP", token: c.tokens.release, other: c.tokens.queue, actions: "read" },
  } as const;
  for (const j of jobs as ("queue" | "release")[]) {
    const job = wf.jobs[j] as Obj;
    const w = want[j];
    expect(job.name).toBe(w.name);
    expect(job.if).toContain(`github.ref == 'refs/heads/${CONTROL_BRANCH}' && github.repository_id == ${n.control.id}`);
    expect(job.if.includes("github.event_name == 'schedule'"), j).toBe(j === "release");
    expect([job["runs-on"]].flat()).toEqual(c.runsOn ?? [HOSTED_RUNS_ON]);
    expect(job["timeout-minutes"]).toBe(c.runner.jobTimeoutMinutes);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(c.config.leaseMinutes - c.config.fenceMarginMinutes);
    expect(job.environment).toBe(w.env);
    expect(job.concurrency).toEqual({ group: `qlander-${j}`, "cancel-in-progress": false });
    expect(job.permissions).toEqual({ contents: "read", issues: "write", actions: w.actions });
    expect(secretsOf(job)).toEqual([`secrets.${w.app}_CLIENT_ID`, `secrets.${w.app}_PRIVATE_KEY`, "secrets.STATE_APP_CLIENT_ID", "secrets.STATE_APP_PRIVATE_KEY"].sort());
    const [target, state] = mints(job);
    expect([target!.with.owner, target!.with.repositories]).toEqual([n.target.owner, n.target.name]);
    expect([state!.with.owner, state!.with.repositories]).toEqual([n.control.owner, n.control.name]);
    expect(Object.keys(state!.with).filter((k) => k.startsWith("permission-"))).toEqual(["permission-contents"]);
    const run = runStep(job);
    expect(Object.keys(run.env).sort()).toEqual(["GITHUB_TOKEN", "QLANDER_MODE", "STATE_TOKEN", w.token].sort());
    expect(run.env[w.token]).toBe(`\${{ steps.${target!.id}.outputs.token }}`);
    expect(run.env.STATE_TOKEN).toBe(`\${{ steps.${state!.id}.outputs.token }}`);
    expect(run.env[w.other]).toBeUndefined();
    const cmd = qlanderCommand(c, `tick ${j}`);
    expect(run.run.trimEnd().endsWith(cmd)).toBe(true);
    expect(run.run.lastIndexOf("sha256sum -c")).toBeLessThan(run.run.indexOf(cmd));
    expect(run.run).not.toContain("${{");
    for (const s of steps(job)) if (s.uses) expect(s.uses).toMatch(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/);
  }
}

describe("renderTick", () => {
  test("the control repo's config renders with every property the code relies on", () => {
    checkTick(controlConfig());
  });

  test("the example and acme configs render the same way, with their own names", () => {
    checkTick(parseConfig(exampleText));
    checkTick(acme());
  });

  test("release advance not enabled: the queue job only, and no release App secret anywhere", () => {
    const c = acme();
    expect(c.release.enabled).toBe(false);
    const text = renderTick(c);
    expect(Object.keys((YAML.parse(text) as Obj).jobs)).toEqual(["queue"]);
    expect(text).not.toContain("RELEASE_APP");
    expect(text).not.toContain(c.tokens.release);
  });

  test("the token variables are the config's (tokens), defaults when absent", () => {
    const set = parseConfig(withRunner(acmeText, SELF_HOSTED + runsOn("acme-queue")) + "\ntokens:\n  queue: ACME_QUEUE_TOKEN\n");
    checkTick(set);
    expect(renderTick(set)).toContain("ACME_QUEUE_TOKEN: ${{ steps.target.outputs.token }}");
    expect(renderTick(acme())).toContain("TARGET_TOKEN: ${{ steps.target.outputs.token }}");
  });

  test("one runner label renders as a plain scalar, several as a list", () => {
    expect(renderTick(acme(SELF_HOSTED + runsOn("acme-queue")))).toContain("\n    runs-on: acme-queue\n");
    expect(renderTick(acme())).toContain("\n    runs-on: [self-hosted, acme-queue]\n");
  });

  test("self-hosted-kill needs runner.runsOn to render; hosted defaults to a GitHub-hosted runner", () => {
    expect(() => renderTick(acme(SELF_HOSTED))).toThrow(RenderError);
    const hosted = acme(HOSTED);
    checkTick(hosted);
    expect((YAML.parse(renderTick(hosted)) as Obj).jobs.queue["runs-on"]).toBe(HOSTED_RUNS_ON);
    expect(renderTick(hosted)).toContain('cron: "*/15 * * * *"');
  });

  test("names YAML would read as something else are quoted, so they read back unchanged", () => {
    for (const s of ["on", "Yes", "null", "true", "123", "1e3", "-x", "a b", "acme", "acme-queue", "a.b_c"]) {
      expect((YAML.parse(`k: ${scalar(s)}`) as Obj).k).toBe(s);
    }
    expect(scalar("acme")).toBe("acme");
    expect(scalar("on")).toBe('"on"');
    const odd = parseConfig(withRunner(acmeText, SELF_HOSTED + runsOn("1runner")).replace(/^( {2}repo: )acme\/widgets$/m, "$1acme/true"));
    const wf = YAML.parse(renderTick(odd)) as Obj;
    expect(mints(wf.jobs.queue)[0]!.with.repositories).toBe("true");
    expect(wf.jobs.queue["runs-on"]).toBe("1runner");
  });
});

describe("review fixes", () => {
  test("a token variable YAML would read as a boolean is quoted, so the tick reads the variable it was given", () => {
    const c = parseConfig(withRunner(acmeText, SELF_HOSTED + runsOn("acme-queue")) + "\ntokens:\n  queue: \"TRUE\"\n");
    expect(c.tokens.queue).toBe("TRUE");
    checkTick(c);
  });

  test("the cron keeps an even interval: divisors of 60 only", () => {
    expect(tickCron(10)).toBe("*/10 * * * *");
    expect(tickCron(15)).toBe("*/15 * * * *");
    expect(tickCron(60)).toBe("0 * * * *");
    for (const m of [7, 40, 45, 90]) expect(() => tickCron(m)).toThrow(RenderError);
  });
});

describe("renderWatchdog", () => {
  test("one job on a GitHub-hosted runner, the control repo's guard, only the workflow token", () => {
    for (const c of [controlConfig(), acme()]) {
      const text = renderWatchdog(c);
      const wf = YAML.parse(text) as Obj;
      const job = wf.jobs.watchdog as Obj;
      expect(Object.keys(wf.jobs)).toEqual(["watchdog"]);
      expect(wf.permissions).toEqual({});
      expect(job["runs-on"]).toBe("ubuntu-latest");
      expect(job.if).toContain(`github.repository_id == ${c.config.names.control.id}`);
      expect(job.permissions).toEqual({ contents: "read", issues: "write", actions: "read" });
      expect(text).not.toMatch(/secrets\.|create-github-app-token|environment:/);
      expect(Object.keys(runStep(job).env).sort()).toEqual(["GITHUB_TOKEN", "QLANDER_MODE"]);
      expect(runStep(job).run.trimEnd().endsWith(qlanderCommand(watchdogInput(c), "watchdog"))).toBe(true);
    }
  });

  test("the same verified Bun download as the tick", () => {
    const c = controlConfig();
    const tick = runStep((YAML.parse(renderTick(c)) as Obj).jobs.queue).run as string;
    const dog = runStep((YAML.parse(renderWatchdog(c)) as Obj).jobs.watchdog).run as string;
    const bunPart = (r: string) => r.slice(0, r.indexOf("unzip"));
    expect(bunPart(dog)).toBe(bunPart(tick));
    if (watchdogInput(c).bundle === c.bundle) expect(dog.replace(qlanderCommand(c, "watchdog"), "")).toBe(tick.replace(qlanderCommand(c, "tick queue"), ""));
  });
});

describe("runner.runsOn in the config", () => {
  const problems = (runner: string) => {
    try {
      parseConfig(withRunner(acmeText, runner));
      return "";
    } catch (e) {
      return String(e);
    }
  };

  test("optional, and not policy: the policy hash is the same with or without it", () => {
    expect(acme(SELF_HOSTED).runsOn).toBeNull();
    expect(acme().runsOn).toEqual(["self-hosted", "acme-queue"]);
    expect(policyHash(acme().config)).toBe(policyHash(acme(SELF_HOSTED).config));
  });

  test("refused: a label twice, a GitHub-hosted image in self-hosted-kill mode, an empty list, a bad label", () => {
    expect(problems(SELF_HOSTED + runsOn("acme", "ACME"))).toMatch(/runner\.runsOn: acme is listed twice/);
    expect(problems(SELF_HOSTED + runsOn("ubuntu-latest"))).toMatch(/GitHub-hosted image, but runner\.mode is self-hosted-kill/);
    expect(problems(HOSTED + runsOn("ubuntu-latest"))).toBe("");
    expect(problems(SELF_HOSTED + "  runsOn: []\n")).toMatch(/runsOn/);
    expect(problems(SELF_HOSTED + runsOn('"a b"'))).toMatch(/runsOn/);
  });

  test("the runtime schema check agrees with ajv on the new key", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;
    const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
    const set = (v: unknown) => {
      const c = YAML.parse(acmeText) as Obj;
      if (v !== undefined) c.runner.runsOn = v;
      return c;
    };
    const corpus: [unknown, boolean][] = [
      [set(undefined), true],
      [set(["acme"]), true],
      [set(["self-hosted", "acme.queue_1"]), true],
      [set([]), false],
      [set("acme"), false],
      [set(["a b"]), false],
      [set(["-acme"]), false],
      [set([1]), false],
    ];
    for (const [doc, ok] of corpus) {
      expect(validate(doc)).toBe(ok);
      expect(schemaProblems(schema, doc).length === 0).toBe(ok);
    }
  });
});

/** A control-repo directory holding `text` as qlander.yml. */
function controlDir(text: string): { dir: string; config: string } {
  const dir = mkdtempSync(join(tmpdir(), "qlander-render-"));
  const config = join(dir, "qlander.yml");
  writeFileSync(config, text);
  return { dir, config };
}

function memIo(files: Map<string, string> = new Map()): Io & { lines: string[]; errors: string[]; files: Map<string, string> } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    files,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    read: (p) => files.get(p) ?? null,
    write: (p, t) => void files.set(p, t),
  };
}

describe("cli", () => {
  const text = withRunner(acmeText, SELF_HOSTED + runsOn("acme-queue"));

  test("render writes both workflows next to the config; render --check then passes", async () => {
    const { dir, config } = controlDir(text);
    const io = memIo();
    expect(await main(["render", "--config", config], io)).toBe(0);
    expect([...io.files.keys()].sort()).toEqual([join(dir, TICK_WORKFLOW), join(dir, WATCHDOG_WORKFLOW)].sort());
    const check = memIo(io.files);
    expect(await main(["render", "--check", "--config", config], check)).toBe(0);
    expect(check.errors).toEqual([]);
    expect(io.files.get(join(dir, TICK_WORKFLOW))).toBe(renderWorkflows(parseConfig(text))[0]!.text);
  });

  test("render --check fails on any difference, comments and whitespace included, and on a missing file", async () => {
    const { dir, config } = controlDir(text);
    const rendered = new Map(renderWorkflows(parseConfig(text)).map((f) => [join(dir, f.path), f.text]));
    for (const edit of [(s: string) => s.replace("# hand.", "# hand!"), (s: string) => `${s}\n`, (s: string) => s.replace("timeout-minutes: 5", "timeout-minutes: 4")]) {
      const files = new Map(rendered);
      files.set(join(dir, TICK_WORKFLOW), edit(files.get(join(dir, TICK_WORKFLOW))!));
      const io = memIo(files);
      expect(await main(["render", "--check", "--config", config], io)).toBe(1);
      expect(io.errors.join("\n")).toContain(`${TICK_WORKFLOW}: differs from its rendering`);
    }
    const missing = new Map(rendered);
    missing.delete(join(dir, WATCHDOG_WORKFLOW));
    const io = memIo(missing);
    expect(await main(["render", "--check", "--config", config], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("(missing)");
  });

  test("render and validate refuse an invalid config with its problems; render refuses an unrenderable one", async () => {
    const bad = controlDir(acmeText.replace("cronMinutes: 10", "cronMinutes: 0"));
    for (const cmd of [["render"], ["render", "--check"], ["validate"]]) {
      const io = memIo();
      expect(await main([...cmd, "--config", bad.config], io)).toBe(1);
      expect(io.errors.join("\n")).toContain("cronMinutes");
      expect(io.files.size).toBe(0);
    }
    const noRunsOn = controlDir(acmeText);
    const io = memIo();
    expect(await main(["render", "--config", noRunsOn.config], io)).toBe(1);
    expect(io.errors.join("\n")).toContain("runner.runsOn is required");
    expect(await main(["validate", "--config", noRunsOn.config], memIo())).toBe(0);
  });

  test("usage errors exit 2", async () => {
    for (const argv of [[], ["nope"], ["tick"], ["tick", "both"], ["tick", "queue", "extra"], ["watchdog", "x"], ["render", "--bogus"], ["render", "--config"], ["validate", "--check"]]) {
      const io = memIo();
      expect(await main(argv, io), argv.join(" ")).toBe(2);
      expect(io.errors.join("\n")).toContain("usage: bun src/cli.ts");
    }
  });

  test("the commands run as a process: validate and render --check on a config, and tick and the old entry point refuse without credentials", () => {
    const { dir, config } = controlDir(text);
    const event = (id: number) => {
      writeFileSync(join(dir, "event.json"), JSON.stringify({ repository: { id } }));
      return { PATH: process.env.PATH ?? "", GITHUB_EVENT_NAME: "schedule", GITHUB_EVENT_PATH: join(dir, "event.json"), GITHUB_RUN_ID: "1", GITHUB_RUN_ATTEMPT: "1" };
    };
    const run = (args: string[], id = 1) => Bun.spawnSync([process.execPath, ...args], { cwd: `${import.meta.dir}/..`, env: event(id), stdout: "pipe", stderr: "pipe" });
    expect(run(["src/cli.ts", "validate", "--config", config]).exitCode).toBe(0);
    expect(run(["src/cli.ts", "render", "--check", "--config", config]).exitCode).toBe(1); // nothing rendered there yet
    expect(run(["src/cli.ts", "bogus"]).exitCode).toBe(2);
    // The old entry point has no --config: it reads the qlander.yml next to the source, which only a control repo has.
    const entries: [string[], number][] = [[["src/cli.ts", "tick", "queue", "--config", config], parseConfig(text).config.names.control.id]];
    const ownConfig = existsSync(join(import.meta.dir, "..", "qlander.yml"));
    if (ownConfig) entries.push([["src/main.ts", "queue"], controlConfig().config.names.control.id]);
    for (const [args, id] of entries) {
      const r = run(args, id);
      expect(r.exitCode, args.join(" ")).not.toBe(0);
      expect(r.stderr.toString(), args.join(" ")).toContain("STATE_TOKEN and GITHUB_TOKEN are required");
    }
    if (ownConfig) expect(run(["src/main.ts", "bogus"]).exitCode).toBe(2);
  });
});

describe("firstDifference", () => {
  test("null when equal; else the first differing line", () => {
    expect(firstDifference("a\nb\n", "a\nb\n")).toBeNull();
    expect(firstDifference("a\nb\n", "a\nc\n")).toEqual({ line: 2, want: "b", have: "c" });
    expect(firstDifference("a\n", "a\n\n")).toEqual({ line: 3, want: "(end of file)", have: "" });
  });
});
