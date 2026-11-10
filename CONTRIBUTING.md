# Contributing

## Layout

| Path | What |
|---|---|
| `apps/gateway` | Cloudflare Worker: API, sessions, billing ledger, OpenAI-compatible proxy |
| `apps/web` | The site (Vite + React) |
| `packages/tools` | Chain toolkit and MCP handler |
| `serving/*` | Provider lanes behind one adapter contract |
| `contracts` | Staking vault (Foundry) |
| `docs` | Architecture and public docs |

## Working rules

- One change per pull request, scoped to one directory where possible. Explain why, not only what.
- `main` stays green: `npm run typecheck`, `npm test` and `forge test` must pass.
- Money-like values are integers (USD micro, token base units). No floats in the ledger.
- Every charge and credit is idempotent and has a test.
- No secrets, account ids or upstream provider URLs in the repository. Configuration comes from environment bindings.
- Commit messages: `<area>: <what changed>` in the imperative, with the reason in the body when it is not obvious.

## Running

```bash
npm install
npm run typecheck
npm test
```

Contracts:

```bash
cd contracts
forge test
```
