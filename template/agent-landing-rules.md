# Agent rules for landing PRs

Copy everything under the line below into your target repo's agent instructions, for example its `AGENTS.md`. First replace `<fast check>` with the job named in `queue.admission.fastLane`, and `<control repo>` with `<owner>/<target>-qlander`. If `queue.labels` renames a label, use your names for `ready` and the `qlander:` labels. Delete the priority line if you don't set `queue.labels.priority`, and add your review step if you set `queue.admission.review.required`.

---

## Landing PRs

Only the qlander queue moves `main`. It tests ready PRs together and lands them once the full suite passes.

- **Never merge by hand.** No `gh pr merge`, no `--admin`, no push to `main`, even if every check is green and your account has bypass rights.
- **Qualify the PR.** It targets `main` from a branch in this repo, not a fork or a draft, has no conflicts, and every commit is signed and verified. Run the tests your change touches first, because a full-suite failure delays other PRs.
- **To land:** finish pushing, wait for `<fast check>` to pass on the current head, then add `ready`. Adding it needs write access. If `<fast check>` is red when `ready` goes on, or goes red after, qlander leaves `ready` on and comments once per head after 30 minutes.
- **Don't add `ready` until the head is final.** The label isn't tied to a commit. Before qlander admits the PR, a push changes what would land and `ready` stays on, so the new head is admitted as soon as `<fast check>` passes on it. After admission, qlander has pinned the head: a push takes the PR out of the queue and removes `ready`, and it has to qualify again. A push just before landing can miss: the pinned head lands without your later commits, and qlander comments to say so.
- **Check that it landed.** Normally GitHub marks the PR merged and qlander removes `ready`, and qlander comments if the PR lands any other way. A missing `ready` alone doesn't mean it landed.
- **After a bounce or removal,** read qlander's comment and fix the cause. A green rerun of the same head isn't a fix. Then push, wait for `<fast check>` on the new head, and add `ready` again. If a person took the PR out, ask them first.
- **Don't remove someone else's `ready`.** That takes their PR out of the queue.
- **Use `/qlander` commands and operator labels only on your own PRs.** The labels are `qlander:bounce`, `qlander:solo`, `qlander:unsolo` and `qlander:go`. Qlander checks only for write access, so this rule is yours to keep.
- **Use the priority label only when a person asks.** It puts your PR ahead of all waiting work, and can stop a running batch if preemption is on.
- **Leave CI-policy approval to a person.** Unless a configured trusted-automation waiver covers it, a PR that touches a path in `queue.policy.paths` lands only after an approver posts `/qlander approve-policy <head sha>`. Don't post it, and finish your pushes first, because a push needs a new approval.
- **Don't try to unpause the queue.** If an open pause issue in `<control repo>` is holding your PR, report its link and stop. Don't close it.
