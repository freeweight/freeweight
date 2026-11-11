# Freeweight

Rent an open-weight text model by the GPU minute.

A model sleeps as stored weights and costs nothing. A session wakes it on a serverless GPU, the wake is shown stage
by stage and is not billed, and the clock runs from the moment the model is ready until the session ends. The price
is per GPU minute. Tokens are never counted.

Status: v0.1, before public launch. The staking vault is written and tested but not deployed. No token is live.

## How it works

1. The catalog lists models with their tier, price, context and licence. A model is asleep, waking or awake.
2. A session starts on a model. The gateway holds the price of the chosen minutes from an integer ledger and asks a
   serving lane to wake the model.
3. The lane reports each stage of the wake with real timings. The gateway streams them to the client.
4. When the model is ready the session's clock starts. Inference goes through an OpenAI-compatible `/v1` proxy.
5. Every renter of a model shares one instance. Each session has its own clock and its own charge.
6. The session ends when it is stopped, out of time or idle. The seconds used are charged, the rest of the hold is
   released, and a receipt is written. When the last session leaves, the model goes back to sleep.

| Tier | GPU memory | Price |
| ---- | ---------- | ----- |
| Light | 24 GB | $0.03 per GPU minute |
| Medium | 48 GB | $0.06 per GPU minute |
| Heavy (preview) | 80 GB | $0.10 per GPU minute |

## Layout

| Path | What |
| ---- | ---- |
| `apps/gateway` | The backend: API, sessions, billing ledger, top-up verification and the `/v1` proxy. One Cloudflare Worker with Durable Objects and D1. |
| `apps/web` | The site and the app (Vite, React). A static bundle that the gateway serves from the same origin. |
| `packages/tools` | Eleven read-only research tools for on-chain questions, and the MCP handler that serves them. |
| `serving/modal`, `serving/baseten` | Two serving lanes behind one adapter contract: wake, status, sleep, inference. |
| `contracts` | `WeightVault`, the staking vault (Foundry). It holds stake and nothing else. Planned: not deployed. |
| `docs` | Architecture, decision records, threat model, runbook, the OpenAPI file and the pages of the public site. |

## What is deliberately absent

- No custody. The service holds no user keys and signs nothing for users. Top-ups are verified by reading the chain.
- No user code execution. A session gives access to model inference only.
- No stored prompts or completions. The gateway keeps what billing needs: sessions, a ledger and token counters.
- No rewards in the vault. Staker credits (planned, not live) are a usage discount computed off-chain from the
  vault's views.
- Tools never sign or send a transaction. A URL that comes from a user, a model or a web page is fetched only
  through an SSRF guard.

## Run it

Node 22 or newer. CI uses Node 24.

```bash
npm install
npm run typecheck
npm test
```

The tests need no account, no secrets and no GPU. The gateway's tests run the Worker in a local runtime against a
mock lane, with the network stubbed. To see the site without a backend:

```bash
npm run dev:mock -w @freeweight/web    # the site against an in-browser mock gateway
```

The contracts, and the lanes, which are separate packages with their own dependencies:

```bash
(cd contracts && forge test)
(cd serving/baseten && npm ci && npm test)
python -m pip install -r serving/modal/requirements-dev.txt
python -m pytest serving/modal/tests
```

Deploying, secrets (names only) and the operating procedures are in [docs/runbook.md](docs/runbook.md).

## Docs

| Read | For |
| ---- | --- |
| [docs/architecture.md](docs/architecture.md) | Components, request and money flows, the wake pipeline, state machines, the data model and trust boundaries. |
| [docs/adr](docs/adr/README.md) | Nine decision records: why per-minute billing, shared instances, free wakes, the lane contract, the ledger, on-chain top-ups, the vault, read-only tools and stateless MCP. |
| [docs/threat-model.md](docs/threat-model.md) | Assets, actors, money paths, what the code mitigates (with file references) and what is still open. |
| [docs/runbook.md](docs/runbook.md) | Deploy, secrets, adding a model, rotating a provider key, a GPU stuck awake, failing top-ups. |
| [docs/architecture.md](docs/architecture.md#known-gaps-in-v01) | Known gaps in v0.1: where the parts do not yet agree with each other. |
| [docs/roadmap.md](docs/roadmap.md) | What is live in v0.1, what is planned for launch, and what is open with no date. |
| [docs/api/openapi.yaml](docs/api/openapi.yaml) | OpenAPI 3.1 for the gateway API as implemented. |
| [docs/site](docs/site) | The pages of the public docs: quickstart, pricing, API reference, agents, tools, models, policies. |

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability, and [docs/threat-model.md](docs/threat-model.md)
for what has been considered. Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

No licence file has been added yet. Until one is, all rights are reserved.
