# Qualification manifest, schema 1

A qualification manifest is a JSON file listing the workflows a commit must pass before release advance may move `release` to it. Qlander reads it with the `manifest` provider:

```yaml
release:
  enabled: true
  qualification:
    provider: manifest
    manifest:
      source: target            # target (default) or control
      path: .github/qualification.json
      proof:                    # optional
        statusContext: qualified
        workflow: .github/workflows/proof.yml
        events:                 # default
          - workflow_run
          - workflow_dispatch
        jobTemplate: "Qualified {sha}"              # default
```

- **`source: target`:** qlander reads the file once per tick from the head of the target repo's `main`, through the contents API. It reads the file as data only and never runs it.
- **`source: control`:** it reads the file from the control repo's checkout, relative to its root.
- **`path`** must be a canonical relative path: no `.` or `..` segments, no leading `/`, and only letters, digits, `.`, `_` and `-` between the slashes.

The receipt of every advance records the file's git blob sha as the policy version.

A target-hosted manifest is policy. `queue.policy.paths` must cover its path, so a target PR that edits it lands only as a policy PR. Config validation refuses a config that leaves the path uncovered.

## Format

```json
{
  "$comment": "What a commit must pass before release.",
  "schema": 1,
  "status_context": "qualified",
  "status_meaning": "What a success status asserts.",
  "branch": "main",
  "evidence_branch_patterns": ["^main$", "^queue/[A-Za-z0-9._-]+$"],
  "required": [
    {
      "path": ".github/workflows/ci.yml",
      "name": "CI",
      "when": "always",
      "why": "The full suite.",
      "required_jobs": ["Lint", "Test"],
      "allow_skipped_jobs": { "pr-gate": "runs on pull requests only" }
    }
  ],
  "not_required": { ".github/workflows/docs.yml": "publishes docs; gates nothing" }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `schema` | yes | Must be `1`. |
| `required` | yes | A non-empty list of workflow entries (below). At least one must have `when: always`. |
| `evidence_branch_patterns` | no | A non-empty list of regular expressions. A run counts as evidence only when its head branch matches one of them. Default: `["^main$"]`. |
| `branch` | no | The branch that commits are qualified on. Used in messages only. |
| `status_context`, `status_meaning` | no | Strings for the workflow that publishes a status. Qlander ignores them. |
| `not_required` | no | A map from workflow path to the reason it is not required. It records a decision and is not read. |

Each workflow entry has these fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `path` | yes | The workflow file, under `.github/workflows/`. |
| `name` | yes | The workflow's display name, used in messages and receipts. |
| `when` | yes | `always`: a run must exist. `if_triggered`: no run is fine, but a run that exists must pass. |
| `required_jobs` | yes | Job names that must appear in the run. Every job in the run must pass, listed or not. |
| `allow_skipped_jobs` | yes | A map from job name to reason. Only these jobs may be `skipped`. |
| `why` | no | A string for people. |

A key that starts with `$` is an annotation, at the top level or in an entry. It may hold any JSON value and is never read.

Any other unknown key, a wrong type, an empty `required`, or an invalid pattern makes the whole manifest invalid. An invalid manifest qualifies nothing and raises a `release-blocked` alert.

## How a commit is judged

For each required workflow, the evidence is the push runs of exactly this commit, in the target repo (both `repository` and `head_repository`), on a branch matching `evidence_branch_patterns`. A `pull_request` run never counts, whatever its branch is called. Qlander takes the newest of these runs on each branch, reads its latest attempt, and judges the workflow:

- **Pending** if any candidate run or job is still running, or if an `always` workflow has no run yet.
- **Failure** if a candidate run concluded `failure` or `timed_out`, or if no candidate passes. A candidate passes when every job succeeded, a job was skipped only where `allow_skipped_jobs` allows it, and every `required_jobs` name is present. `cancelled` and `neutral` never pass.
- **Success** otherwise.

The commit qualifies only when every workflow succeeds **and** the verdict cites at least one actual run. An absent `if_triggered` workflow counts as satisfied with no run, so a manifest of only `if_triggered` entries could otherwise qualify a commit on zero evidence. The parser refuses such a manifest, and the evaluation refuses a run-less success anyway.

Qlander also refuses a run listing or job list that GitHub returned incomplete, since a failing run on a missing page would be invisible.

## The proof chain (optional)

When `proof` is set, a commit must also carry the proof before the manifest is evaluated:

1. The newest status named `statusContext` on the commit must be `success`.
2. Its `target_url` must point at an Actions run in the target repo.
3. That run must be of `proof.workflow` on `main`, in the target repo and running its own code (both repository ids), for one of `proof.events`. The events may only be `workflow_run`, `workflow_dispatch`, `push` or `schedule`, because a pull request run is never proof.
4. Its latest attempt must have a successful job named exactly `jobTemplate`, with every `{sha}` replaced by the commit.

The job name binds the run to the commit, so a run that qualified one commit is no proof for another. The receipt records the proof run.

## Other providers

- `checks-green` uses the same evaluation. The manifest comes from `release.qualification.checksGreen.required`, which defaults to a copy of `queue.preLanding`, and only `main` runs count. The policy version is the blob sha of that list.
- `commit-status` qualifies a commit when the newest status named `context` is `success` and was posted by an account in `creators`. It can also require `targetUrl: actions-run` and the same `proof` chain (without `statusContext`). If `creators` includes `github-actions[bot]`, `producerWorkflow` must name the workflow that posts the status, and that workflow must be a policy path. This provider evaluates no manifest.
