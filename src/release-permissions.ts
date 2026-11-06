// The release App's permissions on the target (DESIGN.md §12.1), from the
// release config. Pure and free of the config loader, so the renderer, setup
// and audit can all import it without loading qlander.yml.

import type { ReleaseConfig } from "./release-config";

/**
 * The release App's token permissions on the target (DESIGN.md §12.1). The
 * dispatch mode adds Actions: write, to dispatch the target's workflow, and,
 * with a freeze, Variables: read. Rendered into tick.yml, requested by setup
 * and checked by audit, so the three cannot drift apart.
 */
export function releaseTokenPermissions(r: Pick<ReleaseConfig, "mode" | "dispatch">): Record<string, string> {
  const dispatch = r.mode === "dispatch";
  return {
    contents: "write",
    workflows: "write",
    actions: dispatch ? "write" : "read",
    checks: "read",
    statuses: "read",
    ...(dispatch && r.dispatch && r.dispatch.freeze.length > 0 ? { actions_variables: "read" } : {}),
  };
}
