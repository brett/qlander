// The operator control commands (src/control.ts has the pieces):
//
//   bun src/cli.ts pause queue|release|both
//   bun src/cli.ts resume queue|release|both [--all]
//   bun src/cli.ts quiesce
//   bun src/cli.ts unquiesce [--all]
//   bun src/cli.ts remove|requeue|prioritise <pr>
//   bun src/cli.ts approve-policy <pr> <sha>
//
// Each takes --dry-run (read what it would check, print every step, change
// nothing) and --config <file>. The token is the operator's own, from
// GH_TOKEN or GITHUB_TOKEN; the repos, labels and branches come from the
// config. Every control that changed something is logged as a comment on the
// watchdog's status issue; a failed log is reported, never fatal.
//
// quiesce (docs/deployment.md §8.1):
//   0. refuse, changing nothing, while a batch is active, running or pending,
//      or a PR waits to run alone (a paused queue never lands them), or for
//      anything step 4 would refuse that a running tick won't clear;
//   1. open a pause and a release-pause issue;
//   2. disable tick.yml;
//   3. wait until two reads in a row find no tick run in progress or queued
//      (a ghost run, queued with no jobs, counts as gone);
//   4. read both state documents and refuse, naming each, unless both exist
//      (an absent one is fine if it was absent at step 0 and no mirror issue
//      says it held state; for the release job, also only while it is off or
//      held in dry run), the queue has no journal, active, concurrent, pending, solo, verify,
//      outbox or lease, and the release state no journal, pausePending or lease;
//   5. print both state commits, for rollback.
// unquiesce:
//   0. refuse, changing nothing, unless a pause issue is open and (without
//      --all) every open pause issue is one a control opened;
//   1. enable tick.yml, then wait ENABLE_SETTLE_MS before dispatching;
//   2. dispatch a tick and check that it ran paused (a live tick's outcome, or
//      in dry-run mode what the tick read from the pause issues);
//   3. close the pause issues, the release pause first;
//   4. dispatch one live tick and check that it succeeded.

import type { PullRequest } from "./github/api";
import {
  closePauses,
  isOurs,
  type ControlApi,
  type ControlConfig,
  type ControlDeps,
  dispatchAndWait,
  docVersion,
  ENABLE_SETTLE_MS,
  liveRuns,
  openPause,
  POLL_MS,
  QUEUE_NEVER_WROTE,
  RELEASE_NEVER_WROTE,
  Refused,
  Run,
  stateProblems,
  WAIT_MS,
  withoutRunningTick,
} from "./control";
import { CONTROL_USAGE, type ControlCommand } from "./control-usage";
import { openTokenAndConfig, type OperatorIo, readStateDocs, why } from "./operator";
import type { IssueInfo, TickRun } from "./watchdog-core";

export interface ControlArgs {
  positional: string[];
  dryRun: boolean;
  all: boolean;
  config: string;
}

const WHICH = ["queue", "release", "both"];
const isPr = (s: string | undefined) => !!s && /^[1-9][0-9]{0,9}$/.test(s);

/** The command's arguments, or a usage error (thrown as a string). */
export function parseControlArgs(cmd: ControlCommand, args: string[], defaultConfig: string, resolvePath: (p: string) => string): ControlArgs {
  const a: ControlArgs = { positional: [], dryRun: false, all: false, config: defaultConfig };
  for (let i = 0; i < args.length; i++) {
    const x = args[i]!;
    if (x === "--dry-run" && !a.dryRun) a.dryRun = true;
    else if (x === "--all" && !a.all && (cmd === "resume" || cmd === "unquiesce")) a.all = true;
    else if (x === "--config") {
      const v = args[++i];
      if (!v) throw "--config needs a file";
      a.config = resolvePath(v);
    } else if (!x.startsWith("-")) a.positional.push(x);
    else throw `unexpected argument ${x}`;
  }
  const p = a.positional;
  if ((cmd === "pause" || cmd === "resume") && (p.length !== 1 || !WHICH.includes(p[0]!))) throw `${cmd} needs one of: queue, release, both`;
  if ((cmd === "quiesce" || cmd === "unquiesce") && p.length) throw `${cmd} takes no arguments`;
  if ((cmd === "remove" || cmd === "requeue" || cmd === "prioritise") && (p.length !== 1 || !isPr(p[0]))) throw `${cmd} needs one PR number`;
  if (cmd === "approve-policy" && (p.length !== 2 || !isPr(p[0]) || !/^[0-9a-f]{40}$/.test(p[1]!))) throw "approve-policy needs a PR number and its full 40-character head sha";
  return a;
}

const pauseLabels = (cfg: ControlConfig, w: string): string[] =>
  w === "queue" ? [cfg.names.controlLabels.pause] : w === "release" ? [cfg.names.releaseLabels.pause] : [cfg.names.controlLabels.pause, cfg.names.releaseLabels.pause];

const listIssues = (xs: IssueInfo[]) => xs.map((i) => `#${i.number} ${i.title}`).join("; ");

async function quiesce(r: Run, login: string): Promise<void> {
  const N = r.cfg.names;
  // 0. A paused queue never lands its active batch or builds a pending one: refuse before pausing under it.
  const pre = await readStateDocs(r.api, N);
  if (pre.queue.kind === "error" || pre.queue.kind === "corrupt") r.refuse(`cannot read ${N.stateBranch} (${pre.queue.reason}); nothing was changed`);
  if (pre.queue.kind === "ok") {
    const s = pre.queue.state;
    const busy = [
      ...(s.active ? [`batch #${s.active.n} (${s.active.prs.join(", ")}) is active`] : []),
      ...(s.baseline && !s.baseline.result ? [`a run of main with no PR in it is going (batch ${s.baseline.n})`] : []),
      ...(s.concurrent?.length ? [`${s.concurrent.length} further batch(es) are running`] : []),
      ...(s.pending.length ? [`${s.pending.length} batch(es) are pending`] : []),
      ...(s.solo.length ? [`${s.solo.length} PR(s) wait to run alone (${s.solo.map((x) => x.pr).join(", ")})`] : []),
    ];
    if (busy.length) r.refuse(`${busy.join("; ")}. A paused queue does not land them, so quiesce does not pause under them: run it again once they have landed or bounced (if you paused first, \`resume both\` lets them). Nothing was changed.`);
  }
  // Whatever else step 4 would refuse, unless a running tick clears it first. Refused here, the ticks keep running and can clear it; refused there, nothing runs to.
  const blocked = await stateProblems(r, withoutRunningTick(pre, pre.serverTime ?? r.now()), pre);
  if (blocked.length) r.refuse(`the state is not idle:\n  ${blocked.join("\n  ")}\nNothing was changed, so ticks keep running and can clear this. Run quiesce again once they have: \`status\` shows the state, and a tick has to run after any time named above. \`pause both\` stops new batches meanwhile, and \`resume both\` lifts it.`);
  let tickDisabled = false;
  // What gets back to where this started, from here on.
  const back = () => (tickDisabled ? "run `unquiesce` to go back: it enables tick.yml, checks a paused tick and closes the pause issues" : "run `resume both` to go back, since tick.yml was not disabled");
  try {
    r.say("1. pause both jobs");
    await openPause(r, N.controlLabels.pause, login, "quiesce");
    await openPause(r, N.releaseLabels.pause, login, "quiesce");
    r.say("2. disable tick.yml");
    const state = await r.api.workflowState();
    if (state === "active") await r.step("disable tick.yml", () => r.api.setTickEnabled(false));
    else r.say(`tick.yml is already ${state}`);
    tickDisabled = true;
  } catch (e) {
    throw new Refused(`${why(e)}. Any pause issue opened so far stays open; ${back()}.`);
  }
  r.say("3. wait until no tick run is in progress or queued");
  if (r.dry) r.say("would: wait (a ghost run, queued with no jobs, counts as gone)");
  else {
    const ghosts = new Set<number>();
    let last: TickRun[] | null = null;
    let quiet = 0;
    try {
      await r.until("the tick runs to finish", async () => {
        last = await liveRuns(r, ghosts);
        quiet = last?.length === 0 ? quiet + 1 : 0;
        return quiet >= 2 ? true : null; // two passes in a row: a run changing status mid-listing is not missed
      });
    } catch (e) {
      const still = last as TickRun[] | null;
      if (e instanceof Refused) throw new Refused(`${e.message} (${still ? `still running: ${still.map((x) => `${x.id} ${x.status} ${x.url}`).join(", ")}` : "the runs could not all be listed"}). Both jobs stay paused and tick.yml stays disabled; ${back()}.`);
      throw e;
    }
    r.say("no tick run is in progress or queued");
  }
  r.say("4. check that the state is idle");
  const docs = await readStateDocs(r.api, N);
  const bad = await stateProblems(r, docs, pre);
  if (bad.length && !r.dry) r.refuse(`the state is not idle:\n  ${bad.join("\n  ")}\nBoth jobs stay paused and tick.yml stays disabled; ${back()}.`);
  for (const b of bad) r.say(`  not idle now: ${b}`);
  if (!bad.length) r.say("idle");
  r.say("5. the state commits, for rollback (docs/deployment.md §8.1.1)");
  const queueVersion = docs.queue.kind === "absent" && !bad.length ? QUEUE_NEVER_WROTE : docVersion(docs.queue);
  const releaseVersion = docs.release.kind === "absent" && !bad.length ? RELEASE_NEVER_WROTE : docVersion(docs.release);
  const shas = `${N.stateBranch} ${queueVersion}, ${N.releaseStateBranch} ${releaseVersion}`;
  r.say(`  ${N.stateBranch} ${queueVersion}`);
  r.say(`  ${N.releaseStateBranch} ${releaseVersion}`);
  // A dry run reads now and does not wait: exit 1, so that a script can't take this for a clear run.
  if (bad.length) r.refuse("not idle now. A real run would pause both jobs, wait for any running tick, and refuse if any of this is left. Nothing was changed.");
  if (!r.dry) {
    r.acted.push(`quiesced; state commits: ${shas}`);
    r.say("quiesced");
  }
}

/** Refuse unless both pause listings are complete and, without `all`, every open pause issue is one a control opened: nothing is closed until all of them can be. */
async function closable(r: Run, all: boolean): Promise<IssueInfo[]> {
  const N = r.cfg.names;
  const open: IssueInfo[] = [];
  for (const label of [N.controlLabels.pause, N.releaseLabels.pause]) {
    const listed = await r.api.listOpenIssues(label);
    if (!listed.complete) r.refuse(`the open ${label} issues could not all be listed; nothing was closed`);
    open.push(...listed.issues);
  }
  const foreign = open.filter((i) => !all && !isOurs(i));
  if (foreign.length) r.refuse(`still open, and not opened by a control: ${listIssues(foreign)}. Close them (or run unquiesce --all), then run unquiesce again. Nothing was closed.`);
  return open;
}

async function unquiesce(r: Run, all: boolean): Promise<void> {
  const N = r.cfg.names;
  const pauses = await r.api.listOpenIssues(N.controlLabels.pause);
  if (!pauses.complete) r.refuse(`the open ${N.controlLabels.pause} issues could not all be listed; nothing was changed`);
  if (!pauses.issues.length) r.refuse(`no ${N.controlLabels.pause} issue is open, so the first tick would not run paused: is the queue quiesced? Nothing was changed. If it isn't, there is nothing to undo: \`resume both\` closes a release pause, and \`gh workflow enable tick.yml\` turns ticks back on.`);
  await closable(r, all); // before anything changes
  r.say("1. enable tick.yml");
  const state = await r.api.workflowState();
  if (state !== "active") {
    await r.step("enable tick.yml", () => r.api.setTickEnabled(true));
    if (!r.dry) await r.sleep(ENABLE_SETTLE_MS);
  } else r.say("tick.yml is already active");
  r.say("2. one tick, still paused");
  // The way out while tick.yml is on and the pause issues are open.
  const stillPaused = "tick.yml is enabled and the pause issues stay open. Find out why, then run `unquiesce` again, or run `resume both` to reopen the queue without this check.";
  const paused = await dispatchAndWait(r, "it must run paused").catch((e) => {
    throw e instanceof Refused ? new Refused(`${e.message}. ${stillPaused}`) : e;
  });
  if (paused && (paused.run.conclusion !== "success" || paused.outcome !== "paused"))
    r.refuse(`the tick did not run paused (run ${paused.run.conclusion ?? "?"}, outcome ${paused.outcome ?? "unknown"}): ${paused.run.url}. ${stillPaused}`);
  r.say("3. close the pause issues");
  await closable(r, all); // again: one may have opened since
  // The release pause first, so a failure part-way leaves the queue's pause open and unquiesce can run again.
  for (const label of [N.releaseLabels.pause, N.controlLabels.pause]) await closePauses(r, label, all);
  r.say("4. one live tick");
  const unpaused = "The pause issues are closed, so the queue is running. Read the run; `pause both` stops the queue again.";
  const live = await dispatchAndWait(r, "it must succeed, unpaused").catch((e) => {
    throw e instanceof Refused ? new Refused(`${e.message}. ${unpaused}`) : e;
  });
  if (live && (live.run.conclusion !== "success" || live.job?.conclusion !== "success" || live.outcome === null || live.outcome === "paused"))
    r.refuse(`the live tick did not succeed (run ${live.run.conclusion ?? "?"}, outcome ${live.outcome ?? "unknown"}): ${live.run.url}. ${unpaused}`);
  if (live) {
    r.acted.push(`live tick ${live.run.id}: ${live.outcome}`);
    r.say("unquiesced");
  }
}

async function labelPr(r: Run, n: number, label: string, effect: string, already: (pr: PullRequest) => boolean): Promise<void> {
  const pr = await r.api.getPr(n);
  if (pr.state !== "open" || pr.merged) r.refuse(`#${n} is ${pr.merged ? "merged" : "closed"}`);
  if (already(pr)) r.refuse(`#${n} is already labelled ${label}`);
  await r.step(`label #${n} ${label} (${effect})`, () => r.api.addPrLabel(n, label));
}

async function approvePolicy(r: Run, me: { login: string; id: number }, n: number, head: string): Promise<void> {
  if (!r.cfg.humans.some((h) => h.login === me.login && h.id === me.id)) r.refuse(`${me.login} is not on queue.policy.approvers, so the tick would not count this approval`);
  const pr = await r.api.getPr(n);
  if (pr.state !== "open" || pr.merged) r.refuse(`#${n} is ${pr.merged ? "merged" : "closed"}`);
  if (pr.head.sha !== head) r.refuse(`#${n}'s head is ${pr.head.sha}, not ${head}: an approval counts for that exact head only`);
  const body = `/qlander approve-policy ${head}`;
  await r.step(`comment on #${n}: ${body}`, () => r.api.commentPr(n, body));
}

/** Run one control command; resolves to the exit code (2: usage, 1: refused or failed, 0: done). */
export async function controlCommand(cmd: ControlCommand, args: string[], io: OperatorIo, deps: ControlDeps, defaultConfig: string, resolvePath: (p: string) => string): Promise<number> {
  let a: ControlArgs;
  try {
    a = parseControlArgs(cmd, args, defaultConfig, resolvePath);
  } catch (e) {
    io.err(String(e));
    io.err(`usage:\n${CONTROL_USAGE}`);
    return 2;
  }
  const opened = openTokenAndConfig(a.config, io, deps.env, "the operator's own token");
  if (typeof opened === "number") return opened;
  const cfg: ControlConfig = { ...opened.config, releaseWritesState: opened.release.enabled && !opened.release.dryRun };
  io = opened.io;
  const redact = opened.redact;
  let api: ControlApi;
  try {
    api = await (deps.connect ?? (async (c, h) => (await import("./github/control-client")).connectControl(c, h)))(cfg, opened.http);
  } catch (e) {
    io.err(`could not connect: ${why(e)}`);
    return 1;
  }
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const r = new Run(api, cfg, io, a.dryRun, sleep, deps.now ?? (() => new Date()), deps.pollMs ?? POLL_MS, deps.waitMs ?? WAIT_MS);
  const L = cfg.names.labels;
  const p = a.positional;
  const line = [cmd, ...p, ...(a.all ? ["--all"] : [])].join(" ");
  if (a.dryRun) io.out(`dry run of \`${line}\`: nothing is changed`);
  let code = 0;
  let outcome = "done";
  let login = "?";
  try {
    const me = await api.whoami();
    login = me.login;
    switch (cmd) {
      case "pause":
        for (const label of pauseLabels(cfg, p[0]!)) await openPause(r, label, login, "pause");
        break;
      case "resume": {
        const left: IssueInfo[] = [];
        for (const label of pauseLabels(cfg, p[0]!)) left.push(...(await closePauses(r, label, a.all)));
        if (left.length) r.say(`still paused by: ${listIssues(left)} (not opened by a control; --all closes them too)`);
        break;
      }
      case "quiesce":
        await quiesce(r, login);
        break;
      case "unquiesce":
        await unquiesce(r, a.all);
        break;
      case "remove":
        await labelPr(r, Number(p[0]), L.bounce, "the tick unreadies it, abandoning its batch if it is in one", () => false);
        break;
      case "requeue":
        await labelPr(r, Number(p[0]), L.ready, "the tick admits it again", (pr) => pr.labels.includes(L.ready));
        break;
      case "prioritise": {
        const label = L.priority ?? r.refuse("the priority lane is off: the config sets no queue.labels.priority");
        await labelPr(r, Number(p[0]), label, "the tick moves it to the front of the queue", (pr) => pr.labels.includes(label));
        break;
      }
      case "approve-policy":
        await approvePolicy(r, me, Number(p[0]), p[1]!);
        break;
    }
  } catch (e) {
    code = 1;
    outcome = e instanceof Refused ? `refused: ${e.message}` : `failed: ${why(e)}`;
    io.err(outcome);
  }
  if (!a.dryRun && r.acted.length) await logControl(r, login, line, redact(outcome));
  return code;
}

/** Log a control that changed something as a comment on the watchdog's status issue. A failure is reported, never fatal. */
async function logControl(r: Run, login: string, line: string, outcome: string): Promise<void> {
  const label = r.cfg.names.watchdogLabels.status;
  try {
    const status = (await r.api.listOpenIssues(label)).issues[0];
    if (!status) return r.io.err(`(not logged: no open ${label} issue)`);
    const body = [`Operator control by ${login} at ${r.now().toISOString()}: \`${line}\``, "", ...r.acted.map((x) => `- ${x}`), "", ...(outcome.includes("\n") ? ["Outcome:", "```", outcome.replaceAll("`", "'"), "```"] : [`Outcome: ${outcome}`])].join("\n");
    await r.api.comment(status.number, body);
    r.say(`logged on #${status.number}`);
  } catch (e) {
    r.io.err(`(not logged on the ${label} issue: ${why(e)})`);
  }
}
