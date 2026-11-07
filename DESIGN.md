# Qlander design

Qlander is a merge queue for one GitHub repository, the **target**. It runs ready PRs through the pre-landing suite in batches, and then moves the target's `main` to exactly the commit that passed, using a compare-and-swap. It can also move a `release` branch to qualified `main` commits: by fast-forwarding it itself, or, in dispatch mode (§8.1), by dispatching the target's own release workflow and watching `release` move.

It runs from its own **control repo**, so the credentials that can move the target's `main` and `release` never share a runner, a checkout or a workflow file with target code. Every identity it acts on (both repos, the branches, ref prefixes and labels) comes from `qlander.yml` in the control repo. The control repo's visibility must be at least as restrictive as the target's (docs/deployment.md §3.3), so it is private unless the target is public.

## 1. Invariants

1. **Main only points at tested commits.** Qlander moves `main` to `Q` only when every job in the pre-landing manifest (§6) succeeded on `Q` itself. The evidence must come from a `push` run on `queue/<n>` in the target, from the expected workflow file, on the latest attempt. A result never carries over to another SHA or tree.
2. **Compare-and-swap, never force.** Every update to `main` and `release` is a GraphQL `updateRefs` with `beforeOid` (the head qlander expects) and `force: false`. If `main` is not exactly the batch's base, the update fails and the batch is rebuilt and retested. In release dispatch mode (§8.1) qlander makes no update to `release` at all: the target's workflow moves it, and qlander only reads it.
   **The one kind of forced write, linear landing only (§7.4).** With `queue.landing.mode: linear`, a landing makes two compare-and-swap writes: first each landed PR's head branch moves to that PR's stack commit, which does not contain the old head, so those entries carry `force: true`; then `main` moves, in a write that also requires every one of those branches to be at its stack commit. A forced entry is bounded four ways: only a branch recorded in the PR's authorisation at admission; only between the head SHA recorded there and that PR's stack commit, in either direction (`beforeOid`, which GitHub checks on a forced entry too, so a branch someone pushed to is refused, and with it the whole call); only to a commit qlander built for that PR in the batch CI just passed, or back to the admitted head when the landing does not complete; and only in a write that also requires `main` to be where qlander read it. Nothing else is ever force-moved, `main` and `release` included. Merge mode makes no forced write. A branch and `main` do not move in one atomic write, because GitHub then closes the PR without marking it merged (§7.4), so between the two writes a branch can read at its stack commit with `main` unmoved. If the landing does not complete, qlander moves it back.
3. **Only the authorised revision lands.** Every PR in a batch carries an authorisation record for (PR, head SHA, base, policy version) (§4.2). The record is checked again before every sub-batch is built and again immediately before landing. In linear mode what lands is the authorised revision's change, squashed: a commit whose tree is the tree CI tested, and none of the PR's own commits.
4. **A change to CI policy is never landed on its own CI's word.** Policy PRs run solo (or, opt-in, only with other approved policy PRs, §4.3 (d)) and need an approval from an account listed as an approver, bound to their SHA (§4.3).
5. **No target code runs with a credential.** Qlander uses the GitHub APIs only. It never checks out or executes anything from the target. It reads target JSON (a qualification manifest) through the contents API, and job logs (flaky tracking §10, the main baseline §5.7) through the Actions API, only as data: a log is matched as text against fixed patterns and nothing else is done with it.
6. **Effects are journalled.** Before qlander does anything with a side effect, it durably records the intent and reserves the budget. On the next tick it reconciles that intent by looking at the result (§3.2).
7. **Bounded cost.** Every build, rebuild and rerun takes its reservation from both the lineage budget and the rolling window budget. When a budget runs out, qlander pauses or bounces. It never loops.

## 2. Moving parts

```
target PR ─ fast lane (+ optional producer-bound review, on head H) ─▶ label `ready`
                                │  poll on a cron / workflow_dispatch
                                ▼
 queue job (queue App key) ─ admit: auth record (PR,H,base,policy) ─▶ select batch
   ─▶ merges on qlander-build/<n> ─▶ verify signatures ─▶ create queue/<n> (one push)
   ─▶ target CI on queue/<n> ─▶ green: updateRefs main B→Q ─▶ verify PRs merged
   (linear mode, §7.4: a stack commit per PR on its merge's tree is pushed instead; an
    updateRefs first moves each PR branch H→S, then another moves main, so GitHub marks it merged)
                                 red:   rerun failed once → split (≤ maxSplitDepth) → solo → bounce

 release job (release App key) ─ newest qualified main commit C (§8) ─▶ updateRefs release R→C
   or, dispatch mode (§8.1):  ─▶ dispatch the target's workflow for C (dry run) ─▶ approval of C
                              ─▶ dispatch it for real ─▶ observe release at C (read only)
```

The code map is in [CONTRIBUTING.md](CONTRIBUTING.md#where-things-are). [Operating, The command line](docs/operating.md#the-command-line) lists every command.

## 3. State

### 3.1 Where it lives

The store of record is the queue's **state branch** (`queue.stateBranch`, for example `qlander-state`) in the control repo. The release job keeps its own store on `release.stateBranch` (§8), with a different document, lease and pause, never read by the queue. Each branch points at a commit whose tree holds `state.json`.

A ruleset on each branch restricts creation, update and deletion, and blocks force pushes, with **only the state App** as a bypass actor (no GitHub Actions, no people). That App is installed on the control repo only, with Contents: write, and its key is held only in the reviewed-main environments. A custom ref outside `refs/heads` would not do: rulesets cannot protect it, so any same-repo workflow, token, deploy key or other App could rewrite it.

- **Writes:** every write makes a new commit on top of the commit the writer read, and moves the ref with GraphQL `updateRefs` (`beforeOid` = that commit, `force: false`). A stale writer fails instead of overwriting.
- **Audit:** the commit history is the audit log.
- **Credentials:** both jobs write their state branch only with `STATE_TOKEN`, an installation token of the state App minted in the job. One `StateRefClient`, parameterised by branch name, is the only code that writes either branch, and it refuses any other branch. Nothing writes state with `GITHUB_TOKEN`, which has `contents: read` (§12.2).
- **Lease:** each state document also carries its job's **whole-tick lease** (`lease: {owner, until, acquiredAt, executor}`, §15).
- **Initialisation:** if the queue's state branch is missing while a mirror issue (below) still holds a non-empty (or unreadable) state, qlander refuses to initialise and pauses. It starts from empty only when there is truly nothing there.
- **Mirror:** the issue labelled with the mirror label (`queue.controlLabels.mirror`) is for people. It is rewritten after each tick, and read for one decision only: the initialisation guard above. An issue cannot be the store, because issue edits have no conditional write and a stale writer could erase a landing. Check runs on queue SHAs cannot either: they cannot journal intent before the SHA exists, and they tie recovery to branch retention.
- **Cross-checks:** target writers cannot touch the state branches. Every tick also checks the state against live reads: the target repo id, that `queue/<n>` exists at the recorded head, that the recorded base is the head's first-parent root, and that each second parent is the pin. A mismatch pauses the queue.

```json
{
  "v": 5, "seq": 118, "policy": "<config hash>",
  "journal": null,
  "active": { "n": 42, "base": "<sha>", "head": "<sha>", "depth": 1,
              "prs": [101, 103], "lineage": 40, "rerun": { "runId": 1, "attempt": 1 } | null, "cancels": [ { "runId": 2, "attempt": 1, "cause": "timeout" } ],
              "builtAt": "…", "phase": "testing" },
  "auth":   { "101": { "head": "<sha>", "base": "main", "baseRepo": "<target repo id>",
                       "policy": "<hash>", "admittedAt": "…", "labelEvent": 99, "evidence": [ … ] } },
  "pending": [ { "prs": [104, 105], "depth": 1, "lineage": 40 } ],
  "solo":    [ { "pr": 106, "lineage": 41, "reason": "policy" } ],
  "lineages": { "40": { "runs": 3 } },
  "window":  [ { "at": "…", "cost": 1 } ],
  "redStreak": 1, "bounceStreak": 0, "lastLandedAt": "…",
  "verify":  [ { "pr": 99, "pin": "<sha>", "landedIn": "<sha>", "since": "…", "notified": false } ],
  "history": [ /* last 100 terminal batch records */ ]
}
```

The sample is abridged; `src/state.ts` has the full schema.

**Optional fields** have no version bump. Flaky tracking's (§10) appear only once a red batch is rerun, and those of `queue.strategy` (§5.7) and `queue.concurrency` (§5.6) only while their keys are on, so a queue without them writes the same document as before. A release that does not know a field refuses the document and pauses (docs/deployment.md §6.1, §8.1.1).

### 3.2 Journal (intent and receipt)

Every effect follows the same three steps:

1. Write the state with `journal = {seq, op, args, reserved}`. Budget is reserved at this point.
2. Perform the effect.
3. Write the state with the result applied and `journal = null`.

Each tick first reconciles a leftover journal, by observation:

| Op | Observed, and what follows |
| --- | --- |
| `build(n, base, pins)` | **Before the checkpoint (§7.1 step 6),** the build is not recorded. With no `queue/<n>`, qlander deletes `qlander-build/<n>` and releases the reservation; no CI was spent. **After the checkpoint,** the record holds `survivors` and `dropped` (a pin plus its outcome, `conflict` or `noop`, for each dropped PR). If `queue/<n>` exists and its chain matches base plus `survivors`, it is adopted as active. If it is absent, qlander creates it from the recorded chain head. Only then are the recorded drop outcomes applied: comment and unready, idempotently. **A `queue/<n>` that exists with no record, or that doesn't match the record,** means CI may have run: the charge stays, the batch is recorded as abandoned, its runs are cancelled, its refs are deleted, and the queue pauses. A record that fails its checks with no `queue/<n>` releases the reservation and pauses. |
| `rerun(runId, attempt)` | If the run's `run_attempt` is greater than the recorded attempt, it is done. If not, wait with the reservation held. An unconfirmed request is never resent: after `reconcileMinutes` the operation ends and the queue pauses. |
| `land(B → Q)` | Run this **before any PR-integrity check**. If `Q` is an ancestor of or equal to `main` (compare `Q...main` is `identical` or `ahead`), the batch landed: record a receipt and move its PRs to `verify`. If `main == B`, it was not applied, and `decide` runs again. Anything else means main moved without us, so rebuild. **Linear (§7.4),** each PR branch is read too. `main == B` with every branch at its admitted head is resent after revalidation. Anything else settles the branches first with one guarded write; refused, the journal stays and the next tick observes again, pausing with the journal kept once `reconcileMinutes` have passed. |
| `comment` / `label` / `cancel` | These are idempotent. Every comment carries a hidden marker, `<!-- qlander:<seq>:<pr> -->`, and is skipped if that marker already exists. |
| `advance(R → C)` (release) | Same as `land`. |
| `dispatch(kind, C, id)` (release, dispatch mode, §8.1) | Never resent. The candidate gets a record of the dispatch with `sent: unknown`, and its run is looked for by the dispatch id `id` until `release.dispatch.appearMinutes` have passed; after that the dispatch counts as `never-appeared`. |

**Retention:** `queue/<n>` and `qlander-build/<n>` refs are deleted once their batch is terminal and recorded in `history`. Recovery never needs an old ref, because `verify` and `history` live in the state document. Batch numbers come from `state.seq`, not from the refs. The ref prefixes (`queue/`, `qlander-build/`), `main` and `release` used throughout are example names; each is set in `qlander.yml`.

## 4. Admission

### 4.1 Producer-bound evidence

Each requirement names a **subject SHA** (the commit being vouched for) and a **producer** (who vouches). Three adapters are allowed, and every field each one lists must match:

| Adapter | Producer check | Subject binding |
| --- | --- | --- |
| `job@subject`: the run executes the subject itself (the fast lane, queue CI) | A workflow run with `path`, `event`, `repository.id` and `head_repository.id` as configured; the newest such run; jobs read with `filter=latest` | `run.head_sha == subject` |
| `job@main`: the run executes main's revision and judges another SHA (a review workflow) | A workflow run with configured `path`, `event` in the configured `events` (normally `workflow_run` and `workflow_dispatch`), `head_branch == "main"` and `repository.id`, where `run.head_sha` (the **producer revision**) is reachable from current main | The job name is exactly `<template with {sha} = subject>`, for example `Reviewed <H>`, and it is on the latest attempt. `run.head_sha` is **not** compared with the subject. |
| `app-check` (a dedicated App) | A check run whose `app.id` equals the configured App id and whose `name` equals the configured name | The check run's `head_sha == subject` |

In every adapter the job or check must have concluded `success`. A producer that fits none of these never counts. An arbitrary commit status (which anything with `statuses: write` can post) is never authorisation.

PR-head requirements are the fast lane and, when configured, the review:
- **Fast lane:** `job@subject`, from `queue.admission.fastLane` (workflow, event and job name), with the PR head as the subject.
- **Review:** optional (`queue.admission.review.required`). When it is off, `ready` must be applied by a write-access account, and admission trusts that account to have reviewed this head: nothing machine-checks that the review happened. When it is on, the review producer (`job@main` or `app-check`) must vouch for the head.

### 4.2 Authorisation record

A PR is admitted, and gets its `auth` entry, when all of these hold at once on a single tick:

- the PR is open and not a draft;
- `base.ref == main`;
- the base and head repos are the target (no forks);
- the head branch is not `main`, `release`, `queue/*` or `qlander-build/*`;
- `ready` is present, and its latest `labeled` event's actor is either the configured review producer (`queue.admission.review.producerLogins`, or the review App) or a user with write permission. A latest event GitHub returns without an actor makes `ready` not validly applied (an older event never stands in for it). For a policy PR, a producer-applied `ready` is not enough: the §4.3 approval is still required;
- `mergeable` is `true`;
- every commit has `verification.verified`;
- every PR-head requirement (§4.1) holds for the current head `H`;
- for a policy PR, the §4.3 approval for `H` is present.

A PR that conflicts with `main` or has an unsigned commit loses `ready` and gets a comment; every other refusal leaves the label on and is reported (below).

The record is (PR, `H`, base ref and repo id, policy hash, label event id, the evidence's run ids and attempts). In linear mode (§7.4) it also holds the PR's head branch (`headRef`), the only branch the landing may move for it, and revalidation drops the PR if that changes.

**Cutoff.** A label is not bound to a SHA. The evidence binds authorisation to `H`: the fast-lane job, the review (when required) and any policy approval all name `H`. A push after admission changes the head, and then the record no longer matches. A push can still arrive after the final revalidation. The pinned `H` still lands, which is the authorised revision, and §7.3 reports that the later commits did not land.

**Revalidation** happens before building any batch or sub-batch (including pending and solo work) and again immediately before `land`. It re-reads each PR and requires everything in the admission list above, with the head still equal to the pinned `H`, base still `main`, and the policy hash unchanged. Any failure drops the PR (§5.3 rule 3), with one exception: **mergeability not computed yet** (`mergeable` null, as GitHub reports for a while after every landing moves `main`) is a *hold*.

- A held PR keeps its record, its place and its fill clock (`state.held` records since when).
- Nothing is built or landed with it that tick: a fresh batch is built without it, a pending or solo batch containing it waits whole, and an active batch containing it neither lands nor is abandoned.
- A hold that lasts `HOLD_MINUTES` (10, a timing constant in `src/machine.ts`, not policy) becomes a drop.
- Every other wait (fast lane, review, approval) still drops an admitted PR.
- Recovery's revalidation of a journalled build or rerun (src/queue.ts) still treats a hold as a failure.

**A waiting PR is told why.** Once a ready PR that is not admitted has waited `WAIT_NOTICE_MINUTES` (30, a timing constant in `src/machine.ts`, not policy) for something it cannot get by itself, qlander posts one comment on it, per head and per reason:

- **A CI-policy approval,** counted from its `ready` label: the comment names the head and the approvers and gives the exact `/qlander approve-policy <head>` line to post.
- **Mergeability GitHub has not computed,** counted from the hold's start in `state.held`: the comment says so and suggests a push.
- **A red fast lane,** counted from its `ready` label: the comment names the head and the verdict, and says to rerun it or push a fix, or to remove `ready`. Red means the newest run for the head has finished without the job passing, so a run still going never counts, and neither does a failed read.

The comment is re-raised on every tick while the PR waits, and the outbox's marker check posts it once (a duplicate needs GitHub's comment list to miss a posted comment for longer than a tick). `comments.omit` never leaves it out, since it asks someone to act. It is best effort (`isBestEffort`, src/outbox.ts): a failure to post it never pauses the queue or holds up other notices. A fast lane still running or not yet started, and a wait for a review, get no comment, because their checks are visible on the PR and nothing has gone wrong yet.

**No ready PR is ignored silently.** Every tick that decides reports a verdict for every PR that is ready but not admitted when the decision ends: a log line `#N ignored: <reason>`, and the same list in the tick's JSON report (`ignored`), which the status issue shows.

The verdict covers every PR the listing or a read shows with the label, names the reason (a refusal, a wait, a pending label removal, a drop, a landed head awaiting GitHub's merge mark, or a pause), and is reporting only: no decision reads it.

### 4.3 CI-policy changes

The **policy boundary** (`queue.policy.paths`) is the set of files that define or implement the gates: the workflows, local actions and scripts under `.github` (normally all of `.github/**`), gate files such as a qualification manifest, and whatever else the target's CI depends on (build definitions, the CI tooling's lockfiles, lint and analysis config, release scripts, test-runner config). It lives in qlander config, not in the target. The loader insists only that it covers the whole `.github/workflows` and `.github/actions` directories and every gate file. Anything else the gates use (scripts elsewhere under `.github`, for example) must be listed explicitly, or a change to it is not a policy PR.

A PR that touches any of these is a **policy PR**. Policy PRs are always tested solo, whichever source the batch comes from, including pending and solo work (§5.4), unless opt-in (d) lets approved policy PRs share a batch.

- **(a) Gates from protected main: out of scope.** Running main's workflow wrapper against the candidate does not protect the gate *implementations*: the scripts, build definitions, test configuration and fixtures the wrapper checks out from the candidate. Protecting those would mean running main's tests against the candidate's application code.

- **(b) An approver's exception bound to the exact SHA.** A policy PR runs alone, needs its fast lane (and review, when required) like any PR (§4.1), and is admitted only with an approval comment from an account in `queue.policy.approvers` (login and id, both checked). The comment body must be exactly `/qlander approve-policy <40-hex H>`, and it must not have been edited. The PR is still tested solo on its own CI.

  The weakness: the approver is the gate for whether the changed CI is as strong as the old one, and qlander can check the account, not who is using it. Keep those accounts to people. If an approver's account is also driven by automation, the gate is only as strong as that automation's instructions.

- **(c) Trusted automations: opt-in.** `queue.policy.trustedAutomations` may list bot accounts (login including `[bot]`, and id) with the exact paths each may change, say a dependency bot and its lockfile. A bot's PR needs no approval only when all of these hold for its head (`src/automation.ts`):
  - the bot opened it;
  - every changed file, renames under both names, matches one of its paths;
  - every commit is signed and authored by the bot as GitHub resolves it;
  - every commit was pushed to the branch by the bot, read from the repository activity API, with no other account ever moving the branch to it.

  Then the bot's own `ready` counts and a CI-policy change needs no approval. Anything else falls back to (b).
  - **Still applies:** the PR runs the full suite in a batch of its own, the waiver is recorded in its authorisation and named in its queued and landing comments, and revalidation drops it if the trust stops holding.
  - **Paths:** `*` within one segment only, never `**`, never under `.github` or on a gate file.
  - **Policy hash:** the list is in the hash when set; absent, the hash is unchanged.
  - **Fails closed:** a multi-commit push (not provable commit by commit) and an activity history longer than qlander reads (five pages).
  - **Late waiver:** a PR that becomes admissible only through a waiver after it was admitted without one is dropped and re-admitted, so it is batched alone.
  - **Residual risk:** a human with push access can move the branch away and back to the same sha between qlander's activity read and its head re-check. The code landed is still exactly the bot's pinned commit, so this loses provenance, not content. Branch protection that lets only the bot push to its branch closes it.

- **(d) Shared batches for approved policy PRs: opt-in.** With `queue.policy.shareBatch: { max: N }` (N ≥ 2, at most `queue.batch.max`), the policy PRs at the head of the FIFO, each admitted with its own approval under (b), share one batch of at most N (and at most the batch size after the red streak).

  - **Guarantees.** Every gate change on main was approved at its exact SHA by an account listed as an approver, and the tree that lands passed the gates it carries. The target cannot change the pre-landing manifest (required workflows and job names, in qlander config) or the classification: a missing or wrongly skipped required job in a batch with a policy PR is `red` (§6.2).
  - **Policy PRs only, never with ordinary PRs.** Selection takes only the FIFO prefix, so a later policy PR never jumps an ordinary one to join an earlier one, and FIFO (§4.4) holds. Each policy PR's queued comment names the other policy PRs in its batch.
  - **The limit you accept.** Each PR is also tested under the gate changes of the PRs behind it, approved but not yet landed. If a later PR weakens a gate, a defect in an earlier PR that the old gate would have caught can land with it, and bisection cannot find it, because the batch is green. The cap N limits how many unlanded gate changes one batch can combine. An approver who judges that a PR weakens a gate can mark it `solo` (§10). A test-runner config or a lane script can weaken a gate as much as a workflow edit can.
  - **Nothing unapproved rides along.** Each PR is admitted and revalidated alone (§4.2), with its approval at its pinned head checked before every build and landing. An unapproved policy PR is never admitted, and one whose approval or head changes is dropped and the batch abandoned. A trusted automation's waived PR (c) and a PR marked `solo` still run alone.
  - **Bisection.** A red shared batch is rerun, then split like any batch (§5.3 rule 6). Its halves hold only policy PRs and are capped the same way. At the depth limit each PR runs alone, and a red single PR is bounced. Missing or skipped required jobs are `red`, never `config`.
  - **Timing.** A policy PR never waits to fill. It builds at once, with whichever approved policy PRs are already right behind it.
  - **Config.** Absent, the key is absent from Config and the policy hash is unchanged. When set, it is in the hash, so turning it on or off drops every admitted PR as a policy change (§4.2, `ready` removed): switch it with nothing admitted. An approval comment names its head, so it still counts when `ready` is added again. Turned off with a shared split half still pending, its PRs run alone.

### 4.4 Order

Strict first in, first out, by `admittedAt`, which persists across rebuilds and splits. Pending and solo work always come before new candidates, so a PR is always attempted before any PR admitted after it, except under the priority lane below. An operator can mark a PR `solo` (§10), which changes how it is tested but not its position.

**Priority lane: opt-in.** With `queue.labels.priority` set, a PR carrying that label goes first.

- **Who.** The label counts only when its latest `labeled` event is by a user with write, maintain or admin access (looked up each tick, as for an operator command, §10), and never when the actor is a bot: a configured trusted automation, a review producer, or any `[bot]` login, whatever its access. A label whose provenance cannot be read (including a latest event without an actor), or whose actor's access cannot be looked up, means no priority that tick, never an error.
- **Ordering only.** Priority never touches admission or revalidation (§4.2): the PR still needs its fast lane, review, signed commits, mergeability and, for a CI-policy change, a SHA-bound approval. It runs the full suite, and a red result is rerun, split and bounced as usual. The authorisation record carries `priority: {by, at}`, refreshed from the live label every tick at the authorised head. Removing the label, or a head change (which drops the admission anyway), returns the PR to its FIFO place.
- **Selection.** Prioritised fresh candidates come before `solo`, `pending` and other new candidates (§5.4 step 1), in FIFO order among themselves. Their batch is built at once, with no fill wait, and holds prioritised PRs only, under the usual solo filter (step 2): a CI-policy PR runs alone (or with other prioritised approved policy PRs under §4.3 (d)), and a waived or operator-solo PR runs alone. Ordinary PRs wait for the next batch. A PR already in a running batch or a recovery item (a split half, a retest) keeps its place there, since pulling it out would re-merge what bisection had split. While a prioritised PR is held on unknown mergeability (as every PR is for a while after a landing), nothing else is built, for at most the hold limit.
- **A running batch, default: left alone.** The priority batch builds as soon as that batch lands, bounces or splits.
- **A running batch, `queue.priority.preempt: true`.** The running batch is stopped through the usual abandon path: its runs are cancelled from the outbox (`cancelRuns`), it is recorded as abandoned, and its PRs go back to the front of `pending` in their order, with the same lineage and depth (a PR running from `solo` goes back to the front of `solo`, ahead of its split siblings), right behind the priority batch, which builds in the same tick.
  - **The safe point:** only while the batch's CI is still `pending`, after every PR in it revalidated (none held). A green batch is landed, and a red, timed-out or inconclusive one is handled as such, first. A landing is a journalled op, and `decide()` never runs while a journal is outstanding, so a batch can never be stopped mid-landing.
  - **Never** a batch that already carries a prioritised PR, and never when the window budget could not pay for the priority build or the batch's lineage for its retest (stopping a lineage's last run would unready its PRs).
  - **At most once per lineage** (`lineages[l].preempted`), so an ordinary batch loses at most one run to preemption however many priority PRs arrive. The stopped run stays charged to the window and to its lineage, and the retest is charged again.
- **Trade-offs.** Every prioritised batch pushes every waiting PR back by one batch. With preemption, a stopped batch also costs a full-suite run that produced nothing, and its PRs a full CI duration. A stream of prioritised PRs can still starve ordinary ones. Priority is a write-access decision, like `bounce`, and its use is visible in the queued and landing comments and in the hook events (`details.priority` on `admitted` and `batch_started`).
- **Config.** Absent, neither key is in Config and the policy hash is unchanged. When set, both are in the hash (`preempt: false` adds nothing), so turning the lane on drops every admitted PR as a policy change (§4.2): switch it with nothing admitted. The label stays on a PR after it lands or is bounced; remove it if a re-queued PR is no longer urgent.

## 5. State machine

### 5.1 Snapshot

```
Snapshot { now, paused, main, state (§3.1), journalOutcome?,
           prs: Map<n, LivePr>,           // live reads for active/pending/solo/verify/candidates
           ci?: CiClass,                  // §6.2, for the active batch
           mainFailedJobs?: string[] }    // main's latest completed push run of the pre-landing workflow
```

### 5.2 Batch phases

`idle → building → testing → (rerunning → testing) → landing → idle`, with `verify` entries kept separately. `building` and `landing` each run inside one journalled op.

### 5.3 Rules, in order

1. **Reconcile the journal** (§3.2).
2. **Paused:** process `verify` only. CI on an active batch keeps running, but nothing lands, builds or reruns.
3. **Revalidate the active batch** (§4.2). If a PR fails, drop it. If its head moved, or a policy fact changed, remove `ready` and comment. Then abandon the batch: cancel its runs and charge the lineage and window for the run it consumed. Return the surviving PRs to the front of `pending` with the same depth and lineage.
4. **Classify CI** (§6.2):
   - `pending`: wait.
   - `infra`: rerun once; if it is still `infra`, pause.
   - `config`: pause at once, with no split or bounce.
   - `green`: go to rule 5.
   - `red`: go to rule 6.
5. **Green.** If the batch was rerun and `redJobs` is set, the rerun passed where the first attempt failed: record the flake (§10) and clear `redJobs`, so it is recorded once. This happens before revalidation and before any wait for another batch (§5.6), so a batch dropped by revalidation still records it. Revalidate again. If `main != base`, rebuild with the same PRs, depth and lineage (this needs a reservation). Otherwise **land**. If `updateRefs` fails, re-read `main`:
   - if it moved, rebuild;
   - if it is unchanged, classify the error: a ruleset, permission or signature rejection pauses; a 5xx retries on the next tick.

   On a landing: comment on each PR, move each PR to `verify`, and set `redStreak = 0` and `bounceStreak = 0`.
6. **Red:**
   1. If `rerun == null` and a reservation succeeds, rerun the failed jobs of each failing evidence run once, and keep the failed jobs in the batch's `redJobs` (the rerun runs are its `rerun`).
   2. If the batch has one PR and every failed job also failed in `mainFailedJobs`, pause because main is red. Don't bounce.
   3. If the batch has one PR, **bounce** it: remove `ready` and comment with the failed job names and their `html_url`s. Then `bounceStreak += 1`, and if `bounceStreak >= queue.batch.breakerBounces`, pause.
   4. If there is more than one PR and `depth < queue.batch.maxSplitDepth`, **split**: push the right half and then the left half (`floor(k/2)` PRs) onto `pending` at `depth + 1`, with the same lineage. (With `queue.strategy.firstAlone`, §5.7, a fresh batch splits as its first PR and the rest.)
   5. If there is more than one PR and `depth` has reached `maxSplitDepth`, put each PR on `solo`, in order, keeping the lineage.

   In every red case, `redStreak += 1`.
7. **Idle: select the next batch** (§5.4), reserve the budget, and build. With `queue.concurrency` (§5.6), rules 3 to 6 apply to each running batch in turn, and selection runs while a slot is free.

### 5.4 Selection (one function, used for every source)

1. The work source, in order:
   - prioritised new candidates (§4.4, when the priority lane is configured), built at once;
   - the head of `solo` (single PRs from a split that reached the depth limit, so the deepest split is finished first);
   - the top of `pending`;
   - new candidates.
2. **Solo filter**, applied to whichever source was picked: a policy PR, a trusted automation's waived PR, or one an operator marked solo, always forms a one-PR batch. If it is at the front, it is taken alone. If not, the batch stops before it. With `queue.policy.shareBatch` (§4.3 (d)), a policy PR at the front instead takes the approved policy PRs right behind it, up to the cap, stopping at the first PR that is not one; an ordinary prefix still stops before a policy PR.
3. Size:
   - normal: `clamp(1, max(min, max >> redStreak), available)`, or with `queue.strategy.adaptive` (§5.7) the adaptive limit;
   - pending work: as split.
4. Budget: if the lineage has used `lineageBudget` runs (`queue.budget.lineage`; the one-culprit-in-8 worst case is 7 builds plus 4 reruns, plus one rebuild, so leave headroom above 12 for diagnostic isolation), remove its PRs from `pending` and `solo`, unready them with a comment, and select again. If the rolling window (`queue.budget.windowHours`) is at `windowBudget` (`queue.budget.window`), pause.

### 5.5 Worked cases (each is a test)

| Case | Path |
| --- | --- |
| Batch of 5, #3 is the culprit | [1–5] red, rerun red → split [1,2] / [3,4,5]. [1,2] green and lands. [3,4,5] on the new main: red, rerun red → split [3] / [4,5]. [3] red, rerun red → bounced. [4,5] green and lands. |
| A and B pass alone, fail together | [A,B] red, rerun red → split [A] / [B]. [A] lands. [B] on main+A: red, rerun red → bounced. The comment says it fails on a main that contains A. |
| Flake | Red, rerun green → lands, and is recorded as flaky (§10). |
| Base moved | Green, but `main != base`: no `updateRefs` call is made; rebuild. Or `updateRefs` with `beforeOid=B` fails, `main` is re-read as moved: rebuild. |
| Head changed | Revalidation drops the PR, the batch is abandoned, and the rest are rebuilt. |
| Conflict | The merge returns 409: drop the PR, unready it, comment, and continue the build. |
| Skipped or cancelled required job | Never green. Skipped → `config` (or `red` if the batch has a policy PR, §6.2). Cancelled (not by us) → `infra`. |

### 5.6 Several batches at once: split halves side by side, and pipelining (opt-in)

With `queue.concurrency` set, up to `maxActive` batches' CI runs at once (default 2 when the block is present). Without it, everything above holds exactly: one batch at a time. `policyHash` leaves the block out, like `runner`, because it changes when a tested commit lands, never what may land or on what evidence. Switching it on or off does not drop admitted PRs.

**State.** `active` stays as it is. Further running batches go in an optional `concurrent` list, in batch-number order, absent while at most one batch runs. A speculative batch carries `on: <n>`, the batch whose head it was built on.
- A queue without `queue.concurrency` never writes either key, so its state documents are byte-identical to before, and the previous version of the code reads every document the new one writes.
- With the block on, the keys appear only while two batches run. The previous version refuses such a document (an unknown key), so it pauses instead of acting on it.
- **Rolling back:** remove the block, let the running batches drain (nothing new starts beyond one batch, and the extra batches are still handled), and only then revert code, if at all. Reverting code while batches overlap needs the quiesced recovery.

**One effect per tick.** The journal holds one op, so recovery after a crash is unchanged.
- A rerun, cancel or landing always concerns `state.active`: the batch it is for is moved into `active` before the op is journalled, and the other running batches into `concurrent`.
- A build may be journalled while other batches run, but it may pin no PR that a running batch, `pending` or `solo` holds.
- Recovery resumes a recorded build only if its base is still main or the head of a batch that is still running.
- Starting both halves of a split takes two ticks: the first build's wake is "now" (§11.1), so the second follows within a minute or two.

**Selection** (§5.4) runs while fewer than `maxActive` batches run, one build per tick:
1. Prioritised PRs, `solo`, then `pending`, each built on main.
2. Fresh candidates, only ordinary PRs (no CI-policy, waived or operator-solo PR at the head):
   - with nothing running: on main;
   - beside fresh batches only (nothing in `pending` or `solo`, no running batch at depth > 0): **pipelining**, stacked on the newest batch of the chain, while fewer than `pipelineDepth` (default 1) batches are stacked, and only on an ordinary batch whose CI is pending or green and not being rerun;
   - beside recovery batches (every recovery item already started, no fresh batch running): one fresh batch on main.
3. A further slot never pauses the queue on the window budget: it stays empty, and only the first slot pauses.

**Landing.** `main` is still moved only by compare-and-swap from a batch's base to its tested head (§1, §7.2).
- A green batch lands when `main` is its base and no running batch ahead of it in FIFO order (by its oldest PR, prioritised PRs first, §4.4), on any base, is still undecided. A batch has decided once it has failed: its CI is red, or it is being rerun after a red and the rerun has not passed. So with one red and one green half, the green half lands at once, even when it is the later half. FIFO gives way only to PRs whose batch has already failed, which are under isolation.
- When both halves are green (the whole batch was flaky, or the halves conflict), the earlier lands. The later is then on a stale base, so §5.3 rule 5 rebuilds it on the new main and tests it again, and it still goes before any younger batch. FIFO is by PRs, not batch numbers, so a rebuilt half keeps its place.
- A batch whose base went stale never lands: a green one is rebuilt (rule 5); a red one is split or bounced, because its failure was observed on its own base.
- A speculative batch lands only after the batch under it has landed: `main` then equals its base, and the landing is a fast-forward to the head tested on top of it. Its red, inconclusive or green result is acted on only then, since a red may be the fault of the untested batch under it (a hung run is still cancelled).
- If the batch under it ends any other way (split, bounced, abandoned, rebuilt), the speculative batch is **discarded**: its runs are cancelled, it is recorded as `abandoned` with a note starting `discarded`, and its run stays charged to the window and to its own new lineage. Its PRs keep `ready` and their FIFO place as fresh candidates, with no comment, and their next batch gets a new lineage, so a discard never spends their retry budget.
- A speculative build in which a PR does not merge (a conflict on top of the running batch, which may never land) is refused as a whole: nothing is pushed, nothing is charged, every PR keeps its admission and place, and the history records `empty` with a note starting `speculation on batch <n> refused`. No further batch is stacked on that batch, since nothing behind the refused PR may go first; it is retried on main once that batch has landed or failed.

**Splits and order.** A red batch follows rule 6. With several batches, the requeued halves go ahead of the first `pending` (or `solo`) item whose oldest PR is younger, so the halves of two batches that failed side by side keep FIFO order. Without the block they go to the front.

**Counters and limits.** Every build, rebuild and rerun of every running batch reserves from the window and its lineage. Split halves share their parent's lineage, so the lineage budget bounds a whole isolation, whether its runs overlap or not. Concurrency adds runs only where the serial queue would too: a both-green split rebuilds the later half, and a discarded speculative batch costs its own run. `maxSplitDepth` is unchanged. `redStreak` and `bounceStreak` count each red and bounce, and a landing resets both, even while another batch is still isolating.

**Other behaviour.**
- `solo` and `bounce` act on whichever running batch holds the PR.
- Preemption (§4.4) applies only when every slot is taken, and only to the newest batch.
- A pause stops every batch alike.
- Each batch has its own cancellation window.
- The CI watch of self-chaining (§11.1) covers every running batch, and a tick that leaves a slot free with work waiting chains at once.
- The status view and the watchdog's status issue list the further running batches.

**Capacity.** Concurrent batches multiply the target's CI load by up to `maxActive` while they overlap: during isolation, and while a speculative batch runs. Size `maxActive` to the CI pool.

### 5.7 Isolation strategy (opt-in)

`queue.strategy` holds opt-in changes to how a red batch is isolated. Simulator results are in [How it works](docs/how-it-works.md#isolation-strategies-opt-in). Every key is off when absent, and with the block absent (or every key false) Config has no `strategy` key and everything above holds exactly. The block is not policy: `policyHash` leaves it out, because it decides which tested commit lands when, never what may land or on what evidence. A PR is still bounced only on a red run of its own, alone. Each key works with one batch at a time, and with `queue.concurrency`.

- **`firstAlone`.** A red *fresh* batch (depth 0) of more than one PR splits as `[first PR]` and `[the rest]`, both at depth 1 with the same lineage, instead of into halves. The first PR lands (or is bounced) on the next run, without waiting for a bisection of its half.
  - The rest, if red, is isolated as in rule 6 (halves while `depth < maxSplitDepth`, else each PR on `solo`), as is every red batch at depth 1 or more.
  - With `maxSplitDepth: 0` a red fresh batch goes to `solo` and the key changes nothing.
  - **The trade:** the oldest PR lands sooner, but a whole isolation costs more on average, and less only when the first PR is the culprit. With `skipSeenRed` the extra run goes: the rest, built after the first PR lands, is the red batch's tree. Not with linear landing, where a PR stacked on the one that landed can merge differently (§7.4), so entries are not carried across a linear landing and that run stays.

- **`skipSeenRed`.** A batch of several PRs that goes red is remembered in `seenRed` as its base and its PRs at their pinned heads.
  - **Keeping entries:** a landing moves main from `before` to a tested head by fast-forward, so an entry on `before` that starts with exactly the landed PRs (same heads, same order) now describes the rest of its PRs on the new main: merging them onto the landed head gives the red batch's tree, merge by merge. Any other entry is stale and goes, as does one whose base is no longer main or one of whose PRs is no longer admitted at its pinned head. At most 8 entries are kept.
  - **Skipping:** when selection would build a `pending` item of several PRs whose pins equal an entry's on the current main, it splits the item without a run (history `split` or `solo`, numbered after the red batch, `head: null`, note `already seen red as batch <n> …`) and selects again. A skipped split does not count towards `redStreak`.
  - **Never bounces on an inference:** a single PR is always built, so a bounce cites a run of its own.
  - **Usual case:** a bisection whose earlier half lands, leaving the later half as the red batch's tree on the new main.
  - With `queue.concurrency` the halves already run side by side, so there is rarely anything to skip. With the key off nothing reads or writes `seenRed`, and a leftover one is removed.

- **`reuseGreen`.** A paused queue keeps a running batch, and lands it on resume if its run is green (rule 2). This key covers a batch the queue *abandons* as it pauses: an inconclusive run after its rerun (`infra`), a `config` problem, or a solo PR failing only what fails on main.
  - **Parking:** such a batch, put back whole, is remembered in `parked` (`n`, base, head, pins, depth, lineage, `builtAt`), and its runs are left to finish instead of being cancelled. While the queue is unpaused and main is still its base, the snapshot reads its CI (`parkedCi`, classified like any batch's, under the current config).
  - **Reusing:** this comes before anything else in selection, and so before the budget checks (it needs no run), with no batch running and no prioritised PR waiting. It needs all of these: the work selection would take next is exactly its PRs at their pinned heads (the head of `solo`, or of `pending` as one batch, or fresh PRs that start with them after a config change readmitted them), each revalidates now, and that run is green. The parked batch then becomes the running batch with its old number, base and head, and its landing is journalled at once: no build, no run, no fill wait.
  - **Otherwise** it is unparked, and its runs are cancelled then: main moved, a PR in it left the queue or moved, the run is not green or could not be read (an unreadable run never fails the tick), a different build goes first, or the key is off.
  - **Typical use:** an operator fixes the CI host and reruns the batch's run by hand while the queue is paused. The batch lands with no new run; without the key it is rebuilt and runs its whole CI again.

- **`adaptive: { greens, ceiling }`.** The fresh batch size limit adapts, as in Zuul's and Mergify's windows (grow on green, halve on red).
  - **Start:** `queue.batch.max`.
  - **Grow:** it doubles, up to `ceiling` (at least `queue.batch.max`), after `greens` fresh batches in a row land green *using the whole limit*. A smaller batch says nothing about a bigger one, so it neither counts nor resets the count.
  - **Shrink:** it halves, not below `max(1, queue.batch.min)`, when a fresh batch of several PRs is red, and the count restarts.
  - **What counts as green:** only a fresh batch that lands on its first run. Recovery batches (depth > 0) neither grow nor shrink the limit. Recovery work shares its red parent's lineage, so it never counts, even solo PRs at depth 0 with `maxSplitDepth: 0`. A rebuilt or rerun batch doesn't count either.
  - **State:** the limit and the count are kept in `adaptive` (absent until the first full green or red), and replace `max >> redStreak` for fresh batches; `redStreak` is still counted and shown.
  - **Policy:** since `strategy` is outside the policy hash, a `ceiling` above `queue.batch.max` lets fresh batches exceed a hashed value. Batch size decides only how many tested PRs share a run, never what may land.
  - **Light load:** a trickle that never fills a batch makes the same decisions as with the key off, and writes nothing until a red fresh batch halves the limit.

- **`mainBaseline`.** A PR is not bounced, and does not count towards the breaker, for a failure main also has.
  - **The evidence.** Main's own push run can't show this for a target that skips tests on main because the queue ref already ran them, so `mainFailedJobs` (§5.3) stays empty there. So before a PR that is red alone (after its rerun) would bounce, the queue pushes `queue/<n>` at main's own commit, with no PR in it, and the batch keeps its slot until that run is in. It costs one run from the window budget and the PR's lineage, with no merge and no journalled op: a lost ref just reads as no run, and the notice that creates the ref waits out a pause. `quiesce` refuses while this run is going. It needs T2 (§4.1 in docs/deployment.md) to run the full suite on any queue push.
  - **Comparing.** Failures compare by test id, parsed from the job logs as flaky tracking does (`src/baseline.ts`). A job name alone would hide a new failure in a shard that is already red. A job with no ids (an aggregate, an unreadable log, past a read limit, or too many failures to list) can only match by name.
  - **If every failure is also main's,** the PR stays admitted and keeps `ready`. It gets a comment, is not bounced or counted, and is not built again on this main. A later batch on the same main is compared with the same run, and a whole group can be held this way without splitting.
  - **If anything is the PR's own,** it bounces as ever, and the comment says which failures are whose. A policy PR, a batch stacked on another, a batch on a main that has since moved, and a run with the budget spent are all judged as they always were.
  - **Green or inconclusive:** the PR bounces and counts, although a flaky failure can pass once, so this does not prove the PR at fault. That run isn't kept, so the next PR that fails alone gets its own run. A red run stays until main moves.
  - **Why nothing is hidden.** Landing still needs a green suite on the batch. A wrong match, such as a flaky test on main that a PR really breaks, or a match by job name, only delays the PR: it is tested again once main has moved, on a suite with nothing left to match, and then lands or bounces on its own.
  - **Staying loud.** The watchdog opens a `main is broken` alert while any PR is held, from the state mirror, and closes it when that ends. Holding `breakerBounces` PRs on one main pauses the queue, naming the failing tests. A pause ends the hold, so closing it is a real retry. A PR that fixes main is not held, because its suite is green. It lands without anyone resuming anything, and the held PRs then build as usual.
  - **Releases.** The run is on main's own commit, so a qualification manifest that accepts queue branches as evidence counts it, and a red baseline unqualifies that commit.
  - **Staging.** `baseline` is written only with the key on. Run a release with this reader live first, then add the key: an older release refuses the state field, and refuses the config key too.

## 6. Pre-landing manifest and CI classification

### 6.1 Two manifests

- **A qualification manifest** (optional; docs/qualification-manifest.md) is the target's own statement of what a commit on main must pass before it may ship. Qlander reads it only to advance `release` (§8), with the `manifest` qualification provider.
- **The pre-landing manifest** lives in qlander's `qlander.yml` (`queue.preLanding`). It decides whether a queue commit may become main. It uses **the same schema and the same verdict semantics as a qualification manifest**: each entry is `{path, required_jobs, allow_skipped_jobs}`, evaluated by one function (`verdict()`), which the pre-landing manifest and the release re-evaluation (§8) both call.
  - The semantics are **all jobs**: every job in the evidence run's latest attempt must conclude `success`, including every instantiated matrix leg. The only exceptions are jobs named in `allow_skipped_jobs`, which may be `skipped` and nothing else. In addition, every `required_jobs` name must be present.
  - Evidence is `job@subject` (§4.1) with event `push`, branch `queue/<n>` and subject `Q`.
  - Only workflows that are safe to run on a queue push belong in it. A workflow that needs an environment or a write secret, or that is path-filtered (`if_triggered` in qualification terms), runs after landing, as part of qualification. If one of those fails, main is unqualified and release does not advance.

A target PR cannot change which jobs landing requires, because the manifest is in qlander. It can change what those jobs do (§4.3). A required job that has never appeared on any queue run means the config is wrong, and the queue pauses.

### 6.2 Classification of the active batch

The evidence runs are the newest run, per manifest workflow, that matches the tuple. The rows are checked **in this order**, and the first one that applies wins:

| Class | Condition |
| --- | --- |
| `red` | Any job concluded `failure` or `timed_out`, except an excused failure (below). This applies whatever else is skipped, so a job skipped because something it `needs` failed is part of that red result, not a config problem. |
| `infra` | No `failure` or `timed_out` anywhere other than excused failures, and one of these holds: a job is `cancelled`, `action_required`, `stale` or `neutral`; or a run was cancelled by qlander for time (`active.cancels`, see below). |
| `red` (policy) | None of the above, but the batch contains a policy PR, and either a required job is missing or wrongly skipped, or a manifest workflow has no run. The policy PR's change caused it, for example by deleting a required job. |
| `config` | None of the above, and no policy PR in the batch, but a manifest workflow still has no run `queue.timeouts.noRunMinutes` after `queue/<n>` was created, or a completed run lacks a required job or skips one that `allow_skipped_jobs` does not list. |
| `pending` | Anything still `queued` or `in_progress` within its time limits (below). Past one, qlander journals `cancel(runId, attempt, cause)`, records it in `active.cancels`, cancels the run, and classifies it as `infra` on the next tick. |
| `green` | `verdict()` passes for every manifest workflow, on the latest attempt of each evidence run. |

Cancellations that qlander makes when it abandons a batch never reach classification, because the batch is no longer active.

A skipped or cancelled required job is never green.

**Excused failures.** In a completed run, a job that concluded `failure` is excused when it is not in the workflow's `required_jobs` and it started (`started_at`) no earlier than the first `completed_at` of a `cancelled` job in the same run. An excused failure is not a verdict, and the run classifies as `infra`.

- **The case it covers:** aggregate jobs (such as `full` or `fast`) `needs:` the lanes, run `if: always()`, and fail when a lane was cancelled ("full: test-integration is 'cancelled', needed 'success'"). Without the rule, a batch cancelled for time while starved of runners would fail its aggregate for that reason alone and be split as red although no test had failed.
- **What ties the failure to the cancellation:** once a run is cancelled nothing new starts except `always()` jobs, and an aggregate cannot start before the lanes it needs have finished.
- **Still red:** a job that was already running when the cancellation happened, a required job, a `timed_out` job, a job or cancellation without timestamps, a failure in a run with no cancelled job, and a failure in a run other than the cancelled one.
- **It cannot land a real failure untested:** `infra` never lands. It reruns once and then pauses, and green still requires every job to succeed.
- **Config:** aggregates are recognised from the manifest and the run's own timestamps rather than named in config, so the policy hash does not change. If an aggregate is ever added to `required_jobs`, its failures are red again (the safe direction).

**Time limits.** All clocks belong to the current attempt (`run_started_at` resets on a rerun), and a job counts only the time it has been `in_progress`, from its own `started_at`. Time a job spends `queued` for a runner never counts towards the execution limit, so a batch starved of runners waits rather than being cancelled. A run is overdue when:

1. a job has been `in_progress` for more than `inProgressMinutes`: cause `timeout`;
2. the attempt is older than `queuedHours` and no job is `in_progress`: cause `starved`;
3. the attempt is older than `queuedHours` plus `inProgressMinutes`, whatever its jobs show: cause `timeout`. This hard cap means no run, however its jobs come and go, can hold the queue for longer.

GitHub can report a run `completed` while its job list still shows a job `queued` or `in_progress`, even with that job's conclusion and `completed_at` already set. Such a job is never a pass, whatever its conclusion says (a `failure` or `timed_out` conclusion is red at once, as above), so the batch waits. The same three limits bound the wait: past one, there is nothing left to cancel, and classification returns `config`, which pauses and puts the batch back with its PRs still ready.

A run qlander has cancelled is not timed again, but cancellation is a request: `always()` jobs can keep it open. If a cancelled attempt is still not `completed` once it is older than the hard cap plus `rerunBarrierMinutes`, classification returns `config`, which pauses and abandons the batch.

## 7. Build, sign check, land, verify

### 7.1 Build

1. Journal the `build` op and reserve 1 from both the lineage and the window.
2. Create `qlander-build/<n>` at `main` (`B`). No target workflow may trigger on this prefix (an activation requirement, §13).
3. For each PR in order, call `POST /merges {base: qlander-build/<n>, head: <pin>, commit_message}`. The message is `<title> (#N)`, a blank line, `Merged from #N at <pin>.`, a blank line, then `Landed-by: qlander batch <n>`. The title is untrusted, so it is first flattened to one line (control characters, line separators and bidi controls become spaces, whitespace collapses) and cut to at most 200 code points with an ellipsis, and it can add no line of its own. A PR with no usable title gets the fixed subject `Merge pull request #N at <pin>`, a blank line and the `Landed-by:` line. So does a title that could read as that subject or as a trailer (`Merge pull request…`, a hyphenated token and a colon, `Title:`, or a leading `---`, which is git's patch divider and would hide the real trailer from `git interpret-trailers`; judged with compatibility forms and dashes folded and invisible characters removed), with `Title: <title>` as a last line. The number after the title is always the PR's own, and a consumer takes it from the end of the subject. Older history has the fixed subject on every merge commit, so a consumer accepts both forms. No decision reads a message back: a commit's identity here is its parents (step 5), and the policy hash and the state hold no message.
   - 201: continue.
   - 204: drop the PR as a no-op.
   - 409: conflict; drop the PR.
   - Anything else: abort the build and pause.
4. **Runtime signature check:** for every merge commit created, `GET /commits/{sha}` must return `verification.verified == true` and `reason == "valid"`. If any commit fails, delete the build ref and pause, before any CI runs.
5. Check the chain: walking first parents from the final commit reaches `B`, and the second parents are the surviving pins, in order.
6. **Checkpoint:** write the state with the build record `{survivors, dropped: [{pr, pin, outcome}], chainHead}`.
7. Create `queue/<n>` at `chainHead`. This is the only push the target's CI sees.
8. Delete the build ref. Apply the drop outcomes: comment and unready, idempotently. Close the journal.

### 7.2 Land

1. Journal `land(B → Q)`.
2. Call GraphQL `updateRefs(repositoryId, refUpdates: [{name: "refs/heads/main", beforeOid: B, afterOid: Q, force: false}])`.
3. The client wrapper refuses the call unless the state's active batch is classified `green` with head `Q` and base `B`.

### 7.3 Verify (persisted in `state.verify`, independent of later batches)

In linear mode (§7.4) `P` below is the PR's stack commit, and the entry also records the admitted head `H`; a head that reads as `H` is treated like one that reads as `P` (a read that lags behind the landing), and the not-merged notice names both.

For each landed PR with pin `P`:

- Confirm that `P` is reachable from `main` (`GET /compare/P...main`, status `ahead` or `identical`).
- `merged == true`: remove `ready`; done.
- Open, `head == P`, `P` reachable: wait for GitHub's indirect-merge detection. After `queue.verify.ticks` ticks and at least 15 minutes since landing (`VERIFY_MIN_MINUTES`; chained ticks can be a minute apart, §11.1), post one comment: "`P` is in main at `Q`, but GitHub has not marked this PR merged; a maintainer may close it." **Qlander never closes a PR.**
- Open and `head != P`: comment "landed revision `P` (in `Q`); later commits are not in main", remove `ready`, and leave it open.
- Done when it is merged, the comment has been posted, or after `queue.verify.days` days.

### 7.4 Linear landing (opt-in, `queue.landing.mode: linear`)

For a target that requires linear history and one commit per PR. Absent, or `mode: merge`, Config has no `landing` key, the policy hash is unchanged, no new state field is written, and everything above holds exactly. The key is policy: switching it drops every admitted PR (§4.2), so switch with nothing admitted.

**Build (§7.1, changed from step 4).** Steps 1 to 3 are unchanged: the PRs are merged onto `qlander-build/<n>` with the merges API, and a 409 drops a PR with the usual "Not queued" comment. The merge chain then stays on the build ref. For each surviving PR `i` in order, qlander reads the tree of its merge commit `M_i` and creates, with the git data API, a commit `S_i` with that tree and the single parent `S_{i-1}` (`S_0 = B`). Its message is `<PR title> (#<number>)`, the title flattened and cut as in §7.1, or `Pull request #<number>` without one, then a blank line and `queue.landing.body` (placeholders `{number}`, `{head}`, `{batch}`).
- `tree(S_i) = tree(M_i)`, so each stack commit holds exactly the trees the merge chain did, and `S_k`'s tree is the one merge mode would have tested. Building on the merge chain's trees rather than merging onto the stack keeps a PR stacked on another's branch *in the same batch* from re-applying its base, because the merge base the merges API uses is the same as in merge mode. Across batches it is not the same, so the build refuses such a PR (below).
- Every `S_i` must be `verified` with reason `valid`, else the build fails and pauses, before any CI. The `M_i` are never pushed anywhere but the build ref, so they are not checked.
- The checkpoint also records the stack, `{pr, commit, parent, tree, own}` per survivor (`own`: below). Recovery adopts a `queue/<n>` only if, walking from it, each commit is exactly the recorded one with one parent, ending at `B`. A crash before the checkpoint leaves only unreferenced commits.
- `queue/<n>` is created at `S_k`. CI, classification, reruns, bisection, splits, solo retests, pipelining and every strategy are unchanged: each rebuild builds a new stack from its pins.

**A PR carrying commits that landed squashed.** Once PR A is on `main` as `S_A`, its commits are not ancestors of `main`. A PR C built on any of them has a merge base from before A, so A's change is on one side only: whatever C undoes of A vanishes, with no conflict (reproduced on GitHub through the merges API). CI tests the tree that lands, so invariant 1 holds, but the PR's change does not land. `POST /merges` takes no merge base, a tree comparison cannot see it (C's diff against that base has no change on the line), and `/commits/{sha}/pulls` returns nothing for a head a landing moved away. So the build refuses, before any merge and any CI:
- For each pin, `compare(base, head)` lists the commits it carries. One whose 12-hex prefix is in the **squashed set** drops the pin with outcome `squashed`: the usual "Not queued" comment, `ready` removed, naming the commit and the `git rebase --onto` that fixes it. So does a list too long to read whole, or over 250 commits in linear mode (`OWN_MAX`), since it could not be proved safe or recorded. A head that already contains the base merges to its own tree, so it passes.
- The squashed set is `state.squashed`, the newest 1000 commits (`SQUASHED_MAX`) that landed squashed, oldest out first, plus the `own` commits of the batches under this build's base when pipelining. A batch beside this one is not under it: if it lands first, this one rebuilds on the new `main`, and the check runs then. A speculative build with such a PR is refused whole and uncharged like any drop on a running batch (§5.6), so its PR is told only if its parent does land.
- Each stack entry records `own`, the commits its PR carries beyond the base and the entries before it. A landing adds them to `state.squashed`. The record is history, so switching to merge mode keeps it, and the build keeps checking while it exists. A repo that never landed linear has no such field, and merge mode reads and writes nothing.
- Same-batch stacks pass: the merge chain holds A's commits, so C merges against them. A PR ordered before the PR it contains is the existing "already contained" drop.
- A false positive is safe: A reverted on `main` and proposed again with the same commits is refused until rebased.

**Land (§7.2, changed from step 2).** One `updateRefs` cannot do it: moving `main` and the PR branches in one call, in any order of entries, leaves every PR closed and not merged (0 of 19 live, and 0 of 2 with one `git push --atomic`), as does moving `main` first. Moving the branches in an earlier call does mark them merged. GitHub documents none of this; the inference is that its merge detection runs from the base branch's push against each PR's head as it was before that push. So two calls, each with a compare-and-swap on what the other relies on. A no-op entry (`beforeOid == afterOid`) is a compare on GitHub's write path, not on a replica that can lag:
- **`moveBranches`:** `main` `B→B`, each PR's recorded `headRef` `H_i→S_i` with `force: true`, plus the epoch entry when the fence is on (docs/deployment.md §3.4).
- **`landStack`:** `main` `B→S_k` with `force: false`, each PR branch `S_i→S_i`, plus the epoch entry.

**Between them, the runner waits for GitHub.** GitHub processes a branch's move in the background, usually in about two seconds, and a main push that overtakes it closes that PR without the merged mark, for good. Measured on the sandbox with batches of 4: `landStack` at once marked 7 of 48 PRs merged; waiting 3 seconds, 48 of 48; waiting until each PR's own read (`GET /pulls/{n}`) shows `S_i`, 137 of 137 across two rounds, with reads taking 2 to 3 seconds. One PR in that study was not processed within the 60 seconds allowed there; moving `main` anyway closed it unmerged. So the runner polls each PR until it reads `S_i`, for up to `LAND_HEAD_WAIT_MS` (120 seconds, every 500 ms); past that, `main` does not move, and it goes out as a transient error: the branches go back and it is resent, up to `maxOpTries`. A read at neither `H_i` nor `S_i` ends the wait, and `landStack` refuses it.

Once `main` is at `S_k`, every PR's head `S_i` is reachable from `main`, and GitHub marks the PR merged. This merged mark does not close issues the PR names with `Closes #n`: measured, neither this landing nor GitHub's own merge API with the same App closed them in the sandbox, while a person's merge in another sandbox repo did. The first call is what may leave a branch at `S_i` with `main` at `B`: for a few seconds normally, longer after a failure. While it reads there the PR shows the stack commit, which holds the PRs ahead of it too.
- **A branch someone pushed to is never overwritten.** Before the first call, its `beforeOid` no longer holds, so the call is refused and nothing moves. Between the calls, its no-op entry no longer holds, so `main` does not move. Either way that PR is dropped by the next tick's revalidation (`ready` removed, the usual "head moved" comment), the batch is abandoned, and the rest is rebuilt and retested (§5.3 rule 3). If the author built on `S_i`, their branch holds the other PRs' stack commits until they update it.
- **Every way out that is not a landing settles first.** After a refusal or error from either call, on recovery unless every read shows `main` at `B` and each branch at `H_i`, and before the op ends for any other reason (a resend no longer valid, past `maxOpTries`), the runner reads `main` and every PR branch, then:
  - `main` at `S_k`, or `S_k` reachable from it: the landing applied; it is recorded. Ancestry, not equality, so a landing someone fast-forwarded past is still recorded.
  - Otherwise it sends one `moveBranches`: `main` no-op at the value read; each branch read at `S_i` back to `H_i` with `force: true`; each other branch a no-op at the value read; a branch that reads absent has no entry, since a no-op needs a commit. Accepted means that at one instant all of those reads were true, so a lagging read cannot end the op with a branch left behind, a landing cannot be unwound (`main`'s no-op fails if it moved), and the sha read for `main` does not contain `S_k`. Then: `main` not at `B` is `baseMoved`, rebuilt as in merge mode; a branch at neither `H_i` nor `S_i` is `headMoved`, above; otherwise the journal stays and the next tick resends. After a refusal from a call this tick, that resend counts toward `queue.landing.maxRefusals` unless the error was transient (5xx, network, rate limit).
  - Refused or failed: `landUnsettled`. Nothing is proved, the journal stays, and each tick tries again from fresh reads. Past `reconcileMinutes` since the op was journalled it also pauses, journal kept, naming each branch and head.
- **A resend is sent only as a fresh landing would be:** the reads above, each PR's own read no longer at `S_i` (GitHub processes a move back in the background too; meanwhile the journal stays, and nothing is dropped as a push), the batch's latest CI attempt `green` on `S_k` (§5.3 rule 5; a rerun that has since gone red, or is still running, stops it), and every PR revalidated against a fresh snapshot (§4.2); a PR that no longer revalidates ends the op (`opDropped`), after settling, and the next decision handles it. Resends are bounded by the op's own retry budget (`queue.timeouts.maxOpTries`): past it the queue pauses and the op ends, after settling. An update that did apply can never apply twice (its `beforeOid`s no longer hold). No inconclusive observation ever clears the journal. A resend costs no queue CI run, so no lineage or window budget is charged. Merge mode is unchanged: a refusal with `main` at `B` there still pauses unless it is transient.
- **A crash between the calls** reads as `main` at `B` and branches at `S_i`, so the next tick moves them back and the tick after resends. It does not roll forward, because revalidation and evidence are bound to `H_i`, and a resend must be a fresh landing. A paused queue writes nothing, so branches stay at `S_i` until the pause closes, and each tick's log names them. Settling needs no snapshot, so nothing about admission or CI can hold it up.
- **Evidence and approvals stay bound to `H_i`.** Admission, revalidation, the fast lane, the review and a §4.3 approval all name the admitted head, and the last revalidation before the landing is at `H_i`. After the landing, the PR is no longer admitted: its landing is recorded and it is tracked in `verify` with `pin = S_i` and `admitted = H_i`. So nothing re-evaluates evidence at `S_i`, and no approval is asked for it. `S_i` is recognised as qlander's by its exact sha, which binds its recorded parent (the previous stack commit) and tree (the tested tree); any other head is somebody's push. A head of `S_i` or `H_i` waits for GitHub's merge mark (§7.3); anything else gets "commits pushed after it are not in main". A landed PR that reads closed and not merged waits `VERIFY_MIN_MINUTES` for a late mark, then gets one comment saying its change is on `main`, and `ready` is removed. In merge mode that line still drops the entry with no comment.
- **The rewrite starts CI.** The first call pushes to each PR branch while its PR is open, so GitHub runs `pull_request` (synchronize) and branch `push` workflows on `S_i`: about one more fast-lane run per landed PR per landing, and more for each move back and resend. Nothing reads them: batch CI and the main baseline read `push` runs on their own branch, release qualification reads `push` runs on the sha, and admission skips a PR whose verify entry names its head, so a red or pending fast lane on `S_i` neither stalls nor bounces anything, and the wait notices are not raised. After a move back, a newer pending run on `H_i` leaves the earlier green verdict standing, and a newer red one drops the PR, as for any red fast lane.
- **The fence.** Each call, and each settling write, is behind the lease fence like any other, and with the epoch fence on carries the epoch entry: a successor's epoch refuses the whole call, and the fence reads it as a lost lease. The successor finds the journal and settles. With the epoch fence off, `landStack`'s branch entries still stop a stale runner moving `main` after a move back.

**Branch names.** A PR head branch is checked with git's own rule (`isGitBranchName`, git check-ref-format) at admission, in the state parser and in the ref client, which encodes each path component. A name that fails it is refused at admission with a "Not queued" comment and `ready` removed, so the state never holds a name it cannot parse or the client cannot move.

**Allowed refs (§11).** Only `moveBranches` (`src/github/target.ts`) moves a PR branch, only in a call that also compares `main`; `landStack` only compares them. At most 100 branches, each a valid git branch name that is not `main`, `release`, a batch ref or the epoch branch, each SHA real. `getPrBranch` reads them, for recovery only. The state parser refuses a land op whose heads are not exactly the active batch's stack and each PR's recorded branch and admitted head.

**Authorship (`queue.landing.author`).**
- `app` (default): the queue App is author and committer, so GitHub signs the commit and a main that requires signed commits accepts it. The PR's author is credited with a last trailer, `Co-authored-by: <login> <<id>+<login>@users.noreply.github.com>`, from the PR's `user` as GitHub returns it; a PR with no readable account gets none. Never a real address.
- `author`: the PR's author is the commit's author at that same noreply address. Qlander passes no committer, and GitHub's documented default makes the committer the author too. GitHub does not sign a git data API commit with another author, so these commits are unsigned: the build's signature check skips exactly the commits it gave another author, and still requires every App-authored one (a PR with no readable author falls back to the App, signed). No trailer: authorship already credits the same person, and a trailer naming them again would add nothing. Unsigned commits on `main` are refused when `main` requires signatures, so `audit` T13 fails `author` when a ruleset on `main` has `required_signatures` (rules are readable without admin) or classic protection requires signed commits (read with an admin token; without one that half is SKIPPED, and a failed read is SKIPPED and inconclusive, never assumed off). T8 then no longer demands `required_signatures` on `main`. Config validation cannot read the target, so the check lives in `audit`, which the rollout gates require clean.

**Force-update compatibility.**
- **At admission**, with only what the queue App can already read (Metadata and Contents, no new permission), each ready PR's head branch is classified (`src/force-update.ts`): GitHub's rules for the branch (`GET /rules/branches/{branch}`, repository and organization rulesets alike); for each rule in `blockingRules` (`non_fast_forward`, every rule that stops a direct update, and `required_signatures` with `author: author`; `src/force-update.ts`), its ruleset's `current_user_can_bypass` for the App itself; and whether the branch has classic protection (`GET /branches/{branch}`: `protection.enabled`, since `protected` is true for a ruleset as well). `always` or `exempt` everywhere, and no classic protection: **allowed**. `never` or `pull_requests_only` on any: **denied**, which wins over an unreadable answer on another ruleset (each ruleset's read is judged on its own), which holds the PR (a wait, `ready` kept, a comment naming the rule, once per head and rule), so it is evaluated again every tick and queued once the rule lets the App bypass it; an admitted PR that becomes denied is dropped the same way, keeping `ready`. Anything else, an unreadable answer, a ruleset GitHub does not name, or classic protection (whose settings need Administration read): **unknown**, advisory only, logged at admission; the landing's own refusal classification (above) is the backstop.
- **In `audit` (T13)**, with the operator's token: rulesets as T8 reads them (repository and organization, include and exclude patterns) with a rule in `blockingRules`, against every open same-repo PR into `main` and against the patterns themselves. A ruleset that covers an open PR's branch without the queue App, by id, as a bypass actor in mode `always` FAILs; one whose pattern could cover a future PR branch WARNs; one whose bypass list cannot be read is SKIPPED (inconclusive on a failed read), never guessed. Classic protection on an open PR's branch that does not allow force pushes FAILs. `main`, `release`, the queue and build prefixes and the epoch branches are never PR branches and are left out.

**Release advance (config).** Validation refuses `mode: linear` while `release.enabled` is true in advance mode, dry runs included (a dry run is the step before a live one): the hotfix protocol's merge-back (§9) must land as a real merge commit so that `release` becomes an ancestor of `main` again, and linear landing would squash it. With release advance off, linear is allowed. The check refuses only when `release.mode` is absent or `advance`, so dispatch mode (§8.1), where qlander moves no `release` ref, is allowed. Dispatch mode still needs `release` to be an ancestor of `main`, and with linear landing a commit that exists only on `release` can never be merged back: the release job would report `diverged` and dispatch nothing from then on, which fails closed but does not recover by itself. So with both modes on, `release` only ever fast-forwards to `main` commits, and that is enforced rather than left to habit:
- `setup` adds **restrict updates** to the release-landing ruleset, so only its bypass actors (`release.dispatch.promoterApps` and the named break-glass people) can move `release`, and nobody can merge a PR into it (§13). Merge mode is unchanged. Setup only tightens, so switching back to merge mode leaves the rule in place until a person removes it, and the hotfix path (§9) stays shut until then.
- `audit` T10 fails without that rule (or with one that allows fetch and merge), fails when a configured promote App is not an `always` bypass actor on every ruleset on `release` that would stop a direct update (a bypass of one ruleset does not bypass another), and no longer checks that the pre-landing workflows run on PRs into `release`, since there are none.
- Validation also refuses `queue.landing.author: author` with dispatch: those commits land unsigned, release-integrity requires signatures with no bypass, and so none could ever be promoted.
- What audit cannot check statically (§13): the target's promote workflow moves `release` only by fast-forward to the dispatched sha, refuses a sha that is not on `main`, and commits nothing of its own (no version bump) on `release`. Whoever can run that workflow with the promoter credential can move `release`.

There is no hotfix path in this combination: fix forward on `main` and promote that. If `release` diverges anyway (a break-glass push, or a promote workflow that commits), the release job stalls as above; [Operating it](docs/operating.md) says what to do.

**Target side.** The queue App must be able to force-update PR branches: a ruleset that blocks non-fast-forward updates on feature branches needs the queue App as a bypass actor in mode `always` (T13 checks it). A main ruleset requiring linear history is satisfied by the stack, and one requiring signed commits by `author: app`. Forks are never admitted, so every branch is in the target.

**Limits.**
- A hotfix merge-back (§9) would land squashed, so validation refuses linear mode with release advance on, and with dispatch mode `release` takes no PRs at all (above).
- The PR's own commits never reach `main`, so a PR that is merged into another branch afterwards, or reopened, needs a person.
- The new state fields (`auth.headRef`, `active.stack`, `parked.stack`, the checkpoint's `stack`, a land op's `heads`, `verify.admitted`, `squashed`) appear only once linear mode is used. Run a release that reads them before turning the mode on: an older one refuses them and pauses. A stack without `own` refuses too, rather than landing without its record.
- A PR stacked on a revision of another that was then force-pushed away shares no commit with what landed. Its merge base is from before that PR in any mode, so qlander cannot see it.
- `squashed` is bounded by count, so a PR built on commits that landed more than 1000 squashed commits ago is not refused.

## 8. Release advance

The release job is a separate job in `tick.yml` (§12.1), run by a separate App, with its own state branch, lease, pause label and mirror issue. It runs only when `release.enabled` is true. Its lease records its executor exactly as the queue's does (§15). It is live only when `QLANDER_MODE` is `live` and `release.dryRun` is false. A dry run makes the same reads and decision through a read-only target client and writes nothing: no lease, no state, no issue. If the release state branch is missing while its mirror issue is open, the job refuses to initialise and pauses itself.

1. Read `R` (release) and `M` (main). If `release` is absent, stop (an operator creates it).
2. **Candidates:** page through `GET /compare/R...M` (newest first). This is every commit reachable from `M` that is not in `R`, so it also works after a merge-back, when `R` is not on main's first-parent chain. If the comparison is too large to list, record `truncated` and alert, which is distinct from "nothing eligible". Keep only the commits on `M`'s first-parent chain.
3. For each of the newest `release.maxCandidates` candidates `C`, newest first, require all of these (if none qualifies and older ones remain, the job alerts "release-blocked … search limit" rather than examining them):
   - **Qualified** by the configured provider (`release.qualification.provider`, specified in docs/qualification-manifest.md): `manifest` (a qualification manifest that qlander re-evaluates, optionally behind a proof chain), `checks-green` (the listed workflows all green on `C`) or `commit-status` (a status from one of the listed creators).
   - **Proof chain** (manifest provider, when `proof` is set): there is a `statusContext` status with `success`, and its `target_url` is an Actions run in the target repo (an anchored pattern built from the target's owner and name). That run must have the configured proof workflow `path`, `head_branch == main`, an allowed event (`workflow_run` or `workflow_dispatch` by default) and `repository.id == target`. On its latest attempt, it must have a job named exactly as `proof.jobTemplate` says with `{sha}` = `C` (default `Qualified {sha}`), with `success`. The job name binds the run to `C`, so a run triggered by `A`'s CI can't be used as proof for `B`.
   - **Independent re-evaluation** (manifest provider): qlander reads the manifest at `M` through the contents API (or from the control repo, `source: control`). It records the blob SHA as the policy version, and it rejects any `schema` other than 1. Then it re-evaluates the manifest's rules for `C` itself against the push runs and jobs for `C`, and records each evidence run's id and `run_attempt`. Both the chain and the re-evaluation must say yes. A manifest with no `when: always` entry, or a verdict that cites no actual run, never qualifies anything.
   - `C` is a strict descendant of `R`: compare `R...C` is `ahead`.
4. Journal `advance(R → C)`, then call `updateRefs(release, beforeOid: R, afterOid: C, force: false)`. Record the receipt (C, policy blob, evidence run ids and attempts) in the release state history.
5. If compare `R...M` is `diverged`, `release` has a hotfix that was not merged back. Open or update a release-blocked issue (`release.labels.alert`). This does **not** pause the queue.

Steps 4 and 5 are `release.mode: advance`, the default. Steps 1 to 3, the job's lease, pause and fence are the same in both modes.

### 8.1 Dispatch mode (opt-in)

Some targets cannot let anything but their own deploy workflow move `release`, because promoting a commit does much more than move a branch: migrations, a deploy, smoke checks, rollback records. With `release.mode: dispatch`, qlander still decides **what** is qualified (steps 1 to 3), but the target's workflow (`release.dispatch.workflow`) does the promotion and moves `release` itself, and qlander only observes the result.

**The property, precisely:** in this mode qlander never writes the `release` ref, nor `main` or a batch ref. The only target ref it writes at all is its own epoch branch, advanced once per tick, and only while the epoch fence is on. It holds structurally, in four layers, each enough on its own:
- the release job connects its target client with the `dispatch` role (src/main.ts), which refuses every ref write and every queue write before any request, and may dispatch exactly the configured workflow, on the configured ref, with exactly the configured input names (src/github/target.ts);
- the dispatch tick is handed a client built by `dispatchOnly` (src/release-dispatch.ts), which has no ref writer on it at all, so no code path in the tick can reach one; its type has none either;
- every dispatch-mode test runs against a fake whose every ref writer (`createRef`, `deleteRef`, `updateRef`, `epochUpdateRefs`, `advanceEpoch`, `voidEpoch`, `merge`, and linear landing's `createCommit` and `landStack`) is spied on, and fails if any is called other than `advanceEpoch` on the epoch branch with the fence on;
- the credential itself (recommended, and what `setup` and `audit` now require): the release App has no Workflows permission and only Contents: read in this mode, and Contents: write only with the epoch fence, for its epoch branch; and the release-landing ruleset no longer lists the release App as a bypass actor, so even a leaked key cannot move `release` without a PR (§12.1).

**One candidate at a time.** The candidate is the newest qualified first-parent commit `C` not yet in `release` (the advance decision's target). For `C`:

1. **Dry run, once per sha.** Journal `dispatch(dry, C, id)` with its budget reservation, then `POST /actions/workflows/{file}/dispatches` with `{ref, inputs: {<sha>: C, <dryRun>: "true", <dispatchId>: id}}`. `id` is unique per intent (`qlr-dry-<sha prefix>-<nonce>`). The receipt is the candidate's record of the dispatch, written in the same state write that drops the journal.
2. **Find the run, and authenticate it.** `workflow_dispatch` returns 204 with no run id. The target workflow's `run-name` must contain the dispatch id input, and qlander matches a run only if: its path is the configured workflow, its event is `workflow_dispatch`, its `head_branch` is the configured ref, its repository and head repository are the target (by id), it was created no more than 5 minutes before the intent, its name contains the id as a whole token, and **GitHub reports both its `actor` and its `triggering_actor` as the release App's bot** (`release.dispatch.actor`, login and id; `audit` T11 checks it is `<release App slug>[bot]` with that id). The id alone proves nothing: it is in the run name, which anyone who can read the target sees, and anyone who can dispatch the workflow can copy it; the actor is GitHub's own record of who started the run and who triggered its latest attempt. Runs carrying the id from anyone else are ignored and logged. The listing (up to 10 pages) must be complete: from a listing that may be cut nothing is adopted, since a second matching run could be hidden, and one still cut at the appear deadline makes the dispatch `ambiguous`. A time window plus the run's head sha would not do: the run's `head_sha` is the ref's tip, not `C`, and two dispatches close together would be indistinguishable. Failure modes: a workflow whose `run-name` leaves the id out is never found (`never-appeared`, below); two authenticated runs with the same id, at any point while the run is followed, are `ambiguous`, never a pick; a run deleted after it was found is `missing`. Once found, the run is followed by id with `GET /actions/runs/{id}`, and looked up again every tick. Its latest attempt's conclusion counts, a green one only together with its completion time, the newest `completed_at` of that attempt's jobs (GitHub's clock, never the time qlander happened to look), and a run past `release.dispatch.runHours` is `stuck`.
3. **Report.** When the dry run is green, the release job posts one comment on the status issue (§10): `C`, the run's link, and the dry run's job names and conclusions, read through the API as data (untrusted text, flattened). It is best effort: the marker it starts with keeps it to one per candidate, and a failure is retried next tick, never a pause.
4. **Approval.** The real run needs a comment on the status issue whose whole body is `/qlander approve-release <C>`, unedited, from an account in `release.dispatch.approvers` (login and id), posted after the authenticated dry run's `created_at` (GitHub's evidence that it started, not the earlier intent time). This is §4.3 (b)'s rule, bound to the release candidate instead of a PR head, and with the same weakness: qlander checks the account, not who is using it. A comment naming another sha, from an account not listed, edited, or older than the dry run is refused, and the log says why. `qlander approve-release <sha>` posts it for an approver, refusing what the job would refuse.
5. **Real run, once per sha.** Only while `C` is still the newest qualified candidate, and only if no real run was ever dispatched for `C`. Immediately before it, the dry run is looked up and authenticated again: it must still be the one run carrying its id, and its latest attempt must be a success that completed within `release.dispatch.dryRunValidMinutes`, so a rerun that failed, a deleted run or an old success after an outage stops it. It is journalled, dispatched and found exactly like the dry run, with `<dryRun>: "false"`.

**Once per sha, durably.** The intent of every dispatch also sets `dispatch.highWater` to `C`, in the same write. A new candidate must be a strict descendant of it (one compare), a dry run is dispatched only for such a candidate, and a real run only for the sha whose dry run set the mark. `main` only moves forward, so this holds however much of `dispatch.history` (`historyLimit`) has been pruned. A dispatch GitHub refused outright started nothing, and gives the mark back in the write that records the refusal.
6. **Released only when green and seen.** A real run counts as a release only when it concluded `success` and `release` is observed at `C` or a descendant of it (a read). Then the receipt (from step 3 of §8) goes into the release history as `advanced`. Every other ending of a real run is an **incomplete promotion** and pauses the release job (not the queue), with the candidate's close and the pending pause in one state write: a red, cancelled or timed-out run with `release` unmoved (`real-failed`); a green run with `release` not at `C` within `observeMinutes` (`not-observed`); a red run although `release` reached `C` (`incomplete`: the ref alone does not show that migrations, the deploy or the smoke checks finished, so it is recorded in the release history as `moved`, never as a release of ours); and a run that could not be followed. The pause names the sha, the run, its conclusion and the `release` it saw, and says production may have changed. A deploy that went wrong is a person's call, which an alert issue would let the next candidate's dry run race past. Closing the pause resumes the job toward the newest qualified candidate; that sha is not tried again unless re-armed.

**The run read by id is authenticated too.** A run's conclusion is read with `GET /actions/runs/{id}`, and a listing can lag behind a rerun. So that response must itself say the release App's bot started the run and triggered its latest attempt, and its `run_attempt` must be the one the authenticated listing showed. A person's rerun (a different `triggering_actor`) is a `foreign-attempt`: for a dry run, that sha's dry run fails; for a real run, the job pauses. Reads that disagree on the attempt conclude nothing until they agree, but only for `release.dispatch.runHours` from the run's start: a run still unauthenticated then is `unauthenticated`, which for a real run closes the candidate and pauses in one write, like any run that cannot be followed (and can then be re-armed). The same check runs in the recheck before the real dispatch.

**Re-arm: once per authorised attempt.** `dispatch.last` records the last dispatch made (its sha and dispatch id, in its intent) and when its candidate closed. An approver grants one more attempt for that sha with a status issue comment whose whole body is `/qlander rearm-release <sha> <incident>`, where `<incident>` is the last attempt's dispatch id (`qlander rearm-release <sha>` posts it). It must be unedited, from a listed approver, and posted after that attempt ended. Bound to the incident, it authorises exactly one attempt: the new attempt's intent replaces `dispatch.last`, so the same comment can never authorise another, and nothing else changes: `highWater` never moves backwards and no history is deleted. The re-armed attempt starts from a fresh dry run and needs a fresh approval posted after that new dry run started, so an old approval cannot authorise it. It applies only while the sha is still the newest qualified commit and a strict descendant of `release` (the decision rechecks qualification and ancestry each tick); once a newer commit qualifies, that commit gets the attempt instead. Freeze, budget, lease and fence all apply; neither a re-arm nor closing a pause clears a freeze; and a pause never extends the dry-run window, which runs from the run's own completion.

**Every dispatch is bounded and fenced.** It needs the release lease (the fence checks it before the request) and, with the epoch fence on, an `epochHeld` probe on GitHub's write path just before the request. A dispatch is not a ref write, so GitHub cannot reject it with the epoch atomically: a frozen holder that passed the probe could still send one request after a successor took over. Its intent was written under its lease before the request, so the successor finds it in the journal, looks for its run and never dispatches that kind for `C` again. A late run is then either found or, if after the appear window, its sha is closed; a real one that cannot be followed pauses. Every dispatch also reserves from `release.dispatch.budget` (`window` dispatches in any `windowHours`), and none is made while a freeze variable equals its value.

**Freeze.** `release.dispatch.freeze` lists target repository variables, each with the value that means frozen. While any equals its value, no new dispatch is made, dry or real; a run in flight is still followed. A variable that cannot be read counts as frozen; one that is not set does not. A repository variable was chosen over a status check: a freeze is a property of the repository at a moment, not of a commit, so a status would have to be posted on every new candidate to hold, and anyone with `statuses: write` could post one. Variables are also what deploy workflows commonly read already, so one switch can freeze both. It needs Variables: read on the release App, requested only when a freeze is configured.

**Outcomes.** A candidate ends in exactly one of these, recorded in `dispatch.history`; none is ever retried for the same sha:

| Case | Outcome |
| --- | --- |
| GitHub refuses the dispatch (a 4xx: nothing started) | No record; retried next tick, up to 3 times per candidate, each from the budget; release-blocked issue. A rate limit is retried without counting. |
| Dispatch response lost (5xx, network, timeout) or a crash before the receipt | Not resent. The run is looked for by its id. |
| Dry run red, cancelled, timed out, never appeared, ambiguous, missing or stuck | `dry-failed`, release-blocked issue. A newer qualified commit gets its own dry run. |
| Green dry run not approved within `dryRunValidMinutes` | `expired`, release-blocked issue. |
| Real run red or cancelled, and `release` not at `C` | `real-failed`, and the release job **pauses** (an incomplete promotion, step 6). |
| Real run never appeared, ambiguous, missing, stuck, or its latest attempt someone else's | `real-failed`, and the release job **pauses**: a promotion may be running that nobody can see. |
| Real run green, `release` not at `C` within `observeMinutes` | `not-observed`, and the release job **pauses**. |
| Real run red although `release` reached `C` | `incomplete`, and the release job **pauses**; the release history records `moved`, not a release. |
| Real run green and `release` at `C` or past it | `released`. |
| An incomplete promotion's pause is closed | The job resumes toward the newest qualified candidate; the sha gets another attempt only through a re-arm. |
| The green dry run is rerun to failure, deleted, joined by a second run with its id, or completed longer ago than `dryRunValidMinutes` when the real run is due | `dry-failed` or `expired`, release-blocked issue; no real run. |
| `release` reached `C` without a real run of ours | `released-elsewhere`. |
| A newer qualified commit while `C`'s dry run is in flight | The dry run is followed to its end first (one target run at a time), then `C` is `superseded`. |
| A newer qualified commit while `C` waits for its approval | `superseded` at once; an approval of `C` is then refused. |
| A newer qualified commit while `C`'s real run is in flight | Never superseded: the real run is followed to its outcome above, then the newer commit starts with its dry run. |
| `release` diverged, or the policy cannot be read | The advance decision's release-blocked issue; nothing is dispatched; the candidate is kept. |
| Paused (an open `release-pause`, or one pending) | Nothing is dispatched or reported; runs in flight are still followed and recorded. |

**The App, least privilege (recommended, and required by `setup` and `audit`).** In this mode the release App has Actions: write (to dispatch), Contents: **read** (discovery, the manifest), Checks and Commit statuses: read, no Workflows, plus Variables: read with a freeze. With the epoch fence on it keeps Contents: write, which its epoch branch needs. Turning the fence off, or changing `runner.epochPrefix`, makes the next job void the predecessor's epoch branch (docs/deployment.md §3.4), which also needs Contents: write: keep it until that job has run, then drop it. Turning the fence off, the rendered job's token is Contents: read, and only when GitHub refuses that handover does it mint a Contents: write token and run the tick once more, so later ticks stay read-only. Without the write permission that second token can't be minted and the job fails, having dispatched nothing; `release` stays out of its reach because the release-landing ruleset requires a PR and, in this mode, `setup` makes the only bypass actors the target's own promote identity (`release.dispatch.promoterApps`, by App id, never the GitHub Actions App, and never one of qlander's own Apps: `setup` refuses, in `--plan` too, a `promoterApps` entry that resolves to the release App's id) and named break-glass users, removing the release App, roles, teams and any other App, and `audit` T10 fails any of those, matching the release App by identity in every bypass mode (a `pull_request` bypass still skips the checks). `setup` registers the permissions, `tick.yml` requests them and `audit` T11 checks them, from one function (src/release-permissions.ts). This answers the question of whether dispatch mode should keep advance mode's write access: it should not.

**Off unless enabled.** As advance mode: nothing runs unless `release.enabled` is true, and nothing is dispatched unless `release.dryRun` is false and `QLANDER_MODE` is `live`. Otherwise the job's dry run reads the state and makes the same decision, and says what a live tick would dispatch.

## 9. Hotfix protocol

1. Branch `hotfix/<slug>` from `release` and open a PR into `release`.
2. The target's PR CI runs the **full** pre-landing suite for PRs with base `release` (a target-side requirement, §13).
3. The release-landing ruleset requires a PR, the full required checks, **strict up-to-date** and merge commits only. A human merges in the GitHub UI. Strict up-to-date means the merge commit's tree equals the tested head's tree, and the commit is signed by GitHub.
4. The target qualifies the landed release SHA. Ship paths ship only qualified release SHAs.
5. **Merge-back** (merge mode only: validation refuses linear landing while release advance is on, §7.4): create a branch `merge-back/<slug>` at the release tip and open a PR into `main`. It goes through the normal queue, and it is classified by its **actual diff against main** (`GET /compare/main...<head>` files), like any other PR. Release ancestry confers nothing. A merge-back that touches the policy boundary is a policy PR: it runs solo and needs the §4.3 approval. Qlander lands it as a real merge commit, so `release` becomes an ancestor of `main` again, and the release advance resumes.
6. Qlander does not automate steps 1–4.

With linear landing and release dispatch (§7.4) there is no hotfix path: `release` restricts updates, so no PR can be merged into it, and it only fast-forwards to `main` commits that the promote workflow is dispatched for. Fix forward on `main` and promote that commit.

## 10. Operator surface

**Reading issues.** Every issue lookup (pause, release-pause, release-blocked, the mirrors, the init guards) lists through the GraphQL issues connection, with all pages and a completeness check against `totalCount` (`src/github/issues.ts`). It never uses the REST issues list, which can return an empty page while issues are open. The lookups fail closed:
- An incomplete or failed pause listing means paused.
- An incomplete mirror-issue listing refuses initialisation.
- A pause, alert or mirror issue is created only when two listings were complete and neither has it.

**Pause.** An open issue labelled `pause` (`queue.controlLabels.pause`) in the control repo pauses the queue. Qlander opens one itself for config, infra, red-main, budget and signature failures, and explains why in the issue. To resume, close the issue.

**Release pause.** An open issue labelled `release-pause` (`release.labels.pause`) pauses the release job only. The queue's `pause` does not stop the release job, and a release pause never pauses the queue. The job opens one itself on a corrupt release state, a release CAS rejected while `release` was unchanged, or, in dispatch mode, a real run it could not follow (§8.1). A leftover `advance` intent is still reconciled by observation while paused, and in dispatch mode a run in flight is still followed.

**Release approval (dispatch mode).** The release job reports a candidate with a green dry run in one comment on the watchdog's status issue, and reads its comments for `/qlander approve-release <sha>` (§8.1). These are the only comments it reads or writes there; the watchdog still owns the body.

**Operator commands** are labels on the target PR: `qlander:bounce`, `qlander:solo`, `qlander:unsolo` and `qlander:go` (the names in `queue.labels`; these are the example names). They are durable, so they are never workflow inputs: GitHub keeps one pending run per concurrency group and drops older pending runs, which would drop their inputs. `workflow_dispatch` takes no inputs and only wakes the queue tick.

Each tick reads every command label, takes the label's latest `labeled` event as the command (its id is the command's identity), checks at consume time that the actor has write, maintain or admin on the target, and applies the commands in event order. The effect and an outbox notice that removes the label are one state write, and a command whose removal notice is still pending is never applied again. A command from anyone without write access, or whose latest event has no readable actor, is removed and ignored.

- `bounce` unreadies the PR and abandons the active batch if the PR is in it.
- `solo` makes the PR run alone without changing its position in the queue. The mark (`operatorSolo`) lasts while the PR is in the queue: a PR read as merged (by any route), closed, or without `ready`, the same in two reads, loses it on the next tick (a best-effort read outside the snapshot's consistency check: a failed or disagreeing read keeps the mark), so apply `solo` after `ready`. A moved head on an admitted PR loses `ready`, and so the mark.
- `go` (on any PR) builds the next fresh batch without waiting for it to fill. It is recorded in the state (`go`) and consumed at the next fresh selection, so it outlives its carrier PR and any active batch.

The priority label (§4.4, opt-in) is not a command: it is read on every tick while it stays on the PR, never removed by qlander, and checked the same way (write access at read time).

**Fill timer.** A fresh batch is built only when one of these holds:
- the FIFO prefix of admitted PRs (stopping at the first run-alone PR) holds `queue.batch.minFill` PRs (capped by the batch size after the red streak);
- the oldest has been admitted for `queue.batch.maxWaitMinutes` (its persisted `eligibleSince`, kept while the PR stays ready at the same head even through a revalidation drop, else `admittedAt`; so time behind an active batch and across restarts counts);
- a run-alone PR is at the head or closes the prefix;
- an operator applies `go`.

Split halves and solo reruns never wait. While filling, the tick self-chains toward the deadline (§11.1).

**Flaky tests.** When a red batch's single rerun passes, the first attempt's failed jobs were flaky. Qlander records a `flaky` history entry (job names and links, the failing test ids, the batch, the run ids), adds the batch to `flakes` (the status issue shows the count for the last 7 days), and queues one outbox notice that opens or updates one issue per flaky test in the control repo, labelled `flaky`. A real failure (the rerun is red too) and an infra rerun record nothing. The tick files nothing outside the control repo.

Test ids come from the first attempt's logs, matched as text against pytest, vitest and Playwright summary lines, with fixed limits on logs, ids per job and line length (`src/flaky.ts`); a job past a limit is tracked by name. One issue per test id in the control repo, deduplicated by a marker, and a closed issue is not reused; the notice is best effort, never pauses the queue, and is dropped after 24 hours.

The one residual: a crash between creating an issue and saving its receipt, with that issue closed by hand before the retry, opens a second issue for the same occurrence.

**Manual landing:** there is none. It is either the queue, or a break-glass human with a ruleset bypass merging in the UI. Qlander then sees `main` move and rebuilds.

**Inspecting:** the state branches (their `git log` is the audit log), their human-readable mirror issues, each tick's job summary (snapshot, class, decision), and the PR comments.

**Monitoring.** `.github/workflows/watchdog.yml` runs every 15 minutes on a GitHub-hosted runner (so it outlives an outage of the self-hosted runners), with only `contents: read`, `issues: write` and `actions: read` on the control repo and no App key or environment. It keeps one alert issue (`watchdog.labels.alert`) per alert kind (ticks stopped, ticks failing, runner not picking up ticks, paused over 2 hours, main is broken, tick workflow disabled, config invalid) and rewrites the pinned status issue. It never reads or writes state and decides nothing for either job. Thresholds and runbook: [Operating, Monitoring](docs/operating.md#monitoring).

## 11. Input validation

| Input | Rule |
| --- | --- |
| Event | `schedule` or `workflow_dispatch` only. There is **no `repository_dispatch`**. Polling replaces the wake-up credential. |
| Repository | The target and control repo ids come from `qlander.yml` and are checked against `GET /repos` on connect. Every PR, run, job and status is checked by id, not by name. |
| Refs | Writes are only allowed to `main` and `queue/<n>`/`qlander-build/<n>` (queue App), or to `release` (release App; none at all in dispatch mode, §8.1), and, in linear mode only, to a landed PR's recorded head branch, between its admitted head and its stack commit, in a call that also compares `main` (§7.4). `main` and `release` are only moved, never created or deleted; batch refs are only created or deleted through the ref APIs, and `POST /merges` advances build refs. With the epoch fence on, a job also advances its own epoch branch, and `voidEpoch` advances a predecessor's recorded epoch branch, which must not overlap any branch above and must point at an empty-tree commit (docs/deployment.md §3.4). The client wrapper enforces this, and `n` matches `^[1-9][0-9]{0,8}$`. |
| SHAs | `^[0-9a-f]{40}$` on every read and before every write. |
| PR numbers | Integers from 1 to 10⁷. |
| URLs | A proof status's `target_url` must match the anchored pattern in §8. |
| State | Strict schema, with `v == 5` for the queue and `v == 1` for the release job. A queue document at v2, v3 or v4 is migrated on read, one version at a time (`src/state.ts`); any other version is refused. A parse failure or a failed cross-check pauses the queue. |
| Branch names in events | Never trusted. A PR whose head branch is `main` is ignored (§4.2). A run counts as main evidence only when `event == push` and the repo id matches. |
| Qualification manifest | Parsed as JSON data. `schema` must be 1, and unknown fields fail closed. |
| Release dispatch (§8.1) | Only the configured workflow, on the configured ref (`main` or `release`), with exactly the configured input names, each value a sha, `true`/`false` or a dispatch id. A run counts only by the match rules in §8.1; its name and job names are untrusted text, shown flattened. Freeze variable names match `^[A-Za-z_][A-Za-z0-9_]*$`. |

### 11.1 Self-chaining

The queue job dispatches its own next tick, with no wake-up credential, because the cron is often late (by tens of minutes) and each tick performs one op.

- **How:** the queue job's `GITHUB_TOKEN` has `actions: write` on the control repo, and `src/github/state-repo.ts` uses it for exactly one write: `POST …/actions/workflows/tick.yml/dispatches` with `{"ref": "main"}`, no inputs. Its HTTP layer allows writes from an allowlist only (create and edit issues, GraphQL queries, and that dispatch with exactly that body), refusing everything else, GraphQL mutations and encoded or dot-segment paths included, before any request. A `GITHUB_TOKEN`-created `workflow_dispatch` is the one event GitHub lets that token start.
- **When (the wake hint, `src/wake.ts`):** computed from the outcome and the final state, only after the lease is released.
  - `acted` with more work (pending halves, solo PRs, admitted PRs, a journalled op, or notices other than CI cancellation) dispatches at once.
  - A batch in flight (just built, or CI pending, or a rerun outstanding) is watched: the job polls the batch's pre-landing runs every 20 seconds, holding no lease, until a run it saw running completes (or a newer attempt completes, or a new run appears completed), or until 3 minutes after the process started, and then dispatches, abandoning the dispatch unless it is done within 30 seconds more.
  - These never chain: `busy`, `paused`, `retry-later`, `lost-lock`, `stale`, `idle` with nothing in flight, a pause waiting in the outbox, a lease that could not be released, and a tick whose op made no progress (`buildAborted`, `buildFailed`, `opAbandoned`, `opDropped`, `landRejected`, `targetMissing`: an aborted build is refunded, so chaining after it could loop without spending a budget).
  - Dry runs never chain.
- **Mergeability re-tick:** when a ready or admitted PR is held on unknown mergeability (§4.2) and the wake would otherwise have left the next tick to the cron (or to a later fill deadline), the job waits `RETICK_SECONDS` (60) and dispatches. Only while the newest hold is younger than `RETICK_WINDOW_MINUTES` (4): a GitHub that never computes mergeability gets two or three quick re-ticks per held PR, then the cron. It never replaces a CI watch or an immediate dispatch, and it goes through the same hourly cap.
- **Bounded:** a run already completed when the watch began never counts as progress, and a failed, late or truncated listing is neither a baseline nor progress, so a tick that cannot yet act on a finished run (the rerun barrier, list lag) waits out the full watch. Chained jobs therefore start at most about once per 4 minutes unless real CI progress happens, or a tick acted. An `acted` tick has performed a journalled op, and every op is bounded by the lineage and window budgets, `maxOpTries`, or a batch's own transitions. As a backstop, no dispatch is made when 30 or more dispatched tick runs were created in the last hour (read from GitHub; an unreadable count means no dispatch). A lost or refused dispatch, a dead VM, or the cap ends the chain, and the cron runs the next tick (§15), so the worst case equals the cron-only queue. A cron run arriving during a chain replaces the pending dispatched job, or is replaced by it, so at most one queue job is ever pending.
- **Leases are unchanged:** the dispatch is the job's last act, after `store.release`, and the concurrency group starts the dispatched job only after this one ends, so two executors never overlap. A `busy` tick (a crashed holder's lease) never chains, so takeover still waits `hostKill + grace` on the cron (§15).
- **Release fairness:** the two jobs are in different concurrency groups, so GitHub does not promise that a waiting release job runs before a dispatched queue job. So the queue does not dispatch while a cron release job is waiting for the runner: the cron run that created it also created a queue job, which is pending and continues the chain after the release job. An unreadable answer means no dispatch.
- **Timing:** the watch must end at least a minute before the job timeout (`WATCH_MINUTES + 1 < jobTimeoutMinutes`, checked by `invariantProblems`), and it holds no lease, so a kill during it only loses that dispatch. The watch and cap are timing constants in `src/wake.ts`, not policy, and are not in `Config`, so the policy hash is unchanged.

## 12. Apps, secrets, qlander's own protection

### 12.1 The Apps

The queue and state Apps always exist; the release App exists only when `release.enabled` is true, so there are two Apps, or three with release advance. None has a webhook or user authorisation.

| App | Permissions | Ruleset bypass |
| --- | --- | --- |
| queue App | Contents: write · Workflows: write · Pull requests: write · Actions: write · Checks: read · Commit statuses: read · Metadata: read, on the **target only** | the target's main-landing and queue-refs rulesets |
| release App, advance mode | Contents: write · Workflows: write · Actions: read · Checks: read · Commit statuses: read · Metadata: read, on the **target only** | the target's release-landing ruleset only |
| release App, dispatch mode (§8.1) | Contents: read (write only with the epoch fence) · Actions: write · Checks: read · Commit statuses: read · Metadata: read, plus Variables: read with a freeze, on the **target only** | none on release (only `release.dispatch.promoterApps` and named users bypass it); its epoch branch's ruleset only, with the fence |
| state App | Contents: write · Metadata: read, on the **control repo only** | the state branches' ruleset only |

**Actions: write in dispatch mode, accepted.** The scope lets a token dispatch any workflow, and cancel, re-run or delete any run, in the target. The client allows only the one dispatch (§11), but a compromised release key is not bound by the client: it could start the target's promote workflow with inputs of its choosing, which a compromised key in advance mode could approximate anyway by moving `release`. Keep the promote workflow's own checks (an environment with required reviewers, for example) as the last word on what it promotes.

Both target Apps need **Workflows: write**, because a ref update by an App that introduces `.github/workflows/**` changes is refused without it. Release lags main, so its fast-forwards carry workflow changes too.

The Apps are separate because a job that holds a private key can mint a token with every permission the App has: downscoping with `permission-*` limits normal operation, not a compromised job. With two target Apps, and with the main-landing ruleset set to **restrict updates** to its bypass actors (§13), the only identities that can move `main` at all are the queue App and the target's named break-glass humans. They can bypass the landing rules on `main` and `release`, but not signing, no-force-push or no-deletion, which bind everyone. That rules out PR merges through the UI or API by anyone else, the release App included. If a break-glass account can also be driven by automation, that automation can land without the queue.

The guarantee for `release` is narrower. A compromised queue key cannot fast-forward `release`. It could merge a release-target PR through the API, but only one that already satisfies the release-landing rules (PR, full checks, strict up-to-date). That is the same bar as a human hotfix merge, and the design accepts it.

Each key is stored in its own control-repo **environment**: `queue-write` (secrets `QUEUE_APP_CLIENT_ID` and `QUEUE_APP_PRIVATE_KEY`) and, with release advance, `release-write` (the same pair for the release App). Each environment also holds the state App's pair (`STATE_APP_CLIENT_ID`, `STATE_APP_PRIVATE_KEY`). Each environment allows deployments from the control repo's `main` only. The queue job sees its target token (in `tokens.queue`, default `TARGET_TOKEN`) and `STATE_TOKEN`; the release job sees `tokens.release` (default `TARGET_RELEASE_TOKEN`) and `STATE_TOKEN`; a job that can see the other App's target token refuses to start (`assertOwnKeyOnly`).

**Where the tick runs.** `.github/workflows/tick.yml` runs on self-hosted runners whose hosts destroy a job's VM at a fixed age from outside it (`runner.hostKillMinutes`) (`runner.mode: self-hosted-kill`). The other supported mode, `hosted`, runs on GitHub-hosted runners, which have no host-side kill; it requires the epoch fence instead, and its takeover rule and residual exposure are in docs/deployment.md §3.3 and §3.4. The rest of this section describes `self-hosted-kill`:
- **Runner:** a dedicated pool (at most one job at a time each) in a runner group restricted to the control repo's `.github/workflows/tick.yml@refs/heads/main`.
- **Schedule:** two jobs per tick, on a cron, plus `workflow_dispatch`: `queue` (environment `queue-write`) and `release` (environment `release-write`). The release job runs on `schedule` only, never for a dispatch, so at most one release job is created per cron interval; a dispatch wakes the queue job only.
- **Tokens:** each job mints two installation tokens with `actions/create-github-app-token` (pinned by SHA): its target App's, for the target only with exactly that App's permissions, and the state App's, for the control repo with `contents: write` only.
- **Limits and ordering:** the job timeout and concurrency groups are R1 and R7 (docs/deployment.md §3.1), and job permissions are in §12.2. The two jobs have separate leases and state branches, so they can run one after the other or at once; §11.1 says why neither starves the other.
- **Downloads:** nothing is cached; docs/deployment.md §6.3 describes the download and its check.

### 12.2 Qlander repo protection

These are activation prerequisites for the control repo:
- `main` always requires a PR. Force pushes and deletion are blocked, there are no bypass actors, and GitHub Actions cannot approve PRs.
- By default, every PR also needs **1 approving review from an account other than its author**, stale approvals are dismissed, approval is required after the latest push, and commits must be signed. [`control.mainProtection`](docs/configuration.md#controlmainprotection) sets these. `requiredApprovals` defaults to 1, takes 0 (`audit` warns) and goes up to GitHub's limit of 10. 0 relaxes only the count: `lastPushApproval`, while true, can still require one. "Reviewed" in this document means merged to control `main` under these settings.
- No secrets exist at repo or org level for the control repo, only in the two environments.
- The tick jobs' own `GITHUB_TOKEN` gets `contents: read`, `issues: write` (pause issues and the mirrors) and `actions: read` (lease takeover) on the control repo, and nothing else, except that the queue job's has `actions: write` to dispatch its own next tick (§11.1). The client refuses every other Actions write.
  - **Accepted:** the scope itself, used directly rather than through the client, also allows dispatching other workflows, cancelling, re-running or deleting runs, logs, artifacts and caches, and disabling workflows (deleting the holder's run would make lease takeover see `unknown` and stay `busy`, and the watchdog could be blinded).
  - That token exists only for the length of one job that already holds the queue App's key, which can move the target's `main`, on the runner group restricted to `tick.yml@main`, and runs only reviewed qlander code. It cannot write either state branch.
- The two state branches each have the ruleset in §3.1, and the state App's key is held only in the two reviewed-main environments.
- The workflows have only `schedule` and `workflow_dispatch` triggers, plus a `pull_request` CI that holds no secrets. Every action is pinned by SHA, the top-level `permissions: {}` is set, and zizmor and actionlint must be clean.
- Dependencies come from `bun.lock` with `--frozen-lockfile`. There are no runtime dependencies beyond Bun; the GitHub client uses `fetch`.

## 13. Target-side requirements

Qlander is not enabled on a target until each requirement is in place and verified. [docs/deployment.md §4.1](docs/deployment.md#41-requirements) lists them (T1 to T12), with what `audit` checks. This section defines the rulesets they name, and what `audit` can't check.

**Rulesets**, replacing classic branch protection on `main`:
- main-landing: PR required plus the fast-lane checks, and **restrict updates**, so only bypass actors can move main at all. That covers UI and API PR merges, and it makes main exclusive (§12.1). Bypass for the queue App, plus the target's named break-glass humans.
- main-integrity: **no bypass**; required signatures, non-fast-forward, deletion.
- release-landing (with release advance): PR required, full checks, strict up-to-date, merge commits only; bypass for the release App, plus the break-glass humans. It doesn't restrict updates, because a person merges a green hotfix PR there (§9), except with linear landing and release dispatch (§7.4), where it does, so only its bypass actors can move `release` and nobody can merge a PR into it. In dispatch mode the bypass actors are `release.dispatch.promoterApps` (mode `always`) and the break-glass humans, never the release App.
- release-integrity: no bypass; signatures, non-fast-forward, deletion.
- With linear landing (§7.4): any ruleset with a rule that refuses a forced update on PR head branches (`src/force-update.ts`) lists the queue App as a bypass actor (by App id, mode `always`), since the landing force-moves them, and classic protection on PR branches allows force pushes. With `queue.landing.author: author`, `main` does not require signed commits. `audit` T13 checks both.
- queue-refs (`queue/**`, `qlander-build/**`): restrict creation, update and deletion; bypass for the queue App only.

A separate integrity ruleset is needed because a bypass actor skips every rule in its ruleset.

**What `audit` can't check:**
- **Path filters** that decide which services to build or deploy compare against the last qualified build, not the first parent. Otherwise a batch whose last merge touches one service skips another's change.
- **Release advance** (optional): every ship path enforces qualification, and landed release SHAs are qualified too. Until then, `release.enabled` stays false or `release.dryRun` true.
- **Linear landing with release dispatch** (§7.4): the promote workflow moves `release` only by fast-forward to the dispatched sha, refuses a sha that is not on `main`, and commits nothing of its own (no version bump) on `release`.
- **A review producer** (optional): with `queue.admission.review.required` on, the producer is a main-hosted workflow or an App whose job name or check output carries the reviewed head SHA (and `run-name: Review <sha>` for a workflow).
- **Proof chain:** with the manifest qualification provider and a proof chain, the proof workflow on main and its job-name contract (`proof.jobTemplate`) stay stable, and the manifest keeps `schema: 1`, with a bump on any semantic change. If the target also evaluates the manifest itself (in its proof workflow), the two evaluators share a set of test vectors (manifest, runs and jobs to verdict), so that they cannot drift apart.

## 14. Rollout gates (in order; each is mandatory)

- **G1, the sandbox experiment.** Set up a scratch repo with main-landing and main-integrity equivalent rulesets and the queue App installed. Then:
  1. The App merges two signed PR heads through `POST /merges` onto a build branch. One of them changes `.github/workflows/`.
  2. Every merge commit must return `verification.verified == true`.
  3. Create a `queue/1` ref.
  4. `updateRefs` fast-forwards the protected `main` with `beforeOid`, and must be accepted.
  5. A wrong `beforeOid` and a non-fast-forward must both be rejected.
  6. Both PRs must be marked merged by indirect-merge detection.
  7. The state App can move both protected state branches with `updateRefs`, and nothing else can, GitHub Actions included.

  If step 2 fails, retry with the GraphQL `mergeBranch` mutation. If both fail, stop: the design needs another signing route before anything else.

  With linear landing (§7.4), also, by hand until `verify-sandbox` covers it:
  8. A commit the App creates with the git data API on a merge commit's tree, with one parent, returns `verified` with reason `valid`.
  9. `moveBranches` (`main` no-op, two PR branches forced), a wait until each PR reads at its stack commit, and then `landStack` (`main` fast-forward, the branches no-op) are accepted, on a `main` whose ruleset restricts updates with the App as bypass actor, and GitHub marks both PRs merged. Moved back with `moveBranches` and landed again, likewise.
  10. Either call with one PR branch's `beforeOid` stale (push to it first) is refused, and nothing it names moves; likewise with `main`'s `beforeOid` stale. A forced entry or no-op entry whose `beforeOid` is wrong must be refused, not applied.
  11. Whether GitHub runs `pull_request` and `push` workflows on the moved branches is recorded; a PR must end merged either way.
  12. A git data API commit with an `author` (a user's noreply address) and no committer comes back unsigned, with that user as committer as well (GitHub's documented default), and GitHub attributes it to that user; with `author: app` the `Co-authored-by` trailer shows the PR author as co-author.
  13. With the queue App's own installation token: `GET /rules/branches/{branch}` lists repository and organization `non_fast_forward` rules on a PR branch, and `GET /rulesets/{id}?includes_parents=true` returns `current_user_can_bypass` (`always` when the App is a bypass actor in mode `always`, `pull_requests_only` or `never` otherwise, `exempt` where it applies), with only Metadata and Contents read; `GET /branches/{branch}` returns `protected`.
  14. A landing whose PR branch is covered by a `non_fast_forward` ruleset without the App as bypass actor is refused whole; with the App added in mode `always` it is accepted.
- **G2:** the target-side requirements (§13) are in place, and GitHub Actions cannot approve PRs in the control repo.
- **G3:** dry run against the target for at least one day. The tick is live only when the repo variable `QLANDER_MODE` is exactly `live`. Unset, or any other value, means a dry run: it reads state and GitHub, decides, and prints what it would do, with a read-only target client, no lease and no writes anywhere.
- **G4:** enable the queue (`QLANDER_MODE=live`). Release advance is enabled separately, once its target-side requirements hold, by a reviewed change setting `release.dryRun` to false; until then the release job dry-runs whatever the mode says.

## 15. Failure modes

| Failure | Handling |
| --- | --- |
| main moved | Either `main != base` before landing, or `updateRefs` with `beforeOid` fails and a re-read shows main moved. Rebuild, with a reservation. Nothing is pushed. |
| Landing rejected while main is unchanged | Classify the error. A ruleset, signature or permission error pauses. A 5xx, or GitHub's generic GraphQL error (next row), retries on the next tick. Neither causes a rebuild. |
| GitHub's generic GraphQL error (HTTP 200, no `type`, "Something went wrong while executing your query") | GitHub uses these words for an internal fault and for a refused `updateRefs`, so the text says nothing and the refs decide. The tick ends `retry-later` and the journal recovers on the next one; nothing is retried in place, because this is a mutation. A repeat could be a refusal that no retry fixes, so the queue records them in `state.internalErrors`: `queue.timeouts.maxOpTries` within any hour pauses it. A landing's journal stays until a later read settles it, because the write may have applied. When the write that fails is the one taking or releasing the lease, there is nowhere to record a count, so the job fails and the watchdog's `ticks-failing` reports it. The release job keeps no count and pauses at once. A rejected epoch advance or a stale `epochHeld` probe is not a fault and isn't counted. |
| An unsigned merge commit | Caught at build time (§7.1), before CI runs. Pause. |
| A crash at any point | The journal (§3.2) reconciles by observation. A landing is recovered by ancestry before any integrity check. |
| Two ticks at once, or a frozen executor resuming after its lease expired | **Hard invariant: an executor never outlives its lease.** The runner contract, R1–R7 and each mode's takeover rule, is in [docs/deployment.md §3](docs/deployment.md#3-the-runner-contract). A live lease, or a holder GitHub doesn't report `completed`, makes the tick `busy`. The queue and the release job each hold their own lease on their own state branch, under the same rules. |
| A rerun request whose response was lost | Each request records its intent (`requested`, persisted before sending, and `everSent`, which is irreversible) and its receipt (`done`). An unconfirmed request is **never resent**. It is reconciled by its run's attempt until `reconcileMinutes`, and after that it is a terminal outcome that pauses. A rerun that may have been sent is never refunded. |
| Lists lag behind reality | Classification waits until a rerun run shows a newer attempt, in its metadata and its jobs. This barrier is checked before the timeout check, and it is bounded: if the run never shows a new attempt within `rerunBarrierMinutes`, it was deleted or superseded, which is a configuration problem that pauses. A snapshot that saw a PR or main move is discarded. Merge detection is awaited in verification, which never closes a PR. |
| A comment whose post was interrupted | `sentAt` is persisted before posting and the comment id after. A comment is **sent at most once**. If the receipt was lost, the marker is looked for until the reconcile window ends; after that the delivery is recorded as uncertain and never reposted. The worst case is a missing comment, which is cosmetic: the label and state are authoritative. |
| An abandoned batch's CI appears late | `cancelRuns` remembers every run id it has ever seen and reconciles each one to a terminal state, through `getRun` when the list lags. While it has seen nothing it keeps looking, because a pushed queue ref always starts CI. If runs are still running at `giveUpAt` (`cancelGiveUpHours`), it pauses. |
| An error that must pause, and the pause issue cannot be created | The pause is persisted as an outbox notice first. A pending pause counts as paused, so nothing builds, reruns or lands until it is applied and closed. |
| The pause listing is incomplete or cannot be read | The job counts as paused, never as unpaused. A paused tick still records effects that already happened and drains its outbox, as it does for an open pause issue. It never builds, reruns, lands or advances. |
| Recovery while paused | Recovery records effects that already happened (allowed). It executes outstanding work (a checkpointed build not yet pushed, a rerun not yet requested, a cancel) only when not paused, after revalidating against a fresh snapshot, and at most `maxOpTries` times before pausing. A missing target (a deleted run) is a terminal outcome that pauses. |
| Flake | One rerun of the failed jobs per batch, reserved and journalled. |
| Infra (cancelled, stuck queue, timeout) | Rerun once, then pause. Never bounce. |
| Config (missing workflow or job, unexpected skip) | Pause at once, with no split or bounce. |
| main red | A single-PR failure whose jobs match main's own failures pauses the queue. `queue.batch.breakerBounces` consecutive bounces also pause it. |
| Head changed, PR closed, unready, retargeted, or a policy fact changed | Revalidation (§4.2) drops the PR, abandons the batch and charges the run. |
| Conflict | Drop the PR, unready it and comment. |
| PR not marked merged | Report it (§7.3), after `queue.verify.ticks` ticks and at least 15 minutes. Never close it. |
| Linear: a landing refused with `main` unmoved | PR branches are moved back at once, and it is resent next tick, after revalidation, with the journal kept (§7.4). `queue.landing.maxRefusals` unexplained refusals in a row pause, journal kept; resends past `maxOpTries` pause and end the op. Transient errors are not counted. |
| Linear: a PR's branch has a rule the queue App cannot bypass | Held at admission with a comment naming the rule, `ready` kept, re-evaluated every tick (§7.4). `audit` T13 fails it for an open PR's branch. |
| Linear: a PR branch pushed to between the last revalidation and the landing, or between its two calls | Its `beforeOid` fails, so that call is refused and `main` does not move; the other branches go back (§7.4). The next tick drops that PR and rebuilds the rest. The push is never overwritten. |
| Linear: a crash between the two calls | The next tick moves the branches back, and the tick after resends after revalidation (§7.4). |
| Linear: a PR carrying commits that landed squashed | Refused at build, before CI, with a comment and `ready` removed, until rebased (§7.4). |
| Linear: a PR branch reads at its stack commit while `main` reads at its base | Moved back with `main` compared on the write path, so a lagging main read cannot unwind a landing: that write is refused, the journal stays, and later reads settle it. Past `reconcileMinutes` of refusals, pause with the journal kept, naming each branch and head. |
| Linear: an unsigned stack commit | Caught at build time (§7.4), before CI runs. Pause. |
| Linear: a PR's head branch renamed after admission | Revalidation drops it as a moved head: the landing moves only the branch recorded at admission. |
| The self-chain breaks (dispatch lost or refused, VM died, hourly cap reached) | The cron runs the next tick; the worst case equals the cron-only queue (§11.1). |
| A PR weakens CI | §4.3: tested solo, and admitted only with an approval from an account listed as an approver, bound to its SHA. |
| A key leaks | Integrity rulesets with no bypass still forbid force pushes and unsigned commits. Each key can move only its own refs. Revoke it in the App settings, and rotate keys yearly. |
| A qlander bug | The client wrapper refuses to land a `Q` that is not the active batch's green head, and refuses non-allowlisted refs. The integrity rulesets bind qlander too. To stop it: pause, or disable the workflow. |
| State corrupted or edited | Schema and cross-checks fail, and the queue pauses. Restore the state branch from its own history. |
| Release dispatch mode: a dispatch whose response was lost, or a crash between the dispatch and its receipt | Never resent. The journal becomes a record with `sent: unknown`, and the run is looked for by its dispatch id (§8.1). |
| Release dispatch mode: a dispatched run fails, is cancelled, never appears, or never finishes | A dry run: that commit is closed with a release-blocked issue and a newer one gets its own dry run. A real run that does not end green with `release` seen at the commit: the release job pauses, in the same state write that closes it (§8.1, step 6). No sha gets a second attempt unless an approver re-arms it, once per re-arm. |
| Release dispatch mode: a run carrying a copied dispatch id, a cut run listing, or a green dry run rerun to failure | Only a run GitHub reports as started and triggered by the release App's bot counts; nothing is adopted from a listing that may be cut; the dry run is authenticated and checked again just before the real run (§8.1). |
| Release dispatch mode with linear landing: someone tries to land a hotfix on `release` | Refused: release-landing restricts updates, so only the promote App and the break-glass people can move `release`; there is no hotfix path, so fix forward on `main` (§7.4, §9). A divergence that happens anyway stalls the release job ([Operating it](docs/operating.md)). |
| Release dispatch mode: `release` diverges, or a newer candidate arrives mid-flight | Diverged: release-blocked, nothing dispatched. Newer candidate: a dry run in flight finishes first, then the old candidate is superseded; a real run in flight is never superseded (§8.1). |

### 15.1 Documented residual risks

These are accepted, and each has a bound:
- **What bounds the time after the fence.** Every target write request has a deadline: 45 seconds, inside the fence margin. A request that times out is ambiguous. It is reconciled by observation and never resent: a land by re-reading main, a queue push by recovery, a rerun as a pending request, and a comment through its delivery record. That bounds a slow request. **It cannot bound a frozen process.** What does depends on the runner mode ([docs/deployment.md §3](docs/deployment.md#3-the-runner-contract)). The fence still stops any effect the process reaches after another runner has written.
- **Runner host restarts.** If the host that enforces `hostKillMinutes` restarts and adopts running VMs, they may be bounded only later than the takeover window. Both jobs rely on that kill, and the release job ignores the queue's `pause`, so the runbook ([Restarting a runner host's controller](docs/operating.md#restarting-a-runner-hosts-controller)) pauses both (`pause` and `release-pause` issues), disables `tick.yml` so no new job starts, and confirms that no tick run is in progress or queued and that each state branch's lease is null or names a job GitHub reports completed. Only then is the host restarted; afterwards the workflow is re-enabled and both pauses are closed.
- **GitHub's `Date` header has one-second resolution**, which is well inside the fence margin.
- **A comment can be missing** if a post's response is lost and the list never shows it (§15). This is cosmetic.
- **A list that lags longer than `rerunBarrierMinutes` pauses the queue**, rather than risking a decision on an old attempt.
- **The state branches' rulesets are unverified until G1** (§14), which checks that the state App can move both protected branches and that GitHub Actions and people cannot.
- **Linear landing rests on GitHub behaviour the in-memory world only models** (§7.4): that `updateRefs` is atomic across its entries, that a forced or no-op entry honours its `beforeOid`, that a PR whose head was already rewritten, and processed, when `main` moved to reach it is marked merged, and that git data API commits by the App are signed. The merged mark on that sequence, and a PR's read as the signal that its move was processed, are observed, not documented: GitHub could change either, and then a landed PR ends closed, is told so by verify (§7.4), and its change is on `main`. G1 steps 8 to 11 (§14) check them; until then, keep the mode off. Between the two calls a PR branch reads at its stack commit with `main` unmoved, and it stays that way through a crash until the next unpaused tick. With the epoch fence off, a runner frozen after its lease check and before the first call could move branches after a successor ended the op: those PRs read at stack commits with no journal. No author push is lost, since the call compares each admitted head, and `H_i` still exists, but if the PR has left the queue nothing reads it and no one is told. The epoch fence refuses that call. A refused landing whose reads still show every ref where the batch left it is resent on later ticks, after revalidation; a read lagging behind an author's push looks the same, and its resend is refused by the same compare-and-swap, so it costs at most `maxRefusals` ticks and a pause, never an overwritten push.

## 16. Cost

`F` is one pre-landing run on a queue branch.

| Scenario | Runs |
| --- | --- |
| Green batch | 1·F |
| Flake | 1·F + a partial rerun |
| One culprit in 8 | ≤ 7·F + 4 partial reruns |
| One culprit in 5 | 5·F + 3 partial reruns |
| A and B fail together | 3·F + 2 partial reruns |
| Abandoned (head change) | The consumed run is charged, plus the rebuild |

**Budgets** (`queue.budget` in `qlander.yml`): `lineage` (sized in §5.4 step 4) and `window` per `windowHours`. The watchdog status issue warns at 75% of the window. Every reservation is made and journalled before the run starts (§1, invariants 6 and 7).

**The double run on main.** A landing pushes to main, and main's CI runs again on the same SHA. A target can keep that second run (2·F per landed batch), or skip main's full lanes when a queue run of the same SHA already passed (1·F per landed batch), but only after checking that release qualification and any downstream triggers accept the reused queue evidence. The `checks-green` provider counts main runs only, so with it the second run must stay. A commit that reaches main any other way, such as a break-glass merge, should still run the full suite.

**Qlander's own cost.** One short job per tick on its runner pool, plus, while a batch is in flight, self-chained queue jobs (about one 4-minute job back to back, capped at 30 dispatched an hour). No target CI pool loses capacity. Qlander's own PR CI runs on GitHub-hosted runners, because untrusted PR code must never reach the pool that holds the App keys.

## 17. Out of scope

- Release-hotfix automation (§9 is manual).
- `repository_dispatch` wake-ups (promptness comes from self-chaining with the job's own `GITHUB_TOKEN`, §11.1, with no new credential).
- Rebase landing (one commit on `main` per PR commit). Squash landing is linear mode (§7.4).
- Policy option (a), gates from protected main (§4.3).
- Megabatches that bypass the solo filter.
