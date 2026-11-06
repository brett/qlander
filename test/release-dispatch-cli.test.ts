// `qlander approve-release <sha>` (DESIGN.md §8.1): it posts the comment the
// release job looks for on the status issue, and refuses, changing nothing,
// whatever the job would refuse.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseControlArgs } from "../src/control-cli";
import { emptyReleaseState, type DispatchCandidate, type ReleaseState } from "../src/release-state";
import { ControlWorld, ME, STATUS } from "./control-fake";
import { EXAMPLE } from "./setup-world";
import { sha } from "./sim";

const A = sha("candidate");

/** The example config in dispatch mode, with the operator (ME) as the only release approver. */
function dispatchConfig(): string {
  const base = readFileSync(EXAMPLE, "utf8");
  const block = [
    "  mode: dispatch",
    "  dispatch:",
    "    workflow: .github/workflows/promote.yml",
    "    inputs:",
    "      sha: sha",
    "      dryRun: dry_run",
    "      dispatchId: dispatch_id",
    "    actor:",
    "      login: example-release[bot]",
    "      id: 90000001",
    "    approvers:",
    `      - login: ${ME.login}`,
    `        id: ${ME.id}`,
  ].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "qlander-dispatch-cli-"));
  const path = join(dir, "qlander.yml");
  writeFileSync(path, base.replace(/\nwatchdog:/, `\n${block}\n\nwatchdog:`));
  return path;
}

function candidate(over: Partial<DispatchCandidate> = {}): DispatchCandidate {
  const at = "2026-10-22T12:00:00.000Z";
  return {
    sha: A,
    receipt: { from: sha("release"), to: A, policyBlob: sha("blob"), proofRun: null, evidence: [] },
    since: at,
    dry: { kind: "dry", id: `qlr-dry-${A.slice(0, 12)}-000000000000`, at, sent: "yes", run: { id: 9, url: "https://github.com/x/actions/runs/9", createdAt: at }, conclusion: "success", concludedAt: at },
    reported: null,
    approval: null,
    real: null,
    refused: 0,
    rearm: null,
    ...over,
  };
}

function world(c: DispatchCandidate | null = candidate(), configPath = dispatchConfig()): ControlWorld {
  const s: ReleaseState = { ...emptyReleaseState(), dispatch: { candidate: c, highWater: c?.dry ? c.sha : null, last: c?.dry ? { sha: c.sha, id: c.dry.id, closedAt: null } : null, window: [], history: [] } };
  const w = new ControlWorld(undefined, s);
  w.configPath = configPath;
  return w;
}

describe("approve-release", () => {
  test("parses exactly one full sha", () => {
    const p = (args: string[]) => parseControlArgs("approve-release", args, "q.yml", (x) => x);
    expect(p([A]).positional).toEqual([A]);
    for (const bad of [[], ["abc"], [A, A], [A.toUpperCase()]]) expect(() => p(bad)).toThrow("approve-release needs");
  });

  test("posts the approval on the status issue, as a listed approver, for the candidate with a green dry run", async () => {
    const w = world();
    const r = await w.run("approve-release", [A]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(w.writes()[0]).toBe(`comment #${w.status.number}`);
    expect(w.status.comments).toContain(`/qlander approve-release ${A}`);
  });

  test("--dry-run posts nothing", async () => {
    const w = world();
    expect((await w.run("approve-release", [A, "--dry-run"])).out).toContain(`would: comment on #${w.status.number}: /qlander approve-release ${A}`);
    expect(w.writes()).toEqual([]);
  });

  test.each([
    ["another sha", candidate(), sha("other"), "that exact sha only"],
    ["no candidate", null, A, "no candidate"],
    ["a dry run still in flight", candidate({ dry: { ...candidate().dry!, conclusion: null, concludedAt: null } }), A, "not green yet"],
    ["a red dry run", candidate({ dry: { ...candidate().dry!, conclusion: "failure" } }), A, "not green yet"],
  ] as const)("refuses %s, changing nothing", async (_, c, s, msg) => {
    const w = world(c);
    const r = await w.run("approve-release", [s]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
    expect(w.writes()).toEqual([]);
  });

  test("refuses an operator who is not a release approver, and a config not in dispatch mode", async () => {
    const w = world();
    w.me = { login: `${ME.login}-other`, id: ME.id + 1 };
    expect((await w.run("approve-release", [A])).err).toContain("not on release.dispatch.approvers");
    const v = world(candidate(), EXAMPLE);
    expect((await v.run("approve-release", [A])).err).toContain("release.mode is not dispatch");
    expect([...w.writes(), ...v.writes()]).toEqual([]);
  });

  test("refuses when there is no open status issue", async () => {
    const w = world();
    w.status.open = false;
    expect((await w.run("approve-release", [A])).err).toContain(`no open ${STATUS} issue`);
  });
});

describe("rearm-release", () => {
  const INCIDENT = `qlr-real-${A.slice(0, 12)}-111111111111`;
  function ended(over: Partial<{ sha: string; closedAt: string | null; candidate: DispatchCandidate | null }> = {}): ControlWorld {
    const s: ReleaseState = {
      ...emptyReleaseState(),
      dispatch: { candidate: over.candidate ?? null, highWater: over.sha ?? A, last: { sha: over.sha ?? A, id: INCIDENT, closedAt: over.closedAt === undefined ? "2026-10-22T12:30:00.000Z" : over.closedAt }, window: [], history: [] },
    };
    const w = new ControlWorld(undefined, s);
    w.configPath = dispatchConfig();
    return w;
  }

  test("posts the re-arm bound to the last attempt's dispatch id, as a release approver", async () => {
    const w = ended();
    const r = await w.run("rearm-release", [A]);
    expect(r.err).toBe("");
    expect(w.status.comments).toContain(`/qlander rearm-release ${A} ${INCIDENT}`);
  });

  test.each([
    ["another sha", ended(), sha("other"), "only it can be re-armed"],
    ["an open candidate", ended({ candidate: candidate() }), A, "is the open candidate"],
    ["an attempt that has not ended", ended({ closedAt: null }), A, "has not ended yet"],
  ] as const)("refuses %s, changing nothing", async (_, w, s, msg) => {
    const r = await w.run("rearm-release", [s]);
    expect(r.code).toBe(1);
    expect(r.err).toContain(msg);
    expect(w.writes()).toEqual([]);
  });

  test("refuses an operator who is not a release approver", async () => {
    const w = ended();
    w.me = { login: `${ME.login}-other`, id: ME.id + 1 };
    expect((await w.run("rearm-release", [A])).err).toContain("not on release.dispatch.approvers");
  });
});
