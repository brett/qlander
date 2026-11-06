// The command line (docs/deployment.md §6.3):
//
//   bun src/cli.ts tick queue|release [--config <file>]
//       One tick of that job, as tick.yml runs it (src/main.ts).
//   bun src/cli.ts watchdog [--config <file>]
//       One watchdog run, as watchdog.yml runs it (src/watchdog.ts).
//   bun src/cli.ts check-state queue|release <file> [--config <file>]
//       Whether this version reads a state document (a copy of a state
//       branch's state.json), and whether it would write it back unchanged.
//       Exit 1 if it refuses it, as a tick would: run it with a release
//       before pinning that release, so a downgrade is never pinned onto
//       state it cannot read (docs/deployment.md §6.1, §8.1.1).
//   bun src/cli.ts version
//       This version (package.json), as a release bundle was built from it.
//   bun src/cli.ts validate [--config <file>]
//       Check a config; print every problem. Exit 1 if it is invalid.
//   bun src/cli.ts render [--check] [--config <file>]
//       Write tick.yml and watchdog.yml from the config, under the config
//       file's directory. With --check, write nothing and exit 1 if a
//       checked-in workflow differs from its rendering.
//   bun src/cli.ts setup [--plan | --apply] [--step <step>] [--keys-dir <dir> | --key-cmd <command>] ...
//       Make the GitHub side (Apps, installations, the control and target
//       repos) match the config, from an operator's machine
//       (src/setup/command.ts). --plan, the default, writes nothing.
//   bun src/cli.ts audit [--config <file>] [--target-only|--control-only] [--json]
//       Check the target's CI requirements and the control repo's protection
//       (src/audit/command.ts), read-only, with a token in GH_TOKEN. Exit 1
//       on a FAIL, 3 when a read failed and it is inconclusive.
//   bun src/cli.ts status [--json] [--watch <seconds>] [--config <file>]
//       A read-only view of the live queue (src/status-cli.ts), with a
//       read-only token in GH_TOKEN or GITHUB_TOKEN. Exit 3 when a read failed
//       or came back incomplete.
//   bun src/cli.ts pause|resume|quiesce|unquiesce|remove|requeue|prioritise|approve-policy ...
//       Operator controls (src/control-cli.ts), with the operator's own token
//       in GH_TOKEN or GITHUB_TOKEN; each takes --dry-run.
//
// --config defaults to the control repo's own qlander.yml, next to the
// source. A release bundle (scripts/build-release.ts) runs from a temp
// directory, so the rendered workflows pass the checkout's file explicitly;
// the tick and the watchdog still read only their own checkout's config.
// Usage errors exit 2.
//
// Each command imports what it runs only when it runs: the tick's modules
// load the control repo's config as they are imported, and `validate`,
// `render` and the watchdog must work when that file is invalid.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { CONFIG_PATH, ConfigError, type LoadedConfig, loadConfig, useConfigFile } from "./config/load";
import { CONTROL_USAGE, isControlCommand } from "./control-usage";
import { firstDifference, HAND_WORKFLOWS, RenderError, renderWorkflows, withBundleDownload } from "./render";

export const USAGE = [
  "usage: bun src/cli.ts <command>",
  "  tick queue|release [--config <file>]",
  "                                     run one tick of a job",
  "  watchdog [--config <file>]         run the watchdog once",
  "  check-state queue|release <file> [--config <file>]",
  "                                     whether this version reads a state document",
  "  version                            print this version",
  "  validate [--config <file>]         check a config",
  "  render [--check] [--config <file>] write the workflows, or check the checked-in ones",
  "  status [--json] [--watch <seconds>] [--config <file>]",
  "                                     show the live queue, read-only (token: GH_TOKEN or GITHUB_TOKEN)",
  "  audit [--config <file>] [--target-only|--control-only] [--json] [--queue-app|--release-app|--state-app <slug>]",
  "                                     check the target's CI and the control repo's protection, read-only (token: GH_TOKEN)",
  CONTROL_USAGE,
  "  setup [--plan | --apply] [--step <step>] [--keys-dir <dir> | --key-cmd <command>] [--config <file>]",
  "                                     create and check the Apps, installations and repo settings (see src/setup/command.ts)",
  "  verify-sandbox <phase> --repo <owner>/<name> --repo-id <id> [--config <file>]",
  "                                     run the G1/H1 checks against a sandbox repo, never the target",
].join("\n");

/** Output and the file system, so tests can run commands without touching either. */
export interface Io {
  out(line: string): void;
  err(line: string): void;
  read(path: string): string | null;
  write(path: string, text: string): void;
}

export const realIo: Io = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  read: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  write: (p, t) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, t);
  },
};

class UsageError extends Error {}

/** `--config <file>` and the boolean flags a command allows; anything else is a usage error. */
function parseFlags(args: string[], booleans: string[]): { config: string; flags: Set<string> } {
  let config = CONFIG_PATH;
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--config") {
      const v = args[++i];
      if (!v) throw new UsageError("--config needs a file");
      config = resolve(v);
    } else if (booleans.includes(a) && !flags.has(a)) flags.add(a);
    else throw new UsageError(`unexpected argument ${a}`);
  }
  return { config, flags };
}

/** The config, or null after printing why it is invalid. */
function load(path: string, io: Io): LoadedConfig | null {
  try {
    return loadConfig(path);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    io.err(`${e.source} is not a valid qlander config:`);
    for (const p of e.problems) io.err(`  ${p}`);
    return null;
  }
}

async function validate(args: string[], io: Io): Promise<number> {
  const { config } = parseFlags(args, []);
  const c = load(config, io);
  if (!c) return 1;
  io.out(`${config}: valid`);
  return 0;
}

function render(args: string[], io: Io): number {
  const { config, flags } = parseFlags(args, ["--check"]);
  const c = load(config, io);
  if (!c) return 1;
  let files: { path: string; text: string }[];
  try {
    files = renderWorkflows(c);
  } catch (e) {
    if (!(e instanceof RenderError)) throw e;
    io.err(`cannot render: ${e.message}`);
    return 1;
  }
  const root = dirname(config);
  const check = flags.has("--check");
  // Only their download is rendered, and they may be hand-edited: --check says so, and never fails an install over them.
  for (const path of c.bundle ? HAND_WORKFLOWS : []) {
    const have = io.read(join(root, path));
    if (have === null) continue;
    const want = withBundleDownload(have, c.bundle!);
    if (want === have) continue;
    if (check) io.out(`${path}: its qlander download differs from bundle; run render to update it`);
    else {
      io.write(join(root, path), want);
      io.out(`updated the qlander download in ${path}`);
    }
  }
  if (!check) {
    for (const f of files) {
      io.write(join(root, f.path), f.text);
      io.out(`wrote ${f.path}`);
    }
    return 0;
  }
  let stale = 0;
  for (const f of files) {
    const have = io.read(join(root, f.path));
    const d = have === null ? { line: 0, want: "(the rendered file)", have: "(missing)" } : firstDifference(f.text, have);
    if (!d) {
      io.out(`${f.path}: matches the config`);
      continue;
    }
    stale++;
    io.err(`${f.path}: differs from its rendering at line ${d.line}`);
    io.err(`  rendered:   ${d.want}`);
    io.err(`  checked in: ${d.have}`);
  }
  if (stale) io.err("run `bun src/cli.ts render` and commit the result");
  return stale ? 1 : 0;
}

/** This version, from package.json; a release is tagged v<version>. */
export const VERSION: string = pkg.version;

/** Parse a state document as a tick would; exit 1 when this version refuses it. */
async function checkState(args: string[], io: Io): Promise<number> {
  const [job, file, ...rest] = args;
  if ((job !== "queue" && job !== "release") || !file || file.startsWith("--")) throw new UsageError("check-state needs a job (queue or release) and a state file");
  const { config } = parseFlags(rest, []);
  const c = load(config, io);
  if (!c) return 1;
  const text = io.read(file);
  if (text === null) {
    io.err(`${file}: cannot be read`);
    return 1;
  }
  const { parseState } = await import("./state");
  const { parseReleaseState } = await import("./release-state");
  const { serialise } = await import("./store");
  let state: { v: number };
  try {
    state = job === "queue" ? parseState(text, c.config.names) : parseReleaseState(text);
  } catch (e) {
    io.err(`${file}: refused by qlander ${VERSION}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const same = serialise(state) === text;
  io.out(`${file}: ${job} state v${state.v}, readable by qlander ${VERSION}; ${same ? "written back unchanged" : "written back changed (a migration or a different layout)"}`);
  return 0;
}

/** `--config <file>` for tick and watchdog: set before their modules load the config. */
function useConfigArg(args: string[], command: string): void {
  if (!args.length) return;
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) throw new UsageError(`${command}: the only argument is --config <file>`);
  useConfigFile(args[1]);
}

/** Run one command; resolves to the exit code. Errors from a tick or the watchdog propagate, failing the job as before. `env` is read by `status` and the controls only. */
export async function main(argv: string[], io: Io = realIo, env: Record<string, string | undefined> = process.env): Promise<number> {
  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case "tick": {
        const [job, ...rest] = args;
        if (job !== "queue" && job !== "release") throw new UsageError("tick needs exactly one job: queue or release");
        useConfigArg(rest, "tick");
        const { runTickJob } = await import("./main");
        await runTickJob(job);
        return 0;
      }
      case "watchdog": {
        useConfigArg(args, "watchdog");
        const { watchdogMain } = await import("./watchdog");
        await watchdogMain();
        return 0;
      }
      case "validate":
        return await validate(args, io);
      case "check-state":
        return await checkState(args, io);
      case "version":
        if (args.length) throw new UsageError("version takes no arguments");
        io.out(VERSION);
        return 0;
      case "render":
        return render(args, io);
      case "status": {
        const { statusCommand } = await import("./status-cli");
        return await statusCommand(args, { out: (t) => io.out(t.replace(/\n$/, "")), err: (l) => io.err(l) }, { env });
      }
      case "setup": {
        const { setupCommand } = await import("./setup/command");
        return await setupCommand(args, io, env);
      }
      case "audit": {
        const { auditCommand } = await import("./audit/command");
        return await auditCommand(args, io, { env });
      }
      case "verify-sandbox": {
        // Its modules load the control config as they are imported: a bundle must point them at --config first.
        const at = args.indexOf("--config");
        if (at >= 0 && args[at + 1]) useConfigFile(args[at + 1]!);
        const { verifySandbox } = await import("./sandbox/command");
        return await verifySandbox(args, env);
      }
      default:
        if (isControlCommand(cmd)) {
          const { controlCommand } = await import("./control-cli");
          return await controlCommand(cmd, args, { out: (t) => io.out(t), err: (l) => io.err(l) }, { env }, CONFIG_PATH, (p) => resolve(p));
        }
        throw new UsageError(cmd === undefined ? "no command" : `unknown command ${cmd}`);
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.err(e.message);
    io.err(USAGE);
    return 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
