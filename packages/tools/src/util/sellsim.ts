import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { Chain } from "../chains.js";
import type { DsPair } from "../sources/dexscreener.js";
import type { Run } from "./http.js";
import { balanceOf, rpc, RpcError } from "./rpc.js";
import { SELL_PROBE_RUNTIME } from "./sellprobe-code.js";

const PROBE = parseAbi([
  "function probeV2(address token, address pair, uint256 amount) returns (uint8 stage, uint256 received, uint256 out, bytes reason)",
  "function probeV3(address token, address pool, uint256 amount) returns (uint8 stage, uint256 received, uint256 out, bytes reason)",
]);

export type SellSim = {
  method: string;
  result: "ok" | "transfer_failed" | "swap_reverted" | "zero_out" | "not_simulated";
  pool_kind?: string;
  holder?: string;
  amount_raw?: string;
  received_by_pool_raw?: string;
  out_raw?: string;
  quote?: string;
  /** Token-level transfer tax measured on the way into the pool (v2 only), percent. */
  tax_pct?: number | null;
  detail?: string;
};

const STAGES: SellSim["result"][] = ["ok", "transfer_failed", "swap_reverted", "not_simulated", "zero_out"];

function decodeReason(hex: Hex): string {
  if (!hex || hex === "0x") return "no reason";
  if (hex.startsWith("0x08c379a0")) {
    try {
      const [s] = decodeFunctionResult({ abi: parseAbi(["function f() returns (string)"]), functionName: "f", data: ("0x" + hex.slice(10)) as Hex }) as unknown as [string];
      return String(s).slice(0, 120);
    } catch {
      /* fallthrough */
    }
  }
  return `custom error ${hex.slice(0, 10)}`;
}

/**
 * Simulate selling 10% of a real holder's balance into the main pool via eth_call with a code override at the holder
 * address (the SellProbe helper). Uniswap v2/v3-style pools only; v4 (singleton + hooks) is reported as not simulated.
 */
export async function simulateSell(run: Run, chain: Chain, token: string, pair: DsPair, holder: string): Promise<SellSim> {
  const isV4 = pair.labels?.includes("v4") || pair.pairAddress.length === 66;
  if (isV4) return { method: "swap_sim", result: "not_simulated", pool_kind: "uniswap v4", detail: "v4 pools (singleton PoolManager + hooks) are not simulated" };
  const pool = pair.pairAddress.toLowerCase();
  const bal = await balanceOf(run, chain, token, holder);
  if (!bal) return { method: "swap_sim", result: "not_simulated", detail: "holder balance unreadable or zero" };
  const amount = bal / 10n > 0n ? bal / 10n : bal;
  const quote = pair.baseToken.address.toLowerCase() === token ? pair.quoteToken.symbol : pair.baseToken.symbol;
  const kinds: ("v2" | "v3")[] = pair.labels?.includes("v3") ? ["v3"] : pair.labels?.includes("v2") ? ["v2"] : ["v2", "v3"];
  let lastDetail = "";
  for (const k of kinds) {
    const fn = k === "v2" ? "probeV2" : "probeV3";
    const data = encodeFunctionData({ abi: PROBE, functionName: fn, args: [token as Hex, pool as Hex, amount] });
    let raw: Hex;
    try {
      raw = await rpc<Hex>(run, chain, "eth_call", [{ from: holder, to: holder, data, gas: "0x1c9c380" }, "latest", { [holder]: { code: SELL_PROBE_RUNTIME } }], { ttl: 0 });
    } catch (e) {
      if (e instanceof RpcError && /override|unknown field|invalid params|argument/i.test(e.message)) {
        return { method: "swap_sim", result: "not_simulated", pool_kind: k, detail: "RPC does not support state overrides" };
      }
      lastDetail = e instanceof Error ? e.message.slice(0, 120) : "error";
      continue;
    }
    const [stage, received, out, reason] = decodeFunctionResult({ abi: PROBE, functionName: fn, data: raw }) as readonly [number, bigint, bigint, Hex];
    const result = STAGES[stage] ?? "not_simulated";
    if (result === "not_simulated" && kinds.length > 1) {
      lastDetail = "pool interface mismatch";
      continue;
    }
    const sim: SellSim = {
      method: "swap_sim",
      result,
      pool_kind: `${pair.dexId} ${k}`,
      holder,
      amount_raw: amount.toString(),
      received_by_pool_raw: received.toString(),
      out_raw: out.toString(),
      quote,
      tax_pct: k === "v2" && received > 0n ? Number(((amount - received) * 10000n) / amount) / 100 : k === "v3" && result === "ok" ? 0 : null,
    };
    if (result !== "ok") {
      const why = decodeReason(reason);
      sim.detail = k === "v3" && why.includes("IIA") ? "pool rejected the payment (IIA): fee-on-transfer token cannot sell into a v3 pool" : why;
    }
    return sim;
  }
  return { method: "swap_sim", result: "not_simulated", detail: lastDetail || "pool kind unknown" };
}
