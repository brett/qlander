# Security

## Support level

Qlander is maintained on a **best effort** basis: issues are welcome, but there are no guaranteed response or fix times, including for security reports.

## Reporting a vulnerability

Report it through GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**. Don't open a public issue, PR or discussion for it.

Include:

- the version or commit;
- the configuration that matters, with your own names replaced;
- what an attacker needs, and what they gain.

Any reply is private and, like any fix, best effort. A fix, if made, is released before the details are published.

## Supported versions

Only the latest minor release gets fixes. Upgrade to it before reporting, if you can.

## What counts

Qlander holds credentials that can move a repository's `main` and `release` branches. The reports that matter most show a way to:

- land a commit on `main` that did not pass the pre-landing manifest, or advance `release` to a commit that is not qualified;
- land a CI-policy change without the approval bound to its SHA;
- make the tick run code from the target repository, or read an App key outside its job;
- have two executors act at once, or an executor act after its lease (DESIGN.md §15).

A behaviour the design already lists as a residual risk is not a vulnerability, but a way to widen it is. [DESIGN.md](DESIGN.md) §15 and §15.1 cover the design and its residual risks, and [docs/deployment.md](docs/deployment.md) §3 covers the runner contract.
