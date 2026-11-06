# Hooks

Hooks send chosen lifecycle events to the target repo as [`repository_dispatch`](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event) events. Any workflow there can listen for them.

Hooks only notify. Nothing waits for them, and a receiver can't block or veto anything. A failed delivery never stops landing or pauses the queue.

## Configure a hook

Hooks are an optional top-level `hooks` list in `qlander.yml`. With no `hooks` key, nothing is sent.

```yaml
hooks:
  - events:
      - landed
      - bounced
    eventType: qlander # the repository_dispatch event_type: letters, digits, _ . : -; at most 100 characters
```

Each hook names one or more events and the `event_type` they are sent as. Several hooks may use different event types. The loader refuses:

- an unknown event;
- an empty list;
- a bad event type;
- the same event sent twice under one event type.

**Not policy.** Hooks are left out of the policy hash, so adding or changing one doesn't unready the queue. The hash covers what decides admission and landing, and every admitted PR is revalidated when it changes; a hook decides nothing. Hooks still live in `qlander.yml` on the control repo's protected `main`, so a change to them is reviewed like any other config change.

**Where they go.** Hooks go to the target repo only, using the queue App's installation token, and need no new permission. `POST /repos/{owner}/{repo}/dispatches` needs the **Contents: write** repository permission ([GitHub's table](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps#repository-permissions-for-contents)). The queue App already has it on the target, and `tick.yml` already mints its token with `permission-contents: write`. Sending to another repo would need the App installed there and a token minted for it, which is not supported.

## Events

| Event | When | `batch` | `prs` | `details` |
| --- | --- | --- | --- | --- |
| `admitted` | A PR is admitted to the queue at a head. | null | the PR | `policyPr`; `waiver` (`{rule, login, readyByBot, policyWaived}`) when a trusted automation was admitted under its waiver; `priority` (`{by}`) when it was admitted prioritised |
| `dequeued` | An admitted PR leaves the queue without landing or being bounced. | null | the PR | `kind`: `head_moved`, `policy_changed` (qlander's policy hash or the PR's policy classification changed), `label_removed`, `closed`, `operator` (`qlander:bounce`), `budget_exhausted`, `conflict`, `already_in_main`, `squashed` (it carries commits that landed squashed) or `revalidation_failed`; and `reason`, in words |
| `batch_started` | `queue/<n>` was pushed, and CI starts on it. | the batch | its PRs | `ref`, `lineage`, `rebuild` (a retest after `main` moved), `dropped` (`[{number, outcome}]`: PRs that conflicted, were already in main, or carry commits that landed squashed); `priority` (`[{number, by}]`) when the batch carries prioritised PRs |
| `landed` | `main` moved to the batch's tested commit. | the batch; `head` is the new `main` | its PRs, each with `mergeSha` = the new `main` | `main`, `previousMain`, `rerun` (it needed a rerun) |
| `bounced` | A PR alone failed, after its rerun, and lost `ready`. A lone CI-policy PR whose batch is classed [red (policy)](../DESIGN.md#62-classification-of-the-active-batch) is bounced without a rerun. | the batch | the PR | `reason`, `failedJobs` (`[{name, url}]`), `failedOnRerun` |
| `flaky` | A red batch passed on its rerun. Sent when the rerun turns green, before landing. | the batch | its PRs | `failedJobs`: the jobs that failed in the red run |
| `approval_needed` | A CI-policy PR has everything but its approval. A trusted automation's PR whose waiver covers the change needs no approval, so it never gets this event. | null | the PR | `command`: the exact comment to post, `/qlander approve-policy <head sha>`; `approvers`: the logins whose approval counts |
| `budget_warning` | A reservation brings the rolling window to 75% of its budget, the share the status issue warns at. Sent once per crossing. | null | none | `used`, `budget`, `windowHours`, `share` |

A PR that is never admitted gets no event. Admission refusals are PR comments.

## Payload

GitHub delivers `event_type` (the hook's `eventType`) and `client_payload`:

```json
{
  "v": 1,
  "event": "landed",
  "idempotencyKey": "landed:42:<new main sha>",
  "at": "2026-10-23T12:00:00.000Z",
  "batch": { "n": 42, "base": "<main before>", "head": "<new main sha>", "depth": 0 },
  "prs": [{ "number": 101, "head": "<tested head sha>", "mergeSha": "<new main sha>", "author": "octocat" }],
  "details": { "main": "<new main sha>", "previousMain": "<main before>", "rerun": false }
}
```

- `prs[].head` is the head SHA qlander tested: the pin. Commits pushed after it are not in `main`.
- `prs[].author` is the PR author's login, recorded at admission. It is absent for PRs admitted before hooks existed.
- `mergeSha` is set on `landed` only. It is the `main` commit the PR landed in, not a per-PR merge commit.
- `batch.n` matches `queue/<n>`, the PR comments and the state history.

**Size.** The payload has 7 top-level keys (GitHub allows 10) and is kept under 8 KB (GitHub allows 64 KB), because waiting deliveries live in the state document. A normal payload is well under 2 KB. A payload that is too large is cut in this order, and `details.truncated` is then `true`:

1. `details.failedJobs` is cut short.
2. If that isn't enough, `details` is replaced.
3. Then the `prs` list is cut, with `details.prsTotal` giving the full count.

## Guarantees

- **Atomic with the transition.** A delivery is queued in the same state write as the change that caused it, so a crash can't lose it or report a transition that didn't happen. See [DESIGN.md, Journal](../DESIGN.md#32-journal-intent-and-receipt).
- **At least once, within bounds.** Deliveries are sent at the end of the tick. One is removed from state only after GitHub accepts it (204) or after it is given up. A tick that dies between the send and the state write sends it again on the next tick, with the same `idempotencyKey`. **Receivers must dedupe by `idempotencyKey`.**
- **Two bounds can lose a delivery,** and each loss is recorded as a failure. The waiting deliveries are capped at 32 KB, and past that the oldest is dropped, so a backlog can't grow the queue's state. A delivery is also given up after 24 hours of transient errors.
- **Stable keys.** What happened fixes the key: `admitted:<pr>:<head>:<admittedAt>`, `dequeued:<pr>:<head>:<admittedAt>`, `batch_started:<n>`, `landed:<n>:<main>`, `bounced:<n>:<pr>:<head>`, `flaky:<n>`, `approval_needed:<pr>:<head>`, `budget_warning:<at>`. Qlander remembers the last 200 delivered keys and the last 20 failures, and won't queue those again. `approval_needed` is re-detected on every tick while the PR waits, so it is normally sent once per head.
- **Never blocks landing.** Delivery runs after the tick's decisions and effects, before the lease is released. Its errors are caught, and it never opens a pause.
  - A server, network or rate-limit error leaves the delivery queued for the next tick, and delivery stops for the rest of that tick.
  - Any other error, such as a 403 or 404, fails the delivery at once.
  - A tick sends at most 10 deliveries, and starts no new dispatch after 20 seconds. In the worst case, one dispatch hangs to the 45-second write timeout. That adds about a minute to the tick, well inside its 5-minute limit.
  - Dispatches go through the lease fence like every other target write. If the fence refuses, delivery stops for that tick, and nothing counts as failed.
- **Visible failures.** Waiting and failed deliveries are in the state document (`hooks`), and so in the state mirror issue. The status issue shows how many are waiting, and a **warning** line with the event and error for any delivery that failed in the last 24 hours. Failed deliveries are not retried.
- **Order.** Deliveries are sent in the order they were queued, and a transient failure holds back the ones behind it. GitHub doesn't promise to start workflows in dispatch order, so receivers should not depend on order.
- **Dry runs.** A dry run logs the deliveries it would queue (`hook (dry run): would queue …`), and sends nothing.

## Receive events

`repository_dispatch` runs workflows from the default branch only. Any account or App with Contents: write on the target can send one, so a receiver should check `github.event.sender.login` before it trusts the payload, and treat the payload as data. The queue App's bot login is `<app slug>[bot]`.

A sketch of a receiver for `landed`:

```yaml
on:
  repository_dispatch:
    types: [qlander]

jobs:
  after-landing:
    if: github.event.client_payload.event == 'landed' && github.event.sender.login == 'widgets-qlander-queue[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: PRs that landed
        env:
          PAYLOAD_PRS: ${{ toJSON(github.event.client_payload.prs) }}
        run: jq -r 'map(.number) | join(",")' <<<"$PAYLOAD_PRS"
```

with this in `qlander.yml`:

```yaml
hooks:
  - events:
      - landed
    eventType: qlander
```

A receiver must be idempotent, since a `landed` event can arrive twice.

## Not supported

- **Watchdog alerts.** `alert` and `alert_cleared` are not hook events. The watchdog is a separate workflow that holds no App key (see [Monitoring](operating.md#monitoring)), so it can't dispatch to the target.
- **Blocking or veto hooks**, where a receiver can hold a batch. They would put a target-side workflow on qlander's critical path.
- **Other targets.** Other repos, and other transports such as webhooks or chat.
