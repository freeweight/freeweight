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
    setSession(s);
    return s;
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    let cur: Session | null = null;
    setSession(null);
    setError(null);
    lastT.current = -1;
    wake.current = anchor(0);
    known.current = [];
    fresh.current = null;
    watched.current = false;
    over.current = null;
    const done = (): boolean => cur?.state === "ended" || cur?.state === "failed";
    void (async () => {
      let delay = 500;
      while (!ctl.signal.aborted) {
        try {
          cur = take(await api.session(id, ctl.signal));
          setError(null);
          if (done()) return;
          await api.events(
            id,
            (event, data) => {
              if (!cur) return;
              const full = Boolean(data && typeof data === "object" && "stages" in data);
              cur = take(applyEvent(cur, event, data), !full);
            },
            ctl.signal,
          );
          delay = 500;
        } catch (e) {
          if (ctl.signal.aborted) return;
          const err = toApiError(e);
          if (err.status === 404 || err.status === 401 || err.status === 403) {
            setError(err);
            return;
          }
          if (!cur) setError(err);
          delay = Math.min(delay * 2, 8000);
        }
        if (done()) return;
        await new Promise((r) => setTimeout(r, delay));
      }
    })();
    return () => ctl.abort();
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
