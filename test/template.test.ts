// The template control repo (docs/deployment.md §6.2), kept in template/ and
// published as its own repo: its config is valid, its workflows are exactly
// the rendering of that config, it runs a public pinned release of this
// version, and its CI downloads and checks the same two pins as the tick.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/cli";
import { parseConfig } from "../src/config/load";
import { renderWorkflows } from "../src/render";

const ROOT = join(import.meta.dir, "..");
const T = join(ROOT, "template");
const read = (p: string) => readFileSync(join(T, p), "utf8");
const config = parseConfig(read("qlander.yml"), "template/qlander.yml");

describe("template/", () => {
  test("the config is valid, in hosted mode with the epoch fence, and runs a public release", () => {
    expect(config.runner.mode).toBe("hosted");
    expect(config.runner.epochFence).toBe(true);
    expect(config.bundle).toEqual({ repo: "brett/qlander", private: false, watchdog: true });
  });

  test("tick.yml and watchdog.yml are exactly the rendering of the config", () => {
    for (const w of renderWorkflows(config)) expect(read(w.path)).toBe(w.text);
  });

  test("the pin names this version's bundle with a sha256; Bun is the same pin as this repo's", () => {
    const [version, asset, sum, ...rest] = read(".github/qlander-release.txt").trim().split(" ");
    expect(rest).toEqual([]);
    expect(version).toBe(VERSION);
    expect(asset).toBe(`qlander-${VERSION}.js`);
    expect(sum).toMatch(/^[0-9a-f]{64}$/);
    expect(read(".github/bun-release.txt")).toBe(readFileSync(join(ROOT, ".github/bun-release.txt"), "utf8"));
  });

  test("ci.yml checks both sha256 pins before it runs validate and render --check, with no secrets", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toContain("secrets.");
    const at = (s: string) => {
      const i = ci.indexOf(s);
      expect(i).toBeGreaterThan(-1);
      return i;
    };
    const bunCheck = at('echo "${sum}  ${asset}" | sha256sum -c -');
    const lsCheck = at('echo "${relsum}  ${relasset}" | sha256sum -c -');
    at("https://github.com/brett/qlander/releases/download/v${relversion}/${relasset}");
    expect(bunCheck).toBeLessThan(lsCheck);
    expect(lsCheck).toBeLessThan(at('validate --config qlander.yml'));
    expect(lsCheck).toBeLessThan(at('render --check --config qlander.yml'));
  });
});
