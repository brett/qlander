// The App manifest flow (docs/deployment.md §5.2 `apps`), the part a person
// does in a browser. A local page POSTs the manifest to GitHub's "new App"
// form for the owner; the owner clicks Create; GitHub redirects back to the
// local page with a one-hour `code`. If the browser cannot reach this machine
// (a remote VM), the person pastes the `code` (or the whole address) from the
// address bar into the terminal instead. The page is also written to a file,
// so it can be opened on another machine.

import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Manifest } from "./context";
import type { AppSpec } from "./expected";

const CODE = /^[A-Za-z0-9_-]{1,200}$/;

/** A pasted line as a code: the bare code, or an address with `code=`. */
export function codeFromLine(line: string): string | null {
  const t = line.trim();
  if (CODE.test(t)) return t;
  const m = /[?&]code=([A-Za-z0-9_-]{1,200})/.exec(t);
  return m ? m[1]! : null;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function manifestPage(action: string, manifest: Manifest): string {
  return [
    "<!doctype html>",
    '<meta charset="utf-8"><title>Create GitHub App</title>',
    `<form id="f" method="post" action="${escapeHtml(action)}">`,
    `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">`,
    `<p>Create the GitHub App <b>${escapeHtml(manifest.name)}</b>: <button type="submit">Continue to GitHub</button></p>`,
    "</form>",
  ].join("\n");
}

export interface FlowOptions {
  web: string;
  out(line: string): void;
  timeoutMs: number;
  /** Lines the person may paste a code into; null to listen only for the redirect. */
  input: NodeJS.ReadableStream | null;
}

export async function browserManifestCode(spec: AppSpec, manifest: Manifest, o: FlowOptions): Promise<string> {
  const state = randomBytes(16).toString("hex");
  const action = `${o.web}/organizations/${encodeURIComponent(spec.owner)}/settings/apps/new?state=${state}`;
  let resolve!: (code: string) => void;
  const got = new Promise<string>((r) => (resolve = r));
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req): Response {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response(manifestPage(action, { ...manifest, redirect_url: `http://127.0.0.1:${server.port}/callback` }), { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code") ?? "";
        if (url.searchParams.get("state") !== state || !CODE.test(code)) return new Response("unexpected callback", { status: 400 });
        resolve(code);
        return new Response("The App was created. Return to the terminal.", { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const file = join(mkdtempSync(join(tmpdir(), "setup-app-")), `${spec.slug}.html`);
  writeFileSync(file, manifestPage(action, { ...manifest, redirect_url: `http://127.0.0.1:${server.port}/callback` }), { mode: 0o600 });
  o.out(`todo  create the ${spec.role} App ${spec.name}: open http://127.0.0.1:${server.port}/ in a browser on this machine, continue to GitHub and click "Create GitHub App"`);
  o.out(`        no browser here? open ${file} elsewhere; after Create, paste the code= value from the address bar here`);
  const rl = o.input ? createInterface({ input: o.input }) : null;
  rl?.on("line", (line) => {
    const code = codeFromLine(line);
    if (code) resolve(code);
    else o.out("        that is not a code; paste the code= value from the address bar");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no App was created for ${spec.name} within ${Math.round(o.timeoutMs / 60000)} minutes`)), o.timeoutMs);
  });
  try {
    return await Promise.race([got, timeout]);
  } finally {
    clearTimeout(timer);
    rl?.close();
    // Graceful: the callback that resolved us still gets its answer.
    void server.stop();
  }
}
