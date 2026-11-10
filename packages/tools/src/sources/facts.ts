import type { Run } from "../util/http.js";
import { cleanSnippet } from "../util/page.js";

/**
 * Freeweight index (Contract 4): private, read-only enrichment for Robinhood Chain tokens.
 * GET {FACTS_URL}/v1/{tool}?token=0x… with X-FW-Facts-Key (+ Cloudflare Access service-token headers when set).
 * Only documented fields are copied (explicit maps below); the origin never appears in output.
 */
export const ENRICHED_TOOLS = new Set(["token_overview", "safety_check", "holders", "dev_history", "official_ca", "project_check"]);

const UA = "freeweight-tools/0.1";
const TIMEOUT_MS = 1500;
const TTL_S = 60;

type Kind = "s" | "n" | "b" | "addr" | "text";
export type Shape = { [k: string]: Kind | { list: Shape; max?: number } | { obj: Shape } };

export const SHAPES: Record<string, Shape> = {
  token_overview: {
    name: "text",
    symbol: "text",
    launchpad: "s",
    quote_asset: "s",
    creator: "addr",
    launched_at: "n",
    launch_block: "n",
    age_s: "n",
    total_supply: "n",
    graduated: "b",
    graduated_at: "n",
    price_usd: "n",
    market_cap_usd: "n",
    price_reliable: "b",
    liquidity_usd_approx: "n",
    liquidity_basis: "s",
    main_venue: "s",
    main_venue_type: "s",
    last_trade_at: "n",
  },
  safety_check: {
    sell_test: "s",
    round_trip_cost: "n",
    buy_cost: "n",
    sell_cost: "n",
    custom_pool_hook: "b",
    contract_checks: "s",
    owner_renounced: "b",
    mint_possible: "b",
    blacklist_possible: "b",
    tax_changeable: "b",
    pausable: "b",
    transfer_limits: "b",
    upgradeable_proxy: "b",
  },
  holders: {
    holder_count: "n",
    pool_share: "n",
    locked_share: "n",
    burned_share: "n",
    token_contract_share: "n",
    dev_share: "n",
    linked_wallets_share: "n",
    snipers_share: "n",
    top10_share: "n",
    top10_share_of_held: "n",
    wallets_to_half: "n",
    computed_at: "n",
  },
  dev_history: {
    creator: "addr",
    creator_is_shared_launcher: "b",
    prior_launches_n: "n",
    prior_launches: {
      max: 20,
      list: { token: "addr", symbol: "text", launchpad: "s", launched_at: "n", graduated: "b", peak_mc_band: "s", peak_multiple_band: "s", status: "s" },
    },
    prior_summary: {
      obj: { listed: "n", graduated: "n", active: "n", peak_mc_under_10k: "n", peak_mc_10k_50k: "n", peak_mc_50k_250k: "n", peak_mc_250k_1m: "n", peak_mc_1m_plus: "n" },
    },
    dev_holds_share: "n",
    dev_peak_share: "n",
    dev_sold_share_of_peak: "n",
    dev_burned_share_of_peak: "n",
    dev_moved_share_of_peak: "n",
    dev_last_sell_at: "n",
    fee_recipient_is_creator: "b",
  },
  official_ca: {
    named_on_site: "b",
    named_in_repo: "b",
    is_official: "b",
    official_token: "addr",
    official_reason: "text",
    links: { max: 10, list: { link_type: "s", launches_on_link: "n", this_token_role: "s", official_token: "addr", reason: "text" } },
    earlier_launches_on_same_links: "n",
    later_launches_on_same_links: "n",
    same_creator_earlier_attempts: "n",
    same_ticker_launches_24h: "n",
    lookalike_of_earlier: "b",
    copy_of_active_token: "b",
  },
  project_check: {
    site_domain: "s",
    domain_registered_at: "n",
    domain_age_at_launch_d: "n",
    domain_reregistered: "b",
    hosted_subdomain_of: "s",
    site_http_status: "n",
    site_title: "text",
    site_description: "text",
    site_has_wallet_connect: "b",
    site_links_docs: "b",
    site_checked_at: "n",
    product_stage: "s",
    repo_commits: "n",
    repo_span_d: "n",
    repo_first_commit_before_launch_d: "n",
    repo_authors: "n",
    project_contracts_n: "n",
    first_contract_deployed_at: "n",
    project_contracts: { max: 20, list: { address: "addr", deployed_at: "n", deployed_by_creator: "b", code_kb: "n" } },
    checked_at: "n",
  },
};

/** Fields whose text comes from a third-party website: renamed with an _untrusted suffix. */
const UNTRUSTED = new Set(["site_title", "site_description"]);

function mapValue(v: unknown, k: Kind): unknown {
  if (v === null || v === undefined) return null;
  switch (k) {
    case "n":
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    case "b":
      return typeof v === "boolean" ? v : null;
    case "addr":
      return typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : null;
    case "s":
      return typeof v === "string" ? v.slice(0, 120) : null;
    case "text":
      return typeof v === "string" ? cleanSnippet(v, 200) : null;
  }
}

export function mapShape(src: unknown, shape: Shape): Record<string, unknown> {
  const o = (src && typeof src === "object" && !Array.isArray(src) ? src : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, spec] of Object.entries(shape)) {
    const v = o[k];
    let mapped: unknown;
    if (typeof spec === "string") mapped = mapValue(v, spec);
    else if ("list" in spec) mapped = Array.isArray(v) ? v.slice(0, spec.max ?? 20).map((item) => mapShape(item, spec.list)) : null;
    else mapped = v && typeof v === "object" ? mapShape(v, spec.obj) : null;
    out[UNTRUSTED.has(k) ? `${k}_untrusted` : k] = mapped;
  }
  return out;
}

export type Enrichment = { status: "merged"; as_of: number | null; fields: Record<string, unknown>; line: string } | { status: "not_found" } | { status: "failed"; why: string };

export async function fetchEnrichment(run: Run, tool: string, token: string): Promise<Enrichment | undefined> {
  const { FACTS_URL, FACTS_KEY, FACTS_ACCESS_ID, FACTS_ACCESS_SECRET } = run.ctx.env;
  if (!FACTS_URL || !FACTS_KEY || !ENRICHED_TOOLS.has(tool)) return undefined;
  const base = FACTS_URL.replace(/\/+$/, "");
  const url = `${base}/v1/${tool}?token=${token.toLowerCase()}`;
  const headers: Record<string, string> = { "X-FW-Facts-Key": FACTS_KEY, "user-agent": UA, accept: "application/json" };
  if (FACTS_ACCESS_ID && FACTS_ACCESS_SECRET) {
    headers["CF-Access-Client-Id"] = FACTS_ACCESS_ID;
    headers["CF-Access-Client-Secret"] = FACTS_ACCESS_SECRET;
  }
  let j: { found?: unknown; as_of?: unknown; data?: unknown };
  try {
    j = await run.json(url, {
      source: "Freeweight index",
      public: false,
      ttl: TTL_S,
      timeoutMs: TIMEOUT_MS,
      retries: 0,
      headers,
      cacheKey: `facts:${tool}:${token.toLowerCase()}`,
      maxBytes: 200_000,
    });
  } catch (e) {
    const m = e instanceof Error ? e.message : "error";
    return { status: "failed", why: /timeout/.test(m) ? "timeout" : /HTTP (\d+)/.exec(m)?.[0] ?? "unreachable" };
  }
  // The JSON source label was recorded by run.json; only keep it when data is merged.
  run.sources.delete("Freeweight index");
  if (j.found !== true || !j.data || typeof j.data !== "object") return { status: "not_found" };
  const fields = mapShape(j.data, SHAPES[tool]!);
  return { status: "merged", as_of: typeof j.as_of === "number" ? j.as_of : null, fields, line: describe(tool, fields) };
}

const pct = (x: unknown) => (typeof x === "number" ? `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%` : "n/a");
const usd = (x: unknown) => (typeof x === "number" ? (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toPrecision(3)}`) : "n/a");

/** One short sentence per tool, for the summary. */
export function describe(tool: string, f: Record<string, unknown>): string {
  switch (tool) {
    case "token_overview": {
      const p: string[] = [];
      if (f.launchpad) p.push(`${f.launchpad} launch`);
      if (f.graduated !== null) p.push(f.graduated ? "graduated" : "not graduated");
      if (f.price_reliable === false) p.push("price not reliable right now");
      else if (f.price_usd !== null) p.push(`main-venue price ${usd(f.price_usd)}, mcap ${usd(f.market_cap_usd)}`);
      if (f.liquidity_usd_approx !== null) p.push(`liquidity ~${usd(f.liquidity_usd_approx)}`);
      return p.join(", ");
    }
    case "safety_check": {
      const t = f.sell_test;
      const s =
        t === "blocked"
          ? "SELL TEST: BLOCKED (a sale fails)"
          : t === "restricted"
            ? "sell test: RESTRICTED (sales through ordinary routes can fail)"
            : t === "costly"
              ? `sell test: COSTLY (a simulated $1 round trip loses ${pct(f.round_trip_cost)})`
              : t === "ok"
                ? `sell test ok${typeof f.round_trip_cost === "number" ? ` (round trip cost ${pct(f.round_trip_cost)})` : ""}`
                : t === "not_tested"
                  ? "sell not tested (bonding curve or plain pool)"
                  : `sell test ${t ?? "unknown"}`;
      const extra = f.custom_pool_hook ? ", custom pool hook" : "";
      const tpl = f.contract_checks === "launchpad_template" ? ", standard launchpad token template" : "";
      return s + extra + tpl;
    }
    case "holders": {
      const p: string[] = [];
      const add = (k: string, label: string) => typeof f[k] === "number" && p.push(`${label} ${pct(f[k])}`);
      add("linked_wallets_share", "linked wallets");
      add("snipers_share", "snipers still holding");
      add("dev_share", "dev");
      add("top10_share", "top 10");
      if (typeof f.wallets_to_half === "number") p.push(`half of held supply in ${f.wallets_to_half} wallets`);
      return p.join(", ");
    }
    case "dev_history": {
      const n = f.prior_launches_n;
      const sum = (f.prior_summary ?? {}) as Record<string, unknown>;
      if (f.creator_is_shared_launcher === true) return `creator is a shared launcher (it launches for many people): its ${n ?? "?"} launches are not one developer's record`;
      const p = [`creator has ${n ?? "?"} other launch(es)`];
      if (typeof sum.graduated === "number") p.push(`${sum.graduated} graduated, ${sum.active ?? "?"} active`);
      if (typeof f.dev_sold_share_of_peak === "number") p.push(`dev sold ${pct(f.dev_sold_share_of_peak)} of its peak bag`);
      return p.join(", ");
    }
    case "official_ca": {
      const p: string[] = [];
      if (f.is_official === true) p.push(`official per ${f.official_reason ?? "project evidence"}`);
      else if (f.is_official === false) p.push(`NOT the official token${f.official_token ? ` (official: ${String(f.official_token).slice(0, 6)}…${String(f.official_token).slice(-4)})` : ""}`);
      else p.push("official status not resolved by site/repo evidence");
      if (typeof f.earlier_launches_on_same_links === "number" && f.earlier_launches_on_same_links > 0) p.push(`${f.earlier_launches_on_same_links} earlier launch(es) used the same links`);
      if (f.copy_of_active_token === true) p.push("copy of an active token");
      return p.join(", ");
    }
    case "project_check": {
      const p: string[] = f.product_stage ? [`product stage ${f.product_stage}`] : [];
      if (typeof f.repo_commits === "number") p.push(`repo ${f.repo_commits} commits by ${f.repo_authors ?? "?"} author(s)`);
      if (typeof f.project_contracts_n === "number") p.push(`${f.project_contracts_n} project contract(s)`);
      if (f.domain_reregistered === true) p.push("domain was re-registered");
      return p.join(", ");
    }
  }
  return "";
}
