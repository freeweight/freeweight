# 0008: Tools are read-only and fetch through an SSRF guard

- Status: accepted
- Date: 2026-11-10

## Context

Rented models can call a toolkit for token research: contract reads, holder lists, sell simulations, project sites.
The toolkit runs inside the gateway Worker, takes arguments written by a model or by an anonymous MCP caller, and
fetches URLs found on the open internet. That is a classic path to three failures: moving funds, reaching internal
systems, and feeding hostile text back into a model.

## Decision

- **Read-only.** No tool signs or sends a transaction. The package (`packages/tools`) has no key and no wallet.
  Chain access is limited to read methods. Every MCP tool is annotated `readOnlyHint: true`.
- **The sell test sends nothing.** `safety_check` simulates a small buy and then a sale of what was bought, from a
  wallet that has never existed, in one `eth_call` with a state override. Nothing reaches the chain. The result
  states the cost of the round trip and its own blind spots: one wallet, one small size, a direct call to the
  pool, at this moment. A loss above 15% reads as costly, above 50% as effectively unable to sell. Every answer
  carries the line "Not a safety guarantee."
- **Checked arguments.** Arguments are validated against the tool's input schema before the tool runs. A mismatch
  is an `invalid_input` result, not a guess. RPC and index URLs from configuration must be https.
- **Guarded fetch.** Any URL that comes from a user, a model or a web page goes through `safeFetch`
  (`packages/tools/src/util/ssrf.ts`): https only, default port, no credentials in the URL, no IP literals, no
  single-label or internal host names, a DNS-over-HTTPS check that every address the name resolves to is public,
  manual redirects (three at most, each checked again), a 1.5 MB body cap, a 7 second timeout and text content types
  only.
- **Untrusted content stays labelled.** Tools return extracted facts and short snippets, never page bodies. Text that
  came from a page or from a token's creator is stripped of markup and control characters and returned under keys
  that end in `_untrusted`.
- **One result shape.** Every tool returns `tool`, `ok`, `summary`, `partial`, `data`, `enriched`, `notes` and
  `sources`, plus `error` when it failed. A value that could not be read is `null`, never `0` or an empty string.
  A tool that could not check something says so in `notes` instead of guessing. `safety_check` never says "safe".
- **A budget.** About 15 seconds and 40 outgoing requests per call. When either runs out the tool returns what it
  has with `partial: true`. The gateway's chat loop runs each tool call in its own Durable Object invocation (`ToolDO`),
  because the platform counts outgoing requests per invocation.
- **The private index stays private.** On Robinhood Chain six tools merge facts from Freeweight's own index. Only
  documented fields are copied, and the gateway removes the index host from tool output (`hideFacts` in
  the gateway, not in this repository).

## Consequences

- A prompt-injected model cannot spend anything through the tools, because the tools cannot spend.
- The guard blocks the usual routes to internal addresses. The check and the fetch are bounded by the platform:
  on Workers the fetch cannot reach a private network of ours.
- Labels do not stop prompt injection. A model can still be misled by text in a tool result. The labels exist so
  that a careful client or system prompt can treat such text as data.
- Read-only limits what agents can do: there is no swap, no transfer, no approval. That is intended.
- The sell test is a simulation of one path. A token can still treat another wallet, another size, a router or a
  later block differently. The result says so, and the public docs repeat it.
- Results depend on public data sources that rate-limit or block server traffic at times. Tools degrade to `partial`
  and name what failed.

## Alternatives

- **Let tools act (swap, send).** A different product with custody and consent problems. Rejected.
- **Let the model fetch any URL.** No guard would be small enough to audit.
- **Run user code for analysis.** Needs a sandbox. Freeweight executes no user code.
