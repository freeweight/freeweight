// The first load of a pasted model: follow it until it ends, and read it as rows and amounts. The follower and the
// readings are pure; the hook at the end ties them to a page.

import { useEffect, useRef, useState } from "react";
import { api, ApiError, LOAD_STAGES, type Load, type LoadStage } from "../api";
import { toApiError } from "./hooks";
import { anchor, read, type Anchor } from "./time";

export const LOAD_STAGE_LABEL: Record<LoadStage, string> = {
  queued: "Queued",
  checking: "Checking the repo",
  downloading: "Downloading weights",
  validating: "Verifying weights",
  starting: "Starting the engine",
  ready: "Ready",
  failed: "Failed",
};

export type LoadRowStatus = "done" | "active" | "pending" | "failed" | "skipped";
export type LoadRowView = { stage: LoadStage; label: string; status: LoadRowStatus };

/**
 * One row per stage. A running load has one active row. A load that ended ready has every row done. A failed load
 * marks the stage it was last seen in (`lastStage`, known only to a page that watched it); without that the rows
 * say nothing about where it stopped, because nobody on this page saw it.
 */
export function loadRows(l: Pick<Load, "state" | "stage">, lastStage: LoadStage | null = null): LoadRowView[] {
  const at = LOAD_STAGES.indexOf(l.state === "failed" ? (lastStage ?? "failed") : l.stage);
  return LOAD_STAGES.map((stage, i) => {
    let status: LoadRowStatus;
    if (l.state === "ready") status = "done";
    else if (l.state === "failed") status = at < 0 ? "skipped" : i < at ? "done" : i === at ? "failed" : "skipped";
    else status = i < at ? "done" : i === at ? "active" : "pending";
    return { stage, label: LOAD_STAGE_LABEL[stage], status };
  });
}

/** How much of the weights is stored, from 0 to 1. Null when the size is not known. */
export function loadFraction(l: Pick<Load, "bytes" | "size_bytes">): number | null {
  if (!(l.size_bytes > 0)) return null;
  return Math.min(1, Math.max(0, l.bytes / l.size_bytes));
}

/** How long the load ran, in ms: to its end, or to `now` on the gateway's clock while it runs. */
export function loadElapsedMs(l: Pick<Load, "created_at" | "ended_at">, now: number): number {
  return Math.max(0, (l.ended_at ?? now) - l.created_at);
}

type Billed = Partial<Pick<Load, "created_at" | "gpu_at" | "gpu_wait_ms">>;

/**
 * The part of `elapsedMs` a load is charged for: the wait for a GPU is not. Until the lane says how long that was,
 * all time since the GPU stage began counts as waiting.
 */
export function loadBilledMs(l: Billed, elapsedMs: number): number {
  const wait = l.gpu_wait_ms ?? (l.gpu_at && l.created_at ? l.created_at + elapsedMs - l.gpu_at : 0);
  return Math.max(elapsedMs - Math.max(wait, 0), 0);
}

/** What a load that ended now would cost: its charged time at the class rate, and never more than the cap. */
export function loadCostMicro(l: Pick<Load, "price_usd_micro_per_min" | "cap_minutes"> & Billed, elapsedMs: number): number {
  const seconds = Math.min(Math.ceil(loadBilledMs(l, elapsedMs) / 1000), l.cap_minutes * 60);
  return Math.round((seconds * l.price_usd_micro_per_min) / 60);
}

const isLoad = (d: unknown): d is Load => Boolean(d && typeof d === "object" && "id" in d && "stage" in d && "state" in d);

type FollowLoad = {
  load: (id: string, signal?: AbortSignal) => Promise<Load>;
  events: (id: string, on: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>;
  take: (l: Load) => void;
  onError: (e: ApiError | null) => void;
  signal: AbortSignal;
  /** Silence for this long and the stream is taken for dead. The gateway sends a tick every two seconds. */
  quietMs?: number;
  delayMs?: number;
  maxDelayMs?: number;
};

/**
 * Keep one load current until it is over: read it, follow its event stream, and start over whenever the stream
 * closes, fails or falls silent. A load that cannot be read at all (not found, not yours) ends the follow.
 */
export async function followLoad(id: string, o: FollowLoad): Promise<void> {
  const first = o.delayMs ?? 500;
  let delay = first;
  let shown: Load | null = null;
  const take = (l: Load): void => {
    shown = l;
    o.take(l);
  };
  const over = (): boolean => shown !== null && shown.state !== "loading";
  while (!o.signal.aborted) {
    const c = new AbortController();
    const off = (): void => c.abort();
    o.signal.addEventListener("abort", off, { once: true });
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const heard = (): void => {
      clearTimeout(quiet);
      quiet = setTimeout(() => c.abort(), o.quietMs ?? 6500);
    };
    try {
      take(await o.load(id, c.signal));
      o.onError(null);
      delay = first;
      if (over()) return;
      heard();
      await o.events(
        id,
        (_event, data) => {
          heard();
          if (isLoad(data)) take(data);
        },
        c.signal,
      );
    } catch (e) {
      if (o.signal.aborted) return;
      if (!c.signal.aborted) {
        const err = toApiError(e);
        if (!shown) {
          o.onError(err);
          if (err.status === 404 || err.status === 401 || err.status === 403) return;
        }
        delay = Math.min(delay * 2, o.maxDelayMs ?? 8000);
      }
    } finally {
      clearTimeout(quiet);
      o.signal.removeEventListener("abort", off);
    }
    if (over()) return;
    await new Promise<void>((r) => setTimeout(r, delay));
  }
}

export type LiveLoad = {
  load: Load | null;
  error: ApiError | null;
  /** ms since the load began, on the gateway's clock. Stands still once the load is over. */
  elapsed: () => number;
  /** The stage the load was in when this page last saw it running. Null when the page opened on a finished load. */
  lastStage: LoadStage | null;
};

export function useLoadOf(id: string): LiveLoad {
  const [load, setLoad] = useState<Load | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const now = useRef<Anchor>(anchor(Date.now()));
  const last = useRef<LoadStage | null>(null);
  useEffect(() => {
    setLoad(null);
    setError(null);
    last.current = null;
    const ctrl = new AbortController();
    void followLoad(id, {
      load: api.load,
      events: api.loadEvents,
      take: (l) => {
        now.current = anchor(l.now);
        if (l.state === "loading") last.current = l.stage;
        setLoad(l);
      },
      onError: setError,
      signal: ctrl.signal,
    });
    return () => ctrl.abort();
  }, [id]);
  return { load, error, elapsed: () => (load ? loadElapsedMs(load, read(now.current)) : 0), lastStage: last.current };
}
