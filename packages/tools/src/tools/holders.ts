import { cleanSnippet, quoteUntrusted } from "../util/page.js";
import { defineTool, partsSummary } from "../tool.js";
import { describe } from "../sources/facts.js";
import { addr, chainArg, CHAIN_PROP, fmtPct, int, round, short, TOKEN_PROP } from "../util/args.js";
import { soft } from "../util/http.js";
import { balanceOf, balanceOfData, blockNumber, erc20Meta, noteMetaFailures, rpcBatch, units } from "../util/rpc.js";
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
  reconcile: (body, f) => {
    // One "top 10" figure: the index's when it has one, with its basis; the public figure stays in data.
    if (typeof f.top10_share === "number" && body.parts) {
      body.parts.top10 = `top 10 wallets hold ${(f.top10_share * 100).toFixed(1)}% of supply (Freeweight index, holder-level view; public on-chain count: ${body.data.top10_ex_pools_burn_pct ?? "n/a"}%)`;
      return describe("holders", f, new Set(["top10"]));
    }
    return undefined;
  },
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
    if (meta.isContract === false) return { ok: false, summary: `${token} has no contract code on ${chain.name}.`, data: { chain: chain.key, token } };
    noteMetaFailures(run, meta);
    if (meta.totalSupply === null) {
      run.partial = true;
      run.note("total supply unreadable: percentages are missing");
    }
    /** Decimals for display only; unknown decimals mean balances are shown as null (raw ranking still works). */
    const dec = meta.decimals;
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
      rows = gp.holders.map((h) => ({ address: h.address.toLowerCase(), raw: toRaw(h.balance ?? "0", dec ?? 18), is_contract: h.is_contract === undefined ? null : h.is_contract === 1, label: h.tag || null }));
      method = "goplus (top 10)";
      holderCount = gp.holder_count ? Number(gp.holder_count) : null;
    }
    // Transfer-log reconstruction: when nothing else worked, or to go past GoPlus' top 10 on young tokens.
    let scanInfo: Record<string, unknown> | null = null;
    let logsTried = "not attempted (time budget)";
    const tooBusy = holderCount !== null && holderCount > 5000;
    if (tooBusy) logsTried = "skipped (too many holders for a keyless scan)";
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
          logsTried = scan.complete ? (mintSeen ? "complete" : "the scanned window does not contain the mint") : "the scan stopped early";
          if (scan.complete && (mintSeen || rows.length === 0)) {
            const bal = balancesFrom(scan.transfers);
            const recon = [...bal.entries()].filter(([a, v]) => v > 0n && a !== ZERO).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
            rows = recon.slice(0, 60).map(([a, v]) => ({ address: a, raw: v, is_contract: null, label: null }));
            holderCount = recon.length;
            method = "transfer logs";
            coverage = mintSeen ? "full" : "partial";
            if (!mintSeen) {
              run.partial = true;
              run.note("The scanned log window does not contain the mint: rows are net transfers within the window, re-read on-chain where possible, and holders from before the window are missing.");
            }
          }
        } else {
          run.note(`log reconstruction skipped: token too old for keyless log scan (${Math.round(ageDays)} d)`);
          logsTried = `skipped (token about ${Math.round(ageDays)} days old, too old for a keyless log scan)`;
        }
      }
    }
    let gap: string | null = null;
    if (!rows.length) {
      run.partial = true;
      // Say what was tried; never fill the gap with guesses.
      const tried = [
        chain.explorers.length === 0 ? "no keyless explorer API exists for this chain" : explorer ? "explorer API (no holders listed)" : "explorer API (unavailable or refusing server requests)",
        !chain.goplus ? "GoPlus (does not cover this chain)" : gp === undefined ? "GoPlus (unavailable)" : "GoPlus (no holder list)",
        `Transfer-log reconstruction (${logsTried})`,
      ];
      gap = `no holder list: tried ${tried.join("; ")}. Older tokens on chains without the Freeweight index need a keyed explorer API for their holder list`;
      run.note(gap + ".");
    }

    // Verify balances on-chain and tag contracts (batched). Enough rows are verified for a real top 10 whatever `limit` is.
    const top = rows.slice(0, Math.max(limit, 25));
    const special = [ZERO, "0x000000000000000000000000000000000000dead", ...(creator.creator ? [creator.creator] : [])];
    const batch = await rpcBatch(run, chain, [
      ...top.map((r) => ({ method: "eth_call", params: [{ to: token, data: balanceOfData(r.address) }, "latest"] })),
      ...top.map((r) => ({ method: "eth_getCode", params: [r.address, "latest"] })),
      ...special.map((a) => ({ method: "eth_call", params: [{ to: token, data: balanceOfData(a) }, "latest"] })),
    ]).catch(() => [] as unknown[]);
    const verified = top.length > 0 && top.some((_, i) => typeof batch[i] === "string");
    if (top.length && !verified) {
      run.partial = true;
      run.note("on-chain balance check failed: holder balances are as listed by the source, not verified");
    }
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
    const burn0 = sb(0);
    const burnDead = sb(1);
    const burnRaw = burn0 === null && burnDead === null ? null : (burn0 ?? 0n) + (burnDead ?? 0n);
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
    const table = top.slice(0, limit).map((r) => ({ address: r.address, balance: units(r.raw, dec), pct_supply: round(pct(r.raw), 4), tags: tag(r) }));
    const inPools = top.filter((r) => pools.has(r.address)).reduce((s, r) => s + r.raw, 0n);
    const ex = top.filter((r) => !pools.has(r.address) && !DEAD_ADDRESSES.has(r.address));
    const topN = Math.min(10, ex.length);
    const top10 = ex.slice(0, 10).reduce((s, r) => s + r.raw, 0n);
    const topContracts = ex.filter((r) => r.is_contract).slice(0, 5).map((r) => r.address);

    const parts: Record<string, string> = {
      id: `${meta.symbol ? quoteUntrusted(meta.symbol) + " " + short(token) : short(token)} on ${chain.name}: ${holderCount !== null ? `${holderCount} holders` : "holder count unknown"} (via ${method || "none"}${coverage === "partial" ? ", partial window" : ""})`,
      top10: topN === 10 ? `top 10 wallets (excl. pools and burns) hold ${fmtPct(pct(top10))}` : `the ${topN} known non-pool wallets hold ${fmtPct(pct(top10))}`,
      pools: `pools ${fmtPct(pct(inPools))}`,
      burned: burnRaw === null ? "burned share unknown" : `burned ${fmtPct(pct(burnRaw))}`,
      creator: creatorRaw !== null ? `creator ${short(creator.creator)} holds ${fmtPct(pct(creatorRaw))}` : "creator unknown",
    };
    if (ex[0]) parts.largest = `largest non-pool holder ${short(ex[0].address)} ${fmtPct(pct(ex[0].raw))}${ex[0].is_contract ? " (contract)" : ""}`;
    if (gap) {
      // No list: keep the on-chain facts (burned, creator), drop sentences that would describe an empty table.
      delete parts.top10;
      delete parts.pools;
      parts.gap = gap;
    }
    if (topContracts.length) run.note("Contract holders can be lockers, vesting, routers or a team multisig: check before reading them as whales.");
    if (method.startsWith("goplus")) run.note("GoPlus lists only the top 10 holders.");

    return {
      summary: partsSummary(parts),
      parts,
      data: {
        chain: chain.key,
        chain_id: chain.id,
        token,
        symbol_untrusted: meta.symbol !== null ? cleanSnippet(meta.symbol, 32) : null,
        decimals: dec,
        total_supply: meta.totalSupply === null ? null : units(supply, dec),
        holder_count: holderCount,
        method: method || null,
        coverage,
        top: table,
        top10_ex_pools_burn_pct: round(pct(top10), 4),
        top10_basis: `${topN} largest verified non-pool, non-burn wallets`,
        pools_pct: round(pct(inPools), 4),
        pool_addresses: [...pools].slice(0, 10),
        burned_pct: burnRaw === null ? null : round(pct(burnRaw), 4),
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
