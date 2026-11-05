// The epoch fence (docs/deployment.md §3.4): every target ref write is one
// atomic updateRefs call that also carries `{epoch: E -> E}`, and a new owner's
// first act is to advance the epoch. A frozen owner that resumes after a
// successor took over has every ref write rejected, even though it already
// passed the lease fence. GitHub's side of this (an unchanged entry is
// checked; the rulesets refuse every rollback) is experiment H1, run on a
// sandbox; here the fake models the behaviour H1 must confirm.

import { describe, expect, test } from "bun:test";
import { epochBranchFor, epochClientProblem } from "../src/config";
import { fenced, takeEpoch } from "../src/fenced";
import { GitHubError } from "../src/github/http";
import { EMPTY_TREE, TargetClient } from "../src/github/target";
import { tick } from "../src/queue";
import { LostLockError } from "../src/store";
import { ZERO_SHA } from "../src/validate";
import { FakeStateRef, FakeStateRepo, FakeTarget } from "./fake-github";
import { ReleaseWorld } from "./release-world";
import { BASE_CONFIG, cfg, NAMES, pathRe, sha, TARGET, TARGET_OPTS, TARGET_SLUG } from "./sim";
import { World } from "./world";

const ON = { ...BASE_CONFIG.runner, epochFence: true };
const QUEUE_EPOCH = epochBranchFor(ON, "queue");
const RELEASE_EPOCH = epochBranchFor(ON, "release");
const noFence = async () => {};

/** A queue-role fake with the fence on, a build ref and a queue ref to delete, and a commit to land. */
function fencedFake(role: "queue" | "release" = "queue") {
  const t = new FakeTarget(role);
  t.epochBranch = role === "queue" ? QUEUE_EPOCH : RELEASE_EPOCH;
  const main = t.refs.get(NAMES.main)!;
  const next = t.commit([main], "next");
  if (role === "release") t.refs.set(NAMES.release, main);
  const build = `${NAMES.buildPrefix}7`;
  if (role === "queue") t.refs.set(build, main);
  return { t, main, next, build };
}

/** Every ref write a job of this role can make, through the epoch-fenced wrapper. */
function everyRefWrite(c: ReturnType<typeof fenced>, role: "queue" | "release", f: ReturnType<typeof fencedFake>): [string, () => Promise<unknown>][] {
  if (role === "release") return [["updateRef release", () => c.updateRef(NAMES.release, f.main, f.next)]];
  return [
    ["createRef queue", () => c.createRef(`${NAMES.queuePrefix}8`, f.next)],
    ["createRef build", () => c.createRef(`${NAMES.buildPrefix}8`, f.main)],
    ["deleteRef build", () => c.deleteRef(f.build)],
    ["updateRef main", () => c.updateRef(NAMES.main, f.main, f.next)],
  ];
}

describe("the frozen owner: every ref write is rejected once a successor has advanced the epoch", () => {
  for (const role of ["queue", "release"] as const) {
    test(`${role}: the old owner passed the lease fence, yet nothing moves`, async () => {
      const f = fencedFake(role);
      // A takes its lease and the epoch; then freezes after its lease check (the lease fence here always passes).
      const eA = await takeEpoch(fenced(f.t, noFence), "A");
      const a = fenced(f.t, noFence, () => eA);
      // B takes over: its first act is to advance the epoch.
      const eB = await takeEpoch(fenced(f.t, noFence), "B");
      expect(eB).not.toBe(eA);
      expect(f.t.commits.get(eB)!.parents).toEqual([eA]); // a fast-forward, never a reset
      const before = new Map(f.t.refs);
      for (const [what, write] of everyRefWrite(a, role, f)) {
        const err = await write().catch((e: unknown) => e);
        expect(err, what).toBeInstanceOf(LostLockError);
        expect(String(err)).toContain(`the epoch is no longer ${eA}`);
      }
      expect(f.t.refs).toEqual(before);
      expect(f.t.epochRejections.map((r) => r.epoch)).toEqual(everyRefWrite(a, role, f).map(() => eA));
      // The current owner's writes land.
      const b = fenced(f.t, noFence, () => eB);
      for (const [, write] of everyRefWrite(b, role, f)) await write();
      expect(f.t.refs.get(role === "queue" ? NAMES.main : NAMES.release)).toBe(f.next);
    });
  }

  test("no bypass: the plain write methods refuse while the client has an epoch branch, wrapped or not", async () => {
    const f = fencedFake();
    const plain = fenced(f.t, noFence); // epoch off in the wrapper, on in the client
    for (const c of [f.t, plain]) {
      await expect(c.createRef(`${NAMES.queuePrefix}8`, f.next)).rejects.toThrow("the epoch fence is on");
      await expect(c.deleteRef(f.build)).rejects.toThrow("the epoch fence is on");
      await expect(c.updateRef(NAMES.main, f.main, f.next)).rejects.toThrow("the epoch fence is on");
    }
    expect(f.t.refs.get(NAMES.main)).toBe(f.main);
  });

  test("before the epoch is taken, and with an epoch the tick does not hold, nothing is written", async () => {
    const f = fencedFake();
    const none = fenced(f.t, noFence, () => null);
    for (const [, write] of everyRefWrite(none, "queue", f)) await expect(write()).rejects.toThrow("no epoch taken");
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    const a = fenced(f.t, noFence, () => e);
    await expect(a.epochUpdateRefs([{ branch: NAMES.main, before: f.main, after: f.next }], sha("forged"))).rejects.toThrow("does not hold");
    expect(f.t.refs.get(NAMES.main)).toBe(f.main);
  });

  test("the lease fence still runs first: a lost lease writes nothing and does not advance the epoch", async () => {
    const f = fencedFake();
    const lost = async () => {
      throw new LostLockError("the state moved");
    };
    await expect(takeEpoch(fenced(f.t, lost), "A")).rejects.toBeInstanceOf(LostLockError);
    expect(f.t.refs.has(QUEUE_EPOCH)).toBe(false);
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    await expect(fenced(f.t, lost, () => e).updateRef(NAMES.main, f.main, f.next)).rejects.toThrow("the state moved");
    expect(f.t.epochRejections).toEqual([]);
  });

  test("a rejection while the epoch is still ours keeps the plain contract (CAS failure, existing ref, confirmed delete)", async () => {
    const f = fencedFake();
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    const a = fenced(f.t, noFence, () => e, noFence);
    // main moved under us: the GitHub error, not a lost lease (the land path judges by the ref).
    await expect(a.updateRef(NAMES.main, f.next, f.main)).rejects.toBeInstanceOf(GitHubError);
    // an existing ref: a conflict, as POST /git/refs reports it.
    const dup = await a.createRef(f.build, f.main).catch((x: unknown) => x);
    expect(dup instanceof GitHubError && dup.kind).toBe("conflict");
    // a ref already gone is a successful delete, and so is one gone by the time we look again.
    await a.deleteRef(`${NAMES.buildPrefix}99`);
    f.t.rejectDeletes.add(f.build);
    await expect(a.deleteRef(f.build)).rejects.toBeInstanceOf(GitHubError);
    expect(f.t.refs.has(f.build)).toBe(true);
  });
});

describe("taking the epoch", () => {
  test("a missing epoch branch starts at a root commit; each take is a child of the last", async () => {
    const f = fencedFake();
    const c = fenced(f.t, noFence);
    const e1 = await takeEpoch(c, "A");
    expect(f.t.commits.get(e1)!.parents).toEqual([]);
    const e2 = await takeEpoch(c, "B");
    expect(f.t.commits.get(e2)!.parents).toEqual([e1]);
    expect(f.t.refs.get(QUEUE_EPOCH)).toBe(e2);
  });

  test("an epoch that moves while it is read is a conflict (the tick retries), not a pause", async () => {
    const f = fencedFake();
    const c = fenced(f.t, noFence);
    await takeEpoch(c, "A");
    const read = f.t.readEpoch.bind(f.t);
    let first = true;
    f.t.readEpoch = async () => {
      const r = await read();
      if (first) {
        first = false;
        await takeEpoch(fenced(f.t, noFence), "racer"); // someone advances between our read and our CAS
      }
      return r;
    };
    const err = await takeEpoch(c, "B").catch((e: unknown) => e);
    expect(err instanceof GitHubError && err.kind).toBe("conflict");
  });

  test("a rejected advance seen through a lagging replica (untyped GraphQL error, epoch still reads old) retries, never pauses", async () => {
    const f = fencedFake();
    const c = fenced(f.t, noFence);
    const e1 = await takeEpoch(c, "A");
    await takeEpoch(c, "racer"); // the epoch is really E2 now
    f.t.readEpoch = async () => e1; // every read lags
    f.t.advanceEpoch = async () => {
      throw new GitHubError("validation", 200, "Something went wrong while executing your query"); // what GitHub returns (H1 check 1)
    };
    const err = await takeEpoch(c, "B").catch((e: unknown) => e);
    expect(err instanceof GitHubError && err.kind).toBe("conflict");
    // Other failures (a token without access, say) are not dressed up as a race.
    f.t.advanceEpoch = async () => {
      throw new GitHubError("auth", 403, "Resource not accessible by integration");
    };
    const auth = await takeEpoch(c, "B").catch((e: unknown) => e);
    expect(auth instanceof GitHubError && auth.kind).toBe("auth");
  });

  test("the contract and the client must agree before a lease is taken", async () => {
    expect(epochClientProblem(ON, QUEUE_EPOCH, "queue")).toBeNull();
    expect(epochClientProblem(BASE_CONFIG.runner, null, "queue")).toBeNull();
    expect(epochClientProblem(ON, null, "queue")).toContain("runner.epochFence is on");
    expect(epochClientProblem(ON, RELEASE_EPOCH, "queue")).toContain(`not ${QUEUE_EPOCH}`);
    expect(epochClientProblem({ ...ON, epochFence: false }, QUEUE_EPOCH, "queue")).toContain("runner.epochFence is off");
    const stateRef = new FakeStateRef();
    const target = new FakeTarget("queue");
    await expect(tick({ target, repo: new FakeStateRepo(), stateRef, cfg: cfg({ runner: ON }), now: () => new Date(), runId: "r.1.x" })).rejects.toThrow("refusing to run: runner.epochFence is on");
    expect(stateRef.current).toBeNull(); // no lease, no state
  });
});

describe("a whole queue with the epoch fence on", () => {
  const fencedWorld = () => {
    const w = new World(() => "pass", { runner: ON });
    w.target.epochBranch = QUEUE_EPOCH;
    return w;
  };

  test("lands as before; every tick that holds the lease advances the epoch first", async () => {
    const w = fencedWorld();
    w.readyPr(1);
    w.readyPr(2);
    const ticks = await w.runUntilIdle();
    expect(w.landed().flat().sort()).toEqual([1, 2]);
    expect(w.target.calls.filter((c) => c.startsWith("advanceEpoch")).length).toBe(ticks);
    expect(w.target.epochRejections).toEqual([]);
  });

  /** The owner freezes after its lease check on the main CAS; meanwhile its successor advances the epoch. */
  async function frozenLand(w: World, epochOn: boolean) {
    w.readyPr(1);
    let froze: string | null = null; // the commit the frozen owner was landing
    if (epochOn) {
      const send = w.target.epochUpdateRefs.bind(w.target);
      w.target.epochUpdateRefs = async (writes, e) => {
        const land = writes.find((x) => x.branch === NAMES.main);
        if (froze === null && land) {
          froze = land.after;
          await takeEpoch(fenced(w.target, noFence), "B"); // the successor's first act
        }
        return send(writes, e);
      };
    } else {
      const send = w.target.updateRef.bind(w.target);
      w.target.updateRef = async (b, before, after) => {
        if (froze === null && b === NAMES.main) froze = after; // nothing here can stop the write once the lease check passed
        return send(b, before, after);
      };
    }
    for (let i = 0; i < 20; i++) {
      const r = await w.tick();
      if (froze !== null) return { r, after: froze as string };
    }
    throw new Error("no land was attempted");
  }

  test("frozen owner: its land is rejected after the lease check passed, and main never moves", async () => {
    const w = fencedWorld();
    const { r, after } = await frozenLand(w, true);
    expect(r === "crashed" ? r : r.outcome).toBe("lost-lock");
    expect(w.mainHistory).not.toContain(after);
    expect(w.target.epochRejections.map((x) => x.writes.map((u) => u.branch))).toEqual([[NAMES.main]]);
  });

  test("without the fence the same resume would land: the hole the epoch closes on hosted runners", async () => {
    const w = new World();
    const { after } = await frozenLand(w, false);
    expect(w.mainHistory).toContain(after);
  });
});

describe("the release job with the epoch fence on", () => {
  const fencedRelease = () => {
    const w = new ReleaseWorld({ runner: ON });
    w.target.epochBranch = RELEASE_EPOCH;
    return w;
  };

  test("advances release through the fence", async () => {
    const w = fencedRelease();
    const c = w.land();
    w.qualified(c);
    const r = await w.ok();
    expect(r.outcome).toBe("advanced");
    expect(w.release).toBe(c);
    expect(w.target.calls.filter((x) => x.startsWith("advanceEpoch"))).toHaveLength(1);
  });

  test("frozen owner: its release CAS is rejected and release does not move", async () => {
    const w = fencedRelease();
    const c = w.land();
    w.qualified(c);
    const send = w.target.epochUpdateRefs.bind(w.target);
    w.target.epochUpdateRefs = async (writes, e) => {
      await takeEpoch(fenced(w.target, noFence), "B"); // the successor's first act, while A is frozen
      return send(writes, e);
    };
    const r = await w.ok({ runId: "A" });
    expect(r.outcome).toBe("lost-lock");
    expect(w.release).toBe(w.R);
  });
});

describe("TargetClient: the epoch fence on the wire", () => {
  const ok = { method: "POST", match: /\/graphql$/, body: { data: { updateRefs: { clientMutationId: null } } } };
  async function client(routes: { method?: string; match: RegExp; body?: unknown; status?: number }[], epochBranch: string | null = QUEUE_EPOCH, role: "queue" | "release" | "read" = "queue") {
    const seen: { method: string; url: string; body: unknown }[] = [];
    const queue = [{ match: pathRe(`/repos/${TARGET_SLUG}`), body: { id: TARGET, node_id: "R_target" } }, ...routes];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const i = queue.findIndex((r) => (r.method ?? "GET") === method && r.match.test(url));
      if (i < 0) return new Response(JSON.stringify({ message: `unrouted ${method} ${url}` }), { status: 599 });
      const r = queue.splice(i, 1)[0]!;
      return new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 });
    }) as typeof fetch;
    const c = await TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role, fetch: fetchFn, sleep: noFence, epochBranch });
    return { c, seen };
  }
  const E = sha("epoch");
  const M = sha("main");
  const N = sha("next");

  test("every ref write is one updateRefs call with the writes and the unchanged epoch entry, force false", async () => {
    const { c, seen } = await client([ok]);
    await c.epochUpdateRefs([{ branch: NAMES.main, before: M, after: N }, { branch: `${NAMES.queuePrefix}3`, before: ZERO_SHA, after: N }], E);
    const calls = seen.filter((s) => s.url.endsWith("/graphql"));
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { variables: unknown }).variables).toEqual({
      input: {
        repositoryId: "R_target",
        refUpdates: [
          { name: `refs/heads/${NAMES.main}`, beforeOid: M, afterOid: N, force: false },
          { name: `refs/heads/${NAMES.queuePrefix}3`, beforeOid: ZERO_SHA, afterOid: N, force: false },
          { name: `refs/heads/${QUEUE_EPOCH}`, beforeOid: E, afterOid: E, force: false },
        ],
      },
    });
  });

  test("epochHeld: a lone no-op updateRefs {epoch E->E}; GitHub's refusal is false, anything else throws", async () => {
    const refused = { method: "POST", match: /\/graphql$/, body: { errors: [{ message: "Something went wrong while executing your query." }] } };
    const { c, seen } = await client([ok, refused, { method: "POST", match: /\/graphql$/, status: 502, body: { message: "bad gateway" } }]);
    expect(await c.epochHeld(E)).toBe(true);
    expect(await c.epochHeld(E)).toBe(false);
    await expect(c.epochHeld(E)).rejects.toBeInstanceOf(GitHubError);
    const calls = seen.filter((s) => s.url.endsWith("/graphql")).map((s) => (s.body as { variables: { input: { refUpdates: unknown[] } } }).variables.input.refUpdates);
    expect(calls[0]).toEqual([{ name: `refs/heads/${QUEUE_EPOCH}`, beforeOid: E, afterOid: E, force: false }]);
    const off = (await client([], null)).c;
    await expect(off.epochHeld(E)).rejects.toThrow("the epoch fence is off");
  });

  test("advancing: an empty-tree commit on the old epoch, then a fast-forward CAS (a create when missing)", async () => {
    const C = sha("new-epoch");
    const { c, seen } = await client([{ method: "POST", match: /\/git\/commits$/, body: { sha: C } }, ok, { method: "POST", match: /\/git\/commits$/, body: { sha: C } }, ok]);
    expect(await c.advanceEpoch(E, "qlander epoch r.1.x")).toBe(C);
    expect(await c.advanceEpoch(null, "qlander epoch r.1.y")).toBe(C);
    const commits = seen.filter((s) => s.url.endsWith("/git/commits")).map((s) => s.body);
    expect(commits).toEqual([
      { message: "qlander epoch r.1.x", tree: EMPTY_TREE, parents: [E] },
      { message: "qlander epoch r.1.y", tree: EMPTY_TREE, parents: [] },
    ]);
    const moves = seen.filter((s) => s.url.endsWith("/graphql")).map((s) => (s.body as { variables: { input: { refUpdates: unknown[] } } }).variables.input.refUpdates);
    expect(moves).toEqual([[{ name: `refs/heads/${QUEUE_EPOCH}`, beforeOid: E, afterOid: C, force: false }], [{ name: `refs/heads/${QUEUE_EPOCH}`, beforeOid: ZERO_SHA, afterOid: C, force: false }]]);
  });

  test("refused before any request: plain writes while fenced, bad writes, epoch calls while unfenced", async () => {
    const { c, seen } = await client([]);
    const n = seen.length;
    await expect(c.createRef(`${NAMES.queuePrefix}3`, N)).rejects.toThrow("the epoch fence is on");
    await expect(c.deleteRef(`${NAMES.queuePrefix}3`)).rejects.toThrow("the epoch fence is on");
    await expect(c.updateRef(NAMES.main, M, N)).rejects.toThrow("the epoch fence is on");
    for (const [w, why] of [
      [[], "no ref writes"],
      [[{ branch: QUEUE_EPOCH, before: E, after: N }], "not one qlander"],
      [[{ branch: NAMES.release, before: M, after: N }], "may not write"],
      [[{ branch: NAMES.main, before: ZERO_SHA, after: N }], "only moved with updateRef"],
      [[{ branch: NAMES.main, before: M, after: ZERO_SHA }], "never deleted"],
      [[{ branch: `${NAMES.queuePrefix}3`, before: M, after: N }], "moves only main or release"],
      [[{ branch: `${NAMES.queuePrefix}3`, before: ZERO_SHA, after: ZERO_SHA }], "nothing to nothing"],
      [[{ branch: NAMES.main, before: M, after: N }, { branch: NAMES.main, before: N, after: M }], "twice"],
    ] as const) await expect(c.epochUpdateRefs([...w], E)).rejects.toThrow(why);
    await expect(c.epochUpdateRefs([{ branch: NAMES.main, before: M, after: N }], ZERO_SHA)).rejects.toThrow("not a real object id");
    await expect(c.advanceEpoch(E, "two\nlines")).rejects.toThrow("bad epoch commit message");
    expect(seen.length).toBe(n);
    const { c: off } = await client([], null);
    await expect(off.readEpoch()).rejects.toThrow("the epoch fence is off");
    await expect(off.advanceEpoch(null, "x")).rejects.toThrow("the epoch fence is off");
    await expect(off.epochUpdateRefs([{ branch: NAMES.main, before: M, after: N }], E)).rejects.toThrow("the epoch fence is off");
  });

  test("voiding a predecessor's branch: only an epoch chain, an empty-tree child, a fast-forward CAS; one that reads as missing is created (create-only CAS)", async () => {
    const OLD = "old-epoch/queue";
    const C = sha("voided");
    const ref = (s: string) => ({ match: new RegExp(`/git/ref/heads/${OLD}$`), body: { object: { sha: s, type: "commit" } } });
    const tree = (t: string) => ({ match: new RegExp(`/git/commits/${E}$`), body: { tree: { sha: t } } });
    const R = sha("root");
    const made = (x: string) => ({ method: "POST", match: /\/git\/commits$/, body: { sha: x } });
    const { c, seen } = await client([ref(E), tree(EMPTY_TREE), made(C), ok, { match: new RegExp(`/git/ref/heads/${OLD}$`), status: 404, body: { message: "Not Found" } }, made(R), ok, ref(E), tree(sha("code-tree"))], null);
    expect(await c.voidEpoch(OLD, "qlander void r.1.x")).toBe(C);
    expect(seen.find((s) => s.url.endsWith("/git/commits") && s.method === "POST")!.body).toEqual({ message: "qlander void r.1.x", tree: EMPTY_TREE, parents: [E] });
    const moves = seen.filter((s) => s.url.endsWith("/graphql")).map((s) => (s.body as { variables: { input: { refUpdates: unknown[] } } }).variables.input.refUpdates);
    expect(moves).toEqual([[{ name: `refs/heads/${OLD}`, beforeOid: E, afterOid: C, force: false }]]);
    expect(await c.voidEpoch(OLD, "x")).toBe(R);
    const second = seen.filter((s) => s.url.endsWith("/graphql")).map((s) => (s.body as { variables: { input: { refUpdates: unknown[] } } }).variables.input.refUpdates);
    expect(second[1]).toEqual([{ name: `refs/heads/${OLD}`, beforeOid: ZERO_SHA, afterOid: R, force: false }]);
    expect(seen.filter((s) => s.url.endsWith("/git/commits") && s.method === "POST")[1]!.body).toEqual({ message: "x", tree: EMPTY_TREE, parents: [] });
    await expect(c.voidEpoch(OLD, "x")).rejects.toThrow("not an epoch chain");
    expect(seen.filter((s) => s.url.endsWith("/graphql"))).toHaveLength(2);
    // Refused before any request: its own branch, a branch qlander writes, a bad name, a read-only client.
    const own = (await client([])).c;
    await expect(own.voidEpoch(QUEUE_EPOCH, "x")).rejects.toThrow("not this client's own");
    await expect(c.voidEpoch(NAMES.main, "x")).rejects.toThrow("overlaps a branch qlander writes");
    await expect(c.voidEpoch("x.lock/queue", "x")).rejects.toThrow("bad epoch branch");
    await expect((await client([], null, "read")).c.voidEpoch(OLD, "x")).rejects.toThrow("read-only");
  });

  test("connect refuses an epoch branch on a read-only client, or one that names a branch qlander writes", async () => {
    await expect(client([], QUEUE_EPOCH, "read")).rejects.toThrow("read-only client has no epoch branch");
    await expect(client([], `${NAMES.queuePrefix}epoch`)).rejects.toThrow("overlaps a branch qlander writes");
    await expect(client([], "epoch.lock/queue")).rejects.toThrow("bad epoch branch");
  });
});

describe("a lagging ref read never decides how a rejected write is treated", () => {
  /** getRef and readEpoch for `ref` return `stale` for the next `n` reads (a replica that has not seen the last write). */
  function lag(f: ReturnType<typeof fencedFake>, ref: string, stale: string | null, n: number) {
    let left = n;
    const get = f.t.getRef.bind(f.t);
    const readEpoch = f.t.readEpoch.bind(f.t);
    f.t.getRef = async (b) => (b === ref && left-- > 0 ? stale : get(b));
    f.t.readEpoch = async () => (ref === QUEUE_EPOCH && left-- > 0 ? stale : readEpoch());
  }

  test("our epoch, read at the one before it: a rejected write is the GitHub error, not a lost lease", async () => {
    const f = fencedFake();
    const e0 = await takeEpoch(fenced(f.t, noFence), "previous tick");
    const e = await takeEpoch(fenced(f.t, noFence), "this tick");
    lag(f, QUEUE_EPOCH, e0, 99);
    const a = fenced(f.t, noFence, () => e, noFence);
    const err = await a.updateRef(NAMES.main, f.next, f.main).catch((x: unknown) => x); // main is not at f.next
    expect(err).toBeInstanceOf(GitHubError);
    expect(err).not.toBeInstanceOf(LostLockError);
  });

  test("a successor's epoch hidden by a lagging read: still a lost lease", async () => {
    const f = fencedFake();
    const eA = await takeEpoch(fenced(f.t, noFence), "A");
    await takeEpoch(fenced(f.t, noFence), "B");
    lag(f, QUEUE_EPOCH, eA, 99); // every read still shows A's epoch
    const a = fenced(f.t, noFence, () => eA, noFence);
    for (const [what, write] of everyRefWrite(a, "queue", f)) expect(await write().catch((x: unknown) => x), what).toBeInstanceOf(LostLockError);
  });

  test("a delete retry checks the lease again before it writes, and stops when the lease is gone", async () => {
    const f = fencedFake();
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    const old = f.t.refs.get(f.build)!;
    f.t.refs.set(f.build, f.t.commit([old], "merge"));
    lag(f, f.build, old, 99); // every read shows the previous commit
    let fences = 0;
    const fence = async () => {
      if (++fences > 2) throw new LostLockError("only 30s of lease left; not acting");
    };
    const a = fenced(f.t, fence, () => e, noFence);
    await expect(a.deleteRef(f.build)).rejects.toBeInstanceOf(LostLockError);
    expect(fences).toBe(3); // the call's own check, then one per retry until the lease is gone
    expect(f.t.refs.has(f.build)).toBe(true);
  });

  test("if the write path cannot be asked, a read that shows another epoch is still a lost lease, and a delete is not retried", async () => {
    const f = fencedFake();
    const eA = await takeEpoch(fenced(f.t, noFence), "A");
    await takeEpoch(fenced(f.t, noFence), "B");
    f.t.epochHeld = async () => {
      throw new GitHubError("network", null, "timeout");
    };
    const a = fenced(f.t, noFence, () => eA, noFence);
    await expect(a.updateRef(NAMES.main, f.main, f.next)).rejects.toBeInstanceOf(LostLockError);
    // Our epoch, and a read that agrees: ownership unknown, the original error, and no retry.
    const g = fencedFake();
    const e = await takeEpoch(fenced(g.t, noFence), "A");
    g.t.epochHeld = f.t.epochHeld;
    let sends = 0;
    const send = g.t.epochUpdateRefs.bind(g.t);
    g.t.epochUpdateRefs = async (w, x) => {
      sends++;
      if (w[0]!.after === ZERO_SHA) throw new GitHubError("validation", 200, "Something went wrong");
      return send(w, x);
    };
    const err = await fenced(g.t, noFence, () => e, noFence).deleteRef(g.build).catch((x: unknown) => x);
    expect(err instanceof GitHubError && err.kind).toBe("validation");
    expect(sends).toBe(1);
  });

  test("if the write path cannot be asked, the original error stands (never a guessed lost lease)", async () => {
    const f = fencedFake();
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    f.t.epochHeld = async () => {
      throw new GitHubError("network", null, "timeout");
    };
    const a = fenced(f.t, noFence, () => e, noFence);
    const err = await a.updateRef(NAMES.main, f.next, f.main).catch((x: unknown) => x);
    expect(err instanceof GitHubError && err.kind).not.toBe("network");
    expect(err).not.toBeInstanceOf(LostLockError);
  });

  test("a build ref read at its previous commit (just merged into) is still deleted: re-read and retried", async () => {
    const f = fencedFake();
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    const old = f.t.refs.get(f.build)!;
    const merged = f.t.commit([old], "merge");
    f.t.refs.set(f.build, merged);
    lag(f, f.build, old, 1);
    const waits: number[] = [];
    const a = fenced(f.t, noFence, () => e, async (ms) => { waits.push(ms); });
    await a.deleteRef(f.build);
    expect(f.t.refs.has(f.build)).toBe(false);
    expect(waits.length).toBeGreaterThan(0);
  });

  test("a ref that reads as absent for a moment (just created) is not skipped as already gone", async () => {
    const f = fencedFake();
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    lag(f, f.build, null, 1);
    const a = fenced(f.t, noFence, () => e, noFence);
    await a.deleteRef(f.build);
    expect(f.t.refs.has(f.build)).toBe(false);
  });

  test("a create refused for another reason is not called a conflict because a lagging read shows a deleted ref", async () => {
    const f = fencedFake();
    const e = await takeEpoch(fenced(f.t, noFence), "A");
    const ref = `${NAMES.queuePrefix}8`;
    lag(f, ref, f.main, 1); // a read still shows a ref deleted a moment ago
    f.t.epochUpdateRefs = async () => {
      throw new GitHubError("validation", 422, "Repository rule violations found");
    };
    const a = fenced(f.t, noFence, () => e, noFence);
    const err = await a.createRef(ref, f.next).catch((x: unknown) => x);
    expect(err instanceof GitHubError && err.kind).toBe("validation");
  });
});
