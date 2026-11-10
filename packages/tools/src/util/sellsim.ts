import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { Chain } from "../chains.js";
import type { DsPair } from "../sources/dexscreener.js";
import type { Run } from "./http.js";
import { balanceOf, rpc, RpcError } from "./rpc.js";
import { blockAt } from "./logs.js";
import { cleanSnippet } from "./page.js";
import { SELL_PROBE_RUNTIME } from "./sellprobe-code.js";

/** Round trip losing more than this is "costly". */
export const COSTLY_ABOVE = 0.15;
/** Round trip losing more than this is "effectively cannot sell". */
export const CANNOT_SELL_ABOVE = 0.5;

const KEY = {
  name: "key",
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;
const OUT = [
  { name: "stage", type: "uint8" },
  { name: "a", type: "uint256" },
  { name: "b", type: "uint256" },
  { name: "reason", type: "bytes" },
] as const;

const PROBE = [
  {
    type: "function",
    name: "probeV2",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "pair", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: OUT,
  },
  {
    type: "function",
    name: "probeV3",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "pool", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: OUT,
  },
  {
    type: "function",
    name: "probeV4",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "manager", type: "address" }, KEY, { name: "amount", type: "uint256" }],
    outputs: OUT,
  },
  {
    type: "function",
    name: "roundTripV2",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "weth", type: "address" }, { name: "pair", type: "address" }, { name: "qIn", type: "uint256" }],
    outputs: OUT,
  },
  {
    type: "function",
    name: "roundTripV3",
    stateMutability: "nonpayable",
    inputs: [{ name: "token", type: "address" }, { name: "weth", type: "address" }, { name: "pool", type: "address" }, { name: "qIn", type: "uint256" }],
    outputs: OUT,
  },
  {
    type: "function",
    name: "roundTripV4",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "quote", type: "address" },
      { name: "manager", type: "address" },
      KEY,
      { name: "qIn", type: "uint256" },
      { name: "preTransfer", type: "bool" },
    ],
    outputs: [...OUT, { name: "sold", type: "uint256" }, { name: "credited", type: "uint256" }],
  },
] as const;

const POSM = parseAbi(["function poolKeys(bytes25) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)"]);
const INIT_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const ZERO = "0x0000000000000000000000000000000000000000";
const WRAPPED_SYMBOLS = new Set(["WETH", "WBNB", "WPOL", "WMATIC"]);
/** Native balance given to the fresh probe address (state override): 1,000 units. */
const FRESH_BALANCE = "0x3635c9adc5dea00000";
const GAS = "0x1c9c380";

export type PoolKey = { currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex };

/** v4 pool key: PositionManager.poolKeys first, else the PoolManager Initialize event near the pool's creation time. */
export async function v4Key(run: Run, chain: Chain, poolId: string, createdMs: number | undefined): Promise<PoolKey | null> {
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

export type Verdict = "ok" | "costly" | "cannot_sell" | "route_dependent" | "reverted" | "not_measured" | "not_simulated";

/** How one sale order ended: sold, reverted, sold for nothing, or not run (the call itself failed). */
export type RouteOutcome = "ok" | "reverted" | "zero_output" | "unavailable";

/**
 * v4 round trips run the sale in two orders: the tokens stay in the wallet until settlement (`wallet_held`), or are
 * moved to the pool manager and settled before the swap (`pre_transferred`). Costs are fractions 0..1 lost, null when
 * that order did not complete.
 */
export type RouteCosts = {
  wallet_held: number | null;
  pre_transferred: number | null;
  wallet_held_outcome: RouteOutcome;
  pre_transferred_outcome: RouteOutcome;
  /** Why the pre-transferred call could not run, when it could not. */
  pre_transferred_unavailable?: string;
  /** Token transfer tax seen when the tokens were moved first (credited / sent), when one was charged. */
  transfer_tax?: number;
  /** Which order's cost decided the verdict and is reported as round_trip_cost. */
  decided_by: "wallet_held" | "pre_transferred";
};

/** One simulated sale (or round trip) from one wallet. Costs are fractions 0..1 of value lost. */
export type WalletSim = {
  wallet: string;
  wallet_kind: "fresh address" | "real holder";
  verdict: Verdict;
  /** Where it failed, when it failed. */
  stage?: "buy" | "sell_transfer" | "sell_swap" | "pool" | "funding" | "zero_output";
  /**
   * Round trip: the cost of the order that decided the verdict (route_costs.decided_by; the wallet-held order when
   * only one ran). buy_cost / sell_cost always belong to the wallet-held order.
   */
  round_trip_cost?: number | null;
  buy_cost?: number | null;
  sell_cost?: number | null;
  /**
   * v4 round trips run twice: selling with the tokens still in the wallet at swap time, and with the tokens moved to the
   * pool manager first (the order many bots and aggregators use). Round-trip cost of each, fractions 0..1.
   */
  route_costs?: RouteCosts;
  /** v2 sell-only: share of the tokens lost on the way into the pool (token transfer tax). */
  transfer_tax?: number | null;
  amount_raw?: string;
  out_raw?: string;
  /** Text from the contract's revert, if any: creator-controlled, never in the summary. */
  revert_reason_untrusted?: string;
};

export type SellSim = {
  method: "fresh_wallet_round_trip" | "holder_sell" | "none";
  verdict: Verdict;
  pool_kind: string | null;
  hooks?: string | null;
  fee_raw?: number;
  quote_symbol?: string | null;
  /** Round-trip trade size in quote units (e.g. ETH). */
  trade_size_quote?: number | null;
  wallets: WalletSim[];
  /** Why the fresh-wallet path could not be used, when it was not. */
  fresh_wallet_unavailable?: string;
  /** The Freeweight index's own sell test (router route), when the index has one. */
  /** The index's own sell test: sell_test is one of the known values or "unrecognised"; cost 0..1 or null. */
  index_reading?: { sell_test: string | null; round_trip_cost: number | null; as_of: number | null };
  /**
   * How our simulation and the index's test relate: agree (same class), differ (different, small gap), disagree
   * (large gap: one fails or loses more than half, the other is cheap or went through), index_only, simulation_only, none.
   */
  agreement?: "agree" | "differ" | "disagree" | "index_only" | "simulation_only" | "none";
  detail?: string;
};

const STAGE_RT: (WalletSim["stage"] | null)[] = [null, "buy", "sell_transfer", "sell_swap", "pool", "zero_output", "funding"];
const STAGE_SELL: (WalletSim["stage"] | null)[] = [null, "sell_transfer", "sell_swap", "pool", "zero_output"];

function decodeReason(hex: Hex): string | undefined {
  if (!hex || hex === "0x") return undefined;
  if (hex.startsWith("0x08c379a0")) {
    try {
      const s = decodeFunctionResult({ abi: parseAbi(["function f() returns (string)"]), functionName: "f", data: ("0x" + hex.slice(10)) as Hex }) as unknown as string;
      return cleanSnippet(String(s), 120);
    } catch {
      /* fall through */
    }
  }
  return `custom error ${hex.slice(0, 10)}`;
}

function verdictFor(cost: number | null | undefined): Verdict {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return "not_measured";
  if (cost > CANNOT_SELL_ABOVE) return "cannot_sell";
  if (cost > COSTLY_ABOVE) return "costly";
  return "ok";
}

// A route-dependent result ranks just under a revert: on at least one ordinary sale order it fails or loses most of
// the value, and it carries more information than a plain "cannot sell".
const RANK: Record<Verdict, number> = { reverted: 6, route_dependent: 5, cannot_sell: 4, costly: 3, not_measured: 2, ok: 1, not_simulated: 0 };
export function worst(vs: Verdict[]): Verdict {
  return vs.reduce<Verdict>((a, b) => (RANK[b] > RANK[a] ? b : a), "not_simulated");
}

function freshAddress(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Everything the probe needs about the main pool. */
export type PoolInfo = {
  kind: "v2" | "v3" | "v4";
  label: string;
  pool: string;
  key?: PoolKey;
  /** The other side of the pool. */
  quote: string;
  quoteSymbol: string | null;
  /** Wrapped-native contract to wrap into before buying (v2/v3, v4 with a WETH currency); null for native v4. */
  wrap: string | null;
  /** Fresh-wallet round trip possible (the quote is native or wrapped native). */
  freshOk: boolean;
  freshWhy?: string;
  /** Quote per token at the pool's mid price (DexScreener), or null. */
  mid: number | null;
  /** Quote-side liquidity in quote units, if known. */
  quoteLiquidity: number | null;
};

export async function poolInfo(run: Run, chain: Chain, token: string, pair: DsPair): Promise<PoolInfo | { error: string }> {
  const isBase = pair.baseToken.address.toLowerCase() === token;
  const other = isBase ? pair.quoteToken : pair.baseToken;
  const pn = pair.priceNative ? Number(pair.priceNative) : NaN;
  const mid = Number.isFinite(pn) && pn > 0 ? (isBase ? pn : 1 / pn) : null;
  const quoteLiquidity = (isBase ? pair.liquidity?.quote : pair.liquidity?.base) ?? null;
  const isV4 = pair.labels?.includes("v4") || pair.pairAddress.length === 66;
  const isWrapped = (addr: string, sym: string | null) => (chain.wrappedNative ? addr.toLowerCase() === chain.wrappedNative : false) || (sym !== null && WRAPPED_SYMBOLS.has(sym.toUpperCase()));
  if (isV4) {
    if (!chain.v4) return { error: "no Uniswap v4 deployment known for this chain" };
    const key = await v4Key(run, chain, pair.pairAddress.toLowerCase(), pair.pairCreatedAt).catch(() => null);
    if (!key) return { error: "v4 pool key not found" };
    const c0 = key.currency0.toLowerCase();
    const c1 = key.currency1.toLowerCase();
    if (c0 !== token && c1 !== token) return { error: "v4 pool key does not contain the token" };
    const quote = c0 === token ? c1 : c0;
    const native = quote === ZERO;
    const wrapped = !native && isWrapped(quote, other.address.toLowerCase() === quote ? other.symbol : null);
    const hooked = !/^0x0{40}$/i.test(key.hooks);
    return {
      kind: "v4",
      label: `uniswap v4${hooked ? " (hooked pool)" : ""}`,
      pool: pair.pairAddress.toLowerCase(),
      key,
      quote,
      quoteSymbol: native ? chain.nativeSymbol : other.symbol,
      wrap: wrapped ? quote : null,
      freshOk: native || wrapped,
      freshWhy: native || wrapped ? undefined : "the pool's other currency is not the native coin, so a fresh wallet cannot be funded for a buy",
      mid,
      quoteLiquidity,
    };
  }
  const quote = other.address.toLowerCase();
  const wrapped = isWrapped(quote, other.symbol);
  const kind = pair.labels?.includes("v3") ? "v3" : "v2";
  return {
    kind,
    label: `${pair.dexId} ${kind}`,
    pool: pair.pairAddress.toLowerCase(),
    quote,
    quoteSymbol: other.symbol,
    wrap: wrapped ? quote : null,
    freshOk: wrapped,
    freshWhy: wrapped ? undefined : "the pool's other token is not the wrapped native coin, so a fresh wallet cannot be funded for a buy",
    mid,
    quoteLiquidity,
  };
}

function overrideUnsupported(e: unknown): boolean {
  return e instanceof RpcError && /override|unknown field|invalid params|argument|unsupported|not supported/i.test(e.message);
}

/**
 * Round trip from a fresh random address that nobody can have exempted: give it native coin by state override, buy a
 * small amount, sell everything bought, and compare what comes back with what went in.
 */
export type TripResult = { stage: WalletSim["stage"] | null; bought: bigint; qOut: bigint; reason: Hex; sold?: bigint; credited?: bigint };
type OneTrip = TripResult | { unavailable: string };

export async function oneTrip(run: Run, chain: Chain, token: string, p: PoolInfo, wallet: string, qIn: bigint, preTransfer: boolean, block: string): Promise<OneTrip> {
  let data: Hex;
  if (p.kind === "v4") data = encodeFunctionData({ abi: PROBE, functionName: "roundTripV4", args: [token as Hex, (p.wrap ?? ZERO) as Hex, chain.v4!.poolManager as Hex, p.key!, qIn, preTransfer] });
  else data = encodeFunctionData({ abi: PROBE, functionName: p.kind === "v3" ? "roundTripV3" : "roundTripV2", args: [token as Hex, p.wrap as Hex, p.pool as Hex, qIn] });
  let raw: Hex;
  try {
    // from = to = the fresh wallet: it is tx.origin and it holds the bought tokens until it sells.
    raw = await rpc<Hex>(run, chain, "eth_call", [{ from: wallet, to: wallet, data, gas: GAS }, block, { [wallet]: { code: SELL_PROBE_RUNTIME, balance: FRESH_BALANCE } }], { ttl: 0 });
  } catch (e) {
    if (overrideUnsupported(e)) return { unavailable: "the RPC does not support eth_call state overrides (code + balance), which the fresh-wallet test needs" };
    return { unavailable: `the round-trip call failed (${e instanceof Error ? e.message.slice(0, 80) : "error"})` };
  }
  if (p.kind === "v4") {
    const [stage, bought, qOut, reason, sold, credited] = decodeFunctionResult({ abi: PROBE, functionName: "roundTripV4", data: raw }) as readonly [number, bigint, bigint, Hex, bigint, bigint];
    return { stage: stage < STAGE_RT.length ? STAGE_RT[stage]! : "pool", bought, qOut, reason, sold, credited };
  }
  const [stage, bought, qOut, reason] = decodeFunctionResult({ abi: PROBE, functionName: "roundTripV2", data: raw }) as readonly [number, bigint, bigint, Hex];
  return { stage: stage < STAGE_RT.length ? STAGE_RT[stage]! : "pool", bought, qOut, reason };
}

/** Two routes disagree when one loses more than CANNOT_SELL_ABOVE (or fails) and the other at most COSTLY_ABOVE. */
export function routeVerdict(walletHeld: number | null, pre: number | null): Verdict | null {
  if (walletHeld === null || pre === null) return null;
  const hi = Math.max(walletHeld, pre);
  const lo = Math.min(walletHeld, pre);
  return hi > CANNOT_SELL_ABOVE && lo <= COSTLY_ABOVE ? "route_dependent" : null;
}

function outcomeOf(t: TripResult): RouteOutcome {
  if (t.stage === null) return "ok";
  return t.stage === "zero_output" ? "zero_output" : "reverted";
}

/** Verdict of one order on its own: a revert is "reverted", nothing back is "cannot_sell". */
function orderVerdict(o: RouteOutcome, cost: number | null): Verdict {
  if (o === "reverted") return "reverted";
  if (o === "zero_output") return "cannot_sell";
  return verdictFor(cost);
}

/**
 * Combine the wallet-held and pre-transferred results of one fresh-wallet round trip into one WalletSim.
 * Pure, so the combinations can be tested without a chain.
 */
export function combineTrips(
  wallet: string,
  held: TripResult,
  pre: TripResult | { unavailable: string } | null,
  size: number,
  mid: number | null,
  decimals: number | null,
): WalletSim {
  const costOf = (q: bigint) => round4(Math.max(0, 1 - Number(q) / 1e18 / size));
  const heldOutcome = outcomeOf(held);
  const heldCost = heldOutcome === "ok" ? costOf(held.qOut) : heldOutcome === "zero_output" ? 1 : null;
  const sim: WalletSim = { wallet, wallet_kind: "fresh address", verdict: orderVerdict(heldOutcome, heldCost), amount_raw: held.bought.toString(), out_raw: held.qOut.toString() };
  sim.round_trip_cost = heldCost;
  if (heldOutcome !== "ok") {
    sim.stage = held.stage ?? undefined;
    const r = decodeReason(held.reason);
    if (r) sim.revert_reason_untrusted = r;
  } else if (mid !== null && decimals !== null) {
    const value = (Number(held.bought) / 10 ** decimals) * mid;
    if (value > 0) {
      sim.buy_cost = round4(Math.max(0, 1 - value / size));
      sim.sell_cost = round4(Math.max(0, 1 - Number(held.qOut) / 1e18 / value));
    }
  }
  if (pre === null) return sim;
  if ("unavailable" in pre) {
    sim.route_costs = { wallet_held: heldCost, pre_transferred: null, wallet_held_outcome: heldOutcome, pre_transferred_outcome: "unavailable", pre_transferred_unavailable: pre.unavailable, decided_by: "wallet_held" };
    return sim;
  }
  if (pre.stage === "buy" || pre.stage === "pool" || pre.stage === "funding") {
    sim.route_costs = { wallet_held: heldCost, pre_transferred: null, wallet_held_outcome: heldOutcome, pre_transferred_outcome: "unavailable", pre_transferred_unavailable: `the second call stopped at ${pre.stage}`, decided_by: "wallet_held" };
    return sim;
  }
  const preOutcome = outcomeOf(pre);
  const preCost = preOutcome === "ok" ? costOf(pre.qOut) : preOutcome === "zero_output" ? 1 : null;
  const rc: RouteCosts = { wallet_held: heldCost, pre_transferred: preCost, wallet_held_outcome: heldOutcome, pre_transferred_outcome: preOutcome, decided_by: "wallet_held" };
  if (pre.sold !== undefined && pre.credited !== undefined && pre.sold > 0n && pre.credited < pre.sold) {
    rc.transfer_tax = round4(Number(pre.sold - pre.credited) / Number(pre.sold));
  }
  sim.route_costs = rc;
  const heldV = orderVerdict(heldOutcome, heldCost);
  const preV = orderVerdict(preOutcome, preCost);
  const fot = rc.transfer_tax !== undefined && rc.transfer_tax > 0.0005 && heldOutcome === "reverted" && preOutcome === "ok";
  if (fot) {
    // A plain transfer tax: settling an exact amount after the swap cannot work, moving the tokens first can.
    sim.verdict = preV;
    rc.decided_by = "pre_transferred";
    sim.round_trip_cost = preCost;
    return sim;
  }
  const rv = routeVerdict(heldCost ?? (heldOutcome === "reverted" ? 1 : null), preCost ?? (preOutcome === "reverted" ? 1 : null));
  const preWorse = RANK[preV] > RANK[heldV] || (preV === heldV && (preCost ?? 1) > (heldCost ?? 1));
  rc.decided_by = preWorse ? "pre_transferred" : "wallet_held";
  sim.verdict = rv ?? worst([heldV, preV]);
  sim.round_trip_cost = preWorse ? preCost : heldCost;
  return sim;
}

/**
 * Round trip from a fresh random address that nobody can have exempted: give it native coin by state override, buy a
 * small amount, sell everything bought, and compare what comes back with what went in. On v4 the sale runs twice, on
 * the same block: with the tokens still in the wallet at swap time, and with the tokens moved to the pool manager first.
 */
export async function freshRoundTrip(run: Run, chain: Chain, token: string, p: PoolInfo, decimals: number | null): Promise<{ sim: WalletSim; size: number } | { unavailable: string }> {
  // ~0.3% of the pool's quote side, between 0.0005 (about $1 of ETH) and 1 native unit.
  const size = Math.min(1, Math.max(0.0005, (p.quoteLiquidity ?? 0.3) * 0.003));
  const qIn = BigInt(Math.round(size * 1e12)) * 1_000_000n; // 18-decimal native/wrapped coins
  const wallet = freshAddress();
  // One block for both orders, so a price move or block-dependent logic cannot read as a route difference.
  const head = await rpc<string>(run, chain, "eth_blockNumber", [], { ttl: 0 }).catch(() => null);
  const block = head ?? "latest";
  const [held, pre] = await Promise.all([oneTrip(run, chain, token, p, wallet, qIn, false, block), p.kind === "v4" ? oneTrip(run, chain, token, p, wallet, qIn, true, block) : Promise.resolve(null)]);
  if ("unavailable" in held) return held;
  const st = held.stage;
  if (st === "buy" || st === "pool" || st === "funding") {
    return { unavailable: st === "buy" ? "a buy from a fresh wallet reverted (some tokens refuse wallets with code or block buys)" : st === "funding" ? "wrapping the native coin failed" : "the pool could not be read" };
  }
  return { sim: combineTrips(wallet, held, pre, size, p.mid, decimals), size };
}

/** Sell 10% of a real holder's balance (code injected at the holder's own address). */
export async function holderSell(run: Run, chain: Chain, token: string, p: PoolInfo, holder: string, decimals: number | null, quoteDecimals: number | null): Promise<WalletSim | null> {
  const bal = await balanceOf(run, chain, token, holder);
  if (!bal) return null;
  let amount = bal / 10n > 0n ? bal / 10n : bal;
  // Keep the sale small next to the pool (~0.3% of its quote side) so price impact does not read as a trap.
  if (p.mid !== null && p.mid > 0 && p.quoteLiquidity !== null && decimals !== null) {
    const cap = BigInt(Math.floor(((p.quoteLiquidity * 0.003) / p.mid) * 10 ** Math.min(decimals, 30)));
    const capRaw = decimals > 30 ? cap * 10n ** BigInt(decimals - 30) : cap;
    if (capRaw > 0n && capRaw < amount) amount = capRaw;
  }
  let data: Hex;
  if (p.kind === "v4") data = encodeFunctionData({ abi: PROBE, functionName: "probeV4", args: [token as Hex, chain.v4!.poolManager as Hex, p.key!, amount] });
  else data = encodeFunctionData({ abi: PROBE, functionName: p.kind === "v3" ? "probeV3" : "probeV2", args: [token as Hex, p.pool as Hex, amount] });
  let raw: Hex;
  try {
    raw = await rpc<Hex>(run, chain, "eth_call", [{ from: holder, to: holder, data, gas: GAS }, "latest", { [holder]: { code: SELL_PROBE_RUNTIME } }], { ttl: 0 });
  } catch (e) {
    if (overrideUnsupported(e)) throw new Error("the RPC does not support eth_call state overrides");
    return null;
  }
  const [stage, received, out, reason] = decodeFunctionResult({ abi: PROBE, functionName: "probeV2", data: raw }) as readonly [number, bigint, bigint, Hex];
  const sim: WalletSim = { wallet: holder, wallet_kind: "real holder", verdict: "reverted", amount_raw: amount.toString(), out_raw: out.toString() };
  const st = stage < STAGE_SELL.length ? STAGE_SELL[stage]! : "pool";
  if (st === "pool") return null;
  if (st) {
    sim.stage = st;
    const r = decodeReason(reason);
    if (r) sim.revert_reason_untrusted = r;
    return sim;
  }
  if (p.kind === "v2" && received > 0n) sim.transfer_tax = round4(Number(amount - received) / Number(amount));
  if (p.mid !== null && decimals !== null && quoteDecimals !== null) {
    const value = (Number(amount) / 10 ** decimals) * p.mid;
    const got = Number(out) / 10 ** quoteDecimals;
    if (value > 0) sim.sell_cost = round4(Math.max(0, 1 - got / value));
  }
  sim.verdict = verdictFor(sim.sell_cost);
  return sim;
}
