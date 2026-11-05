// GitHub's generic GraphQL error: HTTP 200, no `type`, "Something went wrong
// while executing your query on <time>. Please include `<id>` ...". It is an
// internal fault, and in the same words a refused updateRefs, so it retries next
// tick, a repeat pauses the queue, and whatever needs a refusal still sees one.

import { describe, expect, test } from "bun:test";
import { GitHubError, Http, isGraphqlInternal } from "../src/github/http";
import { isRemoteRefusal } from "../src/sandbox/checks";
import { takeEpoch } from "../src/fenced";
import { INTERNAL_ERROR_WINDOW_MS } from "../src/queue";
import type { TargetApi } from "../src/github/api";
import { epochBranchFor } from "../src/config/runner";
import { BASE_CONFIG, sha } from "./sim";
import { ReleaseWorld } from "./release-world";
import { World } from "./world";

const WORDS = "Something went wrong while executing your query on 2030-01-02T03:04:05Z. Please include `AAAA:BBBB:CCCC` when reporting this issue.";

async function classified(errors: unknown[], mutation = true): Promise<GitHubError> {
  const http = new Http({ token: "t", fetch: (async () => Response.json({ errors })) as unknown as typeof fetch });
  return http.graphql("q", {}, mutation).then(
    () => {
      throw new Error("expected an error");
    },
    (e) => e as GitHubError,
  );
}

/** What the real client throws, by way of the real classifier. */
const internal = () => classified([{ message: WORDS }]);

/** The next `n` state writes fail with GitHub's generic error, with the ref unmoved. */
function failStateWrites(w: World, n: number, e: GitHubError) {
  const cas = w.stateRef.cas.bind(w.stateRef);
  w.stateRef.cas = async (before, text) => {
    if (n-- > 0) throw e;
    return cas(before, text);
  };
}

const pauseBody = (w: World) => w.repo.issues.find((i) => i.labels.includes(w.config.names.controlLabels.pause))?.body ?? "";

describe("classification", () => {
  test("GitHub's words with no type are transient, on a query and on a mutation, and are never retried in place", async () => {
    for (const mutation of [true, false]) {
      let calls = 0;
      const http = new Http({
        token: "t",
        sleep: async () => {},
        fetch: (async () => {
          calls++;
          return Response.json({ errors: [{ message: WORDS }] });
        }) as unknown as typeof fetch,
      });
      const e = (await http.graphql("q", {}, mutation).catch((x) => x)) as GitHubError;
      expect(e.kind).toBe("server");
      expect(isGraphqlInternal(e)).toBe(true);
      expect(calls).toBe(1);
    }
  });

  test("any other untyped error stays a hard failure", async () => {
    for (const message of ["Something went wrong", "Resource not accessible", `x ${WORDS}`, "Something went wrong while executing your queryset"]) {
      const e = await classified([{ message }]);
      expect(e.kind, message).toBe("validation");
      expect(isGraphqlInternal(e), message).toBe(false);
    }
  });

  test("the words with a type, or beside a different error, keep the old classification", async () => {
    expect((await classified([{ type: "FORBIDDEN", message: WORDS }])).kind).toBe("auth");
    expect((await classified([{ type: "OTHER", message: WORDS }])).kind).toBe("validation");
    expect((await classified([{ message: WORDS }, { message: "Resource not accessible" }])).kind).toBe("validation");
  });

  test("a real 5xx is transient but not this error", () => {
    expect(isGraphqlInternal(new GitHubError("server", 502, "bad gateway"))).toBe(false);
    expect(isGraphqlInternal(new GitHubError("server", 200, "GraphQL response has no data"))).toBe(false);
  });
});

describe("what needs a refusal still sees one", () => {
  test("the sandbox counts it as GitHub refusing the write; a 5xx it does not", async () => {
    expect(isRemoteRefusal(await internal())).toBe(true);
    expect(isRemoteRefusal(new GitHubError("server", 502, "bad gateway"))).toBe(false);
  });

  test("a rejected epoch advance is a conflict, as a stale beforeOid must be: never counted, never a pause", async () => {
    const E = sha("E");
    const e = await internal();
    const target = {
      readEpoch: async () => E,
      advanceEpoch: async () => {
        throw e;
      },
    } as unknown as TargetApi;
    expect(await takeEpoch(target, "r").catch((x) => (x as GitHubError).kind)).toBe("conflict");
  });
});

describe("in a journalled build", () => {
  test("the write that records the build fails: the lease release records it, the next tick finishes it, with no pause and nothing landed meanwhile", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick(); // lists catch up
    const merge = w.target.merge.bind(w.target);
    let merged = false;
    w.target.merge = async (...a) => {
      const r = await merge(...a);
      merged = true;
      return r;
    };
    // The intent is written and the merge made; the next state write is the one that fails.
    const cas = w.stateRef.cas.bind(w.stateRef);
    const e = await internal();
    let failures = 0;
    w.stateRef.cas = async (before, text) => {
      if (merged && failures === 0) {
        failures++;
        throw e;
      }
      return cas(before, text);
    };
    const main = w.target.refs.get(w.config.names.main)!;
    expect(await w.tick()).toMatchObject({ outcome: "retry-later" });
    expect(failures).toBe(1);
    expect(w.state().internalErrors).toHaveLength(1);
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([]);
    expect(w.target.refs.get(w.config.names.main)).toBe(main);
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
  });

  test("no state write gets through for the rest of the tick: the job fails, the next tick recovers and rebuilds, with no pause, and it lands once", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick();
    const merge = w.target.merge.bind(w.target);
    let merges = 0;
    w.target.merge = async (...a) => {
      merges++;
      return merge(...a);
    };
    const e = await internal();
    const cas = w.stateRef.cas.bind(w.stateRef);
    let failing = true;
    w.stateRef.cas = async (before, text) => {
      if (merges > 0 && failing) throw e;
      return cas(before, text);
    };
    await expect(w.tick()).rejects.toThrow("Something went wrong");
    failing = false;
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(merges).toBe(2);
    expect(w.landed()).toEqual([[1]]);
  });

  test("a merge fails with the error, part way through the build: the next tick aborts and rebuilds it", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick();
    const merge = w.target.merge.bind(w.target);
    const e = await internal();
    let fail = true;
    w.target.merge = async (...a) => {
      if (fail) {
        fail = false;
        throw e;
      }
      return merge(...a);
    };
    expect(await w.tick()).toMatchObject({ outcome: "retry-later" });
    expect(w.state().journal).not.toBeNull();
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
  });

  test("the queue ref's create fails with the error: recovery finishes the recorded build, and it lands once", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick();
    const create = w.target.createRef.bind(w.target);
    const e = await internal();
    let fail = true;
    w.target.createRef = async (b, s) => {
      if (fail && b.startsWith(w.config.names.queuePrefix)) {
        fail = false;
        throw e;
      }
      return create(b, s);
    };
    expect(await w.tick()).toMatchObject({ outcome: "retry-later" });
    expect(w.paused()).toBe(false);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
    expect(w.paused()).toBe(false);
  });
});

describe("with the epoch fence on", () => {
  const ON = { runner: { ...BASE_CONFIG.runner, epochFence: true } };

  test("a build's ref write fails with the error while the epoch is still ours: retried next tick, no pause, and it lands once", async () => {
    const w = new World(() => "pass", ON);
    w.target.epochBranch = epochBranchFor(ON.runner, "queue");
    w.readyPr(1);
    await w.tick();
    const write = w.target.epochUpdateRefs.bind(w.target);
    const e = await internal();
    let fail = true;
    w.target.epochUpdateRefs = async (writes, epoch) => {
      if (fail && writes.some((x) => x.branch.startsWith(w.config.names.queuePrefix))) {
        fail = false;
        throw e;
      }
      return write(writes, epoch);
    };
    expect(await w.tick()).toMatchObject({ outcome: "retry-later" });
    expect(w.state().internalErrors).toHaveLength(1);
    await w.runUntilIdle();
    expect(w.paused()).toBe(false);
    expect(w.landed()).toEqual([[1]]);
  });

  test("the same words after a successor took the epoch are a lost lease, not a fault: nothing is counted", async () => {
    const w = new World(() => "pass", ON);
    w.target.epochBranch = epochBranchFor(ON.runner, "queue");
    w.readyPr(1);
    await w.tick();
    const e = await internal();
    w.target.epochUpdateRefs = async () => {
      throw e;
    };
    w.target.epochHeld = async () => false;
    expect(await w.tick()).toMatchObject({ outcome: "lost-lock" });
    expect(w.state().internalErrors).toBeUndefined();
    expect(w.paused()).toBe(false);
  });
});

describe("repeats surface", () => {
  test("every build failing with the error pauses at maxOpTries, with the error in the reason, and nothing lands", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick();
    const e = await internal();
    w.target.merge = async () => {
      throw e;
    };
    const outcomes: unknown[] = [];
    for (let i = 0; i < w.config.maxOpTries; i++) outcomes.push(((await w.tick()) as { outcome: string }).outcome);
    expect(outcomes).toEqual(["retry-later", "retry-later", "paused"]);
    expect(pauseBody(w)).toContain("Something went wrong");
    expect(pauseBody(w)).toContain(`${w.config.maxOpTries} times`);
    expect(w.landed()).toEqual([]);
    expect(w.state().internalErrors).toBeUndefined(); // a person resuming starts from zero
  });

  test("a landing CAS refused in the same words retries, judged by the ref, then pauses; main never moves", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    const main = w.target.refs.get(w.config.names.main)!;
    const e = await internal();
    w.target.updateRef = async () => {
      throw e;
    };
    const outcomes: unknown[] = [];
    for (let i = 0; i < 30 && !w.paused(); i++) outcomes.push(((await w.tick()) as { outcome: string }).outcome);
    expect(outcomes.slice(-3)).toEqual(["retry-later", "retry-later", "paused"]);
    expect(w.state().journal?.op.kind).toBe("land");
    expect(pauseBody(w)).toContain("Something went wrong");
    expect(w.target.refs.get(w.config.names.main)).toBe(main);
    expect(w.landed()).toEqual([]);
  });

  test("a landing that applied, answered with the error and read back stale is still recorded as landed, by the journal", async () => {
    const w = new World();
    w.readyPr(1);
    await w.untilBuilt();
    const main = w.target.refs.get(w.config.names.main)!;
    const e = await internal();
    const update = w.target.updateRef.bind(w.target);
    const getRef = w.target.getRef.bind(w.target);
    let lag = false;
    w.target.updateRef = async (b, x, y) => {
      await update(b, x, y);
      w.target.updateRef = update;
      lag = true;
      throw e;
    };
    w.target.getRef = async (b) => {
      if (lag && b === w.config.names.main) {
        lag = false;
        return main;
      }
      return getRef(b);
    };
    for (let i = 0; i < 20 && w.landed().length === 0; i++) await w.tick();
    expect(w.landed()).toEqual([[1]]);
    expect(w.paused()).toBe(false);
  });

  test("a notice deferred on the error is counted, and the pause behind it is still opened", async () => {
    const w = new World();
    w.readyPr(1);
    const e = await internal();
    w.target.deleteRef = async () => {
      throw e;
    };
    for (let i = 0; i < 40 && !w.paused(); i++) await w.tick();
    expect(w.paused()).toBe(true);
    expect(pauseBody(w)).toContain("Something went wrong");
  });

  test("the lease release fails with the error: the job fails, as the count could not be recorded", async () => {
    const w = new World();
    await w.tick();
    const e = await internal();
    const cas = w.stateRef.cas.bind(w.stateRef);
    let writes = 0;
    w.stateRef.cas = async (before, text) => {
      if (++writes === 1) return cas(before, text); // the lease is taken
      throw e;
    };
    await expect(w.tick()).rejects.toThrow("Something went wrong");
  });

  test("taking the lease fails with the error: the job fails, so the watchdog's ticks-failing sees it; there is nowhere to record a count", async () => {
    const w = new World();
    w.readyPr(1);
    await w.tick();
    failStateWrites(w, 1, await internal());
    await expect(w.tick()).rejects.toThrow("Something went wrong");
    expect(w.paused()).toBe(false);
    await w.runUntilIdle();
    expect(w.landed()).toEqual([[1]]);
  });

  test("the window slides: only errors in the last hour count, and older ones go from the state", async () => {
    const w = new World();
    await w.tick();
    const ago = (m: number) => new Date(w.now.getTime() - m * 60_000).toISOString();
    const withErrors = (times: string[]) => {
      w.stateRef.current!.text = JSON.stringify({ ...JSON.parse(w.stateRef.current!.text), internalErrors: times });
    };
    withErrors([ago(INTERNAL_ERROR_WINDOW_MS / 60_000 + 5)]);
    await w.tick();
    expect(w.state().internalErrors).toBeUndefined();

    // An hour-old error falls out while the two after it still count: the next one is the third.
    w.readyPr(1);
    await w.tick();
    const e = await internal();
    w.target.merge = async () => {
      throw e;
    };
    withErrors([ago(90), ago(20), ago(10)]);
    expect(await w.tick()).toMatchObject({ outcome: "paused" });
    expect(w.state().internalErrors).toBeUndefined(); // a person resuming starts from zero
  });

  test("the state keeps the count, and refuses a malformed one", async () => {
    const w = new World();
    await w.tick();
    const raw = JSON.parse(w.stateRef.current!.text);
    for (const bad of [[], ["x"], { count: 1 }, [1]]) {
      w.stateRef.current!.text = JSON.stringify({ ...raw, internalErrors: bad });
      expect(() => w.state()).toThrow("internalErrors");
    }
    w.stateRef.current!.text = JSON.stringify({ ...raw, internalErrors: ["2030-01-01T00:00:00Z"] });
    expect(w.state().internalErrors).toEqual(["2030-01-01T00:00:00Z"]);
  });
});

describe("the release job", () => {
  test("keeps no count, so it still pauses on the error", async () => {
    const w = new ReleaseWorld();
    w.qualified(w.land());
    const e = await internal();
    w.target.updateRef = async () => {
      throw e;
    };
    expect((await w.ok()).outcome).toBe("rejected");
    expect(w.issues("release-pause")).toHaveLength(1);
  });
});
