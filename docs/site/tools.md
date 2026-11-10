---
title: Tools
summary: Ten read-only research tools for on-chain questions, what each returns and where each falls short.
order: 60
group: Build
---

Freeweight has ten research tools for questions about tokens and contracts on EVM chains. They read public data:
chain nodes, block explorers, market data, project websites. They never sign or send a transaction.

There are three ways to use them:

- **In the chat on the site.** Switch tools on and the model calls them when it needs a fact.
- **Over MCP.** `POST /mcp` serves the same tools to any agent or MCP client. It needs no key and no session.
- **From your own loop.** Pass the tool list to a model through `/v1` and run the calls yourself.

The [agents](/docs/agents) page shows the calls. This page says what the tools return and what they miss.

The tools cost nothing extra. In the site's chat the session clock runs while a tool works, as it does for
everything else.

## Chains

Every tool that reads a chain takes `chain` as a name or as the chain id. Without it, the tool uses Robinhood
Chain.

| Chain | Id | Names |
| ----- | -- | ----- |
| Robinhood Chain | 4663 | `robinhood`, `rh` |
| Ethereum | 1 | `ethereum`, `eth` |
| Base | 8453 | `base` |
| BNB Chain | 56 | `bsc`, `bnb` |
| Arbitrum One | 42161 | `arbitrum`, `arb` |
| OP Mainnet | 10 | `optimism`, `op` |
| Polygon PoS | 137 | `polygon` |

Another chain is answered with the error `unsupported_chain`.

## The result

Every tool answers with the same envelope:

```json
{
  "tool": "holders",
  "ok": true,
  "summary": "A short plain-language answer.",
  "partial": false,
  "data": {},
  "enriched": false,
  "notes": [],
  "sources": []
}
```

| Field | Meaning |
| ----- | ------- |
| `tool` | The tool that ran. |
| `ok` | `false` for bad input, an unsupported chain, a total failure or a contract call that reverted. A result with gaps is still `ok: true`. |
| `summary` | A short answer in plain words. Read it first. It starts with `[partial]` when the result has gaps. |
| `partial` | `true` when a source failed or a limit was reached. The rest of the result is still real. |
| `data` | The facts, different for each tool. Amounts name their unit. Addresses are lowercase. |
| `enriched` | `true` when Freeweight's own index added facts. Robinhood Chain only. See below. |
| `index` | The facts from the index. Present only when `enriched` is `true`. |
| `notes` | What was not checked, what failed, and the blind spots of the tool. |
| `sources` | Where the data came from: source names and public addresses. |
| `error` | `{ code, message }` when `ok` is `false`. |

Three rules hold for every tool:

- **Unknown is `null`, never 0.** A value the tool could not read is `null`. A node that did not answer is
  reported as "unknown" and the result is `partial`. It is never turned into a fact.
- **Text written by a token's creator is marked.** Token names and symbols, contract names, page titles and
  revert messages sit in `data` under keys that end in `_untrusted`, such as `name_untrusted`. In a summary such
  text is cleaned, cut to 32 characters and put in double quotes.
- **Arguments are checked.** A missing field, an unknown field or a value out of range is answered with the
  error `invalid_input` before anything runs.

Over MCP the envelope is the tool result: as JSON text in `content[0].text`, as an object in `structuredContent`,
and `isError` is `true` when `ok` is `false`.

## The ten tools

### `token_overview`

Input: `token`, and `chain` if it is not Robinhood Chain.

The basic facts of an ERC-20 token. Name, symbol, decimals and total supply come from the contract. The name and
the symbol are in `name_untrusted` and `symbol_untrusted`. The creator and the creation time come from a block
explorer where one answers. The price in US dollars, the fully diluted value, the market cap, the liquidity and
the main pool come from DexScreener, with the project's websites and social links.

The main pool is the deepest one. A pool with less than $1,000 in it, or with less than 1% of the deepest pool
and less than $25,000, counts as junk. Junk pools are listed apart and never used for the price, because a pool
with almost no money in it shows prices nobody can trade at.

On Robinhood Chain, when Freeweight's own index marks the price as unreliable, the price, the fully diluted
value and the market cap are `null` and a `price_note` says why.

### `safety_check`

Input: `token`, and `chain`.

Two questions: can a buyer sell, and what can the owner do.

**The sell test.** The tool simulates a small purchase followed by the sale of everything bought, from a fresh
random address. A fresh address is one the token's creator cannot have put on a list of wallets that are allowed
to sell. Nothing is sent: the chain node only computes what would happen.

- The purchase is about 0.3% of the pool's quote side, at least 0.0005 and at most 1 unit of the chain's native
  coin.
- The result states the cost of the round trip in `round_trip_cost`: the fraction of the value that was lost,
  from 0 to 1. `buy_cost` and `sell_cost` split it, measured against the DexScreener price, and are approximate.
  On Uniswap v4 the sale is tried in two orders, described below. `round_trip_cost` is then the cost of the
  order that decided the verdict, and `buy_cost` and `sell_cost` belong to the first order.
- The verdict follows from the cost:

| Verdict | In the summary | When |
| ------- | -------------- | ---- |
| `ok` | The cost as a percentage | The sale worked and 15% or less was lost. |
| `costly` | COSTLY | More than 15% was lost. |
| `cannot_sell` | EFFECTIVELY CANNOT SELL | More than 50% was lost. |
| `reverted` | SELL REVERTED | The sale failed. |
| `route_dependent` | SELL DEPENDS ON THE ROUTE | Uniswap v4 only. One order of the sale failed or lost more than 50%, and the other lost 15% or less. Both figures are given. |
| `not_measured` | "did not revert; cost not measured" | The sale worked but the cost could not be measured. |
| `not_simulated` | Says so | No sale could be simulated. |

The two thresholds are in `data.thresholds`. The test covers Uniswap v2 and v3 style pools against the wrapped
native coin, and Uniswap v4 pools against the native coin or its wrapped form. On v4 the pool's hooks run as they
would in a real trade.

**Two orders of the sale on Uniswap v4.** A v4 pool can be paid before or after the swap, and a token or a hook
can behave differently in the two cases. So on v4 the sale runs twice, in separate simulations on the same
block:

- `wallet_held`: the tokens stay in the selling wallet until the swap has run and are paid afterwards.
- `pre_transferred`: the tokens are moved to the pool first and then swapped. Summaries call this order
  "moved-first".

Both results are in `wallets[0].route_costs`: a cost for each order (`wallet_held`, `pre_transferred`), an
outcome for each (`wallet_held_outcome`, `pre_transferred_outcome`: `ok`, `reverted`, `zero_output` or
`unavailable`), `pre_transferred_unavailable` when the second simulation could not run, `transfer_tax` when the
token took a tax on the transfer, and `decided_by`, the order that set the verdict. When the first order fails
only because the token taxes transfers, the summary says so: "transfer tax N%; routes that settle an exact
amount after the swap revert". When the two orders differ in another way, the summary gives both figures. v2
and v3 pools have one order each, so they get one result.

A fresh address cannot always be used: the pool trades against another token, the purchase itself fails, or the
node does not support the simulation. The tool then simulates the sale of a small amount from up to three real
holders, and says why in `fresh_wallet_unavailable`. It picks recent small holders, never the largest holder,
the owner or the creator. This fallback is weaker, because a token can let chosen holders sell and block
everybody else. As a last resort the tool simulates a plain transfer from a holder.

`data.sell_simulation` holds the details: the `method` (`fresh_wallet_round_trip`, `holder_sell` or `none`), the
`verdict`, the kind of pool, the size of the trade, and one entry in `wallets` for every address the simulation
ran from, with its own verdict and costs. On Robinhood Chain it can also hold `index_reading` and `agreement`:
see [enriched results](#enriched-results-on-robinhood-chain).

**Contract flags.** Whether the contract is a proxy, who the owner is and whether ownership is renounced, which
owner powers are in the bytecode (mint, blacklist, pause, trading switch, fee and limit setters, upgrade),
whether the source is verified on Sourcify, and the GoPlus token flags where GoPlus covers the chain.

Every summary of this tool ends with "Not a safety guarantee." The tool never says a token is safe. Read the
blind spots under [what the tools miss](#what-the-tools-miss).

### `holders`

Input: `token`, `chain`, and `limit` for the number of rows (5 to 50, default 15).

The top holders with their share of the supply, each tagged where it applies as `pool`, `burn`, `creator` or
`contract`. Then the totals: the share of the ten largest holders not counting pools and burns, the share in
pools, the share burned and the creator's share.

The list comes from a block explorer where one answers, else from GoPlus (ten holders), else it is rebuilt from
the token's transfer history. The rebuild only works for young tokens. It reports `coverage`, and the coverage is
`full` only when the scan reached back to the token's first mint.

Up to 25 balances are read again from the chain, so the top-ten share does not depend on `limit`. `top10_basis`
says what that share was computed from. A balance that could not be read is `null`, and so are totals that
depend on it.

### `dev_history`

Input: `token`, `chain`, and `dev` to profile another wallet than the one detected.

Who launched the token. That is the creator, or the sender of the launch transaction when the creator is a
factory or a launchpad contract. Then the other contracts this wallet deployed, with the market state of each
today, the wallet's balance of this token and how much of it the wallet sent out.

Some wallets launch for many people: deploy services and launchpad relayers. A wallet with 20 or more direct
deployments, or 1,000 or more sent transactions, is flagged in `launcher_looks_shared`. Its deployments are then
not presented as one developer's record.

Two gaps to know. The list of other deployments needs a block explorer that answers. And tokens the same wallet
launched through a launchpad do not show up as its deployments from public sources.

### `official_ca`

Input: `token`, `chain`, and `url` for the project website. Without `url` the site is taken from DexScreener.

Does the project's own website show this contract address? The tool fetches the site and the scripts it loads
from its own address, and searches them for the token address as a whole address, not as part of a longer string.

An address that stands next to warning words, such as "scam", "fake" or "not our token", is reported as
mentioned with a warning. It does not count as the site showing the address. An address that is one among many
on the page is labelled as part of a list.

The tool also lists other contract addresses the site shows, and other tokens with the same symbol on the chain
with their age and liquidity. Age and liquidity never decide which token is the real one. The first launch is
often a copy.

### `project_check`

Input: `url`, or `token` and `chain` to take the site from DexScreener.

What stands behind the project's website. The domain's age and registrar. The first capture in the Wayback
Machine: a capture older than the registration means the domain had an earlier owner. What the site ships: its
title, its framework, the outside scripts it loads, signs of a template or placeholder text, and its links to
social accounts. And the GitHub accounts or repositories it links to, with their age and activity.

### `web_search`

Input: `query`, `num_results` (1 to 10, default 5), and `days` to keep only results from the last N days.

A web search. It returns titles, addresses, dates and short snippets. Snippets are claims to check, not facts.

This tool runs only for a caller we know. Over MCP, send your API key as the bearer token. In the site's chat it
runs in paid sessions, not in the free try. Otherwise it answers with the error `not_configured`.

### `market_data`

Input: `token` or `pair` (a pool address), `chain`, and `majors` for a list of up to 10 large coins.

Live market data from DexScreener: the main pool and the other real pools of a token, or one pool, with price,
liquidity, volume, the count of buys and sells and the price change. Junk side pools are flagged. It also
returns US dollar prices of large coins from CoinGecko, such as `eth`, `btc` and `sol`.

### `chain_read`

Input: `op`, `chain`, and the fields that operation needs.

Direct read access to a chain, for the questions the other tools do not answer.

| `op` | Reads | Fields |
| ---- | ----- | ------ |
| `call` | The return value of a contract function | `to`, `signature`, `args`, optional `from` and `block` |
| `balance` | The native coin balance of an address | `address`, optional `block` |
| `nonce` | The transaction count of an address | `address` |
| `code` | The bytecode at an address | `address` |
| `storage` | One storage slot | `address`, `slot`, optional `block` |
| `tx` | A transaction | `hash` |
| `receipt` | A transaction receipt | `hash` |
| `block` | A block | `block` |
| `logs` | Event logs of one contract | `address`, optional `from_block`, `to_block`, `topics`, `signature` |

`signature` is written the way Solidity writes it, for example
`function balanceOf(address) view returns (uint256)`. For `logs` it is an event signature, used to decode the
logs. A `logs` read spans at most 10,000 blocks and returns the first 100 logs. Without `from_block` it covers
the last 1,000 blocks.

A `call` that the contract rejects is answered with `ok: false` and the error `reverted`. The contract's own
message, when it gave one, is in `data.revert_reason_untrusted`.

Only read methods exist here. There is no way to send a transaction through this tool.

### `contract_source`

Input: `address`, `chain`, and optional `file`, `max_chars` (2,000 to 120,000, default 40,000) and
`include_abi`.

The verified source code of a contract, from Sourcify or from a block explorer that answers. It returns the list
of files with their sizes, the main file cut to `max_chars`, and the function and event signatures. Pass `file`
to read one file from the list. For a proxy that is only a stub, it follows through to the implementation.

A contract with no verified source gets no source. The tool does not decompile.

## Enriched results on Robinhood Chain

Public data about young tokens on Robinhood Chain is thin. So for that chain, Freeweight's own index adds
launch, holder and project facts to six tools: `token_overview`, `safety_check`, `holders`, `dev_history`,
`official_ca` and `project_check`.

When the index knows the token:

- `enriched` is `true`.
- The facts are in `index`, with `as_of`, the time they are from. Shares are fractions from 0 to 1 and times are
  Unix seconds.
- `summary` gains one sentence that starts with "Freeweight index:".
- `sources` lists "Freeweight index".

What the index adds, in broad terms: where and when the token launched and whether it left its launchpad, how
the supply is spread across pools, burns, the developer and other holders, what the same developer launched
before, whether the project's own site names this token, and what the project's site and code repository show.
For `safety_check` it adds the result of a sell test the index ran earlier, where it has one.

**Two sell tests, one statement.** When the index has its own sell test, `safety_check` has two readings: the
simulation it just ran and the index's earlier one. The summary merges them, and the "Freeweight index:"
sentence does not repeat the sell test.

- When both readings fall in the same class, the summary says they agree and gives the simulation's figures
  first.
- When one reading fails or loses more than 50% and the other loses 15% or less, the summary says SELL TESTS
  DISAGREE. It gives the worse reading first, both figures and the age of the index's reading, and it notes that
  the two readings differ by route, size or time.
- For any other difference the summary gives both figures, the worse one first.

The worse reading sets the verdict. `data.sell_simulation.index_reading` holds the index's reading: `sell_test`
(`ok`, `costly`, `restricted`, `blocked`, `inconclusive`, `not_tested` or `unrecognised`), `round_trip_cost` and
`as_of`. `data.sell_simulation.agreement` is `agree`, `differ`, `disagree`, `index_only`, `simulation_only` or
`none`.

Where the index and a public source would give two answers to one question, the summary gives one:

- When the index marks a price as unreliable, the summary gives no price. The price fields in `data` are `null`
  and the public figure moves to `dexscreener_price_usd_unreliable`.
- When the index has a reliable price, the summary uses that price and marks it "(index)".
- The `holders` summary leads with the index's top-ten share and names the public on-chain count beside it.

Everything else in `data` still comes from public sources, and `index` holds what the index said, so you can
compare the two.

The summary words index facts with care. A developer's earlier launches are counted as "at least N", because
very small launches are not in the index. A wallet that launches for many people is not presented as one
developer. A question the index has not settled is "not resolved", which is not the same as "no". Nothing in
`index` is a score or a recommendation.

The index does not know every token. A brand-new or very small token is often not in it yet. The tool then
answers from public sources alone, `enriched` is `false`, and a line in `notes` says that the index does not
track the token. The same happens when the index does not answer in time, with a note that says so. On every
other chain `enriched` is always `false`.

## Limits

| Limit | Value |
| ----- | ----- |
| Time per tool call | About 15 seconds. The tool then returns what it has, marked `partial`. |
| Outside requests per tool call | 40. Sources past that are skipped, and the result is `partial` with a note. |
| `/mcp` request | One message with one `tools/call`, body up to 256 KiB |
| `/mcp` rate | 30 tool calls per minute per network address. A refusal is HTTP 429 with `Retry-After: 30`. |
| Site chat | At most 4 rounds of tool calls per turn, 3 calls per round. A fourth call in a round is refused with `too_many_calls`. |
| Result size in the site chat | The model sees the first 12,000 characters of a result |
| `chain_read` logs | 10,000 blocks per read, first 100 logs returned |
| `holders` rows | 5 to 50 |
| `web_search` results | 1 to 10 |
| Fetched web pages | HTTPS only, at most 1.5 MB and 7 seconds per page, text only. The first 256 KB of a page is analysed. |

Results are cached for a short time, so two identical calls in a row can return the same data.

## What the tools miss

Read `partial`, `notes` and `sources` on every result. They are the honest part of the answer.

**A partial result.** A tool asks several sources and has about 15 seconds. When a source fails or a limit is
reached, the tool returns what it has. `partial` is `true`, the summary starts with `[partial]`, and `notes` says
what is missing. A missing fact is `null`. It is not zero and it is not good news.

**Sources that do not answer.** Block explorers on several chains turn away automated traffic. When that
happens the tools fall back to other sources and say so in `notes`. In practice:

| | Ethereum | Base, Arbitrum, OP, Polygon | BNB Chain | Robinhood Chain |
| - | -------- | --------------------------- | --------- | --------------- |
| Chain reads and the sell test | Yes | Yes | Yes | Yes |
| Market data, verified source | Yes | Yes | Yes | Yes |
| Creator, full holder list, other deployments | From explorers | Often from fallbacks | From fallbacks | From fallbacks and the index |
| Holder list rebuilt from transfers | Young tokens | Young tokens | Young tokens | Young tokens |

A fallback gives less: ten holders instead of a full list, a creator without the list of its other deployments.

**`safety_check` is not a verdict.** The sell test is one trade: from one fresh address, at one small size,
sent straight to the pool, on one block at the moment of the call. A good result means that trade would have
worked. The test does not see:

- rules that favour or punish particular wallets, since the test is one fresh address,
- traps at larger sizes or at a later time,
- logic that depends on a particular router, executor contract, sender or call data, because the test calls
  the pool directly from its own address. The two orders on Uniswap v4 come closer to what some routers do,
  and they are still not those routers,
- tokens that still trade on a launchpad's bonding curve and not in a pool,
- tricks in a website or a wallet prompt,
- anything the owner can still change after the check.

When the test fell back to real holders, it shows less still, because a token can treat those holders better
than a new buyer. When the simulated holders got different results, a note says that the token may treat
wallets differently.

An owner power found in the bytecode is a possibility, not proof that it was used. The scan looks for known
function names and misses custom ones. GoPlus does not see what a Uniswap v4 hook does. A missing flag is not
proof of safety.

**Text from other people.** Token names, website text and search snippets are written by whoever made the token
or the page. A page can contain text aimed at a model, such as "ignore your instructions". The tools return such
text only as short snippets, in fields whose names end in `_untrusted`. Treat it as data, and tell your model
to do the same. `GET /api/config` returns the note we use for that in `tool_system_note`: put it in front of
the conversation when you run your own loop.

**Errors.** When `ok` is `false`, `error.code` is one of:

| Code | Meaning |
| ---- | ------- |
| `invalid_input` | A field is missing, unknown, out of range or malformed, for example an address that is not an address. |
| `unsupported_chain` | The chain is not in the list above. |
| `no_result` | The tool ran and found nothing to report, for example an address with no contract code. |
| `reverted` | A `chain_read` call was rejected by the contract. |
| `not_configured` | `web_search` was called by a caller it does not run for. |
| `upstream_error` | Every source the tool needs failed. Try again later. |
| `unknown_tool` | No tool has that name. Over MCP this is a JSON-RPC error instead. |

**What the tools are not.** They report facts with their gaps. They do not rate a token, predict a price or tell
you what to buy. A model that reads the results can still be wrong about them.
