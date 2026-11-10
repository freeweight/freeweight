# @freeweight/tools

Read-only token research tools for EVM chains, built to run inside a Cloudflare Worker (only `fetch`, no Node APIs).
The same ten tools are served three ways:

- **MCP**: `handleMcp(request, ctx)` is a stateless Streamable-HTTP MCP endpoint (JSON responses, no sessions).
- **Chat tool calling**: `openAiToolSpecs()` returns OpenAI-style function specs; `runTool(name, args, ctx)` runs one.
- **Direct**: `tools` is the list of definitions (name, title, description, JSON-schema input, handler).

Nothing here signs or sends a transaction. Simulations use `eth_call`, which changes no state.

## Use

```ts
import { handleMcp, openAiToolSpecs, runTool, type ToolCtx } from "@freeweight/tools";

const ctx: ToolCtx = { env: { RPC_URLS: { "4663": env.RH_RPC } }, fetch, cache: env.TOOLS_KV };
if (url.pathname === "/mcp") return handleMcp(request, ctx);
const result = await runTool("token_overview", { chain: "base", token: "0x…" }, ctx);
```

Connect an MCP client (Claude, Codex, the MCP Inspector) to the `/mcp` URL with the HTTP transport.

### `ctx.env`

| key | effect |
|---|---|
| `RPC_URLS` | Per-chain RPC override, keyed by chain id or name (`"4663"`, `"base"`); a URL or a comma-separated list tried in order. **Set a keyed Robinhood Chain RPC in production**: from Workers' shared egress IPs the public RPC answers 429. |
| `EXA_KEY` | Enables `web_search`. Without it the tool returns `not_configured`. |
| `GITHUB_TOKEN` | Optional read-only token for `project_check` (keyless GitHub is 60 requests/hour per IP). |
| `FACTS_URL`, `FACTS_KEY`, `FACTS_ACCESS_ID`, `FACTS_ACCESS_SECRET` | Optional Freeweight index for Robinhood Chain tokens (see Enrichment). |

`ctx.cache` is optional; any object with KV's `get(key, "text")` / `put(key, value, { expirationTtl })` works.
Without it the package keeps a small in-memory cache per isolate.

## Chains

Every tool takes `chain` as a name or id; the default is Robinhood Chain.

| chain | id | names |
|---|---|---|
| Robinhood Chain | 4663 | `robinhood`, `rh` |
| Ethereum | 1 | `ethereum`, `eth` |
| Base | 8453 | `base` |
| BNB Chain | 56 | `bsc`, `bnb` |
| Arbitrum One | 42161 | `arbitrum`, `arb` |
| OP Mainnet | 10 | `optimism`, `op` |
| Polygon PoS | 137 | `polygon` |

Add a chain in `src/chains.ts` (RPC list, explorers, DexScreener slug, GoPlus id, v4 addresses).

## Result shape

```jsonc
{
  "tool": "holders",
  "ok": true,               // false only for bad input, unknown tool/chain, or a total failure
  "summary": "…",           // short, plain, read this first
  "partial": false,         // true when a source failed or the time budget ran out
  "data": { … },            // tool-specific; amounts in token units, USD where named, addresses lowercase
  "enriched": false,        // true only when Freeweight index facts were merged
  "index": { … },           // the merged index facts (only when enriched)
  "notes": ["…"],           // what was not checked, blind spots, failures
  "sources": ["dexscreener: https://…", "rpc robinhood"],
  "error": { "code": "invalid_input", "message": "…" }   // when ok is false
}
```

Over MCP the same object is the text content (JSON) and `structuredContent`; `isError` mirrors `!ok`.
Each call has a budget of about 15 seconds and returns what it has, marked `partial`, when time runs out.

## Tools

### `token_overview` `{ chain?, token }`
Name, symbol, decimals and total supply from the contract; creator and creation time from an explorer (GoPlus as a
fallback for the creator); USD price, FDV, market cap, liquidity and the main pool from DexScreener. The main pool is
the deepest one; pools under $1k, or under 1% of the deepest and under $25k, are counted as junk and never used for
price (tiny pools print fake wicks). Also lists websites and socials from DexScreener.

### `safety_check` `{ chain?, token }`
Can a buyer sell, and what can the owner do?
- **Sell simulation**: takes a real holder (GoPlus or explorer list, else a recent recipient) and runs an exact-input
  swap of 10% of its balance into the main pool with `eth_call`, injecting a small helper contract at the holder's
  address through a state override (`sol/SellProbe.sol`). Uniswap v2 and v3 style pools and Uniswap v4 (pool key from
  `PositionManager.poolKeys` or the `Initialize` event) are covered; v4 hooks run as in a real sale. For v2 it measures
  the token-level transfer tax. If a swap cannot be simulated it falls back to a holder-to-pool transfer simulation.
- **Static flags**: EIP-1967 / EIP-1167 proxy, `owner()` and whether it is renounced, owner-power functions found in
  the bytecode by a PUSH4 scan (mint, blacklist, pause, trading switch, fee setters, limits, exclusions, upgrade),
  Sourcify verification, and GoPlus token security where GoPlus covers the chain.
- It never says "safe". Blind spots: traps that target certain wallets, sizes or later times; bonding-curve venues;
  front-end tricks. GoPlus does not see Uniswap v4 hook logic.

### `holders` `{ chain?, token, limit? }`
Top holders with % of supply and tags (`pool`, `burn`, `creator`, `contract`), top-10 concentration excluding pools and
burns, the share in DEX pools, burned (0xdead + 0x0) and the creator's share. Sources in order: Blockscout or Routescan
holder list, GoPlus top 10, then a reconstruction from `Transfer` logs for young tokens (the scan is bounded; it reports
`coverage: full` only when the mint is inside the scanned window). Top balances are re-read on-chain.

### `dev_history` `{ chain?, token, dev? }`
Who launched the token: the creator, and when the creator is a factory or launchpad contract, the sender of the mint
transaction. Then the launcher's other direct deployments (explorer) with their DexScreener state, its balance of this
token, and how much it sent out (from logs, young tokens). Tokens launched through a launchpad by the same wallet do not
show as its deployments.

### `official_ca` `{ chain?, token, url? }`
Fetches the project site (given, or the first non-social website from DexScreener) and its same-origin JS bundles and
checks whether the contract address appears; lists other addresses the site shows. Lists other tokens with the same
symbol on the chain with age and liquidity. Age and depth never decide which token is real.

### `project_check` `{ url? | chain? + token }`
Domain age and registrar (RDAP), first Wayback capture (a capture older than the registration means an earlier owner or
a re-registration), what the site ships (title, framework, external script hosts, template and placeholder signals,
links to X / Telegram / GitHub / Discord) and linked GitHub accounts or repos (age, commits seen, fork).

### `web_search` `{ query, num_results?, days? }`
Exa search: titles, URLs, dates and short snippets. Returns `not_configured` without `EXA_KEY`.

### `market_data` `{ chain?, token? | pair?, majors? }`
DexScreener pools for a token (main, other real pools, junk pools flagged) or one pair, with price, liquidity, volume,
buys/sells and price change; USD prices for majors from CoinGecko (`eth`, `btc`, `sol` or CoinGecko ids).

### `chain_read` `{ chain?, op, … }`
Generic read-only access. `op`:
- `call`: `to`, `signature` (human-readable, e.g. `balanceOf(address) returns (uint256)`), `args`, optional `from`, `block`
- `balance`, `nonce`, `code` (`address`), `storage` (`address`, `slot`)
- `tx`, `receipt` (`hash`); `block` (`block`)
- `logs`: `address` (required), `from_block`/`to_block` (at most 10,000 blocks), optional `topics`, optional event
  `signature` to decode.
Only read methods are allowed (`eth_call`, `eth_getLogs`, `eth_getBalance`, …); nothing is ever sent.

### `contract_source` `{ chain?, address, file?, max_chars?, include_abi? }`
Verified source from Sourcify, else a reachable Blockscout explorer. Returns the file list with sizes, the main file
trimmed to `max_chars` (default 40,000), and function/event signatures. Follows EIP-1967 / EIP-1167 proxies to the
implementation when the proxy itself is only a stub.

## What works where (keyless)

| | Ethereum | Base, Arbitrum, OP, Polygon | BNB Chain | Robinhood Chain |
|---|---|---|---|---|
| RPC reads, sell simulation | yes | yes | yes | yes (needs a keyed RPC from Workers) |
| DexScreener, Sourcify, CoinGecko | yes | yes | yes | yes |
| GoPlus | yes | yes | yes | yes (rate-limited from Workers) |
| Explorer: creator, holder list, deployments | Blockscout + Routescan | challenged from servers: GoPlus/log fallbacks | none keyless: fallbacks | challenged: fallbacks + Freeweight index |
| Holder reconstruction from logs | young tokens | young tokens | young tokens | young tokens (wide log ranges on the official RPC) |

"Challenged" means the explorer API sits behind a bot challenge for server traffic (seen from the build host and from
a deployed Worker); the tools detect it, stop asking for ten minutes and use fallbacks.

## Enrichment (Robinhood Chain)

With `FACTS_URL` and `FACTS_KEY` set, the six token tools also ask the Freeweight index
(`GET {FACTS_URL}/v1/{tool}?token=0x…`, header `X-FW-Facts-Key`, plus Cloudflare Access service-token headers when
`FACTS_ACCESS_ID` / `FACTS_ACCESS_SECRET` are set). Only chain 4663, 60 s cache, 1.5 s timeout. Only documented fields
are copied, into `index`; the summary gains one sentence. On any failure or an unknown token the tool answers from
public sources and says so in `notes`. The index only knows tokens that reached about $5k market cap or drew real
buying, so `found: false` is common for brand-new launches.

How the summary words index facts:
- No price is given when the index marks the price unreliable (thin or junk markets), only "no reliable price".
- A creator's launch count is "at least N": launches that never reached about $5k are not counted. A shared launcher
  contract (it launches for many people) is never presented as one developer's record.
- "An earlier launch on the same site or repo is active now and this one is not the official token" comes from
  `copy_of_active_token`; `is_official: null` is said as "not resolved", never as "not official".
- Creator-written text (`name`, `symbol`, site title and description) comes back under `*_untrusted` keys.

## Safety of fetched content

- User-supplied URLs go through `safeFetch`: https only, default port, no credentials, no IP literals or internal host
  names, DNS-over-HTTPS check that every address is public, manual redirects (at most 3, each re-checked), 1.5 MB and
  7 s caps, text content types only.
- Page content is untrusted. Tools return extracted facts and short snippets (keys end in `_untrusted`), never page
  bodies, and strip markup and control characters.

## Development

Run on the build host with Node 24:

```
npm run typecheck   # tsc for src (Worker libs only) and for tests/scripts
npm test            # vitest; replays recorded responses, no network, no secrets
npm run record      # re-record test/fixtures from the live keyless sources (optionally a case-name filter)
npm run smoke       # live: all tools against PEPE (Ethereum), DEGEN (Base), a liquid and a young Robinhood Chain token
```

The sell probe's runtime bytecode lives in `src/util/sellprobe-code.ts`, generated from `sol/SellProbe.sol` with
solc 0.8.26, optimizer 200 runs, `bytecode_hash = "none"`, `cbor_metadata = false` (any Foundry project with those
settings: `forge build`, then copy `deployedBytecode.object`).
