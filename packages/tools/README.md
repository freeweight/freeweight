# @freeweight/tools

Read-only token research tools for EVM chains, built to run inside a Cloudflare Worker (only `fetch`, no Node APIs).
The same eleven tools are served three ways:

- **MCP**: `handleMcp(request, ctx)` is a stateless Streamable-HTTP MCP endpoint (JSON responses, no sessions).
- **Chat tool calling**: `openAiToolSpecs(env)` returns OpenAI-style function specs; `runTool(name, args, ctx)` runs one.
- **Direct**: `tools` is the list of definitions (name, title, description, JSON-schema input, handler).

A tool that cannot work with the given `env` is not offered: `tools/list` and `openAiToolSpecs(env)` both go through
`availableTools(env)`, which today leaves out `web_search` when there is no `EXA_KEY`. Calling such a tool by name still
answers, with `not_configured`.

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
| `RPC_URLS` | Per-chain RPC override, keyed by chain id or name (`"4663"`, `"base"`); an https URL or a comma-separated list tried in order (`http://` entries are ignored). **Set a keyed Robinhood Chain RPC in production**: from Workers' shared egress IPs the public RPC answers 429. The RPC must support `eth_call` state overrides (code and balance) for the fresh-wallet sell test. |
| `EXA_KEY` | Enables `web_search`. Without it the tool is not listed and returns `not_configured` when called. |
| `GITHUB_TOKEN` | Optional read-only token for `project_check` (keyless GitHub is 60 requests/hour per IP). |
| `FACTS_URL`, `FACTS_KEY`, `FACTS_ACCESS_ID`, `FACTS_ACCESS_SECRET` | Optional Freeweight index for Robinhood Chain tokens (see Enrichment). `FACTS_URL` must be https. |
| `MCP_ALLOWED_ORIGINS` | Browser origins allowed to call `handleMcp` (comma-separated exact origins). Requests without an `Origin` header (SDKs, CLIs, servers) and same-origin requests are always allowed; any other origin gets 403. |

`ctx.cache` is optional; any object with KV's `get(key, "text")` / `put(key, value, { expirationTtl })` works. It is
used only for stable, shareable records (index facts, Sourcify, explorer creation records, GoPlus, RDAP, Wayback), only
when they live at least 60 s, and at most 4 writes per tool call. Everything else stays in a per-isolate memory cache of
at most 16 MB (256 KB per entry, LRU).

### Limits

| limit | value |
|---|---|
| wall clock per tool call | about 15 s; partial results are marked `partial` |
| upstream requests per tool call | 40 (`MAX_SUBREQUESTS`), DNS-over-HTTPS lookups included; hitting it marks the result partial |
| MCP request body | 1 MB (`MCP_LIMITS.maxBodyBytes`) |
| MCP batches | refused for protocol 2025-06-18 and later; older versions: at most 8 messages and one `tools/call` (`MCP_LIMITS`) |
| page analysis | first 256 KB of a page |

A gateway in front should count tool calls, not HTTP requests.

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

Creator-written text (token names and symbols, pool symbols, contract names, page titles, revert strings) is never put
in a summary raw: it appears cleaned, capped at 32 characters and in double quotes, and in `data` under keys ending in
`_untrusted`. An RPC failure is never reported as a fact: the answer says "unknown" and the result is `partial`.

### `token_overview` `{ chain?, token }`
Name, symbol (`name_untrusted`, `symbol_untrusted`), decimals and total supply from the contract; creator and creation time from an explorer (GoPlus as a
fallback for the creator); USD price, FDV, market cap, liquidity and the main pool from DexScreener. The main pool is
the deepest one; pools under $1k, or under 1% of the deepest and under $25k, are counted as junk and never used for
price (tiny pools print fake wicks). Also lists websites and socials from DexScreener.

### `safety_check` `{ chain?, token }`
Can a buyer sell, and what can the owner do?
- **Sell test**: a small buy-then-sell round trip from a fresh random address that nobody can have exempted, run with
  `eth_call` and a state override that gives the address the probe's code and some native coin (`sol/SellProbe.sol`).
  It buys about 0.3% of the pool's quote side (at least 0.0005, at most 1 native unit), sells everything it received,
  and reports `round_trip_cost` plus approximate `buy_cost` / `sell_cost` against the DexScreener mid price (fractions of
  value lost). A round trip losing more than 15% is **COSTLY** (15% itself is not), more than 50% **EFFECTIVELY CANNOT
  SELL**, a failed sale **SELL REVERTED**. Uniswap v2/v3 style pools against the wrapped native coin and Uniswap v4 pools
  against the native coin or its wrapped form are covered, hooks included (pool key from `PositionManager.poolKeys` or
  the `Initialize` event). When a fresh wallet cannot be used (other quote token, the buy reverts, no state-override
  support), sales of a small amount are simulated from up to three real holders (recent small recipients first; never
  the largest holder, owner or creator), and the reason is in `fresh_wallet_unavailable`. Every result names the
  wallet(s) it ran from; without a cost figure it says "did not revert; cost not measured", never "OK". Last resort: a
  plain transfer from a holder.
- **Two sale orders on Uniswap v4**: the round trip's sale runs twice, in separate calls pinned to the same block number.
  `wallet_held`: the tokens stay in the selling wallet until the swap has run and are paid at settlement (the selling
  wallet is also the transaction origin). `pre_transferred`: the tokens are moved to the pool manager and settled
  first, then swapped against that credit, and any credit the swap does not use is taken back. This approximates the
  settle-first order used by some executors, which usually move the tokens through their own contract first; see the
  blind spots below. Both results are in `wallets[0].route_costs` (`wallet_held`, `pre_transferred`, an outcome for
  each, `pre_transferred_unavailable` when the second call could not run, `transfer_tax` when the token charged one,
  and `decided_by`). `round_trip_cost` is the cost of the order that decided the verdict; `buy_cost` / `sell_cost`
  always belong to the wallet-held order. If one order fails or loses more than 50% and the other loses 15% or less,
  the verdict is `route_dependent` and the summary says **SELL DEPENDS ON THE ROUTE** with both figures. If the
  wallet-held sale reverts only because the pool manager was credited less than was sent (a transfer tax), the summary
  says "transfer tax N%; routes that settle an exact amount after the swap revert" instead. When the orders differ
  otherwise, both figures are printed, labelled `wallet-held` and `moved-first`. (v2 pools always take the tokens
  before the swap; v3 pools pull them during the swap, so there is one order each.)
- **Index reconciliation**: when the Freeweight index has its own sell test (a $1 round trip, with the time it was read),
  the two readings are merged into one statement and the index's sell sentence is not repeated. Same verdict class:
  "agree", the simulation's figures first. A large gap (one side fails or loses more than 50%, the other loses 15% or
  less or went through): **SELL TESTS DISAGREE**, worse reading first, both figures and the index reading's age, noting
  that the readings differ by route, size or time. Any other difference: both figures, worse first, no label. The
  worse reading sets the verdict. Index costs outside 0..1 are ignored; index values this package does not know are
  reported as "unrecognised" and never quoted. `sell_simulation.index_reading` and `sell_simulation.agreement`
  (`agree`, `differ`, `disagree`, `index_only`, `simulation_only`, `none`) record this.
- **Probe verification**: the probe's v4 accounting (both orders, partial fills, transfer-taxed tokens, token0- or
  token1-in, native or ERC20 quote) is hand-traced against the v4 pool manager's rules and checked live on real pools;
  there is no forked or local pool-manager test in this package.
- **Static flags**: EIP-1967 / EIP-1167 proxy, `owner()` and whether it is renounced, owner-power functions found in
  the bytecode by a PUSH4 scan (mint, blacklist, pause, trading switch, fee setters, limits, exclusions, upgrade),
  Sourcify verification, and GoPlus token security where GoPlus covers the chain.
- It never says "safe". Still blind: exemptions or penalties for specific wallets (the probe is one fresh address),
  trade size (one small size), time (one block, now), logic keyed to a particular router, executor contract, sender
  or calldata (the probe calls the pool manager or pool directly from its own address), bonding-curve venues, and
  front-end tricks. GoPlus does not see Uniswap v4 hook logic.

### `holders` `{ chain?, token, limit? }`
Top holders with % of supply and tags (`pool`, `burn`, `creator`, `contract`), top-10 concentration excluding pools and
burns, the share in DEX pools, burned (0xdead + 0x0) and the creator's share. Sources in order: Blockscout or Routescan
holder list, GoPlus top 10, then a reconstruction from `Transfer` logs for young tokens (the scan is bounded; it reports
`coverage: full` only when the mint is inside the scanned window, otherwise the result is `partial`). Up to 25 balances
are re-read on-chain, so the top-10 figure does not depend on `limit`; its basis is in `top10_basis`. Unknown values
(a failed balance check, unknown decimals) are null, never 0.

### `dev_history` `{ chain?, token, dev? }`
Who launched the token: the creator, and when the creator is a factory or launchpad contract, the sender of the mint
transaction. Then the launcher's other direct deployments (explorer) with their DexScreener state, its balance of this
token, and how much it sent out (from logs, young tokens). Tokens launched through a launchpad by the same wallet do not
show as its deployments. A wallet with 20 or more direct deployments or 1,000 or more sent transactions is flagged as a
likely shared launcher or deploy service (`launcher_looks_shared`), and its deployments are then not summarised as one
developer's record.

### `official_ca` `{ chain?, token, url? }`
Fetches the project site (given, or the first non-social website from DexScreener) and its same-origin JS bundles and
checks whether the contract address appears as a standalone address (not inside a longer hex string). A mention next
to warning words ("scam", "fake", "not our token" ...) is reported as such (`ca_mentioned_with_warning`) and does not
count as the site showing the CA; one address among many is labelled. Lists other addresses the site shows. Lists other tokens with the same
symbol on the chain with age and liquidity. Age and depth never decide which token is real.

### `project_check` `{ url? | chain? + token }`
Domain age and registrar (RDAP), first Wayback capture (a capture older than the registration means an earlier owner or
a re-registration), what the site ships (title, framework, external script hosts, template and placeholder signals,
links to X / Telegram / GitHub / Discord) and linked GitHub accounts or repos (age, commits seen, fork).

### `web_search` `{ query, num_results?, days? }`
Exa search: titles, URLs, dates and short snippets. Without `EXA_KEY` it is not listed and returns `not_configured`.

### `market_data` `{ chain?, token? | pair?, majors? }`
DexScreener pools for a token (main, other real pools, junk pools flagged) or one pair, with price, liquidity, volume,
buys/sells and price change; USD prices for majors from CoinGecko (`eth`, `btc`, `sol` or CoinGecko ids).

### `new_launches` `{ chain?, launchpad?, stage?, limit?, min_age_minutes?, max_age_minutes?, min_liquidity_usd? }`
The newest tokens on a chain, newest first. It needs no address. Two public sources:

- **A launchpad's own list.** Pons on Robinhood Chain (`ponsfamily.com/api/launches`): every token started there, with
  its stage (`curve` or `graduated`), bonding-curve progress, market cap, the amount raised, volume and trades since
  launch, creator, creator fee, description and links. Pages of 40; a call reads at most three.
- **GeckoTerminal new pools** on any supported chain: the 20 newest pools with reserve, FDV, 24 h volume and trades.

On Robinhood Chain both are read and merged (`launchpad` or `stage` narrows the call to the launchpad). A new pool whose
token is already in the launchpad list, or that sits on the launchpad's own exchange, is dropped: it is that token
graduating, not a new launch. On other chains only new pools are read.

Limits. GeckoTerminal's keyless API answers 429 to most requests from Workers' shared addresses (measured: 1 answer in
16 calls from a deployed Worker), so it is asked once per call, never retried, and a good answer is shared for two
minutes. When it fails on Robinhood Chain the result is `partial`, holds launchpad rows only and says so; on another
chain the call fails with `upstream_error`. `liquidity_usd` is the pool reserve for a pool and the amount raised for a
token on the curve; a graduated launchpad token has none in this list, and `min_liquidity_usd` leaves it out with a
note. Market caps are the sources' own figures and can be far off for a token with almost no trades. Age and liquidity
filters run on the rows read, not on the whole history; a note says how far back the call looked. The tool lists and
does not judge. Only launchpads named in `data.supported_launchpads` are covered.

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
are copied, into `index`; the summary gains one sentence, and index facts replace a conflicting public sentence rather
than sit next to it (an unreliable index price removes the public price; holders shows one top-10 figure with its
basis). Keyed requests never follow redirects. On any failure or an unknown token the tool answers from public sources
and says so in `notes`. The index only knows tokens that reached about $5k market cap or drew real
buying, so `found: false` is common for brand-new launches.

How the summary words index facts:
- No price is given when the index marks the price unreliable (thin or junk markets), only "no reliable price".
- A creator's launch count is "at least N": launches that never reached about $5k are not counted; with none it says
  "no other launch by this creator reached about $5k". A shared launcher
  contract (it launches for many people) is never presented as one developer's record.
- "An earlier launch on the same site or repo is active now and this one is not the official token" comes from
  `copy_of_active_token`; `is_official: null` is said as "not resolved", never as "not official".
- Creator-written text (`name`, `symbol`, site title and description) comes back under `*_untrusted` keys.

## Safety of fetched content

- User-supplied URLs go through `safeFetch`: https only, default port, no credentials, no IP literals or internal host
  names, DNS-over-HTTPS check (A and AAAA, fail closed, never cached) that every address is public, manual redirects
  (at most 3, each re-checked; 2 for sites taken from token metadata), 1.5 MB and 7 s caps, text content types only.
  On Workers this is defence in depth: the runtime resolves again when connecting and cannot reach private ranges.
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
solc 0.8.26, via-IR, optimizer 200 runs, `bytecode_hash = "none"`, `cbor_metadata = false` (any Foundry project with
those settings: `forge build`, then copy `deployedBytecode.object`).
