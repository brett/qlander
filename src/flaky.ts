// Flaky tracking (DESIGN.md §10). A red batch is rerun once; when that rerun
// passes, the first attempt's failed jobs were flaky. The machine records
// them (history, the weekly marks) and queues one `flaky` notice; the outbox
// opens or updates one issue per flaky test in the control repo, keyed by the
// test id parsed from the job's log, or by the job name when no id could be
// parsed. Anything that tracks work elsewhere is filed from those issues.
//
// Everything here is pure. Job logs are target output: they are only matched
// against fixed patterns, and what comes out is cut to a short, plain id.

import type { FlakyItem } from "./state";
import type { FailedJob } from "./types";

/** The issue label in this repo, beside `pause` (src/outbox.ts) and the release labels. */
export const FLAKY_LABEL = "flaky";

/** More failing tests than this in one job reads as a broken job, not one flaky test: it is tracked by job name. */
export const MAX_TESTS_PER_JOB = 10;
/** The most first-attempt job logs read when a rerun passes. */
export const MAX_LOGS = 4;
/** No log download starts this long after the first (each has its own 15 s deadline, src/github/target.ts). */
export const LOG_BUDGET_MS = 30_000;
/** The most items (issues) one flaky batch opens or updates. */
export const MAX_ITEMS = 20;
/** Occurrence lines kept in an issue body; older ones are dropped. */
export const MAX_OCCURRENCES = 50;
/** One tick spends at most this long writing flaky issues; the rest waits for the next tick (receipts are kept per item). */
export const WRITE_BUDGET_MS = 20_000;
/** How long a flaky notice keeps retrying before it is dropped (it never pauses the queue). */
export const GIVE_UP_HOURS = 24;

const MAX_ID = 200;

const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 16);

/** Test keys and job keys never share an identity, even when a job is named like a test. */
const identity = (item: { key: string; byJob: boolean }) => hash(`${item.byJob ? "job" : "test"}:${item.key}`);
/** The marker that makes an issue the one for this item's key. */
export const keyMarker = (item: { key: string; byJob: boolean }) => `<!-- qlander:flaky-test:${identity(item)} -->`;
/** The marker of one occurrence (batch n) in that issue. */
export const occurrenceMarker = (n: number, item: { key: string; byJob: boolean }) => `<!-- qlander:flaky:${n}:${identity(item)} -->`;

/** The job id in a job's html_url (…/actions/runs/<run>/job/<id>), for records that lack `id`. */
export function jobId(j: FailedJob): number | null {
  if (typeof j.id === "number" && Number.isSafeInteger(j.id) && j.id > 0) return j.id;
  const m = /\/job\/([1-9][0-9]{0,15})(?:[/?#]|$)/.exec(j.url);
  return m ? Number(m[1]) : null;
}

/**
 * A single-line id with no markdown or HTML specials (backticks and angle
 * brackets are swapped for look-alikes; other Unicode is kept, so distinct
 * ids stay distinct). An id longer than MAX_ID is cut, with a hash of the
 * whole id appended, so two long ids never collide.
 */
export function cleanId(s: string): string {
  const c = s
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .replace(/[`<>]/g, (x) => (x === "`" ? "'" : x === "<" ? "‹" : "›"))
    .replace(/\s+/g, " ")
    .trim();
  return c.length <= MAX_ID ? c : `${c.slice(0, MAX_ID - 18)}…#${hash(c).slice(0, 12)}`;
}

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

// Each pattern is anchored and free of a lazy group before an optional
// suffix, so a hostile line costs time linear in its length; suffixes are cut
// afterwards. Lines are whitespace-collapsed first, and longer ones skipped.
const PYTEST_SUMMARY = /^(?:\[gw\d+\] \[ ?\d+%\] )?(?:FAILED|ERROR) ([\w./-]+\.py::\S.*)$/;
const PYTEST_VERBOSE = /^([\w./-]+\.py::\S+) (?:FAILED|ERROR)\b/;
const VITEST = /^(?:FAIL|×|✗) (\S+\.(?:test|spec)\.[cm]?[jt]sx?) > (.+)$/;
const DURATION = /^(.*) \d+(?:\.\d+)? ?m?s$/;
const PW_SECTION = /^(\d+) (failed|flaky|skipped|passed|did not run|interrupted)\b/;
const PW_TEST = /^\[([^\]]+)\] › (.+)$/;
/** A summary line longer than this is not a test id line: it is skipped unparsed. */
export const MAX_LINE = 1000;

/** `s` without a trailing run of box-drawing rules (Playwright pads with them). */
function trimRule(s: string): string {
  let e = s.length;
  while (e > 0 && s[e - 1] === "─") e--;
  return s.slice(0, e).trimEnd();
}

/**
 * The failing test ids in a job log: pytest (FAILED/ERROR node ids), vitest
 * (FAIL file > suite > test) and Playwright (the "N failed" summary, never
 * its "flaky" section, which passed on a retry inside the job). Deduplicated,
 * in order of appearance, at most MAX_TESTS_PER_JOB + 1 (enough to tell that
 * there were too many).
 */
export function parseFailingTests(log: string): string[] {
  const out: string[] = [];
  const add = (id: string) => {
    const c = cleanId(id);
    if (c && !out.includes(c)) out.push(c);
  };
  let pwFailed = false;
  for (const raw of log.split("\n")) {
    if (out.length > MAX_TESTS_PER_JOB) break;
    if (raw.length > MAX_LINE * 2) {
      pwFailed = false;
      continue;
    }
    const line = raw.replace(TIMESTAMP, "").replace(ANSI, "").replace(/\s+/g, " ").trim();
    if (line.length > MAX_LINE) {
      pwFailed = false;
      continue;
    }
    const section = PW_SECTION.exec(line);
    if (section) {
      pwFailed = section[2] === "failed";
      continue;
    }
    const sum = PYTEST_SUMMARY.exec(line);
    if (sum) {
      const cut = sum[1]!.indexOf(" - ", 1);
      add(cut < 0 ? sum[1]! : sum[1]!.slice(0, cut));
      continue;
    }
    const verbose = PYTEST_VERBOSE.exec(line);
    if (verbose) {
      add(verbose[1]!);
      continue;
    }
    const vi = VITEST.exec(line);
    if (vi) {
      add(`${vi[1]} > ${DURATION.exec(vi[2]!)?.[1] ?? vi[2]}`);
      continue;
    }
    if (pwFailed) {
      const pw = PW_TEST.exec(line);
      if (pw) add(`[${pw[1]}] › ${trimRule(pw[2]!).replace(/:\d+:\d+(?= ›|$)/g, "")}`);
      else if (line !== "") pwFailed = false;
    }
  }
  return out;
}

/**
 * The issues one flaky batch touches: one per failing test, or one per job
 * when its log gave no test id or too many. Deduplicated by key, capped.
 */
export function flakyItems(jobs: FailedJob[]): FlakyItem[] {
  const out: FlakyItem[] = [];
  for (const j of jobs) {
    const name = cleanId(j.name) || "unnamed job";
    const tests = j.tests ?? [];
    const keys = tests.length > 0 && tests.length <= MAX_TESTS_PER_JOB ? tests.map((t) => ({ key: t, byJob: false })) : [{ key: name, byJob: true }];
    for (const k of keys) if (!out.some((o) => o.key === k.key && o.byJob === k.byJob)) out.push({ ...k, job: name, url: j.url });
  }
  return out.slice(0, MAX_ITEMS);
}

const safeUrl = (u: string) => (/^https:\/\/github\.com\/[\w./%-]+$/.test(u) ? u : null);

/** One occurrence line, ending with its marker. */
export function occurrenceLine(item: FlakyItem, n: number, at: string, runs: { runId: number; attempt: number }[]): string {
  const url = safeUrl(item.url);
  const job = url ? `[\`${item.job}\`](${url})` : `\`${item.job}\``;
  const runList = runs.map((r) => `${r.runId} attempt ${r.attempt}`).join(", ") || "unknown";
  return `- ${at.slice(0, 16).replace("T", " ")}Z · batch ${n} · ${job} failed, its rerun passed · runs ${runList} ${occurrenceMarker(n, item)}`;
}

export function issueTitle(item: FlakyItem): string {
  return `flaky: ${item.byJob ? `job ${item.key}` : item.key}`.slice(0, 240);
}

export function issueBody(item: FlakyItem, line: string): string {
  const what = item.byJob ? `the job \`${item.key}\` (no single failing test could be read from its log)` : `\`${item.key}\` (in the job \`${item.job}\`)`;
  return [
    `Flaky in the landing queue: ${what}. A batch failed on it, and the single rerun of the failed jobs passed on the same commit.`,
    "",
    "Qlander adds a line below each time it happens again. Close this issue once the test is fixed; a later flake opens a new one.",
    "",
    keyMarker(item),
    "",
    "### Occurrences",
    line,
  ].join("\n");
}

/** The body with one more occurrence line, keeping at most MAX_OCCURRENCES of them. */
export function appendOccurrence(body: string, line: string): string {
  const lines = [...body.replace(/\s+$/, "").split("\n"), line];
  const occ = lines.flatMap((l, i) => (l.includes("<!-- qlander:flaky:") ? [i] : []));
  const drop = new Set(occ.slice(0, Math.max(0, occ.length - MAX_OCCURRENCES)));
  return lines.filter((_, i) => !drop.has(i)).join("\n");
}
