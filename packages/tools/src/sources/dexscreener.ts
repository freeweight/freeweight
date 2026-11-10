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
};

/** Pools with less than this USD liquidity, or under 2% of the deepest pool, are treated as junk for pricing. */
export const JUNK_LIQ_USD = 1000;

export async function tokenPairs(run: Run, chain: Chain, token: string): Promise<DsPair[]> {
  if (!chain.dexscreener) return [];
  const j = await run.json<DsPair[] | { pairs?: DsPair[] }>(`${BASE}/tokens/v1/${chain.dexscreener}/${token}`, { source: "dexscreener", ttl: 30 });
  const pairs = Array.isArray(j) ? j : (j.pairs ?? []);
  return pairs.filter((p) => p.chainId === chain.dexscreener);
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
  quote: string;
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
    quote: other.symbol,
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
    if (p === sorted[0] || (l >= JUNK_LIQ_USD && l >= top * 0.02)) real.push(p);
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
