# Configuration

<!-- Generated from schema/qlander.schema.json by scripts/config-doc.ts. Do not edit: change the schema, then run `bun scripts/config-doc.ts`. -->

Qlander reads one file: `qlander.yml`, at the root of the control repo. Start from the template's copy and change what you need. This page lists every key.

- **Default** is the value used when you leave the key out. `required` means you must set it. `none` means no single default: the meaning, or the block's own section, says what leaving it out does.
- **Policy.** Most keys are in the policy hash: changing one makes every admitted PR lose `ready` at the next tick. Outside the hash: `control.mainProtection`, `queue.concurrency`, `queue.strategy`, `hooks`, `tokens`, `bundle`, `notify`, `comments`, `runner` except its timings, and `release` except `branch`, `stateBranch` and `labels`. See [the policy hash](deployment.md#82-the-policy-hash).
- **Checking.** Run `bun "${bundle:?}" validate --config qlander.yml` to check a config. After any change, run `bun "${bundle:?}" render --config qlander.yml` and commit the workflows with it. (In the qlander source repo, `bun src/cli.ts` in place of the bundle.)

## Contents

- [Top level](#top-level)
- [control](#control)
  - [control.mainProtection](#controlmainprotection)
- [target](#target)
- [runner](#runner)
- [lease](#lease)
- [queue](#queue)
  - [queue.refs](#queuerefs)
  - [queue.labels](#queuelabels)
  - [queue.priority](#queuepriority)
  - [queue.concurrency](#queueconcurrency)
  - [queue.strategy](#queuestrategy)
  - [queue.strategy.adaptive](#queuestrategyadaptive)
  - [queue.landing](#queuelanding)
  - [queue.controlLabels](#queuecontrollabels)
  - [queue.admission](#queueadmission)
  - [queue.admission.fastLane](#queueadmissionfastlane)
  - [queue.admission.review](#queueadmissionreview)
  - [queue.admission.review.producer (adapter job@main)](#queueadmissionreviewproducer-adapter-jobmain)
  - [queue.admission.review.producer (adapter app-check)](#queueadmissionreviewproducer-adapter-app-check)
  - [queue.policy](#queuepolicy)
  - [queue.policy.shareBatch](#queuepolicysharebatch)
  - [queue.policy.trustedAutomations[]](#queuepolicytrustedautomations)
  - [queue.policy.approvers[]](#queuepolicyapprovers)
  - [queue.preLanding[]](#queueprelanding)
  - [queue.batch](#queuebatch)
  - [queue.budget](#queuebudget)
  - [queue.timeouts](#queuetimeouts)
  - [queue.verify](#queueverify)
- [release](#release)
  - [release.labels](#releaselabels)
  - [release.qualification](#releasequalification)
  - [release.qualification.manifest](#releasequalificationmanifest)
  - [release.qualification.manifest.proof](#releasequalificationmanifestproof)
  - [release.qualification.checksGreen](#releasequalificationchecksgreen)
  - [release.qualification.checksGreen.required[]](#releasequalificationchecksgreenrequired)
  - [release.qualification.commitStatus](#releasequalificationcommitstatus)
  - [release.qualification.commitStatus.proof](#releasequalificationcommitstatusproof)
  - [release.dispatch](#releasedispatch)
  - [release.dispatch.inputs](#releasedispatchinputs)
  - [release.dispatch.actor](#releasedispatchactor)
  - [release.dispatch.approvers[]](#releasedispatchapprovers)
  - [release.dispatch.budget](#releasedispatchbudget)
  - [release.dispatch.freeze[]](#releasedispatchfreeze)
- [watchdog](#watchdog)
  - [watchdog.labels](#watchdoglabels)
- [hooks[]](#hooks)
- [tokens](#tokens)
- [bundle](#bundle)
- [notify](#notify)
- [comments](#comments)
- [Formats](#formats)

## Top level

qlander.yml: the whole configuration of one deployment. It lives in the control repo, never in the target.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `version` | `1` | required | The config schema version. A version the code does not know is refused. |
| `control` | mapping | required | The control repo: the repo that holds this file, the tick workflow, the App keys and the state branches. See [control](#control). |
| `target` | mapping | required | The target: the repo whose main qlander lands PRs on. See [target](#target). |
| `runner` | mapping | required | The runner contract: where the tick jobs run, and what bounds a job that freezes. See [runner](#runner). |
| `lease` | mapping | required | Each job's whole-tick lease. See [lease](#lease). |
| `queue` | mapping | required | The merge queue: what admits a PR, how batches are built and tested, and the budgets that bound them. See [queue](#queue). |
| `release` | mapping | required | Release advance: move the target's release branch to qualified main commits, by fast-forwarding it (mode advance) or by dispatching the target's own release workflow (mode dispatch). See [release](#release). |
| `watchdog` | mapping | required | The watchdog's issues in the control repo. See [watchdog](#watchdog). |
| `hooks` | list of mappings | `[]` | Lifecycle event hooks: notifications sent to the target as repository_dispatch events. See [hooks[]](#hooks). |
| `tokens` | mapping | none | The environment variables the tick workflow puts each App's installation token in. See [tokens](#tokens). |
| `bundle` | mapping | none | Run a pinned release instead of the control repo's own source. See [bundle](#bundle). |
| `notify` | mapping | none | Who to tell when the queue stops. See [notify](#notify). |
| `comments` | mapping | none | PR comments to leave out. See [comments](#comments). |

```yaml
version: 1
```

## `control`

The control repo: the repo that holds this file, the tick workflow, the App keys and the state branches.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `control.repo` | [owner/name](#formats) | required | The control repo, as owner/name. |
| `control.repoId` | integer | required | The control repo's numeric id, checked against GitHub on connect and rendered into the workflows' repo guard. |
| `control.mainProtection` | mapping | none | What audit expects of the control repo's main ruleset, and what setup writes there. See [control.mainProtection](#controlmainprotection). |

```yaml
control:
  repo: halyard/tidepool-qlander
  repoId: 2001
```

### `control.mainProtection`

What audit expects of the control repo's main ruleset, and what setup writes there. Absent: every key at its default. audit reports a relaxed key as a WARN that names it, and setup neither adds nor removes that protection. Always required: a pull request, blocked force pushes and deletion, and no bypass actors. Not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `control.mainProtection.requiredApprovals` | integer | `1` | Approving reviews a PR to the control repo's main needs. 0 relaxes only the count: lastPushApproval, while true, can still require one. At least 0. |
| `control.mainProtection.dismissStaleReviews` | boolean | `true` | Dismiss stale approvals when new commits are pushed. |
| `control.mainProtection.lastPushApproval` | boolean | `true` | Require the most recent push to be approved by someone other than its pusher. |
| `control.mainProtection.signedCommits` | boolean | `true` | Require signed commits on the control repo's main. |

```yaml
control:
  mainProtection:
    requiredApprovals: 0
    dismissStaleReviews: false
    lastPushApproval: false
    signedCommits: false
```

## `target`

The target: the repo whose main qlander lands PRs on.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `target.repo` | [owner/name](#formats) | required | The target repo, as owner/name. |
| `target.repoId` | integer | required | The target repo's numeric id, checked against GitHub on connect. |
| `target.main` | [branch](#formats) | required | The target branch that qlander lands on. |

```yaml
target:
  repo: halyard/tidepool
  repoId: 2002
  main: main
```

## `runner`

The runner contract: where the tick jobs run, and what bounds a job that freezes. The loader checks each mode's rules after the schema. In the policy hash: jobTimeoutMinutes, takeoverGraceMinutes, and the kill bound that mode and hostKillMinutes set. The other keys are not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `runner.mode` | string | required | self-hosted-kill: self-hosted runners whose host destroys each job's VM at hostKillMinutes. hosted: GitHub-hosted runners, which have no host-side kill, so epochFence must be true. Values: `self-hosted-kill`, `hosted`. |
| `runner.cronMinutes` | integer | required | The tick workflow's schedule interval. Must be more than lease.minutes. |
| `runner.jobTimeoutMinutes` | integer | required | Each tick job's timeout-minutes. At most lease.minutes minus lease.fenceMarginMinutes. |
| `runner.hostKillMinutes` | integer | none | self-hosted-kill only: the host destroys the job's VM at this age. At least jobTimeoutMinutes. |
| `runner.takeoverGraceMinutes` | integer | required | How long past the kill bound (in hosted mode, the job timeout) a successor waits before it takes over an expired lease. At least 1, or 15 in hosted mode. |
| `runner.epochFence` | boolean | `false` | Tie every target ref write to the current lease through an epoch branch in the target. Required in hosted mode; defence in depth in self-hosted-kill mode. |
| `runner.epochPrefix` | [branch prefix](#formats) | `qlander-epoch/` | The target branch prefix for the two epoch branches, <prefix>queue and <prefix>release. |
| `runner.runsOn` | list of strings | none | The tick jobs' runner labels, rendered into tick.yml. Required in self-hosted-kill mode. In hosted mode, absent means ubuntu-latest. |

```yaml
runner:
  mode: self-hosted-kill
  cronMinutes: 10
  jobTimeoutMinutes: 5
  hostKillMinutes: 6
  takeoverGraceMinutes: 2
  epochFence: true
  epochPrefix: qlander-epoch/
  runsOn:
    - self-hosted
    - qlander
```

## `lease`

Each job's whole-tick lease. A job never outlives its lease: runner.jobTimeoutMinutes must be at most minutes minus fenceMarginMinutes.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `lease.minutes` | integer | required | How long a lease lasts once taken. Less than runner.cronMinutes. |
| `lease.fenceMarginMinutes` | integer | required | A target write is made only while more than this much of the lease is left. |

```yaml
lease:
  minutes: 8
  fenceMarginMinutes: 2
```

## `queue`

The merge queue: what admits a PR, how batches are built and tested, and the budgets that bound them.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.stateBranch` | [branch](#formats) | required | The control-repo branch that holds the queue's state.json. |
| `queue.refs` | mapping | required | Target branch prefixes. See [queue.refs](#queuerefs). |
| `queue.labels` | mapping | required | Labels on target PRs. See [queue.labels](#queuelabels). |
| `queue.priority` | mapping | none | Priority lane settings. See [queue.priority](#queuepriority). |
| `queue.concurrency` | mapping | none | Run more than one batch's CI at a time. See [queue.concurrency](#queueconcurrency). |
| `queue.strategy` | mapping | none | How a red batch is isolated and how big fresh batches grow. See [queue.strategy](#queuestrategy). |
| `queue.landing` | mapping | none | How a green batch lands on main. See [queue.landing](#queuelanding). |
| `queue.controlLabels` | mapping | required | Labels on control-repo issues. See [queue.controlLabels](#queuecontrollabels). |
| `queue.admission` | mapping | required | What a PR needs, on its current head, before the ready label admits it. See [queue.admission](#queueadmission). |
| `queue.policy` | mapping | required | The CI-policy boundary: which changes land alone, with an approval bound to their SHA from an account listed in approvers. See [queue.policy](#queuepolicy). |
| `queue.preLanding` | list of mappings | required | The pre-landing manifest: the workflows a queue branch must pass before main moves to it. See [queue.preLanding[]](#queueprelanding). |
| `queue.batch` | mapping | required | How fresh batches are sized, and when they are built. See [queue.batch](#queuebatch). |
| `queue.budget` | mapping | required | CI budgets. See [queue.budget](#queuebudget). |
| `queue.timeouts` | mapping | required | Time limits on CI runs and on reconciling effects. See [queue.timeouts](#queuetimeouts). |
| `queue.verify` | mapping | required | Checking that landed PRs are marked merged. See [queue.verify](#queueverify). |
| `queue.historyLimit` | integer | required | Finished batch records kept in the queue's state. |

```yaml
queue:
  stateBranch: qlander-state
  historyLimit: 100
```

### `queue.refs`

Target branch prefixes. No target workflow may trigger on buildPrefix, and only the preLanding workflows trigger on queuePrefix.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.refs.queuePrefix` | [branch prefix](#formats) | required | The branches CI tests: batch n is pushed as <queuePrefix><n>. |
| `queue.refs.buildPrefix` | [branch prefix](#formats) | required | The scratch branches a batch is merged on before its single push to <queuePrefix><n>. |

```yaml
queue:
  refs:
    queuePrefix: queue/
    buildPrefix: qlander-build/
```

### `queue.labels`

Labels on target PRs. The command labels are removed once applied.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.labels.ready` | [label](#formats) | required | Marks a PR ready to land. Counts only when applied by a write-access account, the review producer or a trusted automation. |
| `queue.labels.bounce` | [label](#formats) | required | Command: take the PR out of the queue. |
| `queue.labels.solo` | [label](#formats) | required | Command: test the PR alone, without changing its place. |
| `queue.labels.unsolo` | [label](#formats) | required | Command: undo solo. |
| `queue.labels.go` | [label](#formats) | required | Command, on any PR: build the next batch without waiting for it to fill. |
| `queue.labels.priority` | [label](#formats) | none | The priority lane's label. A PR carrying it, applied by a human with write access, goes to the front of the queue and builds at once. Absent: no priority lane. Policy when set. |

```yaml
queue:
  labels:
    ready: ready
    bounce: qlander:bounce
    solo: qlander:solo
    unsolo: qlander:unsolo
    go: qlander:go
    priority: qlander:priority
```

### `queue.priority`

Priority lane settings. Only with queue.labels.priority.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.priority.preempt` | boolean | `false` | Stop a running batch whose CI is still pending to build a prioritised PR at once. Policy when true. |

```yaml
queue:
  priority:
    preempt: false
```

### `queue.concurrency`

Run more than one batch's CI at a time. A failed batch's halves run side by side, and a fresh batch can be built on top of the running one (pipelining). Absent: one batch at a time. Not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.concurrency.maxActive` | integer | `2` | Batches whose CI may run at once, speculative ones included. |
| `queue.concurrency.pipelineDepth` | integer | `1` | Speculative batches stacked on the running fresh batch. 0 turns pipelining off. At most maxActive - 1. At least 0. |

```yaml
queue:
  concurrency:
    maxActive: 2
    pipelineDepth: 1
```

### `queue.strategy`

How a red batch is isolated and how big fresh batches grow. Absent: every key is off. Not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.strategy.firstAlone` | boolean | `false` | Split a red fresh batch into its first PR and the rest, instead of halves. The oldest PR then gets a run of its own next. |
| `queue.strategy.skipSeenRed` | boolean | `false` | Split a group of PRs at once, without a run, when its tree was already seen red on the current main. A single PR is always built. |
| `queue.strategy.reuseGreen` | boolean | `false` | Remember a batch abandoned as the queue paused. On resume, land it without a rebuild if main has not moved and its run is now green. |
| `queue.strategy.mainBaseline` | boolean | `false` | Before bouncing a PR that failed alone, run the suite on main with no PR in it. A PR whose failing tests all fail there too stays admitted, is not bounced or counted, and is retried once main moves. Nothing lands on a red suite. The watchdog alerts, and breakerBounces held PRs pause the queue. See DESIGN.md §5.7. |
| `queue.strategy.adaptive` | mapping | none | Adapt the fresh batch size limit. See [queue.strategy.adaptive](#queuestrategyadaptive). |

```yaml
queue:
  strategy:
    firstAlone: true
    skipSeenRed: true
    reuseGreen: true
    mainBaseline: true
```

### `queue.strategy.adaptive`

Adapt the fresh batch size limit. It starts at queue.batch.max, doubles up to ceiling after greens full batches in a row land green, and halves (not below queue.batch.min) on a red fresh batch. Absent: queue.batch.max, halved per red in a row.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.strategy.adaptive.greens` | integer | required | Full fresh batches landed green in a row before the limit doubles. |
| `queue.strategy.adaptive.ceiling` | integer | required | The largest the limit grows to. At least queue.batch.max. |

```yaml
queue:
  strategy:
    adaptive:
      greens: 2
      ceiling: 16
```

### `queue.landing`

How a green batch lands on main. Absent: merge mode, one merge commit per PR. Policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.landing.mode` | string | `merge` | merge: each PR lands as a merge commit, and main fast-forwards to the tested queue commit. linear: each PR lands as one squashed commit on a linear stack, and the one atomic update that moves main also force-moves each PR's head branch, from its admitted head, to its own commit, so GitHub marks it merged. For repos that require linear history. See DESIGN.md §7.4. Values: `merge`, `linear`. |
| `queue.landing.author` | string | `app` | linear mode only: who authors each squashed commit. app: the queue App is author and committer, the commit is signed by GitHub, and the PR's author is credited with a Co-authored-by trailer. author: the PR's author is the commit's author, at their GitHub noreply address, and, as GitHub defaults the committer to the author, its committer too; such a commit is not signed, so audit fails it when the target requires signed commits on main. See DESIGN.md §7.4. Values: `app`, `author`. |
| `queue.landing.maxRefusals` | integer | `3` | linear mode only: refused landings in a row, with main and every PR branch still where the batch left them, before the queue pauses. Each refusal is retried on the next tick; none costs a CI run. |
| `queue.landing.body` | string | `Squashed from #{number} at {head}.\n\nLanded-by: qlander batch {batch}` | linear mode only: the body of each squashed commit, below the subject `<PR title> (#<number>)`. Placeholders: {number}, {head} (the admitted head SHA) and {batch}. A \n in a double-quoted string is a line break. |

```yaml
queue:
  landing:
    mode: linear
    author: app
    maxRefusals: 3
    body: "Squashed from #{number} at {head}.\\n\\nLanded-by: qlander batch {batch}"
```

### `queue.controlLabels`

Labels on control-repo issues.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.controlLabels.pause` | [label](#formats) | required | An open control-repo issue with this label pauses the queue. |
| `queue.controlLabels.mirror` | [label](#formats) | required | Labels the issue that mirrors the queue's state for people. Qlander reads it only to refuse to start from empty when the state branch is missing. |

```yaml
queue:
  controlLabels:
    pause: pause
    mirror: qlander-state
```

### `queue.admission`

What a PR needs, on its current head, before the ready label admits it.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.admission.fastLane` | mapping | required | The PR check that must pass on the PR's head. See [queue.admission.fastLane](#queueadmissionfastlane). |
| `queue.admission.review` | mapping | required | An optional machine-checked review of the PR's head. See [queue.admission.review](#queueadmissionreview). |

### `queue.admission.fastLane`

The PR check that must pass on the PR's head.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.admission.fastLane.workflow` | [workflow path](#formats) | required | The target workflow file that runs the fast lane. |
| `queue.admission.fastLane.event` | string | required | The event that run must be for. |
| `queue.admission.fastLane.job` | string | required | The job that must succeed, named exactly as GitHub shows it. |

```yaml
queue:
  admission:
    fastLane:
      workflow: .github/workflows/ci.yml
      event: pull_request
      job: fast
```

### `queue.admission.review`

An optional machine-checked review of the PR's head.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.admission.review.required` | boolean | required | Require the review producer to vouch for the PR's head. False: a write-access account applying ready is trusted to have reviewed it. |
| `queue.admission.review.producerLogins` | list of strings | required | Logins whose ready label counts as the review producer's. |
| `queue.admission.review.producer` | mapping | required | Who vouches for a reviewed head: a workflow run on main (job@main) or a dedicated App's check run (app-check). See [queue.admission.review.producer (adapter job@main)](#queueadmissionreviewproducer-adapter-jobmain) and [queue.admission.review.producer (adapter app-check)](#queueadmissionreviewproducer-adapter-app-check). |

```yaml
queue:
  admission:
    review:
      required: false
      producerLogins:
        - github-actions[bot]
```

### `queue.admission.review.producer` (adapter `job@main`)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.admission.review.producer.adapter` | `job@main` | required | job@main: a workflow run of main's revision judges the PR head. |
| `queue.admission.review.producer.workflow` | [workflow path](#formats) | required | The review workflow on main. |
| `queue.admission.review.producer.events` | list of strings | required | The events its run may be for: workflow_run or workflow_dispatch. |
| `queue.admission.review.producer.jobTemplate` | string | required | The job name that vouches, with {sha} replaced by the PR head. |
| `queue.admission.review.producer.runNameTemplate` | string | required | The run name, with {sha} replaced by the PR head. |
| `queue.admission.review.producer.searchPages` | integer | required | How many pages of the workflow's runs on main to search for the review run. |

```yaml
queue:
  admission:
    review:
      producer:
        adapter: job@main
        workflow: .github/workflows/review.yml
        events:
          - workflow_run
          - workflow_dispatch
        jobTemplate: "Reviewed {sha}"
        runNameTemplate: "Review {sha}"
        searchPages: 10
```

### `queue.admission.review.producer` (adapter `app-check`)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.admission.review.producer.adapter` | `app-check` | required | app-check: a check run from a dedicated App. |
| `queue.admission.review.producer.appId` | integer | required | The App's id. Its check run on the PR head must succeed. |
| `queue.admission.review.producer.name` | string | required | The check run's name. |

```yaml
queue:
  admission:
    review:
      producer:
        adapter: app-check
        appId: 123456
        name: review
```

### `queue.policy`

The CI-policy boundary: which changes land alone, with an approval bound to their SHA from an account listed in approvers.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.policy.paths` | list of strings | required | Globs of target paths that define or implement the CI gates. A PR touching any of them is a CI-policy PR. Must cover .github/workflows, .github/actions and every gate file. |
| `queue.policy.shareBatch` | mapping | none | Let consecutive approved CI-policy PRs share a batch, never with other PRs. See [queue.policy.shareBatch](#queuepolicysharebatch). |
| `queue.policy.trustedAutomations` | list of mappings | none | Bot accounts whose PRs may land without a CI-policy approval when they change only their listed paths. See [queue.policy.trustedAutomations[]](#queuepolicytrustedautomations). |
| `queue.policy.approvers` | list of mappings | required | Accounts whose /qlander approve-policy comment counts. See [queue.policy.approvers[]](#queuepolicyapprovers). |

```yaml
queue:
  policy:
    paths:
      - .github/**
      - Makefile
      - go.sum
```

### `queue.policy.shareBatch`

Let consecutive approved CI-policy PRs share a batch, never with other PRs. Absent: each CI-policy PR runs alone. Policy when set.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.policy.shareBatch.max` | integer | required | The most CI-policy PRs in one shared batch. At most queue.batch.max. At least 2. |

```yaml
queue:
  policy:
    shareBatch:
      max: 3
```

### `queue.policy.trustedAutomations[]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.policy.trustedAutomations[].login` | string | required | The bot's login, including [bot]. |
| `queue.policy.trustedAutomations[].id` | integer | required | The bot's account id. |
| `queue.policy.trustedAutomations[].paths` | list of strings | required | The paths it may change. * matches within one segment. Never **, never under .github, and never a gate file. |

```yaml
queue:
  policy:
    trustedAutomations:
      - login: deps-bot[bot]
        id: 4242
        paths:
          - go.sum
```

### `queue.policy.approvers[]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.policy.approvers[].login` | string | required | The approver's login. Login and id must both match. |
| `queue.policy.approvers[].id` | integer | required | The approver's account id. |

```yaml
queue:
  policy:
    approvers:
      - login: alice
        id: 1001
      - login: bob
        id: 1002
```

### `queue.preLanding[]`

One required workflow, in the format of a qualification manifest's required entries, without why.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.preLanding[].path` | [workflow path](#formats) | required | The workflow file. |
| `queue.preLanding[].name` | string | required | The workflow's name, used in messages. |
| `queue.preLanding[].when` | string | required | always: a run must exist. if_triggered: no run is fine, but a run that exists must pass. Values: `always`, `if_triggered`. |
| `queue.preLanding[].required_jobs` | list of strings | required | Job names that must appear in the run. Every job in the run must succeed, listed or not. |
| `queue.preLanding[].allow_skipped_jobs` | mapping | required | Job names that may be skipped, each with the reason. Only these may be skipped. |

```yaml
queue:
  preLanding:
    - path: .github/workflows/ci.yml
      name: CI
      when: always
      required_jobs:
        - vet
        - "compile (linux)"
        - "compile (darwin)"
      allow_skipped_jobs:
        pr-gate: "pull-request only"
```

### `queue.batch`

How fresh batches are sized, and when they are built.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.batch.min` | integer | required | The smallest a fresh batch's size limit shrinks to after reds in a row. |
| `queue.batch.max` | integer | required | The largest fresh batch, unless queue.strategy.adaptive grows the limit. The limit halves after each red in a row. |
| `queue.batch.minFill` | integer | required | Build a fresh batch once this many PRs are admitted. At most max. |
| `queue.batch.maxWaitMinutes` | integer | required | Or build it once the oldest admitted PR has waited this long. |
| `queue.batch.maxSplitDepth` | integer | required | How many times a red batch is halved. Past it, each PR is tested alone. At least 0. |
| `queue.batch.breakerBounces` | integer | required | Pause after this many bounces in a row without a landing. |

```yaml
queue:
  batch:
    min: 2
    max: 8
    minFill: 4
    maxWaitMinutes: 5
    maxSplitDepth: 2
    breakerBounces: 3
```

### `queue.budget`

CI budgets. Every build, rebuild and rerun reserves from both before it starts.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.budget.lineage` | integer | required | The most runs one batch and its splits may use. Past it, their PRs lose ready. |
| `queue.budget.window` | integer | required | The most runs in any windowHours. Reaching it pauses the queue. |
| `queue.budget.windowHours` | integer | required | The rolling window's length, in hours. |

```yaml
queue:
  budget:
    lineage: 20
    window: 60
    windowHours: 24
```

### `queue.timeouts`

Time limits on CI runs and on reconciling effects.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.timeouts.noRunMinutes` | integer | required | A when: always preLanding workflow with no run this long after the queue branch was pushed pauses the queue as a configuration problem. In a batch with a CI-policy PR it counts as red instead. |
| `queue.timeouts.inProgressMinutes` | integer | required | A job running longer than this is cancelled as a timeout. In a run GitHub already reports completed, a job still shown running this long pauses the queue as a configuration problem. |
| `queue.timeouts.queuedHours` | integer | required | A run attempt older than this with no job running is cancelled as starved. |
| `queue.timeouts.rerunBarrierMinutes` | integer | required | How long to wait for a rerun to show its new attempt before pausing. |
| `queue.timeouts.reconcileMinutes` | integer | required | How long an unconfirmed effect, such as a rerun request, is reconciled before it pauses. At least twice runner.cronMinutes. |
| `queue.timeouts.cancelWindowMinutes` | integer | required | After a batch is abandoned, keep looking for its runs to cancel for at least this long. |
| `queue.timeouts.cancelGiveUpHours` | integer | required | Pause if an abandoned batch's runs are still running this long after it was abandoned. |
| `queue.timeouts.maxOpTries` | integer | required | Recovery retries outstanding work at most this many times before pausing. |

```yaml
queue:
  timeouts:
    noRunMinutes: 15
    inProgressMinutes: 150
    queuedHours: 6
    rerunBarrierMinutes: 60
    reconcileMinutes: 30
    cancelWindowMinutes: 30
    cancelGiveUpHours: 6
    maxOpTries: 3
```

### `queue.verify`

Checking that landed PRs are marked merged.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `queue.verify.ticks` | integer | required | Ticks to wait, and at least 15 minutes, before commenting that GitHub has not marked a landed PR merged. |
| `queue.verify.days` | integer | required | Stop checking a landed PR after this many days. |

```yaml
queue:
  verify:
    ticks: 2
    days: 5
```

## `release`

Release advance: move the target's release branch to qualified main commits, by fast-forwarding it (mode advance) or by dispatching the target's own release workflow (mode dispatch). A separate job, with its own App, lease, state branch and pause. Not policy, except branch, stateBranch and labels.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.branch` | [branch](#formats) | required | The target branch that release advance fast-forwards. |
| `release.stateBranch` | [branch](#formats) | required | The control-repo branch that holds the release job's state.json. |
| `release.labels` | mapping | required | Labels on control-repo issues. See [release.labels](#releaselabels). |
| `release.enabled` | boolean | `false` | Run release advance. False: the release job reads and writes nothing. |
| `release.dryRun` | boolean | required | Read and decide, but write nothing. The release job acts only when this is false and QLANDER_MODE is live. |
| `release.maxCandidates` | integer | required | How many of main's newest first-parent commits are examined. If none of them qualifies and older ones remain, a release-blocked issue says so. |
| `release.historyLimit` | integer | required | Release receipts kept in the release state. |
| `release.qualification` | mapping | required | How a main commit is proved qualified. See [release.qualification](#releasequalification). |
| `release.mode` | string | `advance` | advance: the release job fast-forwards release itself. dispatch: it never writes release; it dispatches the target's own release workflow, first as a dry run and then, once an approver approves that exact sha, for real, and counts release as advanced only when it sees the ref there. Values: `advance`, `dispatch`. |
| `release.dispatch` | mapping | none | The dispatch mode's settings. See [release.dispatch](#releasedispatch). |

```yaml
release:
  branch: release
  stateBranch: qlander-release-state
  enabled: true
  dryRun: true
  maxCandidates: 20
  historyLimit: 100
  mode: dispatch
```

### `release.labels`

Labels on control-repo issues.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.labels.pause` | [label](#formats) | required | An open issue with this label pauses the release job only. |
| `release.labels.alert` | [label](#formats) | required | Labels the release-blocked issue, opened in some cases where release cannot advance, such as a diverged release. It pauses nothing. |
| `release.labels.mirror` | [label](#formats) | required | Labels the issue that mirrors the release state for people. Qlander reads it only to refuse to start from empty when the release state branch is missing. |

```yaml
release:
  labels:
    pause: release-pause
    alert: release-blocked
    mirror: qlander-release-state
```

### `release.qualification`

How a main commit is proved qualified. Only the selected provider's block may be present.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.qualification.provider` | string | required | manifest: a qualification manifest that qlander re-evaluates. checks-green: the listed workflows are all green on the commit. commit-status: a status from a listed creator. Values: `manifest`, `checks-green`, `commit-status`. |
| `release.qualification.manifest` | mapping | none | The manifest provider's settings. See [release.qualification.manifest](#releasequalificationmanifest). |
| `release.qualification.checksGreen` | mapping | none | The checks-green provider's settings. See [release.qualification.checksGreen](#releasequalificationchecksgreen). |
| `release.qualification.commitStatus` | mapping | none | The commit-status provider's settings. See [release.qualification.commitStatus](#releasequalificationcommitstatus). |

```yaml
release:
  qualification:
    provider: manifest
```

### `release.qualification.manifest`

The manifest provider's settings.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.qualification.manifest.source` | string | `target` | Where the manifest is read: target (the target's main, through the contents API) or control (this repo's checkout). Values: `target`, `control`. |
| `release.qualification.manifest.path` | string | required | The manifest's path: a canonical relative path, with no empty, . or .. segments, no leading / and no %, ? or #. |
| `release.qualification.manifest.proof` | mapping | none | Also require a proof chain: a status whose target URL is a successful proof run on main for the commit. See [release.qualification.manifest.proof](#releasequalificationmanifestproof). |

```yaml
release:
  qualification:
    manifest:
      source: target
      path: .github/qualification.json
```

### `release.qualification.manifest.proof`

Also require a proof chain: a status whose target URL is a successful proof run on main for the commit.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.qualification.manifest.proof.statusContext` | string | required | The status that points at the proof run. |
| `release.qualification.manifest.proof.workflow` | [workflow path](#formats) | required | The proof workflow on main. |
| `release.qualification.manifest.proof.events` | list of strings | `[workflow_run, workflow_dispatch]` | The events the proof run may be for. Only events that run main's own code; a pull request run is never proof. Values: `workflow_run`, `workflow_dispatch`, `push`, `schedule`. |
| `release.qualification.manifest.proof.jobTemplate` | string | `Qualified {sha}` | The proof job's name, with {sha} replaced by the candidate. |

```yaml
release:
  qualification:
    manifest:
      proof:
        statusContext: qualified
        workflow: .github/workflows/proof.yml
        events:
          - workflow_run
        jobTemplate: "Qualified {sha}"
```

### `release.qualification.checksGreen`

The checks-green provider's settings. Absent block: required is a copy of queue.preLanding.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.qualification.checksGreen.required` | list of mappings | required | The workflows that must all pass on a main push run for the commit. See [release.qualification.checksGreen.required[]](#releasequalificationchecksgreenrequired). |

### `release.qualification.checksGreen.required[]`

One required workflow, in the format of a qualification manifest's required entries, without why.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.qualification.checksGreen.required[].path` | [workflow path](#formats) | required | The workflow file. |
| `release.qualification.checksGreen.required[].name` | string | required | The workflow's name, used in messages. |
| `release.qualification.checksGreen.required[].when` | string | required | always: a run must exist. if_triggered: no run is fine, but a run that exists must pass. Values: `always`, `if_triggered`. |
| `release.qualification.checksGreen.required[].required_jobs` | list of strings | required | Job names that must appear in the run. Every job in the run must succeed, listed or not. |
| `release.qualification.checksGreen.required[].allow_skipped_jobs` | mapping | required | Job names that may be skipped, each with the reason. Only these may be skipped. |

```yaml
release:
  qualification:
    checksGreen:
      required:
        - path: .github/workflows/ci.yml
          name: CI
          when: always
          required_jobs:
            - test
          allow_skipped_jobs:
            pr-gate: "pull-request only"
```

### `release.qualification.commitStatus`

The commit-status provider's settings. The weakest provider, unless proof is set.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.qualification.commitStatus.context` | string | required | The status name that must be success. |
| `release.qualification.commitStatus.creators` | list of integers | required | Account ids (users or App bots) whose status counts. |
| `release.qualification.commitStatus.producerWorkflow` | [workflow path](#formats) | none | The workflow that posts the status. Required when creators includes github-actions[bot]. |
| `release.qualification.commitStatus.targetUrl` | string | none | actions-run: the status's target_url must be an Actions run in the target repo. Values: `actions-run`. |
| `release.qualification.commitStatus.proof` | mapping | none | Also require a proof run, as for the manifest provider. See [release.qualification.commitStatus.proof](#releasequalificationcommitstatusproof). |

```yaml
release:
  qualification:
    commitStatus:
      context: qualified
      creators:
        - 41898282
      producerWorkflow: .github/workflows/release-gate.yml
      targetUrl: actions-run
```

### `release.qualification.commitStatus.proof`

Also require a proof run, as for the manifest provider.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.qualification.commitStatus.proof.workflow` | [workflow path](#formats) | required | The proof workflow on main. |
| `release.qualification.commitStatus.proof.events` | list of strings | `[workflow_run, workflow_dispatch]` | The events the proof run may be for. Only events that run main's own code; a pull request run is never proof. Values: `workflow_run`, `workflow_dispatch`, `push`, `schedule`. |
| `release.qualification.commitStatus.proof.jobTemplate` | string | `Qualified {sha}` | The proof job's name, with {sha} replaced by the candidate. |

```yaml
release:
  qualification:
    commitStatus:
      proof:
        workflow: .github/workflows/proof.yml
        events:
          - workflow_run
        jobTemplate: "Qualified {sha}"
```

### `release.dispatch`

The dispatch mode's settings. Required when mode is dispatch, refused otherwise.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.dispatch.workflow` | [workflow path](#formats) | required | The target workflow that promotes a commit and moves release itself. It must have a workflow_dispatch trigger with the three inputs below, and a run-name that contains the dispatch id input. |
| `release.dispatch.ref` | [branch](#formats) | none | The branch the workflow is dispatched on, whose copy of the workflow file runs: the target's main or release.branch. Absent: the target's main. |
| `release.dispatch.inputs` | mapping | required | The workflow_dispatch input names qlander sets. See [release.dispatch.inputs](#releasedispatchinputs). |
| `release.dispatch.actor` | mapping | required | The release App's bot account: a dispatched run counts only if GitHub reports it as both the run's actor and its triggering actor. See [release.dispatch.actor](#releasedispatchactor). |
| `release.dispatch.promoterApps` | list of integers | none | The App ids of the identity the target's promote workflow uses to move release. setup makes them, and named users, the only bypass actors on the release-landing ruleset; audit fails any other (a role, a team, another App, the release App). Absent: none. Never the GitHub Actions App (15368), which any workflow can use. |
| `release.dispatch.approvers` | list of mappings | required | Accounts whose /qlander approve-release comment on the status issue counts. See [release.dispatch.approvers[]](#releasedispatchapprovers). |
| `release.dispatch.dryRunValidMinutes` | integer | `1440` | How long a green dry run stays good for its real run. Past it, that commit is not released, and a newer one gets its own dry run. |
| `release.dispatch.appearMinutes` | integer | `30` | How long after a dispatch its run may take to appear. At least twice runner.cronMinutes. |
| `release.dispatch.runHours` | integer | `6` | How long a dispatched run may run before qlander stops waiting for it. |
| `release.dispatch.observeMinutes` | integer | `60` | How long after a green real run release may take to reach the commit before a release-blocked issue says it did not. |
| `release.dispatch.budget` | mapping | none | At most window dispatches, dry and real together, in any windowHours. See [release.dispatch.budget](#releasedispatchbudget). |
| `release.dispatch.freeze` | list of mappings | none | Target repository variables that stop new dispatches while any of them equals its value. See [release.dispatch.freeze[]](#releasedispatchfreeze). |

```yaml
release:
  dispatch:
    workflow: .github/workflows/promote.yml
    ref: main
    promoterApps:
      - 424242
    dryRunValidMinutes: 1440
    appearMinutes: 30
    runHours: 6
    observeMinutes: 60
```

### `release.dispatch.inputs`

The workflow_dispatch input names qlander sets.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.dispatch.inputs.sha` | string | required | Gets the candidate commit's full sha. |
| `release.dispatch.inputs.dryRun` | string | required | Gets "true" for the dry run and "false" for the real one. |
| `release.dispatch.inputs.dispatchId` | string | required | Gets a unique id per dispatch. The workflow's run-name must contain it, which is how qlander finds the run it started. |

```yaml
release:
  dispatch:
    inputs:
      sha: sha
      dryRun: dry_run
      dispatchId: dispatch_id
```

### `release.dispatch.actor`

The release App's bot account: a dispatched run counts only if GitHub reports it as both the run's actor and its triggering actor. audit checks it against the release App.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.dispatch.actor.login` | string | required | The bot's login, <app slug>[bot]. |
| `release.dispatch.actor.id` | integer | required | The bot account's id (not the App id): gh api 'users/<slug>[bot]' --jq .id. |

```yaml
release:
  dispatch:
    actor:
      login: acme-release[bot]
      id: 90000001
```

### `release.dispatch.approvers[]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.dispatch.approvers[].login` | string | required | The approver's login. |
| `release.dispatch.approvers[].id` | integer | required | The approver's account id. |

```yaml
release:
  dispatch:
    approvers:
      - login: alice
        id: 1001
```

### `release.dispatch.budget`

At most window dispatches, dry and real together, in any windowHours. Absent: 8 in 24 hours.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.dispatch.budget.window` | integer | required | Dispatches allowed in the window. |
| `release.dispatch.budget.windowHours` | integer | required | The window's length in hours. |

```yaml
release:
  dispatch:
    budget:
      window: 8
      windowHours: 24
```

### `release.dispatch.freeze[]`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `release.dispatch.freeze[].variable` | string | required | The repository variable's name. |
| `release.dispatch.freeze[].value` | string | required | The value that means frozen, compared exactly. |

```yaml
release:
  dispatch:
    freeze:
      - variable: RELEASE_FREEZE
        value: "true"
```

## `watchdog`

The watchdog's issues in the control repo.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `watchdog.labels` | mapping | required | Labels on control-repo issues. See [watchdog.labels](#watchdoglabels). |

### `watchdog.labels`

Labels on control-repo issues.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `watchdog.labels.alert` | [label](#formats) | required | Labels the open alert issues, one per alert kind. |
| `watchdog.labels.status` | [label](#formats) | required | Labels the pinned status issue. |

```yaml
watchdog:
  labels:
    alert: qlander-alert
    status: qlander-status
```

## `hooks[]`

One hook: the events it sends, and the event_type they are sent as. Not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `hooks[].events` | list of strings | required | The lifecycle events to send. Values: `admitted`, `dequeued`, `batch_started`, `landed`, `bounced`, `flaky`, `approval_needed`, `budget_warning`. |
| `hooks[].eventType` | string | required | The repository_dispatch event_type: letters, digits and _ . : -, at most 100 characters. |

```yaml
hooks:
  - events:
      - landed
      - bounced
    eventType: qlander
```

## `tokens`

The environment variables the tick workflow puts each App's installation token in. Absent: every key at its default. Wiring, not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `tokens.queue` | [variable name](#formats) | `TARGET_TOKEN` | The queue App's token. |
| `tokens.release` | [variable name](#formats) | `TARGET_RELEASE_TOKEN` | The release App's token. |

```yaml
tokens:
  queue: TARGET_TOKEN
  release: TARGET_RELEASE_TOKEN
```

## `bundle`

Run a pinned release instead of the control repo's own source. .github/qlander-release.txt pins the release and its sha256. Absent: source mode. Wiring, not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `bundle.repo` | [owner/name](#formats) | required | The repo whose releases hold the bundle. After changing it, run `render`: it also updates the download in `ci.yml` and `verify-sandbox.yml`. |
| `bundle.private` | boolean | `false` | Download through the API with the job's own token, which reads only the control repo, so repo must be the control repo. False: an anonymous download of a public release. |
| `bundle.watchdog` | boolean | `true` | Run the bundle in watchdog.yml too. False keeps the watchdog on the source in its checkout, so a broken release cannot also silence the alarm. |

```yaml
bundle:
  repo: example/qlander
  private: false
  watchdog: false
```

## `notify`

Who to tell when the queue stops. Not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `notify.assignees` | list of strings | `[]` | GitHub logins assigned to each pause issue the queue or release job opens and each watchdog alert. An assignee hears through GitHub's notifications, as their own settings allow, whether or not they watch the repo. If GitHub refuses the list, the issue still opens, with nobody assigned. Issues people open themselves, such as a quiesce's, are not assigned. Upgrade to a release that knows this key before adding it: an older release refuses the whole file. |

```yaml
notify:
  assignees:
    - alice
```

## `comments`

PR comments to leave out. Not policy.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `comments.omit` | list of strings | `[]` | Progress comments to leave out: queued, landed or both. Comments that ask someone to act are always posted. Values: `queued`, `landed`. |

```yaml
comments:
  omit:
    - queued
```

## Formats

| Type | Format |
| --- | --- |
| owner/name | owner/name, as GitHub spells it. |
| branch | A branch name: components of letters, digits, _ and -, joined by . or /, with no leading, trailing or doubled separator. |
| branch prefix | A branch-name prefix ending in /; <prefix><n> names batch n. |
| label | A GitHub label name: at most 50 characters, no spaces. |
| workflow path | A workflow file under .github/workflows/. |
| variable name | An environment variable name. |
