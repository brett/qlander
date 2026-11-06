# Getting started

This guide sets up qlander for one repository, from nothing to live. An org admin does it once. Nothing lands until the [rollout](#10-roll-out) gates pass.

You end up with:

- a **control repo** that holds `qlander.yml`, the tick workflow, the App keys and the queue's state;
- **GitHub Apps**: queue and state, plus release once `release.enabled` is true. The [sandbox check](#running-the-sandbox-check) needs all three, so a full rollout creates all three;
- a **target** repo whose `main` only the queue App can move, apart from any person you name as a [break-glass bypass](#9-prepare-the-target) on its ruleset.

In the commands below, `$R` is the control repo, as `owner/name`. The [template repo](https://github.com/brett/qlander-template) README gives the same steps in short, with the release download.

## Before you start

You need an organization that owns the target repo, and these on your own machine:

- the [GitHub CLI](https://cli.github.com), signed in as an owner of the organization: run `gh auth login`, then `gh auth status`;
- `git`, `curl` and `sha256sum`.

Create the control repo from the template, under the target's owner, and clone it. Name it `<target>-qlander`, so `acme/widgets` gets `acme/widgets-qlander`: it sorts beside its target, and it leaves the name `qlander` free for a fork.

```sh
gh repo create <owner>/<target>-qlander --private --template brett/qlander-template --clone
cd <target>-qlander
```

A private control repo needs GitHub Team or Enterprise Cloud, because it uses environments and rulesets. Use `--public` only for a public target: `audit` check C6 fails unless the control repo is at least as restrictive as the target, because job logs and issues show PR numbers, branches and job names.

Install the Bun version the template pins:

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v$(cut -d' ' -f1 .github/bun-release.txt)"
export PATH="$HOME/.bun/bin:$PATH"
bun --version
```

Download the pinned release. Keep this shell open, because every command below uses `$bundle`:

```sh
unset bundle
read -r v asset sum < .github/qlander-release.txt
dir="$(mktemp -d)"
curl -fsSL -o "$dir/$asset" "https://github.com/brett/qlander/releases/download/v$v/$asset" &&
  (cd "$dir" && echo "$sum  $asset" | sha256sum -c -) &&
  bundle="$dir/$asset"
bun "${bundle:?}" version
```

`bundle` is set only once the download's sha256 matches the pin, so after a failed download or checksum every command stops before Bun runs. In a new shell, run this block again.

Run every command in this guide from the control repo's root. Edit the values marked `CHANGE ME` in `qlander.yml`, which the template ships. These commands find the numeric ids:

```sh
gh api repos/<owner>/<repo> --jq .id    # control.repoId and target.repoId
gh api users/<login> --jq .id           # each approver's id
```

Then render the workflows and commit both:

```sh
bun "${bundle:?}" validate --config qlander.yml
bun "${bundle:?}" render --config qlander.yml
```

To work on qlander itself, see [CONTRIBUTING.md](../CONTRIBUTING.md).

## Let `setup` do most of it

`setup` does steps 1, 2, 4 and 5 below, and creates the target's labels and rulesets. Run it on your own machine as an org owner, never in Actions. It reads your token from `GH_TOKEN`, or from `gh auth login`.

```sh
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml            # plan: prints every change, writes nothing
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml --apply    # apps, install, control, target, verify
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml --apply --step target --apply-target-rulesets
```

- **Steps.** Pick one with `--step apps|install|control|target|verify|permissions`. Each step rereads the config, GitHub and the key directory and changes only what differs, so you can rerun any step, and a second run changes nothing.
- **App names.** The Apps are `<prefix>-queue`, `<prefix>-state` and, with release advance, `<prefix>-release`. `--name` sets the prefix, which defaults to the control repo's name. GitHub limits an App's name to 34 characters, and setup refuses a longer one before it changes anything. Names must also be unique across GitHub, which setup can't check in advance. So the default prefix `<target>-qlander` fits only for a target name of up to 18 characters with release advance, or 20 without. For a longer or taken name, pass a shorter `--name` (at most 26 characters) on every `setup` run, and the matching `--queue-app`, `--release-app` and `--state-app` to a standalone `audit`.
- **Creating the Apps.** The `apps` step uses GitHub's manifest flow: it serves a local page and you click **Create GitHub App**. It then checks each App's permissions exactly against [the table in step 1](#1-create-the-github-apps).
- **If GitHub's form comes up empty.** Setup also prints a pre-filled link for each App. Open it, keep the name, check the permissions against the table in step 1 (GitHub can drop one from a link) and click **Create GitHub App**. Then, in the App's settings, click **Credentials**, then **Key pairs**, then **New key**, and save the download as `<keys-dir>/<slug>.pem`. A waiting setup notices the App and its key and carries on, or you can rerun it. If a permission is wrong, `apps` says which and sends you to `--step permissions`.
- **Keys.** `apps` writes each new App's key to `<keys-dir>/<slug>.pem`, with mode 0600, and never overwrites a key. It refuses a directory inside a git work tree, or one that group or others can read.
- **Your secret store.** Pass `--key-cmd '<command>'` to make later steps read keys from your secret store. It runs as `<command> <slug>`. Once `verify` passes, move the keys into that store and delete the directory.
- **A lost key** can't be recovered. `apps` prints where to generate a new one. Then run `--step control --rotate`.
- **Manual steps.** Only a person can create and install the Apps, change or accept permissions, and generate a replacement key. Setup prints each one with its exact link, then polls until GitHub shows it done.
- **Permission changes.** `--step permissions` walks you through one ([Deployment, section 5.3](deployment.md#53-changing-an-apps-permissions)).
- **Rulesets.** Setup refuses a ruleset that names an App as a bypass until that App is installed on the repo. The target's `main` and `release` landing and integrity rulesets need `--apply-target-rulesets`. Setup never removes classic branch protection; it prints the command instead.
- **Verify.** `verify` mints each App's token with exactly the permissions the tick requests, checks that your own token can't create a state branch, then runs `audit`. Add `--skip-audit` to leave the audit out until the target's CI is ready.

The steps below say what setup does and how to check it by hand. [Deployment, section 5](deployment.md#5-setup) has the full design.

## 1. Create the GitHub Apps

Setup creates the release App, and the `release-write` environment in step 2, only when `release.enabled` is true. The template starts with it false. None of the Apps needs a webhook or user authorisation.

| App | Repository permissions |
| --- | --- |
| queue App | Contents: write, Workflows: write, Pull requests: write, Actions: write, Checks: read, Commit statuses: read, Metadata: read |
| release App | Contents: write, Workflows: write, Actions: read, Checks: read, Commit statuses: read, Metadata: read |
| state App | Contents: write, Metadata: read |

1. Install the queue and release Apps on the target only.
2. Install the state App on **the control repo only**. It is the only identity that can move the two state branches.
3. Generate a private key for each App (in its settings, **Credentials**, then **Key pairs**, then **New key**), and note each App's client ID.

The state App can write nothing in the target, and the queue and release keys gain nothing in the control repo. The tick mints a short-lived installation token per job, with exactly these permissions, for the target only.

GitHub behaviour to expect:

- GitHub requires a homepage URL. Turn the webhook off, and subscribe to no events.
- GitHub drops some permission parameters from a pre-filled creation URL. Check each App's permissions against the table after you create it.
- A permission added to an existing App takes effect only once the org accepts it on each installation. Until then, new tokens don't have it.
- A ruleset can name an App as a bypass actor only once the App is installed on that repo. Install first, then edit the ruleset.
- A commit made through the contents API with a user token is unsigned (`verified: false`). It can't land on a branch that requires signatures.
- The queue App has no Issues permission, so the issues list endpoint (`/issues?labels=`) returns 403 for it. Qlander finds labelled PRs through `/pulls` instead. The per-PR issue endpoints for comments, labels and events work with the Pull requests permission.

To check the installed permissions, where `<org>` is the owner the Apps are installed in:

```sh
gh api orgs/<org>/installations --jq '.installations[] | {app_slug, app_id, permissions, events}'
```

## 2. Create the environments and secrets

Create two environments in the control repo, each with a deployment branch policy that names `main` alone.

| Environment | Secrets |
| --- | --- |
| `queue-write` | `QUEUE_APP_CLIENT_ID`, `QUEUE_APP_PRIVATE_KEY`, `STATE_APP_CLIENT_ID`, `STATE_APP_PRIVATE_KEY` |
| `release-write` | `RELEASE_APP_CLIENT_ID`, `RELEASE_APP_PRIVATE_KEY`, `STATE_APP_CLIENT_ID`, `STATE_APP_PRIVATE_KEY` |

Don't create repo-level or org-level secrets for the control repo. The App keys live only in these environment secrets.

To check:

```sh
for e in queue-write release-write; do
  gh api repos/$R/environments/$e/secrets --jq '[.secrets[].name]'
  gh api repos/$R/environments/$e/deployment-branch-policies --jq '[.branch_policies[].name]'   # ["main"]
done
gh api repos/$R/actions/secrets --jq .total_count   # 0
```

Each job of `tick.yml` uses one environment, so it sees only its own target App's key:

| Job | Environment | Token variables in the tick step |
| --- | --- | --- |
| `queue` (Queue tick) | `queue-write` | `tokens.queue` (the queue App's; default `TARGET_TOKEN`), `STATE_TOKEN` (the state App's), `GITHUB_TOKEN` |
| `release` (Release advance) | `release-write` | `tokens.release` (the release App's; default `TARGET_RELEASE_TOKEN`), `STATE_TOKEN` (the state App's), `GITHUB_TOKEN` |

The two token variable names come from [`tokens`](configuration.md#tokens) in `qlander.yml`. `tick.yml` is rendered from the same file ([step 7](#7-render-the-workflows)), so the two always agree. A job that can see the other App's target token refuses to start.

The workflow's own `GITHUB_TOKEN` writes issues only, never state. [Design, section 12](../DESIGN.md#12-apps-secrets-qlanders-own-protection) lists its scopes.

## 3. Leave `QLANDER_MODE` unset

The repository variable `QLANDER_MODE` decides whether ticks act, in both jobs. Leave it unset until [gate G4](#10-roll-out).

- **Unset, or anything other than `live`:** every tick is a dry run. It reads state and GitHub, decides, and prints what it would do in the job log. Its target client is read-only. It writes nothing anywhere: no lease, no state and no issue.
- **`live`:** the queue acts.

The release job also needs `release.enabled: true` and `release.dryRun: false` in `qlander.yml`. Make that a reviewed change, once the target's [release requirements](../DESIGN.md#13-target-side-requirements) hold. Until then the release job stays a dry run. With `release.enabled` absent or false, it reads and writes nothing.

`release.qualification.provider` chooses how a commit qualifies for release: `manifest`, `checks-green` or `commit-status`. The [qualification manifest spec](qualification-manifest.md) describes the format and the providers.

## 4. Protect the control repo's `main`

Create a ruleset on the control repo's `main`:

- a pull request is required, with 1 approving review from an account other than the PR's author;
- stale approvals are dismissed, and approval is required after the latest push;
- signed commits are required;
- force pushes and deletion are blocked;
- there are no bypass actors.

To declare a deliberately lighter rule, use `control.mainProtection` in `qlander.yml`. Each key is optional, and an absent key keeps the strict rule above:

```yaml
control:
  repo: owner/qlander
  repoId: 123
  mainProtection:
    requiredApprovals: 0
    dismissStaleReviews: false
    lastPushApproval: false
    signedCommits: false
```

`audit` then reports each relaxed parameter the ruleset lacks as a `WARN` naming the key, instead of a `FAIL`. `setup` stops adding those parameters and never removes them. You can't relax the pull request, the block on force pushes and deletion, or the absence of bypass actors. `mainProtection` doesn't change the policy hash.

If automation opens PRs through a person's account, that person can't approve them. Another account has to.

A one-person organization can't meet this. Set `requiredApprovals: 0` and `lastPushApproval: false` before `setup` writes the ruleset, or no control-repo PR can ever merge.

Also turn **off** "Allow GitHub Actions to create and approve pull requests" (Settings, Actions, General, Workflow permissions), and keep the org default off. With it on, a workflow in a PR could approve that PR as `github-actions[bot]`. Check it before you go live:

```sh
gh api repos/$R/actions/permissions/workflow   # can_approve_pull_request_reviews must be false
```

## 5. Protect the state branches

Qlander keeps each job's state as `state.json` in a commit on its own branch, and moves the branch only with a compare-and-swap. With the example names:

| Branch | Job | Mirror issue label |
| --- | --- | --- |
| `qlander-state` (`queue.stateBranch`) | queue | `qlander-state` (`queue.controlLabels.mirror`) |
| `qlander-release-state` (`release.stateBranch`) | release | `qlander-release-state` (`release.labels.mirror`) |

Protect **both** branches with a branch ruleset, either one that targets both names or one each. It must:

- restrict creation, update and deletion;
- block force pushes;
- have **only the state App** as a bypass actor.

Don't add GitHub Actions, any other App or any person as a bypass. Qlander's own CI never triggers on either branch.

To check, list the rules on each branch and the ruleset's bypass actors:

```sh
for b in qlander-state qlander-release-state; do
  gh api repos/$R/rules/branches/$b --jq '[.[].type] | sort'   # creation, deletion, non_fast_forward, update
done
gh api repos/$R/rulesets --jq '.[] | {id, name}'
gh api repos/$R/rulesets/<id> --jq '{include: .conditions.ref_name.include, bypass: .bypass_actors}'
# include names both branches; bypass is exactly one actor: the state App (actor_type Integration)
```

A dry run never creates a branch. A job's first live tick creates its own branch, unless something suggests state was lost:

- the queue refuses while an open issue with its mirror label holds state;
- the release job refuses while an issue with its mirror label is open.

Either refusal pauses that job instead of starting from empty. A dry run reports the same refusal.

## 6. Provide the runners

The tick jobs run where `runner.mode` says. Pick a mode, then meet its contract.

### Self-hosted runners (`self-hosted-kill`)

The tick runs on self-hosted runner pools labelled `qlander`. Put them in a runner group restricted to `<control repo>/.github/workflows/tick.yml@refs/heads/main`, and keep that workflow path. You can have several pools, for example one per CI host. A tick job goes to whichever is free.

- **One job at a time.** Each pool runs at most one job at a time.
- **A host-side kill.** The host destroys the VM at a fixed age, `runner.hostKillMinutes`, whatever the guest is doing. That kill is part of the [lease safety argument](deployment.md#32-mode-self-hosted-kill). `hostKillMinutes` must be at least `runner.jobTimeoutMinutes`.
- **Tools.** The runner image needs `curl` 7.71 or newer, `timeout`, `sha256sum` and `unzip`. Each tick downloads the Bun release named in `.github/bun-release.txt` into a fresh temp directory and refuses to run it unless the sha256 matches.
- **Restarts.** Pause both jobs before you restart whatever enforces the host kill. VMs it adopts after a restart may be bounded only later than either job's takeover window. The [runbook](operating.md#restarting-a-runner-hosts-controller) has the procedure.

With one pool, the queue and release jobs run one after the other. With several, they may run at the same time, which is safe because each job has its own lease and state branch.

Each job has its own concurrency group, so at most one of each runs and at most one of each is pending. Each is cut off at `runner.jobTimeoutMinutes`. The release job runs only on the schedule, never for a manual dispatch. A queue job waits behind at most one release job, so the release job can't starve the queue.

### Running on NixOS

The tick downloads a generic Linux build of Bun, which NixOS refuses to start ("Could not start dynamically linked executable") unless `programs.nix-ld.enable = true`. The job's `PATH` also needs `unzip`, `curl` and `sha256sum`.

For a self-hosted pool, this repo's flake has a module that sets them and meets the [contract](deployment.md#32-mode-self-hosted-kill) as far as one host can, which "What it doesn't cover" below spells out:

```nix
# inputs.qlander.url = "github:brett/qlander";
imports = [ inputs.qlander.nixosModules.runner ];

services.qlander-runner = {
  enable = true;
  repository = "your-org/your-repo-qlander";
  tokenFile = "/run/secrets/qlander-runner-token"; # outside the Nix store
  hostKillMinutes = 6; # runner.hostKillMinutes in qlander.yml
  qlanderConfig = inputs.control-repo + "/qlander.yml";
};
```

`qlander.yml` then has `mode: self-hosted-kill`, `epochFence: true`, `hostKillMinutes: 6` and `runsOn: [qlander]`. The system won't build if these disagree with the module, or if the module's bound is later than the config's. That check sees the copy the host was built with, so rebuild the host when you change the config. To raise the bound, change `qlander.yml` first; to lower it, change the host first. `audit` can't see the host, so nothing checks a running host against the config.

What the module does:

- **Runners.** The nixpkgs `github-runner` service, ephemeral, registered to `repository` with the token in `tokenFile`: a fine-grained token for that repo only, with the repository permission Administration: write. It is read again for every job, so a registration token, which expires after an hour, won't do.
- **Only the tick.** GitHub's workflow restriction exists for organisation runner groups, not for runners registered to a repo. A job-started hook does that job here: it kills the runner unless the job is `tick.yml` on `main`.
- **The kill.** A root unit watches each runner's cgroup. `hostKillMinutes` after a process other than the listener appears, it SIGKILLs the whole cgroup. The runner is bound to this unit, so stopping or crashing it kills the job, and no job outlives it. To stop a runner, stop `runner-kill-<name>-<n>.service`.

**What it doesn't cover.** The contract asks for a kill from outside the job's VM or container. Here the container is the systemd unit, and the watcher shares its kernel. A pause of the whole machine, such as a suspend or a hypervisor pausing the host, pauses the watcher too. When the machine resumes, the job keeps running until the kill: about a second after a suspend, which the watcher's clock counts, but up to the rest of its bound after a pause the guest's clock doesn't see. That is why the config check requires `epochFence: true`: the fence rejects ref writes from that job once a successor has taken over, though not the writes [it can't cover](deployment.md#33-mode-hosted-github-hosted-runners). A separate VM per job, destroyed from its host, doesn't have this gap.

`nix flake check` runs the module's tests in NixOS VMs, on x86_64-linux, with no GitHub. They use a stand-in runner for jobs: a stuck job dies at the bound, and the pinned Bun and the bundle run `version`, `validate` and `render --check` in the job's sandbox. The real runner package runs as far as its first network call. No test registers with GitHub or runs a real job, so check the first ticks on a new pool.

### GitHub-hosted runners (`hosted`)

GitHub-hosted runners have no host-side kill. This mode needs `runner.epochFence: true` and a `takeoverGraceMinutes` of at least 15, and it has no `hostKillMinutes`.

- Hosted mode relies on GitHub behaviour that the sandbox check verifies on a scratch repo with the two epoch rulesets (experiment H1 in [Deployment, The epoch fence](deployment.md#34-the-epoch-fence)). You run it yourself in [the rollout](#10-roll-out).
- Hosted runners are billed per job, and their cron is best effort ([When ticks run](#when-ticks-run)). [Deployment, Mode hosted](deployment.md#33-mode-hosted-github-hosted-runners) has the numbers.
- The target needs the two epoch rulesets before the first tick.

### The epoch fence

`runner.epochFence: true` ties every target ref write to the current lease, so a job that froze, and resumed after a successor took over, has every ref write rejected. Hosted mode requires it. In `self-hosted-kill` mode it is allowed as defence in depth. [Deployment, The epoch fence](deployment.md#34-the-epoch-fence) has the mechanism.

Each job owns a target branch that holds a chain of empty commits: `<runner.epochPrefix>queue` or `<runner.epochPrefix>release`. The default prefix is `qlander-epoch/`.

Before you turn it on, give the target the two epoch rulesets:

- `epoch-write`: creation, update and deletion restricted, with the owning App as the only bypass;
- `epoch-integrity`: non-fast-forward and deletion blocked, with no bypass at all.

Make sure no target workflow triggers on pushes to the epoch branches. The fence needs no App permission beyond Contents: write, which both Apps already have.

**Changing the fence or the prefix.** The simplest way is to pause both jobs and let every lease be released first. Otherwise the [epoch branch handover](deployment.md#34-the-epoch-fence) in Deployment applies. In `hosted` mode, a successor refuses to take over an expired lease from a holder that wrote without the fence, and reports busy, so switch to `hosted` mode only once a tick has released the lease.

### Checks in both modes

The loader refuses a config that breaks any of these:

- `runner.jobTimeoutMinutes <= lease.minutes - lease.fenceMarginMinutes`;
- `lease.minutes < runner.cronMinutes`;
- `queue.timeouts.reconcileMinutes >= 2 * runner.cronMinutes`.

`runner.cronMinutes`, `runner.jobTimeoutMinutes` and `runner.runsOn` are rendered into `tick.yml`. `runsOn` holds the tick jobs' runner labels. It is required in `self-hosted-kill` mode, where a GitHub-hosted image is refused. In `hosted` mode it defaults to `ubuntu-latest`.

The mode, `cronMinutes`, `runsOn`, `epochFence` and `epochPrefix` are not in the policy hash.

## 7. Render the workflows

`tick.yml` and `watchdog.yml` are rendered from `qlander.yml`. Never edit them by hand. A workflow can't read the config before it mints its tokens, so these values are written into the files:

- the repo guard (`control.repoId`);
- `runs-on`, the cron and `timeout-minutes`;
- the token steps: owner, repos and per-job permissions;
- the token variable names.

With `release.enabled: false`, only the queue job is rendered.

After you change the config, render and commit the result:

```sh
bun "${bundle:?}" validate --config qlander.yml
bun "${bundle:?}" render --config qlander.yml
```

CI runs `render --check`, which fails if a checked-in workflow differs from its rendering by a single byte.

## 8. Run a pinned release

A control repo made from the template already does this: its `qlander.yml` has a `bundle` block, so there is nothing to do unless you change the block or the pin. Without the block, the workflows run qlander from the control repo's own checkout, as `bun src/cli.ts`. This is source mode, and it needs qlander's source in the control repo.

The block's keys:

```yaml
bundle:
  repo: owner/qlander       # the repo whose releases hold the bundle
  private: true             # download with the job's own token (contents: read); repo must then be the control repo
  watchdog: false           # optional: keep watchdog.yml in source mode, so a broken release can't also silence it
```

`.github/qlander-release.txt` pins the release, as one line: `<version> <asset> <sha256>`.

Each job downloads Bun as before, downloads the pinned asset into a fresh temp directory, checks it against that sha256, and runs `"$bun" "$dir/<asset>" tick queue --config qlander.yml`.

A bundle that doesn't match is never run. The checksum in the reviewed control repo is the trust root. `bundle` doesn't change the policy hash. Re-render the workflows after you set it.

The bundle refuses a config `version` it doesn't know, and a state document `v` newer than it knows, so a downgrade fails closed instead of misreading state. Before you pin an older release, run its `check-state` on a copy of each state branch's `state.json`. [Deployment, Upgrading a live deployment](deployment.md#8-upgrading-a-live-deployment) has the rules.

[CONTRIBUTING.md](../CONTRIBUTING.md#making-a-release) says how a release is built.

## 9. Prepare the target

The target needs the [target-side requirements](../DESIGN.md#13-target-side-requirements):

- CI that runs on pushes to `queue/**`;
- rulesets on `main`, and on `release` if you use release advance, whose only bypass is the qlander Apps and any named break-glass humans. Add those people to the landing ruleset by hand, as individual users. Setup keeps them and removes any broader actor, such as a role, a team or org admins. In an emergency they can merge in the GitHub UI, which skips the queue's full suite;
- qualification for release advance, if you use it;
- the labels `ready`, `qlander:bounce`, `qlander:solo`, `qlander:unsolo` and `qlander:go`, or the names you set in `queue.labels`.

`audit` checks these, read-only. It reads a token from `GH_TOKEN`, and every request is a GET:

```sh
GH_TOKEN=$(gh auth token) bun "${bundle:?}" audit --config qlander.yml
```

It prints one line per check: `PASS`, `WARN`, `FAIL` or `SKIPPED`, with the requirement id and a fix. The ids are T0 to T12 for the [target](deployment.md#41-requirements) and C0 to C8 for the [control repo](deployment.md#4-target-repo-ci-requirements-and-audit). T0 and C0 appear only for a problem: the repo couldn't be read, its id doesn't match the config, or the token isn't an admin. Without admin, the checks that need it are `SKIPPED`. It exits 1 on a `FAIL`. It exits 3 instead if every `FAIL` came from a failed read, or a read failed and nothing else failed: those lines say `(read failed)`, so rerun it. A check that needs a permission the token lacks stays `SKIPPED` or `WARN`, and exits 0.

A check that needs admin rights, such as ruleset bypass lists, branch protection or secrets, is `SKIPPED`, never guessed. [Deployment, section 4](deployment.md#4-target-repo-ci-requirements-and-audit) lists every check.

| Flag | Effect |
| --- | --- |
| `--queue-app`, `--release-app`, `--state-app` | Override the App slugs, which default to `<control repo name>-queue`, `-release` and `-state`. |
| `--target-only`, `--control-only` | Limit the checks to one repo. |
| `--json` | Print the checks as JSON. |

## 10. Roll out

Run these gates in order. Each one is mandatory.

1. **G1, the sandbox.** [Run the sandbox check](#running-the-sandbox-check). On a scratch repo with rulesets like the target's, the queue App merges two signed PR heads through the API, one of them changing `.github/workflows/`, then moves the protected `main`. [Design, section 14](../DESIGN.md#14-rollout-gates-in-order-each-is-mandatory) lists each check.
2. **G2, the target.** The [target-side requirements](#9-prepare-the-target) are in place. `can_approve_pull_request_reviews` is `false` on the control repo ([step 4](#4-protect-the-control-repos-main)).
3. **G3, dry runs.** Run for at least a day against the target, with `QLANDER_MODE` unset. Compare the logged decisions with what a person would have done.
4. **G4, live.** Set `QLANDER_MODE=live`. The queue goes live, and the release job keeps dry-running. Enable release advance separately, by a reviewed PR that sets `release.dryRun: false`, once the target's release requirements hold.

### When ticks run

GitHub runs scheduled workflows on a best-effort basis. Gaps of 20 to 30 minutes between scheduled ticks are normal, and a newly created repo may get no scheduled runs at all for hours. Until the schedule starts, run the tick and the watchdog by hand:

```sh
gh workflow run tick.yml -R "$R"
gh workflow run watchdog.yml -R "$R"
```

A dispatched tick runs the queue job only. The release job runs only on the schedule.

While work is in flight, the queue job dispatches its own next tick. An idle queue waits for the schedule, so a new `ready` PR can take one to three ticks to be admitted.

### Running the sandbox check

`verify-sandbox` runs G1 against a sandbox repo, plus checks 2 to 4 of experiment H1, which the [epoch fence](deployment.md#34-the-epoch-fence) relies on. Every branch name comes from `qlander.yml`. It refuses the config's target and control repos, by id and by name. It stops before writing anything unless each App token reaches the sandbox and no other repo.

This check uses all three Apps. The template has `release.enabled: false`, so `setup` hasn't made the release App or the `release-write` environment yet. Set `release.enabled: true` in `qlander.yml`, and leave `release.dryRun: true`. Then render, commit through a PR, and rerun `setup`:

```sh
bun "${bundle:?}" render --config qlander.yml
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml --apply
bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml --apply --step target --apply-target-rulesets
```

The last command makes the rulesets that enabling release adds to the target: `release-landing`, `release-integrity` and `epoch-write-release`. Sandbox step 3 below copies them, so do this now, before sandbox step 2 widens the App installations.

**1. Make the sandbox.** Use a scratch repo in the same owner, with a first commit on `main`. The epoch branches can't be deleted, so don't reuse it for anything else:

```sh
gh repo create <owner>/<sandbox> --private --add-readme
gh api repos/<owner>/<sandbox> --jq .id
```

**2. Install all three Apps on it, for now.** In each App's settings (`https://github.com/apps/<slug>/installations/new`), add the sandbox to the repos the App can reach. The state App is the easy one to miss, because it normally reaches only the control repo. Until sandbox step 6, `setup` refuses those installations, because each must cover one repo. Don't use `setup` on the sandbox.

**3. Copy the rulesets to it.** A ruleset can only name an App that's installed on the repo, so this comes after step 2. This copies every ruleset from the target: the landing and integrity rules, `queue-refs`, `epoch-write-queue` and `epoch-write-release`, each with only its owning App as bypass, and `epoch-integrity`, with no bypass. From the control repo it copies only `qlander-state-branches`, because the control repo's `main` ruleset requires reviewed PRs with no bypass, which on the sandbox would stop the queue App moving `main`.

```sh
copy() {
  gh api "repos/$1/rulesets/$2" --jq '{name, target, enforcement, conditions, rules, bypass_actors}' |
    gh api -X POST repos/<owner>/<sandbox>/rulesets --input -
}
for id in $(gh api repos/<owner>/<target>/rulesets --jq '.[].id'); do
  copy <owner>/<target> "$id"
done
copy <owner>/<control> "$(gh api repos/<owner>/<control>/rulesets --jq '.[] | select(.name == "qlander-state-branches") | .id')"
```

**4. Run the App phases.** The template's `verify-sandbox` workflow mints each App's token for the sandbox alone, and runs `queue`, `release` and `cross` in that order. You need no token of your own:

```sh
gh workflow run verify-sandbox.yml -f sandbox=<sandbox> -f sandbox-id=<id>
gh run watch "$(gh run list --workflow verify-sandbox.yml --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

**5. Run the admin phase on your own machine,** as an org admin. Each phase refuses a token that isn't its own, so set only this one:

```sh
VERIFY_ADMIN_TOKEN=$(gh auth token) bun "${bundle:?}" verify-sandbox admin --repo <owner>/<sandbox> --repo-id <id> --config qlander.yml
```

The phases must run in this order, because each attacks the epochs the last one made. Each prints every check with its evidence, and a JSON summary. It exits 0 only when every planned check ran and passed. Later runs advance the epoch branches from where the last run left them.

**6. Put it back.** Remove the sandbox from each App's installation, then run `bun "${bundle:?}" setup --keys-dir ~/app-keys --config qlander.yml --step verify` to confirm. If you aren't using release advance yet, set `release.enabled` back to `false`.

These phases test App tokens. They don't test whether GitHub Actions can write the state branches: `setup --step verify` covers that on the control repo, by checking that the state App is the ruleset's only bypass.

## Using it with coding agents

Give an agent these files instead of this guide alone. They say which commands only read, what only a person can do, and how to read each command's [exit code](../AGENTS.md#reading-results), where 3 means it couldn't get an answer:

- [`AGENTS.md`](../AGENTS.md), for setting up or operating qlander, or changing its code.
- [`template/AGENTS.md`](../template/AGENTS.md), for working in a live control repo. A control repo made from the template has it at its root.
- [`template/agent-landing-rules.md`](../template/agent-landing-rules.md), rules to copy into your target repo's agent instructions. They are also at the control repo's root.

By default, agents don't post the [CI-policy approval](how-it-works.md#ci-policy-prs); [AGENTS.md](../AGENTS.md#ci-policy-approval) says why, and why letting an agent use a person's account is your decision.

## Next

- [Operating it](operating.md): pausing, labels, the status issue and alerts.
- [How it works](how-it-works.md): what happens to a PR once it is `ready`.
- [Configuration](configuration.md): every key in `qlander.yml`.
