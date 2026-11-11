/**
 * Live smoke: runs every tool against real tokens and prints the summaries.
 *   npm run smoke                 # all tools, default tokens
 *   npm run smoke -- holders      # one tool
 * Env: FACTS_URL / FACTS_KEY / EXA_KEY / RPC_URLS_JSON are passed through when set.
 */
import { runTool, tools } from "../src/index.js";
import type { ToolCtx } from "../src/index.js";

const env: ToolCtx["env"] = {
  FACTS_URL: process.env.FACTS_URL,
  FACTS_KEY: process.env.FACTS_KEY,
  FACTS_ACCESS_ID: process.env.FACTS_ACCESS_ID,
  FACTS_ACCESS_SECRET: process.env.FACTS_ACCESS_SECRET,
  EXA_KEY: process.env.EXA_KEY,
  RPC_URLS: process.env.RPC_URLS_JSON ? (JSON.parse(process.env.RPC_URLS_JSON) as Record<string, string>) : undefined,
};
const ctx: ToolCtx = { env, fetch: globalThis.fetch.bind(globalThis) };

type Target = { chain: string; token: string; label: string };

async function liquidRobinhoodToken(): Promise<Target> {
  const queries = ["robinhood", "WETH robinhood", "hood"];
  let best: { addr: string; sym: string; liq: number } | null = null;
  for (const q of queries) {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    const j = (await r.json()) as { pairs?: { chainId: string; baseToken: { address: string; symbol: string }; liquidity?: { usd?: number } }[] };
    for (const p of j.pairs ?? []) {
      if (p.chainId !== "robinhood") continue;
      const l = p.liquidity?.usd ?? 0;
      if (/^W?ETH$|^USD/i.test(p.baseToken.symbol) || /Robinhood Token/i.test((p.baseToken as { name?: string }).name ?? "")) continue;
      if (!best || l > best.liq) best = { addr: p.baseToken.address.toLowerCase(), sym: p.baseToken.symbol, liq: l };
    }
  }
  if (!best) throw new Error("no liquid Robinhood Chain token found via DexScreener search");
  return { chain: "robinhood", token: best.addr, label: `$${best.sym} (RH, liq ~$${Math.round(best.liq)})` };
}

/** A recently profiled Robinhood Chain token (young, usually a launchpad token). */
async function youngRobinhoodToken(): Promise<Target | null> {
  const r = await fetch("https://api.dexscreener.com/token-profiles/latest/v1");
  const j = (await r.json()) as { chainId: string; tokenAddress: string }[];
  const t = j.find((x) => x.chainId === "robinhood");
  return t ? { chain: "robinhood", token: t.tokenAddress.toLowerCase(), label: "young RH token (latest DexScreener profile)" } : null;
}

function argsFor(tool: string, t: Target): Record<string, unknown> {
  switch (tool) {
    case "web_search":
      return { query: `${t.label.split(" ")[0]} token` };
    case "market_data":
      return { chain: t.chain, token: t.token, majors: ["ethereum", "bitcoin"] };
    case "new_launches":
      return { chain: t.chain, limit: 5 };
    case "chain_read":
      return { chain: t.chain, op: "call", to: t.token, signature: "function totalSupply() view returns (uint256)" };
    default:
      return { chain: t.chain, token: t.token };
  }
}

async function main() {
  const only = process.argv[2];
  const targets: Target[] = [
    { chain: "ethereum", token: "0x6982508145454ce325ddbe47a25d4ec3d2311933", label: "$PEPE (Ethereum)" },
    { chain: "base", token: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed", label: "$DEGEN (Base)" },
    await liquidRobinhoodToken(),
  ];
  const young = await youngRobinhoodToken().catch(() => null);
  if (young) targets.push(young);
  if (process.env.SMOKE_EXTRA) {
    for (const s of process.env.SMOKE_EXTRA.split(";")) {
      const [chain, token, label] = s.split(",");
      if (chain && token) targets.push({ chain, token, label: label ?? `${chain} ${token}` });
    }
  }
  for (const t of targets) {
    console.log(`\n=== ${t.label} ${t.token}`);
    for (const tool of tools) {
      if (only && tool.name !== only) continue;
      const t0 = Date.now();
      const r = await runTool(tool.name, argsFor(tool.name, t), ctx);
      const ms = Date.now() - t0;
      console.log(`- ${tool.name} [${r.ok ? "ok" : "FAIL"}${r.partial ? ", partial" : ""}, ${ms} ms${r.enriched ? ", enriched" : ""}] ${r.summary}`);
      if (process.env.SMOKE_VERBOSE) console.log(JSON.stringify(r, null, 1).slice(0, 4000));
      else if (r.notes.length) console.log(`    notes: ${r.notes.join(" | ").slice(0, 400)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
