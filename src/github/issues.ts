// Listing qlander's open issues by label: the one implementation behind
// every pause, mirror and alert lookup.
//
// It uses the GraphQL issues connection, never the REST issues list, which can
// return an empty page while issues are open. An empty page read as "no pause"
// lets a tick act while paused, and read as "no issue" opens duplicates.
//
// The listing reads every page, oldest first, and says whether it is
// complete: every page agreed on the total, and every issue GitHub counts was
// read (by distinct number). Callers fail closed on an
// incomplete listing; a failed read throws.

import type { Http } from "./http";
import { GitHubError } from "./http";

export interface ListedIssue {
  number: number;
  nodeId: string;
  title: string;
  body: string;
  url: string;
  createdAt: string;
}

export interface Listing<T> {
  issues: T[];
  /** Every issue GitHub counts was read. False means some may be missing: fail closed. */
  complete: boolean;
}

export const ISSUE_PAGES = 10;

interface Page {
  repository: {
    issues: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { number: number; id: string; title: string; body: string | null; url: string; createdAt: string }[];
    };
  } | null;
}

const QUERY = `query($owner: String!, $name: String!, $label: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    issues(first: 50, after: $after, states: OPEN, labels: [$label], orderBy: { field: CREATED_AT, direction: ASC }) {
      totalCount pageInfo { hasNextPage endCursor } nodes { number id title body url createdAt }
    }
  }
}`;

/** How many times a scan restarts when the total changes under it, before it gives up as incomplete. */
export const SCAN_RESTARTS = 2;

/**
 * Every open issue with the label, oldest first. Throws a GitHubError if it
 * cannot be read. The scan is complete only if every page reported the same
 * totalCount and the distinct issues read equal it: a total that changes
 * mid-scan (an issue opened, closed or reopened) restarts the scan, and after
 * SCAN_RESTARTS restarts the listing is returned incomplete.
 */
export async function listOpenIssuesByLabel(http: Http, owner: string, name: string, label: string, maxPages = ISSUE_PAGES): Promise<Listing<ListedIssue>> {
  let last: ListedIssue[] = [];
  for (let attempt = 0; attempt <= SCAN_RESTARTS; attempt++) {
    const scan = await scanOnce(http, owner, name, label, maxPages);
    if (scan.kind === "done") return { issues: scan.issues, complete: scan.complete };
    last = scan.issues; // the total moved: scan again
  }
  return { issues: last, complete: false };
}

type Scan = { kind: "done"; issues: ListedIssue[]; complete: boolean } | { kind: "moved"; issues: ListedIssue[] };

async function scanOnce(http: Http, owner: string, name: string, label: string, maxPages: number): Promise<Scan> {
  const by = new Map<number, ListedIssue>();
  const sorted = () => [...by.values()].sort((a, b) => a.number - b.number);
  let after: string | null = null;
  let total: number | null = null;
  for (let page = 0; page < maxPages; page++) {
    const d: Page = await http.graphql<Page>(QUERY, { owner, name, label, after }, false);
    const c = d.repository?.issues;
    if (!c) throw new GitHubError("server", null, "the issues listing has no repository");
    if (total === null) total = c.totalCount;
    else if (c.totalCount !== total) return { kind: "moved", issues: sorted() };
    for (const i of c.nodes) if (!by.has(i.number)) by.set(i.number, { number: i.number, nodeId: i.id, title: i.title, body: i.body ?? "", url: i.url, createdAt: i.createdAt });
    if (!c.pageInfo.hasNextPage) return { kind: "done", issues: sorted(), complete: by.size === total };
    after = c.pageInfo.endCursor;
  }
  return { kind: "done", issues: sorted(), complete: false };
}

/** Two reads of one listing, as one: every issue either saw, oldest first; complete only if both were. */
export function unionListings<T extends { number: number }>(a: Listing<T>, b: Listing<T>): Listing<T> {
  const by = new Map<number, T>();
  for (const i of [...a.issues, ...b.issues]) if (!by.has(i.number)) by.set(i.number, i);
  return { issues: [...by.values()].sort((x, y) => x.number - y.number), complete: a.complete && b.complete };
}

/**
 * Read a listing twice before creating anything: a create is safe only when
 * both reads were complete. Returns the union.
 */
export async function listTwice<T extends { number: number }>(list: () => Promise<Listing<T>>): Promise<Listing<T>> {
  const first = await list();
  return unionListings(first, await list());
}

/** Thrown where a create was due but the listing was incomplete: transient, so the work is retried next tick. */
export const incompleteListing = (label: string) => new GitHubError("server", null, `the open ${label} issues could not all be listed; nothing created`);
