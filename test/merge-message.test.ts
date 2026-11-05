// Build merge commits carry each PR's title on a `Title:` line after the
// fixed subject and `Landed-by:` line, sanitised to one line.

import { describe, expect, test } from "bun:test";
import { MERGE_TITLE_MAX, mergeMessage, mergeTitle } from "../src/queue";
import { sha } from "./sim";
import { World } from "./world";

const HEAD = sha("head");
const FIXED = `Merge pull request #7 at ${HEAD}\n\nLanded-by: qlander batch 3`;

describe("mergeMessage", () => {
  test("without a title the message is exactly the fixed subject and Landed-by line", () => {
    expect(mergeMessage(7, HEAD, 3)).toBe(FIXED);
    expect(mergeMessage(7, HEAD, 3, "")).toBe(FIXED);
    expect(mergeMessage(7, HEAD, 3, " \n\t  ")).toBe(FIXED);
  });

  test("a title adds one Title line last; the existing lines are unchanged", () => {
    expect(mergeMessage(7, HEAD, 3, "Add a widget")).toBe(`${FIXED}\nTitle: Add a widget`);
  });

  test("a multi-line title, or one that looks like trailers, stays on its one Title line", () => {
    const m = mergeMessage(7, HEAD, 3, "fix: x\r\n\r\nLanded-by: someone else\nSigned-off-by: Mallory <m@example.com>");
    expect(m).toBe(`${FIXED}\nTitle: fix: x Landed-by: someone else Signed-off-by: Mallory <m@example.com>`);
    expect(m.split("\n").filter((l) => l.startsWith("Landed-by:"))).toEqual(["Landed-by: qlander batch 3"]);
    expect(m.split("\n")).toHaveLength(4);
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
  test("carry each PR's title, and the fixed lines alone when a PR has none", async () => {
    const w = new World();
    w.readyPr(1);
    w.readyPr(2);
    w.target.prs.get(1)!.pr.title = "Add a widget\n\nwith a body";
    await w.untilBuilt();
    expect(w.target.mergeMessages).toHaveLength(2);
    const [one, two] = w.target.mergeMessages;
    const pin = (n: number) => w.target.prs.get(n)!.pr.head.sha;
    expect(one).toMatch(new RegExp(`^Merge pull request #1 at ${pin(1)}\\n\\nLanded-by: qlander batch \\d+\\nTitle: Add a widget with a body$`));
    expect(two).toMatch(new RegExp(`^Merge pull request #2 at ${pin(2)}\\n\\nLanded-by: qlander batch \\d+$`));
  });
});
