// Builds a release's assets (docs/deployment.md §6.1) into a directory:
//
//   qlander-<version>.js   one file, `bun build --target=bun src/cli.ts`
//   qlander.schema.json    the config schema
//   SHA256SUMS             sha256sum's format, for both
//
// and prints the pin line for .github/qlander-release.txt:
// "<version> <asset> <sha256>". The version is package.json's; with --tag,
// the tag must be exactly v<version>, so a release never carries a bundle
// that names another version. The build is deterministic: the same source and
// the same Bun give the same bytes, so anyone can rebuild a release from its
// tag and compare the checksum.
//
// Usage: bun scripts/build-release.ts --out <dir> [--tag v<version>]

import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");

export interface ReleaseAssets {
  version: string;
  /** The bundle's file name in the release. */
  asset: string;
  sha256: string;
  /** The line for .github/qlander-release.txt. */
  pin: string;
}

const sha256 = (path: string) => new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

/** Build the assets into `out` (emptied first). Throws on a tag that does not match the version, or a failed build. */
export async function buildRelease(out: string, tag?: string): Promise<ReleaseAssets> {
  const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string }).version;
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`package.json version ${String(version)} is not X.Y.Z`);
  if (tag !== undefined && tag !== `v${version}`) throw new Error(`tag ${tag} does not match package.json version ${version} (want v${version})`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const asset = `qlander-${version}.js`;
  // The bundle's path comments are relative to the working directory: build from the repo root, wherever this was run from.
  const cwd = process.cwd();
  process.chdir(root);
  let built: Awaited<ReturnType<typeof Bun.build>>;
  try {
    built = await Bun.build({ entrypoints: ["src/cli.ts"], target: "bun", outdir: out, naming: asset });
  } finally {
    process.chdir(cwd);
  }
  if (!built.success) throw new Error(`bun build failed:\n${built.logs.map(String).join("\n")}`);
  const files = readdirSync(out);
  if (files.length !== 1 || files[0] !== asset) throw new Error(`bun build wrote ${files.join(", ")}, not one file ${asset}`);
  copyFileSync(join(root, "schema/qlander.schema.json"), join(out, "qlander.schema.json"));
  const sums = [asset, "qlander.schema.json"].sort().map((f) => `${sha256(join(out, f))}  ${f}\n`).join("");
  writeFileSync(join(out, "SHA256SUMS.tmp"), sums);
  renameSync(join(out, "SHA256SUMS.tmp"), join(out, "SHA256SUMS"));
  const sum = sha256(join(out, asset));
  return { version, asset, sha256: sum, pin: `${version} ${asset} ${sum}` };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  let out: string | undefined;
  let tag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) out = resolve(args[++i]!);
    else if (args[i] === "--tag" && args[i + 1]) tag = args[++i]!;
    else {
      console.error("usage: bun scripts/build-release.ts --out <dir> [--tag v<version>]");
      process.exit(2);
    }
  }
  if (!out) {
    console.error("usage: bun scripts/build-release.ts --out <dir> [--tag v<version>]");
    process.exit(2);
  }
  const r = await buildRelease(out, tag);
  console.log(readFileSync(join(out, "SHA256SUMS"), "utf8").trimEnd());
  console.log(`pin (${".github/qlander-release.txt"}): ${r.pin}`);
}
