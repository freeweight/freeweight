// Formatters. Every number the UI prints goes through one of these.

import type { Tier } from "../api/types";

const MICRO = 1_000_000;

/**
 * USD from micro-units. One rule for every amount on the site: two decimals, or four when the amount is under a
 * dollar and the third or fourth decimal is not zero (which covers everything under one cent). Never three.
 */
export function usd(micro: number): string {
  const v = Math.abs(micro) / MICRO;
  const sign = micro < 0 ? "-" : "";
  // An amount too small for four decimals is still not nothing.
  if (v > 0 && v < 0.0001) return `${sign}<$0.0001`;
  // Whole ten-thousandths of a dollar, so the choice is made on the digits that would be printed.
  const t = Math.round(v * 10_000);
  if (t >= 10_000 || t % 100 === 0) return `${sign}$${v.toFixed(2)}`;
  return `${sign}$${(t / 10_000).toFixed(4)}`;
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

/** A typical wake in words, or null when none has been measured: the page then says so and never makes one up. */
export function typicalWake(seconds: number | null | undefined): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? about(seconds) : null;
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
