import { quoteUntrusted } from "../util/page.js";
import { CHAINS } from "../chains.js";
import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, fmtUsd, InputError, round, short, TOKEN_PROP } from "../util/args.js";
import { soft } from "../util/http.js";
import { pairByAddress, pickMainPool, priceOf, summarizePool, tokenPairs, type DsPair } from "../sources/dexscreener.js";

const MAJOR_ALIASES: Record<string, string> = { eth: "ethereum", btc: "bitcoin", bnb: "binancecoin", sol: "solana", usdc: "usd-coin", usdt: "tether", pol: "polygon-ecosystem-token", arb: "arbitrum", op: "optimism" };

export const marketData = defineTool({
  name: "market_data",
  title: "Market data",
  description:
    "Live market data: for a token (or a pair/pool address) the main and other real pools with price, liquidity, volume, buys/sells and price change " +
    "(DexScreener; junk side pools flagged), plus USD prices of major coins from CoinGecko (e.g. ethereum, bitcoin).",
  inputSchema: {
    type: "object",
    properties: {
      chain: CHAIN_PROP,
      token: TOKEN_PROP,
      pair: { type: "string", description: "Pool/pair address or v4 pool id instead of a token." },
      majors: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
        description: 'CoinGecko ids or tickers, as a list, e.g. ["eth", "btc"]. Default: ethereum, bitcoin + chain native.',
        examples: [["eth", "btc"]],
      },
    },
    additionalProperties: false,
  },
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token", false);
    const pairArg = typeof args.pair === "string" && /^0x[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$/.test(args.pair) ? args.pair.toLowerCase() : null;
    if (args.pair !== undefined && !pairArg) throw new InputError("invalid_input", "pair must be a 20-byte address or 32-byte pool id");
    let majors: string[] = Array.isArray(args.majors) ? args.majors.filter((x): x is string => typeof x === "string").slice(0, 10) : [];
    if (!majors.length) majors = ["ethereum", "bitcoin", chain.nativeCoingecko ?? "ethereum"];
    majors = [...new Set(majors.map((m) => MAJOR_ALIASES[m.toLowerCase()] ?? m.toLowerCase()).filter((m) => /^[a-z0-9-]{1,60}$/.test(m)))];

    const [pairs, single, cg] = await Promise.all([
      token ? soft(run, "dexscreener", tokenPairs(run, chain, token)) : Promise.resolve(undefined),
      pairArg ? soft(run, "dexscreener", pairByAddress(run, chain, pairArg)) : Promise.resolve(undefined),
      soft(
        run,
        "coingecko",
        run.json<Record<string, { usd?: number; usd_24h_change?: number }>>(`https://api.coingecko.com/api/v3/simple/price?ids=${majors.join(",")}&vs_currencies=usd&include_24hr_change=true`, {
          source: "coingecko",
          ttl: 60,
          timeoutMs: 6000,
        }),
      ),
    ]);

    const parts: string[] = [];
    const data: Record<string, unknown> = { chain: chain.key, chain_id: chain.id };
    const poolRow = (p: DsPair, t: string) => ({
      ...summarizePool(p, t),
      txns_24h: p.txns?.h24 ?? null,
      txns_1h: p.txns?.h1 ?? null,
      volume_usd: p.volume ?? null,
      price_change_pct: p.priceChange ?? null,
      fdv_usd: round(p.fdv ?? null),
      market_cap_usd: round(p.marketCap ?? null),
    });
    if (token) {
      const { main, real, junk } = pickMainPool(pairs ?? [], token);
      data.token = token;
      data.main_pool = main ? poolRow(main, token) : null;
      data.other_pools = real.slice(1, 8).map((p) => poolRow(p, token));
      data.junk_pools = junk.slice(0, 5).map((p) => ({ pair: p.pairAddress.toLowerCase(), dex: p.dexId, liquidity_usd: round(p.liquidity?.usd ?? null), price_usd_unreliable: round(priceOf(p, token)) }));
      if (main) {
        const sym = quoteUntrusted(main.baseToken.address.toLowerCase() === token ? main.baseToken.symbol : main.quoteToken.symbol);
        const t = main.txns?.h24;
        parts.push(
          `${sym} ${short(token)}: ${fmtUsd(priceOf(main, token))}, 24h ${main.priceChange?.h24 ?? "n/a"}%, 1h ${main.priceChange?.h1 ?? "n/a"}%, liquidity ${fmtUsd(real.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0))}, 24h volume ${fmtUsd(real.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0))}${t ? `, 24h ${t.buys} buys / ${t.sells} sells (main pool)` : ""}`,
        );
        if (junk.length) parts.push(`${junk.length} junk pool(s) excluded (their prices are unreliable)`);
      } else parts.push(`no pools for ${short(token)} on ${chain.name}`);
    }
    if (pairArg) {
      data.pair = single ? poolRow(single, single.baseToken.address.toLowerCase()) : null;
      if (single) parts.push(`pair ${quoteUntrusted(single.baseToken.symbol, 16)}/${quoteUntrusted(single.quoteToken.symbol, 16)}: ${fmtUsd(single.priceUsd ? Number(single.priceUsd) : null)}, liquidity ${fmtUsd(single.liquidity?.usd ?? null)}`);
      else parts.push(`pair ${short(pairArg)} not found on DexScreener`);
    }
    if (cg) {
      data.majors_usd = Object.fromEntries(Object.entries(cg).map(([k, v]) => [k, { usd: v.usd ?? null, change_24h_pct: round(v.usd_24h_change ?? null, 4) }]));
      parts.push(Object.entries(cg).map(([k, v]) => `${k} ${fmtUsd(v.usd ?? null)}`).join(", "));
    }
    data.supported_chains = CHAINS.map((c) => c.key);
    return { summary: parts.join("; ") + ".", data };
  },
});
