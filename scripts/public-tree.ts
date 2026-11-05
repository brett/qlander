// Turns a copy of this repo into the tree the public repo ships
// (docs/deployment.md §7). Used by the export (scripts/export-public.ts) and
// by scripts/test-on-example.ts, so the suite is tested on exactly the files
// the public repo will have.
//
// Two steps, in this order:
//   1. The overlay: every file under public/ replaces the file at the same
//      path relative to the root (for example public/.github/workflows/ci.yml
//      becomes .github/workflows/ci.yml), and public/ itself is removed. These
//      are the files that differ between this repo and the public one, such
//      as the public repo's CI.
//   2. The deny-list: every path on the rules file's `exclude` list is
//      deleted ("dir/" is a directory, anything else an exact path).

import { cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const OVERLAY_DIR = "public";

/** Every file under `dir`, as /-separated paths relative to it (directories are not listed). */
export function listFiles(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const rel = relative(dir, full).split(sep).join("/");
      if (skip(rel)) continue;
      if (e.isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(dir);
  return out.sort();
}

/** Apply the overlay, then delete the deny-list paths, in `dir` (a copy: this changes it in place). */
export function makePublicTree(dir: string, exclude: string[]): void {
  const overlay = join(dir, OVERLAY_DIR);
  if (existsSync(overlay)) {
    if (!statSync(overlay).isDirectory()) throw new Error(`${OVERLAY_DIR} is not a directory`);
    for (const f of listFiles(overlay)) cpSync(join(overlay, f), join(dir, f));
    rmSync(overlay, { recursive: true, force: true });
  }
  for (const x of exclude) {
    if (!x || x.startsWith("/") || x.split("/").includes("..")) throw new Error(`bad exclude path ${x}`);
    rmSync(join(dir, x), { recursive: true, force: true });
  }
}

/**
 * Shipped files that mention a deny-listed document (an exclude entry under
 * docs/): a reference the public reader cannot follow. Returns `file: path`
 * lines; empty when there are none.
 */
export function danglingDocReferences(dir: string, exclude: string[]): string[] {
  const docs = exclude.filter((x) => x.startsWith("docs/"));
  if (docs.length === 0) return [];
  const out: string[] = [];
  for (const f of listFiles(dir, (rel) => rel === ".git" || rel === "node_modules")) {
    const body = readFileSync(join(dir, f));
    if (body.includes(0)) continue; // binary: the scrub scans it; a link in it is not followed by anyone
    const text = body.toString("utf8");
    for (const d of docs) if (text.includes(d)) out.push(`${f}: ${d}`);
  }
  return out;
}
