import { cleanSnippet } from "../util/page.js";
import type { Chain } from "../chains.js";
import type { Run } from "../util/http.js";
import { round } from "../util/args.js";

const BASE = "https://api.dexscreener.com";

export type DsPair = {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  txns?: Record<string, { buys: number; sells: number }>;
  volume?: Record<string, number>;
  priceChange?: Record<string, number>;
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: { imageUrl?: string; websites?: { label?: string; url: string }[]; socials?: { type: string; url: string }[] };
  /** Where this pool record came from when it is not DexScreener. */
  source?: "geckoterminal" | "freeweight_index";
};

/** Pools under this USD liquidity, or under 1% of the deepest pool while also under $25k, are junk for pricing. */
export const JUNK_LIQ_USD = 1000;

/**
 * Pools for a token: DexScreener, and GeckoTerminal when DexScreener fails (throttling on shared egress is common).
 * An empty DexScreener answer is taken as "no pool listed"; only a failure falls back. When both fail the
 * DexScreener error is thrown, with the fallback's failure noted.
 */
export async function tokenPairs(run: Run, chain: Chain, token: string): Promise<DsPair[]> {
  if (!chain.dexscreener) return chain.geckoterminal ? geckoPairs(run, chain, token) : [];
  try {
    const j = await run.json<DsPair[] | { pairs?: DsPair[] }>(`${BASE}/tokens/v1/${chain.dexscreener}/${token}`, { source: "dexscreener", ttl: 30 });
    const pairs = Array.isArray(j) ? j : (j.pairs ?? []);
    return pairs.filter((p) => p.chainId === chain.dexscreener);
  } catch (e) {
    if (!chain.geckoterminal) throw e;
    try {
      const gt = await geckoPairs(run, chain, token);
      run.note(`DexScreener unavailable (${e instanceof Error ? e.message.slice(0, 60) : "error"}); pools and prices from GeckoTerminal`);
      return gt;
    } catch (g) {
      run.note(`GeckoTerminal fallback unavailable too (${g instanceof Error ? g.message.slice(0, 60) : "error"})`);
      throw e;
    }
  }
}

type GtPool = {
  id: string;
  attributes: {
    address: string;
    name?: string;
    base_token_price_usd?: string | null;
    base_token_price_quote_token?: string | null;
    reserve_in_usd?: string | null;
    pool_created_at?: string | null;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    volume_usd?: Record<string, string | null>;
    price_change_percentage?: Record<string, string | null>;
    transactions?: Record<string, { buys?: number; sells?: number }>;
  };
  relationships: { base_token: { data: { id: string } }; quote_token: { data: { id: string } }; dex: { data: { id: string } } };
};
type GtIncluded = { id: string; type: string; attributes: { symbol?: string; name?: string } };

const num = (v: string | null | undefined) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));

/** Map one GeckoTerminal pool to the DexScreener pair shape the tools read. */
export function geckoToPair(p: GtPool, chain: Chain, included: GtIncluded[]): DsPair {
  const tok = (rel: { data: { id: string } }) => {
    const id = rel.data.id;
    const inc = included.find((i) => i.id === id);
    return { address: id.slice(id.indexOf("_") + 1).toLowerCase(), name: inc?.attributes.name ?? "", symbol: inc?.attributes.symbol ?? "" };
  };
  const a = p.attributes;
  const dex = p.relationships.dex.data.id;
  const addr = a.address.toLowerCase();
  // A 32-byte pool id is a Uniswap v4 pool whatever the venue's name; otherwise read the version from the dex id.
  const labels = addr.length === 66 ? ["v4"] : /v3/.test(dex) ? ["v3"] : /v2/.test(dex) ? ["v2"] : [];
  const pc = a.price_change_percentage ?? {};
  const vol = a.volume_usd ?? {};
  return {
    chainId: chain.dexscreener ?? chain.key,
    dexId: dex,
    url: `https://www.geckoterminal.com/${chain.geckoterminal}/pools/${addr}`,
    pairAddress: addr,
    labels,
    baseToken: tok(p.relationships.base_token),
    quoteToken: tok(p.relationships.quote_token),
    priceNative: a.base_token_price_quote_token ?? undefined,
    priceUsd: a.base_token_price_usd ?? undefined,
    txns: a.transactions?.h24 ? { h24: { buys: a.transactions.h24.buys ?? 0, sells: a.transactions.h24.sells ?? 0 } } : undefined,
    volume: num(vol.h24) !== undefined ? { h24: num(vol.h24)! } : undefined,
    priceChange: Object.fromEntries(["m5", "h1", "h6", "h24"].filter((k) => num(pc[k]) !== undefined).map((k) => [k, num(pc[k])!])),
    liquidity: num(a.reserve_in_usd) !== undefined ? { usd: num(a.reserve_in_usd) } : undefined,
    fdv: num(a.fdv_usd),
    marketCap: num(a.market_cap_usd),
    pairCreatedAt: a.pool_created_at ? Date.parse(a.pool_created_at) : undefined,
    source: "geckoterminal",
  };
}

export async function geckoPairs(run: Run, chain: Chain, token: string): Promise<DsPair[]> {
  if (!chain.geckoterminal) return [];
  const j = await run.json<{ data?: GtPool[]; included?: GtIncluded[] }>(
    `https://api.geckoterminal.com/api/v2/networks/${chain.geckoterminal}/tokens/${token}/pools?page=1&include=base_token,quote_token,dex`,
    { source: "geckoterminal", ttl: 60, retries: 0, timeoutMs: 6000, headers: { accept: "application/json" } },
  );
  return (j.data ?? []).map((p) => geckoToPair(p, chain, j.included ?? []));
}

export async function searchPairs(run: Run, q: string): Promise<DsPair[]> {
  const j = await run.json<{ pairs?: DsPair[] }>(`${BASE}/latest/dex/search?q=${encodeURIComponent(q)}`, { source: "dexscreener", ttl: 60 });
  return j.pairs ?? [];
}

export async function pairByAddress(run: Run, chain: Chain, pair: string): Promise<DsPair | null> {
  if (!chain.dexscreener) return null;
  const j = await run.json<{ pairs?: DsPair[] | null; pair?: DsPair | null }>(`${BASE}/latest/dex/pairs/${chain.dexscreener}/${pair}`, { source: "dexscreener", ttl: 30 });
  return j.pair ?? j.pairs?.[0] ?? null;
}

export type PoolSummary = {
  pair: string;
  dex: string;
  version: string | null;
  /** The other side's symbol, as listed (creator-written). */
  quote_symbol_untrusted: string;
  liquidity_usd: number | null;
  price_usd: number | null;
  volume_24h_usd: number | null;
  created_at: string | null;
  url: string | null;
};

/** USD price of `token` in this pair (handles token as base or quote). */
export function priceOf(p: DsPair, token: string): number | null {
  const pu = p.priceUsd ? Number(p.priceUsd) : NaN;
  if (!Number.isFinite(pu)) return null;
  if (p.baseToken.address.toLowerCase() === token) return pu;
  const pn = p.priceNative ? Number(p.priceNative) : NaN;
  if (p.quoteToken.address.toLowerCase() === token && Number.isFinite(pn) && pn > 0) return pu / pn;
  return null;
}

export function summarizePool(p: DsPair, token: string): PoolSummary {
  const other = p.baseToken.address.toLowerCase() === token ? p.quoteToken : p.baseToken;
  return {
    pair: p.pairAddress.toLowerCase(),
    dex: p.dexId,
    version: p.labels?.[0] ?? null,
    quote_symbol_untrusted: cleanSnippet(other.symbol, 32),
    liquidity_usd: round(p.liquidity?.usd ?? null, 6),
    price_usd: round(priceOf(p, token), 6),
    volume_24h_usd: round(p.volume?.h24 ?? null, 6),
    created_at: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
    url: p.url ?? null,
  };
}

/**
 * Pick the main (deepest) pool and separate junk side pools, which give fake price wicks.
 */
export function pickMainPool(pairs: DsPair[], token: string): { main: DsPair | null; real: DsPair[]; junk: DsPair[] } {
  const mine = pairs.filter((p) => p.baseToken.address.toLowerCase() === token || p.quoteToken.address.toLowerCase() === token);
  const sorted = [...mine].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = sorted[0]?.liquidity?.usd ?? 0;
  const real: DsPair[] = [];
  const junk: DsPair[] = [];
  for (const p of sorted) {
    const l = p.liquidity?.usd ?? 0;
    if (p === sorted[0] || (l >= JUNK_LIQ_USD && (l >= top * 0.01 || l >= 25_000))) real.push(p);
    else junk.push(p);
  }
  return { main: sorted[0] ?? null, real, junk };
}

export function websitesOf(pairs: DsPair[]): string[] {
  const out = new Set<string>();
  for (const p of pairs) for (const w of p.info?.websites ?? []) if (w.url) out.add(w.url);
  return [...out];
}

export function socialsOf(pairs: DsPair[]): { type: string; url: string }[] {
  const seen = new Map<string, { type: string; url: string }>();
  for (const p of pairs) for (const s of p.info?.socials ?? []) if (s.url) seen.set(s.url, { type: s.type, url: s.url });
  return [...seen.values()];
}
