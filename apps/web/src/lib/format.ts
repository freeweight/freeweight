// Formatters. Every number the UI prints goes through one of these.

import type { Tier } from "../api/types";

const MICRO = 1_000_000;

/**
 * USD from micro-units. One rule for every amount on the site: two decimals, or four when the amount is under a
 * dollar and the third or fourth decimal is not zero (which covers everything under one cent). Never three.
 */
export function usd(micro: number): string {
  const a = Math.abs(micro);
  const sign = micro < 0 ? "-" : "";
  // An amount too small for four decimals is still not nothing.
  if (a > 0 && a < MICRO / 10_000) return `${sign}<$0.0001`;
  // Rounding is done on whole micro-units, never on a float dollar, so a half rounds up every time: 1_005_000 is
  // $1.01, as 1_015_000 is $1.02. The choice is made on the ten-thousandths that would be printed.
  const t = Math.round(a / 100);
  if (t >= 10_000 || t % 100 === 0) {
    const c = Math.round(a / 10_000);
    return `${sign}$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  }
  return `${sign}$0.${String(t).padStart(4, "0")}`;
}

/** A code this build has no words for, as plain text: "minimum_applied" reads "minimum applied". */
export function plainCode(code: string): string {
  return code.replace(/[^A-Za-z0-9.]+/g, " ").trim().slice(0, 48);
}

export function perMin(micro: number): string {
  return `${usd(micro)}/min`;
}

/** m:ss, or h:mm:ss past an hour. */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** m:ss.t with tenths, for a running timer. */
export function clockTenths(ms: number): string {
  const v = Math.max(0, ms);
  return `${clock(v)}.${Math.floor((v % 1000) / 100)}`;
}

/** A measured duration: 840 ms, 9.2 s, 1 min 42 s. */
export function took(ms: number): string {
  // The unit is chosen for the rounded number, so nothing reads "1000 ms" or "60.0 s".
  if (ms < 999.5) return `${Math.round(ms)} ms`;
  if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)} min ${total % 60} s`;
}

/** An estimate, deliberately coarse: "about 40 s", "about 1.5 min". */
export function about(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(5, Math.round(seconds / 5) * 5)} s`;
  const m = Math.round((seconds / 60) * 2) / 2;
  return `about ${m} min`;
}

/** What the catalog says about how long a model takes to wake. The low and high ends come only from a gateway that measures them. */
export type WakeFigures = { wake_estimate_s?: number | null; wake_low_s?: number | null; wake_high_s?: number | null };
/** A typical wake: the words for it, and the seconds they stand for (low and high are the same for a single figure). */
export type TypicalWake = { text: string; lowS: number; highS: number; range: boolean };

// Wake times are said in plain steps: 5 s under half a minute, 10 s up to a minute, 30 s up to three minutes,
// whole minutes above. A wake that took 26 s once and 41 s the next time is not "35 s".
const wakeStep = (s: number): number => (s < 30 ? 5 : s < 60 ? 10 : s < 180 ? 30 : 60);
const measured = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const minutes = (s: number): string => String(s / 60);

/**
 * A model's typical wake, or null when none has been measured: the page then says so and never makes one up.
 * With a low and a high end that differ once rounded it is a range, "usually 30 to 60 s". Otherwise it is one
 * rounded figure, "about 30 s".
 */
export function typicalWake(m: WakeFigures | null | undefined): TypicalWake | null {
  if (!m) return null;
  if (measured(m.wake_low_s) && measured(m.wake_high_s) && m.wake_high_s >= m.wake_low_s) {
    const lowS = Math.max(5, Math.floor(m.wake_low_s / wakeStep(m.wake_low_s)) * wakeStep(m.wake_low_s));
    // A high end just under a boundary rounds up onto it, and the step above takes over from there.
    const up = Math.ceil(m.wake_high_s / wakeStep(m.wake_high_s)) * wakeStep(m.wake_high_s);
    const highS = Math.ceil(up / wakeStep(up)) * wakeStep(up);
    if (highS > lowS) {
      const text = highS <= 60 ? `${lowS} to ${highS} s` : lowS >= 60 ? `${minutes(lowS)} to ${minutes(highS)} min` : `${lowS} s to ${minutes(highS)} min`;
      return { text: `usually ${text}`, lowS, highS, range: true };
    }
  }
  const from = measured(m.wake_estimate_s) ? m.wake_estimate_s : measured(m.wake_low_s) && measured(m.wake_high_s) ? m.wake_low_s : null;
  if (from === null) return null;
  const near = Math.max(5, Math.round(from / wakeStep(from)) * wakeStep(from));
  const s = Math.max(5, Math.round(near / wakeStep(near)) * wakeStep(near));
  return { text: s < 60 ? `about ${s} s` : `about ${minutes(s)} min`, lowS: s, highS: s, range: false };
}

/** The gateway's answer to too many wakes stopped before they finished, with how long to wait when it says. */
export function wakeBudget(retryAfter: unknown): string {
  const min = typeof retryAfter === "number" && retryAfter > 0 ? Math.ceil(retryAfter / 60) : 0;
  return `You stopped several wakes before they finished. Try again ${min ? `in ${min} min` : "later"}.`;
}

export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 999.5) return String(Math.round(n));
  if (abs < 999_500) return `${trim(n / 1e3)}k`;
  if (abs < 999_500_000) return `${trim(n / 1e6)}M`;
  return `${trim(n / 1e9)}B`;
}
function trim(v: number): string {
  return v >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
}

export function grouped(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** GPU time from seconds: 42 s, 12.5 min, 3.2 h. */
export function gpuTime(seconds: number): string {
  if (seconds < 59.5) return `${Math.round(seconds)} s`;
  if (seconds < 3597) return `${trim(seconds / 60)} min`;
  return `${trim(seconds / 3600)} h`;
}

export function params(b: number): string {
  return b >= 1 ? `${trim(b)}B` : `${Math.round(b * 1000)}M`;
}

export function context(tokens: number): string {
  // Context sizes are written both ways: 128000 and 131072 are each "128k".
  if (tokens < 1000) return String(tokens);
  return `${tokens % 1000 === 0 ? tokens / 1000 : Math.round(tokens / 1024)}k`;
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

export const TIER_NAME: Record<Tier, string> = { light: "Light", medium: "Medium", heavy: "Heavy" };
export const TIER_CLASS: Record<Tier, string> = { light: "24 GB class", medium: "48 GB class", heavy: "80 GB class" };
export const TIER_PLATES: Record<Tier, number> = { light: 1, medium: 2, heavy: 3 };

export function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
