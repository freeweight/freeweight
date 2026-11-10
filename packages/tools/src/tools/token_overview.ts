import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, fmtAge, fmtUsd, round, short, TOKEN_PROP } from "../util/args.js";
import { soft } from "../util/http.js";
import { erc20Meta, units } from "../util/rpc.js";
import { pickMainPool, priceOf, socialsOf, summarizePool, tokenPairs, websitesOf } from "../sources/dexscreener.js";
import { creatorOf } from "../sources/common.js";

export const tokenOverview = defineTool({
  name: "token_overview",
  title: "Token overview",
  description:
    "Basic facts for an ERC-20 token: name, symbol, decimals, total supply (on-chain), creator and age where discoverable, " +
    "USD price, FDV/market cap, liquidity and the main (deepest) pool. Tiny side pools are listed separately and ignored for price.",
  inputSchema: {
    type: "object",
    properties: { chain: CHAIN_PROP, token: TOKEN_PROP },
    required: ["token"],
    additionalProperties: false,
  },
  enrich: (a) => ({ chain: chainArg(a), token: addr(a, "token")! }),
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token")!;
    const [meta, pairs, creator] = await Promise.all([
      soft(run, "rpc", erc20Meta(run, chain, token)),
      soft(run, "dexscreener", tokenPairs(run, chain, token)),
      creatorOf(run, chain, token),
    ]);
    if (meta && !meta.isContract) {
      return { ok: false, summary: `${token} on ${chain.name} has no contract code (not a token, or wrong chain).`, data: { chain: chain.key, chain_id: chain.id, token } };
    }
    const { main, real, junk } = pickMainPool(pairs ?? [], token);
    const price = main ? priceOf(main, token) : null;
    const supply = meta ? units(meta.totalSupply, meta.decimals) : null;
    const fdv = price !== null && supply !== null ? price * supply : null;
    const isBase = main ? main.baseToken.address.toLowerCase() === token : false;
    const mcap = main && isBase && main.marketCap ? main.marketCap : null;
    const liqTotal = real.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
    const firstPool = (pairs ?? []).map((p) => p.pairCreatedAt ?? 0).filter((x) => x > 0).sort((a, b) => a - b)[0] ?? null;
    const createdMs = creator.created_at ? Date.parse(creator.created_at) : firstPool;
    const name = meta?.name ?? main?.baseToken.name ?? null;
    const symbol = meta?.symbol ?? (main && isBase ? main.baseToken.symbol : null);

    const parts: string[] = [];
    parts.push(`$${symbol ?? "?"} (${name ?? "unknown"}) ${short(token)} on ${chain.name}`);
    if (price !== null) parts.push(`price ${fmtUsd(price)}, FDV ${fmtUsd(fdv)}${mcap ? `, mcap ${fmtUsd(mcap)}` : ""}, liquidity ${fmtUsd(liqTotal)} in ${real.length} pool(s)`);
    else parts.push(pairs ? "no DEX pool found on DexScreener" : "market data unavailable");
    if (main) parts.push(`main pool ${main.dexId}${main.labels?.[0] ? " " + main.labels[0] : ""} vs ${isBase ? main.quoteToken.symbol : main.baseToken.symbol}`);
    if (junk.length) parts.push(`${junk.length} junk side pool(s) ignored`);
    parts.push(createdMs ? `age ${fmtAge(Date.now() - createdMs)}${creator.created_at ? "" : " (first pool)"}` : "age unknown");
    if (creator.creator) parts.push(`creator ${short(creator.creator)}`);

    return {
      summary: parts.join("; ") + ".",
      data: {
        chain: chain.key,
        chain_id: chain.id,
        token,
        name,
        symbol,
        decimals: meta?.decimals ?? null,
        total_supply: supply,
        total_supply_unit: "tokens",
        price_usd: round(price),
        fdv_usd: round(fdv),
        market_cap_usd: round(mcap),
        liquidity_usd: round(liqTotal),
        main_pool: main ? summarizePool(main, token) : null,
        other_pools: real.slice(1, 6).map((p) => summarizePool(p, token)),
        junk_pools_ignored: junk.length,
        creator: creator.creator,
        creation_tx: creator.tx,
        created_at: creator.created_at,
        first_pool_at: firstPool ? new Date(firstPool).toISOString() : null,
        age_hours: createdMs ? round((Date.now() - createdMs) / 3_600_000, 4) : null,
        websites: websitesOf(pairs ?? []),
        socials: socialsOf(pairs ?? []),
        price_change_pct: main?.priceChange ?? null,
        volume_24h_usd: round(real.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0)),
        dexscreener_url: main?.url ?? null,
      },
    };
  },
});
