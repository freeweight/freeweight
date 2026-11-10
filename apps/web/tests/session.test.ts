import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import type { Session } from "../src/api/types";
import { follow } from "../src/lib/session";

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  model_id: "qwen3-8b",
  state: "active",
  stages: [{ stage: "queued", t_ms: 0 }],
  started_at: 1_762_000_000_000,
  ends_at: 1_762_000_600_000,
  now: 1_762_000_000_000,
  base_url: "/v1",
  spent_usd_micro: 0,
  tokens_in: 0,
  tokens_out: 0,
  gpu_seconds: 0,
  free: true,
  ...over,
});

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** A stream that says nothing and stays open until it is dropped. */
const silent = (_id: string, _on: unknown, signal: AbortSignal): Promise<void> => new Promise((_, no) => signal.addEventListener("abort", () => no(new DOMException("dropped", "AbortError"))));

type Events = (id: string, on: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>;
function stage(read: (n: number) => Session | Error, events: Events, opts: { quietMs?: number; hidden?: () => boolean } = {}) {
  let shown: Session | null = null;
  let reads = 0;
  const errors: (ApiError | null)[] = [];
  const ctl = new AbortController();
  const f = follow("s1", {
    session: async () => {
      const r = read(++reads);
      if (r instanceof Error) throw r;
      return r;
    },
    events,
    take: (s) => (shown = s),
    shown: () => shown,
    onError: (e) => void errors.push(e),
    signal: ctl.signal,
    quietMs: opts.quietMs ?? 10_000,
    delayMs: 1,
    maxDelayMs: 4,
    hidden: opts.hidden,
  });
  return { f, ctl, errors, reads: () => reads, shown: () => shown };
}

describe("following a session", () => {
  it("drops a stream that falls silent and reads the session afresh", async () => {
    const s = stage((n) => (n < 3 ? session() : session({ state: "ended" })), silent, { quietMs: 20 });
    await s.f.done;
    expect(s.reads()).toBe(3);
    expect(s.shown()?.state).toBe("ended");
  });

  it("stays on a stream that keeps ticking", async () => {
    const ticking: Events = (_id, on, signal) =>
      new Promise((_, no) => {
        const t = setInterval(() => on("tick", { now: 1_762_000_001_000 }), 5);
        signal.addEventListener("abort", () => {
          clearInterval(t);
          no(new DOMException("dropped", "AbortError"));
        });
      });
    const s = stage(() => session(), ticking, { quietMs: 40 });
    await pause(150);
    expect(s.reads()).toBe(1);
    s.ctl.abort();
    await s.f.done;
  });

  it("does not take silence in a hidden tab for a dead stream", async () => {
    const s = stage(() => session(), silent, { quietMs: 10, hidden: () => true });
    await pause(80);
    expect(s.reads()).toBe(1);
    s.ctl.abort();
    await s.f.done;
  });

  it("reads again when asked to", async () => {
    const s = stage(() => session(), silent);
    await pause(10);
    expect(s.reads()).toBe(1);
    s.f.again();
    await pause(30);
    expect(s.reads()).toBe(2);
    s.ctl.abort();
    await s.f.done;
  });

  it("stops on a session that is not there, before anything is shown", async () => {
    const s = stage(() => new ApiError("not_found", "No such session.", 404), silent);
    await s.f.done;
    expect(s.reads()).toBe(1);
    expect(s.errors.at(-1)?.code).toBe("not_found");
  });

  it("keeps the page and keeps asking when a later read is turned away", async () => {
    const closes: Events = async () => undefined;
    const s = stage((n) => (n === 1 ? session() : n < 4 ? new ApiError("unauthorized", "Sign in.", 401) : session({ state: "ended" })), closes);
    await s.f.done;
    expect(s.reads()).toBe(4);
    expect(s.errors.every((e) => e === null)).toBe(true);
    expect(s.shown()?.state).toBe("ended");
  });

  it("keeps trying while the first read fails for a passing reason", async () => {
    const s = stage((n) => (n < 3 ? new ApiError("network", "Offline.", 0) : session({ state: "ended" })), silent);
    await s.f.done;
    expect(s.reads()).toBe(3);
    expect(s.errors.at(-1)).toBeNull();
  });
});
