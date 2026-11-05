// Qualification providers for release advance (docs/deployment.md §2,
// docs/qualification-manifest.md): the worked cases for each provider, the
// no-zero-evidence rule, and the config checks that go with them.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isPolicyChange } from "../src/evidence";
import { CONFIG_PATH, ConfigError, parseConfig } from "../src/config/load";
import { runReleaseDry } from "../src/main";
import { blobSha, type Qualification } from "../src/qualification";
import { parseQualificationManifest, reevaluate } from "../src/release";
import { discoverRelease } from "../src/release-runner";
import { ReleaseWorld, runUrl, QUALIFY } from "./release-world";
import { job, sha } from "./sim";

const CI = ".github/workflows/ci.yml";
const entry = (o: Partial<{ path: string; name: string; when: "always" | "if_triggered"; required_jobs: string[]; allow_skipped_jobs: Record<string, string> }> = {}) => ({
  path: CI,
  name: "CI",
  when: "always" as const,
  required_jobs: ["Test"],
  allow_skipped_jobs: {},
  ...o,
});

function world(q: Qualification): ReleaseWorld {
  const w = new ReleaseWorld();
  w.cfg = { ...w.cfg, qualification: q };
  return w;
}

describe("checks-green: the config's manifest, on push runs on main", () => {
  const green = (required = [entry()]): Qualification => ({ provider: "checks-green", required });

  test("a green push run on main qualifies; the receipt records the config's policy version and no proof run", async () => {
    const w = world(green());
    const a = w.land();
    w.ci(a); // no status, no proof run: none is needed
    const r = await w.ok();
    expect(r.outcome).toBe("advanced");
    const receipt = w.state().history.at(-1)!.receipt!;
    expect(receipt.policyBlob).toBe(blobSha(JSON.stringify([entry()])));
    expect(receipt.proofRun).toBeNull();
    expect(receipt.evidence[0]).toMatchObject({ workflow: "CI", branch: "main" });
  });

  test("a skipped required job is refused", async () => {
    const w = world(green());
    const a = w.land();
    w.ci(a, [job("Test", "skipped")]);
    expect((await w.ok()).outcome).toBe("none");
  });

  test("one red matrix leg is refused, though the other legs passed", async () => {
    const w = world(green([entry({ required_jobs: ["Test (a)", "Test (b)"] })]));
    const a = w.land();
    w.ci(a, [job("Test (a)"), job("Test (b)", "failure")]);
    const r = await w.ok();
    expect(r.decision).toMatchObject({ kind: "none", reason: expect.stringContaining("'Test (b)' is failure") });
  });

  test("a pull_request run, a run on another branch and a fork's run are not evidence", async () => {
    for (const over of [{ event: "pull_request" }, { head_branch: "queue/1" }, { head_repository: { id: 1 } }]) {
      const w = world(green());
      const a = w.land();
      w.target.addRun({ head_sha: a, path: CI, ...over }, [job("Test")]);
      expect((await w.ok()).outcome).toBe("none");
    }
  });

  test("zero evidence: a manifest whose only workflow is an absent if_triggered one never qualifies", async () => {
    const w = world(green([entry({ when: "if_triggered" })]));
    const a = w.land();
    const r = await w.ok();
    expect(r.decision).toMatchObject({ kind: "none", reason: expect.stringContaining(`${a}: re-evaluation cites no run (zero evidence)`) });
  });
});

describe("commit-status: the newest status of one context, from a listed creator", () => {
  const CREATOR = 777;
  const base = (o: Partial<Extract<Qualification, { provider: "commit-status" }>> = {}): Qualification => ({
    provider: "commit-status",
    context: "ci/verified",
    creators: [CREATOR],
    producerWorkflow: null,
    targetUrl: null,
    proof: null,
    ...o,
  });
  const post = (w: ReleaseWorld, s: string, ...entries: { state?: string; creatorId?: number | null; targetUrl?: string | null; context?: string }[]) =>
    w.target.statusHistory.set(
      s,
      entries.map((e) => ({ context: e.context ?? "ci/verified", state: e.state ?? "success", targetUrl: e.targetUrl ?? null, creatorId: e.creatorId === undefined ? CREATOR : e.creatorId })),
    );

  test("a success from a listed creator qualifies", async () => {
    const w = world(base());
    const a = w.land();
    post(w, a, {});
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.release).toBe(a);
    expect(w.state().history.at(-1)!.receipt).toMatchObject({ proofRun: null, evidence: [{ workflow: "status ci/verified", branch: null, run_id: null }] });
  });

  test("a forged status, posted by an account not in creators (or by no known account), is refused", async () => {
    for (const creatorId of [999, null]) {
      const w = world(base());
      const a = w.land();
      post(w, a, { creatorId });
      expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: expect.stringContaining("not a listed creator") });
    }
  });

  test("only the newest status of the context counts", async () => {
    const w = world(base());
    const a = w.land();
    post(w, a, { state: "failure" }, { state: "success" }); // newest first
    expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: expect.stringContaining("the newest ci/verified status is failure") });
    // Another context's newer entry does not hide it.
    post(w, a, { context: "other", state: "failure" }, { state: "success" });
    expect((await w.ok()).outcome).toBe("advanced");
  });

  test("an incomplete status history with no entry for the context is refused, and says so", async () => {
    const w = world(base());
    const a = w.land();
    post(w, a, { context: "other" });
    w.target.statusHistoryTruncated = true;
    expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: expect.stringContaining("(status history incomplete)") });
  });

  test("targetUrl: actions-run refuses a target_url outside the target repo's Actions runs", async () => {
    for (const [url, outcome] of [
      [runUrl(5), "advanced"],
      [runUrl(5, "someone/else"), "none"],
      ["https://example.com/ok", "none"],
      [null, "none"],
    ] as const) {
      const w = world(base({ targetUrl: "actions-run" }));
      const a = w.land();
      post(w, a, { targetUrl: url });
      expect((await w.ok()).outcome).toBe(outcome);
    }
  });

  test("with proof, the status must point at a run of the proof workflow on main with the job for this sha", async () => {
    const proof = { workflow: QUALIFY, events: ["workflow_run"], jobTemplate: "Gate {sha}" };
    for (const [jobFor, outcome] of [["self", "advanced"], ["other", "none"]] as const) {
      const w = world(base({ proof }));
      const a = w.land();
      const id = w.proof(a, { jobNames: [`Gate ${jobFor === "self" ? a : sha("x")}`] });
      post(w, a, { targetUrl: runUrl(id) });
      const r = await w.ok();
      expect(r.outcome).toBe(outcome);
      if (outcome === "advanced") expect(w.state().history.at(-1)!.receipt).toMatchObject({ proofRun: id, evidence: [{ run_id: id }] });
    }
    // A proof run of another repository's code (a fork's head) is refused.
    {
      const w = world(base({ proof }));
      const a = w.land();
      const id = w.proof(a, { jobNames: [`Gate ${a}`] });
      w.target.runs.find((r) => r.id === id)!.head_repository = { id: 1 };
      post(w, a, { targetUrl: runUrl(id) });
      expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: expect.stringContaining("runs another repository's code") });
    }
    // A proof run from an event not listed is refused.
    const w = world(base({ proof: { ...proof, events: ["workflow_dispatch"] } }));
    const a = w.land();
    const id = w.proof(a, { jobNames: [`Gate ${a}`] });
    post(w, a, { targetUrl: runUrl(id) });
    expect((await w.ok()).decision).toMatchObject({ kind: "none", reason: expect.stringContaining("not a main run") });
  });
});

describe("manifest: a schema-1 qualification manifest", () => {
  const MANIFEST = { schema: 1, required: [entry()] };

  test("`$` keys are annotations, at the top level and in entries; other unknown keys still refuse", () => {
    expect(parseQualificationManifest({ ...MANIFEST, $comment: "x", $notes: { any: ["json"] }, required: [{ ...entry(), $classification: { Test: "why" } }] })).not.toBeNull();
    expect(parseQualificationManifest({ ...MANIFEST, notes: "x" })).toBeNull();
    expect(parseQualificationManifest({ ...MANIFEST, required: [{ ...entry(), classification: {} }] })).toBeNull();
  });

  test("a manifest with no `when: always` entry is refused, raising an alert", async () => {
    expect(parseQualificationManifest({ schema: 1, required: [entry({ when: "if_triggered" })] })).toBeNull();
    const w = new ReleaseWorld();
    const a = w.land();
    w.manifestAt(a, JSON.stringify({ schema: 1, required: [entry({ when: "if_triggered" })] }));
    w.qualified(a);
    expect((await w.ok()).decision).toMatchObject({ kind: "alert", reason: expect.stringContaining("has no when: always entry") });
  });

  test("reevaluate refuses a success that cites no run, whatever the parser let through", () => {
    const m = { schema: 1, required: [entry({ when: "if_triggered" })] };
    expect(reevaluate(m, sha("a"), 1, [], {})).toEqual({ ok: false, reason: "re-evaluation cites no run (zero evidence)" });
  });

  test("without proof, the re-evaluation alone decides", async () => {
    const w = world({ provider: "manifest", source: "target", path: ".github/qualification.json", proof: null });
    const a = w.land();
    w.ci(a);
    expect((await w.ok()).outcome).toBe("advanced");
    expect(w.state().history.at(-1)!.receipt!.proofRun).toBeNull();
  });

  test("source: control reads the manifest from the control repo, versioned by its blob sha", async () => {
    const q: Qualification = { provider: "manifest", source: "control", path: "policy/qualification.json", proof: null };
    const w = world(q);
    const a = w.land();
    w.ci(a);
    const text = JSON.stringify(MANIFEST);
    const read: string[] = [];
    const d = await discoverRelease(w.target, w.cfg, (p) => (read.push(p), p === "policy/qualification.json" ? text : null));
    expect(read).toEqual(["policy/qualification.json"]);
    expect(d.decision).toMatchObject({ kind: "advance", to: a, receipt: { policyBlob: blobSha(text) } });
    expect(w.target.calls.some((c) => c.startsWith("getDataFile"))).toBe(false);
    const missing = await discoverRelease(w.target, w.cfg, () => null);
    expect(missing.decision).toMatchObject({ kind: "alert" });
  });

  test("blobSha is git's blob id", () => {
    expect(blobSha("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("release qualification config (§1.4)", () => {
  const file = readFileSync(CONFIG_PATH, "utf8");
  const block = /^ {2}qualification:\n(?: {4}.*\n)+/m;
  const withQualification = (yaml: string) => {
    const out = file.replace(block, yaml);
    if (out === file) throw new Error("edit did not apply");
    return out;
  };
  const problems = (text: string) => {
    try {
      parseConfig(text);
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      return (e as ConfigError).problems.join("\n");
    }
    throw new Error("expected the config to be refused");
  };
  const commitStatus = (extra = "") => `  qualification:\n    provider: commit-status\n    commitStatus:\n      context: ci/verified\n      creators:\n        - 777\n${extra}`;

  test("release.enabled defaults to false, and a disabled release job reads nothing", async () => {
    const off = parseConfig(file.replace(/^ {2}enabled: true.*\n/m, "")).release;
    expect(off.enabled).toBe(false);
    const r = await runReleaseDry({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: off.names.control.id } }, () => Promise.reject(new Error("must not connect")), off);
    expect(r).toEqual({ mode: "dry-run", log: ["release advance is not enabled (release.enabled)"], decision: null });
  });

  test("checks-green without a block is a copy of queue.preLanding", () => {
    const l = parseConfig(withQualification("  qualification:\n    provider: checks-green\n"));
    expect(l.release.qualification).toEqual({ provider: "checks-green", required: l.config.preLanding });
  });

  test("commit-status loads with its defaults", () => {
    expect(parseConfig(withQualification(commitStatus())).release.qualification).toEqual({
      provider: "commit-status",
      context: "ci/verified",
      creators: [777],
      producerWorkflow: null,
      targetUrl: null,
      proof: null,
    });
  });

  const cases: [string, string, RegExp][] = [
    ["an unknown provider", withQualification("  qualification:\n    provider: vibes\n"), /provider: must be one of/],
    ["another provider's block", withQualification("  qualification:\n    provider: checks-green\n    commitStatus:\n      context: x\n      creators:\n        - 1\n"), /commitStatus is set, but the provider is checks-green/],
    ["manifest without its block", withQualification("  qualification:\n    provider: manifest\n"), /manifest is required for provider manifest/],
    ["commit-status without its block", withQualification("  qualification:\n    provider: commit-status\n"), /commitStatus is required for provider commit-status/],
    ["commit-status with no creators", withQualification("  qualification:\n    provider: commit-status\n    commitStatus:\n      context: x\n      creators: []\n"), /creators: needs at least 1 item/],
    ["github-actions[bot] as creator without producerWorkflow", withQualification(commitStatus("        - 41898282\n")), /producerWorkflow is required when creators includes github-actions\[bot\]/],
    ["a creator listed twice", withQualification(commitStatus("        - 777\n")), /creators lists an account twice/],
    [
      "a producer workflow outside the policy paths",
      withQualification(commitStatus("      producerWorkflow: .github/workflows/status.yml\n")).replace("      - .github/**\n", "      - .github/workflows/ci.yml\n"),
      /does not cover \.github\/workflows\/status\.yml \(release\.qualification\.commitStatus\.producerWorkflow\)/,
    ],
    ["a commit-status proof template without {sha}", withQualification(commitStatus("      proof:\n        workflow: .github/workflows/p.yml\n        jobTemplate: Gate\n")), /commitStatus\.proof\.jobTemplate must contain \{sha\}/],
    ["checks-green with no `when: always` entry", withQualification("  qualification:\n    provider: checks-green\n    checksGreen:\n      required:\n        - path: .github/workflows/ci.yml\n          name: CI\n          when: if_triggered\n          required_jobs: []\n          allow_skipped_jobs: {}\n"), /checksGreen\.required needs at least one entry with when: always/],
    ...["../elsewhere.json", ".github/../policy/q.json", ".github/%2e%2e/policy/q.json", "/etc/q.json", "a//b.json", "./q.json"].flatMap((path): [string, string, RegExp][] =>
      ["control", "target"].map((source) => [
        `a non-canonical ${source} manifest path (${path})`,
        withQualification(`  qualification:\n    provider: manifest\n    manifest:\n      source: ${source}\n      path: "${path}"\n`),
        /manifest\.path: must match/,
      ]),
    ),
    ["a pull_request proof event", withQualification(commitStatus("      proof:\n        workflow: .github/workflows/p.yml\n        events:\n          - pull_request\n")), /events\[0\]: must be one of/],
  ];
  for (const [name, text, want] of cases) test(name, () => expect(problems(text)).toMatch(want));

  test("a control-hosted manifest is not a target gate; a target-hosted one is, so a target PR editing it is a policy PR", () => {
    const control = withQualification("  qualification:\n    provider: manifest\n    manifest:\n      source: control\n      path: policy/q.json\n").replace("      - .github/**\n", "      - .github/workflows/**\n      - .github/actions/**\n");
    expect(() => parseConfig(control)).not.toThrow();
    const l = parseConfig(file);
    const q = l.release.qualification;
    if (q.provider !== "manifest") throw new Error("expected the manifest provider");
    expect(isPolicyChange([q.path], l.config.policyBoundary)).toBe(true);
    expect(isPolicyChange(["src/app.ts"], l.config.policyBoundary)).toBe(false);
  });
});
