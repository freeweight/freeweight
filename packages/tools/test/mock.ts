// Fake network helpers for regression tests. No real requests leave the process.

export const RPC = "https://rpc.test.invalid-host.xyz";

export type Route = (url: string, init: RequestInit | undefined, body: unknown) => Response | Promise<Response> | null;

export const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

export const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
/** ABI-encode one `string` return value. */
export function abiString(s: string): string {
  const hex = [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  return "0x" + (32n).toString(16).padStart(64, "0") + BigInt(hex.length / 2).toString(16).padStart(64, "0") + padded;
}

/** Generic JSON-RPC responder: `handler(method, params)` returns a result, or throws {code,message} for an RPC error. */
export function rpcRoute(handler: (method: string, params: unknown[]) => unknown): Route {
  return (url, init, body) => {
    if (!url.startsWith(RPC)) return null;
    const one = (m: { id: number; method: string; params: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id: m.id, result: handler(m.method, m.params) };
      } catch (e) {
        const err = e as { code?: number; message?: string; http?: number };
        if (err.http) throw err;
        return { jsonrpc: "2.0", id: m.id, error: { code: err.code ?? -32000, message: err.message ?? "error" } };
      }
    };
    try {
      return json(Array.isArray(body) ? body.map(one) : one(body as { id: number; method: string; params: unknown[] }));
    } catch (e) {
      return new Response("upstream down", { status: (e as { http: number }).http });
    }
  };
}

export function fakeFetch(routes: Route[], log: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    log.push(`${init?.method ?? "GET"} ${url}`);
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    for (const r of routes) {
      const res = await r(url, init, body);
      if (res) return res;
    }
    return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
  }) as typeof fetch;
}

/** DoH answers: host -> { A: [...], AAAA: [...] } ; a function value lets a test change the answer between calls. */
export function dohRoute(answers: (host: string, type: string) => string[] | "fail"): Route {
  return (url) => {
    if (!url.startsWith("https://cloudflare-dns.com/dns-query")) return null;
    const u = new URL(url);
    const host = u.searchParams.get("name")!;
    const type = u.searchParams.get("type")!;
    const a = answers(host, type);
    if (a === "fail") return new Response("servfail", { status: 502 });
    return json({ Status: 0, Answer: a.map((data) => ({ name: host, type: type === "A" ? 1 : 28, TTL: 0, data })) });
  };
}

