import { readUpTo, type Run } from "./http.js";

/**
 * Guarded fetch for user-supplied URLs: https only, default port, no credentials, no IP literals, no internal names,
 * DNS (over HTTPS) must resolve to public addresses only, manual redirects (max 3, each re-checked), size + time caps.
 *
 * Defence in depth: on Cloudflare Workers the runtime resolves the name again when it connects, and Workers egress
 * cannot reach private address ranges, so the DNS check there mainly protects against Cloudflare-internal names and
 * keeps behaviour honest on other hosts. Verdicts are never cached: a record flipped after a clean lookup is caught on
 * the next request. On a Node host the check-then-connect gap remains (a rebinding record with TTL 0 can still win the
 * race); such a host should pin the connection to the checked address.
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

/** Parse an IPv6 literal into 8 hextets (handles "::" and an embedded dotted IPv4 tail); null when malformed. */
export function parseIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const b = v4.slice(1).map(Number);
    if (b.some((x) => x > 255)) return null;
    tail = [(b[0]! << 8) | b[1]!, (b[2]! << 8) | b[3]!];
    s = s.slice(0, v4.index) + "0:0";
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const part = (x: string) => (x === "" ? [] : x.split(":"));
  const head = part(halves[0]!);
  const back = halves.length === 2 ? part(halves[1]!) : [];
  const fill = 8 - head.length - back.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...back];
  if (words.length !== 8 || words.some((w) => !/^[0-9a-f]{1,4}$/.test(w))) return null;
  const out = words.map((w) => parseInt(w, 16));
  if (tail.length) {
    out[6] = tail[0]!;
    out[7] = tail[1]!;
  }
  return out;
}

export function ipv6Private(ip: string): boolean {
  const h = parseIpv6(ip);
  if (!h) return true; // unparseable: refuse
  const v4of = (a: number, b: number) => `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  const zero = (from: number, to: number) => h.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && h[7] === 1) return true; // ::1
  if (zero(0, 6)) return true; // ::a.b.c.d IPv4-compatible (deprecated): never a public destination
  if (zero(0, 5) && h[5] === 0xffff) return true; // ::ffff:0:0/96 IPv4-mapped: refuse outright
  if (zero(0, 4) && h[4] === 0xffff && h[5] === 0) return true; // ::ffff:0:a.b.c.d (SIIT)
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return ipv4Private(v4of(h[6]!, h[7]!)); // 64:ff9b::/96 NAT64
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (h[0] === 0x100 && zero(1, 4)) return true; // 100::/64 discard
  if (h[0] === 0x2001 && h[1]! < 0x200) return true; // 2001::/23 IETF special (Teredo, ORCHID, benchmarking ...)
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  if (h[0] === 0x2002) return true; // 6to4: embeds an IPv4 destination
  if (h[0] === 0x3fff && h[1]! < 0x1000) return true; // 3fff::/20 documentation
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((h[0]! & 0xffc0) === 0xfec0) return true; // fec0::/10 site local (deprecated)
  if ((h[0]! & 0xff00) === 0xff00) return true; // multicast
  if ((h[0]! & 0xe000) !== 0x2000) return true; // outside 2000::/3 global unicast
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

/**
 * Resolve A + AAAA over DNS-over-HTTPS; reject when any answer is private/reserved, nothing resolves, or either lookup
 * fails (fail closed). Never cached: see the note at the top of this file.
 */
export async function checkDns(run: Run, host: string): Promise<void> {
  const q = async (type: "A" | "AAAA") => {
    const j = await run.json<{ Status: number; Answer?: { type: number; data: string }[] }>(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, {
      source: "dns",
      ttl: 0,
      timeoutMs: 4000,
      retries: 0,
      headers: { accept: "application/dns-json" },
      public: false,
    });
    if (j.Status !== 0 && j.Status !== 3) throw new BlockedUrl(`DNS ${type} lookup failed (status ${j.Status})`);
    return (j.Answer ?? []).filter((a) => a.type === 1 || a.type === 28).map((a) => a.data);
  };
  let ips: string[];
  try {
    const [a, aaaa] = await Promise.all([q("A"), q("AAAA")]);
    ips = [...a, ...aaaa];
  } catch (e) {
    throw new BlockedUrl(e instanceof BlockedUrl ? e.message : "DNS check failed");
  }
  if (ips.length === 0) throw new BlockedUrl("host does not resolve");
  for (const ip of ips) {
    if (ip.includes(":") ? ipv6Private(ip) : ipv4Private(ip)) throw new BlockedUrl("host resolves to a private or reserved address");
  }
}

export type SafePage = { url: string; final_url: string; status: number; content_type: string; body: string; redirects: number; truncated: boolean };

/** Fetch a user-supplied URL with every guard on. */
export async function safeFetch(run: Run, raw: string, o: { maxBytes?: number; timeoutMs?: number; accept?: string; maxRedirects?: number } = {}): Promise<SafePage> {
  let u = checkUrl(raw);
  const start = u.toString();
  const maxBytes = o.maxBytes ?? 1_500_000;
  const maxRedirects = o.maxRedirects ?? 3;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await checkDns(run, u.hostname);
    try {
      run.spend();
    } catch {
      throw new BlockedUrl("request budget exhausted");
    }
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
