# Contributing

Issues and PRs are welcome. Don't file security reports as issues; see [SECURITY.md](SECURITY.md).

## Before you open a PR

```sh
bun install --frozen-lockfile
bun test                         # unit, end-to-end (against an in-memory GitHub), crash and lease tests
bun scripts/test-on-example.ts   # the suite on exactly the tree the public repo ships, on the neutral example config
bunx tsc --noEmit
bun scripts/config-doc.ts        # regenerate docs/configuration.md after a schema change
bun scripts/build-release.ts --out dist   # the release assets and the pin line
uvx zizmor@1.30.1 --pedantic .github/workflows
go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12
```

- Every behaviour has a test.
- A change to the invariants in DESIGN.md §1, to the lease or the fence, or to the runner contract (docs/deployment.md §3) needs its reasoning in DESIGN.md or docs/deployment.md, in the same PR.
- Qlander has no runtime dependencies. A PR that adds one will be asked to remove it.

## Where things are

| What | Where |
| --- | --- |
| Pure decision logic | `src/machine.ts`, `src/ops.ts` |
| End-to-end tests' in-memory GitHub | `test/world.ts` |
| GitHub client | `src/github/` |
| Queue runner | `src/queue.ts` |
| Release runner | `src/release-runner.ts` |
| Watchdog ([Monitoring](docs/operating.md#monitoring)) | `src/watchdog.ts` |
| Lifecycle hooks ([Hooks](docs/hooks.md)) | `src/hooks.ts` |
| Read-only status view ([Watching the queue](docs/operating.md#watching-the-queue)) | `src/status.ts`, using the operator commands' shared read context in `src/operator.ts` |
| Config schema | `schema/qlander.schema.json` |

[docs/configuration.md](docs/configuration.md) is generated from the schema, and a test fails when the doc is stale.

Each tick job must die before its lease can pass to another runner: `runner.jobTimeoutMinutes` ≤ `lease.minutes` − `lease.fenceMarginMinutes`. The loader refuses a config that breaks this. `tick.yml`'s `timeout-minutes` is rendered from `runner.jobTimeoutMinutes`. Raise it only together with `lease.minutes` in `qlander.yml`; both jobs share them.

## Making a release

Push a tag `v<version>`, where the version is the one in `package.json`. `.github/workflows/release.yml` builds the assets with `scripts/build-release.ts` and publishes them. When the repo is public, it adds a build-provenance attestation. GitHub offers attestations for private repos on Enterprise Cloud only.

The assets are:

- `qlander-<version>.js`, built with `bun build --target=bun src/cli.ts`;
- `qlander.schema.json`;
- `SHA256SUMS`.

The build is deterministic. Running `bun scripts/build-release.ts --out dist` on the tagged commit, with the pinned Bun, reproduces the checksum and prints the pin line.

## Neutral names only

Code, docs, tests and comments use neutral names (`example/…`, `alice`, `acme/widgets`). Values that belong to a deployment go in that deployment's own `qlander.yml`. If a behaviour is specific to one deployment, make it config.

## Public hygiene

Every PR runs a required check that scans the tree, the commit messages, the PR title and body and the branch name for content that must not be published. Its rules are not public, so a failure shows only where the hit is and a rule number. If it fails, the maintainer will tell you what to change.

PRs are squash-merged. The check enforces one maintainer identity on `main`, so the maintainer lands a contribution as their own commit and credits you in the message.

### What must not ship

Nothing that belongs to a particular deployment (its organisation, repos, ids, hosts, people, CI job names or internal history) may appear in this repository's files, history, commit messages, PR text, branch and tag names or release notes. Tests use the neutral example config (`test/fixtures/example.qlander.yml`) and neutral names. The scrub tool, the hooks and the server-side checks that enforce this are described in [docs/deployment.md, Public hygiene](docs/deployment.md#7-public-hygiene).
