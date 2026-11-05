// With the review requirement off, `ready` is applied by a write-access account
// after a review held outside CI. The producer-bound review adapter stays, switched off by config.

import { describe, expect, test } from "bun:test";
import { admit } from "../src/admission";
import { defaultConfig } from "../src/config";
import { buildSnapshot } from "../src/snapshot";
import { emptyState } from "../src/state";
import { FakeTarget } from "./fake-github";
import { cfg, job, livePr, HUMAN } from "./sim";

const NOW = new Date("2026-10-21T12:00:00Z");

function pr(f: FakeTarget, n: number, o: { actor?: string; fastJob?: string } = {}) {
  const p = f.addPr(n);
  p.events = [{ id: 1, actor: o.actor ?? HUMAN, at: "2026-10-21T10:00:00Z" }];
  f.addRun({ head_sha: p.pr.head.sha, event: "pull_request", head_branch: p.pr.head.ref }, [job(o.fastJob ?? "fast")]);
  return p;
}

const snap = (f: FakeTarget, c = cfg()) => buildSnapshot({ api: f, cfg: c, state: emptyState(), now: NOW, paused: false, policyHash: "p" });

describe("v1 admission: ready from a write-access user, fast lane green, no review evidence", () => {
  test("the default config does not require producer-bound review evidence", () => {
    expect(defaultConfig.reviewRequired).toBe(false);
    expect(defaultConfig.fastLane.job).toBe("fast");
  });

  test("ready by a write-access user with a green `fast` and no review run is admitted", async () => {
    const f = new FakeTarget();
    f.permissions.set(HUMAN, "admin");
    pr(f, 1);
    const s = await snap(f);
    expect(s.prs["1"]!.review.ok).toBe(true);
    expect(admit(s.prs["1"]!, cfg())).toEqual({ ok: true });
  });

  test("ready applied by the review bot (no write access) is not admitted", async () => {
    const f = new FakeTarget();
    pr(f, 1, { actor: "github-actions[bot]" });
    expect(admit((await snap(f)).prs["1"]!, cfg())).toMatchObject({ ok: false, kind: "ignore" });
  });

  test("the fast lane is the job named `fast`; a job named `Fast` does not count", async () => {
    const f = new FakeTarget();
    f.permissions.set(HUMAN, "admin");
    pr(f, 1, { fastJob: "Fast" });
    expect((await snap(f)).prs["1"]!.fastLane.ok).toBe(false);
  });

  test("switched on by config, the producer-bound review is required again", async () => {
    const on = cfg({ reviewRequired: true });
    const f = new FakeTarget();
    f.permissions.set(HUMAN, "admin");
    pr(f, 1);
    const s = await snap(f, on);
    expect(s.prs["1"]!.review.ok).toBe(false);
    expect(admit(s.prs["1"]!, on)).toMatchObject({ ok: false, kind: "wait" });
    // and the producer's own ready is accepted only in that mode
    expect(admit(livePr(2, { ready: { actorLogin: "github-actions[bot]", actorPermission: "none", at: "t" } }), on)).toEqual({ ok: true });
    expect(admit(livePr(2, { ready: { actorLogin: "github-actions[bot]", actorPermission: "none", at: "t" } }), cfg())).toMatchObject({ ok: false });
  });
});
