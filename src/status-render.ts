// The Status (src/status.ts) as plain text for a terminal. Pure. Every piece
// of untrusted text (issue and PR titles, notes, job names, lease owners)
// goes through plain(), so nothing read from GitHub can move the cursor,
// clear the screen or forge a line.

import type { PrLine, Status } from "./status";
import { humanAge } from "./watchdog-core";

/** Untrusted text on one terminal line: no control or escape characters, at most `max` characters. */
export function plain(x: unknown, max = 80): string {
  let s = typeof x === "string" ? x : x == null ? "" : String(x);
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const age = (x: number | null) => (x === null ? "?" : humanAge(x));
const short = (sha: string | null) => (sha ? sha.slice(0, 10) : "-");
const yesNo = (b: boolean | null) => (b === null ? "unknown (counts as paused)" : b ? "yes" : "no");

function prText(p: PrLine): string {
  const t = p.title ? ` ${plain(p.title, 60)}` : "";
  const w = p.waitMs === null ? "" : `  (waiting ${humanAge(p.waitMs)})`;
  const pri = p.priorityBy ? `  [priority by ${plain(p.priorityBy, 40)}]` : "";
  return `#${p.pr}${t}${w}${pri}`;
}

export function renderStatusText(s: Status): string {
  const out: string[] = [];
  const add = (x = "") => out.push(x);
  add(`qlander status: ${s.queueSummary.toUpperCase()}   ${s.at.slice(0, 19).replace("T", " ")} UTC`);
  add(`control ${s.control}   target ${s.target}`);
  if (s.queueState.kind === "ok") add(`queue state: seq ${s.queueState.seq} at ${short(s.queueState.version)}`);
  else add(`queue state: ${s.queueState.kind}: ${plain(s.queueState.reason, 200)}`);
  add();

  add(`paused: queue ${yesNo(s.paused.queue)}, release ${yesNo(s.paused.release)}`);
  for (const g of [s.issues.pause, s.issues.releasePause, s.issues.releaseBlocked, s.issues.alert]) {
    for (const i of g.issues) add(`  [${plain(g.label, 40)}] #${i.number} ${plain(i.title, 70)} (open ${age(i.ageMs)})`);
  }

  if (s.lease) {
    const ex = s.lease.executor ? `  ${s.lease.executor.url}` : "";
    const left = s.lease.expiresInMs >= 0 ? `expires in ${humanAge(s.lease.expiresInMs)}` : `expired ${humanAge(-s.lease.expiresInMs)} ago`;
    add(`lease: ${plain(s.lease.owner, 80)}, held ${age(s.lease.ageMs)}, ${left}${ex}`);
  } else if (s.queueState.kind === "ok") add("lease: free (no tick is running)");
  if (s.op) add(`op in flight: ${s.op.kind} since ${humanAge(s.op.ageMs)} ago (tries ${s.op.tries})`);
  add();

  if (s.active) {
    const a = s.active;
    const usual = a.usualMs === null ? "" : ` (usual ${humanAge(a.usualMs)}: median of the last ${a.usualOver} green CI runs on queue refs)`;
    add(`active batch ${a.n} on ${a.ref} at ${short(a.head)}: ${a.prs.length} PR(s), depth ${a.depth}, lineage ${a.lineage}${a.rerunRequested ? ", rerun requested" : ""}`);
    add(`  elapsed ${humanAge(a.elapsedMs)}${usual}`);
    for (const p of a.prs) add(`  ${prText(p)}`);
    for (const r of a.runs) add(`  CI ${plain(r.path, 60)} attempt ${r.attempt}: ${r.status}${r.conclusion ? `/${r.conclusion}` : ""}  ${r.url}`);
    if (a.runsNote) add(`  CI: ${plain(a.runsNote, 160)}`);
  } else if (s.queueState.kind === "ok") add("active batch: none");
  for (const b of s.concurrent) {
    add(`also running: batch ${b.n} on ${b.ref} at ${short(b.head)}${b.on !== null ? `, stacked on batch ${b.on}` : ""}: ${b.prs.length} PR(s), depth ${b.depth}, lineage ${b.lineage}${b.rerunRequested ? ", rerun requested" : ""}, elapsed ${humanAge(b.elapsedMs)}`);
    for (const p of b.prs) add(`  ${prText(p)}`);
  }

  if (s.pending.length) {
    add("pending (split halves, next first):");
    for (const p of s.pending) add(`  depth ${p.depth}, lineage ${p.lineage}: ${p.prs.map(prText).join("; ")}`);
  }
  if (s.solo.length) {
    add("solo:");
    for (const x of s.solo) add(`  ${prText(x.pr)} (${x.reason})`);
  }
  if (s.queued.length) {
    add("queued (oldest first):");
    for (const p of s.queued) add(`  ${prText(p)}`);
  }
  if (s.operatorSolo.length) add(`operator solo: ${s.operatorSolo.map((n) => `#${n}`).join(" ")}`);
  if (s.held.length) add(`held (mergeability unknown): ${s.held.map((h) => `#${h.pr} ${age(h.sinceMs)}`).join(", ")}`);
  if (s.verifying.length) add(`verifying landed: ${s.verifying.map((v) => `#${v.pr} in ${short(v.landedIn)} (${age(v.ageMs)})`).join(", ")}`);
  if (s.outbox.length) add(`outbox: ${s.outbox.map((o) => `${o.kind}${o.pr ? ` #${o.pr}` : ""}`).join(", ")}`);
  if (s.counters) {
    const c = s.counters;
    const landed = c.lastLandedAt ? `${age(c.lastLandedAgeMs)} ago` : "never";
    add(`budget: ${c.windowUsed}/${c.windowBudget} CI runs in ${c.windowHours}h; red streak ${c.redStreak}, bounce streak ${c.bounceStreak}; last landed ${landed}`);
  }
  add();

  if (s.bounces.length) {
    add("recent bounces:");
    for (const b of s.bounces) {
      add(`  ${age(b.ageMs)} ago, batch ${b.n}: ${b.prs.map((n) => `#${n}`).join(" ")}: ${plain(b.note, 100)}`);
      for (const j of b.failedJobs) add(`    failed: ${plain(j.name, 60)}  ${plain(j.url, 160)}`);
    }
    add();
  }

  const r = s.release;
  if (r.kind !== "ok") add(`release: ${plain(r.reason, 200)}`);
  else {
    const lease = r.lease ? `, lease ${plain(r.lease.owner, 60)}` : "";
    const pend = r.pausePending ? `, pause pending: ${plain(r.pausePending, 100)}` : "";
    add(`release: seq ${r.seq}${lease}${pend}`);
    if (r.op) add(`  advancing ${short(r.op.before)} -> ${short(r.op.after)} since ${age(r.op.ageMs)} ago`);
    if (r.dispatch?.op) add(`  dispatching the ${plain(r.dispatch.op.kind, 10)} run for ${short(r.dispatch.op.sha)} since ${age(r.dispatch.op.ageMs)} ago`);
    if (r.dispatch?.candidate) add(`  candidate ${short(r.dispatch.candidate.sha)}: ${plain(r.dispatch.candidate.stage, 120)}`);
    if (r.last) add(`  last check ${age(r.last.ageMs)} ago: ${r.last.kind}: ${plain(r.last.reason, 120)} (release ${short(r.last.release)}, main ${short(r.last.main)})`);
    if (r.lastHistory) add(`  last change ${plain(r.lastHistory.at, 30)}: ${r.lastHistory.outcome} ${short(r.lastHistory.from)} -> ${short(r.lastHistory.to)}`);
  }
  add();

  add(`ticks: workflow ${plain(s.ticks.workflow ?? "unknown", 40)}`);
  for (const t of s.ticks.recent) add(`  ${age(t.ageMs)} ago ${plain(t.event, 30)}: ${plain(t.status, 20)}${t.conclusion ? `/${plain(t.conclusion, 20)}` : ""}  ${plain(t.url, 160)}`);

  if (s.problems.length) {
    add();
    add("could not check:");
    for (const p of s.problems) add(`  ${plain(p, 200)}`);
  }
  return `${out.join("\n")}\n`;
}
