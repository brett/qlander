// The release App's permissions on the target (DESIGN.md §12.1), from the
// release config. Pure and free of the config loader, so the renderer, setup
// and audit can all import it without loading qlander.yml.

import type { ReleaseConfig } from "./release-config";

/**
 * The release App's token permissions on the target (DESIGN.md §12.1).
 *
 * advance: Contents and Workflows write, to fast-forward release (a ref
 * update that carries workflow changes needs Workflows: write).
 *
 * dispatch: least privilege for a job that never writes release. Actions:
 * write, to dispatch the target's workflow; Contents: read, for discovery and
 * the manifest; no Workflows. With the epoch fence on, Contents: write, which
 * it needs to advance its own epoch branch; release stays out of its reach
 * because the release-landing ruleset requires a PR and no longer lists the
 * release App as a bypass actor (src/setup/expected.ts). With a freeze,
 * Variables: read. Rendered into tick.yml, requested by setup and checked by
 * audit, so the three cannot drift apart.
 */
export function releaseTokenPermissions(r: Pick<ReleaseConfig, "mode" | "dispatch">, epochFence: boolean): Record<string, string> {
  if (r.mode !== "dispatch") return { contents: "write", workflows: "write", actions: "read", checks: "read", statuses: "read" };
  return {
    contents: epochFence ? "write" : "read",
    actions: "write",
    checks: "read",
    statuses: "read",
    ...(r.dispatch && r.dispatch.freeze.length > 0 ? { actions_variables: "read" } : {}),
  };
}

/** Whether the release App bypasses the release-landing ruleset: in advance mode only (DESIGN.md §8.1, §13). */
export const releaseAppBypassesRelease = (r: Pick<ReleaseConfig, "mode">) => r.mode !== "dispatch";
