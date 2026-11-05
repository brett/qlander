// Step 5 + step 6 integration: the release job's state lives on its own
// protected branch, written only through the state client with STATE_TOKEN;
// its lease records its executor, so a frozen release job is never taken over
// while it may still be running; and its dry run writes nothing.

import { describe, expect, test } from "bun:test";
import { connectReleaseClients, isReleaseLive, RELEASE_JOB_NAME, runReleaseDry } from "../src/main";
import { StateRefClient } from "../src/github/state-ref";
import { defaultConfig } from "../src/config";
import { defaultReleaseConfig } from "../src/release-config";
import { emptyReleaseState, releaseCodec } from "../src/release-state";
import { LeaseHeldError, StateStore } from "../src/store";
import { ReleaseWorld } from "./release-world";
import { TARGET, NAMES, sha, STATE_BRANCHES, TARGET_SLUG, CONTROL_SLUG, RELEASE_TOKEN_ENV, QUEUE_TOKEN_ENV } from "./sim";

const LS = defaultReleaseConfig.names.control.id;
const RELEASE_STATE_BRANCH = NAMES.releaseStateBranch;
const RELEASE_STATE_REF = `refs/heads/${RELEASE_STATE_BRANCH}`;
const STATE_REF = `refs/heads/${NAMES.stateBranch}`;
const job = (runId: number) => ({ runId, attempt: 1, job: RELEASE_JOB_NAME });

/** A recording fetch: the two repos, the release state branch at V1, and the writes a CAS makes. */
function recordingFetch() {
  const seen: { method: string; url: string; auth: string; body: any }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { date: "Thu, 22 Oct 2026 12:00:00 GMT" } });
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input).replace("https://api.github.com/", "");
    const method = init?.method ?? "GET";
    seen.push({ method, url, auth: String((init?.headers as Record<string, string>)?.authorization ?? ""), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === `repos/${TARGET_SLUG}`) return json({ id: TARGET, node_id: "C" });
    if (url === `repos/${CONTROL_SLUG}`) return json({ id: LS, node_id: "L" });
    if (url.endsWith(`git/ref/heads/${RELEASE_STATE_BRANCH}`)) return json({ object: { sha: sha("V1"), type: "commit" } });
    if (url.includes("contents/state.json")) return json({ type: "file", encoding: "base64", content: Buffer.from("{}").toString("base64") });
    if (url.endsWith("git/blobs")) return json({ sha: sha("blob") }, 201);
    if (url.endsWith("git/trees")) return json({ sha: sha("tree") }, 201);
    if (url.endsWith("git/commits")) return json({ sha: sha("V2") }, 201);
    if (url === "graphql") return json({ data: { updateRefs: { clientMutationId: null } } });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
  return { seen, fetchFn };
}

describe("the release state branch is written only through the state client, with STATE_TOKEN", () => {
  const env = { [RELEASE_TOKEN_ENV]: "release-tok", STATE_TOKEN: "state-tok", GITHUB_TOKEN: "gh-tok" };

  test("its own protected branch, apart from the queue's", () => {
    expect(RELEASE_STATE_REF).toBe("refs/heads/qlander-release-state");
    expect(RELEASE_STATE_REF).not.toBe(STATE_REF);
  });

  test("the target uses the release App's token; every state-branch read and write uses STATE_TOKEN; GITHUB_TOKEN never touches a ref", async () => {
    const { seen, fetchFn } = recordingFetch();
    const clients = await connectReleaseClients(env, { ...defaultReleaseConfig, dryRun: false }, "release", fetchFn);
    const read = await clients.stateRef.read();
    expect(read?.version).toBe(sha("V1"));
    await clients.stateRef.cas(read!.version, "{}");
    const at = (pred: (x: (typeof seen)[number]) => boolean) => seen.filter(pred).map((x) => x.auth);
    expect(at((x) => x.url === `repos/${TARGET_SLUG}`)).toEqual(["Bearer release-tok"]);
    const stateCalls = seen.filter((x) => /\/git\/|contents\/state\.json|^graphql$/.test(x.url));
    expect(stateCalls.length).toBeGreaterThan(0);
    expect(new Set(stateCalls.map((x) => x.auth))).toEqual(new Set(["Bearer state-tok"]));
    expect(seen.find((x) => x.url.endsWith(`git/ref/heads/${RELEASE_STATE_BRANCH}`))).toBeDefined();
    const update = seen.find((x) => x.url === "graphql")!;
    expect(update.body.variables.input.refUpdates).toEqual([{ name: RELEASE_STATE_REF, beforeOid: sha("V1"), afterOid: sha("V2"), force: false }]);
    // The workflow token is used for qlander issues only (the repo client), never for git data or ref updates.
    expect(seen.filter((x) => x.auth === "Bearer gh-tok").map((x) => x.url)).toEqual([`repos/${CONTROL_SLUG}`]);
  });

  test("STATE_TOKEN is required, and the release job still refuses the queue's key", async () => {
    const { fetchFn } = recordingFetch();
    await expect(connectReleaseClients({ [RELEASE_TOKEN_ENV]: "r", GITHUB_TOKEN: "g" }, defaultReleaseConfig, "release", fetchFn)).rejects.toThrow("STATE_TOKEN");
    await expect(connectReleaseClients({ ...env, [QUEUE_TOKEN_ENV]: "q" }, defaultReleaseConfig, "release", fetchFn)).rejects.toThrow("other App's key");
  });

  test("the state client moves only the two state branches", async () => {
    const { fetchFn } = recordingFetch();
    const o = { token: "t", owner: NAMES.control.owner, repo: NAMES.control.name, repoId: LS, fetch: fetchFn };
    for (const branch of ["main", "release", "refs/qlander/release-state", "qlander-state-x"]) {
      await expect(StateRefClient.connect({ stateBranches: STATE_BRANCHES, ...o, branch })).rejects.toThrow("not a qlander state branch");
    }
    await StateRefClient.connect({ stateBranches: STATE_BRANCHES, ...o, branch: RELEASE_STATE_BRANCH });
  });
});

describe("release executor takeover (DESIGN.md §15)", () => {
  test("the release lease records the release job; a successor waits for GitHub to report it completed plus the grace", async () => {
    const w = new ReleaseWorld();
    const cfg = { ...w.cfg, takeoverGraceMinutes: 5 };
    const codec = releaseCodec(cfg.names.releaseLabels.mirror);
    await StateStore.open(w.stateRef, w.repo, "A", cfg, job(10), codec);
    expect(w.state().lease).toMatchObject({ owner: "A", executor: job(10) });
    w.repo.jobStates.set(`10/1/${RELEASE_JOB_NAME}`, "completed");
    w.now = new Date(w.now.getTime() + (cfg.leaseMinutes + 0.5) * 60_000); // lease (8) expired; kill (6) + grace (5) = 11 not yet
    await expect(StateStore.open(w.stateRef, w.repo, "B", cfg, job(11), codec)).rejects.toThrow("kill deadline");
    w.now = new Date(w.now.getTime() + 3 * 60_000);
    for (const s of ["running", "unknown"] as const) {
      w.repo.jobStates.set(`10/1/${RELEASE_JOB_NAME}`, s);
      await expect(StateStore.open(w.stateRef, w.repo, "B", cfg, job(11), codec)).rejects.toBeInstanceOf(LeaseHeldError);
    }
    w.repo.jobStates.set(`10/1/${RELEASE_JOB_NAME}`, "completed");
    const b = await StateStore.open(w.stateRef, w.repo, "B", cfg, job(11), codec);
    expect(b.state.lease).toMatchObject({ owner: "B", executor: job(11) });
  });

  test("a frozen release job past its fence: the next tick is busy until its job completes, and the frozen one's advance stands", async () => {
    const w = new ReleaseWorld();
    const a = w.land();
    w.qualified(a);
    const real = w.target.updateRef.bind(w.target);
    let inner = null as string | null;
    w.target.updateRef = async (b, before, after) => {
      if (inner === null) {
        // A has passed its fence and freezes far past its lease; B's tick starts.
        w.now = new Date(w.now.getTime() + 30 * 60_000);
        const r = await w.tick({ runId: "B", executor: job(901) });
        inner = r === "crashed" ? r : r.outcome;
      }
      return real(b, before, after);
    };
    const r = await w.ok({ runId: "A", executor: job(900) });
    expect(inner).toBe("busy"); // A's job (900) was still running
    expect(r.outcome).toBe("advanced");
    expect(w.release).toBe(a);
    expect(w.releaseWrites()).toEqual([`updateRef release ${w.R} -> ${a}`]);
    expect(w.state().lease).toBeNull();
  });

  test("runRelease refuses to run live outside Actions (no executor to record)", async () => {
    const { runRelease } = await import("../src/main");
    const w = new ReleaseWorld();
    const clients = async () => ({ target: w.target, repo: w.repo, stateRef: w.stateRef });
    await expect(runRelease({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: LS } }, clients, w.cfg)).rejects.toThrow("outside Actions");
    expect(w.stateRef.writes).toBe(0);
  });

  test("the release job shares the pool's kill deadline and the job/lease/fence margins with the queue", () => {
    const r = defaultReleaseConfig;
    expect([r.jobTimeoutMinutes, r.leaseMinutes, r.fenceMarginMinutes]).toEqual([defaultConfig.jobTimeoutMinutes, defaultConfig.leaseMinutes, defaultConfig.fenceMarginMinutes]);
    expect([r.controllerKillMinutes, r.takeoverGraceMinutes]).toEqual([defaultConfig.controllerKillMinutes, defaultConfig.takeoverGraceMinutes]);
  });
});

describe("release dry run (QLANDER_MODE)", () => {
  test("live only when QLANDER_MODE is exactly live and release advance is not held", () => {
    const live = { ...defaultReleaseConfig, dryRun: false };
    expect(isReleaseLive({ QLANDER_MODE: "live" }, live)).toBe(true);
    for (const mode of [undefined, "", "Live", "live ", "true", "dry-run"]) expect(isReleaseLive({ QLANDER_MODE: mode }, live)).toBe(false);
    expect(isReleaseLive({ QLANDER_MODE: "live" }, defaultReleaseConfig)).toBe(false); // held until its own G4
  });

  test("the dry run connects the target read-only even when the release is not held", async () => {
    const { seen, fetchFn } = recordingFetch();
    const c = await connectReleaseClients({ [RELEASE_TOKEN_ENV]: "r", STATE_TOKEN: "s", GITHUB_TOKEN: "g" }, { ...defaultReleaseConfig, dryRun: false }, "read", fetchFn);
    await expect(c.target.updateRef("release", sha("a"), sha("b"))).rejects.toThrow();
    expect(seen.some((x) => x.url === "graphql")).toBe(false);
  });

  test("an end-to-end dry run with a qualified candidate writes nothing: no state, no lease, no issue, no target write", async () => {
    const w = new ReleaseWorld({ dryRun: false });
    w.target.role = "read";
    const a = w.land();
    w.qualified(a);
    const clients = async () => ({ target: w.target, repo: w.repo, stateRef: w.stateRef });
    const r = await runReleaseDry({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: LS } }, clients, w.cfg);
    expect(r).toMatchObject({ mode: "dry-run", decision: { kind: "advance", from: w.R, to: a } });
    expect(w.releaseWrites()).toEqual([]);
    expect(w.stateRef.writes).toBe(0);
    expect(w.repo.issues).toEqual([]);
  });

  test("a dry run reports what a live tick would refuse or recover, and still writes nothing", async () => {
    const w = new ReleaseWorld();
    w.target.role = "read";
    // The release state branch is missing while its mirror issue exists: a live tick would pause.
    await w.repo.createIssue("qlander release state (mirror)", "x", ["qlander-release-state"]);
    const r = await runReleaseDry({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: LS } }, async () => ({ target: w.target, repo: w.repo, stateRef: w.stateRef }), w.cfg);
    expect(r.refused).toContain("refusing to initialise");
    expect(w.issues("release-pause")).toEqual([]);
    expect(w.stateRef.writes).toBe(0);
    // An open release-pause issue: the dry run reports paused and discovers nothing.
    const w2 = new ReleaseWorld();
    w2.stateRef.current = { version: sha("s1"), text: JSON.stringify(emptyReleaseState()) };
    await w2.repo.createIssue("paused", "p", ["release-pause"]);
    const before = w2.target.calls.length;
    const r2 = await runReleaseDry({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: LS } }, async () => ({ target: w2.target, repo: w2.repo, stateRef: w2.stateRef }), w2.cfg);
    expect(r2.log.join(" ")).toContain("paused");
    expect(w2.target.calls.length).toBe(before);
    expect(w2.stateRef.writes).toBe(0);
  });
});
