import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, fmtAge, fmtUsd, round, short, str, TOKEN_PROP } from "../util/args.js";
import { soft, type Run } from "../util/http.js";
import { erc20Meta } from "../util/rpc.js";
import { BlockedUrl, safeFetch } from "../util/ssrf.js";
import { analyzeHtml, snippetAround } from "../util/page.js";
import { searchPairs, tokenPairs, websitesOf, type DsPair } from "../sources/dexscreener.js";

const SOCIAL_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|discord\.(gg|com)|github\.com|farcaster\.xyz|warpcast\.com|medium\.com|youtube\.com|tiktok\.com|instagram\.com|linktr\.ee|reddit\.com|facebook\.com|dexscreener\.com|coingecko\.com|coinmarketcap\.com)$/i;

export function isSocialHost(u: string): boolean {
  try {
    return SOCIAL_HOSTS.test(new URL(u).hostname);
  } catch {
    return true;
  }
}

type SiteCheck = {
  url: string;
  final_url?: string;
  fetched: boolean;
  error?: string;
  ca_in_html: boolean;
  ca_in_scripts: boolean;
  scripts_checked: number;
  other_addresses_on_page: string[];
  snippet_untrusted?: string | null;
};

async function checkSite(run: Run, url: string, token: string): Promise<SiteCheck> {
  const out: SiteCheck = { url, fetched: false, ca_in_html: false, ca_in_scripts: false, scripts_checked: 0, other_addresses_on_page: [] };
  try {
    const page = await safeFetch(run, url);
    out.fetched = true;
    out.final_url = page.final_url;
    const lower = page.body.toLowerCase();
    out.ca_in_html = lower.includes(token);
    const facts = analyzeHtml(page.body, page.final_url);
    out.other_addresses_on_page = facts.addresses_found.filter((a) => a !== token).slice(0, 5);
    if (out.ca_in_html) out.snippet_untrusted = snippetAround(page.body, token);
    if (!out.ca_in_html) {
      // Client-rendered sites keep the CA in their JS bundles.
      for (const src of facts.script_srcs_same_origin.slice(0, 4)) {
        if (run.remaining() < 3000) break;
        try {
          const js = await safeFetch(run, src, { maxBytes: 2_500_000, accept: "*/*" });
          out.scripts_checked++;
          const jl = js.body.toLowerCase();
          if (jl.includes(token)) {
            out.ca_in_scripts = true;
            break;
          }
          for (const m of js.body.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)) {
            const a = m[0].toLowerCase();
            if (a !== token && !out.other_addresses_on_page.includes(a) && out.other_addresses_on_page.length < 8) out.other_addresses_on_page.push(a);
          }
        } catch {
          /* skip a bundle that fails */
        }
      }
    }
  } catch (e) {
    out.error = e instanceof BlockedUrl ? `not fetched: ${e.message}` : `fetch failed: ${e instanceof Error ? e.message.slice(0, 80) : "error"}`;
  }
  return out;
}

export const officialCa = defineTool({
  name: "official_ca",
  title: "Official contract check",
  description:
    "Does the project's own website show this contract address? Fetches the site (given, or from DexScreener metadata) and its same-origin JS bundles " +
    "and searches for the address. Also lists other tokens with the same symbol on the chain, with age and liquidity. " +
    "Age and depth never decide which token is real: 'first launch' is not proof.",
  inputSchema: {
    type: "object",
    properties: { chain: CHAIN_PROP, token: TOKEN_PROP, url: { type: "string", description: "Project website (https). Optional: taken from DexScreener when omitted." } },
    required: ["token"],
    additionalProperties: false,
  },
  enrich: (a) => ({ chain: chainArg(a), token: addr(a, "token")! }),
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token")!;
    const urlArg = str(args, "url", 2000);
    const [meta, pairs] = await Promise.all([soft(run, "rpc", erc20Meta(run, chain, token)), soft(run, "dexscreener", tokenPairs(run, chain, token))]);
    const symbol = meta?.symbol ?? pairs?.find((p) => p.baseToken.address.toLowerCase() === token)?.baseToken.symbol ?? null;
    const sites = urlArg ? [urlArg] : websitesOf(pairs ?? []).filter((u) => !isSocialHost(u)).slice(0, 2);

    const [siteChecks, same] = await Promise.all([
      Promise.all(sites.map((s) => checkSite(run, s, token))),
      symbol ? soft(run, "dexscreener search", searchPairs(run, symbol)) : Promise.resolve([] as DsPair[]),
    ]);

    // Same-symbol tokens on this chain.
    const bySym = new Map<string, { address: string; name: string; liquidity_usd: number; first_pool_at: number | null; fdv_usd: number | null }>();
    const all = [...(same ?? []), ...(pairs ?? [])];
    for (const p of all) {
      if (p.chainId !== chain.dexscreener) continue;
      if (!symbol || p.baseToken.symbol.toLowerCase() !== symbol.toLowerCase()) continue;
      const a = p.baseToken.address.toLowerCase();
      const cur = bySym.get(a) ?? { address: a, name: p.baseToken.name, liquidity_usd: 0, first_pool_at: null, fdv_usd: null };
      cur.liquidity_usd += p.liquidity?.usd ?? 0;
      if (p.pairCreatedAt && (cur.first_pool_at === null || p.pairCreatedAt < cur.first_pool_at)) cur.first_pool_at = p.pairCreatedAt;
      cur.fdv_usd = Math.max(cur.fdv_usd ?? 0, p.fdv ?? 0) || null;
      bySym.set(a, cur);
    }
    const mine = bySym.get(token) ?? null;
    const others = [...bySym.values()].filter((x) => x.address !== token).sort((a, b) => b.liquidity_usd - a.liquidity_usd);
    const older = others.filter((o) => o.first_pool_at && mine?.first_pool_at && o.first_pool_at < mine.first_pool_at).length;
    const deeper = others.filter((o) => o.liquidity_usd > (mine?.liquidity_usd ?? 0)).length;

    const parts: string[] = [];
    const found = siteChecks.find((s) => s.ca_in_html || s.ca_in_scripts);
    if (!sites.length) parts.push("no website known (pass url to check one)");
    else if (found) parts.push(`CA appears on ${new URL(found.final_url ?? found.url).hostname} (${found.ca_in_html ? "page HTML" : "site JS bundle"})`);
    else {
      const fetched = siteChecks.filter((s) => s.fetched);
      if (fetched.length) {
        const otherAddr = fetched.flatMap((s) => s.other_addresses_on_page);
        parts.push(`CA NOT found on ${fetched.map((s) => new URL(s.final_url ?? s.url).hostname).join(", ")}${otherAddr.length ? ` (site shows other address(es) e.g. ${short(otherAddr[0])})` : ""}`);
      } else parts.push(`site not checked (${siteChecks.map((s) => s.error).join("; ")})`);
    }
    if (symbol) {
      parts.push(
        others.length
          ? `${others.length} other $${symbol} token(s) on ${chain.name}: ${older} older, ${deeper} with more liquidity (largest ${short(others[0]!.address)} ${fmtUsd(others[0]!.liquidity_usd)})`
          : `no other $${symbol} on ${chain.name} in DexScreener search`,
      );
    }
    if (sites.length && !urlArg) run.note("Website came from DexScreener token metadata, which the token's own team (or anyone who paid) set: a copycat can list a real project's site.");
    run.note("Neither age nor liquidity decides which token is official; the project's own channels do.");

    return {
      summary: `$${symbol ?? "?"} ${short(token)} on ${chain.name}: ` + parts.join("; ") + ".",
      data: {
        chain: chain.key,
        chain_id: chain.id,
        token,
        symbol,
        sites: siteChecks,
        ca_on_site: sites.length ? Boolean(found) : null,
        this_token: mine ? { liquidity_usd: round(mine.liquidity_usd), first_pool_at: mine.first_pool_at ? new Date(mine.first_pool_at).toISOString() : null } : null,
        same_symbol_tokens: others.slice(0, 10).map((o) => ({
          address: o.address,
          name: o.name,
          liquidity_usd: round(o.liquidity_usd),
          fdv_usd: round(o.fdv_usd),
          first_pool_at: o.first_pool_at ? new Date(o.first_pool_at).toISOString() : null,
          age: o.first_pool_at ? fmtAge(Date.now() - o.first_pool_at) : null,
          older_than_this: o.first_pool_at && mine?.first_pool_at ? o.first_pool_at < mine.first_pool_at : null,
        })),
        same_symbol_note: "DexScreener search returns a limited set of pairs; tokens without pools are not listed.",
      },
    };
  },
});
