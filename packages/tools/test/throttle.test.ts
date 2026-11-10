/** Behaviour when public sources throttle (shared egress): fallbacks and honest gap text. Fake network only. */
import { describe, expect, it } from "vitest";
import { runTool } from "../src/index.js";
import { resolveChain } from "../src/chains.js";
import { Run } from "../src/util/http.js";
import { tokenPairs } from "../src/sources/dexscreener.js";
import { resetState } from "./harness.js";
import { fakeFetch, json } from "./mock.js";

const TOKEN = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed"; // a well-known Base token
const POOL = "0xc9034c3e7f58003e6ae0c8438e7c8f4598d5acaa";
const WETH = "0x4200000000000000000000000000000000000006";

const gtPools = {
  data: [
    {
      id: `base_${POOL}`,
      type: "pool",
      attributes: {
        address: POOL,
        name: "TKN / WETH 0.3%",
        base_token_price_usd: "0.0008",
        base_token_price_quote_token: "0.0000004",
        reserve_in_usd: "230000",
        pool_created_at: "2024-01-07T19:30:45Z",
        fdv_usd: "29000000",
        market_cap_usd: "28000000",
        volume_usd: { h24: "360000" },
        price_change_percentage: { h1: "0.5", h24: "-1.2" },
        transactions: { h24: { buys: 2000, sells: 2500 } },
      },
      relationships: { base_token: { data: { id: `base_${TOKEN}` } }, quote_token: { data: { id: `base_${WETH}` } }, dex: { data: { id: "uniswap_v3" } } },
    },
    {
      id: `base_0x${"ab".repeat(32)}`,
      type: "pool",
      attributes: { address: `0x${"ab".repeat(32)}`, reserve_in_usd: "500" },
      relationships: { base_token: { data: { id: `base_${TOKEN}` } }, quote_token: { data: { id: `base_${"0x" + "0".repeat(40)}` } }, dex: { data: { id: "some-v2-dex" } } },
    },
  ],
  included: [
    { id: `base_${TOKEN}`, type: "token", attributes: { symbol: "TKN", name: "Token" } },
    { id: `base_${WETH}`, type: "token", attributes: { symbol: "WETH", name: "Wrapped Ether" } },
  ],
};

const throttled = (url: string) => (url.includes("api.dexscreener.com") ? new Response('{"error":"rate limited"}', { status: 429 }) : null);
const gecko = (url: string) => (url.startsWith("https://api.geckoterminal.com/api/v2/networks/base/tokens/") ? json(gtPools) : null);

describe("pool lookup falls back to GeckoTerminal when DexScreener is throttled", () => {
  it("maps GeckoTerminal pools to the pair shape the tools read", async () => {
    resetState();
    const run = new Run({ env: {}, fetch: fakeFetch([throttled, gecko]) });
    const pairs = await tokenPairs(run, resolveChain("base")!, TOKEN);
    expect(pairs).toHaveLength(2);
    const p = pairs[0]!;
    expect(p).toMatchObject({ pairAddress: POOL, dexId: "uniswap_v3", labels: ["v3"], priceNative: "0.0000004", liquidity: { usd: 230000 }, source: "geckoterminal" });
    expect(p.baseToken).toEqual({ address: TOKEN, name: "Token", symbol: "TKN" });
    expect(p.quoteToken.address).toBe(WETH);
    expect(p.txns).toEqual({ h24: { buys: 2000, sells: 2500 } });
    // a 32-byte pool id is a v4 pool whatever the dex is called
    expect(pairs[1]!.labels).toEqual(["v4"]);
    expect(run.notes.join(" ")).toMatch(/DexScreener unavailable .*GeckoTerminal/);
  });
  it("token_overview still prices the token and names the source", async () => {
    resetState();
    const r = await runTool("token_overview", { chain: "base", token: TOKEN }, { env: { RPC_URLS: { base: "https://rpc.example.org" } }, fetch: fakeFetch([throttled, gecko]) });
    expect(r.data.price_usd).toBe(0.0008);
    expect(r.sources.some((s) => s.startsWith("geckoterminal"))).toBe(true);
  });
  it("an empty DexScreener answer is not overridden", async () => {
    resetState();
    let gtCalls = 0;
    const f = fakeFetch([(url) => (url.includes("api.dexscreener.com") ? json([]) : null), (url) => (url.includes("geckoterminal") ? (gtCalls++, json(gtPools)) : null)]);
    expect(await tokenPairs(new Run({ env: {}, fetch: f }), resolveChain("base")!, TOKEN)).toEqual([]);
    expect(gtCalls).toBe(0);
  });
  it("when both are throttled the DexScreener error surfaces and the fallback failure is noted", async () => {
    resetState();
    const run = new Run({ env: {}, fetch: fakeFetch([throttled, (url) => (url.includes("geckoterminal") ? new Response("{}", { status: 429 }) : null)]) });
    await expect(tokenPairs(run, resolveChain("base")!, TOKEN)).rejects.toThrow(/429/);
    expect(run.notes.join(" ")).toMatch(/GeckoTerminal fallback unavailable/);
  });
});

// ------------------------------------------------------------------ safety_check: pool named by the index
import { encodeAbiParameters } from "viem";
import { RPC, rpcRoute, word } from "./mock.js";

const RH_TOKEN = "0x" + "7e".repeat(20);
const RH_POOL = "0x" + "9a".repeat(20);
const RH_WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const FACTS = "https://facts.example.org";
const OUT = [{ type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }] as const;

function rhNet(venue: { main_venue: string; main_venue_type: string } | null, seen: string[] = []) {
  return fakeFetch([
    (url) => (url.includes("api.dexscreener.com") || url.includes("geckoterminal") ? new Response('{"error":"rate"}', { status: 429 }) : null),
    (url) =>
      url.startsWith(`${FACTS}/v1/token_overview`)
        ? json(venue ? { found: true, as_of: 1, token: RH_TOKEN, data: { ...venue, launched_at: 1_700_000_000 } } : { found: false, data: null })
        : url.startsWith(FACTS)
          ? json({ found: false, data: null })
          : null,
    (url) => (url.includes("gopluslabs") ? json({ code: 1, message: "OK", result: {} }) : null),
    rpcRoute((method, params) => {
      const p = params as [{ to?: string; data?: string } | string, string, unknown?];
      if (method === "eth_getCode") return "0x6080";
      if (method === "eth_getStorageAt") return word(0n);
      if (method === "eth_blockNumber") return "0x100";
      if (method === "eth_getLogs") return [];
      if (method === "eth_call") {
        const c = p[0] as { to: string; data: string };
        if (p[2]) {
          seen.push(c.to);
          return encodeAbiParameters(OUT, [0, 10n ** 21n, 98n * 10n ** 13n, "0x"]); // ~0.00098 of 0.0009 back
        }
        if (c.to === RH_POOL && c.data.startsWith("0x0dfe1681")) return word(BigInt(RH_TOKEN));
        if (c.to === RH_POOL && c.data.startsWith("0xd21220a7")) return word(BigInt(RH_WETH));
        if (c.data.startsWith("0x313ce567")) return word(18n);
        if (c.data.startsWith("0x8da5cb5b")) throw { code: 3, message: "execution reverted" };
        return "0x";
      }
      return null;
    }),
  ]);
}
const rhEnv = { FACTS_URL: FACTS, FACTS_KEY: "k", RPC_URLS: { "4663": RPC } };

describe("safety_check when no public source lists a pool", () => {
  it("tests the pool the Freeweight index names on Robinhood Chain, and says so", async () => {
    resetState();
    const seen: string[] = [];
    const r = await runTool("safety_check", { token: RH_TOKEN }, { env: rhEnv, fetch: rhNet({ main_venue: RH_POOL, main_venue_type: "v3" }, seen) });
    const s = r.data.sell_simulation as { method: string; pool_source: string; pool_kind: string };
    expect(s.method).toBe("fresh_wallet_round_trip");
    expect(s.pool_source).toBe("freeweight_index");
    expect(r.summary).toMatch(/uniswap v3 \(pool named by the Freeweight index\)/);
    expect(seen.length).toBe(1);
  });
  it("reports a bonding-curve venue instead of simulating it", async () => {
    resetState();
    const r = await runTool("safety_check", { token: RH_TOKEN }, { env: rhEnv, fetch: rhNet({ main_venue: "0x" + "cc".repeat(20), main_venue_type: "curve" }) });
    expect(r.summary).toMatch(/sell not simulated \(the main venue is a bonding curve \(named by the Freeweight index\); bonding curves are not simulated\)/);
  });
  it("says the pool lookup was throttled when that is what happened", async () => {
    resetState();
    const r = await runTool("safety_check", { token: RH_TOKEN }, { env: rhEnv, fetch: rhNet(null) });
    expect(r.summary).toMatch(/sell not simulated \(the pool lookup was throttled \(HTTP 429\) and no other source named a pool\)/);
    expect(r.partial).toBe(true);
  });
  it("says no pool is listed when the sources answered with none", async () => {
    resetState();
    const f = fakeFetch([(url) => (url.includes("api.dexscreener.com") ? json([]) : null), rhNet(null)]);
    const r = await runTool("safety_check", { token: RH_TOKEN }, { env: rhEnv, fetch: f });
    expect(r.summary).toMatch(/sell not simulated \(no pool is listed \(DexScreener and the Freeweight index name none\)\)/);
  });
});
