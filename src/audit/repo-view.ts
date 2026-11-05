// One repository, read at one branch through the API, with every read
// cached: the audit's view of a repo's files. GET only (src/audit/types.ts).

import { GitHubError } from "../github/http";
import type { AuditGh } from "./types";
import { parseWorkflow, type Yaml } from "./workflow";

export const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface RepoInfo {
  id?: number;
  full_name: string;
  default_branch: string;
  visibility?: string;
  private?: boolean;
  permissions?: { admin?: boolean };
}

export interface FileAt {
  path: string;
  text: string;
}

/** A workflow file at the ref: its text and its parse (or the parse error). */
export interface Wf {
  path: string;
  text: string;
  wf: Yaml | null;
  error?: string;
}

export class RepoView {
  private files = new Map<string, Promise<FileAt | null>>();
  private treeP: Promise<{ paths: Set<string>; truncated: boolean } | { error: string; cause: unknown }> | null = null;

  constructor(
    readonly gh: AuditGh,
    readonly repo: string,
    readonly ref: string,
  ) {}

  info(): Promise<RepoInfo> {
    return this.gh.get<RepoInfo>(`repos/${this.repo}`);
  }

  /** A file's text at the ref, or null when it does not exist there. */
  file(path: string): Promise<FileAt | null> {
    let p = this.files.get(path);
    if (!p) {
      p = (async () => {
        try {
          const f = await this.gh.get<{ type?: string; content?: string }>(`repos/${this.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`, { ref: this.ref });
          if (f?.type !== "file" || typeof f.content !== "string") return null;
          return { path, text: Buffer.from(f.content, "base64").toString("utf8") };
        } catch (e) {
          if (e instanceof GitHubError && e.kind === "not_found") return null;
          throw e;
        }
      })();
      this.files.set(path, p);
    }
    return p;
  }

  /** The files directly in a directory at the ref (empty when it does not exist). */
  async dir(path: string): Promise<string[]> {
    try {
      const items = await this.gh.get<{ type: string; path: string }[]>(`repos/${this.repo}/contents/${path}`, { ref: this.ref });
      return Array.isArray(items) ? items.filter((i) => i.type === "file").map((i) => i.path) : [];
    } catch (e) {
      if (e instanceof GitHubError && e.kind === "not_found") return [];
      throw e;
    }
  }

  /** Every file path at the ref (the recursive git tree). */
  tree(): Promise<{ paths: Set<string>; truncated: boolean } | { error: string; cause: unknown }> {
    this.treeP ??= (async () => {
      try {
        const t = await this.gh.get<{ tree: { path: string; type: string }[]; truncated: boolean }>(`repos/${this.repo}/git/trees/${encodeURIComponent(this.ref)}`, { recursive: 1 });
        return { paths: new Set(t.tree.filter((e) => e.type === "blob").map((e) => e.path)), truncated: t.truncated };
      } catch (e) {
        return { error: why(e), cause: e };
      }
    })();
    return this.treeP;
  }

  /** Every workflow file in `.github/workflows` at the ref, parsed. */
  async workflows(): Promise<Wf[]> {
    const out: Wf[] = [];
    for (const path of (await this.dir(".github/workflows")).filter((p) => /\.ya?ml$/.test(p)).sort()) {
      const f = await this.file(path);
      if (!f) continue;
      const p = parseWorkflow(f.text);
      out.push(p.ok ? { path, text: f.text, wf: p.wf } : { path, text: f.text, wf: null, error: p.error });
    }
    return out;
  }
}
