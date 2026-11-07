# How it works

Qlander tests ready PRs in batches, then moves `main` to the commit whose CI passed. [DESIGN.md](../DESIGN.md) has the full design and every failure mode.

## The moving parts

Qlander runs from its own **control repo**, never from the repo it lands on (the **target**). A scheduled workflow, `tick.yml`, runs the queue job on each tick, and the release job too once release advance is enabled:

- **Queue job:** admits PRs, builds batches and moves `main`.
- **Release job (optional):** fast-forwards the target's `release` branch to qualified `main` commits, or, in [dispatch mode](#dispatch-mode-opt-in), has the target's own release workflow do it.

While work is in flight, the queue job also starts its own next tick, using its `GITHUB_TOKEN` and a `workflow_dispatch`, at most 30 times an hour.

Qlander reaches the target only through the GitHub API, using GitHub Apps. It never checks out or runs target code. The queue App is the only identity allowed to move the target's `main`, and the release App moves `release` (in dispatch mode, the target's workflow does).

`qlander.yml` in the control repo sets everything Qlander acts on. The [configuration reference](configuration.md) lists every key. Label names on this page are examples, set in [`queue.labels`](configuration.md#queuelabels).

## How a PR gets landed

1. **Qualify.** The PR's fast lane, the check named in [`queue.admission.fastLane`](configuration.md#queueadmissionfastlane), passes on its current head. Someone with write access then adds `ready`.
2. **Admit.** On the next tick, qlander admits the PR and records its head SHA. If the head changes later, the PR leaves the queue and has to qualify again.
3. **Batch.** Ready PRs are batched first in, first out. Each batch is merged onto `queue/<n>`, and the target's CI runs the full suite there.
4. **Land.** When every required job passes, `main` moves to that exact commit with a compare-and-swap. GitHub then marks the PRs merged, and qlander removes `ready`. With [linear landing](#linear-landing-opt-in), each PR lands as one squashed commit instead of a merge.

Who can add `ready`:

- **Write access.** Qlander ignores a `ready` added by anyone without write access.
- **Review producer.** With [`queue.admission.review.required`](configuration.md#queueadmissionreview), a configured review producer must vouch for the head. See [DESIGN.md, Producer-bound evidence](../DESIGN.md#41-producer-bound-evidence).
- **Trusted automation.** A bot listed in [`queue.policy.trustedAutomations`](configuration.md#queuepolicytrustedautomations) can add `ready` to its own PRs. See [CI-policy PRs](#ci-policy-prs).

## When a batch is built

A fresh batch is built once [`queue.batch.minFill`](configuration.md#queuebatch) PRs are admitted or the oldest has waited `queue.batch.maxWaitMinutes`, whichever comes first. It holds at most `queue.batch.max` PRs, unless the [adaptive strategy](#isolation-strategies-opt-in) grows the limit.

A batch is built at once when:

- a PR that runs alone is next in line, or ends the run of ordinary PRs ahead of it. Such a PR is a CI-policy PR, a trusted automation's waived PR, or a PR marked `qlander:solo`;
- someone adds `qlander:go` to any PR.

Split halves and reruns never wait.

## When a batch fails

A red batch never lands. Qlander reruns its failed jobs once.

- **Green on the rerun:** the failure was flaky. The batch lands, and the flake is recorded.
- **Red again, one PR:** the PR is bounced. It loses `ready` and gets a comment with the failed jobs.
- **Red again, several PRs:** the batch splits into halves, each tested on `main`. A green half lands, and a red half repeats this process.

A bounce comment looks like this:

> Bounced from the landing queue: batch 42 (this PR alone, at `3f2a9c1e0b7d4a6f8e5c2b1a9d0f7e6c5b4a3d21`, on top of main `8be04d7f1c2a3b4e5d6c7f8a9b0e1d2c3f4a5b67`) failed, and failed again on a rerun.
>
> - [unit-tests](https://github.com/acme/widgets/actions/runs/123/job/456)
>
> Fix it and re-add `ready`.

The other PRs from its batch land without it. A PR that conflicts with the ones ahead of it gets a "Not queued" comment instead.

| Case | What happens |
| --- | --- |
| Split depth reached | A batch is halved at most [`queue.batch.maxSplitDepth`](configuration.md#queuebatch) times. Past that, each PR is tested alone. |
| Reds in a row | The size limit for fresh batches halves per red, down to `queue.batch.min`. |
| A single PR fails only jobs that also fail on `main` | The queue pauses instead of bouncing it. Fix `main` first. |
| [`queue.batch.breakerBounces`](configuration.md#queuebatch) bounces in a row | The queue pauses. |
| A job is cancelled, or qlander cancels a run for overrunning its [time limits](configuration.md#queuetimeouts) | This is not a test failure. Qlander reruns it once, then pauses, and never bounces a PR for it. A job that concludes `timed_out` on its own `timeout-minutes` is a failure. |
| A required job is skipped or missing, or a `when: always` workflow never ran | The queue pauses at once. In a batch with a CI-policy PR, this counts as red instead, since that PR's change is the likely cause. |
| A budget runs out | Qlander bounces or pauses, and never loops. Every build, rebuild and rerun reserves from [two budgets](configuration.md#queuebudget): one per batch and its splits, one a rolling window. |
| A PR conflicts with the PRs ahead of it | It is dropped from the batch and told why. The rest of the batch carries on. |

## CI-policy PRs

A **CI-policy PR** touches a path in [`queue.policy.paths`](configuration.md#queuepolicy). Such a PR can change what your CI checks, so it can't land on its own CI's word. It lands alone, unless you opt in to [sharing a batch](#sharing-a-batch-opt-in), and needs an approval comment from one of [`queue.policy.approvers`](configuration.md#queuepolicyapprovers) that names its exact head SHA:

```
/qlander approve-policy <40-character head sha>
```

The comment must not be edited. A push changes the head, so it needs a new approval. Once a ready CI-policy PR has waited 30 minutes for its approval, qlander comments with the exact line to post. See [DESIGN.md, CI-policy changes](../DESIGN.md#43-ci-policy-changes).

### Trusted automations

A bot listed in [`queue.policy.trustedAutomations`](configuration.md#queuepolicytrustedautomations) may land a PR without a human, but only when the PR changes nothing except the bot's own listed paths. Every commit must be signed, authored and pushed by the bot. The PR still runs the full suite, in a batch of its own. Anything else falls back to the approval above, from an account you list as an approver. Keep those accounts to people: qlander can check the account, not who is using it.

### Sharing a batch (opt-in)

With [`queue.policy.shareBatch`](configuration.md#queuepolicysharebatch), approved CI-policy PRs that are next to each other in the queue may share a batch of up to `max`.

- They never share with ordinary PRs.
- A trusted automation's waived PR, and a PR marked `qlander:solo`, still run alone.
- Each PR still needs its own approval.
- A red shared batch is split until the culprit runs alone.
- The queued comment names the other CI-policy PRs in the batch.

Each PR is then also tested under the others' gate changes. If one of them weakens a gate, add `qlander:solo` to it. [DESIGN.md](../DESIGN.md#43-ci-policy-changes) explains the trade, under "(d)".

## Several batches at once (opt-in)

By default, one batch's CI runs at a time. With [`queue.concurrency`](configuration.md#queueconcurrency) set, more than one runs at once:

- **Split halves side by side.** The two halves of a failed batch run at the same time. A green half lands without waiting for the other half to be isolated.
- **Pipelining.** While a fresh batch's CI runs, the next fresh batch is built on top of it, and lands right after the batch under it.
- **Discarding.** If the batch under it fails, the batch on top is discarded, and its PRs keep their place.

`main` still moves only to a commit whose CI passed, by compare-and-swap. The setting is not policy, so changing it doesn't drop admitted PRs. It multiplies CI load by up to `maxActive` while batches overlap, so size it to your CI pool. See [DESIGN.md, Several batches at once](../DESIGN.md#56-several-batches-at-once-split-halves-side-by-side-and-pipelining-opt-in).

## Isolation strategies (opt-in)

[`queue.strategy`](configuration.md#queuestrategy) changes how a red batch is isolated. Every key is off when absent. The block is not policy, so changing it doesn't drop admitted PRs. See [DESIGN.md, Isolation strategy](../DESIGN.md#57-isolation-strategy-opt-in) for the rules.

| Key | What it does |
| --- | --- |
| `firstAlone` | Retests a red fresh batch's first PR alone, then the rest together, instead of halves. |
| `skipSeenRed` | Splits at once, without a run, a group of PRs whose tree was already seen red on the current `main`. It saves CI when one batch runs at a time. |
| `reuseGreen` | Remembers a batch the queue abandoned as it paused, for example after CI was inconclusive twice, and leaves its runs to finish. On resume, if `main` hasn't moved and the run is green, the batch lands without a rebuild. That run may be green because someone reran it by hand during the pause. |
| `mainBaseline` | Before bouncing a PR that failed alone, runs the suite on `main` with no PR in it. If every failing test also fails there, the PR stays admitted, isn't bounced or counted, and is tested again once `main` moves. A failure of its own still bounces it, and nothing lands on a red suite. It costs one extra suite per PR that would have bounced, or none once `main` is known to be red. The watchdog raises a `main is broken` alert, and enough held PRs pause the queue. |
| `adaptive` | Doubles the fresh batch size, up to `ceiling`, after `greens` full batches in a row land green, and halves it on a red fresh batch. Without it, the size only halves per red in a row. |

These results come from the test suite's simulator (`test/strategy.test.ts`), never from a live queue. Your CI's run time and failure rate will change them. In every row the same PRs land and bounce. "One culprit" averages over a culprit at each position in the batch.

| Scenario | Without the key | With it |
| --- | --- | --- |
| `skipSeenRed`, one culprit, batch of 4, 6 or 8 | 8, 10 or 11 runs | 7, 7.7 or 9 runs |
| `skipSeenRed` and `firstAlone`, same batches | 8, 10 or 11 runs | 6.25, 7.8 or 8.9 runs |
| `firstAlone` alone | | The oldest PR lands sooner; an isolation costs about half a run more on average. |
| `skipSeenRed` through the runner, culprit at position 7 of 8 | 11 runs | 7 runs, and fewer ticks |
| `adaptive` (`greens: 2`, `ceiling: 16`, `max: 8`), 128 green PRs | 16 runs | 9 runs |
| `adaptive`, same settings, 200 PRs with two culprits | 45 runs, 74 ticks | 40 runs, 64 ticks |
| `reuseGreen` through the runner, batch rerun by hand during a pause | A rebuild and a whole CI run | No new run |

## Order and the priority lane

The queue is strictly first in, first out, by the time each PR was admitted. Split halves and solo retests always come before new PRs. `qlander:solo` changes how a PR is tested, not its place.

The opt-in priority lane lets a human put an urgent PR first. See [Operating it](operating.md#bouncing-isolating-and-landing-prs).

## Linear landing (opt-in)

By default each PR lands as a merge commit whose subject is `<PR title> (#<number>)`, with the head it was admitted at and `Landed-by: qlander batch <n>` in the body. A PR with no title, or one whose title could read as a trailer, a patch divider or qlander's fixed subject, gets `Merge pull request #<number> at <head>` instead.

For a repo that requires linear history, set [`queue.landing.mode`](configuration.md#queuelanding) to `linear`:

- **One commit per PR.** Each batch is built as a stack on `main`: one commit per PR, holding that PR's changes on top of the commit before it, with the message `<PR title> (#<number>)` and a body from `queue.landing.body`. Qlander still builds it through the GitHub API only, and a PR that conflicts gets the usual "Not queued" comment.
- **CI is unchanged.** It runs on `queue/<n>` at the top of the stack. Splits and retests build new stacks.
- **Landing.** Each PR's branch moves to its own commit in the stack, qlander waits until each PR reads at that commit, and `main` then fast-forwards to the tested commit, so GitHub sees the PR's head in `main` and marks it merged. Each of the two writes compare-and-swaps what the other relies on. Moving a PR branch is a force update, but only of the branch recorded when the PR was admitted, and only from the head it was admitted at. If the landing doesn't complete, qlander moves the branches back itself.
- **The merged mark isn't guaranteed.** It rests on GitHub's background processing of the branch move, which GitHub doesn't document. A landed PR that still ends closed gets a comment saying its change is on `main`. The mark also doesn't close issues named with `Closes #n`, and `merged_by` is often empty, usually on all but the last PR of a batch.
- **A push is never overwritten.** If someone pushed to a PR's branch, the landing is refused and `main` doesn't move. That PR leaves the queue with the usual comment, and the rest are rebuilt and retested.
- **The rewrite isn't a push by the author.** The fast lane, review and CI-policy approval stay bound to the head that was admitted. GitHub may run your PR workflows on the moved branches; qlander ignores those runs.
- **Authorship.** By default the queue App authors each commit, so GitHub signs it, and the PR's author is credited with a `Co-authored-by` trailer at their GitHub noreply address. With [`queue.landing.author`](configuration.md#queuelanding) set to `author`, the PR's author is the commit's author instead; those commits are unsigned, so `audit` fails it if `main` requires signed commits.
- **Branch rules.** The queue App must be able to force-update PR branches. A PR whose branch has a rule the App can't bypass waits with a comment naming the rule and keeps `ready`; `audit` (T13) checks your rulesets and branch protection for this.
- **A refused landing is retried.** If GitHub refuses the landing and nothing has moved, qlander retries it on the next tick, and pauses only after `queue.landing.maxRefusals` refusals in a row.
- **Release advance.** It can't be combined with linear landing: a hotfix merge-back would land squashed, so `release` would never rejoin `main`. Validation refuses the combination.
- **Release dispatch mode.** It can be combined with linear landing, with `queue.landing.author: app` only. `release` then only fast-forwards to `main` commits: `setup` restricts updates on it, so only the promote App and the break-glass people can move it, and there is no hotfix path. Fix forward on `main`.

The setting is policy, so changing it takes `ready` off admitted PRs. Qlander's tests can only model GitHub's side of this (the two writes and the merged mark), so check it in a sandbox repo first ([DESIGN.md §14](../DESIGN.md#14-rollout-gates-in-order-each-is-mandatory), G1). See [DESIGN.md, Linear landing](../DESIGN.md#74-linear-landing-opt-in-queuelandingmode-linear).

## After landing

GitHub marks a landed PR merged once it sees the PR's head in `main`, and qlander then removes `ready`. If GitHub doesn't mark it merged within [`queue.verify.ticks`](configuration.md#queueverify) ticks, and at least 15 minutes, qlander comments to say so. It never closes a PR.

A push before admission changes what would land, and `ready` stays on: the new head is admitted once its fast lane is green. A push to an admitted PR normally drops it from the queue and removes `ready`. If a push arrives after qlander's last check before landing, the pinned head lands, and qlander comments that the later commits are not in `main`.

## Release advance

The optional release job fast-forwards the target's `release` branch to the newest qualified `main` commit. It is a separate job with its own App, lease, state branch and pause.

1. It lists the `main` commits not yet in `release`, newest first.
2. It checks each one with the configured qualification provider: `manifest`, `checks-green` or `commit-status`. See the [qualification manifest spec](qualification-manifest.md).
3. It moves `release` to the newest qualified commit, with a compare-and-swap.

When `release` can't advance, the job opens a `release-blocked` issue, which pauses nothing. The causes include:

- `release` has diverged from `main`, for example after a hotfix that was not merged back;
- the qualification policy can't be read;
- none of the newest [`release.maxCandidates`](configuration.md#release) commits qualifies, and older ones were not examined.

Release advance is off until `release.enabled` is true. It acts only when `release.dryRun` is false and `QLANDER_MODE` is `live`. See [Getting started, step 3](getting-started.md#3-leave-qlander_mode-unset).

### Dispatch mode (opt-in)

If promoting a commit means more than moving a branch (migrations, a deploy, smoke checks), set [`release.mode: dispatch`](configuration.md#release). Qlander then never writes `release`. It still picks the newest qualified `main` commit as above, and hands it to your own workflow, [`release.dispatch.workflow`](configuration.md#releasedispatch), which promotes it and moves `release` itself:

1. **Dry run.** Qlander dispatches the workflow with the commit's sha and the dry-run input set to `"true"`, once per sha.
2. **Report.** When the dry run is green, the release job comments on the [status issue](operating.md#the-status-issue) with the sha and a link to the run.
3. **Approval.** One of [`release.dispatch.approvers`](configuration.md#releasedispatchapprovers) comments there, with exactly:

   ```
   /qlander approve-release <40-character sha>
   ```

4. **Real run.** Qlander dispatches the workflow again with the dry-run input `"false"`, once per sha, and only within [`dryRunValidMinutes`](configuration.md#releasedispatch) of the green dry run.
5. **Advanced.** Release counts as advanced only when qlander sees `release` at the commit.

Your workflow needs a `workflow_dispatch` trigger with the three inputs named in [`release.dispatch.inputs`](configuration.md#releasedispatchinputs), and a `run-name` that contains the dispatch id, which is how qlander finds the run it started. A run counts only if GitHub also reports the release App's bot, [`release.dispatch.actor`](configuration.md#releasedispatchactor), as the account that started it and triggered its latest attempt, so a copy of the id in someone else's run is ignored:

```yaml
on:
  workflow_dispatch:
    inputs:
      sha: { required: true, type: string }
      dry_run: { required: true, type: string }
      dispatch_id: { required: true, type: string }
run-name: "Promote ${{ inputs.sha }} (dry run ${{ inputs.dry_run }}) ${{ inputs.dispatch_id }}"
```

What happens when something goes wrong:

| Case | What happens |
| --- | --- |
| The dry run fails, is cancelled or never appears | A `release-blocked` issue. That commit gets no second dry run; the next qualified commit gets its own. |
| Nobody approves in time | The dry run expires, with a `release-blocked` issue. |
| The real run fails, is cancelled, never appears or never finishes | The release job pauses (`release-pause`), not the queue: production may have changed. |
| The real run is green but `release` doesn't move | The release job pauses after [`observeMinutes`](configuration.md#releasedispatch). |
| The real run fails although `release` moved | The release job pauses: the ref alone doesn't show the promotion finished. |
| You want that commit tried again | An approver re-arms it (`/qlander rearm-release <sha> <incident>`, or `rearm-release <sha>`): one new attempt, from a fresh dry run and a fresh approval. See [Operating](operating.md#approving-a-release-dispatch-mode). |
| A newer commit qualifies | It replaces a candidate waiting for approval at once, and one whose dry run is running once that run ends. A real run is always followed to its end first. |
| A freeze variable is set | No new dispatch until it is cleared. See [`release.dispatch.freeze`](configuration.md#releasedispatchfreeze). |

Pauses, the lease and the dispatch budget work as for the rest of the release job. Before the real run, qlander checks the dry run again: a rerun that failed, or a green run older than the window, stops it. In this mode the release App needs **Actions: write**, keeps only **Contents: read** (write only with the epoch fence) and no Workflows permission, and must not bypass the release ruleset, so it cannot move `release` itself. See [DESIGN.md, Dispatch mode](../DESIGN.md#81-dispatch-mode-opt-in).

## State

Each job keeps its state as `state.json` on its own branch in the control repo. Every change is a new commit, made with a compare-and-swap, so the branch history is the audit log. Only the state App can move these branches. An issue mirrors each state for people. [Inspecting state](operating.md#inspecting-state) shows how to read both.
