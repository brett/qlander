// A control checkout for running a rendered workflow's run step with bash,
// with `curl` replaced by a stand-in that serves local files by URL and
// records every call, and a Bun archive that wraps this test's own Bun. So
// the URLs, the token handling, the checksum checks and the command line are
// the workflow's own, and nothing reaches the network (test/bundle.test.ts).

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIN_FILE } from "../src/render";

export const sha256 = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

export const BUN_URL = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip";

/** A zip with one stored (uncompressed) executable file, laid out as the Bun release archive is. */
export function zipOne(name: string, data: Uint8Array): Uint8Array {
  const n = new TextEncoder().encode(name);
  const crc = Bun.hash.crc32(data);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 10, true);
  local.setUint16(12, 0x21, true); // 1980-01-01
  local.setUint32(14, crc, true);
  local.setUint32(18, data.length, true);
  local.setUint32(22, data.length, true);
  local.setUint16(26, n.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, (3 << 8) | 20, true); // made by Unix, so unzip keeps the mode
  central.setUint16(6, 10, true);
  central.setUint16(14, 0x21, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, data.length, true);
  central.setUint32(24, data.length, true);
  central.setUint16(28, n.length, true);
  central.setUint32(38, (0o100755 << 16) >>> 0, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + n.length, true);
  end.setUint32(16, 30 + n.length + data.length, true);
  return new Uint8Array(Buffer.concat([new Uint8Array(local.buffer), n, data, new Uint8Array(central.buffer), n, new Uint8Array(end.buffer)]));
}

/** Records each call in $CURL_LOG (with what it read from stdin for `--header @-`) and serves $CURL_FILES/<hash of the URL>, else fails as --fail does. */
const FAKE_CURL = `#!/usr/bin/env bash
set -u
out=""; url=""; stdin=0
args=("$@")
for ((i = 0; i < \${#args[@]}; i++)); do
  case "\${args[$i]}" in
    --output) i=$((i + 1)); out="\${args[$i]}" ;;
    --header) i=$((i + 1)); [[ "\${args[$i]}" == "@-" ]] && stdin=1 ;;
    --proto) i=$((i + 1)) ;;
    -*) ;;
    *) url="\${args[$i]}" ;;
  esac
done
printf 'argv %s\\n' "$*" >> "$CURL_LOG"
if [[ $stdin == 1 ]]; then printf 'stdin %s %s\\n' "$url" "$(cat)" >> "$CURL_LOG"; fi
src="$CURL_FILES/$(printf '%s' "$url" | sha256sum | cut -c1-16)"
[[ -f "$src" ]] || { echo "curl: (22) The requested URL returned error: 404" >&2; exit 22; }
cp "$src" "$out"
`;

export interface World {
  dir: string;
  /** Serve `body` at `url`. */
  serve(url: string, body: Uint8Array | string): void;
  /** Run a script with bash in the checkout, as a workflow step would. */
  run(script: string, env?: Record<string, string>): { code: number; out: string; err: string; log: string };
  /** The environment `run` uses, for running something else the same way. */
  env: Record<string, string>;
}

/** A control checkout under `parent` with the config, both pin files, and the Bun archive served at its real URL. */
export function world(parent: string, configText: string, pin: string, opts: { controlId: number; token: string }): World {
  const base = mkdtempSync(join(parent, "control-"));
  const dir = join(base, "checkout");
  const files = join(base, "files");
  const bin = join(base, "bin");
  const log = join(base, "curl.log");
  for (const d of [dir, files, bin, join(dir, ".github")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, "qlander.yml"), configText);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(log, "");
  const serve = (url: string, body: Uint8Array | string) => writeFileSync(join(files, sha256(url).slice(0, 16)), body);
  const archive = zipOne("bun-linux-x64/bun", new TextEncoder().encode(`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`));
  writeFileSync(join(dir, ".github/bun-release.txt"), `1.4.2 bun-linux-x64.zip ${sha256(archive)}\n`);
  serve(BUN_URL, archive);
  writeFileSync(join(dir, PIN_FILE), `${pin}\n`);
  writeFileSync(join(base, "event.json"), JSON.stringify({ repository: { id: opts.controlId } }));
  const env = {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    HOME: base,
    CURL_LOG: log,
    CURL_FILES: files,
    GITHUB_TOKEN: opts.token,
    GITHUB_EVENT_NAME: "schedule",
    GITHUB_EVENT_PATH: join(base, "event.json"),
    GITHUB_RUN_ID: "1",
    GITHUB_RUN_ATTEMPT: "1",
  };
  return {
    dir,
    serve,
    env,
    run(script, extra = {}) {
      const r = Bun.spawnSync(["bash", "-c", script], { cwd: dir, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
      return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString(), log: readFileSync(log, "utf8") };
    },
  };
}
