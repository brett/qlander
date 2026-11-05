// Contract tests: the real client's parsing and the fake must agree on the
// shapes and orderings the rest of qlander relies on (review #7), and the
// fake must model GitHub's own semantics underneath the shared guards (#1).

import { describe, expect, test } from "bun:test";
import type { TargetApi } from "../src/github/api";
import { TargetClient } from "../src/github/target";
import { FakeTarget } from "./fake-github";
import { TARGET, sha, TARGET_OPTS, pathRe, TARGET_SLUG, NAMES } from "./sim";

const ZERO = "0".repeat(40);

/** base → A → B, where A is signed and B is not, each touching one file. */
async function realWith(base: string, a: string, b: string): Promise<TargetApi> {
  const raw = (s: string, parent: string, verified: boolean) => ({ sha: s, parents: [{ sha: parent }], commit: { verification: { verified } } });
  const body = {
    status: "ahead",
    ahead_by: 2,
    behind_by: 0,
    commits: [raw(a, base, true), raw(b, a, false)], // GitHub: chronological, oldest first
    files: [{ filename: "app/a.py" }, { filename: "docs/new.md", previous_filename: ".github/workflows/old.yml" }],
  };
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    if (pathRe(`/repos/${TARGET_SLUG}`).test(url)) return new Response(JSON.stringify({ id: TARGET, node_id: "R" }));
    if (url.includes(`/compare/${base}...${b}`)) return new Response(JSON.stringify(body));
    return new Response(JSON.stringify({ message: "unrouted" }), { status: 599 });
  }) as typeof fetch;
  return TargetClient.connect({ ...TARGET_OPTS, token: "t", owner: NAMES.target.owner, repo: NAMES.target.name, repoId: TARGET, role: "read", fetch: fetchFn });
}

function fakeWith(): { api: FakeTarget; base: string; a: string; b: string } {
  const api = new FakeTarget();
  const base = api.refs.get("main")!;
  const a = api.commit([base], "A", true, ["app/a.py"]);
  const b = api.commit([a], "B", false, ["docs/new.md", ".github/workflows/old.yml"]);
  return { api, base, a, b };
}

describe("compare contract (#7)", () => {
  test("fake: commits oldest first, with signatures and every file", async () => {
    const { api, base, a, b } = fakeWith();
    const c = await api.compare(base, b);
    expect(c.status).toBe("ahead");
    expect(c.commits.map((x) => x.sha)).toEqual([a, b]);
    expect(c.commits.map((x) => x.verified)).toEqual([true, false]);
    expect(c.files.sort()).toEqual([".github/workflows/old.yml", "app/a.py", "docs/new.md"]);
  });

  test("real client: the same order, signatures, and renames under both names", async () => {
    const base = sha("base");
    const a = sha("A");
    const b = sha("B");
    const c = await (await realWith(base, a, b)).compare(base, b);
    expect(c.commits.map((x) => x.sha)).toEqual([a, b]);
    expect(c.commits.map((x) => x.verified)).toEqual([true, false]);
    expect(c.files.sort()).toEqual([".github/workflows/old.yml", "app/a.py", "docs/new.md"]);
    expect(c.truncated).toBe(false);
  });

  test("fake: behind, diverged and identical", async () => {
    const { api, base, a } = fakeWith();
    const side = api.commit([base], "side");
    expect((await api.compare(a, base)).status).toBe("behind");
    expect((await api.compare(a, side)).status).toBe("diverged");
    expect((await api.compare(a, a)).status).toBe("identical");
  });
});

describe("GitHub's zero-OID semantics in the fake (#1)", () => {
  test("below the guard, a zero afterOid deletes and a zero beforeOid demands absence", async () => {
    const f = new FakeTarget("queue");
    const main = f.refs.get("main")!;
    f.githubUpdateRefs("main", main, ZERO);
    expect(f.refs.has("main")).toBe(false);
    f.githubUpdateRefs("main", ZERO, main);
    expect(f.refs.get("main")).toBe(main);
    expect(() => f.githubUpdateRefs("main", ZERO, main)).toThrow("beforeOid does not match");
  });

  test("through the guard (as the clients do), zero OIDs never reach GitHub", async () => {
    const f = new FakeTarget("queue");
    const main = f.refs.get("main")!;
    await expect(f.updateRef("main", main, ZERO)).rejects.toThrow("not a real object id");
    await expect(f.updateRef("main", ZERO, main)).rejects.toThrow("not a real object id");
    expect(f.refs.get("main")).toBe(main);
  });
});
