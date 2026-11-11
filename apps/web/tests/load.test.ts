import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client";
import type { Load } from "../src/api/types";
import { followLoad, loadCostMicro, loadElapsedMs, loadFraction, loadRows } from "../src/lib/load";

const load = (over: Partial<Load> = {}): Load => ({
  id: "load_1",
  model_id: "acme_tiny-1b",
  hf_repo: "acme/tiny-1b",
  sha: "3f9a1c2e7b5d4f6a8c0e1b2d3f4a5c6e7b8d9f0a",
  tier: "light",
  state: "loading",
  stage: "queued",
  bytes: 0,
  size_bytes: 2_000_000_000,
  mine: true,
  price_usd_micro_per_min: 30_000,
  cap_minutes: 5,
  hold_usd_micro: 150_000,
  charged_usd_micro: 0,
  created_at: 1_762_000_000_000,
  ended_at: null,
  now: 1_762_000_000_000,
  ...over,
});
const status = (l: Pick<Load, "state" | "stage">, last: Load["stage"] | null = null): string[] => loadRows(l, last).map((r) => r.status);

describe("load rows", () => {
  it("has one active row while the load runs", () => {
    expect(loadRows(load()).map((r) => r.stage)).toEqual(["queued", "checking", "downloading", "validating", "starting"]);
    expect(status(load())).toEqual(["active", "pending", "pending", "pending", "pending"]);
    expect(status(load({ stage: "downloading" }))).toEqual(["done", "done", "active", "pending", "pending"]);
    expect(status(load({ stage: "starting" }))).toEqual(["done", "done", "done", "done", "active"]);
  });

  it("marks every row done on a load that ended ready", () => {
    expect(status(load({ state: "ready", stage: "ready" }))).toEqual(["done", "done", "done", "done", "done"]);
  });

  it("marks the stage a failed load was last seen in, and nothing when nobody saw it", () => {
    const failed = load({ state: "failed", stage: "failed" });
    expect(status(failed, "validating")).toEqual(["done", "done", "done", "failed", "skipped"]);
    expect(status(failed, "queued")).toEqual(["failed", "skipped", "skipped", "skipped", "skipped"]);
    expect(status(failed)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped"]);
  });
});

describe("load figures", () => {
  it("reads the stored share of the weights, and nothing without a size", () => {
    expect(loadFraction({ bytes: 500, size_bytes: 2_000 })).toBe(0.25);
    expect(loadFraction({ bytes: 3_000, size_bytes: 2_000 })).toBe(1);
    expect(loadFraction({ bytes: 10, size_bytes: 0 })).toBeNull();
  });

  it("stops the clock where the load ended", () => {
    expect(loadElapsedMs({ created_at: 1_000, ended_at: null }, 31_000)).toBe(30_000);
    expect(loadElapsedMs({ created_at: 1_000, ended_at: 9_000 }, 31_000)).toBe(8_000);
    expect(loadElapsedMs({ created_at: 1_000, ended_at: null }, 500)).toBe(0);
  });

  it("prices the time by the started second at the class rate, and never over the cap", () => {
    const l = { price_usd_micro_per_min: 30_000, cap_minutes: 5 };
    expect(loadCostMicro(l, 0)).toBe(0);
    expect(loadCostMicro(l, 1)).toBe(500);
    expect(loadCostMicro(l, 60_000)).toBe(30_000);
    expect(loadCostMicro(l, 214_000)).toBe(107_000);
    expect(loadCostMicro(l, 300_000)).toBe(150_000);
    expect(loadCostMicro(l, 3_600_000)).toBe(150_000);
    expect(loadCostMicro({ price_usd_micro_per_min: 100_000, cap_minutes: 15 }, 3_600_000)).toBe(1_500_000);
  });
});

type Events = (id: string, on: (event: string, data: unknown) => void, signal: AbortSignal) => Promise<void>;
const silent: Events = (_id, _on, signal) => new Promise((_r, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));

function stage(read: (n: number) => Load | Error, events: Events, quietMs = 10_000) {
  const ctl = new AbortController();
  const errors: (ApiError | null)[] = [];
  const taken: Load[] = [];
  let reads = 0;
  const done = followLoad("load_1", {
    load: async () => {
      const r = read(++reads);
      if (r instanceof Error) throw r;
      return r;
    },
    events,
    take: (l) => void taken.push(l),
    onError: (e) => void errors.push(e),
    signal: ctl.signal,
    quietMs,
    delayMs: 1,
    maxDelayMs: 4,
  });
  return { done, ctl, errors, taken, reads: () => reads };
}

describe("following a load", () => {
  it("takes every load the stream carries and stops when one is over", async () => {
    const s = stage(
      () => load(),
      async (_id, on) => {
        on("load", load({ stage: "downloading", bytes: 1_000 }));
        on("tick", load({ stage: "downloading", bytes: 1_000 }));
        on("load", load({ state: "ready", stage: "ready", ended_at: 1_762_000_090_000, charged_usd_micro: 45_000 }));
        on("ended", load({ state: "ready", stage: "ready", ended_at: 1_762_000_090_000, charged_usd_micro: 45_000 }));
      },
    );
    await s.done;
    expect(s.reads()).toBe(1);
    expect(s.taken.map((l) => l.stage)).toEqual(["queued", "downloading", "downloading", "ready", "ready"]);
    expect(s.taken.at(-1)?.charged_usd_micro).toBe(45_000);
  });

  it("does not open a stream for a load that is already over", async () => {
    let streams = 0;
    const s = stage(
      () => load({ state: "failed", stage: "failed", ended_at: 1_762_000_010_000 }),
      async () => void streams++,
    );
    await s.done;
    expect(streams).toBe(0);
    expect(s.taken).toHaveLength(1);
  });

  it("drops a stream that falls silent and reads the load afresh", async () => {
    const s = stage((n) => (n < 3 ? load() : load({ state: "ready", stage: "ready" })), silent, 20);
    await s.done;
    expect(s.reads()).toBe(3);
    expect(s.taken.at(-1)?.state).toBe("ready");
  });

  it("starts over when the stream closes or breaks while the load still runs", async () => {
    let streams = 0;
    const s = stage(
      (n) => (n < 3 ? load() : load({ state: "failed", stage: "failed" })),
      async () => {
        if (++streams === 1) throw new TypeError("network");
      },
    );
    await s.done;
    expect(streams).toBe(2);
    expect(s.reads()).toBe(3);
    // A load that is on the screen keeps showing through a broken stream: no error is raised over it.
    expect(s.errors.every((e) => e === null)).toBe(true);
  });

  it("ignores stream messages that are not a load", async () => {
    const s = stage(
      (n) => (n === 1 ? load() : load({ state: "ready", stage: "ready" })),
      async (_id, on) => {
        on("load", { error: "nope" });
        on("tick", null);
      },
    );
    await s.done;
    expect(s.taken.map((l) => l.state)).toEqual(["loading", "ready"]);
  });

  it("gives up on a load that is not there, and keeps trying one that only failed to answer", async () => {
    const gone = stage(() => new ApiError("load_not_found", "No such load.", 404), silent);
    await gone.done;
    expect(gone.reads()).toBe(1);
    expect(gone.errors.at(-1)).toMatchObject({ code: "load_not_found" });

    const flaky = stage((n) => (n < 3 ? new ApiError("unavailable", "Try again.", 503) : load({ state: "ready", stage: "ready" })), silent);
    await flaky.done;
    expect(flaky.reads()).toBe(3);
    expect(flaky.errors.at(-1)).toBeNull();
    expect(flaky.taken).toHaveLength(1);
  });

  it("stops when the page leaves", async () => {
    const s = stage(() => load(), silent);
    await new Promise((r) => setTimeout(r, 5));
    s.ctl.abort();
    await s.done;
    expect(s.reads()).toBe(1);
  });
});
