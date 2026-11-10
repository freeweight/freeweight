import { defineTool, partsSummary } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, fmtAge, fmtUsd, round, short, TOKEN_PROP } from "../util/args.js";
import { soft } from "../util/http.js";
import { erc20Meta, noteMetaFailures, units } from "../util/rpc.js";
import { cleanSnippet, quoteUntrusted } from "../util/page.js";
import { describe } from "../sources/facts.js";
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
  reconcile: (body, f) => {
    // One price only: the index's main-venue price when it is reliable, none when the index says it is not.
    const d = body.data;
    const parts = body.parts!;
    const liq = `liquidity ${fmtUsd(d.liquidity_usd as number | null)} in DexScreener pools`;
    if (f.price_reliable === false || f.price_usd === null) {
      d.dexscreener_price_usd_unreliable = d.price_usd;
      d.price_usd = null;
      d.fdv_usd = null;
      d.market_cap_usd = null;
      d.price_note = "the Freeweight index marks the price unreliable (thin or junk market)";
      parts.price = `no reliable price right now (thin or junk market); ${liq}`;
    } else if (typeof f.price_usd === "number") {
      parts.price = `main-venue price ${fmtUsd(f.price_usd)}${typeof f.market_cap_usd === "number" ? `, mcap ${fmtUsd(f.market_cap_usd)}` : ""} (index); ${liq}`;
    }
    return describe("token_overview", f, new Set(["price"]));
  },
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token")!;
    const [meta, pairs, creator] = await Promise.all([
      soft(run, "rpc", erc20Meta(run, chain, token)),
      soft(run, "dexscreener", tokenPairs(run, chain, token)),
      creatorOf(run, chain, token),
    ]);
    if (meta && meta.isContract === false) {
      return { ok: false, summary: `${token} on ${chain.name} has no contract code (not a token, or wrong chain).`, data: { chain: chain.key, chain_id: chain.id, token } };
    }
    if (meta) noteMetaFailures(run, meta);
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

    // Creator-written text (name, symbol, pool symbols) only appears cleaned, capped and quoted.
    const parts: Record<string, string> = {};
    parts.id = `${quoteUntrusted(symbol)} (${quoteUntrusted(name)}) ${short(token)} on ${chain.name}`;
    if (price !== null) parts.price = `price ${fmtUsd(price)}, FDV ${fmtUsd(fdv)}${mcap ? `, mcap ${fmtUsd(mcap)}` : ""}, liquidity ${fmtUsd(liqTotal)} in ${real.length} pool(s)`;
    else parts.price = pairs ? "no DEX pool found on DexScreener" : "market data unavailable";
    if (main) parts.pool = `main pool ${main.dexId}${main.labels?.[0] ? " " + main.labels[0] : ""} vs ${quoteUntrusted(isBase ? main.quoteToken.symbol : main.baseToken.symbol, 16)}`;
    if (junk.length) parts.junk = `${junk.length} junk side pool(s) ignored`;
    parts.age = createdMs ? `age ${fmtAge(Date.now() - createdMs)}${creator.created_at ? "" : " (first pool)"}` : "age unknown";
    if (creator.creator) parts.creator = `creator ${short(creator.creator)}`;

    return {
      summary: partsSummary(parts),
      parts,
      data: {
        chain: chain.key,
        chain_id: chain.id,
        token,
        name_untrusted: name !== null ? cleanSnippet(name, 80) : null,
        symbol_untrusted: symbol !== null ? cleanSnippet(symbol, 32) : null,
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
