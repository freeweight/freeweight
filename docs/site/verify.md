---
title: Check our claims
summary: What runs where, and how to check each claim from outside, with no wallet, no key and no money.
order: 35
group: Start
---

Every claim on this site should hold up for someone who does not trust us. This page lists what runs where, and
for each claim the request or the click that shows it. None of the checks below needs a wallet, an API key or
money. Where something cannot be checked from outside, the page says so.

Examples use `https://freeweight.xyz`. Before launch the service runs on a staging address with the same paths.

## What runs where

| Part | Where it runs | Who operates it |
| ---- | ------------- | --------------- |
| The site and the API (`/api`, `/v1`, `/mcp`) | One Cloudflare Worker, with Durable Objects and a D1 database | Us |
| The rented models (Light, Medium, Heavy) | Serverless GPUs at Modal. The Light model has a second source at Baseten. | The GPU provider runs the machine; we run the model on it, from the weights named in the catalog |
| The always-awake model (DeepSeek V4.1 Flash, an uncensored build) | An API run by NanoGPT | NanoGPT |
| Top-ups | Robinhood Chain: a transfer from your wallet to a public treasury address | Nobody signs for you. The service reads the chain. |
| The research tools | Public sources: the chain itself, DexScreener, GeckoTerminal, GoPlus, Sourcify, block explorers and the Pons launch list | See [Tools](tools.md) |
| The staking vault | Not deployed | |
| The token | Does not exist | |

The service holds no user private keys and signs no transaction for a user.

## The claims, and how to check them

### The service is up

```
curl https://freeweight.xyz/api/health
```

The answer is `{"ok": true, "status": "ok", ...}`. Anything else means something is wrong on our side.

### The models are the ones we name

```
curl https://freeweight.xyz/api/models
```

Each model carries `hf_repo` and `sha`: the Hugging Face repository and the commit its weights come from. `quant`
names the quantisation, `license` the model's licence. Open the repository on Hugging Face and compare the commit.
The same answer gives the tier, the price per minute, the context, the state (asleep, waking or awake) and the
wake estimate.

### The prices are the ones on the page

```
curl https://freeweight.xyz/api/config
curl https://freeweight.xyz/api/hosted
```

`prices_usd_micro_per_min` in the first answer is the price per GPU minute of each tier, in millionths of a US
dollar: 30000 is $0.03. The second answer gives the per-token prices of the always-awake model
(`price_in_usd_micro_per_mtok`, `price_out_usd_micro_per_mtok`, per million tokens), its free messages per day,
and `source`, the line that says where it is served.

### The numbers on the home page are counted, not typed

```
curl https://freeweight.xyz/api/stats
curl https://freeweight.xyz/api/receipts
curl https://freeweight.xyz/api/awake
```

`/api/stats` is what the home page shows: GPU-seconds, sessions, wakes, the median wake, and the answers and
tokens of the always-awake model. They are counted from the database. A new deployment starts at zero.
`/api/receipts` lists the 20 sessions that ended last, with the model, free or paid, minutes, price, tokens written
and how long the wake took. It carries no account data. `/api/awake` lists the models that are awake now.

### A model really wakes and answers

This one needs a browser. On the home page, leave the Light model chosen and wake it free for 5 minutes: no
wallet and no sign-up, once a day, after a human check. The wake view shows each stage of the wake as it
happens, with its time. When the model is ready, the chat answers from it, and the session ends on its own when
the 5 minutes are up. An API key cannot start a free try.

### The always-awake model answers

On the home page, type a question into the box. 20 short messages a day are free, the first one behind a human
check. The answer comes from the model named in `GET /api/hosted`.

### The tools work

The tools are served over the Model Context Protocol and need no key. List them:

```
curl https://freeweight.xyz/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}'
```

Call one, here the newest launches on Robinhood Chain:

```
curl https://freeweight.xyz/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "new_launches", "arguments": {}}}'
```

Every result says what it could not find (`partial`, `notes`) and where its facts come from (`sources`). Tool
calls are limited to 30 a minute per network address. What each tool does is on the [tools](tools.md) page.

### Top-ups are read from the chain

`topups.treasury` in `GET /api/config` is the address top-ups go to. It is `null` while top-ups are closed. A
top-up is an ordinary transfer of ETH or USDG to that address on Robinhood Chain, so every one is visible on a
block explorer. The service credits a balance only for a transfer it has read from the chain, after
`topups.confirmations` blocks. It never asks for a signature that moves funds.

### The token and the staking vault

Today there is neither. `perks` in `GET /api/config` reads `{"enabled": false, "token": null, "vault": null}`.

When a token exists, its contract address will be in `perks.token`, on the home page, on this page and in
[llms.txt](llms.txt), all on this domain. An address that shows up anywhere else first is not ours. The staking
vault's source will be verified on the block explorer before anyone is asked to stake. See [staking](staking.md).

### The API is what the docs say

The OpenAPI description is at [/openapi.yaml](openapi.yaml) and a plain-text summary for programs is at
[/llms.txt](llms.txt). Both are served by the same deployment they describe.

## What you cannot check from outside

- **That prompts and answers are not stored.** The gateway keeps what billing needs: sessions, a ledger and token
  counts. You cannot see that from outside. A prompt also passes through the GPU machine that runs the model, and
  for the always-awake model through NanoGPT, whose own terms apply. See [privacy](privacy.md).
- **The source code.** The repository is not public yet.
- **Uptime over time.** There is no public status page yet. `/api/health` shows only the present.
- **Paid use.** A paid session, a top-up and a receipt for them need a wallet and money. The checks above stop
  before that.

## Something does not match

If an answer above disagrees with a page on this site, the page is wrong or the service is. Tell us at
hello@freeweight.xyz with the request and the answer you got.
