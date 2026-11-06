# Qlander and GitHub's merge queue

GitHub has a built-in [merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue). You can't use both: qlander's audit requires GitHub's merge queue to be off on `main`.

| | GitHub merge queue | qlander |
| --- | --- | --- |
| Where it is available | Public repos owned by an organization, and private repos on GitHub Enterprise Cloud. | Repos owned by an organization that has rulesets: public repos on any plan, private repos on GitHub Team or Enterprise Cloud. |
| CI builds | One `merge_group` build per queued PR. Each includes the PRs ahead of it. Up to 100 run at once. | One build per batch of PRs. With `queue.concurrency`, a few batches overlap. |
| A failing PR | Removed from the queue, and the PRs behind it are rebuilt without it. With "Only merge non-failing pull requests" off, it can still land in a group whose last PR passed. | The failed jobs are rerun once. Then the batch is split until the failing PR is found alone. |
| A CI timeout | Treated as a failure: the PR is removed. | A run past qlander's time limits is cancelled and rerun once, then the queue pauses. It never bounces a PR. A job that hits its own `timeout-minutes` still counts as a failure. |
| Jumping the queue | Rebuilds every pull request already in progress. | The opt-in priority lane waits for the running batch, unless a concurrency slot is free or you turn on preemption. |
| PRs that change CI | The docs describe no separate rule. | Need an approval bound to their SHA, unless a trusted bot's narrow waiver covers them. Land alone, or with other approved CI-policy PRs (opt-in). |
| Merge method | Merge, rebase or squash. | Merge commits, or with the opt-in linear landing one squashed commit per PR. No rebase. |
| How your CI is triggered | A `merge_group` event, or a push to `gh-readonly-queue/*` for other CI systems. | A `push` to the `queue/` branches. |
| Running it | Built into GitHub. | You run a control repo, a scheduled workflow and two Apps, or three with release advance. |

Sources: [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [About rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) and, for qlander, [How it works](how-it-works.md).
