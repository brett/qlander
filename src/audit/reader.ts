// The audit's only way to GitHub: GET requests, through the shared HTTP layer
// (retries for reads, error classification, pagination). There is no method
// that takes a verb, so no check can write, whatever it is passed.

import { GitHubError, Http, type HttpOptions } from "../github/http";
import type { AuditGh } from "./types";

export function auditReader(opts: HttpOptions): AuditGh {
  const http = new Http(opts);
  return {
    async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
      const { json } = await http.request<T>("GET", path, query ? { query } : {});
      if (json === null || json === undefined) throw new GitHubError("server", null, `GET ${path}: the response has no JSON body`);
      return json;
    },
    list<T>(path: string, query: Record<string, string | number | undefined>, pick: (page: unknown) => T[] | undefined) {
      return http.paginate<T>(
        path,
        query,
        (page) => {
          const items = pick(page);
          if (!Array.isArray(items)) throw new GitHubError("server", null, `GET ${path}: the response has no list`);
          return items;
        },
        10,
      );
    },
  };
}
