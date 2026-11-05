// The read-only sources behind the operator commands (src/operator.ts),
// built on the existing clients with one token: the state branches through
// StateRefClient.read, the control repo's issues, tick runs and workflow
// state through WatchdogClient's reads, and the target through a TargetClient
// with the "read" role (which refuses every write). The only call added here
// is the recent queue CI runs listing, for the usual batch duration.
//
// Nothing here writes: the status command calls only GET requests and
// GraphQL queries (POSTed to /graphql, never a mutation). Any token that can read both repos works, for example
// `gh auth token`'s.

import type { Config } from "../config";
import type { CiSpan } from "../status";
import type { OperatorSources } from "../operator";
import { isQueueRef } from "../validate";
import { Http, type HttpOptions } from "./http";
import { StateRefClient } from "./state-ref";
import { TargetClient } from "./target";
import { WatchdogClient } from "./watchdog-client";

/** How many recent CI runs of the first pre-landing workflow are read for the usual duration (one page). */
const SPAN_PAGE = 100;

export async function connectOperatorSources(cfg: Pick<Config, "names" | "preLanding">, http: HttpOptions): Promise<OperatorSources> {
  const N = cfg.names;
  const control = { ...http, owner: N.control.owner, repo: N.control.name, repoId: N.control.id };
  const stateBranches = [N.stateBranch, N.releaseStateBranch];
  const [queueState, releaseState, controlClient, target] = await Promise.all([
    StateRefClient.connect({ ...control, branch: N.stateBranch, stateBranches }),
    StateRefClient.connect({ ...control, branch: N.releaseStateBranch, stateBranches }),
    WatchdogClient.connect({
      ...control,
      readLabels: [N.controlLabels.pause, N.releaseLabels.pause, N.releaseLabels.alert, N.watchdogLabels.alert],
      writeLabels: [],
    }),
    TargetClient.connect({ ...http, owner: N.target.owner, repo: N.target.name, repoId: N.target.id, role: "read", names: N, dataFiles: [] }),
  ]);
  const targetHttp = new Http(http);
  const workflow = cfg.preLanding[0]?.path;
  return {
    queueState,
    releaseState,
    control: controlClient,
    target,
    async recentQueueSpans(): Promise<CiSpan[]> {
      if (!workflow) return [];
      const file = workflow.slice(".github/workflows/".length);
      type Raw = { head_branch: string | null; run_started_at?: string | null; updated_at?: string | null };
      const { items } = await targetHttp.paginate(
        `repos/${N.target.owner}/${N.target.name}/actions/workflows/${encodeURIComponent(file)}/runs`,
        { event: "push", status: "success", per_page: SPAN_PAGE },
        (p) => (p as { workflow_runs: Raw[] }).workflow_runs,
        1,
      );
      return items
        .filter((r) => r.head_branch !== null && isQueueRef(N, r.head_branch) && r.run_started_at && r.updated_at)
        .map((r) => ({ startedAt: r.run_started_at!, finishedAt: r.updated_at! }));
    },
  };
}
