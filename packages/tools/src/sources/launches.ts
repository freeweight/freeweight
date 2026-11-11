import type { Chain } from "../chains.js";
import { round } from "../util/args.js";
import type { Run } from "../util/http.js";
import { cleanSnippet } from "../util/page.js";

/**
 * Lists of new tokens from two public sources:
 *  - a launchpad's own list (Pons on Robinhood Chain): every token started on the pad, newest first, with the stage on
 *    its bonding curve;
 *  - GeckoTerminal's new pools: any pool that just appeared on a chain, whatever created it.
 * Names, symbols, descriptions and links are written by whoever made the token: they are cleaned, cut and carried in
 * `_untrusted` fields.
 */
export type LaunchRow = {
  token: string;
  symbol_untrusted: string | null;
  name_untrusted: string | null;
  /** Launchpad the token was started on, when the source says so. */
  launchpad: string | null;
  /** "curve" = still on the launchpad's bonding curve; "graduated" = moved to a pool; "pool" = a pool from the start. */
  stage: "curve" | "graduated" | "pool";
  /** Exchange the pool is on (new pools only). */
  dex: string | null;
  pool: string | null;
  created_at: string | null;
  age_minutes: number | null;
  /** Price times total supply, as the source reports it. */
  market_cap_usd: number | null;
  /** Pool reserve; on a bonding curve, the quote raised so far. */
  liquidity_usd: number | null;
  /** Share of the way to graduation (launchpad rows on the curve). */
  curve_progress_pct: number | null;
  /** Since launch for launchpad rows, last 24 h for new pools. */
  volume_usd: number | null;
  trades: number | null;
  quote: string | null;
  creator: string | null;
  /** Share of each trade paid to the creator, in percent (launchpad rows). */
  creator_fee_pct: number | null;
  description_untrusted: string | null;
  links_untrusted: Record<string, string> | null;
  source: "pons" | "geckoterminal";
};

export const LAUNCHPADS: Record<string, { chainId: number; name: string }> = {
  pons: { chainId: 4663, name: "Pons" },
};

const lower = (v: unknown): string | null => (typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const c = cleanSnippet(v, max);
  return c === "" ? null : c;
};
const ageMin = (ms: number | null): number | null => (ms === null ? null : Math.max(0, Math.round((Date.now() - ms) / 60_000)));

/* ---- Pons ---- */

type PonsItem = {
  address?: unknown;
  name?: unknown;
  symbol?: unknown;
  stage?: unknown;
  description?: unknown;
  deployer?: unknown;
  createdAt?: unknown;
  quote?: { symbol?: unknown } | null;
  progress?: unknown;
  marketCapUsd?: unknown;
  raisedUsd?: unknown;
  volumeUsd?: unknown;
  tradeCount?: unknown;
  creatorTaxBps?: unknown;
  socials?: Record<string, unknown> | null;
  pool?: unknown;
};
type PonsPage = { items?: PonsItem[]; nextCursor?: unknown };

const PONS_API = "https://ponsfamily.com/api/launches";
const PONS_LINKS: [string, string][] = [
  ["twitter", "x"],
  ["telegram", "telegram"],
  ["website", "website"],
];

export function ponsRow(i: PonsItem): LaunchRow | null {
  const token = lower(i.address);
  if (!token) return null;
  const created = num(i.createdAt);
  const ms = created !== null && created > 0 ? created * 1000 : null;
  const stage = i.stage === "graduated" ? "graduated" : "curve";
  const links: Record<string, string> = {};
  for (const [from, to] of PONS_LINKS) {
    const v = text(i.socials?.[from], 120);
    if (v) links[to] = v;
  }
  const progress = num(i.progress);
  const tax = num(i.creatorTaxBps);
  return {
    token,
    symbol_untrusted: text(i.symbol, 24),
    name_untrusted: text(i.name, 48),
    launchpad: "pons",
    stage,
    dex: null,
    pool: typeof i.pool === "string" && /^0x[0-9a-fA-F]{40,64}$/.test(i.pool) ? i.pool.toLowerCase() : null,
    created_at: ms === null ? null : new Date(ms).toISOString(),
    age_minutes: ageMin(ms),
    market_cap_usd: round(num(i.marketCapUsd), 4),
    liquidity_usd: stage === "curve" ? round(num(i.raisedUsd), 4) : null,
    curve_progress_pct: stage === "curve" && progress !== null ? Math.round(Math.max(0, Math.min(1, progress)) * 1000) / 10 : null,
    volume_usd: round(num(i.volumeUsd), 4),
    trades: num(i.tradeCount),
    quote: text(i.quote?.symbol, 12),
    creator: lower(i.deployer),
    creator_fee_pct: tax === null ? null : tax / 100,
    description_untrusted: text(i.description, 140),
    links_untrusted: Object.keys(links).length ? links : null,
    source: "pons",
  };
}

/** One page (40 tokens) of the Pons list, newest first. `cursor` is the previous page's `next`. */
export async function ponsNewest(run: Run, o: { stage?: "curve" | "graduated" | null; cursor?: string | null } = {}): Promise<{ rows: LaunchRow[]; next: string | null }> {
  const q = new URLSearchParams({ sort: "newest" });
  if (o.stage) q.set("stage", o.stage);
  if (o.cursor) q.set("cursor", o.cursor);
  const j = await run.json<PonsPage>(`${PONS_API}?${q.toString()}`, { source: "pons", ttl: 30, timeoutMs: 6000, retries: 1, maxBytes: 1_000_000 });
  if (!j || !Array.isArray(j.items)) throw new Error("unexpected answer from the Pons list");
  const rows = j.items.map(ponsRow).filter((r): r is LaunchRow => r !== null);
  const next = typeof j.nextCursor === "string" && /^[0-9]{1,12}\.0x[0-9a-fA-F]{40}$/.test(j.nextCursor) ? j.nextCursor : null;
  return { rows, next };
}

/* ---- GeckoTerminal new pools ---- */

type GtNewPool = {
  attributes?: {
    address?: unknown;
    pool_created_at?: unknown;
    fdv_usd?: unknown;
    market_cap_usd?: unknown;
    reserve_in_usd?: unknown;
    volume_usd?: { h24?: unknown } | null;
    transactions?: { h24?: { buys?: unknown; sells?: unknown } | null } | null;
  };
  relationships?: Record<string, { data?: { id?: unknown } | null } | undefined>;
};
type GtInc = { id?: unknown; type?: unknown; attributes?: { address?: unknown; symbol?: unknown; name?: unknown } };

export function geckoRow(p: GtNewPool, included: GtInc[], chain: Chain): LaunchRow | null {
  const rel = (k: string): string | null => {
    const id = p.relationships?.[k]?.data?.id;
    return typeof id === "string" ? id : null;
  };
  const inc = (id: string | null) => (id === null ? undefined : included.find((x) => x.id === id));
  const baseId = rel("base_token");
  const base = inc(baseId);
  const token = lower(base?.attributes?.address) ?? lower(baseId?.slice(baseId.indexOf("_") + 1));
  if (!token) return null;
  const a = p.attributes ?? {};
  const t = typeof a.pool_created_at === "string" ? Date.parse(a.pool_created_at) : NaN;
  const ms = Number.isFinite(t) ? t : null;
  const dexId = rel("dex");
  const h24 = a.transactions?.h24;
  const buys = num(h24?.buys);
  const sells = num(h24?.sells);
  return {
    token,
    symbol_untrusted: text(base?.attributes?.symbol, 24),
    name_untrusted: text(base?.attributes?.name, 48),
    launchpad: dexId !== null && chain.id === 4663 && dexId.startsWith("pons") ? "pons" : null,
    stage: "pool",
    dex: text(inc(dexId)?.attributes?.name, 40) ?? text(dexId, 40),
    pool: typeof a.address === "string" && /^0x[0-9a-fA-F]{40,64}$/.test(a.address) ? a.address.toLowerCase() : null,
    created_at: ms === null ? null : new Date(ms).toISOString(),
    age_minutes: ageMin(ms),
    market_cap_usd: round(num(a.market_cap_usd) ?? num(a.fdv_usd), 4),
    liquidity_usd: round(num(a.reserve_in_usd), 4),
    curve_progress_pct: null,
    volume_usd: round(num(a.volume_usd?.h24), 4),
    trades: buys === null && sells === null ? null : (buys ?? 0) + (sells ?? 0),
    quote: text(inc(rel("quote_token"))?.attributes?.symbol, 12),
    creator: null,
    creator_fee_pct: null,
    description_untrusted: null,
    links_untrusted: null,
    source: "geckoterminal",
  };
}

/**
 * The newest pools on a chain (one page of 20). The keyless API allows few requests per address and Workers share
 * theirs, so this is one request per call, never retried, and a good answer is shared between isolates for two minutes.
 */
export async function geckoNewPools(run: Run, chain: Chain): Promise<LaunchRow[]> {
  if (!chain.geckoterminal) return [];
  const j = await run.json<{ data?: GtNewPool[]; included?: GtInc[] }>(
    `https://api.geckoterminal.com/api/v2/networks/${chain.geckoterminal}/new_pools?page=1&include=base_token,quote_token,dex`,
    { source: "geckoterminal", ttl: 120, share: true, retries: 0, timeoutMs: 6000, headers: { accept: "application/json" } },
  );
  if (!j || !Array.isArray(j.data)) throw new Error("unexpected answer from GeckoTerminal");
  const inc = Array.isArray(j.included) ? j.included : [];
  return j.data.map((p) => geckoRow(p, inc, chain)).filter((r): r is LaunchRow => r !== null);
}
