import { describe, expect, it } from "vitest";
import { BlockedUrl, checkUrl, ipv4Private, ipv6Private, safeFetch } from "../src/util/ssrf.js";
import { Run } from "../src/util/http.js";

describe("SSRF guard: static checks", () => {
  const bad = [
    "http://example.com",
    "ftp://example.com",
    "https://127.0.0.1/",
    "https://10.0.0.1",
    "https://[::1]/",
    "https://169.254.169.254/latest/meta-data",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://localhost/",
    "https://foo.localhost",
    "https://metadata.google.internal/",
    "https://intranet/",
    "https://user:pw@example.com/",
    "https://example.com:8443/",
    "https://router.lan/",
    "javascript:alert(1)",
  ];
  for (const u of bad) it(`blocks ${u}`, () => expect(() => checkUrl(u)).toThrow(BlockedUrl));
  it("allows a normal https URL and adds https to bare hosts", () => {
    expect(checkUrl("https://Example.COM/a?b=1#frag").toString()).toBe("https://example.com/a?b=1");
    expect(checkUrl("example.org").protocol).toBe("https:");
  });
  it("classifies private ranges", () => {
    for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1"]) expect(ipv4Private(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "104.16.0.1"]) expect(ipv4Private(ip)).toBe(false);
    for (const ip of ["::1", "fc00::1", "fd12::1", "fe80::1", "::ffff:127.0.0.1", "ff02::1", "2001:db8::1"]) expect(ipv6Private(ip)).toBe(true);
    for (const ip of ["2606:4700::1111", "2001:4860:4860::8888"]) expect(ipv6Private(ip)).toBe(false);
  });
});

function dnsAnd(map: Record<string, string[]>, pages: Record<string, Response | (() => Response)>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const u = new URL(String(input));
    if (u.hostname === "cloudflare-dns.com") {
      const name = u.searchParams.get("name")!;
      const type = u.searchParams.get("type");
      const ips = (map[name] ?? []).filter((ip) => (type === "AAAA" ? ip.includes(":") : !ip.includes(":")));
      return new Response(JSON.stringify({ Status: 0, Answer: ips.map((data) => ({ type: type === "AAAA" ? 28 : 1, data })) }), { status: 200 });
    }
    const p = pages[u.toString()];
    if (!p) return new Response("nope", { status: 404 });
    return typeof p === "function" ? p() : p.clone();
  }) as typeof fetch;
}

describe("SSRF guard: DNS and redirects", () => {
  it("refuses hosts that resolve to private addresses (DNS rebinding)", async () => {
    const run = new Run({ env: {}, fetch: dnsAnd({ "evil.example.com": ["127.0.0.1"] }, {}) });
    await expect(safeFetch(run, "https://evil.example.com/")).rejects.toThrow(/private/);
  });
  it("re-checks every redirect hop", async () => {
    const f = dnsAnd(
      { "ok.example.com": ["93.184.216.34"], "inner.example.com": ["10.0.0.5"] },
      { "https://ok.example.com/": () => new Response(null, { status: 302, headers: { location: "https://inner.example.com/admin" } }) },
    );
    await expect(safeFetch(new Run({ env: {}, fetch: f }), "https://ok.example.com/")).rejects.toThrow(/private/);
    const f2 = dnsAnd({ "ok.example.com": ["93.184.216.34"] }, { "https://ok.example.com/": () => new Response(null, { status: 301, headers: { location: "http://ok.example.com/" } }) });
    await expect(safeFetch(new Run({ env: {}, fetch: f2 }), "https://ok.example.com/")).rejects.toThrow(/https/);
  });
  it("caps redirects", async () => {
    const f = dnsAnd({ "loop.example.com": ["93.184.216.34"] }, { "https://loop.example.com/": () => new Response(null, { status: 302, headers: { location: "/" } }) });
    await expect(safeFetch(new Run({ env: {}, fetch: f }), "https://loop.example.com/")).rejects.toThrow(/too many redirects/);
  });
  it("truncates large bodies and refuses binary content", async () => {
    const big = "a".repeat(5000);
    const f = dnsAnd(
      { "ok.example.com": ["93.184.216.34"] },
      {
        "https://ok.example.com/": () => new Response(big, { status: 200, headers: { "content-type": "text/html" } }),
        "https://ok.example.com/x.bin": () => new Response("x", { status: 200, headers: { "content-type": "application/octet-stream" } }),
      },
    );
    const page = await safeFetch(new Run({ env: {}, fetch: f }), "https://ok.example.com/", { maxBytes: 1000 });
    expect(page.body.length).toBe(1000);
    expect(page.truncated).toBe(true);
    await expect(safeFetch(new Run({ env: {}, fetch: f }), "https://ok.example.com/x.bin")).rejects.toThrow(/content type/);
  });
});
