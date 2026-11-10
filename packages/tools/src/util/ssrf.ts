import { readUpTo, type Run } from "./http.js";

/**
 * Guarded fetch for user-supplied URLs: https only, default port, no credentials, no IP literals, no internal names,
 * DNS (over HTTPS) must resolve to public addresses only, manual redirects (max 3, each re-checked), size + time caps.
 */

export class BlockedUrl extends Error {}

const BAD_SUFFIX = [".localhost", ".local", ".internal", ".lan", ".home", ".corp", ".intranet", ".arpa", ".test", ".invalid", ".example", ".onion", ".localdomain", ".home.arpa"];

export function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = p as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

export function ipv6Private(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::" || s === "::1") return true;
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return ipv4Private(mapped[1]!);
  if (/^::ffff:/.test(s) || /^64:ff9b:/.test(s)) return true;
  const first = parseInt(s.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (s.startsWith("2001:db8") || s.startsWith("100::") || s.startsWith("2001:10:") || s.startsWith("2002:")) return true;
  return false;
}

/** Static checks; throws BlockedUrl. Returns the normalized URL. */
export function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new BlockedUrl("not a valid URL");
  }
  if (u.protocol !== "https:") throw new BlockedUrl("only https URLs are fetched");
  if (u.username || u.password) throw new BlockedUrl("URLs with credentials are not fetched");
  if (u.port && u.port !== "443") throw new BlockedUrl("non-default ports are not fetched");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.length > 253) throw new BlockedUrl("bad host");
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[") || host.includes(":")) throw new BlockedUrl("IP-address URLs are not fetched");
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) throw new BlockedUrl("numeric hosts are not fetched");
  if (!host.includes(".")) throw new BlockedUrl("single-label hosts are not fetched");
  if (host === "localhost" || BAD_SUFFIX.some((s) => host.endsWith(s))) throw new BlockedUrl("internal host names are not fetched");
  if (!/^[a-z0-9.-]+$/.test(host)) throw new BlockedUrl("host must be ASCII (punycode)");
  u.hostname = host;
  u.hash = "";
  return u;
}

/** Resolve A + AAAA over DNS-over-HTTPS; reject when any answer is private/reserved or nothing resolves. */
export async function checkDns(run: Run, host: string): Promise<void> {
  const q = async (type: "A" | "AAAA") => {
    const j = await run.json<{ Status: number; Answer?: { type: number; data: string }[] }>(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      source: "dns",
      ttl: 300,
      timeoutMs: 4000,
      headers: { accept: "application/dns-json" },
      public: false,
    });
    return (j.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
  };
  let ips: string[];
  try {
    const [a, aaaa] = await Promise.all([q("A"), q("AAAA").catch(() => [] as string[])]);
    ips = [...a, ...aaaa];
  } catch {
    throw new BlockedUrl("DNS check failed");
  }
  if (ips.length === 0) throw new BlockedUrl("host does not resolve");
  for (const ip of ips) {
    if (ip.includes(":") ? ipv6Private(ip) : ipv4Private(ip)) throw new BlockedUrl("host resolves to a private or reserved address");
  }
}

export type SafePage = { url: string; final_url: string; status: number; content_type: string; body: string; redirects: number; truncated: boolean };

/** Fetch a user-supplied URL with every guard on. */
export async function safeFetch(run: Run, raw: string, o: { maxBytes?: number; timeoutMs?: number; accept?: string } = {}): Promise<SafePage> {
  let u = checkUrl(raw);
  const start = u.toString();
  const maxBytes = o.maxBytes ?? 1_500_000;
  for (let hop = 0; hop <= 3; hop++) {
    await checkDns(run, u.hostname);
    const left = run.remaining();
    if (left < 800) throw new BlockedUrl("time budget exhausted");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), Math.min(o.timeoutMs ?? 7000, left - 300));
    let res: Response;
    try {
      res = await run.ctx.fetch(u.toString(), {
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": "Mozilla/5.0 (compatible; freeweight-tools/0.1; +read-only)", accept: o.accept ?? "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new BlockedUrl(ac.signal.aborted ? "timeout" : `fetch failed (${e instanceof Error ? e.message.slice(0, 60) : "error"})`);
    }
    if (res.status >= 300 && res.status < 400) {
      clearTimeout(timer);
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!loc) throw new BlockedUrl("redirect without location");
      u = checkUrl(new URL(loc, u).toString());
      continue;
    }
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !/text\/|json|xml|javascript/i.test(ct)) {
      clearTimeout(timer);
      await res.body?.cancel().catch(() => undefined);
      throw new BlockedUrl(`unsupported content type ${ct.slice(0, 40)}`);
    }
    let body = "";
    let truncated = false;
    try {
      ({ text: body, truncated } = await readUpTo(res, maxBytes));
    } catch {
      throw new BlockedUrl("read failed");
    } finally {
      clearTimeout(timer);
    }
    run.sources.add(`site: ${u.origin}`);
    return { url: start, final_url: u.toString(), status: res.status, content_type: ct, body, redirects: hop, truncated };
  }
  throw new BlockedUrl("too many redirects");
}
