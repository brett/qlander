// The operator control commands' names and usage (src/control-cli.ts), apart
// from their code so that src/cli.ts can list and route them without
// loading it.

export const CONTROL_USAGE = [
  "  pause queue|release|both                       open the pause issue(s)",
  "  resume queue|release|both [--all]              close the pause issue(s) a control opened (--all: every one)",
  "  quiesce                                        pause both jobs, disable tick.yml, wait, check the state is idle",
  "  unquiesce [--all]                              enable tick.yml, check a paused tick, resume, check a live tick",
  "  remove|requeue|prioritise <pr>                 label the PR bounce, ready or priority",
  "  approve-policy <pr> <sha>                      post the CI-policy approval for that exact head",
  "  approve-release <sha>                          post the release approval for that exact candidate (release.mode dispatch)",
  "  rearm-release <sha>                            grant that sha one more release attempt after its last one ended (release.mode dispatch)",
  "                                                 each also takes --dry-run and --config <file>",
  "                                                 (token: GH_TOKEN or GITHUB_TOKEN, the operator's own)",
].join("\n");

export const CONTROL_COMMANDS = ["pause", "resume", "quiesce", "unquiesce", "remove", "requeue", "prioritise", "approve-policy", "approve-release", "rearm-release"] as const;
export type ControlCommand = (typeof CONTROL_COMMANDS)[number];
export const isControlCommand = (c: string | undefined): c is ControlCommand => CONTROL_COMMANDS.includes(c as ControlCommand);
