// The wake, as rows on a time scale. Pure functions over the stage events the gateway relays.
//
// Nothing here guesses. Every stretch a stage ran for is a row of its own, in the order it was reported, so a stage
// that comes round twice (weights fetched to the machine, then loaded into the GPU; a second attempt) reads as two
// rows with two bars. A stage the gateway never timed has no row. When live detail goes away the rows stop where the
// last report left them while the clock keeps real time.

import type { Stage, StageEvent } from "../api/types";
import { STAGES } from "../api/types";

export const STAGE_LABEL: Record<Stage, string> = {
  queued: "Queued",
  gpu: "GPU",
  container: "Container",
  weights: "Weights",
  engine: "Engine",
  ready: "Ready",
  failed: "Failed",
};

/** `held` is the last stage reported before live detail went away: it may or may not still be the current one. */
export type RowStatus = "done" | "active" | "held" | "pending" | "failed";
/** One stretch a stage ran for, or a stage that is still ahead. Rows are told apart by position, never by stage. */
export type Row = {
  stage: Stage;
  label: string;
  /** ms into the wake when this stretch began. Null for a stage that has not begun. */
  at: number | null;
  /** How long it has run. Null for a stage that has not begun, and for the ready mark. */
  took: number | null;
  detail: string;
  status: RowStatus;
  /** Which run of its stage this row is, and how many runs that stage has had so far. */
  nth: number;
  of: number;
};
export type Rack = {
  rows: Row[];
  readyAt: number | null;
  failedAt: number | null;
  current: Stage | null;
  elapsed: number;
  /** 1 on a first try. Read from a detail such as "GPU node assigned (attempt 2)", or from the GPU stage coming round again. */
  attempt: number;
};

const ATTEMPT = /\(attempt (\d+)\)/i;
/** The attempt a stage detail names, if it names one. */
export function attemptOf(detail: string | undefined): number | null {
  const m = detail ? ATTEMPT.exec(detail) : null;
  return m ? Number(m[1]) : null;
}

type Seg = { stage: Stage; at: number; end: number; detail: string; attempt: number | null };
/** The stages a wake goes through before it is ready, in their usual order. */
const BEFORE_READY = STAGES.filter((s) => s !== "ready");

/**
 * Lay the stage events out as rows. `elapsed` is ms since the wake began, as far as we know. `heldAt` is set while
 * live detail is unavailable: the moment (ms into the wake) the last report was still current.
 */
export function rack(stages: StageEvent[], elapsed: number, heldAt: number | null = null): Rack {
  // Events in the order given, on a clock that never runs backwards, up to the first one that ends the wake.
  const evs: StageEvent[] = [];
  let hi = 0;
  for (const s of stages) {
    hi = Math.max(hi, s.t_ms);
    evs.push(s.t_ms === hi ? s : { ...s, t_ms: hi });
    if (s.stage === "ready" || s.stage === "failed") break;
  }
  const last = evs.at(-1) ?? null;
  const term = last && (last.stage === "ready" || last.stage === "failed") ? last : null;
  const ready = term?.stage === "ready" ? term : null;
  const failed = term?.stage === "failed" ? term : null;
  const now = term ? term.t_ms : Math.max(elapsed, hi);
  // Where the running stage's bar ends: at the terminal event, at the last moment we had detail, or now.
  const held = !term && heldAt != null;
  const edge = term ? term.t_ms : held ? Math.max(hi, Math.min(heldAt, now)) : now;

  const segs: Seg[] = [];
  for (const e of term ? evs.slice(0, -1) : evs) {
    const prev = segs.at(-1);
    const n = attemptOf(e.detail);
    if (prev && prev.stage === e.stage && (n == null || n === prev.attempt)) {
      // The same stage reporting again: a new detail for the stretch that is already running.
      if (e.detail) prev.detail = e.detail;
      continue;
    }
    if (prev) prev.end = e.t_ms;
    segs.push({ stage: e.stage, at: e.t_ms, end: edge, detail: e.detail ?? "", attempt: n });
  }
  const running = segs.at(-1) ?? null;

  const runs = new Map<Stage, number>();
  for (const s of segs) runs.set(s.stage, (runs.get(s.stage) ?? 0) + 1);
  const seen = new Map<Stage, number>();
  const rows: Row[] = segs.map((s) => {
    const nth = (seen.get(s.stage) ?? 0) + 1;
    seen.set(s.stage, nth);
    // A stage name this build does not know still gets its row, under the name the gateway gave it.
    const base = { stage: s.stage, label: STAGE_LABEL[s.stage] ?? String(s.stage), at: s.at, took: Math.max(0, s.end - s.at), nth, of: runs.get(s.stage) ?? 1 };
    if (s !== running || ready) return { ...base, detail: s.detail, status: "done" };
    if (failed) return { ...base, detail: failed.detail ?? s.detail, status: "failed" };
    return { ...base, detail: s.detail, status: held ? "held" : "active" };
  });
  if (!ready) {
    // What the wake has not come to yet: the stages after the running one, in their usual order, with no times.
    const i = running ? BEFORE_READY.indexOf(running.stage as (typeof BEFORE_READY)[number]) : -1;
    const ahead = !running ? BEFORE_READY : i < 0 ? [] : BEFORE_READY.slice(i + 1);
    for (const stage of ahead) rows.push({ stage, label: STAGE_LABEL[stage], at: null, took: null, detail: "", status: "pending", nth: 1, of: 1 });
  }
  rows.push({ stage: "ready", label: STAGE_LABEL.ready, at: ready?.t_ms ?? null, took: null, detail: ready?.detail ?? "", status: ready ? "done" : "pending", nth: 1, of: 1 });

  const named = segs.map((s) => s.attempt ?? 1);
  const attempt = Math.max(1, ...named, segs.filter((s) => s.stage === "gpu").length);
  return { rows, readyAt: ready?.t_ms ?? null, failedAt: failed?.t_ms ?? null, current: term ? null : (running?.stage ?? null), elapsed: now, attempt };
}

/** The right edge of the time scale: room past the estimate, stretched if the wake runs long. Whole 30 s steps. */
export function scaleMax(estimateS: number, elapsedMs: number): number {
  const need = Math.max(estimateS * 1000 * 1.12, elapsedMs * 1.06, 30_000);
  return Math.ceil(need / 30_000) * 30_000;
}

/** Tick positions (ms) for a scale: majors labelled, minors between. */
export function ticks(maxMs: number): { major: number[]; minor: number[] } {
  // A wake that goes round again can run for many minutes, so the steps widen with the scale.
  const majorStep = maxMs <= 60_000 ? 10_000 : maxMs <= 180_000 ? 30_000 : maxMs <= 420_000 ? 60_000 : maxMs <= 900_000 ? 120_000 : 300_000;
  const minorStep = majorStep / (majorStep === 120_000 ? 4 : majorStep === 30_000 || majorStep === 60_000 ? 6 : 5);
  const major: number[] = [];
  const minor: number[] = [];
  for (let t = 0; t <= maxMs + 1; t += minorStep) (t % majorStep === 0 ? major : minor).push(t);
  return { major, minor };
}

/** Timer weight: the readout gains mass as the machine takes load. */
export function loadWeight(current: Stage | null, ready: boolean): number {
  if (ready) return 800;
  const w: Partial<Record<Stage, number>> = { queued: 200, gpu: 300, container: 400, weights: 500, engine: 650 };
  return (current && w[current]) || 200;
}
