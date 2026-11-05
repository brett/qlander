// The HTTP layer under the GitHub clients: one request function, error
// classification, Link-header pagination, and retries for reads only.
// Nothing here knows about queues; nothing here runs code from a repository.

export type ErrorKind = "rate_limit" | "auth" | "not_found" | "conflict" | "validation" | "server" | "network";

export class GitHubError extends Error {
  constructor(
    public readonly kind: ErrorKind,
    public readonly status: number | null,
    message: string,
    public readonly retryAfterMs: number | null = null,
    public readonly graphqlInternal = false,
  ) {
    super(`${kind}${status ? ` (${status})` : ""}: ${message}`);
    this.name = "GitHubError";
  }
}

/**
 * GitHub's generic GraphQL failure, on a 200 with no `type`. It is what GitHub
 * answers for an internal fault, and also, in the same words, for a refused
 * updateRefs (a stale beforeOid, measured on real GitHub). So the text alone
 * never says what happened: a caller judges by the refs, and the queue counts
 * repeats (src/queue.ts) because a refusal does not go away on retry.
 */
const GRAPHQL_INTERNAL = /^Something went wrong while executing your query\b/;

/** The error graphql() throws for that failure. A plain 5xx is not one. */
export function isGraphqlInternal(e: unknown): e is GitHubError {
  return e instanceof GitHubError && e.kind === "server" && e.graphqlInternal;
}

/** Who to assign an issue to, when it carries one of these labels (qlander.yml `notify`). Assigning is what makes GitHub tell them. */
export interface AssignOn {
  labels: readonly string[];
  logins: readonly string[];
}

/**
 * Create an issue, assigned as `assign` says. A login GitHub refuses must
 * never cost the issue, least of all a pause: it is then created unassigned.
 */
export async function postIssue<T>(http: Pick<Http, "request">, path: string, issue: { title: string; body: string; labels: string[] }, assign?: AssignOn): Promise<Response<T>> {
  const logins = assign && issue.labels.some((l) => assign.labels.includes(l)) ? assign.logins : [];
  if (logins.length > 0) {
    try {
      return await http.request<T>("POST", `${path}/issues`, { body: { ...issue, assignees: logins } });
    } catch (e) {
      if (!(e instanceof GitHubError && e.kind === "validation")) throw e;
    }
  }
  return http.request<T>("POST", `${path}/issues`, { body: issue });
}

export interface Response<T = unknown> {
  status: number;
  json: T;
  headers: Headers;
}

export interface HttpOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts for an idempotent read (1 = no retry). */
  readAttempts?: number;
  maxPages?: number;
  /** Deadline for a write request; well inside the lease fence margin (DESIGN.md §15). */
  writeTimeoutMs?: number;
  /** Deadline for a read request. */
  readTimeoutMs?: number;
}

/** Default deadlines: a write must finish (or be abandoned as ambiguous) well inside the 2-minute fence margin. */
export const WRITE_TIMEOUT_MS = 45_000;
export const READ_TIMEOUT_MS = 60_000;

const READ = new Set(["GET", "HEAD"]);

/** Map an HTTP failure to an ErrorKind (DESIGN.md §5.3 rule 5, §15). */
export function classify(status: number, headers: Headers, message: string): GitHubError {
  const retryAfter = headers.get("retry-after");
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : reset ? Math.max(0, Number(reset) * 1000 - Date.now()) : null;
  if (status === 429 || ((status === 403 || status === 429) && (remaining === "0" || retryAfter !== null || /rate limit/i.test(message)))) {
    return new GitHubError("rate_limit", status, message, retryAfterMs);
  }
  if (status === 401 || status === 403) return new GitHubError("auth", status, message);
  if (status === 404) return new GitHubError("not_found", status, message);
  if (status === 409) return new GitHubError("conflict", status, message);
  if (status === 422 && /already exists/i.test(message)) return new GitHubError("conflict", status, message);
  if (status === 400 || status === 422) return new GitHubError("validation", status, message);
  if (status >= 500) return new GitHubError("server", status, message);
  return new GitHubError("validation", status, message);
}

function nextLink(headers: Headers): string | null {
  const link = headers.get("link");
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1]!;
  }
  return null;
}

export class Http {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readAttempts: number;
  readonly maxPages: number;

  constructor(private readonly opts: HttpOptions) {
    this.base = opts.baseUrl ?? "https://api.github.com";
    this.fetchFn = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.readAttempts = opts.readAttempts ?? 3;
    this.maxPages = opts.maxPages ?? 30;
  }

  private url(pathOrUrl: string, query?: Record<string, string | number | undefined>): string {
    // Only follow absolute URLs on the API host (Link headers); refuse anything else.
    const u = pathOrUrl.startsWith("https://") ? new URL(pathOrUrl) : new URL(pathOrUrl.replace(/^\//, ""), `${this.base}/`);
    if (u.origin !== new URL(this.base).origin) throw new GitHubError("validation", null, `refusing to call ${u.origin}`);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async request<T = unknown>(
    method: string,
    path: string,
    init: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<Response<T>> {
    const url = this.url(path, init.query);
    const attempts = READ.has(method) ? this.readAttempts : 1;
    let last: GitHubError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.once<T>(method, url, init.body);
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        last = e;
        const retryable = e.kind === "server" || e.kind === "network" || (e.kind === "rate_limit" && (e.retryAfterMs ?? 0) <= 60_000);
        if (!retryable || attempt === attempts) throw e;
        await this.sleep(e.kind === "rate_limit" ? (e.retryAfterMs ?? 1000) : 500 * 2 ** (attempt - 1));
      }
    }
    throw last!;
  }

  private async once<T>(method: string, url: string, body: unknown): Promise<Response<T>> {
    let res: globalThis.Response;
    const deadline = READ.has(method) ? (this.opts.readTimeoutMs ?? READ_TIMEOUT_MS) : (this.opts.writeTimeoutMs ?? WRITE_TIMEOUT_MS);
    try {
      res = await this.fetchFn(url, {
        signal: AbortSignal.timeout(deadline),
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.opts.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "qlander",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
      });
    } catch (e) {
      // A timed-out write may or may not have happened: callers treat it as
      // ambiguous and reconcile by observation, never by resending.
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new GitHubError("network", null, timedOut ? `${method} exceeded its ${deadline} ms deadline; outcome unknown` : e instanceof Error ? e.message : String(e));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      // The body failed mid-read: like a timeout, the request's outcome is unknown.
      throw new GitHubError("network", res.status, `${method} response body could not be read: ${e instanceof Error ? e.message : String(e)}`);
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (res.status >= 400) {
      const msg = (json as { message?: string } | null)?.message ?? (text.slice(0, 200) || res.statusText);
      throw classify(res.status, res.headers, msg);
    }
    return { status: res.status, json: json as T, headers: res.headers };
  }

  /**
   * GET every page (Link rel="next"). `pick` extracts the items of a page.
   * Returns truncated=true instead of silently stopping at maxPages.
   */
  async paginate<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    pick: (page: unknown) => T[],
    maxPages = this.maxPages,
  ): Promise<{ items: T[]; truncated: boolean }> {
    const items: T[] = [];
    let url: string | null = this.url(path, { per_page: 100, ...query });
    for (let page = 0; url; page++) {
      if (page >= maxPages) return { items, truncated: true };
      const res: Response = await this.request("GET", url);
      items.push(...pick(res.json));
      url = nextLink(res.headers);
    }
    return { items, truncated: false };
  }

  /**
   * GET a text file served by a redirect (a job log): the API answers with a
   * short-lived signed https URL, which is fetched without the token. The
   * body is streamed and only its last `maxBytes` bytes are kept. One
   * deadline covers the whole download; every failure is a GitHubError.
   */
  async download(path: string, maxBytes: number, timeoutMs: number): Promise<string> {
    const signal = AbortSignal.timeout(timeoutMs);
    const net = (e: unknown) => new GitHubError("network", null, `download: ${e instanceof Error ? e.message : String(e)}`);
    let res: globalThis.Response;
    try {
      res = await this.fetchFn(this.url(path), {
        signal,
        method: "GET",
        redirect: "manual",
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.opts.token}`, "x-github-api-version": "2022-11-28", "user-agent": "qlander" },
      });
    } catch (e) {
      throw net(e);
    }
    const location = res.headers.get("location");
    if (res.status >= 400) throw classify(res.status, res.headers, `download: HTTP ${res.status}`);
    if (res.status < 300 || res.status >= 400 || !location) throw new GitHubError("validation", res.status, `download: expected a redirect, got HTTP ${res.status}`);
    if (!location.startsWith("https://")) throw new GitHubError("validation", res.status, "download: redirect is not https");
    try {
      const file = await this.fetchFn(location, { method: "GET", redirect: "follow", signal });
      if (!file.ok) throw new GitHubError(file.status >= 500 ? "server" : "validation", file.status, `download: HTTP ${file.status}`);
      if (!file.body) return "";
      // Keep a rolling tail: a long log never sits in memory whole.
      const chunks: Uint8Array[] = [];
      let kept = 0;
      for await (const chunk of file.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
        kept += chunk.length;
        while (chunks.length > 1 && kept - chunks[0]!.length >= maxBytes) kept -= chunks.shift()!.length;
      }
      const all = Buffer.concat(chunks);
      return all.subarray(Math.max(0, all.length - maxBytes)).toString("utf8");
    } catch (e) {
      throw e instanceof GitHubError ? e : net(e);
    }
  }

  /** GraphQL. Mutations are never retried; errors are classified by type. */
  async graphql<T>(query: string, variables: Record<string, unknown>, mutation: boolean): Promise<T> {
    const res = mutation
      ? await this.once<{ data?: T; errors?: { type?: string; message: string }[] }>("POST", this.url("graphql"), { query, variables })
      : await this.request<{ data?: T; errors?: { type?: string; message: string }[] }>("POST", "graphql", { body: { query, variables } });
    const errors = res.json?.errors;
    if (errors && errors.length > 0) {
      const message = errors.map((x) => x.message).join("; ");
      if (errors.every((x) => !x.type && GRAPHQL_INTERNAL.test(x.message))) throw new GitHubError("server", res.status, message, null, true);
      const e = errors[0]!;
      const kind: ErrorKind =
        e.type === "NOT_FOUND" ? "not_found" : e.type === "FORBIDDEN" ? "auth" : e.type === "RATE_LIMITED" ? "rate_limit" : e.type === "STALE_DATA" ? "conflict" : "validation";
      throw new GitHubError(kind, res.status, message);
    }
    if (!res.json?.data) throw new GitHubError("server", res.status, "GraphQL response has no data");
    return res.json.data;
  }
}
