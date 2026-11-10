import { describe, expect, it } from "vitest";
import type { StageEvent } from "../src/api/types";
import { loadWeight, rack, scaleMax, ticks } from "../src/lib/wake";

const status = (stages: StageEvent[], elapsed: number): string[] => rack(stages, elapsed).rows.map((r) => `${r.stage}:${r.status}`);

describe("rack", () => {
  it("times finished stages and keeps the current one running", () => {
    const r = rack(
      [
        { stage: "queued", t_ms: 0 },
        { stage: "gpu", t_ms: 2_000 },
        { stage: "container", t_ms: 9_000 },
      ],
      12_000,
    );
    expect(r.current).toBe("container");
    expect(r.elapsed).toBe(12_000);
    expect(r.rows.map((x) => x.took)).toEqual([2_000, 7_000, 3_000, null, null, null]);
    expect(r.rows.map((x) => x.status)).toEqual(["done", "done", "active", "pending", "pending", "pending"]);
    expect(r.readyAt).toBeNull();
  });

  it("never runs the clock behind the last event", () => {
    const r = rack([{ stage: "queued", t_ms: 0 }, { stage: "gpu", t_ms: 5_000 }], 1_000);
    expect(r.elapsed).toBe(5_000);
    expect(r.rows[1]!.took).toBe(0);
  });

  it("stops at ready", () => {
    const r = rack(
      [
        { stage: "queued", t_ms: 0 },
        { stage: "gpu", t_ms: 1_000 },
        { stage: "container", t_ms: 4_000 },
        { stage: "weights", t_ms: 20_000 },
        { stage: "engine", t_ms: 50_000 },
        { stage: "ready", t_ms: 71_000 },
      ],
      500_000,
    );
    expect(r.readyAt).toBe(71_000);
    expect(r.elapsed).toBe(71_000);
    expect(r.current).toBeNull();
    expect(r.rows.every((x) => x.status === "done")).toBe(true);
    expect(r.rows[4]!.took).toBe(21_000);
  });

  it("marks the stage a wake failed in, with the reason", () => {
    const r = rack(
      [
        { stage: "queued", t_ms: 0 },
        { stage: "gpu", t_ms: 1_000 },
        { stage: "container", t_ms: 4_000 },
        { stage: "weights", t_ms: 20_000 },
        { stage: "failed", t_ms: 31_000, detail: "The download stalled." },
      ],
      90_000,
    );
    expect(r.failedAt).toBe(31_000);
    expect(r.current).toBeNull();
    const weights = r.rows.find((x) => x.stage === "weights")!;
    expect(weights.status).toBe("failed");
    expect(weights.took).toBe(11_000);
    expect(weights.detail).toBe("The download stalled.");
    expect(r.rows.find((x) => x.stage === "engine")!.status).toBe("pending");
  });

  it("has no row for a stage the gateway never reported", () => {
    expect(status([{ stage: "queued", t_ms: 0 }, { stage: "weights", t_ms: 3_000 }], 4_000)).toEqual(["queued:done", "weights:active", "engine:pending", "ready:pending"]);
    // Once the wake is over, only what was timed is left.
    expect(status([{ stage: "queued", t_ms: 0 }, { stage: "engine", t_ms: 3_000 }, { stage: "ready", t_ms: 9_000 }], 20_000)).toEqual(["queued:done", "engine:done", "ready:done"]);
  });

  it("gives a stage that comes round twice two rows, in the order reported", () => {
    // A real wake: the weights are fetched to the machine, the container starts, then the weights go into the GPU.
    const stages: StageEvent[] = [
      { stage: "queued", t_ms: 0 },
      { stage: "gpu", t_ms: 3_000 },
      { stage: "weights", t_ms: 8_000, detail: "fetching to the machine" },
      { stage: "container", t_ms: 31_000 },
      { stage: "weights", t_ms: 62_000, detail: "loading into the GPU" },
      { stage: "engine", t_ms: 84_000 },
      { stage: "ready", t_ms: 103_000 },
    ];
    const r = rack(stages, 200_000);
    expect(r.rows.map((x) => x.stage)).toEqual(["queued", "gpu", "weights", "container", "weights", "engine", "ready"]);
    const [first, second] = r.rows.filter((x) => x.stage === "weights");
    expect(first).toMatchObject({ at: 8_000, took: 23_000, detail: "fetching to the machine", nth: 1, of: 2, status: "done" });
    expect(second).toMatchObject({ at: 62_000, took: 22_000, detail: "loading into the GPU", nth: 2, of: 2, status: "done" });
    expect(r.rows.filter((x) => x.stage === "container")[0]).toMatchObject({ took: 31_000, nth: 1, of: 1 });
    expect(r.readyAt).toBe(103_000);
    expect(r.attempt).toBe(1);

    // Part-way: only the stretch that is running is live, and what is ahead follows from where the wake is now.
    expect(status(stages.slice(0, 3), 20_000)).toEqual(["queued:done", "gpu:done", "weights:active", "engine:pending", "ready:pending"]);
    expect(status(stages.slice(0, 4), 40_000)).toEqual(["queued:done", "gpu:done", "weights:done", "container:active", "weights:pending", "engine:pending", "ready:pending"]);
    const mid = rack(stages.slice(0, 5), 70_000);
    expect(mid.rows.map((x) => `${x.stage}:${x.status}`)).toEqual(["queued:done", "gpu:done", "weights:done", "container:done", "weights:active", "engine:pending", "ready:pending"]);
    expect(mid.rows[4]).toMatchObject({ took: 8_000, nth: 2, of: 2 });
    expect(mid.rows[2]).toMatchObject({ took: 23_000, nth: 1, of: 2 });
  });

  it("keeps a stage name it does not know, as a row of its own", () => {
    const r = rack([{ stage: "queued", t_ms: 0 }, { stage: "snapshot" as StageEvent["stage"], t_ms: 2_000 }], 5_000);
    expect(r.rows.map((x) => `${x.label}:${x.status}`)).toEqual(["Queued:done", "snapshot:active", "Ready:pending"]);
  });

  it("gives a second attempt rows of its own, and counts the attempt", () => {
    const r = rack(
      [
        { stage: "queued", t_ms: 0 },
        { stage: "gpu", t_ms: 2_000, detail: "GPU node assigned" },
        { stage: "container", t_ms: 9_000 },
        { stage: "gpu", t_ms: 20_000, detail: "GPU node assigned (attempt 2)" },
        { stage: "container", t_ms: 26_000 },
        { stage: "weights", t_ms: 30_000 },
      ],
      35_000,
    );
    expect(r.rows.map((x) => x.stage)).toEqual(["queued", "gpu", "container", "gpu", "container", "weights", "engine", "ready"]);
    expect(r.rows[1]).toMatchObject({ at: 2_000, took: 7_000, nth: 1, of: 2, status: "done" });
    expect(r.rows[2]).toMatchObject({ at: 9_000, took: 11_000, nth: 1, of: 2, status: "done" });
    expect(r.rows[3]).toMatchObject({ at: 20_000, took: 6_000, nth: 2, of: 2, status: "done" });
    expect(r.rows[4]).toMatchObject({ at: 26_000, took: 4_000, nth: 2, of: 2, status: "done" });
    expect(r.rows[5]).toMatchObject({ status: "active", took: 5_000, of: 1 });
    expect(r.attempt).toBe(2);
    // The clock is one clock: the second try does not start it again.
    expect(r.elapsed).toBe(35_000);
  });

  it("reads the attempt from the GPU stage coming round again when no detail names it", () => {
    const r = rack([{ stage: "queued", t_ms: 0 }, { stage: "gpu", t_ms: 1_000 }, { stage: "container", t_ms: 4_000 }, { stage: "gpu", t_ms: 15_000 }], 16_000);
    expect(r.attempt).toBe(2);
    expect(r.current).toBe("gpu");
    expect(rack([{ stage: "queued", t_ms: 0 }, { stage: "gpu", t_ms: 1_000 }], 2_000).attempt).toBe(1);
  });

  it("starts a new row when the GPU stage reports a new attempt straight after the old one", () => {
    const r = rack(
      [
        { stage: "queued", t_ms: 0 },
        { stage: "gpu", t_ms: 1_000, detail: "GPU node assigned" },
        { stage: "gpu", t_ms: 12_000, detail: "GPU node assigned (attempt 2)" },
      ],
      15_000,
    );
    expect(r.rows[1]).toMatchObject({ stage: "gpu", at: 1_000, took: 11_000, status: "done" });
    expect(r.rows[2]).toMatchObject({ stage: "gpu", at: 12_000, took: 3_000, status: "active", nth: 2 });
    expect(r.attempt).toBe(2);
  });

  it("treats the same stage reporting again as news about the bar that is running", () => {
    const r = rack(
      [
        { stage: "queued", t_ms: 0 },
        { stage: "weights", t_ms: 20_000, detail: "Fetching weights" },
        { stage: "weights", t_ms: 20_000, detail: "4.1 of 9.2 GB" },
      ],
      26_000,
    );
    expect(r.rows.filter((x) => x.stage === "weights")).toHaveLength(1);
    expect(r.rows[1]).toMatchObject({ stage: "weights", at: 20_000, took: 6_000, detail: "4.1 of 9.2 GB", of: 1 });
    expect(r.attempt).toBe(1);
  });

  it("stops the bars where live detail went away, while the clock keeps time", () => {
    const stages: StageEvent[] = [
      { stage: "queued", t_ms: 0 },
      { stage: "gpu", t_ms: 2_000 },
      { stage: "container", t_ms: 9_000 },
    ];
    const r = rack(stages, 30_000, 14_000);
    expect(r.rows[2]).toMatchObject({ status: "held", took: 5_000 });
    expect(r.rows[3]!.status).toBe("pending");
    expect(r.current).toBe("container");
    expect(r.elapsed).toBe(30_000);
    // Detail that went away before the last report still leaves that report in place.
    expect(rack(stages, 30_000, 5_000).rows[2]).toMatchObject({ status: "held", took: 0 });
    // A finished wake has nothing held.
    expect(rack([...stages, { stage: "ready", t_ms: 20_000 }], 30_000, 14_000).rows[2]!.status).toBe("done");
  });

  it("never lets a later report run the scale backwards", () => {
    const r = rack([{ stage: "queued", t_ms: 0 }, { stage: "gpu", t_ms: 5_000 }, { stage: "container", t_ms: 3_000 }], 6_000);
    expect(r.rows[2]!.at).toBe(5_000);
    expect(r.rows[1]!.took).toBe(0);
    expect(r.rows[2]!.took).toBe(1_000);
  });

  it("reads nothing past the event that ended the wake", () => {
    const r = rack(
      [
        { stage: "queued", t_ms: 0 },
        { stage: "gpu", t_ms: 1_000 },
        { stage: "failed", t_ms: 5_000, detail: "No GPU." },
        { stage: "gpu", t_ms: 6_000 },
        { stage: "ready", t_ms: 9_000 },
      ],
      20_000,
    );
    expect(r.failedAt).toBe(5_000);
    expect(r.readyAt).toBeNull();
    expect(r.elapsed).toBe(5_000);
    expect(r.rows[1]).toMatchObject({ status: "failed", took: 4_000, detail: "No GPU." });
    expect(r.rows.filter((x) => x.stage === "gpu")).toHaveLength(1);
    expect(r.attempt).toBe(1);
  });

  it("copes with no events yet", () => {
    const r = rack([], 1_500);
    expect(r.current).toBeNull();
    expect(r.rows.every((x) => x.status === "pending")).toBe(true);
    expect(r.elapsed).toBe(1_500);
  });
});

describe("time scale", () => {
  it("leaves room past the estimate, in whole 30 s steps", () => {
    expect(scaleMax(10, 0)).toBe(30_000);
    expect(scaleMax(60, 0)).toBe(90_000);
    expect(scaleMax(60, 200_000)).toBe(240_000);
  });
  it("labels a sensible number of ticks", () => {
    expect(ticks(60_000).major).toEqual([0, 10_000, 20_000, 30_000, 40_000, 50_000, 60_000]);
    expect(ticks(60_000).minor).toHaveLength(24);
    expect(ticks(90_000).major).toEqual([0, 30_000, 60_000, 90_000]);
    expect(ticks(90_000).minor).toHaveLength(15);
    expect(ticks(240_000).major).toHaveLength(5);
  });
  it("widens the steps when a wake goes round again and runs long", () => {
    expect(ticks(300_000).major).toEqual([0, 60_000, 120_000, 180_000, 240_000, 300_000]);
    expect(ticks(600_000).major).toEqual([0, 120_000, 240_000, 360_000, 480_000, 600_000]);
    expect(ticks(600_000).minor).toHaveLength(15);
    expect(ticks(1_200_000).major).toEqual([0, 300_000, 600_000, 900_000, 1_200_000]);
    for (const max of [300_000, 600_000, 1_200_000]) expect(ticks(max).major.length + ticks(max).minor.length).toBeLessThanOrEqual(31);
  });
  it("puts weight on the timer as the machine takes load", () => {
    expect(loadWeight(null, false)).toBe(200);
    expect(loadWeight("weights", false)).toBe(500);
    expect(loadWeight("engine", false)).toBeGreaterThan(loadWeight("gpu", false));
    expect(loadWeight(null, true)).toBe(800);
  });
});
