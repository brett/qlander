// verify-sandbox, rollout gate G1 (docs/getting-started.md, "Roll out"): drives the
// queue's real write path against a sandbox repo whose rulesets mirror the
// target's (main) and the control repo's (the state branches):
//   a. the queue App makes two PR heads through the git data API (one changes
//      .github/workflows/), each must be verified, and it opens two PRs;
//   b. build branch at main, POST /merges for each head, every merge commit
//      verified, chain checked, the queue ref at the chain head (DESIGN.md §7.1);
//   c. updateRefs fast-forwards main with beforeOid; a stale beforeOid and a
//      non-fast-forward are refused and main does not move;
//   d. both PRs are marked merged;
//   e. the state App creates and updates both state branches;
//   f. the queue App cannot write either state branch, and the state App
//      cannot move main or create a queue ref;
//   g. cleanup: the queue ref and the PR branches; main and the state branches stay.
//
// Ref writes go through the production clients, unchanged, connected to the
// sandbox: TargetClient (createRef, merge, deleteRef, and updateRef, the
// GraphQL updateRefs mutation with force false) and StateRefClient (create,
// and cas through updateRefs). Every branch name comes from the config.

import type { Names } from "../config";
import { GitHubError, Http, type HttpOptions } from "../github/http";
import { StateRefClient } from "../github/state-ref";
import { TargetClient } from "../github/target";
import { buildRef, queueRef } from "../validate";
import { Abort, chainProblems, describeError, type Recorder, signatureProblems } from "./checks";
import { current, holds, type ReadTiming, type Sandbox, SandboxRepo, settle } from "./repo";

export type HttpBase = Omit<HttpOptions, "token">;

const DEMO_WORKFLOW = (n: number) =>
  `# verify-sandbox run ${n}: a workflow change the queue App lands. Dispatch only; nothing runs it.\nname: demo\non:\n  workflow_dispatch:\npermissions: {}\njobs:\n  noop:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo "verify-sandbox ${n}"\n`;

/** G1 into `rec`. Never throws: an abort or error goes to cleanup, and the checks not reached are reported as not run. */
export async function runG1(
  o: { sandbox: Sandbox; names: Names; tokens: { queue: string; state: string }; n: { queue: number; probe: number }; http?: HttpBase; mergeWaitMs?: number; read?: ReadTiming },
  rec: Recorder,
): Promise<void> {
  const { sandbox: target, names } = o;
  const base = o.http ?? {};
  const path = `repos/${target.owner}/${target.repo}`;
  const qHttp = new Http({ ...base, token: o.tokens.queue });
  const sHttp = new Http({ ...base, token: o.tokens.state });
  const conn = { ...base, owner: target.owner, repo: target.repo, repoId: target.repoId, names, dataFiles: [] };
  const queue = await TargetClient.connect({ ...conn, token: o.tokens.queue, role: "queue" });
  // The state App's token behind the same client, with the queue role, so the
  // client's own role check lets each write reach GitHub, whose rulesets must refuse it.
  const stateAsQueue = await TargetClient.connect({ ...conn, token: o.tokens.state, role: "queue" });
  // For reads after writes (src/sandbox/repo.ts): a landed write is polled until it shows; an
  // unchanged ref is proved with a no-op updateRefs by an identity that may write it, or held across a window.
  const t = o.read ?? {};
  const qRaw = await SandboxRepo.connect({ ...base, token: o.tokens.queue, ...target });
  const sRaw = await SandboxRepo.connect({ ...base, token: o.tokens.state, ...target });

  const build = buildRef(names, o.n.queue);
  const qRef = queueRef(names, o.n.queue);
  const probeRef = queueRef(names, o.n.probe);
  const prBranches = [`verify-sandbox/${o.n.queue}-workflow`, `verify-sandbox/${o.n.queue}-plain`];
  const made = { prBranches: [] as string[], build: false, queue: false, probe: false };

  /** After a refused write: main is still at `want`, proved by the queue App's no-op updateRefs. */
  const mainIs = (want: string) => () => holds(names.main, () => queue.getRef(names.main), want, t, { repo: qRaw, branch: names.main });
  /** After a write that landed: `ref` reaches `want` (polled through the read lag). */
  const refIs = (ref: string, want: string | null) => async () => {
    const r = await settle(ref, () => queue.getRef(ref), want, t);
    return { evidence: { ref, at: want, readLagMs: r.lagMs }, problems: r.problems };
  };
  const treeOf = async (http: Http, commit: string) => (await http.request<{ tree: { sha: string } }>("GET", `${path}/git/commits/${commit}`)).json.tree.sha;
  /** An empty commit on top of `parent`, made by whichever App's token `http` holds. */
  const emptyCommit = async (http: Http, parent: string, message: string) =>
    (await http.request<{ sha: string }>("POST", `${path}/git/commits`, { body: { message, tree: await treeOf(http, parent), parents: [parent] } })).json.sha;

  try {
    // ------------------------------------------------ a. PR heads made by the queue App, and their PRs
    const B = rec.need((await current(names.main, () => queue.getRef(names.main), t, { repo: qRaw, branch: names.main })) ?? undefined, names.main);
    const baseTree = await treeOf(qHttp, B);
    const files = [
      { path: ".github/workflows/demo.yml", content: DEMO_WORKFLOW(o.n.queue), title: `verify-sandbox ${o.n.queue}: change .github/workflows/demo.yml` },
      { path: `verify-sandbox/${o.n.queue}.txt`, content: `verify-sandbox run ${o.n.queue}\n`, title: `verify-sandbox ${o.n.queue}: add a plain file` },
    ];
    const heads: string[] = [];
    for (const [i, f] of files.entries()) {
      const branch = prBranches[i]!;
      const head = await rec.ok(
        i === 0 ? "a1" : "a3",
        async () => {
          const blob = await qHttp.request<{ sha: string }>("POST", `${path}/git/blobs`, { body: { content: f.content, encoding: "utf-8" } });
          const tree = await qHttp.request<{ sha: string }>("POST", `${path}/git/trees`, { body: { base_tree: baseTree, tree: [{ path: f.path, mode: "100644", type: "blob", sha: blob.json.sha }] } });
          const commit = await qHttp.request<{ sha: string }>("POST", `${path}/git/commits`, { body: { message: f.title, tree: tree.json.sha, parents: [B] } });
          await qHttp.request("POST", `${path}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha: commit.json.sha } });
          made.prBranches.push(branch);
          return commit.json.sha;
        },
        async (sha) => ({ evidence: { branch, file: f.path, commit: sha, parent: B } }),
      );
      heads.push(rec.need(head, `PR head ${i + 1}`));
      await rec.ok(
        i === 0 ? "a2" : "a4",
        () => queue.getCommit(heads[i]!),
        async (c) => ({ evidence: { commit: c.sha, verified: c.verified, reason: c.reason }, problems: signatureProblems(c) }),
      );
    }
    const prs: number[] = [];
    for (const [i, f] of files.entries()) {
      const pr = await rec.ok(
        i === 0 ? "a5" : "a6",
        async () =>
          (await qHttp.request<{ number: number }>("POST", `${path}/pulls`, {
            body: { title: f.title, head: prBranches[i], base: names.main, body: "verify-sandbox (rollout gate G1): landed by the queue App with updateRefs." },
          })).json.number,
        async (num) => {
          const p = await queue.getPr(num);
          return { evidence: { pr: num, head: p.head.sha }, problems: p.head.sha === heads[i] && p.state === "open" ? [] : [`PR #${num} is ${p.state} at ${p.head.sha}`] };
        },
      );
      prs.push(rec.need(pr, `PR ${i + 1}`));
    }

    // ------------------------------------------------ b. build, merges, sign check, queue ref (DESIGN.md §7.1)
    rec.need(await rec.ok("b1", async () => { await queue.createRef(build, B); made.build = true; return true; }, refIs(build, B)), build);
    const merges: { sha: string; parents: string[] }[] = [];
    for (const [i, head] of heads.entries()) {
      const m = await rec.ok(
        i === 0 ? "b2" : "b4",
        () => queue.merge(build, head, `Merge pull request #${prs[i]} from ${prBranches[i]}\n\n${files[i]!.title}\nLanded-by: qlander batch ${o.n.queue}`),
        async (r) => ({ evidence: { base: build, head, result: r }, problems: r.kind === "merged" ? [] : [`merge result ${r.kind}`] }),
      );
      const sha = rec.need(m?.kind === "merged" ? m.sha : undefined, `merge ${i + 1}`);
      const c = await rec.ok(
        i === 0 ? "b3" : "b5",
        () => queue.getCommit(sha),
        async (c) => ({ evidence: { commit: c.sha, verified: c.verified, reason: c.reason, parents: c.parents }, problems: signatureProblems(c) }),
      );
      merges.push({ sha, parents: rec.need(c, `verified merge ${i + 1}`).parents });
    }
    const Q = merges.at(-1)!.sha;
    rec.need(await rec.ok("b6", async () => chainProblems(B, heads, merges), async (problems) => ({ evidence: { base: B, heads, merges }, problems })), "a valid chain");
    rec.need(await rec.ok("b7", async () => { await queue.createRef(qRef, Q); made.queue = true; return true; }, refIs(qRef, Q)), qRef);
    await rec.ok("b8", async () => { await queue.deleteRef(build); made.build = false; return true; }, refIs(build, null));

    // ------------------------------------------------ c. land with updateRefs, then the two refusals
    rec.need(
      await rec.ok(
        "c1",
        async () => { await queue.updateRef(names.main, B, Q); return true; },
        async () => {
          const r = await settle(names.main, () => queue.getRef(names.main), Q, t);
          return { evidence: { beforeOid: B, afterOid: Q, readLagMs: r.lagMs }, problems: r.problems };
        },
      ),
      `${names.main} at ${qRef}`,
    );
    const X = await emptyCommit(qHttp, Q, `verify-sandbox ${o.n.queue}: fast-forward probe (must never land)`);
    await rec.refused("c2", () => queue.updateRef(names.main, B, X), mainIs(Q), { beforeOid: B, afterOid: X, main: Q });
    await rec.refused("c3", () => queue.updateRef(names.main, Q, B), mainIs(Q), { beforeOid: Q, afterOid: B });

    // ------------------------------------------------ d. indirect-merge detection (up to mergeWaitMs)
    const wait = o.mergeWaitMs ?? 120_000;
    const sleep = base.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let t = 0; t * 5000 <= wait; t++) {
      if (t > 0) await sleep(5000);
      if ((await Promise.all(prs.map((p) => queue.getPr(p)))).every((p) => p.merged)) break;
    }
    for (const [i, num] of prs.entries()) {
      await rec.ok(
        i === 0 ? "d1" : "d2",
        () => queue.getPr(num),
        async (p) => ({ evidence: { pr: num, merged: p.merged, state: p.state, head: p.head.sha }, problems: p.merged ? [] : [`PR #${num} not marked merged after ${wait} ms`] }),
      );
    }

    // ------------------------------------------------ e/f. the state branches
    const stateBranches = [names.stateBranch, names.releaseStateBranch];
    const text = (branch: string) => `${JSON.stringify({ verifySandbox: o.n.queue, branch, at: new Date().toISOString() })}\n`;
    for (const [i, branch] of stateBranches.entries()) {
      const [fCreate, eCreate, eUpdate, fUpdate] = (i === 0 ? ["f1", "e1", "e2", "f3"] : ["f2", "e3", "e4", "f4"]) as [string, string, string, string];
      const sc = { ...base, owner: target.owner, repo: target.repo, repoId: target.repoId, branch, stateBranches };
      const owner = await StateRefClient.connect({ ...sc, token: o.tokens.state });
      const intruder = await StateRefClient.connect({ ...sc, token: o.tokens.queue });
      const readVersion = async () => (await owner.read())?.version ?? null;
      const before = await current(branch, readVersion, t, { repo: sRaw, branch });
      let version: string | undefined = before ?? undefined;
      if (before === null) {
        // The queue App's creation is only observable as refused while the branch is absent (the first run).
        await rec.refused(fCreate, () => intruder.create(text(branch)), () => holds(branch, readVersion, null, t), { branch });
        version = await rec.ok(eCreate, () => owner.create(text(branch)), async (c) => {
          const r = await settle(branch, readVersion, c, t);
          return { evidence: { branch, commit: c, readLagMs: r.lagMs }, problems: r.problems };
        });
      } else {
        rec.skip(fCreate, `${branch} already exists (an earlier run created it); a creation refusal is only observable while it is absent`, true, { at: before });
        rec.skip(eCreate, `${branch} already exists (an earlier run created it)`, true, { at: before });
      }
      if (version === undefined) {
        rec.skip(eUpdate, `${branch} was not created`, false);
        rec.skip(fUpdate, `${branch} was not created`, false);
        continue;
      }
      const from = version;
      const updated = await rec.ok(eUpdate, () => owner.cas(from, text(branch)), async (c) => {
        const r = await settle(branch, readVersion, c, t);
        return { evidence: { branch, beforeOid: from, afterOid: c, readLagMs: r.lagMs }, problems: r.problems };
      });
      const now = updated ?? from;
      await rec.refused(fUpdate, () => intruder.cas(now, text(branch)), () => holds(branch, readVersion, now, t, { repo: sRaw, branch }), { branch, beforeOid: now });
    }

    // The state App against main and the queue refs.
    const Y = await emptyCommit(sHttp, Q, `verify-sandbox ${o.n.queue}: state App fast-forward probe (must never land)`);
    await rec.refused("f5", () => stateAsQueue.updateRef(names.main, Q, Y), mainIs(Q), { beforeOid: Q, afterOid: Y });
    await rec.refused("f6", async () => { await stateAsQueue.createRef(probeRef, Q); made.probe = true; }, async () => {
      const problems = await holds(probeRef, () => queue.getRef(probeRef), null, t);
      if (problems.length > 0) made.probe = true;
      return problems;
    }, { ref: probeRef });
  } catch (e) {
    console.log(`G1 ${e instanceof Abort ? "ABORT" : "ERROR"}: ${describeError(e)}; going to cleanup`);
  } finally {
    // ------------------------------------------------ g. cleanup; main and the state branches stay as they are
    if (made.queue) await rec.ok("g1", async () => { await queue.deleteRef(qRef); return true; }, refIs(qRef, null));
    for (const [i, branch] of prBranches.entries()) {
      if (!made.prBranches.includes(branch)) continue;
      await rec.ok(i === 0 ? "g2" : "g3", async () => { await qHttp.request("DELETE", `${path}/git/refs/heads/${branch}`); return true; }, async () => {
        const r = await settle(branch, () => qRaw.ref(branch), null, t);
        return { evidence: { branch, readLagMs: r.lagMs }, problems: r.problems };
      });
    }
    // Leftovers of an aborted or failed run: removed, not checked.
    for (const [left, ref] of [[made.build, build], [made.probe, probeRef]] as const) {
      if (left) await queue.deleteRef(ref).catch((e) => console.log(`could not delete ${ref}: ${describeError(e)}`));
    }
  }
}
