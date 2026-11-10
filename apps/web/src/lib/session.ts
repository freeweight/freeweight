// One live session: load it, follow its event stream (reconnecting), and expose anchored clocks.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type Session, type StageEvent } from "../api";
import { applyEvent } from "../api/client";
import { anchor, read, type Anchor } from "./time";
import { toApiError } from "./hooks";

export type Live = {
  session: Session | null;
  error: ApiError | null;
  /** ms since the wake began. Stands still once the wake is over. */
  wakeElapsed: () => number;
  /** While live stage detail is unavailable: ms into the wake when the last report was still current. Otherwise null. */
  heldAt: () => number | null;
  /** The gateway's clock, advanced locally. */
  serverNow: () => number;
  extend: (minutes: number) => Promise<void>;
  stop: () => Promise<void>;
  busy: "extend" | "stop" | null;
  actionError: ApiError | null;
};

/** The gateway sends a tick every two seconds. Three missed ticks and the stream is taken for dead. */
export const QUIET_MS = 6500;

type Follow = {
  session: (id: string, signal?: AbortSignal) => Promise<Session>;
  events: (id: string, on: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>;
  /** Show a new view of the session and return it as shown. */
  take: (s: Session, fromEvent?: boolean) => Session;
  shown: () => Session | null;
  onError: (e: ApiError | null) => void;
  signal: AbortSignal;
  hidden?: () => boolean;
  quietMs?: number;
  /** First wait between attempts, doubled on each failure up to `maxDelayMs`, and back to this after a good read. */
  delayMs?: number;
  maxDelayMs?: number;
};

/**
 * Keep one session current until it is over: read it, follow its event stream, and start over whenever the stream
 * closes, fails or falls silent. `again()` drops the connection and reads the session afresh right away.
 */
export function follow(id: string, o: Follow): { again: () => void; done: Promise<void> } {
  const first = o.delayMs ?? 500;
  let conn: AbortController | null = null;
  let wake: (() => void) | null = null;
  const over = (): boolean => {
    const s = o.shown();
    return s?.state === "ended" || s?.state === "failed";
  };
  const done = (async () => {
    let delay = first;
    while (!o.signal.aborted) {
      const c = new AbortController();
      conn = c;
      const off = (): void => c.abort();
      o.signal.addEventListener("abort", off, { once: true });
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const heard = (): void => {
        clearTimeout(quiet);
        // A tab in the background has its timers held back, so silence there proves nothing.
        quiet = setTimeout(() => (o.hidden?.() ? heard() : c.abort()), o.quietMs ?? QUIET_MS);
      };
      try {
        o.take(await o.session(id, c.signal));
        o.onError(null);
        delay = first;
        if (over()) return;
        heard();
        await o.events(
          id,
          (event, data) => {
            heard();
            const cur = o.shown();
            if (!cur) return;
            const full = Boolean(data && typeof data === "object" && "stages" in data);
            o.take(applyEvent(cur, event, data), !full);
          },
          c.signal,
        );
      } catch (e) {
        if (o.signal.aborted) return;
        if (!c.signal.aborted) {
          const err = toApiError(e);
          // Before anything is on the page, "not found" and "not yours" are final. After that the page keeps what
          // it has and keeps asking: a sign-in that lapsed or a gateway that lost its place may come back.
          if (!o.shown()) {
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
      await new Promise<void>((r) => {
        wake = r;
        setTimeout(r, delay);
      });
      wake = null;
    }
  })();
  return {
    again: () => {
      conn?.abort();
      wake?.();
    },
    done,
  };
}

export function useSession(id: string): Live {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<"extend" | "stop" | null>(null);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const now = useRef<Anchor>(anchor(Date.now()));
  const wake = useRef<Anchor>(anchor(0));
  const lastT = useRef(-1);
  const known = useRef<StageEvent[]>([]);
  const fresh = useRef<number | null>(null);
  const watched = useRef(false);
  const over = useRef<number | null>(null);
  /** The session as last taken, whoever took it: the stream, a re-read, or Extend and Stop. */
  const shown = useRef<Session | null>(null);
  const asked = useRef<number | null>(null);

  /** Take a new view of the session. Returns it as shown, which is what the next event builds on. */
  const take = useCallback((s: Session, fromEvent = false): Session => {
    if (!fromEvent) now.current = anchor(s.now);
    // While detail is unavailable the gateway may send a short or empty list. What was already reported stays.
    if (s.degraded && s.stages.length < known.current.length) s = { ...s, stages: known.current };
    else known.current = s.stages;
    // The clock only ever moves forward: a retry that reports small times again does not reset it.
    const last = s.stages.filter((e) => e.stage !== "failed").at(-1);
    if (s.created_at != null && !fromEvent) wake.current = anchor(Math.max(s.now - s.created_at, read(wake.current), last?.t_ms ?? 0));
    else if (last && last.t_ms !== lastT.current) wake.current = anchor(Math.max(read(wake.current), last.t_ms));
    lastT.current = last?.t_ms ?? -1;
    if (s.state === "waking") {
      watched.current = true;
      over.current = null;
      if (!s.degraded) fresh.current = read(wake.current);
    } else {
      // Over. If this page watched it happen the clock stops where it is, otherwise at the last thing reported.
      over.current ??= s.stages.at(-1)?.stage === "failed" || !watched.current ? (s.stages.at(-1)?.t_ms ?? 0) : read(wake.current);
    }
    shown.current = s;
    setSession(s);
    return s;
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    shown.current = null;
    setSession(null);
    setError(null);
    lastT.current = -1;
    wake.current = anchor(0);
    known.current = [];
    fresh.current = null;
    watched.current = false;
    over.current = null;
    const f = follow(id, {
      session: api.session,
      events: api.events,
      take,
      shown: () => shown.current,
      onError: setError,
      signal: ctl.signal,
      hidden: () => document.hidden,
    });
    // A tab that comes back to the front may have slept through anything: read the session again.
    const back = (): void => {
      if (!document.hidden) f.again();
    };
    document.addEventListener("visibilitychange", back);
    // When the clock on this page runs out, ask what the gateway says: the stream's last word may never have arrived.
    const zero = setInterval(() => {
      const s = shown.current;
      if (s?.state !== "active" || s.ends_at == null || asked.current === s.ends_at) return;
      if (read(now.current) < s.ends_at) return;
      asked.current = s.ends_at;
      f.again();
    }, 500);
    return () => {
      ctl.abort();
      clearInterval(zero);
      document.removeEventListener("visibilitychange", back);
    };
  }, [id, take]);

  const act = useCallback(
    async (kind: "extend" | "stop", fn: () => Promise<Session>) => {
      setBusy(kind);
      setActionError(null);
      try {
        take(await fn());
      } catch (e) {
        setActionError(toApiError(e));
      } finally {
        setBusy(null);
      }
    },
    [take],
  );

  return {
    session,
    error,
    wakeElapsed: () => over.current ?? read(wake.current),
    heldAt: () => (session?.degraded && session.state === "waking" ? (fresh.current ?? 0) : null),
    serverNow: () => read(now.current),
    extend: (minutes) => act("extend", () => api.extend(id, minutes)),
    stop: () => act("stop", () => api.stop(id)),
    busy,
    actionError,
  };
}
