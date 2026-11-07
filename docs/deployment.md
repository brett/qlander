# Deploying qlander: config, runners, audit, setup and packaging

`DESIGN.md` covers the queue and the release advance. This document covers what you need to point qlander at your own repository: the config file, the qualification providers, the runner contract, what the target's CI must provide (and the `audit` that checks it), `setup`, packaging and releases, and upgrades.

Section numbers are stable: code and tests cite them.

---

## 0. Properties the config can't weaken further

No key in `qlander.yml` disables these. Items 4 and 5 have the exceptions they state, and those are the only ones:

1. `main` moves only by compare-and-swap (`updateRefs`, `beforeOid`, `force: false`) to the exact commit whose pre-landing manifest passed (DESIGN §1, invariants 1 and 2).
2. Merges are made through `POST /merges`, so GitHub signs them, and each is checked `verified` before any CI runs (DESIGN §7.1). No App ever needs a signature bypass.
3. Every build and rerun reserves from bounded budgets (DESIGN §5.4).
4. A change to CI policy lands alone (or, opt-in, only with other approved policy changes), with an approval from an account listed as an approver, bound to its SHA (DESIGN §4.3). Qlander can check the account, not who is using it. **Exception:** a bot you list in `queue.policy.trustedAutomations` needs no approval for a PR that touches only the paths listed for it.
5. Release advance judges qualification itself before it moves `release` (DESIGN §8). With `checks-green` and `manifest` it re-evaluates the CI runs for the exact commit. **Exception:** with `commit-status` it checks the status's state and creator, and with `proof` the chain back to the proof workflow, but it doesn't look at CI. Without `proof`, it trusts that creator's status, so only name a creator you trust to mean it. Release advance is off by default.
6. No target-repo code runs with a credential. The config lives in the control repo, never in the target (§1.3).

Two terms used throughout:
- **Target repo:** the repo whose `main` the queue lands.
- **Control repo:** the repo that holds the config, the tick workflow, the App keys (in environments) and the state branches.

---

## 1. Config: `qlander.yml`

### 1.1 What the config sets

Every identity qlander acts on comes from the config, never from code:

| Value | Key |
| --- | --- |
| The two repos, by name and by id (checked against `GET /repos` on connect) | `control.repo`, `control.repoId`, `target.repo`, `target.repoId` |
| The target's main branch, the queue and build ref prefixes, the release branch | `target.main`, `queue.refs.*`, `release.branch` |
| PR labels on the target | `queue.labels.*` |
| Issue labels in the control repo (pause, mirrors, alerts, status) | `queue.controlLabels.*`, `release.labels.*`, `watchdog.labels.*` |
| State branch names | `queue.stateBranch`, `release.stateBranch` |
| The runner contract | `runner.*`, `lease.*` (§3) |
| The token variable names (default `TARGET_TOKEN`, `TARGET_RELEASE_TOKEN`) | `tokens.*` |
| Source or pinned release, and which repo's releases | `bundle.*` (§6.3) |

These stay in code: the job names `Queue tick` and `Release advance` (the renderer writes them into the workflow, §6.3), the watchdog's thresholds, the `flaky` label, and the GitHub Actions App's global id, which is the same for everyone.

### 1.2 Schema

The source of truth is `schema/qlander.schema.json` (JSON Schema 2020-12, `additionalProperties: false` everywhere); every key has a description there. `test/fixtures/example.qlander.yml` is a complete config with made-up names, and the test suite runs on it.

Start from the example, because the schema's `required` lists are short on defaults. The top-level `version`, `control`, `target`, `runner`, `lease`, `queue`, `release` and `watchdog` blocks are all required, as are most keys inside them (the runner's mode and timings, the queue's refs, labels, admission, policy, manifest, batch, budget, timeouts and verify settings, and `release.dryRun`).
- `release.enabled` defaults to `false`, so a `release` block alone runs nothing.
- `runner.mode` has no default: you must choose (§3).
- `version` is the config schema version. An unknown version is refused.

### 1.3 Where the config lives, and why

`qlander.yml` sits at the root of the **control repo**, and the tick reads it from its own checkout of control-repo `main`. It is never read from the target repo, so a target PR cannot weaken the manifest, the policy paths or the approvers (DESIGN §6.1):
- The tick checks out the control repo only, and control `main` requires a PR with the review settings in DESIGN §12.2 ([`control.mainProtection`](configuration.md#controlmainprotection) can relax them; `audit` C5 warns on each relaxed key). With no review required, someone who can merge to control `main` can change this config, including the approvers and policy paths, without a second person.
- Most config changes are policy changes: `policyHash` covers them (§8.2), so revalidation drops PRs admitted under the old config. §8.2 lists the keys it leaves out.

Some policy can still live in the **target** repo, as data or as workflows that qlander reads: the release qualification manifest (`release.qualification.manifest.path`), the proof workflow, a status producer's workflow and a review producer's workflow. A target PR that edits any of these, or what they run, changes a gate, so it must be a **policy PR** (solo, with a SHA-bound approval, DESIGN §4.3). Otherwise a PR could weaken the qualification manifest and land as an ordinary PR. So `queue.policy.paths` must cover the **policy set**:
- every `preLanding[].path` and `fastLane.workflow`;
- `review.producer.workflow`, when the adapter is `job@main`;
- for release, if enabled:
  - `qualification.manifest.path` (`source: target`);
  - every `path` listed in that manifest, read at `target.main` by `audit`;
  - `proof.workflow`;
  - `commitStatus.producerWorkflow`;
  - every `checksGreen.required[].path`;
- the **gate-implementation dependencies** of each of those workflows: local actions (`uses: ./…`), local reusable workflows, and repo paths their `run:` steps execute. A static scan in `audit` finds these. Config validation can't read the target, so it enforces the named files, and always the whole `.github/workflows` and `.github/actions` directories. `audit` (T12, §4.1) then fails on any dependency the scan finds that `policy.paths` doesn't cover.

To keep that policy in the control repo instead, use `qualification.manifest.source: control`, which reads the manifest from the control repo's checkout (as `preLanding` already is), or `checks-green`, which keeps its manifest in the config. Both are recommended for new deployments.

### 1.4 Validation

- **Runtime has no dependencies** (DESIGN §12.2). YAML is parsed with `Bun.YAML.parse`. The validator is hand-written and strict, in the same style as `parseQualificationManifest`: unknown keys, wrong types, empty lists where a list is required, and bad regexes all fail closed.
- **The schema and the validator cannot drift.** `ajv` is a dev dependency only. A test runs a corpus of valid and invalid fixtures through both and requires the same verdict for each.
- **Semantic checks** run after the schema check:
  - the runner invariants (§3.5);
  - `policy.paths` covers the policy set in §1.3 (the static part; `audit` checks the rest);
  - `policy.approvers` is non-empty whenever `policy.paths` is non-empty;
  - every manifest (`preLanding`, `checksGreen.required`, a control-hosted qualification manifest) has at least one `when: always` entry;
  - `release.enabled` requires a `qualification` block;
  - `commit-status` requires a non-empty `creators` list, and `producerWorkflow` whenever `creators` includes the `github-actions[bot]` id;
  - the ref prefixes don't overlap each other, `target.main` or `release.branch`;
  - the label names are distinct.
- **Where it runs:** `qlander validate` (CLI), the control repo's PR CI, and the first thing every tick does, before it takes the lease. A bad config fails the job and touches no state. `audit` (T12) reads a target-hosted manifest and checks that its listed workflows are covered.

---

## 2. Qualification providers for release advance

The release job is a separate job with its own App, lease, state branch and pause (DESIGN §8). It is **off by default** (`release.enabled: false`). `release.dryRun` must be set explicitly; start with `true`, and only a reviewed config PR makes it live. Steps 1, 2, 4 and 5 of DESIGN §8 (candidate discovery, the strict-descendant check, the CAS, the receipt, the blocked alert) are shared. Only step 3, "is `C` qualified?", is pluggable. With `release.mode: dispatch` (DESIGN §8.1), steps 4 and 5 are replaced: qlander dispatches the target's own release workflow for `C`, as a dry run and then, once approved, for real, and never writes `release` itself. The provider is the same in both modes:

```ts
interface QualificationProvider {
  /** Once per tick, at main: the policy version recorded in the receipt (a 40-hex sha), or why nothing can be judged (an alert). */
  policy(main: string): Promise<{ ok: true; version: string } | Refusal>;
  /** The cheap check, before ancestry is read: a status and its proof run. */
  screen(sha: string): Promise<Screened | Refusal>;
  /** The full judgement: the evidence the receipt records. */
  judge(sha: string, screened: Screened): Promise<{ ok: true; evidence: ReceiptEvidence[] } | Refusal>;
}
```

| Provider | `C` qualifies when | Binding and caveats |
| --- | --- | --- |
| `checks-green` | Every workflow in `release.qualification.checksGreen.required` (the same entry schema as `preLanding`; it defaults to a copy of `preLanding`) passes `verdict()` on a `push` run for `C` on `target.main`, with all-jobs semantics. | Uses the same evidence rules as the queue (`job@subject`, event `push`, both repository ids). The policy version is the hash of the config block. Nothing can forge it short of pushing to main. |
| `commit-status` | The newest status named `context` on `C` is `success`, **and** its `creator.id` is in `creators` (user or App bot ids; if that is `github-actions[bot]`, `producerWorkflow` names the workflow that posts it, and that workflow is in the policy set, §1.3), **and**, if `targetUrl` is set, its `target_url` matches the anchored pattern derived from the target repo. | The weakest provider. Anyone with `statuses: write` can post a status, so `creators` is required and validation refuses an empty list. Optional `proof` (below) makes it as strong as `manifest`. |
| `manifest` | Read a JSON manifest (`path`, schema 1) at `M` through the contents API, as data only (or, with `source: control`, from the control repo's checkout), and re-evaluate it for `C` with `verdict()`. Optionally require the `proof` chain too: status → run of `proof.workflow` on main → a job named exactly `jobTemplate` with `{sha}` = `C`, on the latest attempt. | The policy version is the manifest's blob SHA. The manifest format is a published spec, `docs/qualification-manifest.md`. |

`proof` is a shared sub-block (`statusContext`, `workflow`, `events`, `jobTemplate`) usable by both `commit-status` and `manifest`.

**No qualification from zero evidence.** `verdict()` treats an absent `when: if_triggered` workflow as satisfied, so a manifest whose only entry is an `if_triggered` workflow that never ran would otherwise qualify `C` with **zero runs**. Every provider that evaluates a manifest (`checks-green`, `manifest`, and the pre-landing manifest) therefore requires both of these, or `C` does not qualify:
- the manifest has at least one `when: always` entry (validation for control-hosted manifests; `parseQualificationManifest` for target-hosted ones, which fails closed and raises the blocked alert);
- the verdict cites at least one evidence run.

A stricter re-evaluation than whatever produced a status can only hold `release` back, never advance it.

The receipt records the manifest blob SHA, so a manifest change is visible in the release history. A target-hosted manifest, proof workflow or status producer is in the policy set (§1.3).

---

## 3. The runner contract

### 3.1 What the safety argument needs

DESIGN §15 rests on these invariants:

| # | Invariant | Enforced by |
| --- | --- | --- |
| R1 | The job is killed before its lease could pass on: `jobTimeoutMinutes <= lease.minutes - lease.fenceMarginMinutes` | config validation; the rendered `timeout-minutes` (§6.3) |
| R2 | Lease times use GitHub's clock (the `Date` header) | code (`StateRefClient.serverTime`) |
| R3 | Every target write passes the fence (own state version, more than the margin of lease left) | code (`fenced.ts`) |
| R4 | Run ids are unique per execution; there is no same-owner bypass | code (`makeRunId`) |
| R5 | An expired lease is taken over only when **its holder cannot act any more** | mode-specific (below) |
| R6 | `lease.minutes < runner.cronMinutes`, so a crashed tick never blocks the next one | config validation |
| R7 | One running job per concurrency group | rendered workflow (`cancel-in-progress: false`) |

R1 to R4 only bound a process that is still *running*. The hard case is a process that freezes after it passes the fence and resumes later (DESIGN §15.1). R5 closes it, and R5 depends on the runner.

### 3.2 Mode `self-hosted-kill`

Requirements on the runner. `audit` cannot see any of them; the NixOS module's preflight checks the kill timing (below):
- **Host-side kill:** something outside the guest destroys the job's VM or container at `hostKillMinutes` after the job starts, whatever the guest is doing (for example, the runner host controller's maximum job duration). `nixos/runner.nix` provides this on NixOS hosts: a root watcher unit per runner that kills the job at `hostKillMinutes`, with a preflight that refuses a timer later than `runner.hostKillMinutes` ([Getting started, Running on NixOS](getting-started.md#running-on-nixos)).
- **Ephemeral, single-job runners**, used only by this control repo's tick workflow (restrict the runner group to `<control repo>/.github/workflows/tick.yml@refs/heads/main`). Untrusted target PR jobs must never reach this pool.
- **Host clock** within `takeoverGraceMinutes / 2` of real time (NTP).
- **Operator procedure:** pause both jobs before restarting whatever enforces the kill ([Restarting a runner host's controller](operating.md#restarting-a-runner-hosts-controller)). An adopted VM may outlive the kill window.

R5 in this mode: take over only when GitHub reports the holder's job `completed` **and** now ≥ `acquiredAt + hostKillMinutes + takeoverGraceMinutes` (`StateStore.open`). The job starts before it acquires the lease, so by then the holder's VM is dead.

Knobs: `runsOn`, `jobTimeoutMinutes`, `hostKillMinutes`, `takeoverGraceMinutes`, `lease.*`, `cronMinutes`. Validation for this mode adds `hostKillMinutes >= jobTimeoutMinutes` and `takeoverGraceMinutes >= 1`. Takeover also never happens before the lease expires: `StateStore.open` checks `until` first.

### 3.3 Mode `hosted` (GitHub-hosted runners)

`hosted` mode **requires the epoch fence** (§3.4). Validation refuses `mode: hosted` without `epochFence: true`. Without the fence, hosted runners are unsafe:
1. **No host-side kill.** `timeout-minutes` is enforced by the runner agent inside the VM. A VM that the hypervisor pauses, or that loses its network, is not killed by it.
2. **"Job completed" is not proof of death.** When a hosted runner loses contact, GitHub eventually fails the job, but nothing documented bounds how long that VM, or its process, can still be alive after that point. Treat it as unbounded. The `self-hosted-kill` R5 rule (completed + grace) proves nothing here.
3. Together these mean a process frozen between its fence check and its write could resume after a successor has taken over. That is the one hole DESIGN §15.1 leaves to the host kill.

With the epoch fence:
- **R5 in this mode:** takeover needs the holder's job `completed` **and** now ≥ `acquiredAt + jobTimeoutMinutes + takeoverGraceMinutes`. The new owner's first act is to advance the epoch (§3.4), which invalidates every ref write the old owner could still make.
- **What stays exposed after a resume:** writes that are not ref updates, which the epoch cannot cover:
  - a comment (cosmetic, marker-deduplicated);
  - a label removal (it could take `ready` off a PR the successor re-admitted: wrong but visible, and someone adds `ready` back by hand);
  - a failed-job rerun or a cancel on the old owner's own runs (cost only);
  - `POST /merges` onto a build ref (the successor deletes or never reuses that ref; a later merge fails with 404 or 409).

  None of them can move `main` or `release`, or create a `queue/<n>` that CI would test.

**Both modes are supported.** Hosted mode relies on the GitHub behaviour that experiment H1 (§3.4) checks. The target needs the two epoch rulesets (§3.4) before the first hosted tick.

Other hosted-runner caveats, which affect liveness and cost, not safety:
- **Cron is best effort.** GitHub delays scheduled runs under load, and in **public** repos it disables scheduled workflows after 60 days without repository activity. The watchdog alerts on "ticks stopped" and "tick workflow disabled". [Getting started, When ticks run](getting-started.md#when-ticks-run) says what to expect on a new repo.
- **Minutes are rounded up per job.** Two jobs every 10 minutes is about 8,600 billed minutes a month, above the minutes included with the Free and Team plans for a private control repo. Raise `cronMinutes` (R6 then allows a longer lease) or use a public control repo. The control repo's visibility must be at least as restrictive as the target's, because job logs and mirror issues show PR numbers, branches and job names. `audit` check C6 enforces this.

### 3.4 The epoch fence

The epoch fence ties every target ref write to the current lease, using the fact that GraphQL `updateRefs` applies a list of ref updates to one repository atomically:
- **The epoch branches.** Each job has an epoch branch in the target: `<epochPrefix>queue` and `<epochPrefix>release` (`runner.epochPrefix`, default `qlander-epoch/`). The prefix is separate from `buildPrefix` so that the `queue-refs` ruleset, which lets the queue App write `buildPrefix/**`, never covers the release epoch. Each epoch branch points at a chain of empty-tree commits.
- **Taking the lease.** The new owner creates a commit (empty tree, parent = the current epoch, message = its run id) through the git data API, and moves the epoch branch forward to it with `updateRefs` (`beforeOid` = old epoch, `force: false`).
- **Every write carries the epoch.** Every target ref write (`createRef queue/<n>` and `<buildPrefix><n>`, `deleteRef`, the `main` CAS, the `release` CAS) is sent as **one** `updateRefs` call that also carries `{epoch: E → E}`, where `E` is the epoch this tick advanced to. If a successor has advanced the epoch, the whole call is rejected and nothing moves.

**The epoch must not be rolled back.** If anyone could force-reset the epoch from `E2` back to `E1`, a frozen executor holding `E1` would get its authority back: `{epoch E1→E1, main M→Q}` would land. So target rulesets protect the epoch branches like `main`:
- **`epoch-write`:** restrict creation, update and deletion. The only bypass actor is the App that owns the epoch (the queue App for the queue's epoch branch, the release App for the release's). Use one ruleset per epoch branch, so that an attempt by the other App is refused by `epoch-write` itself and not only by `epoch-integrity`.
- **`epoch-integrity`:** non-fast-forward and deletion blocked, with **no bypass at all**, not even for the Apps or admins. A bypass actor skips every rule in its ruleset, which is why this has to be a separate ruleset.

Advancing the epoch is always a fast-forward (the new commit's parent is the old epoch), so it passes. A reset, or a delete followed by a re-create at an old commit, is refused for everyone. The epoch branches must also be **excluded from CI**:
- Requirement T3 (§4.1) says no workflow may trigger on `buildPrefix` or `epochPrefix`.
- `audit` additionally flags any target workflow with an unfiltered `push` trigger (no `branches`), because an epoch advance by an App would start it.

**How the client applies it.** `fenced()` (`src/fenced.ts`) takes the tick's epoch. With the fence on, `createRef`, `deleteRef` and `updateRef` become one `epochUpdateRefs` call each: the write (a create has a zero `beforeOid`, a delete a zero `afterOid` with the ref's current commit as `beforeOid`) plus `{epoch: E → E}`, force false. The lease fence still runs first on every write. The client refuses the plain write methods while it has an epoch branch, so no ref write can bypass the fence, and the tick refuses to start when the contract and the client disagree (`epochClientProblem`).
- **A rejected write** is judged on the write path, not by a read: GitHub can serve a ref read from a replica that hasn't seen a write made a moment earlier, and a lagging read shows older values, never newer ones. `epochHeld(E)` sends a lone no-op `updateRefs {epoch E→E}`, which GitHub accepts only while the epoch is E. A rejection means the lease is lost (`LostLockError`; the tick ends as `lost-lock`). If the probe can't be made, a read showing another epoch is a lost lease, and one showing ours leaves the original error standing, with ownership unknown, and that write is not retried.
- **While the epoch is still ours,** a rejected write keeps the plain client's contract: a create of an existing ref is a conflict, a delete succeeds once the ref is confirmed gone, and a failed `main` or `release` CAS is judged by re-reading the ref.
- **`takeEpoch()`** is the first act of both ticks after the lease: an empty-tree commit whose parent is the current epoch (a root commit when the branch is missing), moved there with a fast-forward CAS through the lease fence. An advance that is rejected, or that sees the epoch move while it was read, is a conflict, and the tick retries later. It never pauses, because GitHub reports a stale `beforeOid` as an untyped GraphQL error, and a lagging replica can still show the old epoch.
- **Between the new owner's lease write and its epoch advance,** a frozen predecessor's write can still land. That is safe for the same reason a write just before the takeover is: every ref write follows a journalled intent, and the new owner reconciles that journal by reading the refs, which it does only after it has advanced the epoch.
- **`POST /merges`** onto a build ref moves that ref through a REST call that `updateRefs` cannot carry, so it is not epoch-fenced and stays exposed as §3.3 says.
- **Changing `epochPrefix`, or turning `epochFence` on or off.** A frozen owner keeps the authority of the epoch branch it was started with, and a successor advancing a differently named branch does not void it. The epoch branch handover below enforces this, so the change does not need a quiesce, though pausing both jobs and letting every lease be released first (§8.1) is still the simplest way to make it.

**Epoch branch handover, with the release job's read-only token.** In dispatch mode with the fence off, the release job's token has Contents: read. If a recorded branch still has to be voided, GitHub refuses, and the rendered job mints a Contents: write token and runs the tick once more. Later ticks stay on the read token. Keep Contents: write on the App's registration until that has happened; `audit` T11 reports the difference until you drop it.

**Epoch branch handover (enforced).** Each state document (queue and release) records `epochBranch`, the branch its last lease holder fenced on. It is written with the lease and kept when the lease is released, because a holder can keep authority on its branch after a release: a successor took its lease but failed to advance the epoch and released, or one of its writes was still in flight. With the fence off nothing is recorded, so a fence-off deployment's state document does not change. Every job taking its lease, after R5's checks and before it writes its own lease, compares the recorded branch with its own (`predecessorEpoch()` in `src/config/runner.ts`, `epochHandover()` in `src/fenced.ts`, called from `StateStore.open`):
- **Different branch** (a changed `epochPrefix`, or the fence turned off), whether the last lease expired or was released: the job first advances the recorded branch with `voidEpoch`: an empty-tree child of its current commit, moved there with a fast-forward CAS. It refuses unless that commit has the empty tree, so it never touches a code branch. A branch that reads as missing is created at a new root commit with a create-only CAS rather than skipped, so a lagging read cannot pass for "nothing to void". Every ref write a frozen holder could still send then carries a stale epoch on that branch and is rejected. The record then becomes the job's own branch, or is dropped once voided with the fence off.
- **No branch recorded** (the holder wrote without the fence): nothing can void it. In `self-hosted-kill` mode R5's host kill bounds it. In `hosted` mode a job refuses to take over such an **expired** lease (`busy`), because nothing bounds that holder; switch to hosted only once a tick has released the lease, or let one self-hosted-kill tick take the lease over and release it. A released lease without a record is taken as before: an unfenced holder's request already in flight at its release is the same residual every mode has without the fence.
- **Same branch:** nothing extra; taking the epoch voids it.

A void that fails, or a refusal, leaves the state untouched, so the record survives and the next tick tries again; the tick ends `busy` with the reason and never throws. Voiding before the new lease is written is safe without the lease fence: the branch it advances belongs to no job under the current config, so the advance can only stop a holder, never let one write. The tests are `test/epoch-record.test.ts` and `test/epoch-handover.test.ts`.

**Experiment H1** checks the GitHub behaviour hosted mode relies on, in a sandbox repo with the rulesets above. It is part of `qlander verify-sandbox`, so a deployment runs it itself:
1. An entry with `beforeOid == afterOid` is checked, not skipped. A stale `beforeOid` there rejects the whole call, including the `main` entry, and `main` does not move.
2. The owning App can advance its epoch branch (fast-forward) and include it in a combined call with `main`.
3. **Adversarial epoch reset.** Advance the epoch `E1 → E2`, then try to put it back to `E1`. The attempts are made by the owning App (`updateRefs` with `force: true`), by the other App, by an org-admin user (`git push --force` and `PATCH git/refs force=true`), and by deleting and re-creating it at `E1`. **Every attempt must be refused.** Then a stale `{epoch E1→E1, main M→Q}` call must be refused.
4. No workflow run is created by an epoch advance (checked by listing runs on the sandbox for the epoch commit).

If check 1 fails, the fallback is to advance the epoch on every write (`E → E'`, with a fresh commit each time). That costs one extra API call per write, and checks 2 to 4 still apply. If check 2, 3 or 4 fails, `hosted` mode is not safe on that GitHub instance.

The `verify-sandbox` phases allow for read-after-write lag:
- A write that should have landed is polled with backoff for up to 10 s until it shows.
- A write that must not have landed is proved unchanged by a no-op `updateRefs` from an identity allowed to write the ref (the owning App). When no such identity is available (the other App, the admin), every read across a 10 s window must show the expected value.
- A reset attempt counts as refused only when GitHub refused the write itself: a 401, 403 or 404 means the token could not try, and is reported as an error.
- Each stale call is followed by a control: the identical writes with E2 must land, so the stale epoch is shown to be the only reason for the refusal.

### 3.5 Validation of the runner block

| Check | Modes |
| --- | --- |
| R1: `jobTimeoutMinutes <= lease.minutes - lease.fenceMarginMinutes` | both |
| R6: `lease.minutes < cronMinutes`; `reconcileMinutes >= 2 * cronMinutes` | both |
| `hostKillMinutes >= jobTimeoutMinutes`; `takeoverGraceMinutes >= 1` | self-hosted-kill |
| `epochFence: true`; `takeoverGraceMinutes >= 15`; `hostKillMinutes` absent; `epochPrefix` overlaps no other prefix or branch and no component ends in `.lock`; `audit` sees the two epoch rulesets | hosted |
| The rendered `tick.yml` matches the config (§6.3) | both |

The mode rows are `runnerProblems()` in `src/config/runner.ts`; R1 and R6 are `invariantProblems()`, called with `runner.cronMinutes`. The contract travels with the config (`Config.runner`, `ReleaseConfig.runner`), so a job never checks one config against another file's contract. `policyHash` leaves the runner block's mode, cron, runner labels and epoch settings out. Not all timings are left out: `jobTimeoutMinutes`, `hostKillMinutes` and `takeoverGraceMinutes` also feed hashed lease and takeover values, so changing one of them changes the hash (§8.2). Switching `runner.mode` also changes the hash unless `hostKillMinutes` equals `jobTimeoutMinutes`, because the hashed takeover bound is `hostKillMinutes` in `self-hosted-kill` mode and `jobTimeoutMinutes` in `hosted` mode.

GitHub's behaviour can change, so don't take H1 from this document: `verify-sandbox` runs checks 2 to 4 in your own deployment (§3.4).

---

## 4. Target-repo CI requirements, and `audit`

### 4.1 Requirements

| Id | Requirement | `audit` |
| --- | --- | --- |
| T1 | Every `preLanding` workflow triggers on `push` to `queue.refs.queuePrefix` (a glob that matches `queue/1`), with no `paths` or `paths-ignore` filter, unless the entry is `when: if_triggered`. | FAIL |
| T2 | On queue pushes, these workflows run their full suite: whatever gates a "full" run must accept the queue prefix as well as `main`. | WARN (it looks for `github.ref == 'refs/heads/main'` conditions without the queue prefix) |
| T3 | No workflow triggers on `buildPrefix` or `epochPrefix`, and no workflow has an unfiltered `push` trigger (an App ref update would start it). Only `preLanding` workflows trigger on `queuePrefix`. | FAIL / WARN |
| T4 | Privileged steps (trusted runner pools, write-capable caches, deploy environments) stay main-only. A job in a workflow that runs on queue pushes and that uses an `environment`, a write secret, or `id-token: write` has an `if:` that excludes the queue prefix. | WARN (static heuristic) |
| T5 | Diff baselines don't assume one commit per push. `github.event.before`, `HEAD^` and first-parent diffs are replaced by `git merge-base HEAD origin/<main>`, which equals the batch base on a queue push, so a step sees the whole `base..Q`. | WARN, with each line listed |
| T6 | The fast-lane workflow runs on `pull_request` in the same repo and has a job named exactly `fastLane.job`. | FAIL |
| T7 | Required job names are stable, and every job that can be skipped is listed in `allow_skipped_jobs`. Matrix legs count as jobs (all-jobs semantics, DESIGN §6.1). | Dynamic: FAIL if the newest completed queue run (or main push run, before the first queue run) lacks a required job or skips an unlisted one |
| T8 | The main-landing, main-integrity and queue-refs rulesets ([DESIGN §13](../DESIGN.md#13-target-side-requirements)). If `epochFence` is on: the `epoch-write` and `epoch-integrity` rulesets (§3.4). Merge queue (native) is off on `main`. | FAIL; bypass lists need an admin token, otherwise SKIPPED |
| T9 | The `queue.labels` labels exist on the target. | FAIL (`setup` creates them) |
| T10 | Release, if enabled: the release-landing and release-integrity rulesets (DESIGN §13; `audit` requires a PR and every check `setup` writes on release-landing, but not "Restrict updates", because a person merges hotfix PRs there); PR CI for base `release` runs the full suite (the hotfix path, DESIGN §9). With linear landing and release dispatch there is no hotfix path (DESIGN §7.4): `audit` requires "Restrict updates" on release-landing and each `release.dispatch.promoterApps` App as an `always` bypass actor on every ruleset that would stop it moving `release`, and doesn't check PR CI for base `release`; the provider's inputs exist (the manifest file parses; the status context or proof workflow has been seen on main). | FAIL / WARN (WARN while `release.dryRun` is true) |
| T11 | The queue App and the release App have exactly the expected permissions, registered and accepted on each installation (§5.3). For the release App that depends on `release.mode`, and the queue App also needs Issues: write with `linkedIssues.close` (the App table in §5). | FAIL; installation permissions need an org owner's token, otherwise SKIPPED. Whether an installation covers only the target is always SKIPPED (`setup --step verify` checks it) |
| T12 | Policy coverage (§1.3): every file in the policy set, and every local action, local reusable workflow and repo script that those workflows run (a static scan of `uses: ./…` and of `run:` lines that execute repo paths), is matched by `queue.policy.paths`. The listed workflows of a target-hosted qualification manifest are read at `target.main`. | FAIL for an uncovered named file or dependency; WARN for a `run:` line the scan can't resolve |
| T13 | Linear landing only (`queue.landing.mode: linear`, DESIGN §7.4): every ruleset (repository or organization, include and exclude patterns) with a rule that refuses a forced update (`non_fast_forward`, `update`, `pull_request`, `required_status_checks`, `required_deployments`, `merge_queue`, `workflows`, `code_scanning`, and with `queue.landing.author: author` also `required_signatures`) that covers a same-repo PR branch into main lists the queue App, by id, as a bypass actor in mode `always`, the same list admission uses; classic protection on an open PR's branch allows force pushes; with `queue.landing.author: author`, main requires no signed commits (ruleset `required_signatures` or classic protection). `main`, `release`, the queue and build prefixes and the epoch branches are left out. No finding in merge mode. | FAIL for an open PR's branch proven blocked, or required signatures with `author`; WARN for a pattern that could cover future PR branches; SKIPPED (inconclusive on a failed read) when bypass lists or classic protection can't be read |

### 4.2 `qlander audit`

```
qlander audit [--config qlander.yml] [--target-only|--control-only] [--json]
              [--queue-app <slug>] [--release-app <slug>] [--state-app <slug>]
```

- Reads the target only through the API with a read token (`GH_TOKEN`). It never checks anything out. Workflow files are fetched through the contents API at `target.main` and parsed as YAML data. Every request is a GET.
- The control checks:
  - C1: the environments exist and allow deployments from `main` only;
  - C2: there are no repo-level or org-level secrets the tick could see;
  - C3: `can_approve_pull_request_reviews` is false;
  - C4: each state branch's ruleset has exactly the state App as bypass;
  - C5: control `main`'s ruleset, parameter by parameter, by default: `pull_request` with `required_approving_review_count >= 1`, `dismiss_stale_reviews_on_push: true` and `require_last_push_approval: true`; `required_signatures`; `non_fast_forward`; `deletion`; no bypass actors (DESIGN §12.2). Each missing parameter is its own FAIL line. [`control.mainProtection`](configuration.md#controlmainprotection) can raise the approval count, or declare a lighter rule for the count, stale-review dismissal, last-push approval and signatures; a parameter relaxed there is a WARN naming the key instead ([Getting started, step 4](getting-started.md#4-protect-the-control-repos-main));
  - C6: the visibility rule (§3.3);
  - C7: the rendered workflows have no drift (§6.3), and the hand-edited `ci.yml` and `verify-sandbox.yml` download the bundle `bundle` names (a WARN if not);
  - C8: the state App's permissions.
- Output is a table of `PASS / WARN / FAIL / SKIPPED`, with the requirement id and a fix line for each. A check the token can't see (a 403, or an answer only an admin gets) is SKIPPED or WARN, never a guessed PASS, and exits 0, though a 403 or 404 on a repo or an App's registration is a FAIL. A read that fails for another reason (a 5xx, a network failure, a rate limit, a 401) keeps its status and gains `inconclusive: true`, shown as `(read failed)` in text. A truncated repo tree stays a plain WARN, because on a very large repo it would otherwise never clear. Exit codes:
  - **0:** no FAIL (WARN and SKIPPED alone never fail).
  - **1:** a FAIL that is an answer (a 403 or 404 on a repo or an App's registration counts as an answer).
  - **2:** a usage error.
  - **3:** no such FAIL, but a failed read (`inconclusive`), no token, an invalid config or a stopped audit. A FAIL produced by a failed read, such as `cannot read the target` on a 5xx, stays a FAIL in the table and exits 3.
- Apps are found by slug (`<control repo name>-queue|release|state`, or `--queue-app` and so on). `audit` lists, per App, the registration permissions (`GET /apps/{slug}`) and each installation's permissions (`GET /orgs/{org}/installations`, which needs org admin read) separately, so a change that is saved but not yet accepted shows as "pending acceptance" (§5.3). An installation's repo list needs the App's JWT and is always SKIPPED; `setup --step verify` covers it.

---

## 5. `setup`

```
qlander setup [--config qlander.yml] [--plan | --apply]
                  [--step apps|install|control|target|verify|permissions]
                  [--keys-dir <dir> | --key-cmd <command>] [--name <prefix>] [--rotate]
                  [--apply-target-rulesets] [--poll-seconds <n>] [--wait-minutes <n>] [--skip-audit]
```

**The Apps and their permissions** (DESIGN §12.1). `setup` registers exactly these, `tick.yml` requests them when it mints each token, and `audit` T11 requires them, not fewer and not more:

| App | On | Permissions |
| --- | --- | --- |
| queue App | the target | Contents: write, Workflows: write, Pull requests: write, Actions: write, Checks: read, Commit statuses: read, Metadata: read; plus **Issues: write** with `linkedIssues.close` on, to close the issues a landed PR names ([How it works](how-it-works.md#closing-linked-issues)) |
| release App, `release.mode: advance` | the target | Contents: write, Workflows: write, Actions: read, Checks: read, Commit statuses: read, Metadata: read |
| release App, `release.mode: dispatch` | the target | **Actions: write**, to dispatch `release.dispatch.workflow`; Contents: **read** (write only with the epoch fence on, for its epoch branch); no Workflows; Checks: read, Commit statuses: read, Metadata: read; plus **Variables: read** when `release.dispatch.freeze` is set |
| state App | the control repo | Contents: write, Metadata: read |

Switching an existing release App to dispatch mode is a permission change: follow §5.3 (save the new permissions in the App's settings, then accept them on the installation) before you merge the config change, or every release tick fails to mint its token. The queue App never gets the new permission. In dispatch mode `setup --step target --apply-target-rulesets` makes the release-landing ruleset's only bypass actors the App your promote workflow moves `release` with (`release.dispatch.promoterApps`, by App id; never the GitHub Actions App) and named break-glass users. It removes the release App, roles, teams and any other App, and `audit` T10 fails while any of them is there, whatever its bypass mode. Set `release.dispatch.actor` to the release App's bot account, `<slug>[bot]`, with its id (`gh api 'users/<slug>[bot]' --jq .id`); `audit` T11 checks both.

`--plan` (the default) prints every change it would make. `--apply` makes them. Without `--step` it runs apps, install, control, target and verify in order, stopping at the first that fails. It is idempotent: every step reads first and changes only what differs. It runs on an operator's machine with `gh` authenticated as an org owner, never in Actions.

**Steps are resumable across processes.** Each step is a separate invocation. It reads only the config, the live GitHub state and the key directory, and keeps nothing in memory between steps.

### 5.1 Key custody

GitHub never returns a secret's value, and it shows an App's private key only at the moment it is generated. A crash between `apps` and `control` would lose keys held only in setup's memory, so:
- **Where keys go.** `--keys-dir <dir>` is required for `apps`, `control` and `verify`. The `apps` step writes each new key to `<dir>/<app-slug>.pem` (mode 0600, created exclusively, never overwritten) and writes `<dir>/apps.json` (App ids, client ids, slugs and installation ids: nothing secret). Setup refuses a `<dir>` that is inside a git work tree or readable by group or others.
- **How later steps use them.** `control` reads the key files to set the environment secrets, and `verify` reads them to mint tokens. With `--key-cmd '<command> <slug>'`, setup gets each key from the operator's secure store (for example `op read …` or `pass show …`) instead of the directory. Move the keys into such a store and delete the directory once `verify` passes.
- **A lost key is replaced, not recovered.** When `apps` finds the App already exists (`GET /apps/<slug>`) but no key, it does not create a second App. It prints the App's settings URL and the way to its **Credentials**, then **Key pairs**, then **New key**, and waits for the operator to generate a key and put it in `<dir>`. `control --rotate` then replaces the environment secrets, and the old key is deleted in the UI.
- **The test.** Each step is run as its own process, with the process killed after every API write in turn. Re-running the remaining steps reaches the same end state, creates no duplicate App, environment, ruleset or label, and never asks for a key that is already in `<dir>`.

### 5.2 Steps

| Step | What it does | Automated? |
| --- | --- | --- |
| **apps** | Creates `<name>-queue`, `<name>-release` (if release is enabled) and `<name>-state` through the **App manifest flow**: a local page POSTs the manifest JSON to `https://github.com/organizations/<org>/settings/apps/new`, GitHub redirects back with a `code`, and `POST /app-manifests/{code}/conversions` returns the id, client id and private key, which go straight to the key store (§5.1). | Mostly. The org owner clicks "Create" once per App. If the redirect to `localhost` can't be reached (a remote VM), the CLI asks for the `code` from the browser's address bar instead. The code is valid for one hour. |
| | **Permissions are verified after creation, never assumed.** GitHub silently drops some permissions passed as URL query parameters, so the manifest flow comes first. Setup also prints a pre-filled link as a fallback for when GitHub's form comes up empty, and says to check the permissions on it. After the manifest flow it reads `GET /app` with the App's JWT and compares the permissions with the expected set from DESIGN §12.1, exactly (not fewer, not more). Any difference fails the step and sends the owner through `permissions` (below). | Check: yes. Fix: by hand. |
| **install** | Prints `https://github.com/apps/<slug>/installations/new` for each App, then polls `GET /app/installations` with the JWT until the queue and release Apps are installed on **only** the target, and the state App on **only** the control repo (`repository_selection: selected`). It records the installation ids in `apps.json`. | No: an owner must click Install. |
| **control** | In the control repo:<br>• creates the environments (`queue-write`, `release-write`) with a deployment-branch policy of `main` only;<br>• sets each environment's secrets (`QUEUE_APP_CLIENT_ID`/`_PRIVATE_KEY`, `RELEASE_APP_*`, `STATE_APP_*`) from §5.1 through `gh secret set --env`, which does the sealed-box encryption;<br>• creates the issue labels;<br>• sets `can_approve_pull_request_reviews: false`;<br>• creates the `main` ruleset with every DESIGN §12.2 parameter (less any that `control.mainProtection` relaxes, which setup neither adds nor removes): `pull_request` (`required_approving_review_count: 1`, `dismiss_stale_reviews_on_push: true`, `require_last_push_approval: true`), `required_signatures`, `non_fast_forward`, `deletion`, and no bypass actors. An existing ruleset missing any of these is updated, and the diff is printed;<br>• creates the **state-branch ruleset**: restrict creation, update and deletion, block force pushes, and bypass = the state App only. | Yes, but order matters: GitHub accepts an App as a ruleset bypass actor only once that App is **installed on the repo**, so this step refuses to run before `install` has seen the state App installation. |
| **target** | Creates the target labels. Creates the `queue-refs` ruleset and, with `--apply-target-rulesets`, the main-landing and main-integrity rulesets (plus the release rulesets, and the epoch rulesets when `epochFence` is on, §3.4). The App bypass rule above applies here too. It never deletes classic branch protection: it prints the command instead. | Labels yes; rulesets opt-in; classic protection removal no. |
| **verify** | Mints an installation token for each App with exactly the per-job permissions the tick requests, and requires success. Also checks that the state App's token can read its branch, that an attempt by the operator's own token to create the state branch is **refused** by the ruleset, and that each App's installation covers exactly the expected repos. GitHub's wording varies, so a refusal counts as a 422, the branch still absent, and `GET /repos/{owner}/{repo}/rules/branches/{branch}` reporting the creation rule from that ruleset, whose bypass list has been checked first. A read that fails is a failed check. This can't tell a 422 from another cause apart from a refusal, so it would pass wrongly only if GitHub reported the rule as active without enforcing it. Then runs `audit`, and fails on any FAIL or failed read. | Yes |
| **permissions** | Changes to an existing App's permissions. See §5.3. | No (UI), but setup checks the result. |

### 5.3 Changing an App's permissions

This is manual: no API changes an existing App's permissions. When a new qlander version needs a permission the App lacks (`setup --step verify` reports it), `setup --step permissions`:
1. Prints the exact steps and links:
   - "Open `https://github.com/organizations/<org>/settings/apps/<slug>/permissions`, set `<permission>` to `<level>` under Repository permissions, and save (Permissions & events)."
   - Then, for each installation: "Open `https://github.com/organizations/<org>/settings/installations/<installation-id>` and accept the new permissions."
2. Polls the **registration** permissions (`GET /app`, with the JWT) until they equal the new expected set.
3. Only then polls **each installation's** permissions (`GET /app/installations/{id}`) until they equal it too.

Each poll reports its own status, so "saved but not accepted" is visible. A tick fails closed before taking the lease, naming the missing permission, if a token mint is refused.

[Getting started](getting-started.md) lists the manual steps (the clicks in §5.2, the CI changes in §4.1, the runner, and the sandbox check).

---

## 6. Packaging

### 6.1 Releases

Each tag `vX.Y.Z` is built by the release workflow on a hosted runner, with no secrets except `id-token: write` for provenance. Assets:
- `qlander-X.Y.Z.js`: one file, `bun build --target=bun src/cli.ts`;
- `qlander.schema.json`;
- `SHA256SUMS`;
- a build-provenance attestation (`actions/attest-build-provenance`), when the repo is public.

The build is deterministic: the same source and the same Bun give the same bytes, so anyone can rebuild a release from its tag and compare the checksum.

**Versioning:**
- **Major:** a config `version` bump, an irreversible state migration, or a change to the runner contract.
- **Minor:** new optional config keys, or new providers.
- **Patch:** fixes.

The bundle refuses a config `version` it doesn't know, and a state document `v` newer than it knows, so a downgrade fails closed instead of misreading state. State migrations run when the lease is taken, on the first tick of the new version (even a paused one), so they are **staged** (§8.1.1). Downgrading to any version at or after the reader is safe. A migration that can't be staged is a major version marked "quiesced upgrade only". Release notes say which case each release is. Before pinning an older release, run its `check-state` on a copy of each state branch's `state.json`.

### 6.2 The template control repo

A GitHub template repo, `brett/qlander-template`, contains:

```
qlander.yml                         # commented minimal config
.github/qlander-release.txt         # "<version> <asset> <sha256>"
.github/bun-release.txt             # "<version> <asset> <sha256>" for Bun
.github/workflows/tick.yml          # rendered; never edited by hand
.github/workflows/watchdog.yml      # rendered
.github/workflows/ci.yml            # PR CI: validate + render --check + zizmor/actionlint; hosted runner, no secrets; only its qlander download is rendered
.github/workflows/verify-sandbox.yml  # the sandbox checks (§3.4), dispatched by hand; only its qlander download is rendered
README.md                           # the first hour: template → setup → audit → dry run → live
AGENTS.md                           # for an agent working in the live control repo
agent-landing-rules.md              # rules to copy into the target repo's agent instructions
```

Its source is `template/` in this repo, and the template repo is published from it. `test/template.test.ts` checks that the config is valid, that the two rendered workflows are exactly its rendering, and that the pin names this version. The template uses GitHub-hosted runners with the epoch fence, and keeps release advance off.

**Pinning and upgrading:**
- The pin is the line in `.github/qlander-release.txt`; `bundle` in the config (§6.3) is what makes the tick use it. It is reviewed like any control-repo change.
- The template's pin has to be set for each release, and last, because any change under `src/` changes the bundle. `scripts/export-public.ts` and the public release workflow build the bundle and refuse if the pin differs (`scripts/template-pin.ts`). The build depends on the Bun that runs it, so the export also refuses on any Bun version but the one in `.github/bun-release.txt`: it checks nothing and says so, rather than guess. The release workflow always builds with the pinned Bun.
- To upgrade: fetch the new release's `SHA256SUMS`, check the attestation with `gh attestation verify`, rewrite the pin line, re-render the workflows if the new version renders them differently, and open the PR. Before 1.0, stop the queue first (§8.1): release notes don't say which upgrades could skip that.
- A Renovate regex manager can update the pin file. Dependabot cannot update a custom file.

### 6.3 The tick: download, verify, run

The tick downloads Bun from the release named in `.github/bun-release.txt`, checked against its sha256, into a fresh temp dir. With `bundle` set ([`bundle`](configuration.md#bundle)), it then does the same for the qlander asset named in `.github/qlander-release.txt`, from `https://github.com/<bundle.repo>/releases/download/v<ver>/…`, or, with `bundle.private: true`, through the releases API with the job's own token (so `bundle.repo` must be the control repo). Without `bundle` the job runs `src/cli.ts` from the control repo's checkout. It runs:

```
"$dir/bun" "$dir/qlander-$ver.js" tick queue --config qlander.yml
```

The checksum in the reviewed control repo is the trust root. A public release's download needs no token, and there is no cache and no package install.

`tick.yml` and `watchdog.yml` are **rendered** from the config by `qlander render`, because a workflow can't read the config before it mints tokens. The rendering fills in:
- `runs-on`, the `if: github.repository_id == <control.repoId>` guard and `timeout-minutes`;
- the cron, from `cronMinutes`;
- the token steps (owner, target repo, per-job permissions);
- the environment names and the job names.

The control repo's CI compares the checked-in workflows with `render(config)` (`render --check`), and `audit` reports drift (C7). `ci.yml` and `verify-sandbox.yml` are hand-edited, so `render` updates only the lines that download the bundle in them, and `render --check` and C7 only mention a difference there (exit 0, WARN).

---

## 7. Public hygiene

This applies to qlander's own repository, not to a control repo. [CONTRIBUTING.md, Public hygiene](../CONTRIBUTING.md#public-hygiene) has the rule for contributors. Everything in the repository's files, history, commit messages, PR text, branch and tag names and release notes is published, and anything published to GitHub can't be reliably cleaned afterwards.

### 7.1 The scrub tool

`scripts/public-scrub.ts` is a generic engine with no denylist of its own. The rules (literal strings and regexes, a short allowlist, deny-list paths and the allowed commit identities) are JSON, read from `--rules <file>`, else `$PUBLIC_SCRUB_RULES` (the JSON text), else `scripts/public-scrub.rules.json`. The rules name what must not appear, so they are never committed here; CI reads them from an Actions secret. A missing or invalid rules file is an error (exit 2) in every mode, never a clean result. Each rule and allow entry carries examples, which the tests replay.
- `--tree <dir|git-ref>` scans every file, its content and its path name. The git-ref form is authoritative; the directory form skips `.git` and a top-level `node_modules/`.
- `--text <file|->` scans any text: a commit message, a PR title or body, a branch or tag name, a tag annotation or release notes.
- `--commits <range>` scans each commit's message and checks its author and committer against the allowed identities.
- `--tag <ref>` scans an annotated tag's name and annotation and checks its tagger against the allowed authors.
- Output is `file:line:match:rule`, then the count. `--fail` exits 1 on any hit. `--summary` groups hits by rule and by file. `--redact` prints where, without the matched text and with rules by number rather than by name, and a hash for a path whose own name has a hit, for logs that are themselves public. `--forbid-excluded` turns a present deny-list path into a hit.
- **Content is never skipped as binary.** A file with NUL bytes is scanned as printable runs, single-byte and UTF-16 both ways round. Other encodings (compressed or base64 data, for example) are not decoded; this repo ships source and docs only, and a binary asset needs a reviewer's look.

### 7.2 When it runs

A server-side check runs only after a push or a PR has already made its content visible, so a local check comes first.

**Before publication (the layer that prevents disclosure).** Every push, PR, tag and release is made by the maintainer or by tooling acting for them, and each runs the scrub locally first, with `--fail`. A pushed tag is public at once, before any workflow has run, so nothing server-side can come first.
- `.githooks/pre-push` runs `--pre-push`: for each ref, its name, its tag (name, annotation, tagger; a lightweight tag is a hit), its tree (`--forbid-excluded`) and every commit the remote lacks. Turn it on with `git config core.hooksPath .githooks` and `PUBLIC_SCRUB_RULES` set. Without the rules it refuses the push. A hook can be skipped, so the server-side checks below also run.
- A PR's title and body and a release's notes go through `--text` before they are sent.

**Before merge (server side, required).** The `public scrub` check runs on every PR, whatever its base, with `--fail --redact` (`.github/workflows/scrub.yml`). It is a required status on `main`, set by the ruleset in `.github/rulesets/main.json` along with squash-only merges; apply it with `gh api --method POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main.json`. The check is only as required as that ruleset: without it, a red check does not stop a merge.
- `--tree` on the PR head with `--forbid-excluded`, and `--commit-trees` on each commit, since a file added and removed is still published;
- `--commits base..head`: messages, and author and committer identity;
- `--text` on the PR title, the body and the head branch name, read from the API when the check runs, so a rerun of an older run can't pass on old text. A PR edit (title or body) re-runs it.
- It runs on `pull_request_target`: the **base** branch's script runs, and the PR head is read only as data (`git fetch` of the head commit, never executed), so fork PRs are checked too without exposing the rules secret to PR code.
- **Squash merges only.** Only the PR's final tree lands, so content added in one PR commit and deleted in a later one never enters `main`'s history. The squash commit's message defaults to the PR title and body, which the check scanned; a message edited by hand at merge time is outside it. So a workflow on every push to any branch (`.github/workflows/scrub-published.yml`) re-runs `--commits` and `--tree` on the new commits, and `--text` on the branch name, and opens an alert issue on a hit. That also covers a branch with no PR. The same workflow checks every pushed tag (its name, annotation, tagger, tree and every commit it reaches) and every published or edited release (its name and notes). This is detection only.
- **Tags and releases.** `.github/rulesets/tags.json` stops anyone moving or deleting a tag once it is published. The release workflow builds only a tag whose commit is on `main`, and scrubs the tag it was started for (its name, its annotation and its tagger, `--tag`), the release notes, the tagged tree and the built assets before it attests or creates the release, refusing on any hit. A release made by hand skips that step, so make releases only by pushing a tag: `scrub-published.yml` checks a release's name and notes when it is created or published and on every edit, but that is detection only.
- **What no check covers.** Issue and PR comments, reviews and discussions aren't scanned, and a PR's title and body are public from the moment they are sent. GitHub also runs no workflow for a push whose commit says `[skip ci]`, a push of more than three tags at once, or a draft release, and it doesn't show a step's env-free text in logs but does show ref names in the Actions UI. The pre-push hook covers the first two. The maintainer and any tooling acting for them must keep to the same rules everywhere.
- **Commit identity is enforced.** Commits are authored by the one allowed identity in the rules; any other author is a hit (`identity`). The committer may also be GitHub's web-flow identity (`GitHub <noreply@github.com>`), which a merge in the UI records. The maintainer commits a contributor's PR under that identity. GitHub writes a squash merge's author at merge time, from the merging account's profile name and the commit email chosen for the merge, after every check on the PR has run. So the account's profile name must match the allowed identity, and the merge must use its address (`gh pr merge --squash --author-email <address>`). A wrong one is only detected afterwards, and it can't be cleaned.

---

## 8. Upgrading a live deployment

### 8.1 Rules for every upgrade

A control repo that runs from source picks up every merge on its next tick; one that pins a release picks up a new pin. Either way, an upgrade must preserve the running queue's behaviour (the same reads, decisions, writes, labels, refs, comments and state documents) unless it is applied under the quiesce procedure below. An upgrade that changes something a running deployment can observe (the state shape, a workflow, an environment name, the policy hash) is applied only after quiescing. Opening `pause` alone is not enough:
- it races a running tick, because a tick reads `pause` before it builds the snapshot and doesn't check again;
- the mirror issue is not authoritative;
- the queue's `pause` doesn't stop the release job.

**Quiesce procedure.** `bun "${bundle:?}" quiesce --config qlander.yml` runs it as one command ([quiesce](operating.md#quiesce)). By hand:
1. Wait until the queue has no active or pending batch and no PR waiting to run alone. A paused queue doesn't land or build them, so pausing under them stops them there. Then open a `pause` issue **and** a `release-pause` issue in the control repo.
2. If a state branch's `lease` has expired without being released, wait for the next tick, which runs paused and releases it. Then disable `tick.yml` (`gh workflow disable tick.yml`), so that no new job starts. Once it is disabled, nothing can release a lease.
3. Wait until no `tick.yml` run is `in_progress` or `queued`, and until each state branch's `lease` is null.
4. Read **both authoritative state refs** (`git show origin/<stateBranch>:state.json`, for the queue and for the release), not the mirror issues. Record both commit SHAs.
   - The queue must have `journal: null`, `active: null`, `lease: null`, empty `concurrent`, `pending`, `solo`, `verify` and `outbox`, and no `baseline` run still going (a `baseline` without a `result`). Its state branch must exist, unless it was absent at the first read too and every queue mirror issue listing is complete and shows none open: a queue no live tick has run has nothing in flight.
   - The release state must have `journal: null`, `pausePending: null` and `lease: null`. A release state branch that does not exist yet is fine only while the release job makes no writes (`release.enabled` false or `release.dryRun` true), the branch was absent at the first read too, and every release mirror issue listing is complete and shows none open.
5. Apply the upgrade.
6. Re-enable `tick.yml` while both pause issues are still open. The first ticks run paused, so the queue only verifies and the release job only reconciles. Check their job summaries and state commits. Then close both pause issues and watch one live tick of each job.

### 8.1.1 Rollback: code and state are separate

Rolling back a version rolls back **code**, not **state**. `StateStore.open` writes the state while it takes the lease, before any pause check. So the first tick of a new version persists any migrated state, even while paused, and the old code may refuse it (§6.1).
- **Code-only changes** (no change to the state schema) roll back by pinning, or reverting to, the previous version. The state written by the new code is, by construction, state the old code reads.
- **State-schema changes are staged.** First, a reader version reads `v(k+1)` and writes it back losslessly, while it still writes `v(k)`. That version ships and runs live. Only then does a writer version start writing `v(k+1)`. Rolling back the writer leaves the reader, and the reader reads everything the writer wrote.
- **When staging is impossible**, there is a quiesced recovery: quiesce (above), then restore. The state App writes a **new** commit on each state branch whose `state.json` equals the content at the SHAs recorded in step 4. This is a fast-forward, so the state-branch rulesets allow it. The restore is valid only if the target refs (`main`, `release`, the queue and build refs) still match what that state records. Otherwise an operator reconciles by hand before resuming. Release notes mark such a version "quiesced upgrade only".

### 8.2 The policy hash

`policyHash(cfg)` is `v2:` followed by 16 hex digits of the sha256 of a canonical, sorted projection of the policy-relevant config. Every authorisation records it, and revalidation drops a PR whose recorded hash differs: the PR loses `ready` and gets a comment. So **any change to policy-relevant config takes `ready` off every admitted PR at the next unpaused tick**, because the rules it was admitted under have changed. Apply a policy change while nothing is admitted. The projection leaves out `hooks`, `tokens`, `bundle`, `notify`, `comments`, `linkedIssues`, `control.mainProtection`, `queue.concurrency`, `queue.strategy`, `runner` (its timings feed hashed values, §3.5) and `release` except `branch`, `stateBranch` and `labels`. Everything else is in it, including `control.repo`, `queue.historyLimit` and `watchdog.labels`. A new optional key is left out while it is unset, so adding it to the code changes no existing deployment's hash.
