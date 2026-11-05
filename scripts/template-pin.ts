// The gate on template/.github/qlander-release.txt: the template repo pins
// the sha256 of one release's bundle, and every job refuses a download that
// doesn't match it, so a stale pin ships a template that can't run.
//
// A pin can only be checked by building: this builds the bundle from the given
// tree (scripts/build-release.ts, in a temp directory) and compares pin lines.
// The bytes depend on the Bun that builds them, so the check refuses to run
// on any Bun version but the one in .github/bun-release.txt. A build with
// another version would say "stale" about a right pin, or "fine" about one a
// release wouldn't match.
//
// The pin only has to match when a release is cut: scripts/export-public.ts and
// the public release workflow check it. Set it last, once nothing under src/
// will change before the tag.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEMPLATE_PIN = "template/.github/qlander-release.txt";
const BUN_PIN = ".github/bun-release.txt";

/** Why the tree's template pin isn't its bundle, or null when it is. */
export function templatePinProblem(dir: string, bunVersion: string = Bun.version, bun: string = process.execPath): string | null {
  if (!existsSync(join(dir, BUN_PIN))) return `${BUN_PIN} is missing`;
  if (!existsSync(join(dir, TEMPLATE_PIN))) return `${TEMPLATE_PIN} is missing`;
  const pinnedBun = readFileSync(join(dir, BUN_PIN), "utf8").trim().split(" ")[0];
  if (pinnedBun !== bunVersion) return `the template pin can only be checked with Bun ${pinnedBun}, the version in ${BUN_PIN}: this is Bun ${bunVersion}, whose build may differ. Nothing was checked; rerun with Bun ${pinnedBun}`;
  const out = mkdtempSync(join(tmpdir(), "template-pin-"));
  try {
    const built = spawnSync(bun, ["scripts/build-release.ts", "--out", out], { cwd: dir, encoding: "utf8" });
    if (built.status !== 0) return `the bundle did not build: ${built.stderr.trim()}`;
    const pin = /^pin \(.*\): (.*)$/m.exec(built.stdout)?.[1];
    if (!pin) return "scripts/build-release.ts printed no pin line";
    const pinned = readFileSync(join(dir, TEMPLATE_PIN), "utf8").trim();
    if (pinned !== pin) return `${TEMPLATE_PIN} is stale: it says "${pinned}", and this tree builds "${pin}". A template with this pin refuses its own release. Write the built line into it`;
    return null;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
