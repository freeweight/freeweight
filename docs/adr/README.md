# Decision records

Short records of the decisions that shape Freeweight v0.1. Each one states the context, the decision, what follows
from it and what was considered instead. A record describes what the code does today. When a decision changes, add a
new record and mark the old one as superseded: do not rewrite history.

| No. | Decision | Status |
| --- | -------- | ------ |
| [0001](0001-bill-per-gpu-minute.md) | Bill per GPU minute, never per token | Accepted |
| [0002](0002-shared-instance-per-session-clocks.md) | One shared instance per model, one clock per session | Accepted |
| [0003](0003-wake-time-is-free.md) | Wake time is free | Accepted |
| [0006](0006-topups-verified-on-chain.md) | Top-ups verified by reading the chain | Accepted |
| [0007](0007-vault-holds-no-rewards.md) | The staking vault holds no rewards; credits are computed off-chain | Accepted, vault not deployed |
| [0008](0008-read-only-tools-ssrf-guard.md) | Tools are read-only and fetch through an SSRF guard | Accepted |
| [0009](0009-stateless-mcp.md) | Stateless Streamable-HTTP MCP | Accepted |

Records 0004 and 0005 concern the backend and are not in this repository.

All records are dated 2026-11-10, the day v0.1 was built.
