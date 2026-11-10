import type { Run } from "../util/http.js";

/** Tools the Freeweight index can enrich (Contract 4: GET {FACTS_URL}/v1/{tool}?token=0x…). */
export const ENRICHED_TOOLS = new Set(["token_overview", "safety_check", "holders", "dev_history", "official_ca", "project_check"]);

/**
 * Ask the private index for extra facts. Silent on every failure: absent config, timeout, non-200, bad JSON.
 * Never records the origin anywhere in the output.
 */
export async function fetchEnrichment(run: Run, tool: string, token: string): Promise<unknown> {
  const { FACTS_URL, FACTS_KEY } = run.ctx.env;
  if (!FACTS_URL || !FACTS_KEY || !ENRICHED_TOOLS.has(tool)) return undefined;
  const base = FACTS_URL.replace(/\/+$/, "");
  const url = `${base}/v1/${tool}?token=${encodeURIComponent(token.toLowerCase())}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), Math.max(500, Math.min(6000, run.remaining() - 500)));
  try {
    const res = await run.ctx.fetch(url, { headers: { "X-FW-Facts-Key": FACTS_KEY, accept: "application/json" }, signal: ac.signal });
    if (!res.ok) return undefined;
    const txt = await res.text();
    if (txt.length > 200_000) return undefined;
    const j = JSON.parse(txt) as unknown;
    if (j === null || typeof j !== "object") return undefined;
    return scrub(j);
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

/** Drop any field that would reveal where the enrichment came from. */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^(origin|host|source_url|upstream|_debug|debug)$/i.test(k)) continue;
      out[k] = scrub(val);
    }
    return out;
  }
  return v;
}
