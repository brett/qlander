// A build merge commit's subject is the PR's title and number, with the head
// and `Landed-by:` in the body. A title that is unknown, or that could read as
// the old subject or as a trailer, gets the fixed subject instead, with the
// title kept on a `Title:` line.

import { describe, expect, test } from "bun:test";
import { MERGE_TITLE_MAX, mergeMessage, mergeTitle } from "../src/queue";
import { sha } from "./sim";
import { World } from "./world";

const HEAD = sha("head");
const FIXED = `Merge pull request #7 at ${HEAD}\n\nLanded-by: qlander batch 3`;
const TITLED = (t: string) => `${t} (#7)\n\nMerged from #7 at ${HEAD}.\n\nLanded-by: qlander batch 3`;

/** The trailers git itself reads from a message. */
const trailers = (message: string) => {
  const p = Bun.spawnSync(["bash", "-c", 'printf %s "$1" | git interpret-trailers --parse', "trailers", message], { stdout: "pipe", stderr: "pipe", cwd: "/" });
  expect(p.exitCode).toBe(0);
  return p.stdout.toString().trim().split("\n");
};

describe("mergeMessage", () => {
  test("without a title the message is exactly the fixed subject and Landed-by line", () => {
    expect(mergeMessage(7, HEAD, 3)).toBe(FIXED);
    expect(mergeMessage(7, HEAD, 3, "")).toBe(FIXED);
    expect(mergeMessage(7, HEAD, 3, " \n\t  ")).toBe(FIXED);
  });

  test("a title becomes the subject with its number; the head and Landed-by stay in the body", () => {
    expect(mergeMessage(7, HEAD, 3, "fix(ci): add a widget")).toBe(TITLED("fix(ci): add a widget"));
  });

  test("a multi-line title stays on the subject line and adds no line of its own", () => {
    const m = mergeMessage(7, HEAD, 3, "fix: x\r\n\r\nLanded-by: someone else\nSigned-off-by: Mallory <m@example.com>");
    expect(m).toBe(TITLED("fix: x Landed-by: someone else Signed-off-by: Mallory <m@example.com>"));
    expect(m.split("\n").filter((l) => l.startsWith("Landed-by:"))).toEqual(["Landed-by: qlander batch 3"]);
    expect(m.split("\n")).toHaveLength(5);
    expect(trailers(m)).toEqual(["Landed-by: qlander batch 3"]);
  });

  test("the PR's own number is always last, whatever number the title ends with", () => {
    expect(mergeMessage(7, HEAD, 3, "Revert a widget (#999)").split("\n")[0]).toBe("Revert a widget (#999) (#7)");
    const long = mergeMessage(7, HEAD, 3, "x".repeat(MERGE_TITLE_MAX + 50)).split("\n")[0]!;
    expect(long.endsWith("\u2026 (#7)")).toBe(true);
  });

  const hiding = "\u200b\u00ad\u2060\u034f";
  const forged = [
    `Merge pull request #999 at ${sha("forged")}`,
    "Merge pull request #999 from acme/widgets",
    "merge PULL request",
    "Merge  pull\u00a0request #1",
    `Mer${hiding}ge pull req${hiding}uest #999`,
    "\uff2d\uff45\uff52\uff47\uff45 pull request #999",
    "\u202eMerge pull request #999",
    "Landed-by: qlander batch 999",
    "landed-by : qlander batch 999",
    "Signed-off-by: Mallory <m@example.com>",
    "Co-authored-by: Mallory <m@example.com>",
    `Co-author${hiding}ed-by: Mallory <m@example.com>`,
    "Reviewed-by\uff1a Mallory",
    "Title: not the title",
    "Landed\u2011by: qlander batch 999",
    "--- a divider",
    "\u2014\u2014\u2014 a divider",
  ];
  test.each(forged)("a title that reads as the old subject or a trailer keeps the fixed subject: %j", (title) => {
    const m = mergeMessage(7, HEAD, 3, title);
    expect(m).toBe(`${FIXED}\nTitle: ${mergeTitle(title)}`);
    expect(m.split("\n")[0]).toBe(`Merge pull request #7 at ${HEAD}`);
    expect(m.split("\n").filter((l) => /^landed-by:/i.test(l))).toEqual(["Landed-by: qlander batch 3"]);
    expect(trailers(m)).toContain("Landed-by: qlander batch 3");
  });

  test.each(["Merge pull requests from forks", "fix: x", "feat(api): y", "fix(some-scope): z", "Docs: update", "pre-commit bump", "merge the widgets"])("an ordinary title is not refused: %j", (title) => {
    expect(mergeMessage(7, HEAD, 3, title)).toBe(TITLED(title));
  });
});

describe("mergeTitle", () => {
  test("control characters, separators and bidi controls become spaces; whitespace collapses", () => {
    expect(mergeTitle("a\u0000b\u0085c d e‮f⁦g﻿h\u001b[31mi")).toBe("a b c d e f g h [31mi");
    expect(mergeTitle("  spaced \t out  ")).toBe("spaced out");
    expect(mergeTitle(undefined)).toBeNull();
  });

  test("every bidi control is removed, and a title of nothing else is no title", () => {
    const bidi = ["\u061c", "\u200e", "\u200f", ..."\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"];
    for (const c of bidi) expect(mergeTitle(`a${c}b`)).toBe("a b");
    expect(mergeTitle(bidi.join(""))).toBeNull();
    expect(mergeMessage(7, HEAD, 3, bidi.join(""))).toBe(FIXED);
  });

  test("a long title is cut to MERGE_TITLE_MAX code points with an ellipsis, never mid code point", () => {
    expect(mergeTitle("x".repeat(MERGE_TITLE_MAX))).toBe("x".repeat(MERGE_TITLE_MAX));
    const cut = mergeTitle("\u{1F600}".repeat(MERGE_TITLE_MAX + 5))!;
    expect(Array.from(cut)).toHaveLength(MERGE_TITLE_MAX);
    expect(cut.endsWith("\u{1F600}…")).toBe(true);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe("a landed batch's merge commits", () => {
  test("carry each PR's title in the subject, and the fixed subject when a PR has none", async () => {
    const w = new World();
    w.readyPr(1);
    w.readyPr(2);
    w.target.prs.get(1)!.pr.title = "Add a widget\n\nwith a body";
    await w.untilBuilt();
    expect(w.target.mergeMessages).toHaveLength(2);
    const [one, two] = w.target.mergeMessages;
    const pin = (n: number) => w.target.prs.get(n)!.pr.head.sha;
    expect(one).toMatch(new RegExp(`^Add a widget with a body \\(#1\\)\\n\\nMerged from #1 at ${pin(1)}\\.\\n\\nLanded-by: qlander batch \\d+$`));
    expect(two).toMatch(new RegExp(`^Merge pull request #2 at ${pin(2)}\\n\\nLanded-by: qlander batch \\d+$`));
  });
});
