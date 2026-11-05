// Operator controls (src/control.ts, src/control-cli.ts,
// src/github/control-client.ts) against the fake GitHub (test/control-fake.ts):
// pause and resume, the quiesce procedure and its refusals, unquiesce, the
// PR label controls, the policy approval, every --dry-run, the status-issue
// log, and the real client's requests and refusals.

import { describe, expect, test } from "bun:test";
import { CONFIG_PATH } from "../src/config/load";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENABLE_SETTLE_MS, OPERATOR_MARKER, QUEUE_NEVER_WROTE, RELEASE_NEVER_WROTE, tickOutcome } from "../src/control";
import { controlCommand, parseControlArgs } from "../src/control-cli";
import type { ControlCommand } from "../src/control-usage";
import { connectControl } from "../src/github/control-client";
import { CONTROL_BRANCH, QUEUE_JOB_NAME } from "../src/job-names";
import { emptyReleaseState } from "../src/release-state";
import { ACTIVE, ControlWorld as World, ME, PAUSE, RPAUSE, STATUS, withState } from "./control-fake";
import { APPROVERS, NAMES, sha } from "./sim";
import { ago, NOW, run, WAITING } from "./watchdog-fake";

const VERIFY = [{ pr: 9, pin: sha("h9"), landedIn: sha("m9"), since: ago(3), ticks: 0, notified: false }];

describe("arguments", () => {
  test("each command's arguments are checked; usage errors exit 2 before any connection", async () => {
    const p = (c: ControlCommand, a: string[]) => parseControlArgs(c, a, "cfg", (x) => `/abs/${x}`);
    expect(p("pause", ["both", "--dry-run"])).toEqual({ positional: ["both"], dryRun: true, all: false, config: "cfg" });
    expect(p("resume", ["queue", "--all", "--config", "x.yml"])).toEqual({ positional: ["queue"], dryRun: false, all: true, config: "/abs/x.yml" });
    for (const [c, a] of [
      ["pause", ["everything"]],
      ["pause", ["queue", "--all"]],
      ["quiesce", ["now"]],
      ["remove", ["0"]],
      ["requeue", ["12", "13"]],
      ["approve-policy", ["12", "abc"]],
      ["approve-policy", ["12", sha("h").toUpperCase()]],
    ] as [ControlCommand, string[]][])
      expect(() => p(c, a)).toThrow();
    expect(p("approve-policy", ["12", sha("h")]).positional).toEqual(["12", sha("h")]);
    const w = new World();
    let connected = false;
    const r = await controlCommand("quiesce", ["--bogus"], { out: () => {}, err: () => {} }, { env: { GH_TOKEN: "t" }, connect: async () => ((connected = true), w.api()) }, CONFIG_PATH, (x) => x);
    expect(r).toBe(2);
    expect(connected).toBe(false);
  });

  test("a missing token exits 1 and names the operator's own token", async () => {
    const r = await new World().run("pause", ["queue"], {});
    expect(r.code).toBe(1);
    expect(r.err).toContain("operator's own token");
  });

  test("bun src/cli.ts routes the controls and lists them", async () => {
    const { main, USAGE } = await import("../src/cli");
    for (const c of ["pause queue|release|both", "quiesce", "unquiesce", "remove|requeue|prioritise <pr>", "approve-policy <pr> <sha>", "--dry-run"]) expect(USAGE).toContain(c);
    const io = { out: () => {}, err: () => {}, read: () => null, write: () => {} };
    expect(await main(["unquiesce", "extra"], io, {})).toBe(2);
    expect(await main(["requeue", "5"], io, {})).toBe(1); // no token
  });
});

describe("pause and resume", () => {
  test("pause both opens one marked issue per job, once; a change is logged on the status issue", async () => {
    const w = new World();
    const r = await w.run("pause", ["both"]);
    expect(r.code).toBe(0);
    expect(w.open(PAUSE)).toHaveLength(1);
    expect(w.open(RPAUSE)).toHaveLength(1);
    expect(w.open(PAUSE)[0]!.body).toContain(OPERATOR_MARKER);
    expect(w.open(PAUSE)[0]!.title).toContain(ME.login);
    expect(w.status.comments).toHaveLength(1);
    expect(w.status.comments[0]).toContain(`by ${ME.login}`);
    expect(w.status.comments[0]).toContain("`pause both`");
    const again = await w.run("pause", ["queue"]);
    expect(again.code).toBe(0);
    expect(again.out).toContain("already open");
    expect(w.open(PAUSE)).toHaveLength(1);
    expect(w.status.comments).toHaveLength(1); // nothing changed, nothing logged
  });

  test("resume closes only the issues a control opened, names the rest, and --all closes them too", async () => {
    const w = new World();
    await w.run("pause", ["queue"]);
    const other = w.repo.seed("qlander paused: main is red", [PAUSE], 30);
    const r = await w.run("resume", ["queue"]);
    expect(r.code).toBe(0);
    expect(w.open(PAUSE).map((i) => i.number)).toEqual([other.number]);
    expect(r.out).toContain(`still paused by: #${other.number}`);
    await w.run("resume", ["queue", "--all"]);
    expect(w.open(PAUSE)).toEqual([]);
  });

  test("an incomplete listing closes nothing", async () => {
    const w = new World();
    await w.run("pause", ["queue"]);
    w.repo.incomplete.add(PAUSE);
    w.log = [];
    const r = await w.run("resume", ["queue"]);
    expect(r.code).toBe(1);
    expect(w.writes()).toEqual([]);
  });

  test("dry runs change nothing", async () => {
    const w = new World();
    const r = await w.run("pause", ["both", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`would: open a ${PAUSE} issue`);
    w.repo.seed("held", [PAUSE], 5, OPERATOR_MARKER);
    const s = await w.run("resume", ["both", "--dry-run"]);
    expect(s.out).toContain(`would: close ${PAUSE} issue`);
    expect(w.log).toEqual([]);
    expect(w.open(PAUSE)).toHaveLength(1);
  });
});

describe("quiesce (docs/deployment.md §8.1)", () => {
  test("pauses both jobs, disables tick.yml, waits out a running tick, counts a ghost as gone, checks the state and prints both commits", async () => {
    const w = new World();
    const running = run({ status: "in_progress", conclusion: null, createdAt: ago(1) }, { status: "in_progress", conclusion: null, completedAt: null });
    const ghost = run({ status: "queued", conclusion: null, createdAt: ago(3) }, null, null);
    w.repo.runs.push(running, ghost);
    w.onSleep = () => {
      running.status = "completed";
      running.conclusion = "success";
    };
    const r = await w.run("quiesce");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(w.writes()).toEqual([`create ${PAUSE}`, `create ${RPAUSE}`, "disable", `comment #${w.status.number}`]);
    expect(w.log.filter((l) => l.startsWith("sleep"))).toHaveLength(2); // idle is taken only from two quiet passes in a row
    expect(r.out).toContain(`run ${ghost.id} is a ghost`);
    expect(r.out).toContain(`${NAMES.stateBranch} ${sha("queue-v")}`);
    expect(r.out).toContain(`${NAMES.releaseStateBranch} ${sha("release-v")}`);
    expect(w.status.comments[0]).toContain(sha("queue-v"));
  });

  test("refuses while a batch is active, running or pending, before changing anything", async () => {
    for (const s of [withState({ active: ACTIVE }), withState({ pending: [{ prs: [3, 4], depth: 1, lineage: 2 }] }), withState({ active: ACTIVE, concurrent: [{ ...ACTIVE, n: 8, prs: [13], lineage: 2, base: ACTIVE.head, head: sha("q8") }] })]) {
      const w = new World(s);
      const r = await w.run("quiesce");
      expect(r.code).toBe(1);
      expect(r.err).toContain("A paused queue does not land them");
      expect(r.err).toContain("Nothing was changed");
      expect(w.log).toEqual([]);
    }
  });

  test("refuses, naming every part of the state that is not idle, and leaves both jobs paused", async () => {
    const q = withState({ verify: VERIFY, outbox: [{ id: "n1", kind: "unready", pr: 9 }], lease: { owner: "run-1", until: ago(-5), acquiredAt: ago(1), executor: null } });
    const w = new World();
    // A tick changed the state between the pre-check and step 4.
    const read = w.queueRef.read.bind(w.queueRef);
    let reads = 0;
    w.queueRef.read = async () => (++reads === 2 ? { version: sha("queue-v2"), text: JSON.stringify(q), serverTime: NOW } : read());
    const readRelease = w.releaseRef.read.bind(w.releaseRef);
    let releaseReads = 0;
    w.releaseRef.read = async () => (++releaseReads === 2 ? { version: sha("release-v2"), text: JSON.stringify({ ...emptyReleaseState(), pausePending: { id: "p", reason: "corrupt" } }), serverTime: NOW } : readRelease());
    const r = await w.run("quiesce");
    expect(r.code).toBe(1);
    for (const what of ["verify holds 1", "outbox holds 1", "the lease is held by run-1", `${NAMES.releaseStateBranch}: a release pause is pending`, "run `unquiesce` to go back"]) expect(r.err).toContain(what);
    expect(w.open(PAUSE)).toHaveLength(1);
    expect(w.open(RPAUSE)).toHaveLength(1);
    expect(w.repo.state).toBe("disabled_manually");
    expect(w.status.comments[0]).toContain("refused");
  });

  test("solo work refuses before anything changes", async () => {
    const w = new World(withState({ solo: [{ pr: 14, lineage: 3, reason: "policy" }], lineages: { "3": { runs: 0 } }, auth: { "14": { head: sha("h14"), baseRepoId: NAMES.target.id, policy: "p", policyPr: true, admittedAt: ago(9), labelledAt: ago(10), evidence: [], reviewRun: null } } }));
    const r = await w.run("quiesce");
    expect(r.err).toContain("wait to run alone (14)");
    expect(w.log).toEqual([]);
  });

  test("a queue that never ran live has nothing in flight: an absent state branch quiesces cleanly", async () => {
    const w = new World();
    w.queueRef.current = null;
    const r = await w.run("quiesce");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${NAMES.stateBranch} ${QUEUE_NEVER_WROTE}`);
    expect(r.out).toContain("quiesced");
    expect(w.open(PAUSE)).toHaveLength(1);
    expect(w.repo.state).toBe("disabled_manually");
    const dry = new World();
    dry.queueRef.current = null;
    expect((await dry.run("quiesce", ["--dry-run"])).code).toBe(0);
  });

  test("an absent queue state that something says should exist still refuses: an open or unlisted mirror issue changes nothing", async () => {
    const MIRROR = NAMES.controlLabels.mirror;
    const mirror = new World();
    mirror.queueRef.current = null;
    const m = mirror.repo.seed("state", [MIRROR], 60);
    const r = await mirror.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${NAMES.stateBranch}: absent, but state issue #${m.number} is open`);
    expect(mirror.log).toEqual([]);
    const unlisted = new World();
    unlisted.queueRef.current = null;
    unlisted.repo.incomplete.add(MIRROR);
    const u = await unlisted.run("quiesce");
    expect(u.code).toBe(1);
    expect(u.err).toContain("could not all be listed");
    expect(unlisted.log).toEqual([]);
  });

  test("a queue state branch there when the command started and gone at step 4 refuses, and leaves both jobs paused", async () => {
    const w = new World();
    const read = w.queueRef.read.bind(w.queueRef);
    let reads = 0;
    w.queueRef.read = async () => (++reads >= 2 ? null : read());
    const r = await w.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`${NAMES.stateBranch}: it was there at the pre-check and is gone now`);
    expect(r.err).toContain("run `unquiesce` to go back");
    expect(r.out).not.toContain(QUEUE_NEVER_WROTE);
    expect(w.open(PAUSE)).toHaveLength(1);
  });

  test("the pre-check refuses, changing nothing, for whatever step 4 would refuse and no running tick clears", async () => {
    const until = ago(-20);
    const cancel = { id: "x:7", kind: "cancelRuns" as const, ref: "queue/7", head: sha("q7"), until, giveUpAt: ago(-300) };
    const lapsed = { owner: "run-1", until: ago(1), acquiredAt: ago(9), executor: null };
    const journal = { seq: 1, op: { kind: "build" as const, n: 7, base: sha("b"), pins: [{ pr: 14, head: sha("h14") }], depth: 0, lineage: 1, source: { kind: "candidates" as const }, rebuild: false }, reserved: true, at: ago(5), checkpoint: null, tries: 0 };
    for (const [state, what] of [
      [{ verify: VERIFY }, "verify holds 1"],
      [{ outbox: [cancel] }, `cancelRuns once its runs have stopped: queue/7 until ${until}`],
      [{ lease: lapsed }, "the lease is held by run-1"],
      [{ journal, lineages: { "1": { runs: 0 } }, auth: { "14": { head: sha("h14"), baseRepoId: NAMES.target.id, policy: "p", policyPr: false, admittedAt: ago(9), labelledAt: ago(10), evidence: [], reviewRun: null } } }, "journal is not null"],
    ] as [Parameters<typeof withState>[0], string][]) {
      const w = new World(withState(state));
      w.queueRef.clock = () => NOW;
      const r = await w.run("quiesce");
      expect(r.code).toBe(1);
      expect(r.err).toContain(what);
      expect(r.err).toContain("Nothing was changed");
      expect(r.err).toContain("`resume both`");
      expect(w.log).toEqual([]);
      expect(w.open(PAUSE)).toEqual([]);
      expect(w.repo.state).toBe("active");
    }
    const pausing = new World();
    pausing.releaseRef.current = { version: sha("release-v"), text: JSON.stringify({ ...emptyReleaseState(), pausePending: { id: "p", reason: "corrupt" } }) };
    expect((await pausing.run("quiesce")).err).toContain("a release pause is pending");
    expect(pausing.log).toEqual([]);
    const corrupt = new World();
    corrupt.releaseRef.current = { version: sha("release-v"), text: "{" };
    expect((await corrupt.run("quiesce")).code).toBe(1);
    expect(corrupt.log).toEqual([]);
  });

  test("the pre-check waits out a running tick's lease and journal; the later check still judges them", async () => {
    const held = withState({ lease: { owner: "run-1", until: ago(-5), acquiredAt: ago(1), executor: null } });
    const w = new World(held);
    const r = await w.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("the lease is held by run-1");
    expect(w.open(PAUSE)).toHaveLength(1); // past the pre-check: the tick was given its chance to finish
    const clears = new World(held);
    const read = clears.queueRef.read.bind(clears.queueRef);
    let reads = 0;
    clears.queueRef.read = async () => (++reads === 2 ? { version: sha("queue-v2"), text: JSON.stringify(withState({})), serverTime: NOW } : read());
    expect((await clears.run("quiesce")).code).toBe(0);
  });

  test("a release job that may write state and has none refuses before anything changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "control-release-pre-"));
    try {
      const text = readFileSync(CONFIG_PATH, "utf8").replace(/\n {2}enabled: false/, "\n  enabled: true").replace(/\n {2}dryRun: true/, "\n  dryRun: false");
      const path = join(dir, "live.yml");
      writeFileSync(path, text);
      const w = new World();
      w.configPath = path;
      w.releaseRef.current = null;
      const r = await w.run("quiesce");
      expect(r.code).toBe(1);
      expect(w.log).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failure before tick.yml is disabled names `resume both`, and one after it `unquiesce`", async () => {
    const w = new World();
    const connect = w.api.bind(w);
    w.api = () => ({ ...connect(), setTickEnabled: async () => { throw new Error("no access"); } });
    const r = await w.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no access");
    expect(r.err).toContain("run `resume both` to go back");
    expect(r.err).not.toContain("unquiesce");
  });

  test("an absent release state branch is idle while the release job is off or held in dry run, and refuses once it is live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "control-release-"));
    const text = readFileSync(CONFIG_PATH, "utf8");
    const release = text.indexOf("\nrelease:\n");
    expect(release).toBeGreaterThan(0);
    /** The control repo's config with one key of its release block set. */
    const set = (key: string, value: boolean, base = text) => {
      const m = new RegExp(`\\n  ${key}: (true|false)`).exec(base.slice(release))!;
      const at = release + m.index;
      return `${base.slice(0, at)}\n  ${key}: ${value}${base.slice(at + m[0].length)}`;
    };
    const live = set("enabled", true, set("dryRun", false));
    const configs = { dryRun: set("dryRun", true, live), disabled: set("enabled", false, live), live };
    try {
      for (const [name, body] of Object.entries(configs)) {
        const path = join(dir, `${name}.yml`);
        writeFileSync(path, body);
        const w = new World();
        w.configPath = path;
        w.releaseRef.current = null;
        const r = await w.run("quiesce");
        if (name === "live") {
          expect(r.code).toBe(1);
          expect(r.err).toContain(`${NAMES.releaseStateBranch}: absent, so there is no commit to roll back to`);
        } else {
          expect(r.err).toBe("");
          expect(r.code).toBe(0);
          expect(r.out).toContain(`${NAMES.releaseStateBranch} ${RELEASE_NEVER_WROTE}`);
          expect(r.out).toContain("quiesced");
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent release state that held state once refuses even in dry run: a mirror issue open or unlisted, or the branch gone since the pre-check", async () => {
    const MIRROR = NAMES.releaseLabels.mirror;
    const mirror = new World();
    mirror.releaseRef.current = null;
    const m = mirror.repo.seed("release state", [MIRROR], 60);
    expect((await mirror.run("quiesce")).err).toContain(`release state issue #${m.number} is open`);
    const unlisted = new World();
    unlisted.releaseRef.current = null;
    unlisted.repo.incomplete.add(MIRROR);
    expect((await unlisted.run("quiesce")).err).toContain("could not all be listed");
    const vanished = new World();
    const read = vanished.releaseRef.read.bind(vanished.releaseRef);
    let reads = 0;
    vanished.releaseRef.read = async () => (++reads >= 2 ? null : read());
    const r = await vanished.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("it was there at the pre-check and is gone now");
    expect(r.out).not.toContain("never written");
  });

  test("the status-issue log never carries the token, whatever an error quotes back", async () => {
    const token = "ghp_operatorSECRET123";
    const w = new World();
    const api = w.api();
    w.api = () => ({ ...api, setTickEnabled: async () => Promise.reject(new Error(`auth (401): Bearer ${token} rejected`)) });
    const r = await w.run("quiesce", [], { GH_TOKEN: token });
    expect(r.code).toBe(1);
    expect(w.status.comments).toHaveLength(1);
    expect(w.status.comments[0]).toContain("[token]");
    expect(w.status.comments[0]).not.toContain(token);
    expect(r.err).not.toContain(token);
  });

  test("refuses when a tick run does not finish in time, naming it", async () => {
    const w = new World();
    const stuck = run({ status: "queued", conclusion: null, createdAt: ago(1) }, WAITING);
    w.repo.runs.push(stuck);
    const r = await w.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("timed out");
    expect(r.err).toContain(`still running: ${stuck.id} queued`);
  });

  test("a run the per-status listings miss (it changed status between them) still counts", async () => {
    const w = new World();
    const moving = run({ status: "in_progress", conclusion: null, createdAt: ago(1) }, { status: "in_progress", conclusion: null, completedAt: null });
    w.repo.runs.push(moving);
    const api = w.api();
    w.api = () => ({ ...api, listUnfinishedRuns: async () => ({ runs: [], truncated: false }) });
    const r = await w.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`still running: ${moving.id} in_progress`);
  });

  test("an unreadable run listing is never taken for no runs", async () => {
    const w = new World();
    w.repo.unfinishedTruncated = true;
    const r = await w.run("quiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("the runs could not all be listed");
  });

  test("an already disabled tick.yml is left as it is", async () => {
    const w = new World();
    w.repo.state = "disabled_manually";
    expect((await w.run("quiesce")).code).toBe(0);
    expect(w.writes()).not.toContain("disable");
  });

  test("--dry-run reads and prints every step, changing nothing; it still refuses under an active batch", async () => {
    const w = new World(withState({ verify: VERIFY }));
    const r = await w.run("quiesce", ["--dry-run"]);
    expect(r.code).toBe(1); // the pre-check: a real run would refuse too
    expect(r.err).toContain("verify holds 1");
    expect(w.log).toEqual([]);
    const idle = new World();
    const ok = await idle.run("quiesce", ["--dry-run"]);
    expect(ok.code).toBe(0);
    for (const s of [`would: open a ${PAUSE} issue`, `would: open a ${RPAUSE} issue`, "would: disable tick.yml", "would: wait", "idle", sha("queue-v")]) expect(ok.out).toContain(s);
    expect(idle.log).toEqual([]);
    const running = new World(withState({ lease: { owner: "run-1", until: ago(-5), acquiredAt: ago(1), executor: null } }));
    const busy = await running.run("quiesce", ["--dry-run"]);
    expect(busy.out).toContain("not idle now:");
    expect(busy.out).toContain(sha("queue-v")); // every step still printed
    expect(busy.code).toBe(1);
    expect(busy.err).toContain("Nothing was changed");
    expect(running.log).toEqual([]);
    expect((await new World(withState({ active: ACTIVE })).run("quiesce", ["--dry-run"])).code).toBe(1);
  });
});

describe("unquiesce", () => {
  const quiesced = async () => {
    const w = new World();
    expect((await w.run("quiesce")).code).toBe(0);
    w.log = [];
    return w;
  };

  test("in dry-run mode it reads what the tick read of the pause issues, and succeeds", async () => {
    const w = await quiesced();
    w.tickMode = "dry-run";
    const r = await w.run("unquiesce");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    expect(r.out).toContain("outcome: paused");
    expect(r.out).toContain("outcome: dry-run");
    expect(r.out).toContain("unquiesced");
    expect(w.open(PAUSE)).toEqual([]);
  });

  test("a dry-run tick that did not read a pause, or does not say, still refuses, and names the way out", async () => {
    const said = await quiesced();
    said.tickMode = "dry-run";
    const dispatch = said.api.bind(said);
    said.api = () => {
      const a = dispatch();
      return {
        ...a,
        async dispatchTick() {
          const open = said.open(PAUSE);
          for (const i of open) i.open = false;
          await a.dispatchTick();
          for (const i of open) i.open = true;
        },
      };
    };
    const r = await said.run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("outcome dry-run");
    expect(r.err).toContain("`resume both`");
    expect(said.open(PAUSE)).toHaveLength(1);

    const unsaid = await quiesced();
    unsaid.tickMode = "dry-run-unsaid";
    const u = await unsaid.run("unquiesce");
    expect(u.code).toBe(1);
    expect(u.err).toContain("outcome unknown");
    expect(unsaid.open(PAUSE)).toHaveLength(1);
  });

  test("tickOutcome: a live report's outcome, never a dry-run field; a dry-run report's paused, never a stray outcome", () => {
    expect(tickOutcome({ outcome: "paused" })).toBe("paused");
    expect(tickOutcome({ paused: true })).toBe(null); // not a dry-run report: the live check is not weakened
    expect(tickOutcome({ mode: "dry-run", paused: true })).toBe("paused");
    expect(tickOutcome({ mode: "dry-run", paused: false })).toBe("dry-run");
    expect(tickOutcome({ mode: "dry-run", outcome: "paused" })).toBe(null);
    expect(tickOutcome({ mode: "dry-run", refused: "x" })).toBe(null);
    expect(tickOutcome(null)).toBe(null);
  });

  test("with no pause issue open it names what is left to do", async () => {
    const r = await new World().run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("`resume both`");
    expect(r.err).toContain("gh workflow enable tick.yml");
  });

  test("a live tick that fails says the queue is running and how to stop it", async () => {
    const w = await quiesced();
    w.liveConclusion = "failure";
    const r = await w.run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("the queue is running");
    expect(r.err).toContain("`pause both`");
  });

  test("enables tick.yml, waits before dispatching, checks a paused tick, closes both issues, checks a live tick", async () => {
    const w = await quiesced();
    const r = await w.run("unquiesce");
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const [q, rel] = [PAUSE, RPAUSE].map((l) => w.repo.issues.find((i) => i.labels.includes(l))!.number);
    expect(w.writes()).toEqual(["enable", "dispatch", `close #${rel}`, `close #${q}`, "dispatch", `comment #${w.status.number}`]);
    expect(w.log.slice(0, 3)).toEqual(["enable", `sleep ${ENABLE_SETTLE_MS}`, "dispatch"]);
    expect(r.out).toContain("outcome: paused");
    expect(r.out).toContain("outcome: idle");
    expect(w.open(PAUSE)).toEqual([]);
    expect(w.open(RPAUSE)).toEqual([]);
    expect(w.repo.state).toBe("active");
    const dispatched = w.repo.runs.filter((x) => x.event === "workflow_dispatch");
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]!.branch).toBe(CONTROL_BRANCH);
    expect(dispatched[0]!.jobs![0]!.name).toBe(QUEUE_JOB_NAME);
  });

  test("refuses with nothing paused, before changing anything", async () => {
    const w = new World();
    w.repo.state = "disabled_manually";
    const r = await w.run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("is the queue quiesced?");
    expect(w.log).toEqual([]);
  });

  test("a dispatched tick that never starts keeps the pause issues open", async () => {
    const w = await quiesced();
    w.ghostDispatch = true;
    const r = await w.run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("timed out");
    expect(w.open(PAUSE)).toHaveLength(1);
    expect(w.open(RPAUSE)).toHaveLength(1);
  });

  test("a pause issue it did not open, on either job, stops it before anything changes; --all closes it", async () => {
    const w = await quiesced();
    const other = w.repo.seed("paused by hand", [RPAUSE], 5);
    const r = await w.run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`#${other.number} paused by hand`);
    expect(w.log).toEqual([]);
    expect(w.repo.state).toBe("disabled_manually");
    expect((await w.run("unquiesce", ["--all"])).code).toBe(0);
    expect(w.open(PAUSE)).toEqual([]);
    expect(w.open(RPAUSE)).toEqual([]);
  });

  test("a pause issue opened by hand during the paused tick stops it before closing anything", async () => {
    const w = await quiesced();
    const api = w.api();
    const dispatch = api.dispatchTick;
    w.api = () => ({ ...api, dispatchTick: async () => (await dispatch(), void w.repo.seed("mid-way", [RPAUSE], 0)) });
    const r = await w.run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("mid-way");
    expect(w.open(PAUSE)).toHaveLength(1);
  });

  test("refuses when it cannot tell which run its dispatch started", async () => {
    const w = await quiesced();
    const api = w.api();
    w.api = () => ({ ...api, dispatchTick: async () => (await api.dispatchTick(), await api.dispatchTick()) });
    const r = await w.run("unquiesce");
    expect(r.code).toBe(1);
    expect(r.err).toContain("which one this dispatch started is unknown");
    expect(w.open(PAUSE)).toHaveLength(1);
  });

  test("refuses when the live tick fails or still runs paused", async () => {
    const w = await quiesced();
    w.liveConclusion = "failure";
    expect((await w.run("unquiesce")).err).toContain("the live tick did not succeed");
    const v = await quiesced();
    v.liveOutcome = "paused";
    expect((await v.run("unquiesce")).err).toContain("the live tick did not succeed");
  });

  test("--dry-run prints the steps and changes nothing", async () => {
    const w = await quiesced();
    const r = await w.run("unquiesce", ["--dry-run"]);
    expect(r.code).toBe(0);
    for (const s of ["would: enable tick.yml", "would: dispatch a tick (it must run paused)", `would: close ${PAUSE} issue`, `would: close ${RPAUSE} issue`, "would: dispatch a tick (it must succeed"]) expect(r.out).toContain(s);
    expect(w.log).toEqual([]);
  });
});

describe("PR controls", () => {
  test("remove, requeue and prioritise put the configured label on the PR", async () => {
    const w = new World();
    w.target.addPr(21);
    w.target.addPr(22, { labels: [] });
    expect((await w.run("remove", ["21"])).code).toBe(0);
    expect((await w.run("requeue", ["22"])).code).toBe(0);
    expect((await w.run("prioritise", ["22"])).code).toBe(0);
    expect(w.writes().filter((l) => l.startsWith("label"))).toEqual([`label #21 ${NAMES.labels.bounce}`, `label #22 ${NAMES.labels.ready}`, `label #22 ${NAMES.labels.priority}`]);
    expect(w.status.comments).toHaveLength(3);
  });

  test("refuse a closed PR and a label already there; --dry-run labels nothing", async () => {
    const w = new World();
    w.target.addPr(31, { state: "closed" });
    w.target.addPr(32);
    expect((await w.run("remove", ["31"])).err).toContain("#31 is closed");
    expect((await w.run("requeue", ["32"])).err).toContain(`already labelled ${NAMES.labels.ready}`);
    expect((await w.run("remove", ["32", "--dry-run"])).out).toContain(`would: label #32 ${NAMES.labels.bounce}`);
    expect(w.log).toEqual([]);
  });
});

describe("approve-policy", () => {
  test("posts the approval for the PR's exact head, as an approver", async () => {
    const w = new World();
    const head = w.target.addPr(51).pr.head.sha;
    expect((await w.run("approve-policy", ["51", head])).code).toBe(0);
    expect(w.writes()[0]).toBe(`pr comment #51 /qlander approve-policy ${head}`);
  });

  test("refuses a stale head and an operator who is not an approver; --dry-run posts nothing", async () => {
    const w = new World();
    const head = w.target.addPr(52).pr.head.sha;
    expect((await w.run("approve-policy", ["52", sha("old")])).err).toContain("an approval counts for that exact head only");
    expect((await w.run("approve-policy", ["52", head, "--dry-run"])).out).toContain("would: comment on #52");
    w.me = { login: "someone-else", id: 1 };
    expect((await w.run("approve-policy", ["52", head])).err).toContain("not on queue.policy.approvers");
    expect(w.log).toEqual([]);
  });
});

describe("the real client", () => {
  test("its writes: enable, disable and dispatch tick.yml, the configured labels and the approval comment; anything else is refused", async () => {
    const seen: { method: string; url: string; body: string }[] = [];
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ method: init?.method ?? "GET", url, body: String(init?.body ?? "") });
      if (url.endsWith(`/repos/${NAMES.control.owner}/${NAMES.control.name}`)) return Response.json({ id: NAMES.control.id, node_id: "R_c" });
      if (url.endsWith(`/repos/${NAMES.target.owner}/${NAMES.target.name}`)) return Response.json({ id: NAMES.target.id, node_id: "R_t" });
      if (url.endsWith("/user")) return Response.json({ login: ME.login, id: ME.id });
      if (init?.method && init.method !== "GET") return new Response(null, { status: 204 });
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const api = await connectControl({ names: NAMES, humans: APPROVERS, releaseWritesState: false }, { token: "t", fetch, readAttempts: 1 });
    expect(await api.whoami()).toEqual({ login: ME.login, id: ME.id });
    seen.length = 0;
    await api.setTickEnabled(false);
    await api.setTickEnabled(true);
    await api.dispatchTick();
    await api.addPrLabel(5, NAMES.labels.bounce);
    await api.commentPr(5, `/qlander approve-policy ${sha("h")}`);
    const ctl = `/repos/${NAMES.control.owner}/${NAMES.control.name}/actions/workflows/tick.yml`;
    const tgt = `/repos/${NAMES.target.owner}/${NAMES.target.name}/issues/5`;
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([`PUT ${ctl}/disable`, `PUT ${ctl}/enable`, `POST ${ctl}/dispatches`, `POST ${tgt}/labels`, `POST ${tgt}/comments`]);
    expect(JSON.parse(seen[2]!.body)).toEqual({ ref: CONTROL_BRANCH });
    expect(JSON.parse(seen[3]!.body)).toEqual({ labels: [NAMES.labels.bounce] });
    seen.length = 0;
    await expect(api.addPrLabel(5, NAMES.labels.solo)).rejects.toThrow("unexpected label");
    await expect(api.commentPr(5, "hello")).rejects.toThrow("policy approval");
    await expect(api.addPrLabel(0, NAMES.labels.ready)).rejects.toThrow("bad PR number");
    await expect(api.createIssue("x", "y", [STATUS])).rejects.toThrow("unexpected label");
    expect(seen).toEqual([]);
  });
});
