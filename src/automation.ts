// Trusted automations. Opt-in: qlander.yml may
// list bot accounts, each with the exact paths it may change. A PR from such
// a bot lands without a human only when everything below holds; otherwise
// today's rules apply unchanged (a writer's `ready`, and an approver's
// `/qlander approve-policy <sha>` for a CI-policy change).
//
//   1. The PR was opened by the bot (login AND id).
//   2. Every changed file, renames under both names, matches one of the bot's
//      paths. A compare that may be cut fails closed.
//   3. Every commit in main...head is signed (admission checks that) and
//      authored by the bot, as GitHub resolves the author (login AND id).
//   4. Every commit in main...head was pushed to the PR's branch by the bot:
//      each is the `after` of a bot ref update in the branch's activity, and no
//      other account ever moved the branch to it. A commit that arrived inside
//      someone else's push, or in a multi-commit push, is not proven and fails
//      closed. This is what stops a human pushing onto the bot's branch, or
//      forging the bot as a commit's author through the contents API.
//
// The `ready` label then counts when the bot itself added it, and a CI-policy
// change needs no approval. The PR still runs the full pre-landing suite, in a
// batch of its own (machine.ts batchClass), and the landing comment names
// the waiver. Pure: snapshot.ts fetches the data.

import type { TrustedAutomation } from "./config";
import type { Account, Compare, Listed, RefActivity } from "./github/api";
import type { Waiver } from "./state";

export type AutomationTrust =
  | { ok: true; login: string; id: number; files: string[]; globs: string[] }
  | { ok: false; login: string; why: string };

/**
 * Why an allowed-path glob is too loose to accept, or null. Globs stay narrow
 * by construction: relative, `*` within one segment only (no `**`, `?`,
 * classes, braces or negation), no empty, `.` or `..` segments, and never a
 * first segment that matches `.github`, so a bot can never edit a workflow or
 * local action whatever else is configured.
 */
export function allowedPathProblem(glob: string): string | null {
  if (!/^[A-Za-z0-9._*/-]+$/.test(glob)) return "may use only letters, digits, '.', '_', '-', '/' and '*'";
  if (glob.includes("**")) return "must not use '**'";
  const segs = glob.split("/");
  if (segs.some((s) => s === "" || s === "." || s === "..")) return "must be a relative path without empty, '.' or '..' segments";
  if (new Bun.Glob(segs[0]!).match(".github")) return "must not reach into .github";
  return null;
}

/** The configured automation that opened this PR, if any (login AND id). */
export function automationFor(list: TrustedAutomation[] | undefined, author: Account | null): TrustedAutomation | undefined {
  if (!author || !list) return undefined;
  return list.find((a) => a.login === author.login && a.id === author.id);
}

const sameAccount = (a: Account | null, bot: TrustedAutomation) => a !== null && a.login === bot.login && a.id === bot.id;

export function automationTrust(
  bot: TrustedAutomation,
  pr: { headRef: string; head: string },
  diff: Compare,
  activity: Listed<RefActivity>,
): AutomationTrust {
  const no = (why: string): AutomationTrust => ({ ok: false, login: bot.login, why });
  if (diff.truncated) return no("the change list may be incomplete");
  if (diff.commits.length === 0 || diff.files.length === 0) return no("nothing to land");
  if (!diff.commits.some((c) => c.sha === pr.head)) return no("the compare does not include the head");

  const globs = bot.paths.map((p) => ({ p, g: new Bun.Glob(p) }));
  const used = new Set<string>();
  for (const f of diff.files) {
    const hit = globs.find((x) => x.g.match(f));
    if (!hit) return no(`changes ${f}, which is not one of its allowed paths`);
    used.add(hit.p);
  }

  for (const c of diff.commits) {
    if (!sameAccount(c.author, bot)) return no(`commit ${c.sha} is authored by ${c.author?.login ?? "an unknown account"}`);
  }

  // An older entry past the pages read could be another account moving the branch to one of these commits.
  if (activity.truncated) return no("the branch's activity history is longer than qlander reads");
  const ref = `refs/heads/${pr.headRef}`;
  const moves = activity.items.filter((a) => a.ref === ref);
  for (const c of diff.commits) {
    const to = moves.filter((a) => a.after === c.sha);
    if (to.length === 0) {
      return no(`no push of ${c.sha} by ${bot.login} to ${pr.headRef}`);
    }
    const other = to.find((a) => !sameAccount(a.actor, bot));
    if (other) return no(`${other.actor?.login ?? "an unknown account"} moved ${pr.headRef} to ${c.sha}`);
  }
  return { ok: true, login: bot.login, id: bot.id, files: [...diff.files], globs: bot.paths.filter((p) => used.has(p)) };
}

const code = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");

/** One line for the log and the PR's comments: which rule, which bot, what it skipped, which paths. */
export function describeWaiver(w: Waiver): string {
  const skipped = [w.readyByBot ? `its own \`ready\` counted` : "", w.policyWaived ? "no CI-policy approval was needed" : ""].filter(Boolean).join("; ");
  return `trusted-automation waiver for ${w.login} (id ${w.id}): ${skipped}; changed ${code(w.files)}, allowed by ${code(w.globs)}`;
}
