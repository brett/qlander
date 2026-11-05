// A small benchmark for queue.strategy (DESIGN.md §5.7) on the pure machine
// (test/sim.ts): PRs 1..n are admitted together, CI is red exactly when a
// batch holds a culprit (a rerun is red too), and the queue runs until idle.
// It counts what one CI host pays: CI runs (builds plus reruns) and ticks.

import type { Config } from "../src/config";
import { cfg, green, livePr, red, Sim } from "./sim";

export interface Bench {
  /** Builds plus reruns: full-suite CI runs paid for. */
  runs: number;
  /** Ticks until idle. */
  ticks: number;
  /** The tick on which the first PR in FIFO order landed (or null). */
  firstLanded: number | null;
  landed: number[];
  bounced: number[];
}

/** Run `n` PRs with these culprits to completion under `over` (minFill 1, so the first batch builds at once). */
export function bench(n: number, culprits: number[], over: Partial<Config> = {}, extra: { more?: number; every?: number } = {}): Bench {
  const s = new Sim(cfg(over), (b) => (b.prs.some((p) => culprits.includes(p)) ? red() : green));
  for (let i = 1; i <= n; i++) s.add(livePr(i));
  let firstLanded: number | null = null;
  let next = n + 1;
  const total = n + (extra.more ?? 0);
  for (let t = 1; t <= 500; t++) {
    if (next <= total && extra.every && t % extra.every === 0) s.add(livePr(next++));
    s.tick();
    if (firstLanded === null && s.landed.some((l) => l.includes(1))) firstLanded = t;
    const st = s.state;
    const waiting = Object.keys(st.auth).length + st.pending.length + st.solo.length;
    if (next > total && !st.active && !st.journal && waiting === 0) {
      return { runs: s.builds.length + s.reruns, ticks: t, firstLanded, landed: s.landed.flat(), bounced: [...s.bounced] };
    }
    if (s.paused) throw new Error(`paused: ${s.pauses.join("; ")}`);
  }
  throw new Error("did not settle");
}

/** Mean of a field over one culprit at each position of a batch of `n`. */
export function meanOverCulprit(n: number, over: Partial<Config>, field: "runs" | "ticks" | "firstLanded"): number {
  let sum = 0;
  for (let c = 1; c <= n; c++) sum += bench(n, [c], over)[field] ?? 0;
  return sum / n;
}

/**
 * A digest of everything a run of `bench` did: every build (number, base,
 * PRs, rebuild), the rerun count, and the final state document. Equal digests
 * mean the same decisions and the same state, byte for byte.
 */
export function trace(n: number, culprits: number[], over: Partial<Config> = {}): string {
  const s = new Sim(cfg(over), (b) => (b.prs.some((p) => culprits.includes(p)) ? red() : green));
  for (let i = 1; i <= n; i++) s.add(livePr(i));
  s.runUntilIdle(200);
  const text = JSON.stringify({ builds: s.builds, reruns: s.reruns, landed: s.landed, bounced: s.bounced, state: s.state }, null, 1);
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
}

/** One digest over one culprit at every position of batches of 2 to 8, and two culprits in a batch of 8. */
export function traceAll(over: Partial<Config> = {}): string {
  const parts: string[] = [];
  for (let n = 2; n <= 8; n++) for (let c = 1; c <= n; c++) parts.push(trace(n, [c], over));
  parts.push(trace(8, [3, 7], over), trace(8, [], over));
  return new Bun.CryptoHasher("sha256").update(parts.join(",")).digest("hex").slice(0, 16);
}

/**
 * Like traceAll, for batches the queue abandons as it pauses: CI inconclusive
 * twice, a configuration problem, and a solo PR red only where main is red;
 * each paused for two ticks and then resumed with CI green.
 */
export function traceAbandons(over: Partial<Config> = {}): string {
  const infra = { kind: "infra" as const, runs: [{ runId: 9, attempt: 1 }], reason: "cancelled" };
  const config = { kind: "config" as const, reason: "CI: 'Test' skipped" };
  const parts: string[] = [];
  for (const bad of [infra, config, "mainRed"] as const) {
    let fixed = false;
    const s = new Sim(cfg(over), (b) => (fixed || b.n !== (bad === "mainRed" ? 3 : 1) ? (bad === "mainRed" && !fixed && b.prs.length === 1 ? red(["Test"]) : green) : bad === "mainRed" ? green : bad));
    if (bad === "mainRed") s.mainFailedJobs = ["Test"];
    for (let i = 1; i <= 3; i++) s.add(livePr(i));
    for (let i = 0; i < 30 && !s.paused; i++) s.tick();
    fixed = true;
    s.tick();
    s.tick();
    s.paused = false;
    s.mainFailedJobs = null;
    s.runUntilIdle(100);
    const text = JSON.stringify({ builds: s.builds, reruns: s.reruns, landed: s.landed, bounced: s.bounced, pauses: s.pauses, state: s.state }, null, 1);
    parts.push(new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16));
  }
  return parts.join(",");
}
