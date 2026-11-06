// The three Apps (DESIGN.md §12.1) as the audit sees them: who they are, and
// their permissions as registered (`GET /apps/{slug}`) and as each
// installation has accepted them (`GET /orgs/{org}/installations`), reported
// separately, so a change that is saved but not yet accepted shows as
// pending acceptance (docs/deployment.md §4.2, §5.3).

import { GitHubError } from "../github/http";
import type { ReleaseConfig } from "../release-config";
import { releaseTokenPermissions } from "../release-permissions";
import { type AuditGh, fail, type Finding, pass, readFailed, skipped, unread } from "./types";

export type AppRole = "queue" | "release" | "state";

/** Exactly these permissions, not fewer and not more (DESIGN.md §12.1), for release advance (release.mode advance). */
export const EXPECTED_PERMISSIONS: Record<AppRole, Record<string, string>> = {
  queue: { contents: "write", workflows: "write", pull_requests: "write", actions: "write", checks: "read", statuses: "read", metadata: "read" },
  release: { ...releaseTokenPermissions({ mode: "advance", dispatch: null }), metadata: "read" },
  state: { contents: "write", metadata: "read" },
};

/** The permissions one App must have under this release config: release.mode dispatch adds Actions: write to the release App only (and Variables: read with a freeze). */
export function expectedPermissions(role: AppRole, release: Pick<ReleaseConfig, "mode" | "dispatch">): Record<string, string> {
  return role === "release" ? { ...releaseTokenPermissions(release), metadata: "read" } : EXPECTED_PERMISSIONS[role];
}

export interface AppIdentity {
  role: AppRole;
  slug: string;
  /** null when the App could not be read. */
  id: number | null;
  permissions: Record<string, string> | null;
  error?: string;
  /** Its registration could not be read because a read failed (readFailed), so nothing about it is known. */
  unread?: boolean;
}

interface Installation {
  id: number;
  app_id: number;
  app_slug: string;
  repository_selection: string;
  permissions: Record<string, string>;
}

/** The differences between two permission sets, in words; empty when equal. */
export function permissionDiff(want: Record<string, string>, have: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(want)) if (have[k] !== v) out.push(have[k] ? `${k}: ${have[k]}, expected ${v}` : `${k}: missing, expected ${v}`);
  for (const [k, v] of Object.entries(have)) if (!(k in want)) out.push(`${k}: ${v}, not expected`);
  return out.sort();
}

const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Each App's registration (id and permissions), by slug. */
export async function readApps(gh: AuditGh, slugs: { role: AppRole; slug: string }[]): Promise<AppIdentity[]> {
  const out: AppIdentity[] = [];
  for (const { role, slug } of slugs) {
    try {
      const a = await gh.get<{ id: number; permissions?: Record<string, string> }>(`apps/${slug}`);
      out.push({ role, slug, id: a.id, permissions: a.permissions ?? null });
    } catch (e) {
      out.push({ role, slug, id: null, permissions: null, error: why(e), unread: readFailed(e) });
    }
  }
  return out;
}

/**
 * T11: per App, its registration permissions, then each installation's
 * accepted permissions and repository selection. Which repos an
 * installation covers needs the App's own JWT, so that line is SKIPPED.
 */
export async function appChecks(gh: AuditGh, org: string, apps: AppIdentity[], id = "T11", release: Pick<ReleaseConfig, "mode" | "dispatch"> = { mode: "advance", dispatch: null }): Promise<Finding[]> {
  const out: Finding[] = [];
  let installs: Installation[] | null = null;
  let installErr = "";
  let installCause: unknown;
  try {
    const listed = await gh.list<Installation>(`orgs/${org}/installations`, {}, (p) => (p as { installations?: Installation[] } | null)?.installations);
    if (listed.truncated) throw new Error("the installation listing was incomplete");
    installs = listed.items;
  } catch (e) {
    installCause = e;
    installErr = e instanceof GitHubError && e.kind === "auth" ? "the token cannot list the organization's installations (it needs org admin read)" : why(e);
  }
  for (const app of apps) {
    const want = expectedPermissions(app.role, release);
    const label = `${app.role} App ${app.slug}`;
    if (app.id === null || !app.permissions) {
      const f = fail(id, `${label}: cannot read its registration (${app.error ?? "no permissions in the response"})`, `check the slug (--${app.role}-app) and that the App exists`);
      out.push(app.unread ? { ...f, inconclusive: true } : f);
      continue;
    }
    const reg = permissionDiff(want, app.permissions);
    out.push(
      reg.length
        ? fail(id, `${label}: registration permissions differ from DESIGN §12.1${app.role === "release" && release.mode === "dispatch" ? " for release.mode dispatch" : ""}`, `set exactly these in the App's settings: ${fmt(want)}`, reg)
        : pass(id, `${label}: registration permissions are exactly ${fmt(want)}`),
    );
    if (!installs) {
      out.push(unread(skipped(id, `${label}: installation permissions not read: ${installErr}`, "rerun with an org owner's token"), installCause));
      continue;
    }
    const mine = installs.filter((i) => i.app_id === app.id);
    if (!mine.length) {
      out.push(fail(id, `${label}: not installed on the organization`, `install it: https://github.com/apps/${app.slug}/installations/new`));
      continue;
    }
    for (const inst of mine) {
      const d = permissionDiff(app.permissions, inst.permissions);
      if (d.length) out.push(fail(id, `${label}: installation ${inst.id} has not accepted the registered permissions (pending acceptance)`, `accept them: https://github.com/organizations/${org}/settings/installations/${inst.id}`, d));
      else out.push(pass(id, `${label}: installation ${inst.id} has accepted the registered permissions`));
      if (inst.repository_selection !== "selected") out.push(fail(id, `${label}: installation ${inst.id} covers all repositories`, "install it on the one repo it serves only (repository_selection: selected)"));
    }
    out.push(skipped(id, `${label}: which repos each installation covers needs the App's JWT`, "check it in the installation's settings, or with `setup --step verify`"));
  }
  return out;
}

const fmt = (p: Record<string, string>) =>
  Object.entries(p)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
