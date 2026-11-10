import { describe, expect, it } from "vitest";
import { reconcileSell } from "../src/tools/safety_check.js";
import type { SellSim } from "../src/util/sellsim.js";

const fresh = (verdict: SellSim["verdict"], cost: number | null): SellSim => ({
  method: "fresh_wallet_round_trip",
  verdict,
  pool_kind: "uniswap v4 (hooked pool)",
  quote_symbol: "ETH",
  trade_size_quote: 0.0005,
  wallets: [{ wallet: "0x" + "5a".repeat(20), wallet_kind: "fresh address", verdict, round_trip_cost: cost }],
});
const none: SellSim = { method: "none", verdict: "not_simulated", pool_kind: null, wallets: [], detail: "no pool" };

describe("sell test reconciliation with the index", () => {
  it("agree, both fine: one statement, simulation first", () => {
    const r = reconcileSell(fresh("ok", 0.012), { sell_test: "ok", round_trip_cost: 0.011 });
    expect(r.sim.agreement).toBe("agree");
    expect(r.sim.verdict).toBe("ok");
    expect(r.sentence).toMatch(/^sell test from a fresh wallet .*costs 1\.2%.*\(the index's router-route test agrees: it costs 1\.1%\)$/);
  });
  it("agree, both bad", () => {
    const r = reconcileSell(fresh("cannot_sell", 0.9), { sell_test: "costly", round_trip_cost: 0.97 });
    expect(r.sim.agreement).toBe("agree");
    expect(r.sim.verdict).toBe("cannot_sell");
    expect(r.sentence).toMatch(/^sell test from a fresh wallet: EFFECTIVELY CANNOT SELL/);
  });
  it("disagree, index worse: route-dependent trap headline", () => {
    const r = reconcileSell(fresh("ok", 0.049), { sell_test: "costly", round_trip_cost: 0.97 });
    expect(r.sim.agreement).toBe("disagree");
    expect(r.sim.verdict).toBe("cannot_sell");
    expect(r.sentence).toBe("SELL TESTS DISAGREE: the direct pool round trip costs 4.9%, the index's router-route test loses 97%: treat as a route-dependent sell trap until shown otherwise");
  });
  it("disagree, simulation worse", () => {
    const r = reconcileSell(fresh("reverted", null), { sell_test: "ok", round_trip_cost: 0.02 });
    expect(r.sim.agreement).toBe("disagree");
    expect(r.sim.verdict).toBe("reverted");
    expect(r.sentence).toBe("SELL TESTS DISAGREE: the direct pool round trip reverts, the index's router-route test costs 2.0%: treat as a sell trap until shown otherwise");
  });
  it("index only", () => {
    const r = reconcileSell(none, { sell_test: "blocked", round_trip_cost: null });
    expect(r.sim.agreement).toBe("index_only");
    expect(r.sim.verdict).toBe("reverted");
    expect(r.sentence).toMatch(/^SELL BLOCKED: the index's router-route sell test fails \(the sale reverts\); our own test: sell not simulated/);
  });
  it("simulation only (index not tested)", () => {
    const r = reconcileSell(fresh("costly", 0.3), { sell_test: "not_tested", round_trip_cost: null });
    expect(r.sim.agreement).toBe("simulation_only");
    expect(r.sim.verdict).toBe("costly");
    expect(r.sentence).toMatch(/COSTLY, a round trip of 0\.0005 ETH loses 30%/);
  });
});
