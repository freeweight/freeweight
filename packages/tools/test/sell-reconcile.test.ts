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

import { describeSell } from "../src/tools/safety_check.js";
import { routeVerdict } from "../src/util/sellsim.js";

describe("route-dependent sell traps (v4 wallet-held vs pre-transferred sale)", () => {
  it("flags only when one route is effectively unsellable and the other is cheap", () => {
    expect(routeVerdict(0.049, 0.9999)).toBe("route_dependent");
    expect(routeVerdict(0.9999, 0.03)).toBe("route_dependent");
    expect(routeVerdict(0.049, 0.049)).toBeNull();
    expect(routeVerdict(0.3, 0.9)).toBeNull(); // both bad: the worse verdict applies instead
    expect(routeVerdict(null, 0.9)).toBeNull();
  });
  it("says which route is cheap and which loses", () => {
    const s: SellSim = {
      ...fresh("route_dependent", 0.049),
      wallets: [{ wallet: "0x" + "5a".repeat(20), wallet_kind: "fresh address", verdict: "route_dependent", round_trip_cost: 0.049, route_costs: { wallet_held: 0.049, pre_transferred: 0.9999 } }],
    };
    expect(describeSell(s)).toBe("SELL DEPENDS ON THE ROUTE: selling straight from the wallet costs 4.9%, routes that move the tokens first lose 100% (fresh wallet, uniswap v4 (hooked pool))");
    // A route-dependent simulation and an index test that loses 97% agree (both bad): one statement.
    const r = reconcileSell(s, { sell_test: "costly", round_trip_cost: 0.97 });
    expect(r.sim.agreement).toBe("agree");
    expect(r.sentence).toMatch(/^SELL DEPENDS ON THE ROUTE/);
  });
  it("mentions the pre-transferred cost only when it differs", () => {
    const same: SellSim = { ...fresh("ok", 0.049), wallets: [{ wallet: "0x" + "5a".repeat(20), wallet_kind: "fresh address", verdict: "ok", round_trip_cost: 0.049, route_costs: { wallet_held: 0.049, pre_transferred: 0.049 } }] };
    expect(describeSell(same)).not.toMatch(/moving the tokens first/);
    const differs: SellSim = { ...fresh("ok", 0.03), wallets: [{ wallet: "0x" + "5a".repeat(20), wallet_kind: "fresh address", verdict: "ok", round_trip_cost: 0.03, route_costs: { wallet_held: 0.03, pre_transferred: 0.08 } }] };
    expect(describeSell(differs)).toMatch(/; moving the tokens first: 8\.0%$/);
  });
});
