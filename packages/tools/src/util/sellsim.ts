import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { Chain } from "../chains.js";
import type { DsPair } from "../sources/dexscreener.js";
import type { Run } from "./http.js";
import { balanceOf, rpc, RpcError } from "./rpc.js";
import { blockAt } from "./logs.js";
import { SELL_PROBE_RUNTIME } from "./sellprobe-code.js";

const PROBE_V4 = [
  {
    type: "function",
    name: "probeV4",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "manager", type: "address" },
      {
        name: "key",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "amount", type: "uint256" },
    ],
    outputs: [
      { name: "stage", type: "uint8" },
      { name: "received", type: "uint256" },
      { name: "out", type: "uint256" },
      { name: "reason", type: "bytes" },
    ],
  },
] as const;

const POSM = parseAbi(["function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"]);
const INIT_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";

type PoolKey = { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };

/** v4 pool key: PositionManager.poolKeys first, else the PoolManager Initialize event near the pool's creation time. */
async function v4Key(run: Run, chain: Chain, poolId: string, createdMs: number | undefined): Promise<PoolKey | null> {
  const v4 = chain.v4!;
  try {
    const raw = await rpc<Hex>(run, chain, "eth_call", [{ to: v4.positionManager, data: encodeFunctionData({ abi: POSM, functionName: "poolKeys", args: [poolId.slice(0, 52) as Hex] }) }, "latest"], { ttl: 3600 });
    const [c0, c1, fee, ts, hooks] = decodeFunctionResult({ abi: POSM, functionName: "poolKeys", data: raw }) as readonly [Hex, Hex, number, number, Hex];
    if (!/^0x0{40}$/i.test(c0) || !/^0x0{40}$/i.test(c1)) return { currency0: c0, currency1: c1, fee, tickSpacing: ts, hooks };
  } catch {
    /* fall through */
  }
  if (!createdMs) return null;
  const from = await blockAt(run, chain, createdMs - 15 * 60_000);
  const to = await blockAt(run, chain, createdMs + 15 * 60_000);
  const logs = await rpc<{ topics: Hex[]; data: Hex }[]>(run, chain, "eth_getLogs", [{ address: v4.poolManager, topics: [INIT_TOPIC, poolId], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }], { ttl: 3600, timeoutMs: 9000 });
  const l = logs[0];
  if (!l || l.topics.length < 4) return null;
  const d = l.data.slice(2);
  const word = (i: number) => d.slice(i * 64, i * 64 + 64);
  const fee = Number(BigInt("0x" + word(0)));
  let ts = Number(BigInt("0x" + word(1)) & 0xffffffn);
  if (ts >= 0x800000) ts -= 0x1000000;
  return { currency0: ("0x" + l.topics[2]!.slice(26)) as Hex, currency1: ("0x" + l.topics[3]!.slice(26)) as Hex, fee, tickSpacing: ts, hooks: ("0x" + word(2).slice(24)) as Hex };
}

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
  /** v4 only: the pool's hook contract and raw fee field (0x800000 = dynamic fee). */
  hooks?: string;
  fee_raw?: number;
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
  const pool = pair.pairAddress.toLowerCase();
  const bal = await balanceOf(run, chain, token, holder);
  if (!bal) return { method: "swap_sim", result: "not_simulated", detail: "holder balance unreadable or zero" };
  const amount = bal / 10n > 0n ? bal / 10n : bal;
  const quote = pair.baseToken.address.toLowerCase() === token ? pair.quoteToken.symbol : pair.baseToken.symbol;
  if (isV4) {
    if (!chain.v4) return { method: "swap_sim", result: "not_simulated", pool_kind: "uniswap v4", detail: "no v4 deployment known for this chain" };
    const key = await v4Key(run, chain, pool, pair.pairCreatedAt).catch(() => null);
    if (!key) return { method: "swap_sim", result: "not_simulated", pool_kind: "uniswap v4", detail: "v4 pool key not found" };
    if (key.currency0.toLowerCase() !== token && key.currency1.toLowerCase() !== token) return { method: "swap_sim", result: "not_simulated", pool_kind: "uniswap v4", detail: "pool key does not contain the token" };
    const data = encodeFunctionData({ abi: PROBE_V4, functionName: "probeV4", args: [token as Hex, chain.v4.poolManager as Hex, key, amount] });
    let raw: Hex;
    try {
      raw = await rpc<Hex>(run, chain, "eth_call", [{ from: holder, to: holder, data, gas: "0x1c9c380" }, "latest", { [holder]: { code: SELL_PROBE_RUNTIME } }], { ttl: 0 });
    } catch (e) {
      return { method: "swap_sim", result: "not_simulated", pool_kind: "uniswap v4", detail: e instanceof Error ? e.message.slice(0, 120) : "error" };
    }
    const [stage, paid, out, reason] = decodeFunctionResult({ abi: PROBE_V4, functionName: "probeV4", data: raw }) as readonly [number, bigint, bigint, Hex];
    const result = STAGES[stage] ?? "not_simulated";
    const hooked = !/^0x0{40}$/i.test(key.hooks);
    const sim: SellSim = {
      method: "swap_sim",
      result,
      pool_kind: `uniswap v4${hooked ? " (hooked pool)" : ""}`,
      holder,
      amount_raw: amount.toString(),
      received_by_pool_raw: paid.toString(),
      out_raw: out.toString(),
      quote,
      tax_pct: null,
      hooks: key.hooks.toLowerCase(),
      fee_raw: key.fee,
    };
    if (result !== "ok") sim.detail = decodeReason(reason);
    return sim;
  }
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
