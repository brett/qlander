// The real client behind the operator controls (src/control.ts), with the
// operator's own token. It is built on the existing clients, each limited to
// what a control needs:
//
//   - the state branches: StateRefClient, read only;
//   - control-repo issues, tick runs, jobs and logs: WatchdogClient, which
//     lists the pause, release-pause and status labels and creates issues
//     with the two pause labels only;
//   - the target's PRs: TargetClient with the "read" role.
//
// The writes it adds are exactly these: enable or disable tick.yml, dispatch
// tick.yml on the control branch, put one of the configured ready, bounce
// and priority labels on a target PR, and comment on a target PR. Each
// refuses anything else before a request is made. None needs an App: they
// are what an operator with write access does by hand.

import type { ControlApi, ControlConfig } from "../control";
import { CONTROL_BRANCH } from "../job-names";
import { isPrNumber } from "../validate";
import { GitHubError, Http, type HttpOptions } from "./http";
import { StateRefClient } from "./state-ref";
import { TargetClient } from "./target";
import { WatchdogClient } from "./watchdog-client";

const TICK_WORKFLOW = "tick.yml";

function bad(msg: string): never {
  throw new GitHubError("validation", null, msg);
}

const pr = (n: number) => (isPrNumber(n) ? n : bad("bad PR number"));

export async function connectControl(cfg: ControlConfig, http: HttpOptions): Promise<ControlApi> {
  const N = cfg.names;
  const control = { ...http, owner: N.control.owner, repo: N.control.name, repoId: N.control.id };
  const stateBranches = [N.stateBranch, N.releaseStateBranch];
  const pauses = [N.controlLabels.pause, N.releaseLabels.pause];
  const [queueState, releaseState, repo, target] = await Promise.all([
    StateRefClient.connect({ ...control, branch: N.stateBranch, stateBranches }),
    StateRefClient.connect({ ...control, branch: N.releaseStateBranch, stateBranches }),
    WatchdogClient.connect({ ...control, readLabels: [...pauses, N.watchdogLabels.status, N.releaseLabels.mirror], writeLabels: pauses }),
    TargetClient.connect({ ...http, owner: N.target.owner, repo: N.target.name, repoId: N.target.id, role: "read", names: N, dataFiles: [] }),
  ]);
  const h = new Http(http);
  const workflow = `repos/${N.control.owner}/${N.control.name}/actions/workflows/${TICK_WORKFLOW}`;
  const issues = `repos/${N.target.owner}/${N.target.name}/issues`;
  const labels = new Set([N.labels.ready, N.labels.bounce, ...(N.labels.priority ? [N.labels.priority] : [])]);
  return {
    queueState,
    releaseState,
    async whoami() {
      const u = (await h.request<{ login: unknown; id: unknown }>("GET", "user")).json;
      if (typeof u.login !== "string" || !Number.isSafeInteger(u.id)) bad("unreadable account");
      return { login: u.login, id: u.id as number };
    },
    workflowState: () => repo.workflowState(),
    async setTickEnabled(enabled: boolean) {
      await h.request("PUT", `${workflow}/${enabled ? "enable" : "disable"}`);
    },
    async dispatchTick() {
      await h.request("POST", `${workflow}/dispatches`, { body: { ref: CONTROL_BRANCH } });
    },
    listRecentRuns: () => repo.listRecentRuns(),
    listUnfinishedRuns: () => repo.listUnfinishedRuns(),
    listJobs: (id) => repo.listJobs(id),
    jobLog: (id) => repo.jobLog(id),
    listOpenIssues: (label) => repo.listOpenIssues(label),
    createIssue: (title, body, l) => repo.createIssue(title, body, l),
    closeIssue: (n) => repo.closeIssue(n),
    comment: (n, body) => repo.comment(n, body),
    getPr: (n) => target.getPr(n),
    async addPrLabel(n: number, label: string) {
      if (!labels.has(label)) bad(`unexpected label ${label}`);
      await h.request("POST", `${issues}/${pr(n)}/labels`, { body: { labels: [label] } });
    },
    async commentPr(n: number, body: string) {
      if (!/^\/qlander approve-policy [0-9a-f]{40}$/.test(body)) bad("the only PR comment a control posts is the policy approval");
      await h.request("POST", `${issues}/${pr(n)}/comments`, { body: { body } });
    },
  };
}
