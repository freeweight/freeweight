/**
 * Record/replay of outbound HTTP for tool tests. A fixture is { recorded_at, entries: [{ key, status, headers, body }] }.
 * The key is METHOD + URL + body with JSON-RPC ids removed, so replays match regardless of id counters.
 */
import { clearMemCache } from "../src/util/http.js";
import { resetExplorerCircuit } from "../src/sources/explorer.js";

export type Entry = { key: string; status: number; headers: Record<string, string>; body: string };
export type Fixture = { recorded_at: number; note?: string; entries: Entry[] };

function stripIds(body: string): string {
  try {
    const j = JSON.parse(body) as unknown;
    const strip = (m: unknown) => {
      if (m && typeof m === "object" && "jsonrpc" in (m as object)) {
        const { id: _id, ...rest } = m as Record<string, unknown>;
        return rest;
      }
      return m;
    };
    return JSON.stringify(Array.isArray(j) ? j.map(strip) : strip(j));
  } catch {
    return body;
  }
}

export function requestKey(url: string, init?: RequestInit): string {
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? stripIds(init.body) : "";
  return `${method} ${url}${body ? " " + body : ""}`;
}

/** Re-attach the caller's JSON-RPC ids to a recorded response. */
function withIds(reqBody: string | undefined, resBody: string): string {
  if (!reqBody) return resBody;
  try {
    const req = JSON.parse(reqBody) as unknown;
    const res = JSON.parse(resBody) as unknown;
    if (Array.isArray(req) && Array.isArray(res)) {
      return JSON.stringify(res.map((r, i) => ({ ...(r as object), id: (req[i] as { id?: unknown })?.id })));
    }
    if (!Array.isArray(req) && req && typeof req === "object" && "id" in req && res && typeof res === "object" && !Array.isArray(res)) {
      return JSON.stringify({ ...(res as object), id: (req as { id: unknown }).id });
    }
  } catch {
    /* not JSON */
  }
  return resBody;
}

/** Normalize a recorded batch response to request order (servers may reorder). */
function orderBatch(reqBody: string | undefined, resBody: string): string {
  try {
    const req = JSON.parse(reqBody ?? "") as { id: unknown }[];
    const res = JSON.parse(resBody) as { id: unknown }[];
    if (!Array.isArray(req) || !Array.isArray(res)) return resBody;
    const by = new Map(res.map((r) => [r.id, r]));
    return JSON.stringify(req.map((q) => by.get(q.id) ?? { jsonrpc: "2.0", id: q.id, error: { code: -32603, message: "missing" } }));
  } catch {
    return resBody;
  }
}

export function resetState(): void {
  clearMemCache();
  resetExplorerCircuit();
}

export function recorder(real: typeof fetch): { fetch: typeof fetch; entries: Entry[] } {
  const entries: Entry[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const res = await real(url, init);
    const body = await res.text();
    const headers: Record<string, string> = {};
    for (const h of ["content-type", "location"]) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    const reqBody = typeof init?.body === "string" ? init.body : undefined;
    entries.push({ key: requestKey(url, init), status: res.status, headers, body: Array.isArray(safeParse(reqBody)) ? orderBatch(reqBody, body) : body });
    return new Response(body, { status: res.status, headers });
  }) as typeof fetch;
  return { fetch: f, entries };
}

function safeParse(s: string | undefined): unknown {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}

export function replayer(fx: Fixture): { fetch: typeof fetch; misses: string[] } {
  const misses: string[] = [];
  const byKey = new Map<string, Entry[]>();
  for (const e of fx.entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
  const used = new Map<string, number>();
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const key = requestKey(url, init);
    const list = byKey.get(key);
    if (!list?.length) {
      misses.push(key.slice(0, 300));
      return new Response(JSON.stringify({ error: "fixture missing" }), { status: 599 });
    }
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);
    const e = list[Math.min(n, list.length - 1)]!;
    const reqBody = typeof init?.body === "string" ? init.body : undefined;
    const status = e.status === 304 ? 200 : e.status;
    return new Response(status === 204 || (status >= 300 && status < 400 && !e.body) ? null : withIds(reqBody, e.body), { status, headers: e.headers });
  }) as typeof fetch;
  return { fetch: f, misses };
}
