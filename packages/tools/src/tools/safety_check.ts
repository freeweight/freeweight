import { encodeFunctionData, parseAbi, type Hex } from "viem";
import type { Chain } from "../chains.js";
import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, short, TOKEN_PROP } from "../util/args.js";
import { soft, type Run } from "../util/http.js";
import { blockNumber, ethCall, isRevert, ownerOf, rpc, rpcBatch, tri, type Tri } from "../util/rpc.js";
import { scanTransfers } from "../util/logs.js";
import { DEAD_ADDRESSES, EIP1967_ADMIN, EIP1967_BEACON, EIP1967_IMPL, minimalProxyTarget, push4Selectors, scanRisk, slotAddress } from "../util/bytecode.js";
import { goplusToken, flag, type GoPlusToken } from "../sources/goplus.js";
import { sourcify } from "../sources/sourcify.js";
import { pickMainPool, tokenPairs } from "../sources/dexscreener.js";
import { tokenHolders } from "../sources/explorer.js";
import { cleanSnippet } from "../util/page.js";
import { describe } from "../sources/facts.js";
import { CANNOT_SELL_ABOVE, COSTLY_ABOVE, freshRoundTrip, holderSell, poolInfo, worst, type RouteCosts, type RouteOutcome, type SellSim, type Verdict, type WalletSim } from "../util/sellsim.js";

const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)", "function decimals() view returns (uint8)"]);
const FRESH = "0x000000000000000000000000000000000000f4ee";

type TransferSim = { from: string; to: string; to_kind: string; amount_raw: string; result: "ok" | "reverted" | "returned_false" | "error"; revert_reason_untrusted?: string };

async function simTransfer(run: Run, chain: Chain, token: string, from: string, to: string, toKind: string, amount: bigint): Promise<TransferSim> {
  const base = { from, to, to_kind: toKind, amount_raw: amount.toString() };
  try {
    const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to as Hex, amount] });
    const r = await ethCall(run, chain, token, data, { from, ttl: 0 });
    if (r && r.length >= 66 && BigInt(r.slice(0, 66)) === 0n) return { ...base, result: "returned_false" };
    return { ...base, result: "ok" };
  } catch (e) {
    if (isRevert(e)) return { ...base, result: "reverted", revert_reason_untrusted: cleanSnippet(e instanceof Error ? e.message : "", 120) };
    return { ...base, result: "error" };
  }
}

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

/** One sale order's result in words: "costs 4.9%", "loses 60%", "reverts", "returns nothing", "did not run". */
function orderPhrase(o: RouteOutcome, cost: number | null): string {
  if (o === "reverted") return "reverts";
  if (o === "zero_output") return "returns nothing";
  if (o === "unavailable" || cost === null) return "did not run";
  return cost <= COSTLY_ABOVE ? `costs ${pct(cost)}` : `loses ${pct(cost)}`;
}

/** Short label for one order in the "wallet-held X / moved-first Y" form. */
function orderFigure(o: RouteOutcome, cost: number | null): string {
  if (o === "reverted") return "reverts";
  if (o === "zero_output") return "nothing back";
  if (o === "unavailable" || cost === null) return "not run";
  return pct(cost);
}

/** True when the two v4 sale orders gave visibly different results. */
function routesDiffer(rc: RouteCosts | undefined): boolean {
  if (!rc || rc.pre_transferred_outcome === "unavailable") return false;
  if (rc.wallet_held_outcome !== rc.pre_transferred_outcome) return true;
  return rc.wallet_held !== null && rc.pre_transferred !== null && Math.abs(rc.wallet_held - rc.pre_transferred) >= 0.01;
}

/** The round-trip figures for a fresh wallet, routes labelled when they differ; legs sit next to the wallet-held order. */
function routeFigures(w: WalletSim): string {
  const legs = w.buy_cost !== undefined && w.buy_cost !== null ? ` (buy ${pct(w.buy_cost)}, sell ${pct(w.sell_cost)})` : "";
  const rc = w.route_costs;
  if (rc && rc.transfer_tax !== undefined && rc.wallet_held_outcome === "reverted" && rc.pre_transferred_outcome === "ok") {
    return `transfer tax ${pct(rc.transfer_tax)}; routes that settle an exact amount after the swap revert; moving the tokens first, the round trip ${orderPhrase("ok", rc.pre_transferred)}`;
  }
  if (rc && routesDiffer(rc)) return `wallet-held ${orderFigure(rc.wallet_held_outcome, rc.wallet_held)}${rc.wallet_held_outcome === "ok" ? legs : ""} / moved-first ${orderFigure(rc.pre_transferred_outcome, rc.pre_transferred)}`;
  const cost = `${orderPhrase(w.stage === "zero_output" ? "zero_output" : "ok", w.round_trip_cost ?? null)}${legs}`;
  return rc?.pre_transferred_outcome === "unavailable" ? `${cost} (the moved-first order did not run)` : cost;
}

/** One sentence about the sell test; always names the wallet and never says OK without a cost. */
export function describeSell(s: SellSim): string {
  if (s.method === "none") return `sell not simulated (${s.detail ?? "no pool or holder to test with"})`;
  if (s.method === "fresh_wallet_round_trip") {
    const w = s.wallets[0]!;
    const size = s.trade_size_quote !== null && s.trade_size_quote !== undefined ? `${Number(s.trade_size_quote.toPrecision(2))} ${s.quote_symbol ?? ""}`.trim() : "a small amount";
    const rc = w.route_costs;
    const where = `fresh wallet, round trip of ${size} on ${s.pool_kind}`;
    if (w.verdict === "route_dependent" && rc) {
      return `SELL DEPENDS ON THE ROUTE (${where}): selling straight from the wallet ${orderPhrase(rc.wallet_held_outcome, rc.wallet_held)}, moving the tokens to the pool manager first ${orderPhrase(rc.pre_transferred_outcome, rc.pre_transferred)}`;
    }
    const fig = routeFigures(w);
    switch (w.verdict) {
      case "ok":
        return `sell test (${where}): ${fig}`;
      case "costly":
        return `sell test (${where}): COSTLY, ${fig}`;
      case "cannot_sell":
        return `sell test (${where}): EFFECTIVELY CANNOT SELL, ${fig}`;
      case "reverted":
        return routesDiffer(rc)
          ? `sell test (${where}): SELL REVERTED on one order, ${fig}`
          : `sell test (${where}): SELL REVERTED (bought, then the sale ${w.stage === "sell_transfer" ? "transfer" : "swap"} reverted)`;
      default:
        return `sell test (${where}): did not revert; cost not measured`;
    }
  }
  const n = s.wallets.length;
  const who = s.wallets.map((w) => short(w.wallet)).join(", ");
  const reverted = s.wallets.filter((w) => w.verdict === "reverted").length;
  if (reverted) return `sell test from ${n} real holder${n > 1 ? "s" : ""} (${who}): SELL REVERTED for ${reverted} of ${n}`;
  const costs = s.wallets.map((w) => w.sell_cost).filter((c): c is number => typeof c === "number");
  if (!costs.length) return `sell from real holder${n > 1 ? "s" : ""} ${who} did not revert; cost not measured`;
  const max = Math.max(...costs);
  const head = s.verdict === "cannot_sell" ? "EFFECTIVELY CANNOT SELL, " : s.verdict === "costly" ? "COSTLY, " : "";
  const unmeasured = costs.length < n ? ` (${n - costs.length} without a cost figure)` : "";
  return `sell test from ${n} real holder${n > 1 ? "s" : ""} (${who}) on ${s.pool_kind}: ${head}a sale costs up to ${pct(max)}${unmeasured}`;
}

/** The index's sell_test values this package understands; anything else is "unrecognised" and never quoted. */
export const INDEX_SELL_TESTS = ["ok", "costly", "restricted", "blocked", "inconclusive", "not_tested"] as const;
export type IndexSellTest = (typeof INDEX_SELL_TESTS)[number] | "unrecognised";

export type IndexSellReading = { sell_test: IndexSellTest | null; round_trip_cost: number | null; as_of: number | null };

export function indexReading(f: Record<string, unknown>): IndexSellReading {
  const t = f.sell_test;
  const sell_test = t === null || t === undefined ? null : (INDEX_SELL_TESTS as readonly unknown[]).includes(t) ? (t as IndexSellTest) : "unrecognised";
  const c = f.round_trip_cost;
  // A cost is a fraction 0..1; anything else (percent units, negative, NaN) is not a cost.
  const round_trip_cost = typeof c === "number" && Number.isFinite(c) && c >= 0 && c <= 1 ? c : null;
  const a = f.as_of;
  return { sell_test, round_trip_cost, as_of: typeof a === "number" && Number.isFinite(a) && a > 0 ? a : null };
}

/** The index's sell reading as a verdict on the same scale; the cost decides when present. Null = no usable reading. */
export function indexVerdict(r: IndexSellReading): Verdict | null {
  switch (r.sell_test) {
    case "blocked":
      return "reverted";
    case "restricted":
      return "cannot_sell";
    case "costly":
      return r.round_trip_cost !== null ? worst(["costly", verdictForCost(r.round_trip_cost)]) : "costly";
    case "ok":
      return r.round_trip_cost !== null ? verdictForCost(r.round_trip_cost) : "ok";
    default:
      return null; // inconclusive, not_tested, unrecognised, missing
  }
}

function verdictForCost(c: number): Verdict {
  return c > CANNOT_SELL_ABOVE ? "cannot_sell" : c > COSTLY_ABOVE ? "costly" : "ok";
}

function age(asOf: number | null): string {
  if (asOf === null) return "age unknown";
  const s = Math.max(0, Date.now() / 1000 - asOf);
  return s < 120 ? "read just now" : s < 7200 ? `read ${Math.round(s / 60)} min ago` : s < 172800 ? `read ${Math.round(s / 3600)} h ago` : `read ${Math.round(s / 86400)} d ago`;
}

/** "the index's sell test ($1 round trip, read 3 h ago)": no claim about how the index runs it. */
function indexWho(r: IndexSellReading): string {
  return `the index's sell test ($1 round trip, ${age(r.as_of)})`;
}

function indexPhrase(r: IndexSellReading): string {
  switch (r.sell_test) {
    case "blocked":
      return "fails (the sale reverts)";
    case "restricted":
      return "can fail on ordinary routes";
    case "costly":
      return r.round_trip_cost !== null ? `loses ${pct(r.round_trip_cost)}` : "is marked costly";
    case "ok":
      return r.round_trip_cost !== null ? orderPhrase("ok", r.round_trip_cost) : "passes";
    default:
      return "gave no reading";
  }
}

/** Our simulation's result in a clause, reusing the route wording. */
function simPhrase(s: SellSim): string {
  const w = s.wallets[0];
  if (!w) return "was not run";
  if (s.method === "fresh_wallet_round_trip") {
    const rc = w.route_costs;
    if (s.verdict === "route_dependent" && rc) return `${orderPhrase(rc.wallet_held_outcome, rc.wallet_held)} from the wallet but ${orderPhrase(rc.pre_transferred_outcome, rc.pre_transferred)} when the tokens are moved first`;
    if (rc && routesDiffer(rc)) return `gives wallet-held ${orderFigure(rc.wallet_held_outcome, rc.wallet_held)} / moved-first ${orderFigure(rc.pre_transferred_outcome, rc.pre_transferred)}`;
    if (w.stage === "zero_output") return "returns nothing";
    if (s.verdict === "reverted") return "reverts";
    return orderPhrase("ok", w.round_trip_cost ?? null);
  }
  if (s.verdict === "reverted") return "reverts";
  const costs = s.wallets.map((x) => x.sell_cost).filter((c): c is number => typeof c === "number");
  if (!costs.length) return "did not revert (cost not measured)";
  return orderPhrase("ok", Math.max(...costs));
}

/** Sale outcome classes: fails or loses most of the value / costly / cheap / went through at an unknown cost. */
function klass(v: Verdict): "fail" | "costly" | "cheap" | "passed" | null {
  if (v === "reverted" || v === "cannot_sell" || v === "route_dependent") return "fail";
  if (v === "costly") return "costly";
  if (v === "ok") return "cheap";
  if (v === "not_measured") return "passed";
  return null;
}

/**
 * Reconcile our simulation with the index's sell test into one statement.
 * - agree: same verdict class (simulation figures first, the index's figure beside them);
 * - disagree: a large gap (one side fails or loses more than half, the other is cheap or went through), headline
 *   "SELL TESTS DISAGREE", both figures, the worse reading sets the verdict;
 * - differ: different classes without a large gap: both figures, worse first, no trap label;
 * - index_only / simulation_only / none: only one side has a reading.
 */
export function reconcileSell(sim: SellSim, f: Record<string, unknown>): { sim: SellSim; sentence: string } {
  const reading = indexReading(f);
  const iv = indexVerdict(reading);
  const sk = klass(sim.verdict);
  const ik = iv === null ? null : klass(iv);
  const out: SellSim = { ...sim, index_reading: reading };
  const own = describeSell(sim);
  const route = sim.method === "fresh_wallet_round_trip" ? "direct pool round trip" : "direct pool sale from real holders";
  if (ik === null) {
    out.agreement = sk === null ? "none" : "simulation_only";
    return { sim: out, sentence: own };
  }
  // A sale that went through at an unknown cost only compares with a failing index reading.
  if (sk === null || (sk === "passed" && ik !== "fail")) {
    out.agreement = "index_only";
    out.verdict = worst([sim.verdict, iv!]);
    const head = ik === "fail" ? (iv === "reverted" ? "SELL BLOCKED" : "EFFECTIVELY CANNOT SELL") + ": " : ik === "costly" ? "COSTLY: " : "";
    return { sim: out, sentence: `${head}${indexWho(reading)} ${indexPhrase(reading)}; our own test: ${own}` };
  }
  out.verdict = worst([sim.verdict, iv!]);
  if (sk === ik) {
    out.agreement = "agree";
    return { sim: out, sentence: `${own} (${indexWho(reading)} agrees: it ${indexPhrase(reading)})` };
  }
  const large = (sk === "fail" && (ik === "cheap")) || (ik === "fail" && (sk === "cheap" || sk === "passed"));
  const simWorse = RANK_ORDER.indexOf(sim.verdict) >= RANK_ORDER.indexOf(iv!);
  const ours = `our ${route} ${simPhrase(sim)}`;
  const theirs = `${indexWho(reading)} ${indexPhrase(reading)}`;
  if (large) {
    out.agreement = "disagree";
    return { sim: out, sentence: `SELL TESTS DISAGREE: ${simWorse ? `${ours}, ${theirs}` : `${theirs}, ${ours}`}: the readings differ (route, size or time); treat the worse one as possible until shown otherwise` };
  }
  out.agreement = "differ";
  return { sim: out, sentence: `${simWorse ? `${ours}; ${theirs}` : `${theirs}; ${ours}`} (the readings differ: route, size or time)` };
}

const RANK_ORDER: Verdict[] = ["not_simulated", "ok", "not_measured", "costly", "cannot_sell", "route_dependent", "reverted"];

export const safetyCheck = defineTool({
  name: "safety_check",
  title: "Safety check",
  description:
    "Can a buyer sell, and what can the owner do? Simulates, with eth_call and a state-override helper, a small buy-then-sell round trip from a fresh random wallet " +
    "on the main Uniswap v2/v3/v4 pool (hooks included) and reports the round-trip cost; when that cannot run, it simulates sales from up to three real holders. " +
    `A round trip losing more than ${COSTLY_ABOVE * 100}% is COSTLY, more than ${CANNOT_SELL_ABOVE * 100}% EFFECTIVELY CANNOT SELL. ` +
    "Also reads proxy slots (EIP-1967/1167), owner, owner-power functions found in bytecode (mint, blacklist, pause, fee setters), Sourcify verification and " +
    "GoPlus flags where GoPlus covers the chain. Reports uncertainty; never says 'safe'. " +
    "Blind spots: traps that target specific wallets, sizes or later times; bonding-curve venues; off-chain front-end tricks.",
  inputSchema: { type: "object", properties: { chain: CHAIN_PROP, token: TOKEN_PROP }, required: ["token"], additionalProperties: false },
  enrich: (a) => ({ chain: chainArg(a), token: addr(a, "token")! }),
  reconcile: (body, f) => {
    // Early returns (RPC down, no code) have no simulation: keep the default index line, sell reading included.
    if (!body.parts || !body.data.sell_simulation) return undefined;
    // One sell statement: the simulation and the index's test, reconciled; the index sell line is not repeated.
    const rec = reconcileSell(body.data.sell_simulation as SellSim, f);
    body.data.sell_simulation = rec.sim;
    body.parts.head = `${short(String(body.data.token))} on ${String(body.data.chain_name ?? body.data.chain)}: ${rec.sentence}`;
    // "" = no further index sentence (hook / template facts only when there are some).
    return describe("safety_check", f, new Set(["sell"]));
  },
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token")!;
    const codeT = await tri(rpc<string>(run, chain, "eth_getCode", [token, "latest"], { ttl: 300 }));
    if (codeT.state === "error") {
      run.miss("rpc", new Error(codeT.error));
      return { ok: false, summary: `Could not read ${short(token)} on ${chain.name}: the RPC failed. Nothing was checked.`, data: { chain: chain.key, chain_id: chain.id, token } };
    }
    const code = codeT.state === "value" ? codeT.value : "0x";
    if (code === "0x") return { ok: false, summary: `${token} has no contract code on ${chain.name}.`, data: { chain: chain.key, token } };

    const slot = (s: string) => tri(rpc<string>(run, chain, "eth_getStorageAt", [token, s, "latest"], { ttl: 300 }));
    const [implW, adminW, beaconW, ownerT, gp, verified, pairs, explorerHolders, decT] = await Promise.all([
      slot(EIP1967_IMPL),
      slot(EIP1967_ADMIN),
      slot(EIP1967_BEACON),
      ownerOf(run, chain, token),
      chain.goplus ? soft(run, "goplus", goplusToken(run, chain, token)) : Promise.resolve(undefined),
      soft(run, "sourcify", sourcify(run, chain, token, false)),
      soft(run, "dexscreener", tokenPairs(run, chain, token)),
      tokenHolders(run, chain, token).catch(() => null),
      tri(ethCall(run, chain, token, encodeFunctionData({ abi: ERC20, functionName: "decimals" }), { ttl: 3600 })),
    ]);
    const slotsFailed = [implW, adminW, beaconW].some((t) => t.state === "error");
    if (slotsFailed) run.miss("rpc", new Error("proxy storage slots unreadable"));
    if (ownerT.state === "error") run.miss("rpc", new Error("owner() unreadable"));
    const sv = (t: Tri<string>) => (t.state === "value" ? t.value : null);
    const impl = slotAddress(sv(implW)) ?? minimalProxyTarget(code);
    const beacon = slotAddress(sv(beaconW));
    const proxyAdmin = slotAddress(sv(adminW));
    let scanCode = code;
    if (impl) {
      const ic = await rpc<string>(run, chain, "eth_getCode", [impl, "latest"], { ttl: 300 }).catch(() => null);
      if (ic && ic !== "0x") scanCode = code + ic.slice(2);
      else run.miss("rpc", new Error("implementation code unreadable: owner powers scanned on the proxy only"));
    }
    const powers = scanRisk(push4Selectors(scanCode));
    const owner = ownerT.state === "value" ? ownerT.value : null;
    const ownerRenounced = owner ? DEAD_ADDRESSES.has(owner) : null;
    const decRaw = decT.state === "value" ? decT.value : null;
    const decimals = decRaw && decRaw !== "0x" ? Number(BigInt(decRaw.slice(0, 66))) : null;

    // --- sell test
    const { main } = pickMainPool(pairs ?? [], token);
    const creator = gp?.creator_address?.toLowerCase();
    let sell: SellSim = { method: "none", verdict: "not_simulated", pool_kind: null, wallets: [] };
    const sims: TransferSim[] = [];
    let candidates: string[] = [];
    if (main) {
      const info = await poolInfo(run, chain, token, main).catch((e) => ({ error: e instanceof Error ? e.message.slice(0, 80) : "error" }));
      if ("error" in info) {
        sell = { ...sell, detail: info.error };
      } else {
        sell = { method: "none", verdict: "not_simulated", pool_kind: info.label, quote_symbol: info.quoteSymbol, wallets: [] };
        if (info.key) {
          sell.hooks = info.key.hooks.toLowerCase();
          sell.fee_raw = info.key.fee;
        }
        let freshWhy = info.freshWhy;
        if (info.freshOk) {
          const rt = await freshRoundTrip(run, chain, token, info, decimals).catch((e) => ({ unavailable: e instanceof Error ? e.message.slice(0, 80) : "error" }));
          if ("sim" in rt) sell = { ...sell, method: "fresh_wallet_round_trip", verdict: rt.sim.verdict, trade_size_quote: rt.size, wallets: [rt.sim] };
          else freshWhy = rt.unavailable;
        }
        if (sell.method === "none") {
          sell.fresh_wallet_unavailable = freshWhy;
          // Fallback: up to three real holders, smallest first, never the largest holder, owner or creator.
          candidates = await holderCandidates(run, chain, token, gp, explorerHolders?.holders ?? [], [owner, creator, info.pool, chain.v4?.poolManager]);
          const quoteDecimals = info.quote === "0x0000000000000000000000000000000000000000" || info.wrap ? 18 : null;
          const wallets: WalletSim[] = [];
          for (const h of candidates) {
            if (wallets.length >= 3 || run.remaining() < 2500) break;
            try {
              const w = await holderSell(run, chain, token, info, h, decimals, quoteDecimals);
              if (w) wallets.push(w);
            } catch (e) {
              sell.detail = e instanceof Error ? e.message.slice(0, 100) : "error";
              break;
            }
          }
          if (wallets.length) {
            sell = { ...sell, method: "holder_sell", verdict: worst(wallets.map((w) => w.verdict)), wallets };
            const kinds = new Set(wallets.map((w) => w.verdict));
            if (kinds.size > 1) run.note("The simulated holders got different results: the token may treat wallets differently.");
          } else if (!sell.detail) sell.detail = "no holder with a balance could be simulated";
        }
      }
    }
    if (sell.method === "none" && candidates.length === 0) {
      candidates = await holderCandidates(run, chain, token, gp, explorerHolders?.holders ?? [], [owner, creator]).catch(() => []);
    }
    if (sell.method === "none") {
      // Last resort: does a plain transfer from a holder go through?
      for (const h of candidates.slice(0, 1)) {
        const balRaw = await tri(ethCall(run, chain, token, ("0x70a08231" + h.slice(2).padStart(64, "0")) as Hex, { ttl: 30 }));
        const bal = balRaw.state === "value" && balRaw.value !== "0x" ? BigInt(balRaw.value.slice(0, 66)) : 0n;
        if (bal === 0n) continue;
        const amt = bal / 10n > 0n ? bal / 10n : bal;
        const poolAddr = main && /^0x[0-9a-f]{40}$/i.test(main.pairAddress) ? main.pairAddress.toLowerCase() : null;
        if (poolAddr) sims.push(await simTransfer(run, chain, token, h, poolAddr, "main pool", amt));
        sims.push(await simTransfer(run, chain, token, h, FRESH, "fresh address", amt));
      }
    }

    // --- GoPlus
    const gpFlags = gp ? goplusFlags(gp) : null;
    const hookPool = main?.labels?.includes("v4") ?? false;

    // --- verdict lines
    const lines: string[] = [];
    if (sell.method === "none" && sims.length) {
      const bad = sims.filter((s) => s.result !== "ok" && s.result !== "error");
      const err = sims.filter((s) => s.result === "error");
      lines.push(
        bad.length
          ? `a transfer from holder ${short(sims[0]!.from)} FAILED (${bad.map((b) => `${b.to_kind}: ${b.result}`).join(", ")})`
          : err.length
            ? "transfer test could not run (RPC error)"
            : `a plain transfer from holder ${short(sims[0]!.from)} ${sims.some((x) => x.to_kind === "main pool") ? "into the pool" : "to a fresh address"} goes through (not a sale)`,
      );
    }
    if (gpFlags) {
      const hp = gpFlags.honeypot;
      const tax = (v: number | null) => (v === null ? "n/a" : `${v}%`);
      lines.push(`GoPlus: honeypot ${hp === null ? "n/a" : hp ? "YES" : "no"}, buy tax ${tax(gpFlags.buy_tax_pct)}, sell tax ${tax(gpFlags.sell_tax_pct)}`);
    } else lines.push(chain.goplus ? "GoPlus unavailable" : "GoPlus does not cover this chain");
    if (impl || beacon) lines.push(`PROXY (implementation ${short(impl ?? beacon)}): logic can change`);
    else lines.push(slotsFailed ? "proxy status unknown (RPC error)" : "not a proxy");
    lines.push(
      ownerT.state === "error" ? "owner unknown (RPC error)" : owner ? (ownerRenounced ? "owner renounced" : `owner ${short(owner)}`) : "no owner() function",
    );
    const ownerPowers = powers.filter((p) => !["ownable"].includes(p.key));
    if (ownerPowers.length) lines.push(`functions present: ${ownerPowers.map((p) => p.key).join(", ")}`);
    lines.push(verified ? "source verified on Sourcify" : verified === null ? "not verified on Sourcify" : "Sourcify unavailable");
    if (hookPool) {
      const ran = sell.method !== "none" && sell.pool_kind?.includes("v4");
      lines.push(
        ran
          ? `main pool is Uniswap v4${sell.hooks && !/^0x0{40}$/.test(sell.hooks) ? ` with hook ${short(sell.hooks)}` : ""}: the simulation ran through it (GoPlus does not see hook traps)`
          : "main pool is Uniswap v4: hook-level sell traps were not simulated and GoPlus does not see them",
      );
    }
    if (sell.method !== "none") {
      run.note(
        sell.method === "fresh_wallet_round_trip"
          ? "The round trip was simulated from one fresh random wallet at one small size, now, calling the pool directly. Traps aimed at specific wallets, larger sizes, later times or particular routers are not covered."
          : `The fresh-wallet round trip was not possible (${sell.fresh_wallet_unavailable ?? "unknown reason"}); sales were simulated from real holders, which a token can exempt.`,
      );
    }
    run.note("Selector scan shows capabilities present in bytecode, not that they were used; names can be obfuscated and the scan misses custom names.");

    return {
      summary: "",
      parts: { head: `${short(token)} on ${chain.name}: ${describeSell(sell)}`, rest: lines.join("; "), tail: "Not a safety guarantee" },
      data: {
        chain: chain.key,
        chain_id: chain.id,
        chain_name: chain.name,
        token,
        sell_simulation: sell,
        transfer_simulations: sims,
        proxy: { is_proxy: impl || beacon ? true : slotsFailed ? null : false, implementation: impl, beacon, admin: proxyAdmin },
        owner,
        owner_status: ownerT.state,
        owner_renounced: ownerRenounced,
        owner_powers_in_bytecode: powers,
        verified_sourcify: verified ? verified.match : verified === null ? false : null,
        goplus: gpFlags,
        main_pool: main ? { pair: main.pairAddress.toLowerCase(), dex: main.dexId, version: main.labels?.[0] ?? null } : null,
        bytecode_bytes: (code.length - 2) / 2,
        thresholds: { costly_above: COSTLY_ABOVE, cannot_sell_above: CANNOT_SELL_ABOVE, unit: "fraction of value lost" },
      },
    };
  },
});

/**
 * Wallets to simulate sales from: recent small recipients first (from one bounded log scan), then listed holders from
 * the smallest up. Never the largest holder (often the team or an exempt wallet), the owner, creator or a pool.
 */
async function holderCandidates(
  run: Run,
  chain: Chain,
  token: string,
  gp: GoPlusToken | null | undefined,
  ex: { address: string; is_contract: boolean | null }[],
  exclude: (string | null | undefined)[],
): Promise<string[]> {
  const skip = new Set(exclude.filter(Boolean).map((x) => x!.toLowerCase()));
  const listed: string[] = [];
  for (const h of gp?.holders ?? []) {
    const a = h.address.toLowerCase();
    if (h.is_contract === 1 || h.is_locked === 1 || skip.has(a) || DEAD_ADDRESSES.has(a)) continue;
    listed.push(a);
  }
  for (const h of ex) {
    if (h.is_contract || skip.has(h.address) || DEAD_ADDRESSES.has(h.address) || listed.includes(h.address)) continue;
    listed.push(h.address);
  }
  const top = listed[0];
  const recent = await recentHolders(run, chain, token, [...skip, ...(top ? [top] : [])]).catch(() => [] as string[]);
  const out: string[] = [];
  for (const a of [...recent, ...listed.slice(1).reverse()]) if (!out.includes(a) && a !== top) out.push(a);
  return out.slice(0, 5);
}

/** Recent token recipients that are wallets (EOA or EIP-7702), from one bounded getLogs call. */
async function recentHolders(run: Run, chain: Chain, token: string, exclude: string[]): Promise<string[]> {
  const head = await blockNumber(run, chain);
  const span = Math.min(chain.logsSpan, Math.ceil(3600 / chain.blockTime));
  const scan = await scanTransfers(run, chain, token, Math.max(0, head - span), head, { maxCalls: 2, maxLogs: 5000 });
  const skip = new Set(exclude);
  const seen: string[] = [];
  for (const t of [...scan.transfers].reverse()) {
    if (skip.has(t.to) || DEAD_ADDRESSES.has(t.to) || seen.includes(t.to)) continue;
    seen.push(t.to);
    if (seen.length >= 8) break;
  }
  const codes = await rpcBatch(run, chain, seen.map((a) => ({ method: "eth_getCode", params: [a, "latest"] })));
  return seen.filter((_, i) => typeof codes[i] === "string" && (codes[i] === "0x" || String(codes[i]).startsWith("0xef0100"))).slice(0, 4);
}

function pctGp(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 10 : null;
}

function goplusFlags(g: GoPlusToken) {
  return {
    honeypot: flag(g.is_honeypot),
    cannot_buy: flag(g.cannot_buy),
    cannot_sell_all: flag(g.cannot_sell_all),
    buy_tax_pct: pctGp(g.buy_tax),
    sell_tax_pct: pctGp(g.sell_tax),
    transfer_tax_pct: pctGp(g.transfer_tax),
    mintable: flag(g.is_mintable),
    proxy: flag(g.is_proxy),
    open_source: flag(g.is_open_source),
    hidden_owner: flag(g.hidden_owner),
    can_take_back_ownership: flag(g.can_take_back_ownership),
    owner_change_balance: flag(g.owner_change_balance),
    blacklist: flag(g.is_blacklisted),
    whitelist: flag(g.is_whitelisted),
    transfer_pausable: flag(g.transfer_pausable),
    slippage_modifiable: flag(g.slippage_modifiable),
    trading_cooldown: flag(g.trading_cooldown),
    external_call: flag(g.external_call),
    selfdestruct: flag(g.selfdestruct),
    honeypot_with_same_creator: flag(g.honeypot_with_same_creator),
    holder_count: g.holder_count ? Number(g.holder_count) : null,
  };
}
