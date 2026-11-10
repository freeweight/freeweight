import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, ApiError, type Awake, type Config, type Me, type Model } from "../api";

export type Load<T> = { data: T | null; error: ApiError | null; loading: boolean; reload: () => void };

/** Load once, optionally keep polling while the tab is visible. Keeps the last good value across polls. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs = 0): Load<T> {
  const [state, set] = useState<{ data: T | null; error: ApiError | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = (): void => {
      fnRef.current().then(
        (data) => live && set({ data, error: null, loading: false }),
        (e: unknown) => live && set((s) => ({ data: s.data, error: toApiError(e), loading: false })),
      ).finally(() => {
        if (live && pollMs) timer = setTimeout(() => (document.hidden ? (timer = setTimeout(run, pollMs)) : run()), pollMs);
      });
    };
    run();
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n, pollMs]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { ...state, reload };
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError("error", e instanceof Error ? e.message : "Something went wrong.", 0);
}

// ---------- tiny shared stores ----------

function store<T>(initial: T) {
  let value = initial;
  const subs = new Set<() => void>();
  return {
    get: () => value,
    set(v: T) {
      value = v;
      for (const s of subs) s();
    },
    sub(cb: () => void) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
  };
}

const meStore = store<Me | null>(null);
let meInflight: Promise<Me> | null = null;
export function refreshMe(): Promise<Me> {
  meInflight ??= api
    .me()
    .then((m) => {
      meStore.set(m);
      return m;
    })
    .finally(() => {
      meInflight = null;
    });
  return meInflight;
}
export function useMe(): Me | null {
  const v = useSyncExternalStore(meStore.sub, meStore.get, meStore.get);
  useEffect(() => {
    if (meStore.get() === null) refreshMe().catch(() => undefined);
  }, []);
  return v;
}

/** What to say when a page's data did not load. A gateway that is not ready gets one plain line and no detail. */
export function loadFailed(e: ApiError): string {
  return e.status >= 500 || e.code === "misconfigured" ? "The service is not ready. Try again in a moment." : e.message;
}

const configStore = store<Config | null>(null);
let configInflight: Promise<Config> | null = null;
/** Public config, asked for once and shared. It never rejects: without a gateway the app runs on its defaults. */
export function loadConfig(): Promise<Config> {
  const have = configStore.get();
  if (have) return Promise.resolve(have);
  configInflight ??= api
    .config()
    .then((c) => {
      configStore.set(c);
      return c;
    })
    .finally(() => {
      configInflight = null;
    });
  return configInflight;
}
export function useConfig(): Config | null {
  const v = useSyncExternalStore(configStore.sub, configStore.get, configStore.get);
  useEffect(() => {
    if (configStore.get() === null) void loadConfig();
  }, []);
  return v;
}

const modelsStore = store<Model[] | null>(null);
const awakeStore = store<Awake[] | null>(null);
let liveUsers = 0;
let liveTimer: ReturnType<typeof setInterval> | undefined;
let liveError: ApiError | null = null;
export function refreshLive(): void {
  Promise.all([api.models(), api.awake()]).then(
    ([m, a]) => {
      liveError = null;
      modelsStore.set(m);
      awakeStore.set(a);
    },
    (e: unknown) => {
      liveError = toApiError(e);
      if (modelsStore.get() === null) modelsStore.set(null);
      errTick.set(errTick.get() + 1);
    },
  );
}
const errTick = store(0);

/** The catalog and the awake board, shared by every screen and refreshed every 10 s while something is mounted. */
export function useLive(): { models: Model[] | null; awake: Awake[] | null; error: ApiError | null } {
  const models = useSyncExternalStore(modelsStore.sub, modelsStore.get, modelsStore.get);
  const awake = useSyncExternalStore(awakeStore.sub, awakeStore.get, awakeStore.get);
  useSyncExternalStore(errTick.sub, errTick.get, errTick.get);
  useEffect(() => {
    if (liveUsers++ === 0) {
      refreshLive();
      liveTimer = setInterval(() => !document.hidden && refreshLive(), 10_000);
    }
    return () => {
      if (--liveUsers === 0) clearInterval(liveTimer);
    };
  }, []);
  return { models, awake, error: models ? null : liveError };
}

/** Re-render on every animation frame while `on`, for elapsed-time readouts. */
export function useFrame(on: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    let raf = 0;
    const loop = (): void => {
      set((x) => (x + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [on]);
}

/** Re-render every `ms` while `on`. */
export function useEvery(ms: number, on = true): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms, on]);
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} · Freeweight` : "Freeweight: rent any open model by the minute";
  }, [title]);
}
