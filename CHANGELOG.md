# Changelog

## Unreleased

- Release dispatch mode (`release.mode: dispatch`, opt-in). The release job never writes `release`: for the newest qualified `main` commit it dispatches the target's own release workflow as a dry run, reports a green one on the status issue, waits for `/qlander approve-release <sha>` from one of `release.dispatch.approvers`, then dispatches the real run, and counts release as advanced only when it sees the ref there. Each sha gets at most one dry run and one real run. Dispatches are journalled, never resent, budgeted, fenced, paused by `release-pause` and stopped by optional freeze variables. The release App needs Actions: write in this mode only (and Variables: read with a freeze): change its permissions before you switch. New command: `approve-release <sha>`. Advance mode, its state and the policy hash are unchanged; a dispatch-mode state has an extra `dispatch` field, which older releases refuse.

## 0.2.3

One fix and a documentation update. State is unchanged, so this release reads what 0.2.2 wrote, and the policy hash is unchanged, so no admitted PR loses its place.

- A batch no longer waits forever when GitHub reports its CI run `completed` but still lists one of its jobs as `in_progress` (or `queued`), even with that job's conclusion and `completed_at` set. Before, the in-progress timeout skipped completed runs, so the batch stayed pending until someone bounced the PR. Such a job still never counts as a pass. Once it is past `queue.timeouts.inProgressMinutes` from its own start, or the attempt is past the usual caps, the queue pauses with a configuration problem that names the run and the job, and the batch's PRs go back to the front of the queue with `ready` kept (or are parked, with `queue.strategy.reuseGreen`). Close the pause to carry on. A failure conclusion on such a job is still red at once.
- Docs: new runbooks for renaming the control repo, an App or a label, and for a job still running after its run finished; when ticks run, and why a new repo can go hours without a scheduled run; full command forms in both agent guides; the check before merging a config change accepts a queue state that is still `absent` before the first live tick; and a wording pass over the install and operating guides and the template.

## 0.2.2

Fixes from the first full end-to-end run of the queue, in a scratch organisation. State is unchanged, so this release reads what 0.2.1 and 0.1.0 wrote, and the policy hash is unchanged, so no admitted PR loses its place.

- `quiesce` works on a queue no live tick has run. A missing queue state branch has nothing in flight, so it quiesces cleanly, unless the queue's state issue is open or can't be listed, or the branch was there when the command started. Those still refuse.
- `unquiesce` works in dry-run mode. A dry-run tick's report now says whether it found a pause or would raise one, and `unquiesce` checks that. A live tick must still report success, and `unquiesce` now also refuses if that tick reopened a pause, left one pending in its state, or the check can't tell.
- `unquiesce` closes only the pauses `quiesce` opened. A pause from `pause` or by hand makes it refuse unless you close that pause or pass `--all`, and `quiesce` and `pause` each open their own issue beside the other's.
- `quiesce` refuses before it changes anything for whatever would stop it later, including a landed PR being verified and an undelivered notice, so a queue isn't stopped when it can't finish. The check after the wait is unchanged.
- Refusals from `quiesce` and `unquiesce` name the way out, going by what is true then: `resume both` or `unquiesce` only when every open pause is that run's own. A pause that was already there is named and left alone, and the message gives the issues to close instead. A waiting `cancelRuns` entry shows when it can clear.
- `quiesce --dry-run` also reads the tick runs, and exits 1 when it prints `not idle now`, as it does for a tick still running.
- `audit` no longer asks for a restrict-updates rule on the release landing ruleset, which `setup` leaves out so that a person can merge a hotfix PR. If you added that rule to quiet `audit`, remove it, because it blocks that merge. `audit` now requires every check `setup` puts on that ruleset, so a release ruleset missing one of the full suite's jobs fails where it used to pass.
- Every download in a workflow retries a failed attempt within a hard limit, 40 seconds for Bun and 20 for the bundle, and is still checked against its sha256. A stalled download fails the job, which leaves the tick's work inside the 5-minute job limit. The runner needs `curl` 7.71 or newer and `timeout`. Run `render` when you take this pin: until you do, `render --check` and `audit` C7 report the difference. The old workflows still run this release.
- A `ready` PR whose fast lane is red gets one comment per head after 30 minutes, instead of waiting silently.
- The landing rules now say that a push drops a PR only after admission. Before that, a push changes what would land and `ready` stays on, so don't add `ready` until the head is final.
- Wording: the "ticks stopped" and "runner stuck" alerts no longer assume your own CI hosts, the status issue names `release.dryRun`, the mirror issues say when they are read, and an admission's evidence no longer carries deployment-specific text. The docs now say when T0 and C0 print, and that control commands comment on the status issue.

## 0.2.1

Fixes for a first run of `setup` against real GitHub.

- `setup --step verify` no longer fails on a ruleset that works. It judged a refused state branch by GitHub's wording, and a real refusal can read `Reference update failed`. It now needs a 422, the branch still absent, and GitHub reporting that ruleset's creation rule on that branch name. A failed read of those rules fails the check.
- `setup --skip-audit` no longer reports a clean audit when none ran, or names a command that bundle users don't have.
- If a key is already saved for an App when its manifest code arrives, `setup` keeps that key and checks it, instead of failing.
- For when GitHub's new-App form comes up empty, `setup` also prints a pre-filled link for each App. A waiting `setup` notices the App and its key and carries on.
- The steps for a new private key use GitHub's current labels: **Credentials**, then **Key pairs**, then **New key**.

## 0.2.0

First public release.
