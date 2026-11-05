// The template pin gate (scripts/template-pin.ts) and where it runs. It builds
// a small tree for real, with the Bun running this test.

import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEMPLATE_PIN, templatePinProblem } from "../scripts/template-pin";

const ROOT = join(import.meta.dir, "..");
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A tree that builds a release, with the given pin line and the running Bun pinned. */
function tree(pin: string, bun = Bun.version): string {
  const d = mkdtempSync(join(tmpdir(), "pin-tree-"));
  dirs.push(d);
  for (const sub of ["scripts", "src", "schema", ".github", "template/.github"]) mkdirSync(join(d, sub), { recursive: true });
  copyFileSync(join(ROOT, "scripts/build-release.ts"), join(d, "scripts/build-release.ts"));
  writeFileSync(join(d, "src/cli.ts"), 'console.log("hello");\n');
  writeFileSync(join(d, "schema/qlander.schema.json"), "{}\n");
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", version: "1.2.3" }));
  writeFileSync(join(d, ".github/bun-release.txt"), `${bun} bun-linux-x64.zip ${"0".repeat(64)}\n`);
  writeFileSync(join(d, TEMPLATE_PIN), `${pin}\n`);
  return d;
}

/** The pin line that tree really builds, taken from the refusal. */
function realPin(): string {
  const m = /this tree builds "(.*)"/.exec(templatePinProblem(tree("stale"))!);
  return m![1]!;
}

describe("templatePinProblem", () => {
  test("a stale pin is refused, and the refusal gives the line to write", () => {
    const stale = `1.2.3 qlander-1.2.3.js ${"a".repeat(64)}`;
    const why = templatePinProblem(tree(stale));
    expect(why).toContain("is stale");
    expect(why).toContain(stale);
    expect(why).toContain("qlander-1.2.3.js");
  });

  test("the pin the tree builds is accepted", () => {
    expect(templatePinProblem(tree(realPin()))).toBeNull();
  });

  test("a change under src/ makes the same pin stale", () => {
    const pin = realPin();
    const d = tree(pin);
    writeFileSync(join(d, "src/cli.ts"), 'console.log("changed");\n');
    expect(templatePinProblem(d)).toContain("is stale");
  });

  test("another Bun version checks nothing, and says so: even a right pin is refused", () => {
    const why = templatePinProblem(tree(realPin(), "0.0.1"));
    expect(why).toContain("can only be checked with Bun 0.0.1");
    expect(why).toContain("Nothing was checked");
  });

  test("a missing pin is refused", () => {
    const d = tree("x");
    rmSync(join(d, TEMPLATE_PIN));
    expect(templatePinProblem(d)).toContain("is missing");
  });
});

describe("where the gate runs", () => {
  test("the public release workflow compares the template pin with the built bundle, and refuses, before anything is published", () => {
    // The private tree keeps the public workflow under public/; the public tree has it in place.
    const overlay = join(ROOT, "public/.github/workflows/release.yml");
    const w = readFileSync(existsSync(overlay) ? overlay : join(ROOT, ".github/workflows/release.yml"), "utf8");
    const gate = w.indexOf("Refuse a stale template pin");
    expect(gate).toBeGreaterThan(w.indexOf("scripts/build-release.ts --out dist"));
    expect(gate).toBeLessThan(w.indexOf("gh release create"));
    expect(w).toContain(TEMPLATE_PIN);
    expect(w).toContain("exit 1");
  });

  test("the export calls it by default", () => {
    expect(readFileSync(join(ROOT, "scripts/export-public.ts"), "utf8")).toContain("o.templatePin ?? templatePinProblem");
  });
});
