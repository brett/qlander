// verify-sandbox, experiment H1 checks 2 to 4 (docs/deployment.md §3.4): the
// epoch branches, protected by an `epoch-write` ruleset per branch (bypass:
// only the owning App) and an `epoch-integrity` ruleset (non-fast-forward and
// deletion, no bypass at all).
//
//   2. The owning App advances its epoch (E1, then E2, fast-forward) and
//      includes the unchanged {epoch E2→E2} in combined updateRefs calls with
//      the refs it writes. They land.
//   3. Every attempt to put the epoch back to E1 is refused, whoever makes it:
//      the owning App (updateRefs force true, PATCH force true, delete and
//      re-create), the other Apps, and an org admin (the same, plus git push
//      --force). Then a stale {epoch E1→E1, ...} call is refused and nothing
//      moves.
//   4. No workflow run exists for an epoch commit.
//
// A job holds one App's key at a time, so the checks are split by identity:
//   queue    the queue App (and the state App): the queue epoch, and G1
//   release  the release App: the release epoch, and the queue epoch as the other App
//   cross    the queue App: the release epoch as the other App
//   admin    an org admin's token, run by hand: both epochs, and the rulesets
// Each phase reads E2 from the branch and E1 as E2's parent, so later phases
// attack the epochs earlier ones made. The writes of check 2 go through the
// production TargetClient (advanceEpoch, epochUpdateRefs); the attempts go
// through SandboxRepo, because the production client refuses them locally.

import type { Names } from "../config";
import { GitHubError, Http } from "../github/http";
import { EMPTY_TREE, TargetClient } from "../github/target";
import type { RefUpdate } from "../github/api";
import { queueRef, ZERO_SHA } from "../validate";
import { Abort, describeError, PushRejected, type Recorder } from "./checks";
import type { HttpBase } from "./g1";
import { current, holds, type ReadTiming, type Sandbox, SandboxRepo, settle } from "./repo";

/** An org admin's git push, as `git push --force <sandbox> <sha>:refs/heads/<branch>`. Throws PushRejected when the remote rejects it. */
export interface Pusher {
  forcePush(branch: string, sha: string): Promise<void>;
}

export interface H1Options {
  sandbox: Sandbox;
  names: Names;
  epochQueue: string;
  epochRelease: string;
  http?: HttpBase;
  /** Check 4 waits at least this long after the last epoch advance before listing runs (default 30 s). */
  runsWaitMs?: number;
  now?: () => number;
  /** How reads after a write wait out GitHub's read-after-write lag (src/sandbox/repo.ts). */
  read?: ReadTiming;
}

type Raw = SandboxRepo;

/** After a write that should have landed: `branch` reaches `want` (polled through the read lag). */
const reaches = (raw: Raw, branch: string, want: string | null, t: ReadTiming) => async (): Promise<string[]> => (await settle(branch, () => raw.ref(branch), want, t)).problems;

/** After a write that must not have landed: `branch` is still at `want`, proved by `prover` (an identity allowed to write it) or held across the window. */
const stays = (raw: Raw, branch: string, want: string | null, t: ReadTiming, prover?: Raw) => (): Promise<string[]> =>
  holds(branch, () => raw.ref(branch), want, t, prover ? { repo: prover, branch } : undefined);

/** E2 (the epoch now, confirmed) and E1 (its first parent), or why they cannot be read. */
async function currentPair(raw: Raw, epoch: string, t: ReadTiming, prover?: Raw): Promise<{ e1: string; e2: string } | string> {
  const e2 = await current(epoch, () => raw.ref(epoch), t, prover ? { repo: prover, branch: epoch } : undefined);
  if (e2 === null) return `${epoch} does not exist (run the phase that creates it first)`;
  const parent = (await raw.commit(e2)).parents[0];
  if (parent === undefined) return `${epoch} is at a root commit: no E1 to reset to`;
  return { e1: parent, e2 };
}

/**
 * A reset attempt counts as refused only when GitHub refused the write itself
 * (a 4xx rule or validation error, or an untyped GraphQL error). A 401, 403 or
 * 404 means the token could not make the attempt at all, which says nothing
 * about the rulesets, so it is reported as an error, never a refusal.
 */
function byRules(act: () => Promise<unknown>): () => Promise<unknown> {
  return async () => {
    try {
      return await act();
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === "auth" || e.kind === "not_found")) throw new Error(`not a ruleset refusal (the token could not make the attempt): ${e.message}`);
      throw e;
    }
  };
}

/**
 * The reset attempts of check 3 against `epoch` at E2: each must be refused,
 * and afterwards the branch must still read E2 (`observer` reads it).
 * `ids` name the checks in order: updateRefs force, PATCH force, [git push
 * --force], delete, re-create (only if the delete went through).
 */
async function resetAttempts(
  rec: Recorder,
  ids: { force: string; patch?: string; push?: string; del: string; recreate?: string },
  attacker: Raw,
  observer: Raw,
  epoch: string,
  pair: { e1: string; e2: string },
  t: ReadTiming,
  o: { pusher?: Pusher; restore?: Raw; prover?: Raw } = {},
): Promise<void> {
  const { e1, e2 } = pair;
  const { pusher, restore, prover } = o;
  const still = stays(observer, epoch, e2, t, prover);
  // Without an owner to prove E2, it is a read held stable for the window: a run's earlier phase advanced it, minutes
  // before, so a lag that long is not expected, but it is not proved (an attempt from a stale E2 would be refused for that).
  const ev = {
    branch: epoch,
    E1: e1,
    E2: e2,
    baseline: prover ? "E2 proved by the owner's no-op updateRefs" : `E2 unproven: every read for ${t.windowMs ?? 10_000} ms agreed`,
    proof: prover ? "no-op updateRefs by the owner" : `every read for ${t.windowMs ?? 10_000} ms`,
  };
  await rec.refused(ids.force, byRules(() => attacker.updateRefs([{ branch: epoch, before: e2, after: e1, force: true }])), still, ev);
  if (ids.patch) await rec.refused(ids.patch, byRules(() => attacker.patchRef(epoch, e1, true)), still, ev);
  if (ids.push) await rec.refused(ids.push, () => pusher!.forcePush(epoch, e1), still, ev);
  await rec.refused(ids.del, byRules(() => attacker.deleteRef(epoch)), still, ev);
  if (!ids.recreate) return;
  // Confirmed, not a single read: a lagging read must not make a refused delete look like a deletion, or the reverse.
  const now = await current(epoch, () => observer.ref(epoch), t, prover ? { repo: prover, branch: epoch } : undefined);
  if (now === e2) {
    rec.skip(ids.recreate, "the delete was refused: the branch is still at E2, so there is nothing to re-create", true, ev);
    return;
  }
  if (now !== null) {
    rec.skip(ids.recreate, `${epoch} moved to ${now}`, false, ev);
    return;
  }
  await rec.refused(ids.recreate, byRules(() => attacker.createRef(epoch, e1)), stays(observer, epoch, e2, t, prover), ev);
  // The epoch was deleted: put it back at E2 if this identity may (the owner), so later phases still have it.
  if (restore && (await observer.ref(epoch)) !== e2) {
    await (async () => {
      const r = await observer.ref(epoch);
      if (r === null) await restore.createRef(epoch, e2);
      else await restore.updateRefs([{ branch: epoch, before: r, after: e2, force: true }]);
    })().catch((e) => console.log(`could not restore ${epoch} to ${e2}: ${describeError(e)}`));
  }
}

/** Check 2's advance: E1 (a root commit when the branch is absent), then E2, each a fast-forward through the production client. */
async function advance(rec: Recorder, p: string, client: TargetClient, raw: Raw, epoch: string, label: string, t: ReadTiming): Promise<{ e1: string; e2: string }> {
  // The epoch now, confirmed by the owner's no-op updateRefs: a lagging read would make the advance fail.
  const before = await current(epoch, () => client.readEpoch(), t, { repo: raw, branch: epoch });
  const isChild = (c: string, parent: string | null) => async () => {
    const seen = await settle(epoch, () => raw.ref(epoch), c, t);
    const commit = await raw.commit(c);
    const problems = [
      ...seen.problems,
      ...(commit.tree === EMPTY_TREE ? [] : [`${c} has tree ${commit.tree}, not the empty tree`]),
      ...(JSON.stringify(commit.parents) === JSON.stringify(parent === null ? [] : [parent]) ? [] : [`${c} has parents ${JSON.stringify(commit.parents)}`]),
    ];
    return { evidence: { branch: epoch, commit: c, parents: commit.parents, readLagMs: seen.lagMs }, problems };
  };
  const e1 = rec.need(await rec.ok(`${p}1`, () => client.advanceEpoch(before, `verify-sandbox ${label} E1`), (c) => isChild(c, before)()), `${epoch} E1`);
  const e2 = rec.need(await rec.ok(`${p}2`, () => client.advanceEpoch(e1, `verify-sandbox ${label} E2`), (c) => isChild(c, e1)()), `${epoch} E2`);
  return { e1, e2 };
}

/** One combined write {epoch E→E, write}; for check 2 it must land, for the stale call it must be refused. */
const combined = (client: TargetClient, writes: RefUpdate[], epoch: string) => () => client.epochUpdateRefs(writes, epoch);

/**
 * A stale call {epoch E1→E1, writes}: GitHub must refuse it with nothing
 * moved; then the identical writes with the current E2 must land. That
 * control shows the stale epoch was the only reason for the refusal.
 */
async function stale(
  rec: Recorder,
  id: string,
  client: TargetClient,
  writes: RefUpdate[],
  pair: { e1: string; e2: string },
  unmoved: () => Promise<string[]>,
  landed: () => Promise<string[]>,
  ev: Record<string, unknown>,
): Promise<void> {
  await rec.refused(id, byRules(combined(client, writes, pair.e1)), async () => {
    const moved = await unmoved();
    if (moved.length > 0) return moved;
    try {
      await client.epochUpdateRefs(writes, pair.e2);
    } catch (e) {
      return [`control: the same writes with E2 were refused too (${describeError(e)}), so this refusal does not show the epoch fence`];
    }
    return (await landed()).map((p) => `control: ${p}`);
  }, { ...ev, control: "the same writes with E2 land" });
}

/** Check 4: no run for any of `shas`, listed once at least `runsWaitMs` has passed since `since`. */
async function noRuns(rec: Recorder, id: string, raw: Raw, shas: string[], o: H1Options, since: number): Promise<void> {
  const now = o.now ?? Date.now;
  const wait = (o.runsWaitMs ?? 30_000) - (now() - since);
  const sleep = o.http?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const list = async () => Object.fromEntries(await Promise.all(shas.map(async (s) => [s, await raw.runsFor(s)] as const)));
  // Two observations, at least runsWaitMs apart, the first at least runsWaitMs after the last advance.
  await rec.ok(
    id,
    async () => {
      if (wait > 0) await sleep(wait);
      const first = { afterMs: now() - since, runs: await list() };
      await sleep(o.runsWaitMs ?? 30_000);
      return [first, { afterMs: now() - since, runs: await list() }];
    },
    async (seen) => ({
      evidence: { observations: seen },
      problems: seen.flatMap((x) => Object.entries(x.runs).filter(([, n]) => n !== 0).map(([s, n]) => `${n} workflow run(s) for ${s} at +${x.afterMs} ms`)),
    }),
  );
}

function connectTarget(o: H1Options, token: string, role: "queue" | "release", epochBranch: string): Promise<TargetClient> {
  return TargetClient.connect({ ...(o.http ?? {}), token, owner: o.sandbox.owner, repo: o.sandbox.repo, repoId: o.sandbox.repoId, names: o.names, dataFiles: [], role, epochBranch });
}
const connectRaw = (o: H1Options, token: string) => SandboxRepo.connect({ ...(o.http ?? {}), token, ...o.sandbox });

async function guarded(what: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (e) {
    console.log(`H1 ${what} ${e instanceof Abort ? "ABORT" : "ERROR"}: ${describeError(e)}`);
  }
}

/** The queue phase's H1 part (after G1): the queue App owns the queue epoch. */
export async function h1Queue(o: H1Options & { tokens: { queue: string; state: string }; n: { epoch: number; stale: number } }, rec: Recorder): Promise<void> {
  const n = o.names;
  const epoch = o.epochQueue;
  const k = queueRef(n, o.n.epoch);
  const j = queueRef(n, o.n.stale);
  const held: { raw: Raw | null } = { raw: null };
  let leftover: string | null = null;
  await guarded("queue", async () => {
    const raw = await connectRaw(o, o.tokens.queue);
    held.raw = raw;
    const client = await connectTarget(o, o.tokens.queue, "queue", epoch);
    const t = o.read ?? {};
    const { e1, e2 } = await advance(rec, "hq", client, raw, epoch, "queue", t);
    const since = (o.now ?? Date.now)();
    // main as it is now, confirmed (G1 just moved it; a lagging read would make the combined write fail).
    const M = rec.need((await current(n.main, () => raw.ref(n.main), t, { repo: raw, branch: n.main })) ?? undefined, n.main);
    const epochStays = stays(raw, epoch, e2, t, raw);
    const plus = (extra: () => Promise<string[]>) => async () => [...(await extra()), ...(await epochStays())];
    // Check 2: combined writes land.
    await rec.ok("hq3", async () => { leftover = k; await combined(client, [{ branch: k, before: ZERO_SHA, after: M }], e2)(); return true; }, async () => ({ evidence: { ref: k, at: M, epoch: e2 }, problems: await plus(reaches(raw, k, M, t))() }));
    const M1 = await raw.childCommit(M, `verify-sandbox ${o.n.epoch}: an epoch-fenced fast-forward`);
    rec.need(await rec.ok("hq4", async () => { await combined(client, [{ branch: n.main, before: M, after: M1 }], e2)(); return true; }, async () => ({ evidence: { main: M1, epoch: e2 }, problems: await plus(reaches(raw, n.main, M1, t))() })), `${n.main} at M'`);
    if (await rec.ok("hq5", async () => { await combined(client, [{ branch: k, before: M, after: ZERO_SHA }], e2)(); return true; }, async () => ({ evidence: { ref: k }, problems: await plus(reaches(raw, k, null, t))() }))) leftover = null;
    // Check 3: the owner's own reset attempts.
    await resetAttempts(rec, { force: "hq6", patch: "hq7", del: "hq8", recreate: "hq9" }, raw, raw, epoch, { e1, e2 }, t, { restore: raw, prover: raw });
    // Then the stale calls: nothing moves.
    const M2 = await raw.childCommit(M1, `verify-sandbox ${o.n.epoch}: a stale-epoch probe (must never land)`);
    await stale(rec, "hq10", client, [{ branch: n.main, before: M1, after: M2 }], { e1, e2 }, plus(stays(raw, n.main, M1, t, raw)), reaches(raw, n.main, M2, t), { E1: e1, main: M1, probe: M2 });
    await stale(rec, "hq11", client, [{ branch: j, before: ZERO_SHA, after: M1 }], { e1, e2 }, plus(stays(raw, j, null, t)), reaches(raw, j, M1, t), { E1: e1, ref: j });
    // Another identity with Contents: write on the repo.
    const state = await connectRaw(o, o.tokens.state);
    await rec.refused("hq12", byRules(() => state.updateRefs([{ branch: epoch, before: e2, after: e1, force: true }])), epochStays, { E1: e1, E2: e2 });
    // Check 4.
    await noRuns(rec, "hq13", raw, [e1, e2], o, since);
  });
  // Leftovers of a failed run: removed with a fenced delete when possible, not checked.
  const r = held.raw;
  if (r === null) return;
  for (const ref of [leftover, j]) {
    if (ref === null) continue;
    await (async () => {
      // Confirmed reads: a lagging read must not make a leftover look already gone.
      const t = o.read ?? {};
      const c = await current(ref, () => r.ref(ref), t, { repo: r, branch: ref });
      const e = await current(epoch, () => r.ref(epoch), t, { repo: r, branch: epoch });
      if (c && e) await (await connectTarget(o, o.tokens.queue, "queue", epoch)).epochUpdateRefs([{ branch: ref, before: c, after: ZERO_SHA }], e);
    })().catch((e) => console.log(`could not delete ${ref}: ${describeError(e)}`));
  }
}

/** The release phase: the release App owns the release epoch, and attacks the queue epoch as the other App. */
export async function h1Release(o: H1Options & { tokens: { release: string } }, rec: Recorder): Promise<void> {
  const n = o.names;
  const epoch = o.epochRelease;
  await guarded("release", async () => {
    const raw = await connectRaw(o, o.tokens.release);
    const client = await connectTarget(o, o.tokens.release, "release", epoch);
    const t = o.read ?? {};
    const { e1, e2 } = await advance(rec, "hr", client, raw, epoch, "release", t);
    const since = (o.now ?? Date.now)();
    let R = await current(n.release, () => raw.ref(n.release), t, { repo: raw, branch: n.release });
    if (R === null) {
      // Setup, not a check: the release branch starts at main.
      const M = rec.need((await raw.ref(n.main)) ?? undefined, n.main);
      await raw.createRef(n.release, M);
      console.log(`setup: created ${n.release} at ${M}`);
      R = M;
    }
    const epochStays = stays(raw, epoch, e2, t, raw);
    const plus = (extra: () => Promise<string[]>) => async () => [...(await extra()), ...(await epochStays())];
    const R1 = await raw.childCommit(R, "verify-sandbox: an epoch-fenced release advance");
    rec.need(await rec.ok("hr3", async () => { await combined(client, [{ branch: n.release, before: R, after: R1 }], e2)(); return true; }, async () => ({ evidence: { release: R1, epoch: e2 }, problems: await plus(reaches(raw, n.release, R1, t))() })), `${n.release} at R'`);
    await resetAttempts(rec, { force: "hr4", patch: "hr5", del: "hr6", recreate: "hr7" }, raw, raw, epoch, { e1, e2 }, t, { restore: raw, prover: raw });
    const R2 = await raw.childCommit(R1, "verify-sandbox: a stale-epoch probe (must never land)");
    await stale(rec, "hr8", client, [{ branch: n.release, before: R1, after: R2 }], { e1, e2 }, plus(stays(raw, n.release, R1, t, raw)), reaches(raw, n.release, R2, t), { E1: e1, release: R1, probe: R2 });
    // As the other App, against the queue epoch.
    const q = await currentPair(raw, o.epochQueue, t);
    if (typeof q === "string") {
      rec.skip("hr9", q, false);
      rec.skip("hr10", q, false);
    } else await resetAttempts(rec, { force: "hr9", del: "hr10" }, raw, raw, o.epochQueue, q, t);
    await noRuns(rec, "hr11", raw, [e1, e2], o, since);
  });
}

/** The cross phase: the queue App attacks the release epoch as the other App. */
export async function h1Cross(o: H1Options & { tokens: { queue: string } }, rec: Recorder): Promise<void> {
  await guarded("cross", async () => {
    const raw = await connectRaw(o, o.tokens.queue);
    const t = o.read ?? {};
    const r = await currentPair(raw, o.epochRelease, t);
    if (typeof r === "string") throw new Abort(r);
    await resetAttempts(rec, { force: "hc1", patch: "hc2", del: "hc3" }, raw, raw, o.epochRelease, r, t);
  });
}

interface RulesetSummary {
  id: number;
  name: string;
  rules: string[];
  bypass: { type: string; id: number | null }[];
}

/** Problems with the rulesets that apply to the two epoch branches (§3.4), read with an admin token. */
export async function rulesetProblems(http: Http, path: string, epochs: string[]): Promise<{ problems: string[]; seen: Record<string, RulesetSummary[]> }> {
  const problems: string[] = [];
  const seen: Record<string, RulesetSummary[]> = {};
  const writers: (number | null)[] = [];
  for (const branch of epochs) {
    const applied = (await http.request<{ type: string; ruleset_id: number }[]>("GET", `${path}/rules/branches/${branch}`)).json;
    const ids = [...new Set(applied.map((r) => r.ruleset_id))];
    const sets: RulesetSummary[] = [];
    for (const id of ids) {
      const rs = (await http.request<{ id: number; name: string; rules: { type: string }[]; bypass_actors: { actor_type: string; actor_id: number | null }[] }>("GET", `${path}/rulesets/${id}`)).json;
      sets.push({ id: rs.id, name: rs.name, rules: rs.rules.map((r) => r.type), bypass: (rs.bypass_actors ?? []).map((b) => ({ type: b.actor_type, id: b.actor_id })) });
    }
    seen[branch] = sets;
    const has = (s: RulesetSummary, rules: string[]) => rules.every((r) => s.rules.includes(r));
    const write = sets.filter((s) => has(s, ["creation", "update", "deletion"]) && s.bypass.length === 1 && s.bypass[0]!.type === "Integration");
    const integrity = sets.filter((s) => has(s, ["non_fast_forward", "deletion"]) && s.bypass.length === 0);
    if (write.length !== 1) problems.push(`${branch}: expected exactly one ruleset restricting creation, update and deletion with one App as its only bypass, found ${write.length}`);
    else writers.push(write[0]!.bypass[0]!.id);
    if (integrity.length === 0) problems.push(`${branch}: no ruleset blocks non-fast-forward and deletion without any bypass`);
    // Any other bypass on a ruleset that restricts writes would let that actor write the epoch.
    for (const s of sets) {
      if (write.includes(s) || s.bypass.length === 0) continue;
      if (s.rules.some((r) => ["creation", "update", "deletion", "non_fast_forward"].includes(r))) problems.push(`${branch}: ruleset ${s.name} (${s.id}) restricts writes but has bypass actors ${JSON.stringify(s.bypass)}`);
    }
  }
  if (writers.length === epochs.length && new Set(writers).size !== writers.length) problems.push(`the epoch branches share a bypass App (${writers.join(", ")}): each must have its own owner`);
  return { problems, seen };
}

/** The admin phase, run by hand with an org admin's token: the rulesets, then every admin reset attempt, then check 4 again. */
export async function h1Admin(o: H1Options & { tokens: { admin: string }; pusher: Pusher }, rec: Recorder): Promise<void> {
  await guarded("admin", async () => {
    const raw = await connectRaw(o, o.tokens.admin);
    const epochs = [o.epochQueue, o.epochRelease];
    const adminHttp = new Http({ ...(o.http ?? {}), token: o.tokens.admin });
    await rec.ok(
      "ha0",
      async () => {
        const user = (await adminHttp.request<{ login: string; id: number }>("GET", "user")).json;
        const perms = (await adminHttp.request<{ permissions?: { admin?: boolean } }>("GET", raw.path)).json.permissions ?? {};
        return { user, admin: perms.admin === true, ...(await rulesetProblems(adminHttp, raw.path, epochs)) };
      },
      async (r) => ({
        evidence: { user: r.user.login, admin: r.admin, rulesets: r.seen },
        problems: [...(r.admin ? [] : [`${r.user.login} is not an admin of the sandbox: the admin attempts would prove nothing`]), ...r.problems],
      }),
    );
    const shas: string[] = [];
    for (const [p, epoch] of [["haq", o.epochQueue], ["har", o.epochRelease]] as const) {
      const pair = await currentPair(raw, epoch, o.read ?? {});
      if (typeof pair === "string") {
        for (let i = 1; i <= 5; i++) rec.skip(`${p}${i}`, pair, false);
        continue;
      }
      shas.push(pair.e1, pair.e2);
      await resetAttempts(rec, { force: `${p}1`, patch: `${p}2`, push: `${p}3`, del: `${p}4`, recreate: `${p}5` }, raw, raw, epoch, pair, o.read ?? {}, { pusher: o.pusher });
    }
    if (shas.length === 0) rec.skip("ha6", "no epoch commits to look up", false);
    else await noRuns(rec, "ha6", raw, shas, { ...o, runsWaitMs: 0 }, 0);
  });
}

export { PushRejected };
