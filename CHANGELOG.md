# Changelog

## 0.2.1

Fixes for a first run of `setup` against real GitHub.

- `setup --step verify` no longer fails on a ruleset that works. It judged a refused state branch by GitHub's wording, and a real refusal can read `Reference update failed`. It now needs a 422, the branch still absent, and GitHub reporting that ruleset's creation rule on that branch name. A failed read of those rules fails the check.
- `setup --skip-audit` no longer reports a clean audit when none ran, or names a command that bundle users don't have.
- If a key is already saved for an App when its manifest code arrives, `setup` keeps that key and checks it, instead of failing.
- For when GitHub's new-App form comes up empty, `setup` also prints a pre-filled link for each App. A waiting `setup` notices the App and its key and carries on.
- The steps for a new private key use GitHub's current labels: **Credentials**, then **Key pairs**, then **New key**.

## 0.2.0

First public release.
