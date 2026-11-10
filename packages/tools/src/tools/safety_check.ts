import { encodeFunctionData, parseAbi, type Hex } from "viem";
import type { Chain } from "../chains.js";
import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, short, TOKEN_PROP } from "../util/args.js";
import { soft, type Run } from "../util/http.js";
import { balanceOf, ethCall, ownerOf, rpc, RpcError } from "../util/rpc.js";
import { DEAD_ADDRESSES, EIP1967_ADMIN, EIP1967_BEACON, EIP1967_IMPL, minimalProxyTarget, push4Selectors, scanRisk, slotAddress } from "../util/bytecode.js";
import { goplusToken, flag, type GoPlusToken } from "../sources/goplus.js";
import { sourcify } from "../sources/sourcify.js";
import { pickMainPool, tokenPairs } from "../sources/dexscreener.js";
import { tokenHolders } from "../sources/explorer.js";
import { simulateSell, type SellSim } from "../util/sellsim.js";

const ERC20 = parseAbi(["function transfer(address,uint256) returns (bool)"]);
const FRESH = "0x000000000000000000000000000000000000f4ee";

async function storage(run: Run, chain: Chain, a: string, slot: string): Promise<string | null> {
  return rpc<string>(run, chain, "eth_getStorageAt", [a, slot, "latest"], { ttl: 300 }).catch(() => null);
}

type TransferSim = { from: string; to: string; to_kind: string; amount_raw: string; result: "ok" | "reverted" | "returned_false" | "error"; detail?: string };

async function simTransfer(run: Run, chain: Chain, token: string, from: string, to: string, toKind: string, amount: bigint): Promise<TransferSim> {
  const base = { from, to, to_kind: toKind, amount_raw: amount.toString() };
  try {
    const data = encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to as Hex, amount] });
    const r = await ethCall(run, chain, token, data, { from, ttl: 0 });
    if (r && r.length >= 66 && BigInt(r.slice(0, 66)) === 0n) return { ...base, result: "returned_false" };
    return { ...base, result: "ok" };
  } catch (e) {
    if (e instanceof RpcError) return { ...base, result: "reverted", detail: e.message.slice(0, 160) };
    return { ...base, result: "error", detail: e instanceof Error ? e.message.slice(0, 120) : "error" };
  }
}

export const safetyCheck = defineTool({
  name: "safety_check",
  title: "Safety check",
  description:
    "Can a buyer sell, and what can the owner do? Simulates a sell where it can (eth_call of a real Uniswap v2/v3 swap using a state-override helper, " +
    "else a token transfer from a real holder into the pool), reads proxy slots (EIP-1967/1167), owner, owner-power functions found in bytecode " +
    "(mint, blacklist, pause, fee setters), Sourcify verification and GoPlus flags where GoPlus covers the chain. Reports uncertainty; never says 'safe'. " +
    "Blind spots: Uniswap v4 hook traps, time-delayed traps, off-chain front-end tricks.",
  inputSchema: { type: "object", properties: { chain: CHAIN_PROP, token: TOKEN_PROP }, required: ["token"], additionalProperties: false },
  enrich: (a) => ({ chain: chainArg(a), token: addr(a, "token")! }),
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token")!;
    const code = await rpc<string>(run, chain, "eth_getCode", [token, "latest"], { ttl: 300 });
    if (!code || code === "0x") return { ok: false, summary: `${token} has no contract code on ${chain.name}.`, data: { chain: chain.key, token } };

    const [implW, adminW, beaconW, owner, gp, verified, pairs, explorerHolders] = await Promise.all([
      storage(run, chain, token, EIP1967_IMPL),
      storage(run, chain, token, EIP1967_ADMIN),
      storage(run, chain, token, EIP1967_BEACON),
      ownerOf(run, chain, token),
      chain.goplus ? soft(run, "goplus", goplusToken(run, chain, token)) : Promise.resolve(undefined),
      soft(run, "sourcify", sourcify(run, chain, token, false)),
      soft(run, "dexscreener", tokenPairs(run, chain, token)),
      tokenHolders(run, chain, token).catch(() => null),
    ]);
    const impl = slotAddress(implW) ?? minimalProxyTarget(code);
    const beacon = slotAddress(beaconW);
    const proxyAdmin = slotAddress(adminW);
    let scanCode = code;
    if (impl) {
      const ic = await rpc<string>(run, chain, "eth_getCode", [impl, "latest"], { ttl: 300 }).catch(() => null);
      if (ic && ic !== "0x") scanCode = code + ic.slice(2);
    }
    const powers = scanRisk(push4Selectors(scanCode));
    const ownerRenounced = owner ? DEAD_ADDRESSES.has(owner) : null;

    // --- sell simulation
    const { main } = pickMainPool(pairs ?? [], token);
    let sell: SellSim | null = null;
    const sims: TransferSim[] = [];
    const creator = gp?.creator_address?.toLowerCase();
    const candidates = holderCandidates(gp, explorerHolders?.holders ?? [], [owner, creator, main?.pairAddress?.toLowerCase()]);
    if (main && candidates[0]) {
      sell = await simulateSell(run, chain, token, main, candidates[0]).catch((e) => ({
        method: "swap_sim",
        result: "not_simulated" as const,
        detail: e instanceof Error ? e.message.slice(0, 160) : "error",
      }));
    }
    if (!sell || sell.result === "not_simulated") {
      for (const h of candidates.slice(0, 2)) {
        const bal = await balanceOf(run, chain, token, h);
        if (!bal || bal === 0n) continue;
        const amt = bal / 10n > 0n ? bal / 10n : bal;
        const poolAddr = main && /^0x[0-9a-f]{40}$/i.test(main.pairAddress) ? main.pairAddress.toLowerCase() : null;
        if (poolAddr) sims.push(await simTransfer(run, chain, token, h, poolAddr, "main pool", amt));
        sims.push(await simTransfer(run, chain, token, h, FRESH, "fresh address", amt));
        break;
      }
    }

    // --- GoPlus
    const gpFlags = gp ? goplusFlags(gp) : null;
    const hookPool = main?.labels?.includes("v4") ?? false;

    // --- verdict lines
    const lines: string[] = [];
    if (sell && sell.result !== "not_simulated") {
      lines.push(
        sell.result === "ok"
          ? `sell simulation OK on ${sell.pool_kind ?? "main pool"}${sell.tax_pct !== undefined && sell.tax_pct !== null ? ` (token tax on the way into the pool ${sell.tax_pct.toFixed(1)}%, pool fee excluded)` : ""}`
          : `SELL SIMULATION FAILED (${sell.result}${sell.detail ? ": " + sell.detail.slice(0, 80) : ""})`,
      );
    } else if (sims.length) {
      const bad = sims.filter((s) => s.result !== "ok");
      lines.push(bad.length ? `transfer simulation FAILED (${bad.map((b) => `${b.to_kind}: ${b.result}`).join(", ")})` : `holder→pool transfer simulates OK (not a full swap)`);
    } else lines.push("sell not simulated (no usable holder or pool)");
    if (gpFlags) {
      const hp = gpFlags.honeypot;
      lines.push(`GoPlus: honeypot ${hp === null ? "n/a" : hp ? "YES" : "no"}, buy tax ${gpFlags.buy_tax_pct ?? "n/a"}%, sell tax ${gpFlags.sell_tax_pct ?? "n/a"}%`);
    } else lines.push(chain.goplus ? "GoPlus unavailable" : "GoPlus does not cover this chain");
    lines.push(impl || beacon ? `PROXY (implementation ${short(impl ?? beacon)}): logic can change` : "not a proxy");
    lines.push(owner ? (ownerRenounced ? "owner renounced" : `owner ${short(owner)}`) : "no owner() function");
    const ownerPowers = powers.filter((p) => !["ownable"].includes(p.key));
    if (ownerPowers.length) lines.push(`functions present: ${ownerPowers.map((p) => p.key).join(", ")}`);
    lines.push(verified ? "source verified on Sourcify" : verified === null ? "not verified on Sourcify" : "Sourcify unavailable");
    if (hookPool) lines.push("main pool is Uniswap v4: hook-level sell traps are not covered by GoPlus");

    const notes = [
      "Selector scan shows capabilities present in bytecode, not that they were used; names can be obfuscated and the scan misses custom names.",
    ];
    for (const n of notes) run.note(n);

    return {
      summary: `${short(token)} on ${chain.name}: ` + lines.join("; ") + ". Not a safety guarantee.",
      data: {
        chain: chain.key,
        chain_id: chain.id,
        token,
        sell_simulation: sell,
        transfer_simulations: sims,
        proxy: { is_proxy: Boolean(impl || beacon), implementation: impl, beacon, admin: proxyAdmin },
        owner,
        owner_renounced: ownerRenounced,
        owner_powers_in_bytecode: powers,
        verified_sourcify: verified ? verified.match : verified === null ? false : null,
        goplus: gpFlags,
        main_pool: main ? { pair: main.pairAddress.toLowerCase(), dex: main.dexId, version: main.labels?.[0] ?? null } : null,
        bytecode_bytes: (code.length - 2) / 2,
      },
    };
  },
});

function holderCandidates(gp: GoPlusToken | null | undefined, ex: { address: string; is_contract: boolean | null }[], exclude: (string | null | undefined)[]): string[] {
  const skip = new Set(exclude.filter(Boolean).map((x) => x!.toLowerCase()));
  const out: string[] = [];
  for (const h of gp?.holders ?? []) {
    const a = h.address.toLowerCase();
    if (h.is_contract === 1 || h.is_locked === 1 || skip.has(a) || DEAD_ADDRESSES.has(a)) continue;
    out.push(a);
  }
  for (const h of ex) {
    if (h.is_contract || skip.has(h.address) || DEAD_ADDRESSES.has(h.address) || out.includes(h.address)) continue;
    out.push(h.address);
  }
  return out.slice(0, 4);
}

function pct(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 1000) / 10 : null;
}

function goplusFlags(g: GoPlusToken) {
  return {
    honeypot: flag(g.is_honeypot),
    cannot_buy: flag(g.cannot_buy),
    cannot_sell_all: flag(g.cannot_sell_all),
    buy_tax_pct: pct(g.buy_tax),
    sell_tax_pct: pct(g.sell_tax),
    transfer_tax_pct: pct(g.transfer_tax),
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
