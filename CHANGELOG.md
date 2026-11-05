# Changelog

## 0.2.2

Fixes from the first full end-to-end run of the queue, in a scratch organisation. State is unchanged, so this release reads what 0.2.1 and 0.1.0 wrote, and the policy hash is unchanged, so no admitted PR loses its place.

- `quiesce` works on a queue no live tick has run. A missing queue state branch has nothing in flight, so it quiesces cleanly, unless the queue's state issue is open or can't be listed, or the branch was there when the command started. Those still refuse.
- `unquiesce` works in dry-run mode. A dry-run tick's report now says whether it found a pause, and `unquiesce` checks that. The check on a live tick is unchanged.
- `quiesce` refuses before it changes anything for whatever would stop it later, including a landed PR being verified and an undelivered notice, so a queue isn't stopped when it can't finish. The check after the wait is unchanged.
- Refusals from `quiesce` and `unquiesce` name the way out: `resume both`, `unquiesce` or `pause both`, depending on how far the command got. A waiting `cancelRuns` entry shows when it can clear.
- `quiesce --dry-run` exits 1 when it prints `not idle now`.
- `audit` no longer asks for a restrict-updates rule on the release landing ruleset, which `setup` leaves out so that a person can merge a hotfix PR. If you added that rule to quiet `audit`, remove it, because it blocks that merge.
- Every download in a workflow retries a failed attempt, for up to about a minute, and is still checked against its sha256. The runner needs `curl` 7.71 or newer. Run `render` when you take this pin: until you do, `render --check` and `audit` C7 report the difference. The old workflows still run this release.
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
