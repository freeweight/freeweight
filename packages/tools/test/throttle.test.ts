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
