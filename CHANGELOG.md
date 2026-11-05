# Changelog

## 0.2.1

Fixes for a first run of `setup` against real GitHub.

- `setup --step verify` no longer fails on a ruleset that works. It judged a refused state branch by GitHub's wording, and a real refusal can read `Reference update failed`. It now needs a 422, the branch still absent, and the same token creating `<branch>-setup-probe` on the same commit, which it deletes again. So a verify that reaches this check now writes and removes that branch.
- For when GitHub's new-App form comes up empty, `setup` also prints a pre-filled link for each App. A waiting `setup` notices the App and its key and carries on.
- The steps for a new private key use GitHub's current labels: **Credentials**, then **Key pairs**, then **New key**.

## 0.2.0

First public release.
