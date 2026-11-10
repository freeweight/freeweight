# 0001: Bill per GPU minute, never per token

- Status: accepted
- Date: 2026-11-10

## Context

Freeweight serves open-weight models that are asleep by default. A model costs GPU time from the moment it is loaded
until it is unloaded, whatever the number of tokens it produces in between. Per-token prices only work when one
loaded model is shared by enough traffic to keep it busy. Most open models never get that traffic, which is why most
of them are not served anywhere.

## Decision

A session is billed for the time it runs, at the price of the model's weight class.

- Prices are per GPU minute and belong to the class, not to the model: Light $0.03, Medium $0.06, Heavy $0.10
  (defaults in `apps/gateway/src/env.ts`, stored as 30,000, 60,000 and 100,000 micro-USD per minute).
- The charge is `ceil(seconds * price_per_minute / 60)` micro-USD, computed once when the session ends
  (`priceOf` in `apps/gateway/src/ledger.ts`). Seconds are whole seconds of server time.
- Tokens in and out are counted per session and shown on the receipt. They never enter a price.

## Consequences

- Any model that fits a class can be listed at a known price, with no traffic forecast.
- The cost of a job is known before it starts: minutes times the class price.
- Long-context and high-volume work is cheap per token. Light, occasional chat is expensive per token. The pricing
  page says so.
- A session that sits unused still runs its clock. The idle timeout (300 seconds by default) and the stop call bound
  the waste.
- Throughput is not part of the price. A model that answers slowly costs the same per minute as a fast one in the
  same class.

## Alternatives

- **Per token.** Familiar, but it needs steady shared traffic per model and a price table per model. It cannot carry
  rarely used models.
- **Per request.** Hides very different costs behind one number.
- **Subscription.** Needs accounts, plans and usage caps. None of that exists in v0.1.
