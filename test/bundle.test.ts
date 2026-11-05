// Release packaging (docs/deployment.md §6.1, §6.3): the bundle that
// scripts/build-release.ts builds, and the download-verify-run lines that
// src/render.ts writes into the workflows for a pinned deployment. The
// end-to-end tests build the real bundle and run the rendered run step itself
// with bash (test/bundle-world.ts); nothing reaches the network.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "../src/cli";
import { type LoadedConfig, parseConfig } from "../src/config/load";
import { emptyState } from "../src/state";
import { emptyReleaseState } from "../src/release-state";
import { policyHash } from "../src/queue";
import { qlanderCommand, PIN_FILE, renderTick, renderWatchdog, renderWorkflows, watchdogInput } from "../src/render";
import { buildRelease, type ReleaseAssets } from "../scripts/build-release";
import { BUN_URL, sha256, type World, world as makeWorld } from "./bundle-world";

type Obj = Record<string, any>;
const YAML = (Bun as unknown as { YAML: { parse(s: string): unknown } }).YAML;
const ROOT = join(import.meta.dir, "..");
const exampleText = readFileSync(`${import.meta.dir}/fixtures/example.qlander.yml`, "utf8");
const example = parseConfig(exampleText);
const CONTROL = `${example.config.names.control.owner}/${example.config.names.control.name}`;
const OTHER = "someone-else/qlander";
const TOKEN = "job-token-0123456789";

const withBundle = (text: string, block: string) => `${text.trimEnd()}\n\nbundle:\n${block}`;
const privateText = withBundle(exampleText, `  repo: ${CONTROL}\n  private: true\n`);
const publicText = withBundle(exampleText, `  repo: ${OTHER}\n`);

let tmp: string;
let built: ReleaseAssets;
let bundle: Uint8Array;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "qlander-bundle-"));
  built = await buildRelease(join(tmp, "dist"));
  bundle = readFileSync(join(tmp, "dist", built.asset));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const world = (text: string, pin = built.pin) => makeWorld(tmp, text, pin, { controlId: example.config.names.control.id, token: TOKEN });
const runOf = (wf: string, job: string): string => ((YAML.parse(wf) as Obj).jobs[job].steps as Obj[]).find((s) => s.run)!.run;
const queueRun = (c: LoadedConfig) => runOf(renderTick(c), "queue");
const API = `https://api.github.com/repos/${CONTROL}/releases`;

/** The release API's answer for the pinned tag: the bundle among the other assets. */
const releaseJson = (asset: string) =>
  JSON.stringify({ tag_name: `v${built.version}`, assets: [{ name: "SHA256SUMS", id: 11 }, { name: asset, id: 4242 }, { name: "qlander.schema.json", id: 12 }] });

/** Serve the pinned private release the way the job reaches it. */
function servePrivate(w: World, asset: Uint8Array = bundle) {
  w.serve(`${API}/tags/v${built.version}`, releaseJson(built.asset));
  w.serve(`${API}/assets/4242`, asset);
}

/** What the tick says when it gets as far as connecting without the App tokens: it ran, with the config loaded. */
const REACHED_CONNECT = "STATE_TOKEN and GITHUB_TOKEN are required";
const spawn = (args: string[], cwd: string, env: Record<string, string>) => {
  const r = Bun.spawnSync([process.execPath, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
const PATH_ONLY = { PATH: process.env.PATH ?? "" };

describe("the release bundle (scripts/build-release.ts)", () => {
  test("one file named for package.json's version; SHA256SUMS covers the bundle and the schema; the pin line names both", () => {
    expect(built.version).toBe(VERSION);
    expect(built.asset).toBe(`qlander-${VERSION}.js`);
    const sums = readFileSync(join(tmp, "dist", "SHA256SUMS"), "utf8");
    expect(sums).toContain(`${built.sha256}  ${built.asset}\n`);
    expect(sums).toContain(`${sha256(readFileSync(join(ROOT, "schema/qlander.schema.json")))}  qlander.schema.json\n`);
    expect(built.pin).toBe(`${VERSION} ${built.asset} ${built.sha256}`);
  });

  test("deterministic: a second build is byte-identical, from any working directory", async () => {
    expect((await buildRelease(join(tmp, "dist-again"))).sha256).toBe(built.sha256);
    const r = spawn([join(ROOT, "scripts/build-release.ts"), "--out", join(tmp, "dist-cwd")], "/", PATH_ONLY);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`pin (${PIN_FILE}): ${built.pin}`);
  });

  test("a tag that is not v<version> is refused before anything is built", async () => {
    await expect(buildRelease(join(tmp, "dist-tag"), "v9.9.9")).rejects.toThrow(`does not match package.json version ${VERSION}`);
    expect(await buildRelease(join(tmp, "dist-tag"), `v${VERSION}`)).toEqual(built);
  });

  test("self-contained: it runs from a directory with nothing else in it, and agrees with the source on the same commands", () => {
    const dir = mkdtempSync(join(tmp, "alone-"));
    writeFileSync(join(dir, "b.js"), bundle);
    const config = join(dir, "qlander.yml");
    writeFileSync(config, exampleText);
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    for (const f of renderWorkflows(example)) writeFileSync(join(dir, f.path), f.text);
    writeFileSync(join(dir, "queue.json"), `${JSON.stringify(emptyState(), null, 1)}\n`);
    for (const args of [["version"], ["validate", "--config", config], ["render", "--check", "--config", config], ["check-state", "queue", "queue.json", "--config", config], ["bogus"]]) {
      expect(spawn(["b.js", ...args], dir, PATH_ONLY), args.join(" ")).toEqual(spawn([join(ROOT, "src/cli.ts"), ...args], dir, PATH_ONLY));
    }
    expect(spawn(["b.js", "version"], dir, PATH_ONLY).out).toBe(`${VERSION}\n`);
    // The bundle reads a config that pins the tick only.
    writeFileSync(join(dir, "tick-only.yml"), withBundle(exampleText, `  repo: ${CONTROL}\n  private: true\n  watchdog: false\n`));
    expect(spawn(["b.js", "validate", "--config", "tick-only.yml"], dir, PATH_ONLY).code).toBe(0);
  });

  // (The watchdog reads no state; on an invalid config it raises its own alert, by design.)
  test("verify-sandbox reads --config before its modules load the config, in the bundle as from the source", () => {
    const dir = mkdtempSync(join(tmp, "sandbox-"));
    writeFileSync(join(dir, "b.js"), bundle);
    writeFileSync(join(dir, "qlander.yml"), exampleText);
    const args = ["verify-sandbox", "queue", "--repo", "someone/sandbox", "--repo-id", "9999", "--config", "qlander.yml"];
    const b = spawn(["b.js", ...args], dir, PATH_ONLY);
    const s = spawn([join(ROOT, "src/cli.ts"), ...args], dir, PATH_ONLY);
    expect(b.code).toBe(s.code);
    expect(b.out).toBe(s.out);
    expect(b.out + b.err).toContain("needs VERIFY_QUEUE_TOKEN"); // past the config, at the token check
  });

  test("an unknown config version is refused by the bundle's tick, before any state is read", () => {
    const dir = mkdtempSync(join(tmp, "v2-"));
    writeFileSync(join(dir, "b.js"), bundle);
    writeFileSync(join(dir, "qlander.yml"), exampleText.replace("version: 1", "version: 2"));
    for (const args of [["validate"], ["tick", "queue"], ["tick", "release"]]) {
      const r = spawn(["b.js", ...args, "--config", "qlander.yml"], dir, { ...PATH_ONLY, GITHUB_TOKEN: TOKEN });
      expect(r.code, args.join(" ")).not.toBe(0);
      expect(r.err, args.join(" ")).toContain("$.version: must be 1");
    }
  });

  test("a state document newer than this version is refused by the bundle; one it knows is read back unchanged", () => {
    const dir = mkdtempSync(join(tmp, "state-"));
    writeFileSync(join(dir, "b.js"), bundle);
    writeFileSync(join(dir, "qlander.yml"), exampleText);
    const q = emptyState().v;
    const rl = emptyReleaseState().v;
    const cases: [string, string, unknown, number, string][] = [
      ["queue", "queue-now.json", emptyState(), 0, `queue state v${q}, readable by qlander ${VERSION}; written back unchanged`],
      ["queue", "queue-next.json", { ...emptyState(), v: q + 1 }, 1, `unknown version ${q + 1}`],
      ["release", "release-now.json", emptyReleaseState(), 0, `release state v${rl}, readable by qlander ${VERSION}; written back unchanged`],
      ["release", "release-next.json", { ...emptyReleaseState(), v: rl + 1 }, 1, `version ${rl + 1} is not ${rl}`],
    ];
    for (const [job, file, doc, code, want] of cases) {
      writeFileSync(join(dir, file), `${JSON.stringify(doc, null, 1)}\n`);
      const r = spawn(["b.js", "check-state", job, file, "--config", "qlander.yml"], dir, PATH_ONLY);
      expect(r.code, file).toBe(code);
      expect(r.out + r.err, file).toContain(want);
    }
  });
});

describe("the pinned run step (bundle set), end to end", () => {
  test("private: found and fetched with the job's token on stdin, verified, run with the checkout's config, and doing exactly what the source does", () => {
    const w = world(privateText);
    servePrivate(w);
    const r = w.run(queueRun(parseConfig(privateText)));
    expect(r.out).toContain(`${built.asset}: OK`);
    expect(r.err).toContain(REACHED_CONNECT);
    expect(r.code).not.toBe(0);
    const calls = r.log.split("\n").filter((l) => l.startsWith("argv "));
    expect(calls.map((l) => l.split(" ").pop())).toEqual([BUN_URL, `${API}/tags/v${built.version}`, `${API}/assets/4242`]);
    expect(calls[1]).toContain("Accept: application/vnd.github+json");
    expect(calls[2]).toContain("Accept: application/octet-stream");
    // Never on a command line: the token reaches the two API calls on stdin, and nothing else.
    expect(r.log.split("\n").filter((l) => l.includes(TOKEN))).toEqual([
      `stdin ${API}/tags/v${built.version} Authorization: Bearer ${TOKEN}`,
      `stdin ${API}/assets/4242 Authorization: Bearer ${TOKEN}`,
    ]);
    // The same tick from the source, in the same checkout and environment: the same output and the same stop.
    const src = spawn([join(ROOT, "src/cli.ts"), "tick", "queue", "--config", "qlander.yml"], w.dir, w.env);
    expect(src.code).toBe(r.code);
    expect(src.out).toBe(r.out.replace(`bun-linux-x64.zip: OK\n${built.asset}: OK\n`, ""));
    const lastError = (s: string) => s.split("\n").filter((l) => l.startsWith("error: ")).pop() ?? "";
    expect(lastError(r.err)).toBe(lastError(src.err));
    expect(lastError(r.err)).toContain(REACHED_CONNECT);
  });

  test("a tampered asset is refused: the checksum fails and the bundle never runs", () => {
    const w = world(privateText);
    servePrivate(w, Buffer.concat([bundle, Buffer.from('\nconsole.error("TAMPERED BUNDLE RAN");\n')]));
    const r = w.run(queueRun(parseConfig(privateText)));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`${built.asset}: FAILED`);
    expect(r.err).not.toContain("TAMPERED BUNDLE RAN");
    expect(r.err).not.toContain(REACHED_CONNECT);
  });

  test("a pin that names another checksum is refused the same way", () => {
    const w = world(privateText, `${built.version} ${built.asset} ${"0".repeat(64)}`);
    servePrivate(w);
    const r = w.run(queueRun(parseConfig(privateText)));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`${built.asset}: FAILED`);
    expect(r.err).not.toContain(REACHED_CONNECT);
  });

  test("a tampered Bun archive is refused before qlander is fetched", () => {
    const w = world(privateText);
    servePrivate(w);
    w.serve(BUN_URL, "not the archive");
    const r = w.run(queueRun(parseConfig(privateText)));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("bun-linux-x64.zip: FAILED");
    expect(r.log).not.toContain(API);
  });

  test("a release without exactly one asset of the pinned name, or a pinned name that is not a plain .js file name, stops the step", () => {
    const c = parseConfig(privateText);
    const missing = world(privateText);
    missing.serve(`${API}/tags/v${built.version}`, releaseJson("renamed-bundle.js"));
    const r1 = missing.run(queueRun(c));
    expect(r1.code).not.toBe(0);
    expect(r1.err).toContain(`the release has no single asset ${built.asset}`);
    expect(r1.log).not.toContain(`${API}/assets/`);
    for (const asset of ["../escape.js", "sub/dir.js", "qlander.sh"]) {
      const w = world(privateText, `${built.version} ${asset} ${built.sha256}`);
      servePrivate(w);
      const r = w.run(queueRun(c));
      expect(r.code, asset).not.toBe(0);
      expect(r.log, asset).not.toContain(API);
    }
  });

  test("an unknown config version in the checkout is refused by the downloaded bundle", () => {
    const w = world(privateText.replace("version: 1", "version: 2"));
    servePrivate(w);
    const r = w.run(queueRun(parseConfig(privateText)));
    expect(r.out).toContain(`${built.asset}: OK`);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("$.version: must be 1");
    expect(r.err).not.toContain(REACHED_CONNECT);
  });

  test("public: an anonymous download of the release asset; the token goes nowhere", () => {
    const w = world(publicText);
    w.serve(`https://github.com/${OTHER}/releases/download/v${built.version}/${built.asset}`, bundle);
    const r = w.run(queueRun(parseConfig(publicText)));
    expect(r.out).toContain(`${built.asset}: OK`);
    expect(r.err).toContain(REACHED_CONNECT);
    expect(r.log).not.toContain(TOKEN);
    expect(r.log).not.toContain("stdin ");
    expect(r.log).not.toContain("api.github.com");
  });
});

describe("rendering a pinned deployment (src/render.ts)", () => {
  const strip = (wf: string) => {
    const o = YAML.parse(wf) as Obj;
    for (const job of Object.values(o.jobs as Obj)) for (const s of job.steps as Obj[]) if (s.run) s.run = "(run)";
    return o;
  };

  test("only the run steps and the header comments change: jobs, permissions, tokens, env and steps stay the same", () => {
    for (const text of [privateText, publicText]) {
      const pinned = parseConfig(text);
      expect(strip(renderTick(pinned))).toEqual(strip(renderTick(example)));
      expect(strip(renderWatchdog(pinned))).toEqual(strip(renderWatchdog(example)));
    }
  });

  test("every job runs the pinned bundle with its own command, after both checksums; source mode is unchanged", () => {
    const pinned = parseConfig(privateText);
    const args = { queue: "tick queue", release: "tick release", watchdog: "watchdog" } as const;
    const runs = { queue: runOf(renderTick(pinned), "queue"), release: runOf(renderTick(pinned), "release"), watchdog: runOf(renderWatchdog(pinned), "watchdog") };
    for (const job of Object.keys(args) as (keyof typeof args)[]) {
      const run = runs[job];
      const cmd = qlanderCommand(pinned, args[job]);
      expect(cmd).toBe(`"$bun" "$dir/$relasset" ${args[job]} --config qlander.yml`);
      expect(run.trimEnd().endsWith(cmd), job).toBe(true);
      expect(run.split("sha256sum -c").length - 1, job).toBe(2);
      expect(run.lastIndexOf("sha256sum -c"), job).toBeLessThan(run.indexOf(cmd));
      expect(run, job).toContain(PIN_FILE);
      expect(run, job).not.toContain("src/cli.ts");
      expect(run, job).not.toContain("${{");
      // curl sends the token to the API host only: never --location-trusted, which would forward it on the redirect.
      expect(run, job).not.toContain("location-trusted");
      expect(run, job).not.toMatch(/Authorization: Bearer \$\{?GITHUB_TOKEN\}?"? *\\?\n *--|--header "Authorization/);
      expect(run.replace(cmd, ""), job).toBe(runs.queue.replace(qlanderCommand(pinned, args.queue), ""));
    }
    expect(qlanderCommand(example, "tick queue")).toBe('"$dir/${asset%.zip}/bun" src/cli.ts tick queue');
    expect(runOf(renderTick(example), "queue")).not.toContain(PIN_FILE);
  });

  test("bundle.watchdog false: the tick runs the bundle, the watchdog stays in source mode, byte for byte as without bundle", () => {
    const c = parseConfig(withBundle(exampleText, `  repo: ${CONTROL}\n  private: true\n  watchdog: false\n`));
    expect(c.bundle).toEqual({ repo: CONTROL, private: true, watchdog: false });
    expect(watchdogInput(c)).toEqual({ bundle: null });
    expect(renderWatchdog(c)).toBe(renderWatchdog(example));
    expect(renderTick(c)).toBe(renderTick(parseConfig(privateText)));
    const dog = runOf(renderWatchdog(c), "watchdog");
    expect(dog).not.toContain(PIN_FILE);
    expect(dog.trimEnd().endsWith(qlanderCommand(example, "watchdog"))).toBe(true);
    // The tick's run step still downloads and verifies the pinned release.
    expect(runOf(renderTick(c), "queue")).toContain(PIN_FILE);
    expect(() => parseConfig(withBundle(exampleText, `  repo: ${CONTROL}\n  watchdog: no-thanks\n`))).toThrow();
  });

  test("bundle is wiring, not policy: the policy hash is the same with or without it", () => {
    expect(policyHash(parseConfig(privateText).config)).toBe(policyHash(example.config));
    expect(policyHash(parseConfig(publicText).config)).toBe(policyHash(example.config));
    expect(parseConfig(privateText).bundle).toEqual({ repo: CONTROL, private: true, watchdog: true });
    expect(parseConfig(publicText).bundle).toEqual({ repo: OTHER, private: false, watchdog: true });
    expect(policyHash(parseConfig(withBundle(exampleText, `  repo: ${CONTROL}\n  private: true\n  watchdog: false\n`)).config)).toBe(policyHash(example.config));
    expect(example.bundle).toBeNull();
  });

  test("a private bundle must come from the control repo: the job's own token reads nothing else", () => {
    expect(() => parseConfig(withBundle(exampleText, `  repo: ${OTHER}\n  private: true\n`))).toThrow("reads only the control repo");
    expect(parseConfig(withBundle(exampleText, `  repo: ${CONTROL.toUpperCase()}\n  private: true\n`)).bundle?.private).toBe(true);
    for (const block of ["  private: true\n", `  repo: ${CONTROL}\n  extra: 1\n`, "  repo: not-a-repo\n", `  repo: ${CONTROL}\n  private: yes-please\n`]) {
      expect(() => parseConfig(withBundle(exampleText, block)), block).toThrow();
    }
  });
});

describe("release.yml: builds and publishes a tag's release", () => {
  const text = readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8");
  const wf = YAML.parse(text) as Obj;
  const job = wf.jobs.release as Obj;
  const steps = job.steps as Obj[];

  test("a pushed v* tag only; GitHub-hosted; nothing at the top; contents write plus the attestation's two permissions", () => {
    expect(wf.on).toEqual({ push: { tags: ["v*"] } });
    expect(Object.keys(wf.jobs)).toEqual(["release"]);
    expect(wf.permissions).toEqual({});
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.permissions).toEqual({ contents: "write", "id-token": "write", attestations: "write" });
    expect(job.environment).toBeUndefined();
    // The public repo's copy reads the scrub rules from a secret (test/export-public.test.ts); nothing else.
    expect(text.replace(/secrets\.PUBLIC_SCRUB_RULES/g, "")).not.toMatch(/secrets\.|setup-bun|actions\/cache|cache:|\bbun install\b|bunx|npx/);
  });

  test("builds with the verified pinned Bun and scripts/build-release.ts, which checks the tag; then rechecks SHA256SUMS", () => {
    const build = steps.find((s) => String(s.run ?? "").includes("build-release.ts"))!;
    expect(build.run).toContain(".github/bun-release.txt");
    expect(build.run.indexOf("sha256sum -c -")).toBeLessThan(build.run.indexOf("build-release.ts"));
    expect(build.run).toContain('scripts/build-release.ts --out dist --tag "$TAG"');
    expect(build.run).toContain("sha256sum -c SHA256SUMS");
    expect(build.env.TAG).toBe("${{ github.ref_name }}");
    for (const s of steps) if (s.run) expect(s.run).not.toContain("${{");
    const checkout = steps.find((s) => String(s.uses).startsWith("actions/checkout@"))!;
    expect(checkout.with["persist-credentials"]).toBe(false);
  });

  test("attests the bundle when the repo is public; publishes the bundle, the schema and SHA256SUMS", () => {
    const attest = steps.find((s) => String(s.uses).startsWith("actions/attest-build-provenance@"))!;
    expect(attest.if).toBe("${{ !github.event.repository.private }}");
    expect(attest.with["subject-path"]).toBe("dist/qlander-*.js");
    const publish = steps.find((s) => String(s.run ?? "").includes("gh release create"))!;
    expect(steps.indexOf(publish)).toBeGreaterThan(steps.indexOf(attest));
    expect(publish.run).toContain('gh release create "$TAG" --verify-tag');
    for (const f of ['"dist/qlander-${TAG#v}.js"', "dist/qlander.schema.json", "dist/SHA256SUMS"]) expect(publish.run).toContain(f);
  });
});
