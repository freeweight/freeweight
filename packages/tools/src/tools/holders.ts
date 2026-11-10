import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, fmtPct, int, round, short, TOKEN_PROP } from "../util/args.js";
import { soft } from "../util/http.js";
import { balanceOf, balanceOfData, blockNumber, erc20Meta, rpcBatch, units } from "../util/rpc.js";
import { DEAD_ADDRESSES } from "../util/bytecode.js";
import { balancesFrom, blockAt, scanTransfers } from "../util/logs.js";
import { tokenHolders } from "../sources/explorer.js";
import { goplusToken } from "../sources/goplus.js";
import { tokenPairs } from "../sources/dexscreener.js";
import { creatorOf } from "../sources/common.js";

const ZERO = "0x0000000000000000000000000000000000000000";

type Row = { address: string; raw: bigint; is_contract: boolean | null; label: string | null };

export const holdersTool = defineTool({
  name: "holders",
  title: "Holders and concentration",
  description:
    "Top holders of a token with % of supply, tagged as pool / burn / creator / contract; concentration of the top 10 excluding pools and burns; " +
    "share held in DEX pools, burned (0xdead + 0x0) and by the creator. Sources: explorer holder list where reachable, GoPlus top holders, " +
    "else a reconstruction from Transfer logs (young tokens; says when coverage is partial).",
  inputSchema: {
    type: "object",
    properties: { chain: CHAIN_PROP, token: TOKEN_PROP, limit: { type: "integer", minimum: 5, maximum: 50, description: "Rows to return (default 15)." } },
    required: ["token"],
    additionalProperties: false,
  },
  enrich: (a) => ({ chain: chainArg(a), token: addr(a, "token")! }),
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token")!;
    const limit = int(args, "limit", 15, 5, 50);

    const [meta, explorer, gp, pairs, creator] = await Promise.all([
      erc20Meta(run, chain, token),
      tokenHolders(run, chain, token).catch(() => null),
      chain.goplus ? soft(run, "goplus", goplusToken(run, chain, token)) : Promise.resolve(undefined),
      soft(run, "dexscreener", tokenPairs(run, chain, token)),
      creatorOf(run, chain, token),
    ]);
    if (!meta.isContract) return { ok: false, summary: `${token} has no contract code on ${chain.name}.`, data: { chain: chain.key, token } };
    const dec = meta.decimals ?? 18;
    const supply = meta.totalSupply ?? 0n;

    // Pool addresses: v2/v3 pair contracts from DexScreener, v4 PoolManager from GoPlus.
    const pools = new Set<string>();
    for (const p of pairs ?? []) if (/^0x[0-9a-fA-F]{40}$/.test(p.pairAddress)) pools.add(p.pairAddress.toLowerCase());
    for (const d of gp?.dex ?? []) {
      const pm = (d as { pool_manager?: string }).pool_manager;
      if (pm) pools.add(pm.toLowerCase());
      if (d.pair && /^0x[0-9a-fA-F]{40}$/.test(d.pair)) pools.add(d.pair.toLowerCase());
    }

    let rows: Row[] = [];
    let method = "";
    let coverage: "full" | "top_only" | "partial" = "top_only";
    let holderCount: number | null = null;
    if (explorer && explorer.holders.length) {
      rows = explorer.holders;
      method = explorer.source;
      holderCount = explorer.holder_count;
    }
    if (!rows.length && gp?.holders?.length) {
      rows = gp.holders.map((h) => ({ address: h.address.toLowerCase(), raw: toRaw(h.balance ?? "0", dec), is_contract: h.is_contract === undefined ? null : h.is_contract === 1, label: h.tag || null }));
      method = "goplus (top 10)";
      holderCount = gp.holder_count ? Number(gp.holder_count) : null;
    }
    // Transfer-log reconstruction: when nothing else worked, or to go past GoPlus' top 10 on young tokens.
    let scanInfo: Record<string, unknown> | null = null;
    const tooBusy = holderCount !== null && holderCount > 5000;
    if (tooBusy) run.note(`log reconstruction skipped: ${holderCount} holders is too many transfers for a keyless log scan`);
    if (rows.length < limit && run.remaining() > 6000 && !tooBusy) {
      const firstPool = (pairs ?? []).map((p) => p.pairCreatedAt ?? 0).filter((x) => x > 0).sort((a, b) => a - b)[0];
      const startMs = creator.created_at
        ? Date.parse(creator.created_at) - 3_600_000
        : firstPool
          ? firstPool - 2 * 86_400_000
          : Date.now() - (chain.id === 4663 ? 3 : 1) * 86_400_000;
      if (startMs) {
        const ageDays = (Date.now() - startMs) / 86_400_000;
        const head = await blockNumber(run, chain);
        const from = await blockAt(run, chain, startMs).catch(() => null);
        const blocks = from !== null ? head - from : Infinity;
        const maxCalls = chain.id === 4663 ? 14 : 10;
        if (from !== null && blocks / chain.logsSpan <= maxCalls) {
          const scan = await scanTransfers(run, chain, token, from, head, { maxCalls, maxLogs: 40_000 });
          const minted = scan.transfers.filter((t) => t.from === ZERO).reduce((s, t) => s + t.value, 0n);
          const mintSeen = supply > 0n && minted >= supply - supply / 1000n;
          scanInfo = { from_block: from, to_block: scan.scanned_to, transfers: scan.transfers.length, calls: scan.calls, complete: scan.complete, mint_in_window: mintSeen, age_days: round(ageDays, 3) };
          if (scan.complete && (mintSeen || rows.length === 0)) {
            const bal = balancesFrom(scan.transfers);
            const recon = [...bal.entries()].filter(([a, v]) => v > 0n && a !== ZERO).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
            rows = recon.slice(0, 60).map(([a, v]) => ({ address: a, raw: v, is_contract: null, label: null }));
            holderCount = recon.length;
            method = "transfer logs";
            coverage = mintSeen ? "full" : "partial";
          }
        } else {
          run.note(`log reconstruction skipped: token too old for keyless log scan (${Math.round(ageDays)} d)`);
        }
      }
    }
    if (!rows.length) {
      run.partial = true;
      run.note("no holder list available from any source");
    }

    // Verify top balances on-chain and tag contracts (one batched RPC request).
    const top = rows.slice(0, limit);
    const special = [ZERO, "0x000000000000000000000000000000000000dead", ...(creator.creator ? [creator.creator] : [])];
    const batch = await rpcBatch(run, chain, [
      ...top.map((r) => ({ method: "eth_call", params: [{ to: token, data: balanceOfData(r.address) }, "latest"] })),
      ...top.map((r) => ({ method: "eth_getCode", params: [r.address, "latest"] })),
      ...special.map((a) => ({ method: "eth_call", params: [{ to: token, data: balanceOfData(a) }, "latest"] })),
    ]).catch(() => [] as unknown[]);
    top.forEach((r, i) => {
      const b = batch[i];
      if (typeof b === "string" && b.length >= 66) r.raw = BigInt(b.slice(0, 66));
      const c = batch[top.length + i];
      if (typeof c === "string") r.is_contract = c !== "0x";
    });
    top.sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
    const sb = (i: number) => {
      const v = batch[top.length * 2 + i];
      return typeof v === "string" && v.length >= 66 ? BigInt(v.slice(0, 66)) : null;
    };
    const burnRaw = (sb(0) ?? 0n) + (sb(1) ?? 0n);
    const creatorRaw = creator.creator ? (sb(2) ?? (await balanceOf(run, chain, token, creator.creator))) : null;

    const pct = (raw: bigint) => (supply > 0n ? Number((raw * 1_000_000n) / supply) / 10_000 : null);
    const tag = (r: Row): string[] => {
      const t: string[] = [];
      if (pools.has(r.address)) t.push("pool");
      if (DEAD_ADDRESSES.has(r.address)) t.push("burn");
      if (creator.creator && r.address === creator.creator) t.push("creator");
      if (r.is_contract) t.push("contract");
      if (r.label) t.push(r.label.slice(0, 40));
      return t;
    };
    const table = top.map((r) => ({ address: r.address, balance: units(r.raw, dec), pct_supply: round(pct(r.raw), 4), tags: tag(r) }));
    const inPools = top.filter((r) => pools.has(r.address)).reduce((s, r) => s + r.raw, 0n);
    const ex = top.filter((r) => !pools.has(r.address) && !DEAD_ADDRESSES.has(r.address));
    const top10 = ex.slice(0, 10).reduce((s, r) => s + r.raw, 0n);
    const topContracts = ex.filter((r) => r.is_contract).slice(0, 5).map((r) => r.address);

    const summary = [
      `${meta.symbol ? "$" + meta.symbol : short(token)} on ${chain.name}: ${holderCount !== null ? `${holderCount} holders` : "holder count unknown"} (via ${method || "none"}${coverage === "partial" ? ", partial" : ""})`,
      `top 10 excl. pools/burn hold ${fmtPct(pct(top10))}`,
      `pools ${fmtPct(pct(inPools))}`,
      `burned ${fmtPct(pct(burnRaw))}`,
      creatorRaw !== null ? `creator ${short(creator.creator)} holds ${fmtPct(pct(creatorRaw))}` : "creator unknown",
      ex[0] ? `largest non-pool holder ${short(ex[0].address)} ${fmtPct(pct(ex[0].raw))}${ex[0].is_contract ? " (contract)" : ""}` : "",
    ].filter(Boolean);
    if (topContracts.length) run.note("Contract holders can be lockers, vesting, routers or a team multisig: check before reading them as whales.");
    if (method.startsWith("goplus")) run.note("GoPlus lists only the top 10 holders.");

    return {
      summary: summary.join("; ") + ".",
      data: {
        chain: chain.key,
        chain_id: chain.id,
        token,
        symbol: meta.symbol,
        decimals: dec,
        total_supply: units(supply, dec),
        holder_count: holderCount,
        method: method || null,
        coverage,
        top: table,
        top10_ex_pools_burn_pct: round(pct(top10), 4),
        pools_pct: round(pct(inPools), 4),
        pool_addresses: [...pools].slice(0, 10),
        burned_pct: round(pct(burnRaw), 4),
        creator: creator.creator,
        creator_pct: creatorRaw !== null ? round(pct(creatorRaw), 4) : null,
        log_scan: scanInfo,
        unit: "balance in token units; pct of total supply",
      },
    };
  },
});

function toRaw(s: string, dec: number): bigint {
  const [w = "0", f = ""] = s.split(".");
  try {
    return BigInt(w + (f + "0".repeat(dec)).slice(0, dec));
  } catch {
    return 0n;
  }
}
