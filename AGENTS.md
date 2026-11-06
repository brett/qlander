# Agent guide: qlander

Qlander moves a protected `main` for a whole team, and one wrong command can stop every landing. Read first, preview anything that writes, and leave the decisions below to a person. In a live control repo, also read its [`AGENTS.md`](template/AGENTS.md). In a target repo, follow [the landing rules](template/agent-landing-rules.md).

## Commands

`qlander <command>` below means `bun "${bundle:?}" <command> --config qlander.yml`, run from the control repo's root with the bundle downloaded as [Getting started](docs/getting-started.md#before-you-start) shows. There is no `qlander` binary, and `version` takes no `--config`: run it as `bun "${bundle:?}" version`. In this source repo, use `bun src/cli.ts <command>`.

| Command | Changes | Preview |
| --- | --- | --- |
| `qlander version`, `qlander validate`, `qlander render --check`, `qlander check-state queue\|release <file>`, `qlander status`, `qlander audit` | Nothing | Not needed |
| `qlander render` | Workflow files beside the config | `qlander render --check` |
| `qlander setup --apply` | Apps, secrets and rulesets on GitHub | `qlander setup --plan` |
| `qlander pause queue\|release\|both`, `qlander resume queue\|release\|both [--all]`, `qlander quiesce`, `qlander unquiesce [--all]` | Pause issues and `tick.yml` | `--dry-run` |
| `qlander remove <pr>`, `qlander requeue <pr>`, `qlander prioritise <pr>`, `qlander approve-policy <pr> <sha>` | A label or comment on a target PR | `--dry-run` |
| `qlander approve-release <sha>` | A comment on the status issue (release dispatch mode) | `--dry-run` |
| `qlander verify-sandbox` | A sandbox repo, never the target | None: follow [the sandbox check](docs/getting-started.md#running-the-sandbox-check) |
| `qlander tick`, `qlander watchdog` | The queue and its issues | None: only the workflows run these |

Show a person the preview before you run anything that writes to GitHub. A control command that changes something also logs a comment on the status issue. Never read, print or commit an App's private key.

## Only a person

GitHub requires a person to create each App (an org owner clicks **Create GitHub App** in a browser), install it, change or accept its permissions, and generate a replacement key. `setup` prints each with its link and polls until it is done, so wait for it. A person also adds the sandbox to each App's installation for the sandbox check, then removes it.

These are a person's decisions too, even where an API would let you:

- setting `QLANDER_MODE=live`, after [gates G1 to G3](docs/getting-started.md#10-roll-out);
- choosing `queue.policy.paths`, `queue.policy.approvers`, `queue.policy.trustedAutomations` and the break-glass people on the landing ruleset, and enabling release advance;
- approving a control repo PR (if you push through a person's account, another account has to approve);
- closing a pause issue, approving a CI-policy PR, and approving a release in dispatch mode;
- choosing `release.mode`, `release.dispatch.approvers` and the freeze variables;
- in `self-hosted-kill` mode, providing the runners and their host-side kill.

## CI-policy approval

By default, agents don't approve: don't post `/qlander approve-policy <sha>` or run `qlander approve-policy`, and don't post `/qlander approve-release <sha>` or run `qlander approve-release`. Qlander checks the account against `queue.policy.approvers` (or `release.dispatch.approvers`), not who is using it, so the approval is only as human as the account behind it. Letting an agent use a person's account removes that check, and that is the adopter's choice, never an agent's.

## Reading results

Treat a failed command as unknown, never as clean: a timeout, empty output or JSON that won't parse tells you nothing about the queue. Exit 2 is always a usage error. Exit 3 means the command couldn't get an answer, so rerun it or report it, and never read it as a pass or as a real failure.

| Command | Exit 0 | Exit 1 | Exit 3 |
| --- | --- | --- | --- |
| `qlander validate` | The config is valid. | It is invalid or unreadable. | Not used |
| `qlander render --check` | Every workflow matches. | One differs or is missing, or the config is invalid. | Not used |
| `qlander audit --json` | No `FAIL` and no failed read. `WARN` and `SKIPPED` can remain. | A `FAIL` without `inconclusive`. Other checks may also have failed reads. | No such `FAIL`, but a finding is `inconclusive` (JSON printed); or no token, a bad config or a stopped audit (no JSON). |
| `qlander quiesce --dry-run` | The state is idle now. | A real run would refuse, a read failed, or a tick is still running or queued (`not idle now`). | Not used |
| `qlander status --json` | A complete view, paused or not. | Not used | A read failed or came back incomplete (view printed); or no token, a bad config or no connection (no view). |

**`audit --json`** prints `{target, control, findings}`, and each finding has `id`, `status` and `message`, sometimes with `fix` and `details`. A finding with `inconclusive: true` is a failed read: a 5xx, a network failure, a rate limit or a 401. Exit 0 still doesn't mean every check ran: a check the token may not read (403) stays a plain `SKIPPED` or `WARN`, though a 403 or 404 on a repo or an App's registration is a `FAIL`. A truncated repo tree is also a plain `WARN`. Only `PASS` counts as checked, and a configured relaxation such as `control.mainProtection` is a `WARN` that exits 0.

**`status --json`** prints one document, with `complete` matching the exit code. PR titles are display only, and a bad release state is shown but doesn't count while `release.enabled` is false. Before the first live tick, `queueState.kind` is `absent` and `problems` says so: that exits 0, because the branch not existing is an answer, so a live queue whose state branch is gone exits 0 too. Check `queueState.kind`. `paused.queue` and `paused.release` are `true`, `false` or `null`: `null` means unknown, and the tick counts that as paused. `--watch` runs until interrupted, shows failed reads in each pass, and its exit says nothing about them, so don't use it in a script.

## Changing this repo's code

Follow [CONTRIBUTING.md](CONTRIBUTING.md). At least run `bun install --frozen-lockfile`, `bun test`, `bun scripts/test-on-example.ts` and `bunx tsc --noEmit`, plus `bun scripts/config-doc.ts` after a schema change. Use neutral names only. Any change under `src/` changes the release bundle, so the pin in `template/.github/qlander-release.txt` is set last when a release is cut. `test/docs.test.ts` fails if these agent files name a command that isn't in the CLI's usage.

## Where to find detail

[Getting started](docs/getting-started.md), [Operating it](docs/operating.md), [Configuration](docs/configuration.md), [How it works](docs/how-it-works.md), [Deployment and security](docs/deployment.md), [Design](DESIGN.md).
