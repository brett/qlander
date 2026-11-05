# Agent guide: this control repo

This repo runs qlander for one target repo, and its issues and state are the queue's live controls. Read before you act, and stop and report when you're unsure.

`qlander <command>` below means `bun "${bundle:?}" <command> --config qlander.yml`, run from this repo's root with the bundle downloaded as [README.md](README.md) shows and `GH_TOKEN=$(gh auth token)` set. There is no `qlander` binary.

The label names below are the defaults. The real ones are in `qlander.yml`: `queue.controlLabels.pause`, `release.labels.pause`, `release.labels.alert` and `watchdog.labels`.

## Check first

1. The pinned **qlander status** issue, labelled `qlander-status`. The watchdog rewrites it about every 15 minutes, so an old time means the watchdog may have stopped.
2. Open issues labelled `pause` or `release-pause`, then `release-blocked` and `qlander-alert`, for example `gh issue list --label pause --state open`. Read each body.
3. `qlander status --json`. Exit 0 is a complete view, paused or not, and exit 3 means a read failed or came back incomplete, so the view can't be trusted. A `queueState.kind` of `absent` also exits 0, which is normal only before the first live tick. In `paused.queue` and `paused.release`, `null` means unknown, and the tick counts that as paused.

Exit 3, or any other failed command or `gh` call, is unknown, never "no pause open". The queue itself counts a failed listing as paused.

## Stop and report

Don't try to fix these. Report the issue link, what it says and what you checked, then wait:

- an open `pause` or `release-pause` issue you weren't asked to handle;
- `corrupt state`, `refusing to initialise` or a missing state branch;
- a permission, installation or auth error;
- an open `qlander-alert` or `release-blocked` issue whose cause you can't show from its text and the linked run;
- a command that refuses or fails partway, or an exit 3 that a rerun doesn't clear.

Never close a pause issue, or run `qlander resume` or `qlander unquiesce`, without the person's say-so for that closure. Closing one doesn't fix its cause, and `--all` also closes pauses that people or the queue opened. Don't close an alert issue either: the watchdog reopens it while the condition holds.

Don't pause the queue unless asked, because it stops landings for everyone. Don't edit `tick.yml`, `watchdog.yml` or the state branches, change rulesets, or set `QLANDER_MODE`.

## Changing `qlander.yml`

Treat every config change as a policy change. Most keys are in the [policy hash](https://github.com/brett/qlander/blob/main/docs/deployment.md#82-the-policy-hash), so changing one makes every admitted PR lose `ready` at the next unpaused tick.

1. Edit the file, run `qlander validate` and `qlander render`, and put both in one PR. This repo's CI runs `render --check`.
2. A person reviews it, and merges it while nothing is admitted. Check just before the merge, because PRs can be admitted during review: in a `qlander status --json` that exits 0, `queueState.kind` is `ok`, `active` is null and `concurrent`, `pending`, `solo` and `queued` are empty.

A key the pinned release doesn't know makes every tick fail, so upgrade before you add one.

## Upgrades

Every upgrade goes through `quiesce`. Opening a pause issue alone isn't enough.

1. Run `qlander quiesce --dry-run` and read all of it. It exits 0 only if the state is idle and no tick is running now, and 1 if a real run would refuse or a tick is still running (`not idle now`).
2. With the person's go-ahead, run `qlander quiesce`. It refuses, changing nothing, while a batch is active or pending or the state has work left: try again later, and don't work around it. If it fails partway, some of its steps may have happened, so report its message, which names the way back and any pause it left alone, the open pause issues and the state of `tick.yml`.
3. Keep the two state commits it prints, for rollback.
4. Follow [Upgrading](README.md#upgrading) to open the PR with the new pin. A person reviews and merges it.
5. With the person's go-ahead, run `qlander unquiesce --dry-run`, then `qlander unquiesce`. It refuses while a pause that `quiesce` didn't open is open. Add `--all` only if they ask for it, because that lifts such a pause.

## CI-policy approval

By default, agents don't approve: don't post `/qlander approve-policy <sha>`, and don't run `qlander approve-policy`. The approval is only as human as the account behind it, and letting an agent use a person's account removes that human check. That is this repo's owner's choice to make, never an agent's.

## Where to find detail

[Operating it](https://github.com/brett/qlander/blob/main/docs/operating.md), [the agent guide, with exit codes](https://github.com/brett/qlander/blob/main/AGENTS.md#reading-results), [Configuration](https://github.com/brett/qlander/blob/main/docs/configuration.md). The landing rules for the target repo are in [agent-landing-rules.md](agent-landing-rules.md).
