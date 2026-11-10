# Freeweight

Rent any open model by the minute. Models sleep as stored weights and cost nothing; a session wakes one on a
serverless GPU, and you pay per GPU minute while it runs.

- `apps/gateway`: API, sessions, billing and the OpenAI-compatible proxy (Cloudflare Workers)
- `apps/web`: the site
- `packages/tools`: the chain toolkit and its MCP endpoint
- `serving/`: wake-on-demand serving on GPU providers
- `contracts/`: staking vault
- `docs/`: architecture and API docs

Status: pre-launch. No token is live.
