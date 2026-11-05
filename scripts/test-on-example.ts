// Runs the test suite on exactly the tree the public repo ships, which has no
// qlander.yml of its own, so the suite runs on the neutral example config
// (test/fixtures/example.qlander.yml, chosen by test/preload.ts). A test
// that passes here and in this checkout cannot depend on a value copied from
// either config, and a test the public repo would fail (one that reads a
// deny-listed file, say) fails here first.
//
// The script copies the working tree (tracked and untracked, not ignored)
// into a fresh temporary directory, turns the copy into the public tree
// (scripts/public-tree.ts: the public/ overlay, then the rules file's
// `exclude` list deleted), and runs `bun test` there. The checkout itself is
// never modified. Without the rules file (in the public repo), nothing is
// deleted.
//
// Usage: bun scripts/test-on-example.ts [bun test arguments...]

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makePublicTree } from "./public-tree";

const root = join(import.meta.dir, "..");
const RULES = "scripts/public-scrub.rules.json";

/** The deny-list from the rules file's text; none without a rules file. */
export function excludeList(rulesText: string | null): string[] {
  if (rulesText === null) return [];
  return (JSON.parse(rulesText) as { exclude: string[] }).exclude;
}

if (import.meta.main) {
  const files = spawnSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" });
  if (files.status !== 0) throw new Error(`git ls-files: ${files.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "qlander-example-"));
  let code = 1;
  try {
    for (const f of files.stdout.split("\0").filter(Boolean)) {
      if (!existsSync(join(root, f))) continue; // deleted in the working tree
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(root, f), join(dir, f));
    }
    makePublicTree(dir, excludeList(existsSync(join(root, RULES)) ? readFileSync(join(root, RULES), "utf8") : null));
    if (existsSync(join(dir, "qlander.yml"))) throw new Error("the public tree has a qlander.yml; the suite would not run on the example config");
    symlinkSync(join(root, "node_modules"), join(dir, "node_modules"));
    const args = ["test", ...process.argv.slice(2)];
    console.log(`bun ${args.join(" ")}  (in the public tree, on test/fixtures/example.qlander.yml)`);
    code = spawnSync(process.execPath, args, { cwd: dir, stdio: "inherit" }).status ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(code);
}
