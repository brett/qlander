# Operating qlander

Start at the pinned **qlander status** issue in the control repo.

| You see | Go to |
| --- | --- |
| An open `pause` issue | [Pause and resume](#pause-and-resume) |
| An open `release-pause` issue | [The release job's pause](#the-release-jobs-pause) |
| A `qlander alert: <kind>` issue | [Alert issues](#alert-issues) |
| A PR dropped from the queue, or commented on | [Bouncing, isolating and landing PRs](#bouncing-isolating-and-landing-prs), [PR comments](#pr-comments) |
| A need for the live queue state | [Watching the queue](#watching-the-queue), [Inspecting state](#inspecting-state) |
| A batch still pending long after its CI run finished | [A job still running after its run finished](#a-job-still-running-after-its-run-finished) |
| A need to rename the control repo, an App or a label | [Renaming the control repo, an App or a label](#renaming-the-control-repo-an-app-or-a-label) |

In the commands, `$R` is the control repo, as `owner/name`.

## Pause and resume

The queue is paused while any issue labelled `pause` is open in the control repo.

- **To pause:** open an issue with the `pause` label. The title and body are for people.
- **To resume:** close every open `pause` issue. Read each one first: closing it doesn't fix its cause.

A paused queue lands, builds and reruns nothing. It still finishes verifying PRs that already landed, and still cancels CI for batches it abandoned.

Qlander opens a `pause` issue itself when it stops for a reason that needs a person. The issue says why. Common reasons:

| The pause issue says | What it means | What to do |
| --- | --- | --- |
| `corrupt state` or `refusing to initialise` | The state branch doesn't parse, or it is missing while a state issue still holds state. | Inspect both ([below](#inspecting-state)) before you do anything. |
| `configuration problem` | A required CI job was skipped, missing or never ran on a queue branch, often after a `ci.yml` change. | Fix the target's CI, or `queue.preLanding` in `qlander.yml`. |
| `main is red` | The single PR under test failed only jobs that also fail on `main`. | Fix `main` first. |
| `not signed and verified` | A merge commit (or, in linear mode, a stack commit) the App made isn't verified, so `main` would reject it. | Check the App and the signing rules. |
| `could not settle its PR branches` | Linear mode: for `queue.timeouts.reconcileMinutes`, the landing did not complete and qlander's write moving its PR branches back has been refused. The landing's journal is kept. | Check `main`: if it is at the batch's head, the next tick records the landing. If not, find why the write was refused, usually a new rule on a PR branch or on `main`, then close the issue. Qlander moves the branches back itself and resends. |
| `window budget` | The queue used `queue.budget.window` CI runs within `queue.budget.windowHours` hours. | Check `main` and CI: usually one is broken for queue branches. |
| `bounces in a row` | `queue.batch.breakerBounces` PRs bounced in a row without a landing. | Check `main` and CI: usually one is broken for queue branches. |
| `not confirmed`, `no longer exist` or `still running` | A rerun or cancellation couldn't be reconciled. | Look at the named runs. |
| `stopped on an auth error` | Usually an App permission or an installation is missing. | Check the App's permissions and installations. |

With linear landing, a landing that stops part way can leave a PR branch at its squashed commit with `main` unmoved. Qlander moves it back on the next tick and lands again. While the queue is paused it writes nothing, so the branch stays there until the pause closes, and each tick's log names it (DESIGN.md §7.4).

### A failed read counts as paused

The queue treats itself as paused whenever it can't read the `pause` issues or can't list them completely. It opens a pause, release-pause, release-blocked or mirror issue only if two complete listings both lack it, so a short read can't open a duplicate. See [DESIGN.md, Operator surface](../DESIGN.md#10-operator-surface).

### The release job's pause

An open issue labelled `release-pause` stops release advance only. The queue's `pause` doesn't stop the release job. The rules for reading `release-pause` are the same as for `pause`.

The release job opens a `release-pause` itself when:

- its state is corrupt;
- its state branch is missing while its mirror issue is open;
- a release update was rejected while `release` was unchanged;
- in [dispatch mode](how-it-works.md#dispatch-mode-opt-in), a real run it dispatched did not end green with `release` at the commit: it failed, was cancelled, never appeared, never finished, was rerun by someone else, ended green without moving `release`, or failed after moving it. The pause names the sha, the run, its conclusion and where `release` is. Production may have changed: check the promotion and the target workflow's runs, and close the pause only when you know what happened. Closing it resumes the release job toward the newest qualified commit; to try the same commit again, re-arm it (below).

While paused, a dispatch-mode release job dispatches nothing, but still follows a run already in flight and records how it ended.

In some other cases, such as a diverged `release`, the job raises a `release-blocked` issue instead, which pauses nothing. [How it works](how-it-works.md#release-advance) lists them.

## Bouncing, isolating and landing PRs

Operator commands are labels on the target PR. Qlander reads them on every tick, applies them in the order they were added, and removes each label once applied. Label names are examples, set in [`queue.labels`](configuration.md#queuelabels).

- A label stays until it is applied, so no command is lost, however many arrive while a tick runs.
- Only a label added by someone with write access to the target counts. Qlander checks that when the tick applies it, and removes and ignores anyone else's command label.
- To act before the next scheduled tick, go to Actions, then **tick**, then **Run workflow**. It takes no inputs, and only wakes the queue tick.

| To | Do this | Notes |
| --- | --- | --- |
| Bounce a PR | Add `qlander:bounce`. | Removes `ready` and comments. If the PR was in the active batch, the batch is rebuilt without it. Removing `ready` by hand has the same effect on the next tick. |
| Test a PR on its own | Add `qlander:solo`. Add `qlander:unsolo` to undo it. | Its place doesn't change. Apply it to a PR that already has `ready`: the mark is cleared once the PR merges, closes or loses `ready`. |
| Build the next batch without waiting for it to fill | Add `qlander:go` to any PR. | |
| Land a PR without the queue | There is no such command. | Every landing goes through the full suite. In an emergency, a break-glass human with a ruleset bypass can merge in the GitHub UI. Qlander sees `main` move and rebuilds whatever it was testing, at the cost of one CI run. |

### The priority lane (opt-in)

With [`queue.labels.priority`](configuration.md#queuelabels) set, add that label to a PR to land it ahead of the rest. Once admitted, the PR goes before everything waiting, split halves included, and its batch builds at once.

- **Who.** The label counts only when its latest application is by someone with write access. It never counts from a bot, not even a trusted automation.
- **Its batch.** That batch holds only prioritised PRs, under the usual solo rules. A waived PR still runs alone. A CI-policy PR runs alone, or with other prioritised approved CI-policy PRs under `queue.policy.shareBatch`.
- **No gate is skipped.** The PR still needs its fast lane, review and signed commits. A CI-policy change still needs its approval, unless a trusted bot's waiver covers it. It runs the full suite, and is bounced as usual if it fails.
- **The running batch.** By default it is left alone, so priority builds right after that batch lands or fails. With `queue.concurrency` and a free slot, it builds alongside the running batch at once.
- **Preemption.** With `queue.priority.preempt: true`, a running batch whose CI is still pending is stopped instead. Its runs are cancelled, and its PRs are retested right after the priority batch, in the same order. This happens at most once per batch, and never while it is landing. The stopped run still counts against both budgets, and the retest costs another run.
- **Undoing it.** Removing the label returns the PR to its place. The PR's queued and landing comments say who prioritised it.
- **It stays on.** Qlander never removes the priority label, not when the PR lands and not when it is bounced. If a bounced PR gets `ready` again with the label still on, it goes first again, so remove the label unless it should.

Use it for a fix that must land now: `main` is red, a security advisory, a deploy blocker. Don't use it to shorten the wait for routine work: every use pushes every other PR back by a batch, and every preemption also costs a full-suite run. See [DESIGN.md, Order](../DESIGN.md#44-order).

## The command line

Run `bun "${bundle:?}" <command> --config qlander.yml` from the control repo's root, with the bundle downloaded as [Getting started](getting-started.md#before-you-start) shows. With the bundle, pass `--config qlander.yml` to every command except `version`, which takes no arguments. The examples below leave it out.

| Command | What it does |
| --- | --- |
| `tick queue\|release [--config <file>]` | One tick of that job: what `tick.yml` runs. |
| `watchdog [--config <file>]` | One watchdog run: what `watchdog.yml` runs. |
| `check-state queue\|release <file> [--config <file>]` | Whether this version reads a state document (a copy of a state branch's `state.json`), and whether it would write it back unchanged or changed. It writes nothing, and exits 0 either way. Exits 1 if it refuses the document, as a tick would. |
| `version` | Prints this version. |
| `validate [--config <file>]` | Checks a config and prints every problem. Exits 1 if it is invalid. |
| `render [--check] [--config <file>]` | Writes the workflows under the config file's directory. With `--check` it writes nothing, and exits 1 if a checked-in one differs. |
| `status [--json] [--watch <seconds>] [--config <file>]` | Shows the live queue, read-only. Exits 3 if a read failed. See [Watching the queue](#watching-the-queue). |
| `audit [--target-only\|--control-only] [--json] [--queue-app <slug>] [--release-app <slug>] [--state-app <slug>] [--config <file>]` | Checks the target's CI requirements and the control repo's protection, read-only. Exits 1 on a `FAIL` that a failed read didn't cause, else 3 if a read failed. See [Getting started, step 9](getting-started.md#9-prepare-the-target). |
| `setup …` | Creates and checks the Apps, installations and repo settings. See [Getting started](getting-started.md#let-setup-do-most-of-it). |
| `verify-sandbox <phase> …` | Runs rollout gate G1 against a sandbox repo. See [Getting started, Running G1](getting-started.md#running-the-sandbox-check). |
| `pause`, `resume`, `remove`, `requeue`, `prioritise`, `approve-policy`, `approve-release`, `rearm-release`, `quiesce`, `unquiesce` | Control commands. See [below](#controlling-the-queue-from-the-command-line). |

Without `--config`, the bundle looks for `qlander.yml` relative to where the bundle file is, not in the control repo. Only in source mode (`bun src/cli.ts`) does `--config` default to the control repo's own `qlander.yml`, next to the source. The tick and the watchdog always read their own checkout's file.

### Watching the queue

`status` prints one read-only view of a live queue, from a checkout of the control repo:

```sh
GH_TOKEN=$(gh auth token) bun "${bundle:?}" status                # once, as text
GH_TOKEN=$(gh auth token) bun "${bundle:?}" status --watch 30     # re-read and redraw every 30 s (at least 10)
GH_TOKEN=$(gh auth token) bun "${bundle:?}" status --json         # the same view as JSON (one line per pass under --watch)
```

**The token** comes from `GH_TOKEN`, else `GITHUB_TOKEN`. It needs read access only:

- the control repo's contents (the state branches), issues and Actions;
- the target's Actions and pull requests.

A `gh auth token` with access to both repos works. The command makes only GET requests and GraphQL queries (POSTs to `/graphql`, none a mutation). It never prints the token.

Every field comes from the state branches or the Actions and issues APIs, never from the mirror issues or PR comments. A read that fails is listed under **could not check** (`problems` in `--json`), and is never shown as a clean state.

**The exit code** is 0 for a complete view, paused or not. PR titles are display only and don't count. It is 3 if another read failed or came back incomplete, with the view still printed, and also for no token, a bad config or no connection, with no view. It is 2 for a usage error. A state branch that doesn't exist exits 0, because it is an answer: `problems` still names it, and a tick hasn't run live yet or the branch was lost. `--watch` keeps going through failed reads and runs until interrupted, so its exit says nothing about them.

### Controlling the queue from the command line

The control commands act through pause issues, PR labels, the approval comment and `tick.yml`. They use your own token, from `GH_TOKEN` or `GITHUB_TOKEN`, and need no App and no new permission.

- The repos, labels and branches come from the config (`--config <file>`).
- Each takes `--dry-run`, which reads what the command would check, prints every step, and changes nothing.
- Every control that changes something is logged as a comment on the watchdog's status issue.

```sh
export GH_TOKEN=$(gh auth token)
bun "${bundle:?}" pause queue|release|both          # open the pause issue(s)
bun "${bundle:?}" resume queue|release|both [--all] # close the ones a control opened (--all: every one)
bun "${bundle:?}" remove 123                        # the bounce label
bun "${bundle:?}" requeue 123                       # the ready label
bun "${bundle:?}" prioritise 123                    # the priority label (when queue.labels.priority is set)
bun "${bundle:?}" approve-policy 123 <40-hex head>  # the CI-policy approval, as an approver, for the PR's current head only
bun "${bundle:?}" approve-release <40-hex sha>      # the release approval (dispatch mode), as a release approver, for the current candidate only
bun "${bundle:?}" rearm-release <40-hex sha>        # one more release attempt for the last sha dispatched, after its attempt ended
bun "${bundle:?}" quiesce                           # stop both jobs safely (below)
bun "${bundle:?}" unquiesce [--all]                 # and start them again
```

#### `quiesce`

`quiesce` stops both jobs safely, as one command. It is the [quiesce procedure](deployment.md#81-rules-for-every-upgrade) for upgrades.

1. It refuses, changing nothing, while a batch is active, running or pending, or a PR waits to run alone. A paused queue never lands those. It also refuses, changing nothing, for anything else step 4 would refuse, except the lease and journal of a tick still running, which it waits for.
2. It opens its own `pause` and `release-pause` issues, beside any pause already open, and disables `tick.yml`.
3. It waits until two reads in a row find no tick run in progress or queued. A ghost run, queued with no jobs, counts as gone.
4. It reads both state branches again, and refuses, naming each, unless both are idle or fine to be missing (below). Idle means no journal, active or concurrent batch, pending, solo, verify, outbox, lease or pending release pause.
5. It ends by printing both state commits, for rollback.

A missing queue state branch is fine: a queue no live tick has run has nothing in flight. A missing release state branch is fine while the release job makes no writes (`release.enabled` is false or `release.dryRun` is true). In either case, it isn't fine if:

- its state issue is open, or can't be listed;
- the branch was there when the command started.

When a branch is fine to be missing, `quiesce` prints `(absent: no live tick has written state)` or `(absent: release job has never written state)` in place of that commit.

**When it refuses for the state:**

- **At step 1,** nothing has changed and ticks keep running, so wait and run it again. Verifying a landed PR or delivering a notice takes a tick or two.
- **A `cancelRuns` entry** is left by a batch that was abandoned or stopped. It stays for at least `queue.timeouts.cancelWindowMinutes` (30 in the template), to catch runs that appear late, and it can't be cleared sooner. The refusal prints the time. A tick has to run after that time, so dispatch one if the cron is late. If no runs were ever seen on that branch, the entry stays until the later time printed (`queue.timeouts.cancelGiveUpHours`).
- **On a busy queue,** run `pause both` first. It stops new batches, and so new entries, while ticks still clear the old ones. `resume both` lifts that pause.
- **At step 4,** nothing runs to clear the state, so run `unquiesce` to go back, then wait.

**With `--dry-run`** it exits 0 only if the state is idle now and no tick run is in progress or queued. It exits 1 if a real run would refuse at the first step, or if it reads a running tick or anything else not idle (`not idle now`). A real run would wait for that tick.

#### `unquiesce`

1. It refuses, changing nothing, if a pause issue that `quiesce` didn't open is open, including one from `pause`, because that's someone's deliberate pause. `--all` closes those too. A control's marker identifies who opened an issue only by its text, so don't hand-write it in an issue.
2. It re-enables `tick.yml`, waits a few seconds, dispatches a tick, and checks that it ran paused.
3. It closes the pause issues, the release pause first.
4. It dispatches one live tick, and checks that it succeeded.

It refuses if more than one new dispatched run appears, since GitHub doesn't say which run a dispatch started. Any check that fails stops the command with the reason and the way out, and leaves things as they are. If a check fails before the pause issues are closed, run `unquiesce` again once you know why. The message says how to reopen the queue without the check, and it names `resume both` only if no one else's pause is open, since `resume both` would close that too.

In dry-run mode (`QLANDER_MODE` unset) the two ticks are dry runs. A dry-run tick reports whether it found a pause or would raise one, and `unquiesce` reads that: `outcome: paused`, then `outcome: dry-run`.

## Inspecting state

The stores of record are the two state branches:

```sh
git fetch origin qlander-state qlander-release-state
git show origin/qlander-state:state.json           # the queue's current state
git show origin/qlander-release-state:state.json   # the release job's current state
git log --oneline origin/qlander-state             # one commit per state change: the audit log
```

The issues labelled `qlander-state` and `qlander-release-state` are readable copies, rewritten after each tick. Qlander makes no decision from them, and reads them only to refuse to start from empty when a state branch is missing.

Each tick's job log prints its outcome and decisions. A dry run prints the operation it would perform next. PR comments record every queue event.

## Runbooks

### Restarting a runner host's controller

In `self-hosted-kill` mode, both jobs rely on the host killing a VM at `runner.hostKillMinutes`, and the release job ignores the queue's `pause` issue. So stop both:

```sh
# 1. Pause both jobs: the queue (pause) and the release job (release-pause).
gh issue create -R "$R" --label pause --title "pause: CI controller restart" --body "Controller restart; close after it is back."
gh issue create -R "$R" --label release-pause --title "release pause: CI controller restart" --body "Controller restart; close after it is back."
# 2. Stop new jobs: a paused tick still runs (verification, recovery), so disable the workflow too.
gh workflow disable tick.yml -R "$R"
# 3. Confirm both jobs' executors have finished: no run in progress or queued ...
gh run list -R "$R" --workflow tick.yml --status in_progress   # must print nothing
gh run list -R "$R" --workflow tick.yml --status queued        # must print nothing
# ... and each state branch's lease is null, or names a job GitHub reports completed.
for b in qlander-state qlander-release-state; do
  gh api "repos/$R/contents/state.json?ref=$b" --jq .content | base64 -d | jq -c '.lease'
done
gh api "repos/$R/actions/runs/<runId>/attempts/<attempt>/jobs" --jq '.jobs[] | {name, status}'   # for each non-null lease.executor
```

Restart the controller only when both checks pass. Afterwards, re-enable the workflow (`gh workflow enable tick.yml -R "$R"`) and close **both** pause issues (`pause` and `release-pause`) to resume both jobs.

VMs the controller adopts after a restart may be bounded only later than either job's takeover window: see [DESIGN.md, Documented residual risks](../DESIGN.md#151-documented-residual-risks). `bun "${bundle:?}" quiesce` runs steps 1 to 3 and the state check as [one command](#quiesce).

Qlander's own PR CI and the watchdog run on GitHub-hosted runners, never on these pools.

### A job still running after its run finished

GitHub sometimes reports a job as `in_progress` after its workflow run has completed: the job's `status` isn't `completed`, but it already has a `conclusion` and a `completed_at`. Qlander counts a job as done only when its `status` says so, so the batch stays pending. Once the job is past its time limit (`timeouts.inProgressMinutes`, or `queuedHours` for a job still queued), qlander pauses the queue with the reason `CI run <id> completed, but job '<name>' still shows <status> past its time limit` and puts the batch back. Versions before 0.2.3 wait with no limit.

From 0.2.3, check the run as below, then close the pause issue: the batch's PRs kept `ready` and their place, and the next batch runs on a new CI run. On earlier versions, or if a batch shows a job still running long after its run finished, look at the run's jobs:

```sh
gh api "repos/<target>/actions/runs/<run id>/jobs" --jq '.jobs[] | {name, status, conclusion, completed_at}'
```

If a job has a `conclusion` and a `completed_at` but its `status` isn't `completed`, bounce one PR in the batch: add `qlander:bounce`, run `remove <pr>`, or remove `ready`. The batch is abandoned, and any other PRs in it are rebuilt on a new CI run.

1. Wait for a tick to take the PR out: `status --json` no longer lists it, and the bounce label, if you used one, is gone. Adding `ready` back sooner can leave its admission, and the stuck batch, in place.
2. Add `ready` back to it (`requeue <pr>`). Its fast lane must still be green on the same head.
3. Check the batch's other PRs. If its retry budget had run out, they lose `ready` instead of being rebuilt, so add it back to each.

### Renaming the control repo, an App or a label

Rename with nothing admitted and both jobs stopped. GitHub redirects an old repo name for git and REST, but qlander refuses redirects, so anything that still uses an old name fails at its first request, before it reads or writes. A half-done rename stops the queue, and it never writes under the wrong name.

| You rename | What uses the old name |
| --- | --- |
| The control repo | `control.repo`, which is in the policy hash. The rendered `tick.yml`, which mints the state App's token for that repo name. `setup`, whose default App prefix is the control repo's name, and `audit`, whose default App slugs are `<control repo name>-queue`, `-release` and `-state`. In `self-hosted-kill` mode, the runner group's workflow restriction. |
| An App | Its slug: `audit`'s default slugs, and `setup`, which finds each App and its key (`<keys-dir>/<slug>.pem`, or `--key-cmd` run with the slug) by `<prefix>-queue`, `-release` and `-state`. So rename all the Apps to one new prefix, or `setup` can't find them. The App id, client id, installations and keys stay the same, so the tick and the ruleset bypasses keep working. |
| A label | Its name in `qlander.yml` (`queue.labels`, `queue.controlLabels`, `release.labels`, `watchdog.labels`), most of which are in the policy hash. Qlander reads `ready`, each operator label and the priority label from the PR's latest `labeled` event with exactly that name, and a renamed label's old events keep the old name. The watchdog finds the status issue by its label. |

Renaming a GitHub App is done in a browser only: in the App's settings, on **General**, change **GitHub App name** and save. Its slug and its bot's login change.

1. **Let the queue empty.** Ask people to stop adding `ready`, and wait until `status --json` exits 0 with `active` null and `concurrent`, `pending`, `solo` and `queued` empty. `queued` lists the admitted PRs, which would all lose `ready` when the policy hash changes.
2. **Stop both jobs.** Run `quiesce`, then `status --json` again. `quiesce` doesn't check for admitted PRs, so if `queued` isn't empty, run `unquiesce`, wait, and start again.
3. **Stop the watchdog:** `gh workflow disable watchdog.yml -R "$R"`. A watchdog run that reads one label name while the issue has the other opens a second status issue. Disabling doesn't stop a run already started, so wait until `gh run list -R "$R" --workflow watchdog.yml --status in_progress` and `--status queued` both print nothing.
4. **Rename on GitHub.** The repo (`gh repo rename <new name> -R "$R"`), the labels on the target and the control repo (`gh label edit <old> --name <new>`), and the Apps. Environments, secrets, variables, rulesets and App installations survive a repo rename. To rename a state branch too, rename the branch first and then point its ruleset at the new name: GitHub refuses to rename a branch into a name a ruleset covers.
5. **Change the config to match.** Update `qlander.yml`, run `validate` and `render`, and merge both in one PR on the renamed repo. In `self-hosted-kill` mode, check that the runner group's workflow restriction names the new repo, and update it if it doesn't.
6. **Put labels back on.** On every open PR that had a renamed label, remove it and add it again. Until then, a renamed `ready` doesn't count, and a renamed operator or priority label does nothing.
7. **Fix your own copies.** Point your clone at the new name (`git remote set-url`). If the Apps were renamed, rename each key file or secret-store entry to the new slug. Unless the Apps' prefix is the control repo's new name, pass `--name <their prefix>` to `setup` and `--queue-app`, `--release-app` and `--state-app` to `audit`.
8. **Start again.** A workflow disabled by hand stays disabled through a rename and a merge, so enable the watchdog yourself: `gh workflow enable watchdog.yml -R "$R"`, then `gh workflow run watchdog.yml -R "$R"`, and check that there is still one status issue. Run `unquiesce`, which enables `tick.yml`, then `audit`.

## Monitoring

`.github/workflows/watchdog.yml` runs every 15 minutes, and on **Run workflow**. It runs on a GitHub-hosted runner (`ubuntu-latest`) so it keeps running when the CI hosts or the qlander pools are down.

- It holds no App key and uses no environment.
- Its `GITHUB_TOKEN` has `contents: read` (to check out the private control repo), `issues: write` and `actions: read`, on the control repo only.
- It reads `tick.yml`'s runs, jobs and job logs, plus the issues. Expect about 13 tick runs an hour while a batch is in flight.
- It writes only the two kinds of issue below, and never touches the target or the state branches.

### The status issue

There is one issue titled **qlander status**, labelled `qlander-status` and pinned at the top of the Issues tab. It's the one place to look. The watchdog rewrites its body on every run and never comments, so its runs make no notification noise. Each control command that changes something logs one comment here, which notifies anyone subscribed to the issue. In [dispatch mode](how-it-works.md#dispatch-mode-opt-in), the release job also comments once per release candidate whose dry run is green, and approvals are posted here (see [Approving a release](#approving-a-release-dispatch-mode)).

| Field | What it shows |
| --- | --- |
| Overall state | **OK**, **WARN** or **ALERT**, with the time and a link to the watchdog run. |
| Mode | Dry-run or live, from the `QLANDER_MODE` repo variable. The release job stays a dry run until `release.dryRun` in `qlander.yml` enables it. |
| Last 5 ticks | Each one's time, the queue job's result, the release job's result and a link. |
| Newest tick | From the job log: the log lines, cut at 12; what it would do (dry run) or its outcome (live); the PRs GitHub listed with `ready`; and, in full, every ready PR the tick did not admit, with the reason. If the token can't read job logs, a note replaces this section. No permission is added to fix it. |
| Queue and release state | Summarised from the mirror issues, which exist only once ticks run live. |
| Flaky tests | Failures in the last 7 days. Each flaky test has its own open issue, labelled `flaky`. |
| Hook deliveries | Those waiting, and a warning for any that failed in the last 24 hours ([Hooks](hooks.md#guarantees)). |
| Open issues | The open `pause`, `release-pause`, `release-blocked` and `qlander-alert` issues, with their ages. |

- **Duplicates.** The watchdog keeps the pinned issue, else the oldest, and closes any extra with a comment. It creates an issue only when two complete listings both find none. An incomplete or failed read creates nothing, and closes no extra status issue. It also unpins closed status and alert issues, so they give back their pin slots.
- **Pinning.** It pins the issue through the GraphQL `pinIssue` mutation. If `GITHUB_TOKEN` isn't allowed to pin, or the repo already has three pinned issues, the run doesn't fail. The body's footer says so instead, and someone pins the issue once by hand: open it, then **Pin issue**.

### Approving a release (dispatch mode)

With `release.mode: dispatch`, a commit is promoted only after a person approves it. When its dry run is green, the release job comments on the status issue with the sha, a link to the dry run and its jobs, and the exact line to post. To approve, one of `release.dispatch.approvers` posts a new comment whose whole body is that line:

```
/qlander approve-release <40-character sha>
```

or runs `approve-release <sha>`, which checks the same things first and posts it. Qlander ignores, and logs why, an approval that:

- names any other sha, including an older candidate's;
- comes from an account not listed in `release.dispatch.approvers` (login and id both checked);
- was edited, or was posted before the dry run was dispatched.

The approval counts for that sha only, and only within `release.dispatch.dryRunValidMinutes` of the green dry run. A newer qualified commit replaces a candidate that is still waiting, and gets its own dry run. Agents don't approve releases: the rule is the same as for [CI-policy approvals](../AGENTS.md#ci-policy-approval). `status` shows where the candidate is (`candidate <sha>: <stage>`).

**Re-arming a commit.** After an attempt ends without a release, that sha is not tried again on its own. To grant it exactly one more attempt, an approver posts on the status issue:

```
/qlander rearm-release <40-character sha> <incident>
```

where `<incident>` is the failed attempt's dispatch id, which the pause issue quotes in full; or runs `rearm-release <sha>`, which reads it from the release state and refuses unless that sha was the last one dispatched, its attempt has ended and no candidate is open. The re-armed attempt runs a fresh dry run and needs a fresh `approve-release` after it: the earlier approval no longer counts. It applies only while the sha is still the newest qualified commit; once a newer one qualifies, that one goes instead. A re-arm doesn't close a pause or clear a freeze, and one re-arm buys one attempt.

To stop new dispatches without pausing anything else, set one of `release.dispatch.freeze`'s target repository variables to its value. A run already started is still followed.

**With linear landing (`queue.landing.mode: linear`).** `release` only ever fast-forwards to `main` commits: `setup` restricts updates on it, so only the promote App and the break-glass people can move it, and there is no hotfix PR into `release`. Fix forward on `main` and promote that commit. If `release` diverges anyway (a break-glass push, or a promote workflow that committed on `release`), the release job stalls: it raises a `release-blocked` issue and dispatches nothing, because `main` can never take that commit back. To recover, fix forward on `main`, then move `release` back to the last commit qlander promoted (the latest `advanced` entry in the release state's history, checked to be an ancestor of `main`), after any promotion in flight has finished. That is a force push, which release-integrity forbids with no bypass, so a repository admin turns off its "Block force pushes" rule for the move, puts it back at once, and runs `audit` to confirm. Check what moving `release` does in the target first, since it may start workflows. Tooling for this recovery is planned.

### Alert issues

Each alert issue says what is wrong, whether PRs are still landing, and what to do.

| Alert | Fires when | What to do |
| --- | --- | --- |
| `ticks stopped` | No queue tick has finished in the last 30 minutes, or `tick.yml` has no runs. | Check the `qlander` runner pools, and whether `tick.yml` is enabled. A runner alert or a disabled-workflow alert usually fires alongside it. |
| `ticks failing` | The last 3 completed queue-tick jobs all failed. A timeout counts. The issue links the newest failed run. | Open the linked run. A failure at a token step usually means an App key or installation problem. A failure in the tick step is in qlander or GitHub. |
| `runner not picking up ticks` | A tick run or job has waited more than 20 minutes for a runner. A ghost run, queued with no jobs at all, is ignored once a newer tick has finished. Disabling and re-enabling `tick.yml` can leave one. | A tick is stuck waiting. Other ticks may still be running, so this doesn't by itself mean every pool is down. Check the runners and the controllers on their hosts. Read [Restarting a runner host's controller](#restarting-a-runner-hosts-controller) before you restart one. |
| `paused` | A `pause` or `release-pause` issue has been open for more than 2 hours. The issue shows the oldest one's title. | Read the pause issue and fix its cause (see [Pause and resume](#pause-and-resume)). Then close it. |
| `main is broken` | With `queue.strategy.mainBaseline` on: PRs are held because `main` fails the same tests with no PR in it. | Land a PR that fixes `main`. It isn't held, and the held PRs are then tested again. |
| `tick workflow disabled` | `tick.yml` is disabled, by hand or by GitHub. | If it was disabled on purpose, for a controller restart, finish that procedure. Otherwise run `gh workflow enable tick.yml -R "$R"`. |
| `config invalid` | `qlander.yml` does not load. Ticks fail until it is fixed. | Open the linked run for the exact error, fix `qlander.yml` on `main`, and merge the fix. |

- Each alert kind has at most one open issue, labelled `qlander-alert` and titled `qlander alert: <kind>`.
- The watchdog opens the issue when the condition starts, which notifies watchers. While the condition holds, it comments only when the detail changes materially, for example a different failing step, or another pause going overdue. When the condition clears, it closes the issue with a comment.
- Don't close an alert issue by hand to clear it: the watchdog opens a new one on its next run while the condition still holds. Fix the cause instead.
- If a check is undecidable on a run (a listing came back incomplete, a timestamp was invalid, or the job-read budget ran out), the status lists it under **Could not check**, and the alert issue is left exactly as it was. If the alert issues' own listing is incomplete, no alert issue is opened, commented on or closed that run. An incomplete pause listing never closes the `paused` alert, though an overdue pause it did see can still open or update it.

An open `release-blocked` issue, or a pause younger than 2 hours, makes the status **WARN** but opens no alert issue. A `release-blocked` issue notifies watchers when qlander opens it.

### Labels for monitoring

The watchdog labels must exist in the control repo: [`watchdog.labels`](configuration.md#watchdoglabels), for example `qlander-alert` and `qlander-status`. The tick also opens one issue per flaky test there, labelled `flaky`. To create them:

```sh
gh label create flaky -R "$R" --color FBCA04 --description "A test that failed in a qlander batch and passed on its rerun (one issue per test)"
gh label create qlander-alert -R "$R" --color B60205 --description "An open qlander watchdog alert (one issue per alert kind)"
gh label create qlander-status -R "$R" --color 0E8A16 --description "The pinned qlander status issue, rewritten by the watchdog"
```

### Getting notified

Set [`notify.assignees`](configuration.md#notify) to the people who should hear. An alert that `qlander.yml` is invalid can't read the setting, so it goes out unassigned.

**Upgrade first, then add the key.** A release that doesn't know `notify` refuses the whole file, and every tick then fails.

**With no assignees, only watchers hear.** A new pause issue reaches only people watching the repo, and the watchdog's own alert follows 2 hours later.

To watch the control repo, choose **Watch**, then **Custom**, then tick **Issues**, or choose **All Activity**. A new alert issue, and each comment on it, then reaches you by email or in the GitHub mobile app, depending on your notification settings.

Edits to the status issue's body never notify anyone, so open the pinned issue to see the current state. If the watchdog itself fails, its run shows a red cross in Actions, and GitHub emails whoever last changed its `cron`.

## PR comments

Qlander comments on a PR when something happens to it, and GitHub notifies everyone subscribed to the PR, usually its author.

These comments are always posted, and most ask someone to act:

- a bounce;
- "Not queued": a conflict, a PR that does not qualify, or, with linear landing, a PR carrying commits that already landed squashed. That last one must be rebased onto `main`, keeping only its own commits; the comment gives the command;
- With linear landing, a PR GitHub closed without the merged mark says its change is on `main` anyway;
- a removal from the queue: the head moved, the retry budget was used, or an operator bounced it;
- a PR kept in the queue because every failure is also main's (`queue.strategy.mainBaseline`);
- a landed revision with later commits that are not in `main`;
- a PR that GitHub has not marked merged;
- the notice that a batch was stopped for a prioritised PR;
- the notice on a ready PR that has waited 30 minutes for a CI-policy approval, for GitHub to compute mergeability, or with a red fast lane. It's posted once per head and reason.

Two comments only report progress: **queued** ("Queued in batch N at ...") and **landed** ("Landed in main at ..."). You can leave out either with [`comments.omit`](configuration.md#comments). The schema refuses any other value.

Leaving them out changes only who is notified. No decision reads a comment back. Each batch and landing is still recorded in the queue state's history, in each merge commit's message and in the lifecycle [hooks](hooks.md). A comment already waiting in the outbox when the setting changes is still posted. `comments` is not part of the policy hash, so changing it doesn't take `ready` off admitted PRs.
