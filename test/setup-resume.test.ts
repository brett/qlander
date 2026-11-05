// The kill-and-resume test (docs/deployment.md §5.1): each setup step runs as
// its own process against one fake GitHub served on a local port, with a
// fake `gh` for the secrets. A reference run counts every API write. Then,
// for each write in turn, a fresh run is killed (SIGKILL) right after GitHub
// applied that write and before its answer arrived, and the killed step is
// rerun as a new process, followed by the remaining steps. Every such run
// must reach the reference end state: no duplicate App, environment,
// ruleset or label, and no request for a key that is already in the key
// directory (only a kill straight after an App was created loses its key,
// which GitHub shows only once). A last full run then writes nothing, apart
// from the probe branch verify creates and deletes.
//
// A test-side "operator" reads each child's output and does what a person
// would: completes the manifest flow in the "browser", installs Apps, and
// generates a replacement key when asked.

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSpecs } from "../src/setup/expected";
import { FakeSetupGitHub } from "./fake-github-setup";
import { EXAMPLE, exampleConfig, fakeFor, freshKeysDir, installAll } from "./setup-world";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const STEPS = ["apps", "install", "control", "target", "verify"];
const config = exampleConfig();
const specs = appSpecs(config, config.config.names.control.name);

const ghDir = mkdtempSync(join(tmpdir(), "setup-fake-gh-"));
writeFileSync(join(ghDir, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-gh.ts")}" "$@"\n`);
chmodSync(join(ghDir, "gh"), 0o755);

interface Run {
  f: FakeSetupGitHub;
  url: string;
  keysDir: string;
  child: { kill(sig?: number | NodeJS.Signals): void } | null;
  keyPrompts: number;
  /** Steps that were killed and rerun. */
  reruns: string[];
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** What a person does when a line asks for it. */
async function operator(r: Run, line: string): Promise<void> {
  const page = /open (http:\/\/127\.0\.0\.1:\d+\/) in a browser/.exec(line);
  if (page) {
    const html = await (await fetch(page[1]!)).text();
    const action = unescape(/action="([^"]+)"/.exec(html)![1]!);
    const manifest = unescape(/name="manifest" value="([^"]+)"/.exec(html)![1]!);
    const created = await fetch(action, { method: "POST", body: new URLSearchParams({ manifest }), redirect: "manual" });
    await fetch(created.headers.get("location")!);
    return;
  }
  if (/\/apps\/[a-z0-9-]+\/installations\/new$/.test(line)) installAll(r.f, specs);
  const key = /save the downloaded file as (\S+\/([a-z0-9-]+)\.pem)$/.exec(line);
  if (key) {
    r.keyPrompts++;
    writeFileSync(key[1]!, r.f.generateKey(key[2]!), { mode: 0o644 });
  }
}

async function step(r: Run, name: string): Promise<{ code: number; killed: boolean; out: string[] }> {
  const child = Bun.spawn(
    [process.execPath, CLI, "setup", "--apply", "--step", name, "--apply-target-rulesets", "--skip-audit", "--config", EXAMPLE, "--keys-dir", r.keysDir, "--poll-seconds", "0.05", "--wait-minutes", "0.5"],
    {
      env: { PATH: `${ghDir}:${process.env.PATH}`, HOME: process.env.HOME, GH_TOKEN: r.f.operator, QLANDER_GITHUB_API: r.url, QLANDER_GITHUB_WEB: r.url },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  r.child = child;
  const out: string[] = [];
  const acts: Promise<void>[] = [];
  const reader = child.stdout.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      out.push(line);
      acts.push(operator(r, line).catch(() => {}));
    }
  }
  await Promise.all(acts);
  const code = await child.exited;
  if (code !== 0 && child.signalCode !== "SIGKILL") out.push(await new Response(child.stderr).text());
  return { code, killed: child.signalCode === "SIGKILL", out };
}

/** Every step, in order; a killed step is rerun once (a new process) with no further kill. */
async function setup(killAt: number | null): Promise<{ r: Run; killedAt: string | null; stop(): void }> {
  const f = fakeFor(config);
  const server = f.serve();
  const r: Run = { f, url: server.url, keysDir: freshKeysDir(), child: null, keyPrompts: 0, reruns: [] };
  let killedAt: string | null = null;
  f.onMutation = (n, what) => {
    if (n !== killAt) return;
    killedAt = what;
    r.child?.kill("SIGKILL");
  };
  for (const s of STEPS) {
    let res = await step(r, s);
    if (res.killed) {
      r.reruns.push(s);
      f.onMutation = null;
      res = await step(r, s);
    }
    if (res.code !== 0) throw new Error(`step ${s} exited ${res.code}${killAt ? ` (kill at write ${killAt}: ${killedAt})` : ""}:\n${res.out.join("\n")}`);
  }
  return { r, killedAt, stop: server.stop };
}

describe("kill and resume across processes", () => {
  test(
    "a kill after any write resumes to the same end state, with no duplicate and no needless key request",
    async () => {
      const ref = await setup(null);
      const writes = [...ref.r.f.mutations];
      const end = JSON.stringify(ref.r.f.snapshot());
      ref.stop();
      expect(ref.r.keyPrompts).toBe(0);
      expect(writes.filter((w) => w.startsWith("create app"))).toHaveLength(specs.length);
      expect(writes.length).toBeGreaterThan(20);

      for (let k = 1; k <= writes.length; k++) {
        const run = await setup(k);
        try {
          expect({ k, killed: run.killedAt }).toEqual({ k, killed: writes[k - 1]! });
          // The process really died there, and its step ran again in a new one.
          expect({ k, reruns: run.r.reruns.length }).toEqual({ k, reruns: 1 });
          expect({ k, end: JSON.stringify(run.r.f.snapshot()) }).toEqual({ k, end });
          // Only a kill right after GitHub made an App loses that App's key (shown once); nothing else asks for one.
          expect({ k, keyPrompts: run.r.keyPrompts }).toEqual({ k, keyPrompts: writes[k - 1]!.startsWith("create app") ? 1 : 0 });
          if (k === writes.length || k === 1 || writes[k - 1]!.startsWith("create app")) {
            // And once resumed, a full rerun writes nothing but verify's probe, which it deletes again.
            const lasting = () => run.r.f.mutations.filter((m) => !m.includes("-setup-probe"));
            const before = lasting().length;
            for (const s of STEPS) expect((await step(run.r, s)).code).toBe(0);
            expect(lasting().length).toBe(before);
          }
        } finally {
          run.stop();
        }
      }
    },
    600_000,
  );
});
