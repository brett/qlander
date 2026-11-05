// Who may write state, when a lease may be taken over, and
// what a dry run reports.

import { describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import type { Clients } from "../src/main";
import { connectClients, runDry } from "../src/main";
import { emptyState, renderState, type State } from "../src/state";
import { LeaseHeldError, StateStore } from "../src/store";
import { FakeTarget, FakeStateRef, FakeStateRepo } from "./fake-github";
import { TARGET, NAMES, sha, TARGET_SLUG, CONTROL_SLUG, QUEUE_TOKEN_ENV } from "./sim";
import { World } from "./world";
import { queueCodec } from "../src/store";

const LS = defaultConfig.names.control.id;
const JOB = "Queue tick";

describe("the state is written only with the state App's own token", () => {
  test("target calls use the queue token, the state branch uses STATE_TOKEN, issues and Actions reads use GITHUB_TOKEN", async () => {
    const seen: { url: string; auth: string }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: String((init?.headers as Record<string, string>)?.authorization ?? "") });
      if (url.endsWith(`/repos/${TARGET_SLUG}`)) return new Response(JSON.stringify({ id: TARGET, node_id: "C" }));
      if (url.endsWith(`/repos/${CONTROL_SLUG}`)) return new Response(JSON.stringify({ id: LS, node_id: "L" }));
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    await connectClients({ [QUEUE_TOKEN_ENV]: "queue-tok", STATE_TOKEN: "state-tok", GITHUB_TOKEN: "gh-tok" }, "queue", fetchFn);
    const auths = seen.map((s) => `${s.url.replace("https://api.github.com/", "")} ${s.auth}`);
    expect(auths).toContain(`repos/${TARGET_SLUG} Bearer queue-tok`);
    expect(auths).toContain(`repos/${CONTROL_SLUG} Bearer state-tok`);
    expect(auths).toContain(`repos/${CONTROL_SLUG} Bearer gh-tok`);
    await expect(connectClients({ [QUEUE_TOKEN_ENV]: "c", GITHUB_TOKEN: "g" }, "queue", fetchFn)).rejects.toThrow("STATE_TOKEN");
  });
});

describe("no takeover while the previous executor's job may still be running", () => {
  test("Regression: A is suspended after its fence; B may not take over until A's job has completed", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt({ executor: { runId: 900, attempt: 1, job: JOB } });
    const update = w.target.updateRef.bind(w.target);
    let inner = null as string | null;
    w.target.updateRef = async (b, before, after) => {
      if (inner === null && b === "main") {
        // A has passed its fence; it now freezes far past its lease.
        w.now = new Date(w.now.getTime() + 30 * 60_000);
        const p = w.target.prs.get(1)!.pr;
        p.labels = p.labels.filter((l) => l !== "ready");
        const r = await w.tick({ runId: "B", executor: { runId: 901, attempt: 1, job: JOB } });
        inner = r === "crashed" ? r : r.outcome;
      }
      return update(b, before, after);
    };
    await w.tick({ runId: "A", executor: { runId: 902, attempt: 1, job: JOB } });
    expect(inner).toBe("busy"); // A's job (902) was still running
    expect(w.landed()).toEqual([[1]]); // A resumed and landed, and its state write still succeeded
    expect(w.state().history.filter((h) => h.outcome === "abandoned")).toEqual([]);
  });

  test("an expired lease is taken over only once the job is completed and the grace past the kill deadline has passed", async () => {
    const ref = new FakeStateRef();
    const repo = new FakeStateRepo();
    let t = new Date("2026-10-21T12:00:00Z");
    ref.clock = () => t;
    const c = { ...defaultConfig, takeoverGraceMinutes: 5 };
    await StateStore.open(ref, repo, "A", c, { runId: 10, attempt: 1, job: JOB }, queueCodec(NAMES));
    repo.jobStates.set("10/1/Queue tick", "running");
    t = new Date("2026-10-21T12:09:00Z"); // lease (8) expired; kill (6) + grace (5) = 11 not yet
    repo.jobStates.set("10/1/Queue tick", "completed");
    await expect(StateStore.open(ref, repo, "B", c, { runId: 11, attempt: 1, job: JOB }, queueCodec(NAMES))).rejects.toBeInstanceOf(LeaseHeldError);
    t = new Date("2026-10-21T12:12:00Z");
    repo.jobStates.set("10/1/Queue tick", "running");
    await expect(StateStore.open(ref, repo, "B", c, { runId: 11, attempt: 1, job: JOB }, queueCodec(NAMES))).rejects.toThrow("not completed");
    repo.jobStates.set("10/1/Queue tick", "unknown");
    await expect(StateStore.open(ref, repo, "B", c, { runId: 11, attempt: 1, job: JOB }, queueCodec(NAMES))).rejects.toBeInstanceOf(LeaseHeldError);
    repo.jobStates.set("10/1/Queue tick", "completed");
    const b = await StateStore.open(ref, repo, "B", c, { runId: 11, attempt: 1, job: JOB }, queueCodec(NAMES));
    expect(b.state.lease).toMatchObject({ owner: "B", executor: { runId: 11, attempt: 1, job: JOB } });
  });
});

describe("a dry run applies the same initialisation check as a live run", () => {
  test("missing state ref and a state issue holding state: the dry run reports the refusal and writes nothing", async () => {
    const target = new FakeTarget("read");
    const repo = new FakeStateRepo();
    const held: State = { ...emptyState(), seq: 3, window: [{ at: "2026-10-21T10:00:00.000Z", cost: 1 }] };
    await repo.createIssue("qlander state", renderState(held), ["qlander-state"]);
    const stateRef = new FakeStateRef();
    const clients: Clients = { target, repo, stateRef };
    const r = await runDry({ GITHUB_EVENT_NAME: "schedule" }, { repository: { id: LS } }, async () => clients);
    expect(r.refused).toContain("refusing to initialise");
    expect(r.wouldDo).toBeNull();
    expect(repo.issues.filter((i) => i.labels.includes("pause"))).toEqual([]);
    expect(stateRef.writes).toBe(0);
    void sha;
  });
});
