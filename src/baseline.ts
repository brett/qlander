// queue.strategy.mainBaseline (DESIGN.md §5.7): is a red PR's failure one that
// main has on its own? Pure. The evidence is a run of the same suite on main's
// own commit, with no PR in it: a push run on main says nothing for a target
// whose main run skips the tests its queue refs already ran.
//
// Failures are compared by test id where the logs give one. A job name alone
// is too coarse: a shard that is red on main hides a new failure in the same
// shard. A job with no ids (an aggregate, an unreadable log, too many
// failures to list) can only match by name. That can wrongly hold a PR, but
// never lands it: a held PR still needs a green suite once main has moved.

import { jobId, MAX_TESTS_PER_JOB } from "./flaky";
import type { BaselineResult } from "./state";
import type { FailedJob } from "./types";

/** The most test ids kept in the state document; a job past it matches by name. */
export const MAX_BASELINE_TESTS = 100;

const idsOf = (j: FailedJob, tests: Record<string, string[]>): string[] => {
  const id = jobId(j);
  return id === null ? [] : (tests[String(id)] ?? []);
};

/** What main's own run failed. `byJob` names the jobs whose ids cannot stand for the whole job. */
export function baselineResult(failed: FailedJob[], tests: Record<string, string[]>): BaselineResult {
  const ids = new Set<string>();
  const byJob = new Set<string>();
  for (const j of failed) {
    const own = idsOf(j, tests);
    if (own.length === 0 || own.length > MAX_TESTS_PER_JOB || ids.size + own.length > MAX_BASELINE_TESTS) byJob.add(j.name);
    else own.forEach((t) => ids.add(t));
  }
  return { red: true, jobs: [...new Set(failed.map((j) => j.name))], tests: [...ids], byJob: [...byJob] };
}

/** A green or unknown run: nothing here shows that main fails. */
export const NOT_RED: BaselineResult = { red: false, jobs: [], tests: [], byJob: [] };

/** The failures of this run that main's own run does not show: test ids, or job names where no id can be compared. */
export function ownFailures(failed: FailedJob[], tests: Record<string, string[]>, main: BaselineResult): string[] {
  const own: string[] = [];
  for (const j of failed) {
    const ids = idsOf(j, tests);
    const byName = ids.length === 0 || ids.length > MAX_TESTS_PER_JOB || main.byJob.includes(j.name);
    if (byName) {
      if (!main.jobs.includes(j.name)) own.push(j.name);
    } else own.push(...ids.filter((t) => !main.tests.includes(t)));
  }
  return [...new Set(own)];
}

/** At most `max` of what main fails, for a comment or a pause reason. */
export function mainFailures(main: BaselineResult, max = 3): string {
  const all = main.tests.length > 0 ? main.tests : main.jobs;
  return `${all.slice(0, max).join(", ")}${all.length > max ? ` and ${all.length - max} more` : ""}`;
}
