// The watchdog's text (src/watchdog-render.ts, and the escaping in
// src/watchdog-core.ts): tick log reports, mirror summaries, the status body,
// and hostile titles, bodies and report fields. No network.

import { describe, expect, test } from "bun:test";
import { QUEUE_JOB_NAME, RELEASE_JOB_NAME } from "../src/main";
import { emptyReleaseState, renderReleaseState } from "../src/release-state";
import { emptyState, renderState, type State } from "../src/state";
import { code, esc, evaluate, fenced, safeUrl } from "../src/watchdog-core";
import { extractTickReport, renderStatus, type StatusInput, summariseQueueState, summariseReleaseState } from "../src/watchdog-render";
import { ago, issue, NOW, obs, run } from "./watchdog-fake";
import { ISSUE_LABELS, CONTROL_SLUG } from "./sim";

const base = (over: Partial<StatusInput> = {}): StatusInput => ({
  now: NOW,
  runUrl: `https://github.com/${CONTROL_SLUG}/actions/runs/1`,
  modeVar: undefined,
  releaseHeldByConfig: true,
  evaluation: { alerts: [], warnings: [], unknown: [], notes: [] },
  runs: [],
  newest: null,
  labels: ISSUE_LABELS,
  queueMirror: null,
  releaseMirror: null,
  openIssues: [],
  ...over,
});

/** Outside code (fenced blocks and inline spans, which GitHub never interprets), nothing may mention or open HTML or a comment. */
function inert(body: string): void {
  const prose = body
    .replace(/^<!-- qlander-status -->\n/, "")
    .replace(/^````text\n[\s\S]*?\n````$/gm, "")
    .replace(/`[^`\n]*`/g, "");
  expect(prose).not.toMatch(/@[A-Za-z0-9]/); // a mention needs a word character straight after @
  expect(prose).not.toMatch(/<[A-Za-z!/]/);
  expect(prose).not.toMatch(/\]\(https:\/\/evil/);
}

describe("tick logs and mirrors", () => {
  test("finds the JSON report the tick prints last, under the Actions timestamps", () => {
    const report = { mode: "dry-run", log: ["idle: nothing to land"], wouldDo: null };
    const lines = ["##[group]Run set -euo pipefail", "{", "not json", "}", ...JSON.stringify(report, null, 1).split("\n")];
    const log = `\uFEFF${lines.map((l) => `2026-10-22T11:50:01.1234567Z ${l}`).join("\r\n")}\r\n`;
    expect(extractTickReport(log)).toEqual(report);
    expect(extractTickReport("2026-10-22T11:50:00.0Z error: boom\n")).toBeNull();
  });

  test("summarises the queue and release mirrors; an unreadable body says so", () => {
    const q = { ...emptyState(), seq: 12, active: { n: 4, prs: [1401, 1403], phase: "testing" } } as unknown as State;
    expect(summariseQueueState(`Mirror of the qlander-state branch.\n\n${renderState(q)}`)).toEqual([
      "seq 12 · batch 4 (PR 1401, PR 1403) testing",
      "pending 0 · solo 0 · admitted 0 · verifying 0",
      "last landed never · red streak 0 · bounce streak 0",
    ]);
    const r = { ...emptyReleaseState(), seq: 3, last: { at: "2026-10-22T11:40:00Z", kind: "none" as const, reason: "release is at main", release: null, main: null } };
    expect(summariseReleaseState(renderReleaseState(r))).toEqual(["seq 3 · last check none at 2026-10-22T11:40:00Z: release is at main"]);
    expect(summariseQueueState("hand edited")).toEqual(["(the mirror has no readable state block)"]);
  });

  test("warns on the status issue at 75% of the window budget", () => {
    const at = (cost: number) => ({ ...emptyState(), window: Array.from({ length: cost }, (_, i) => ({ at: `2026-10-22T11:${String(i % 60).padStart(2, "0")}:00Z`, cost: 1 })) });
    const body = (cost: number) => `Mirror.\n\n${renderState(at(cost) as State)}`;
    const b = { window: 96, windowHours: 24, now: new Date("2026-10-22T12:00:00Z") };
    expect(summariseQueueState(body(71), b).at(-1)).toBe("window budget: 71 of 96 full-suite runs used");
    // Expired reservations do not count, as in the queue's own accounting.
    expect(summariseQueueState(body(72), { ...b, now: new Date("2026-10-23T12:00:00Z") }).at(-1)).toBe("window budget: 0 of 96 full-suite runs used");
    expect(summariseQueueState(body(72), b).at(-1)).toBe("**warning:** window budget: 72 of 96 full-suite runs used (at or above 75%; the queue pauses at the limit)");
    expect(summariseQueueState(body(72)).at(-1)).toBe("last landed never · red streak 0 · bounce streak 0");
  });
});

describe("status body", () => {
  test("the overall line, the mode and the watchdog run's link come first", () => {
    expect(renderStatus(base()).split("\n").slice(0, 3)).toEqual([
      "<!-- qlander-status -->",
      "## OK · 2026-10-22 12:00 UTC",
      `[watchdog run](https://github.com/${CONTROL_SLUG}/actions/runs/1) · mode: dry-run (QLANDER_MODE is unset)`,
    ]);
    expect(renderStatus(base({ modeVar: "live" }))).toContain("mode: live (release advance held in dry run by src/release-config.ts)");
    expect(renderStatus(base({ evaluation: { alerts: [], warnings: [{ detail: "w" }], unknown: [], notes: [] } }))).toContain("\n## WARN · ");
    expect(renderStatus(base({ evaluation: { alerts: [], warnings: [], unknown: [{ kind: "ticks-failing", reason: "r" }], notes: [] } }))).toContain("**Could not check**");
    expect(renderStatus(base({ evaluation: { alerts: [{ kind: "paused", key: "1", detail: "paused for 3h: x" }], warnings: [], unknown: [], notes: [] } }))).toContain("\n## ALERT · ");
  });

  test("the last 5 ticks, the newest tick's log and wouldDo or outcome, open issues with their age", () => {
    const runs = Array.from({ length: 7 }, (_, i) => run({ createdAt: ago(10 * i + 1) }, { completedAt: ago(10 * i) }));
    const b = renderStatus(
      base({
        runs,
        newest: {
          run: runs[0]!,
          reports: [
            { job: QUEUE_JOB_NAME, report: { mode: "dry-run", log: ["idle: nothing to land"], wouldDo: { kind: "build", n: 4 } } },
            { job: RELEASE_JOB_NAME, report: { outcome: "none", log: [], decision: { kind: "none", reason: "release is at main" } } },
          ],
        },
        openIssues: [{ label: "pause", issue: issue(7, "pause: main is red", 125) }],
      }),
    );
    expect(b.match(/^- \d\d-\d\d \d\d:\d\d · queue success · release skipped · \[run\]\(https:\/\/github\.com\/[^)]+\)$/gm)).toHaveLength(5);
    expect(b).toContain('- would do: `{"kind":"build","n":4}`');
    expect(b).toContain("\nidle: nothing to land\n");
    expect(b).toContain("**Release** (live, outcome **none**)");
    expect(b).toContain("- decision: none: release is at main");
    expect(b).toContain("No state mirror issues yet");
    expect(b).toContain(`- pause [issue 7](https://github.com/${CONTROL_SLUG}/issues/7) pause: main is red · 2h 5m`);
  });

  test("unreadable logs drop the section with a note; a pin failure goes in the footer", () => {
    const b = renderStatus(base({ logsNote: "Job logs could not be read with this token (x); open the run instead.", pinNote: "The watchdog could not pin this issue (y); pin it by hand." }));
    expect(b).toContain("Job logs could not be read with this token");
    expect(b.trim().split("\n").at(-1)).toContain("could not pin this issue");
  });
});

describe("untrusted text is escaped everywhere", () => {
  const HOSTILE = "@victim\n<!-- hide --> **bold** [x](https://evil.example) `tick` #12 <img src=x> | a";

  test("esc, code and fenced neutralise mentions, HTML, Markdown, newlines and backticks", () => {
    const e = esc(HOSTILE);
    expect(e).not.toMatch(/[\n\r<>]|@[a-z]|#1|(?<!\\)[`*[\]()!|]/); // every Markdown character is backslash-escaped
    expect(e).toContain("&lt;\\!--");
    expect(code("a`b\nc")).toBe("`a'b c`");
    expect(fenced(["````", "x"])).toEqual(["````text", "''''", "x", "````"]);
    expect(safeUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeUrl(`https://github.com/${CONTROL_SLUG}/issues/1)`)).toBeUndefined();
  });

  test("hostile pause, release-blocked and alert titles", () => {
    const e = evaluate(obs({ pause: [issue(7, HOSTILE, 300)], releaseBlocked: [issue(8, HOSTILE, 10)] }));
    const b = renderStatus(base({ evaluation: e, openIssues: [{ label: "pause", issue: issue(7, HOSTILE, 300) }] }));
    inert(b);
    expect(b.split("\n").filter((l) => l.includes("hide"))).toHaveLength(3); // each on its own list line, none broken out
  });

  test("hostile mirror bodies: wrong types show as ?, strings are escaped", () => {
    const queue = `\`\`\`json qlander-state\n${JSON.stringify({ seq: "@victim\n<!--", active: { n: "<b>", prs: ["@victim", 5], phase: "@victim\n<!--" }, pending: "x", auth: [], redStreak: { a: 1 }, lastLandedAt: "@victim" })}\n\`\`\``;
    const release = `\`\`\`json\n${JSON.stringify({ seq: 1, last: { kind: "@victim", at: "<!--", reason: "@victim\n<!--" }, journal: { before: "@victim", after: "zz" }, history: [{ outcome: "<b>", at: 1, from: "@victim", to: "x" }] })}\n\`\`\``;
    const q = summariseQueueState(queue);
    expect(q[0]).toBe("seq ? · batch ? (PR ?, PR 5) @\u200bvictim &lt;\\!--");
    const b = renderStatus(base({ queueMirror: issue(3, "q", 1, queue), releaseMirror: issue(4, "r", 1, release) }));
    inert(b);
    expect(b).not.toContain("@victim");
  });

  test("hostile tick report fields: outcome, refused, wouldDo, decision, log", () => {
    const report = {
      mode: "dry-run",
      refused: HOSTILE,
      wouldDo: { kind: "x`y`\n@victim" },
      decision: { kind: HOSTILE, reason: HOSTILE },
      log: [HOSTILE, "````", "```", 42, { a: 1 }],
    };
    const live = { outcome: HOSTILE, log: "@victim not an array" };
    const r = run({}, { completedAt: ago(1) });
    const b = renderStatus(base({ runs: [r], newest: { run: r, reports: [{ job: QUEUE_JOB_NAME, report }, { job: RELEASE_JOB_NAME, report: live }] } }));
    // Outside the fenced log, nothing is live.
    inert(b);
    expect(b).toContain("`{\"kind\":\"x'y'\\n@victim\"}`"); // wouldDo: one inline code span, backticks neutralised
    // The fenced log holds every line on its own and cannot be closed early.
    const fence = /^````text\n([\s\S]*?)\n````$/m.exec(b)![1]!.split("\n");
    expect(fence).toHaveLength(5);
    expect(fence.some((l) => l.includes("`"))).toBe(false);
  });
});
