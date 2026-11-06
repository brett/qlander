// The control repo's workflows, rendered from qlander.yml
// (docs/deployment.md §6.3): `bun src/cli.ts render` writes them and
// `render --check` fails when the checked-in files differ. A workflow cannot
// read the config before it mints its tokens, so everything the config
// decides about the jobs is written into the files here: the repo guard,
// runs-on, the cron, timeout-minutes, the token steps (owner, repos,
// per-job permissions) and the token variable names.
//
// What is the same for every deployment is fixed here: the job, environment,
// concurrency-group and secret names, the action pins, the permissions, and
// the verified Bun download. test/render.test.ts checks the properties the
// code relies on (DESIGN.md §12.1, §15) on any config.

import type { Names } from "./config";
import type { Bundle, LoadedConfig } from "./config/load";
import { CONTROL_BRANCH, QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "./job-names";
import type { ReleaseConfig } from "./release-config";
import { releaseTokenPermissions } from "./release-permissions";

/** The workflow files, relative to the control repo's root. */
export const TICK_WORKFLOW = ".github/workflows/tick.yml";
export const WATCHDOG_WORKFLOW = ".github/workflows/watchdog.yml";

/** How often the watchdog runs. */
export const WATCHDOG_CRON_MINUTES = 15;
/** The watchdog's runner: GitHub-hosted on purpose, so it still runs when the tick's runners are down. */
export const WATCHDOG_RUNS_ON = "ubuntu-latest";
/** The runner a hosted-mode tick uses when runner.runsOn is absent. */
export const HOSTED_RUNS_ON = "ubuntu-latest";

const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const APP_TOKEN = "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0";

/** What the renderer reads from the config: names, the runner contract, the token variables and whether release advance runs. */
export type RenderInput = Pick<LoadedConfig, "runner" | "tokens" | "runsOn" | "bundle"> & { config: { names: Names }; release: { enabled: boolean } & Partial<Pick<ReleaseConfig, "mode" | "dispatch">> };

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}

/** YAML 1.1 and 1.2 words a plain scalar would turn into something other than a string. */
const YAML_WORDS = /^(?:y|n|yes|no|true|false|on|off|null|~)$/i;

/** A string as a YAML scalar: plain when that reads back as the same string, else double-quoted. */
export function scalar(s: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s) && !YAML_WORDS.test(s) ? s : JSON.stringify(s);
}

/** The tick jobs' runner labels (runner.runsOn), checked against the mode. */
export function tickRunsOn(c: RenderInput): string[] {
  if (c.runsOn) return c.runsOn;
  if (c.runner.mode === "hosted") return [HOSTED_RUNS_ON];
  throw new RenderError("runner.runsOn is required to render the tick workflow in self-hosted-kill mode: the labels of the runners the host kills");
}

/**
 * The schedule for runner.cronMinutes. `*\/N` in the minute field restarts at
 * every hour, so it keeps an even N-minute interval only when N divides 60;
 * any other N would put some ticks closer together than the lease assumes.
 */
export function tickCron(minutes: number): string {
  if (minutes === 60) return "0 * * * *";
  if (minutes >= 1 && minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;
  throw new RenderError(`runner.cronMinutes ${minutes} cannot be a cron schedule with an even interval: use a divisor of 60`);
}

const runsOnLine = (labels: string[]) => (labels.length === 1 ? scalar(labels[0]!) : `[${labels.map(scalar).join(", ")}]`);

/** The pin file of a bundled deployment: one line, "<version> <asset> <sha256>" (docs/deployment.md §6.2). */
export const PIN_FILE = ".github/qlander-release.txt";

/** What the run step runs after the Bun binary in `$bun`: the checkout's source, or the pinned bundle, which takes the config explicitly. */
export function qlanderCommand(c: Pick<RenderInput, "bundle">, args: string): string {
  return c.bundle ? `"$bun" "$dir/$relasset" ${args} --config qlander.yml` : `"$dir/\${asset%.zip}/bun" src/cli.ts ${args}`;
}

/** What watchdog.yml runs: the bundle, unless `bundle.watchdog` is false (source mode). */
export function watchdogInput<C extends Pick<RenderInput, "bundle">>(c: C): Pick<RenderInput, "bundle"> {
  return c.bundle?.watchdog === false ? { bundle: null } : c;
}

/**
 * Every download: a failed attempt (a 504, a reset, a stall of 10 seconds) is
 * tried again until `timeout` ends it, which curl's own --retry-max-time can't,
 * since that doesn't stop an attempt already going. What arrives is still
 * checked against its committed sha256; a download that runs out fails the job.
 *
 * The bounds, in seconds, against the template's 5-minute job (300): the queue
 * job's chain is done at most WATCH_MINUTES + DISPATCH_SECONDS (src/wake.ts)
 * after the process starts, 210, which leaves 90 for what comes before it. The
 * downloads take at most 40 + 20 = 60 (40 + 10 + 20 = 70 for a private
 * release), leaving 30 (20) for the checkout and the token steps. A job that
 * still runs over loses only its chain link: the lease is released by then.
 */
export const CURL = "curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --retry 5 --retry-all-errors --connect-timeout 5 --speed-limit 1024 --speed-time 10";
/** Bun, about 40 MB. */
export const BUN_SECONDS = 40;
/** The bundle, under 1 MB. */
export const BUNDLE_SECONDS = 20;
/** A private release's listing. */
export const RELEASE_LISTING_SECONDS = 10;

/** Download, verify and run the pinned bundle (bundle set). */
function bundleLines(b: Bundle, args: string): string[] {
  const curl = CURL;
  const download = b.private
    ? [
        `          # A private release of ${b.repo},`,
        "          # read through the API with this job's own token (contents: read),",
        "          # passed on stdin so it is never in a command line. curl drops it on",
        "          # the redirect to the asset's storage host.",
        `          releases="https://api.github.com/repos/${b.repo}/releases"`,
        "          auth() { printf 'Authorization: Bearer %s\\n' \"$GITHUB_TOKEN\"; }",
        `          auth | timeout ${RELEASE_LISTING_SECONDS} ${curl} \\`,
        '            --header @- --header "Accept: application/vnd.github+json" \\',
        '            --output "$dir/release.json" "$releases/tags/v${relversion}"',
        '          id="$(RELEASE="$dir/release.json" ASSET="$relasset" "$bun" -e \'const a = (await Bun.file(process.env.RELEASE).json()).assets.filter((x) => x.name === process.env.ASSET); if (a.length !== 1) throw new Error("the release has no single asset " + process.env.ASSET); console.log(a[0].id)\')"',
        '          [[ "$id" =~ ^[0-9]+$ ]]',
        `          auth | timeout ${BUNDLE_SECONDS} ${curl} \\`,
        '            --header @- --header "Accept: application/octet-stream" \\',
        '            --output "$dir/$relasset" "$releases/assets/${id}"',
      ]
    : [
        `          timeout ${BUNDLE_SECONDS} ${curl} \\`,
        `            --output "$dir/$relasset" "https://github.com/${b.repo}/releases/download/v\${relversion}/\${relasset}"`,
      ];
  return [
    '          bun="$dir/${asset%.zip}/bun"',
    "          # The pinned qlander release, checked against the sha256 committed in",
    `          # ${PIN_FILE} before it runs. The checksum is the trust root.`,
    `          read -r relversion relasset relsum < ${PIN_FILE}`,
    '          [[ "$relasset" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*\\.js$ ]]',
    ...download,
    '          (cd "$dir" && echo "${relsum}  ${relasset}" | sha256sum -c -)',
    `          ${qlanderCommand({ bundle: b }, args)}`,
  ];
}

/** The verified Bun download and the command; the same lines in every job. */
function runScript(c: Pick<RenderInput, "bundle">, args: string): string[] {
  return [
    "        run: |",
    "          set -euo pipefail",
    "          # A pinned Bun release, checked against the committed sha256, in a",
    "          # directory that did not exist before this step.",
    "          read -r version asset sum < .github/bun-release.txt",
    '          dir="$(mktemp -d)"',
    `          timeout ${BUN_SECONDS} ${CURL} \\`,
    '            --output "$dir/$asset" "https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}"',
    '          (cd "$dir" && echo "${sum}  ${asset}" | sha256sum -c -)',
    '          unzip -q "$dir/$asset" -d "$dir"',
    ...(c.bundle ? bundleLines(c.bundle, args) : [`          ${qlanderCommand(c, args)}`]),
  ];
}

function checkoutStep(n: Names): string[] {
  return [`      - name: Check out ${n.control.name}`, `        uses: ${CHECKOUT}`, "        with:", "          persist-credentials: false"];
}

function stateTokenStep(n: Names): string[] {
  return [
    `      - name: Mint the state App token (${n.control.name} contents only)`,
    "        id: state",
    `        uses: ${APP_TOKEN}`,
    "        with:",
    "          client-id: ${{ secrets.STATE_APP_CLIENT_ID }}",
    "          private-key: ${{ secrets.STATE_APP_PRIVATE_KEY }}",
    `          owner: ${scalar(n.control.owner)}`,
    `          repositories: ${scalar(n.control.name)}`,
    "          permission-contents: write",
  ];
}

/** The App token for the target repo, with exactly the job's permissions. */
function targetTokenStep(n: Names, app: "queue" | "release", secret: string, permissions: [string, string][]): string[] {
  return [
    `      - name: Mint the ${app} App token (${n.target.name} only, least privilege)`,
    "        id: target",
    `        uses: ${APP_TOKEN}`,
    "        with:",
    `          client-id: \${{ secrets.${secret}_CLIENT_ID }}`,
    `          private-key: \${{ secrets.${secret}_PRIVATE_KEY }}`,
    `          owner: ${scalar(n.target.owner)}`,
    `          repositories: ${scalar(n.target.name)}`,
    ...permissions.map(([k, v]) => `          permission-${k}: ${v}`),
  ];
}

const guard = (n: Names) => `github.ref == 'refs/heads/${CONTROL_BRANCH}' && github.repository_id == ${n.control.id}`;

/** tick.yml: the queue job, and the release job when release advance is enabled. */
export function renderTick(c: RenderInput): string {
  const n = c.config.names;
  const r = c.runner;
  const runsOn = runsOnLine(tickRunsOn(c));
  const cron = tickCron(r.cronMinutes);
  const control = `${n.control.owner}/${n.control.name}`;
  const selfHosted = r.mode === "self-hosted-kill";
  const release = c.release.enabled;
  const runnerComment = selfHosted
    ? "    # Self-hosted runners in a group restricted to this workflow on main (DESIGN.md §11)."
    : "    # GitHub-hosted runners (runner.mode hosted, docs/deployment.md §3.3).";
  const lines = [
    "# Rendered from qlander.yml by `bun src/cli.ts render`; do not edit by",
    "# hand. `bun src/cli.ts render --check` fails when this file and the config",
    "# disagree.",
    "#",
    "# The tick (DESIGN.md §11, §15). Keep this exact path"
      + (selfHosted ? ": the runner group is restricted to" : "."),
    ...(selfHosted ? [`#   ${control}/.github/workflows/tick.yml@refs/heads/${CONTROL_BRANCH}`] : []),
    "#",
    ...(release
      ? [
          "# Two jobs, each with its own App key, environment, state branch, lease and",
          "# concurrency group:",
          `#   queue    ${c.tokens.queue}, queue-write, ${n.stateBranch}`,
          `#   release  ${c.tokens.release}, release-write, ${n.releaseStateBranch}`,
          "# Both get STATE_TOKEN, the state App's token, which is the only identity",
          "# that can move either state branch. Neither job ever sees the other App's",
          "# key (src/main.ts refuses to start if it does). The release job runs on",
          "# `schedule` only, so at most one is created per cron interval however",
          "# many dispatches arrive (DESIGN.md §12.1).",
        ]
      : [
          `# One job, queue (${c.tokens.queue}, queue-write, ${n.stateBranch}); release`,
          "# advance is not enabled (release.enabled). The job also gets STATE_TOKEN,",
          "# the state App's token, the only identity that can move the state branch.",
        ]),
    "#",
    "# Hard invariant (DESIGN.md §15, checked when the config is loaded): each",
    "# job's timeout-minutes is at most lease.minutes - lease.fenceMarginMinutes.",
    "#",
    "# Self-chaining (DESIGN.md §11.1): the queue job may dispatch the next tick",
    "# itself with its GITHUB_TOKEN (actions: write), only after releasing its",
    "# lease and only as its last act. The cron stays the fallback.",
    "#",
    "# Operator commands (DESIGN.md §10) are labels on the target PR, never",
    "# inputs: a newer pending run replaces an older one, so an input could be",
    "# lost.",
    "#",
    "# Nothing here checks out, installs or runs target code. The job checks out",
    ...(c.bundle
      ? [
          `# this repo and runs the qlander release pinned in ${PIN_FILE}`,
          `# (from ${c.bundle.repo}) with a Bun release verified against`,
          "# .github/bun-release.txt, each checked against its committed sha256 in a",
          "# fresh temp directory. There is no cache of any kind and no package",
          "# install while the keys are present.",
        ]
      : [
          "# this repo and runs qlander with a Bun release verified against",
          "# .github/bun-release.txt, unpacked into a fresh temp directory. There is no",
          "# cache of any kind and no package install while the keys are present.",
        ]),
    "",
    "name: tick",
    "",
    "on:",
    "  schedule:",
    `    - cron: "${cron}"`,
    "  workflow_dispatch: # wakes the queue tick; takes no inputs (commands are PR labels)",
    "",
    "permissions: {}",
    "",
    "jobs:",
    "  queue:",
    `    name: ${QUEUE_JOB_NAME} # recorded in the lease (src/job-names.ts QUEUE_JOB_NAME)`,
    "    # Only this repo's own main ever runs with the keys (the environment's",
    "    # deployment-branch rule enforces the same).",
    `    if: ${guard(n)}`,
    runnerComment,
    `    runs-on: ${runsOn}`,
    `    timeout-minutes: ${r.jobTimeoutMinutes}`,
    "    environment: queue-write",
    "    concurrency:",
    "      group: qlander-queue",
    "      cancel-in-progress: false",
    "    permissions:",
    "      contents: read # the state branch is written with the state App's token, never this one",
    "      issues: write # pause issues and the state mirror",
    "      # A GITHUB_TOKEN-created workflow_dispatch is the one event that starts a",
    "      # run. src/github/state-repo.ts refuses every other Actions write.",
    "      actions: write # lease takeover reads, and dispatching the next queue tick (self-chaining, DESIGN.md §11.1)",
    "    steps:",
    ...checkoutStep(n),
    "",
    ...targetTokenStep(n, "queue", "QUEUE_APP", [
      ["contents", "write"],
      ["workflows", "write"],
      ["pull-requests", "write"],
      ["actions", "write"],
      ["checks", "read"],
      ["statuses", "read"],
    ]),
    "",
    ...stateTokenStep(n),
    "",
    '      - name: Run one queue tick (a dry run unless QLANDER_MODE is "live")',
    "        env:",
    `          ${scalar(c.tokens.queue)}: \${{ steps.target.outputs.token }}`,
    "          STATE_TOKEN: ${{ steps.state.outputs.token }}",
    "          GITHUB_TOKEN: ${{ github.token }}",
    "          QLANDER_MODE: ${{ vars.QLANDER_MODE }}",
    ...runScript(c, "tick queue"),
  ];
  if (release) {
    lines.push(
      "",
      "  release:",
      `    name: ${RELEASE_JOB_NAME} # recorded in the lease (src/job-names.ts RELEASE_JOB_NAME)`,
      "    # This repo's own main only; and on the cron only, never a dispatch, so at",
      "    # most one release job is created per cron interval.",
      "    if: >-",
      `      ${guard(n)} &&`,
      "      github.event_name == 'schedule'",
      `    runs-on: ${runsOn}`,
      `    timeout-minutes: ${r.jobTimeoutMinutes}`,
      "    environment: release-write",
      "    concurrency:",
      "      group: qlander-release",
      "      cancel-in-progress: false",
      "    permissions:",
      "      contents: read # the release state branch is written with the state App's token, never this one",
      "      issues: write # the release pause and alert issues and the release state mirror",
      "      actions: read # whether a previous release job has completed (lease takeover)",
      "    steps:",
      ...checkoutStep(n),
      "",
      // release.mode dispatch: actions: write (dispatching the target's release workflow), contents: read (write only for the epoch fence), no workflows, and, with a freeze, actions-variables: read.
      ...targetTokenStep(n, "release", "RELEASE_APP", Object.entries(releaseTokenPermissions({ mode: c.release.mode ?? "advance", dispatch: c.release.dispatch ?? null }, r.epochFence)).map(([k, v]) => [k.replace(/_/g, "-"), v])),
      "",
      ...stateTokenStep(n),
      "",
      '      - name: Run one release tick (a dry run unless QLANDER_MODE is "live" and release advance is enabled)',
      "        env:",
      `          ${scalar(c.tokens.release)}: \${{ steps.target.outputs.token }}`,
      "          STATE_TOKEN: ${{ steps.state.outputs.token }}",
      "          GITHUB_TOKEN: ${{ github.token }}",
      "          QLANDER_MODE: ${{ vars.QLANDER_MODE }}",
      ...runScript(c, "tick release"),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** watchdog.yml: one job on a GitHub-hosted runner, with only the workflow token. */
export function renderWatchdog(c: RenderInput): string {
  const n = c.config.names;
  const w = n.watchdogLabels;
  const lines = [
    "# Rendered from qlander.yml by `bun src/cli.ts render`; do not edit by",
    "# hand. `bun src/cli.ts render --check` fails when this file and the config",
    "# disagree.",
    "#",
    `# The watchdog (docs/operating.md, Monitoring). Every ${WATCHDOG_CRON_MINUTES} minutes it checks that ticks`,
    "# are running and passing, that a runner picks them up, that no pause has",
    "# sat open too long and that tick.yml is enabled. It keeps one",
    `# \`${w.alert}\` issue per alert kind and rewrites the pinned status issue`,
    `# (\`${w.status}\`).`,
    "#",
    "# It runs on a GitHub-hosted runner on purpose: it must still run when the",
    "# tick's runners are down, which is one of the things it watches for.",
    "#",
    "# It holds no App key and uses no environment. Its GITHUB_TOKEN reads this",
    "# repo's contents (the checkout) and Actions (tick.yml runs, jobs and logs),",
    "# and writes issues; nothing else. Bun is the same pinned release as",
    "# tick.yml, verified against .github/bun-release.txt, in a fresh temp",
    "# directory, with no cache and no package install.",
    ...(watchdogInput(c).bundle ? [`# So is qlander: the release pinned in ${PIN_FILE}.`] : []),
    "",
    "name: watchdog",
    "",
    "on:",
    "  schedule:",
    `    - cron: "*/${WATCHDOG_CRON_MINUTES} * * * *"`,
    "  workflow_dispatch:",
    "",
    "permissions: {}",
    "",
    "jobs:",
    "  watchdog:",
    "    name: Watchdog",
    `    if: ${guard(n)}`,
    `    runs-on: ${WATCHDOG_RUNS_ON}`,
    "    timeout-minutes: 5",
    "    concurrency:",
    "      group: qlander-watchdog # one writer of the alert and status issues at a time",
    "      cancel-in-progress: false",
    "    permissions:",
    "      contents: read # check out this repo (it may be private); nothing is written",
    "      issues: write # the alert issues and the status issue",
    "      actions: read # tick.yml's state, runs, jobs and job logs",
    "    steps:",
    ...checkoutStep(n),
    "",
    "      - name: Run the watchdog",
    "        env:",
    "          GITHUB_TOKEN: ${{ github.token }}",
    "          QLANDER_MODE: ${{ vars.QLANDER_MODE }}",
    ...runScript(watchdogInput(c), "watchdog"),
  ];
  return `${lines.join("\n")}\n`;
}

/** Every rendered workflow, by its path relative to the control repo's root. */
export function renderWorkflows(c: RenderInput): { path: string; text: string }[] {
  return [
    { path: TICK_WORKFLOW, text: renderTick(c) },
    { path: WATCHDOG_WORKFLOW, text: renderWatchdog(c) },
  ];
}

/** The first line where two texts differ (1-based), or null when they are equal. */
export function firstDifference(want: string, have: string): { line: number; want: string; have: string } | null {
  if (want === have) return null;
  const a = want.split("\n");
  const b = have.split("\n");
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { line: i + 1, want: a[i] ?? "(end of file)", have: b[i] ?? "(end of file)" };
  }
  return { line: a.length, want: "(same lines)", have: "(same lines, different line endings)" };
}
