# qlander control repo

This repo runs [qlander](https://github.com/brett/qlander), a merge queue for one GitHub repository (the **target**), on a cron. It never holds qlander's source: each tick downloads the pinned release and refuses to run it unless its sha256 matches the pin. Once running, the queue keeps its state on a branch of its own in this repo.

Create your control repo from this template (**Use this template**), as a **private** repo in the same owner as the target, because job logs and issues here show the target's PR numbers, branches and job names. `audit` fails if this repo is less restrictive than the target. Then follow the steps below. The [getting-started guide](https://github.com/brett/qlander/blob/main/docs/getting-started.md) has the detail behind each one.

Qlander itself is supported best effort. Report problems in [brett/qlander](https://github.com/brett/qlander/issues), not here: this repo's issues are the queue's controls.

## What is here

| File | What it is |
| --- | --- |
| `qlander.yml` | The configuration. You must set the values marked `CHANGE ME`. |
| `.github/qlander-release.txt` | The pinned release: `<version> <asset> <sha256>`. The sha256 is the trust root. |
| `.github/bun-release.txt` | The pinned Bun release the jobs run it with, in the same format. |
| `.github/workflows/tick.yml`, `watchdog.yml` | Rendered from `qlander.yml`. Never edit them by hand. |
| `.github/workflows/ci.yml` | PR checks: the config is valid, and the two workflows are exactly its rendering. |
| `.github/workflows/verify-sandbox.yml` | The rollout's sandbox check, run by hand. Not rendered. |
| `AGENTS.md` | For a coding agent working in this repo. |
| `agent-landing-rules.md` | Rules to copy into the target repo's agent instructions. |

## The first hour

### 1. Get the bundle

Every command below runs the pinned release with [Bun](https://bun.sh), at the version in `.github/bun-release.txt`. Install that version:

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v$(cut -d' ' -f1 .github/bun-release.txt)"
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Then download the release, and keep this shell open:

```sh
unset bundle
read -r v asset sum < .github/qlander-release.txt
dir="$(mktemp -d)"
curl -fsSL -o "$dir/$asset" "https://github.com/brett/qlander/releases/download/v$v/$asset" &&
  (cd "$dir" && echo "$sum  $asset" | sha256sum -c -) &&
  bundle="$dir/$asset"
bun "${bundle:?}" version
```

`bundle` is set only once the download's sha256 matches the pin, and every command uses `${bundle:?}`, so after a failed download or checksum each one stops before Bun runs. On a public release, also check its build provenance before you run it: `gh attestation verify "${bundle:?}" --repo brett/qlander`.

### 2. Configure and render

Edit `qlander.yml`: this repo and the target (names and ids), the target's fast-lane check and full-suite jobs, and the policy approvers. The template uses GitHub-hosted runners with the epoch fence (`runner.mode: hosted`). For the self-hosted mode, see [Provide the runners](https://github.com/brett/qlander/blob/main/docs/getting-started.md#6-provide-the-runners).

```sh
bun "${bundle:?}" validate --config qlander.yml
bun "${bundle:?}" render --config qlander.yml
```

Commit the config and the rendered workflows together, through a PR. The tick's repo guard is rendered from `control.repoId`, so every tick job is skipped until it names this repo.

### 3. Setup

Run `setup` on your own machine as an owner of both repos, never in Actions. It prints every change first and writes nothing without `--apply`.

```sh
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml --apply
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml --apply --step target --apply-target-rulesets
```

`setup` walks you through creating and installing the GitHub Apps (queue and state, plus release once release advance is enabled): GitHub makes a person click each step, so setup prints the link and waits. It then makes these match the config:

- this repo's environments and secrets, its `main` ruleset and the state-branch ruleset;
- the target's labels and, with `--apply-target-rulesets`, its landing, integrity and epoch rulesets.

[Getting started](https://github.com/brett/qlander/blob/main/docs/getting-started.md#let-setup-do-most-of-it) explains each step, the key handling and how to rerun one step.

### 4. Audit

`audit` checks the target's CI against what the queue needs, and checks this repo's protection. Fix every FAIL before you go on. Exit 3 means a read failed, so rerun it.

```sh
GH_TOKEN=$(gh auth token) bun "${bundle:?}" audit --config qlander.yml
```

### 5. Sandbox check

Run this before any tick touches your target. It proves on a scratch repo that the GitHub behaviour qlander relies on holds. It uses `.github/workflows/verify-sandbox.yml`. Follow [Running the sandbox check](https://github.com/brett/qlander/blob/main/docs/getting-started.md#running-the-sandbox-check).

### 6. Dry run

With the repository variable `QLANDER_MODE` unset, every tick is a dry run: it reads, decides, prints what it would do in the job log, and writes nothing. Let it run for a day against the target and compare its decisions with what you would have done.

### 7. Live

Set `QLANDER_MODE` to `live` (Settings, Secrets and variables, Actions, Variables). The queue acts from the next tick: label a PR whose fast lane is green with `ready` and it lands. Release advance stays off until a reviewed PR sets `release.enabled: true` and `release.dryRun: false`.

## Upgrading

1. Before 1.0, stop the queue first: `GH_TOKEN=$(gh auth token) bun "${bundle:?}" quiesce --config qlander.yml`. `unquiesce` starts it again afterwards.
2. Download the new release's `SHA256SUMS`, bundle and `qlander.schema.json`, and check them (`sha256sum -c SHA256SUMS`, and `gh attestation verify` on the bundle of a public release).
3. Write its pin line, which the release notes print, into `.github/qlander-release.txt`. Run its `render` and open the PR.

Before pinning an older release, run its `check-state` on a copy of each state branch's `state.json`: a release refuses state newer than it knows.
