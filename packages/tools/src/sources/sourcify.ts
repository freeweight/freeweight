import type { Chain } from "../chains.js";
import { HttpError, type Run } from "../util/http.js";

const BASE = "https://sourcify.dev/server";

export type SourcifyContract = {
  match: string | null;
  name: string | null;
  compiler: string | null;
  language: string | null;
  files: { path: string; content: string }[];
  abi: unknown[] | null;
  proxy: { isProxy?: boolean; proxyType?: string; implementations?: { address: string; name?: string }[] } | null;
};

/** Verified contract from Sourcify, or null when not verified there (404). */
export async function sourcify(run: Run, chain: Chain, address: string, full: boolean): Promise<SourcifyContract | null> {
  const url = `${BASE}/v2/contract/${chain.id}/${address}${full ? "?fields=sources,abi,compilation,proxyResolution" : ""}`;
  let j: Record<string, unknown>;
  try {
    j = await run.json<Record<string, unknown>>(url, { source: "sourcify", ttl: 3600, timeoutMs: 8000, maxBytes: 8_000_000 });
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
  const comp = (j.compilation ?? {}) as Record<string, unknown>;
  const sources = (j.sources ?? {}) as Record<string, { content?: string }>;
  return {
    match: (j.match as string) ?? (j.runtimeMatch as string) ?? null,
    name: (comp.name as string) ?? null,
    compiler: (comp.compilerVersion as string) ?? null,
    language: (comp.language as string) ?? null,
    files: Object.entries(sources).map(([path, s]) => ({ path, content: s.content ?? "" })),
    abi: Array.isArray(j.abi) ? (j.abi as unknown[]) : null,
    proxy: (j.proxyResolution as SourcifyContract["proxy"]) ?? null,
  };
}
