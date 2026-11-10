import { expect, it, vi } from "vitest";
import { rack } from "../src/lib/wake";

// The mock reads its options from the address when it loads, so this file hands it one before importing it.
// lane:2 is a wake as one kind of machine really reports it: the weights stage comes round twice.
// user:1 is a signed-in wallet, so the session is a paid one and its receipt shows how billing works.

it("replays a wake that reports the weights stage twice, and the view gives each run a row", async () => {
  const kept = new Map<string, string>();
  vi.stubGlobal("location", { search: "?mock=speed:400,lane:2,user:1" });
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) });
  const { mockFetch } = await import("../src/api/mock");
  const { createClient } = await import("../src/api/client");
  const api = createClient(mockFetch);

  const model = (await api.models()).find((m) => m.tier === "light" && m.state === "asleep")!;
  let s = await api.createSession(model.id, { minutes: 10 });
  expect(s.free).toBe(false);
  for (let i = 0; i < 80 && s.state === "waking"; i++) {
    await new Promise((r) => setTimeout(r, 50));
    s = await api.session(s.id);
  }
  expect(s.state).toBe("active");
  expect(s.stages.map((e) => e.stage)).toEqual(["queued", "gpu", "weights", "container", "weights", "engine", "ready"]);

  const r = rack(s.stages, 0);
  expect(r.rows.map((x) => x.stage)).toEqual(["queued", "gpu", "weights", "container", "weights", "engine", "ready"]);
  const weights = r.rows.filter((x) => x.stage === "weights");
  expect(weights.map((x) => `${x.nth}/${x.of}`)).toEqual(["1/2", "2/2"]);
  expect(weights[0]!.detail).toMatch(/^fetching .* to the machine$/);
  expect(weights[1]!.detail).toMatch(/^loading .* into the GPU$/);
  expect(weights[0]!.at).toBeLessThan(weights[1]!.at ?? 0);
  expect(r.attempt).toBe(1);

  // Billed by the second at the per-minute price, with a one-minute minimum, and the receipt keeps the real seconds.
  const ended = await api.stop(s.id);
  expect(ended.state).toBe("ended");
  expect(ended.receipt?.reason).toBe("stopped");
  const used = ended.receipt?.gpu_seconds ?? -1;
  expect(used).toBeGreaterThanOrEqual(0);
  expect(ended.receipt?.price_usd_micro).toBe(Math.ceil((Math.max(60, used) * model.price_usd_micro_per_min) / 60));
  expect(ended.receipt?.minutes).toBeCloseTo(used / 60, 2);
  vi.unstubAllGlobals();
});
