# 0009: Stateless Streamable-HTTP MCP

- Status: accepted
- Date: 2026-11-10

## Context

The toolkit is also offered to outside agents over the Model Context Protocol at `/mcp`. MCP allows long-lived
sessions with server-sent streams, resumable connections and server-initiated messages. The gateway runs on Workers,
where each request may land on a different isolate, and every tool here is a single request and a single response.

## Decision

`/mcp` is a stateless Streamable-HTTP endpoint (`packages/tools/src/mcp.ts`).

- `POST` only, with a JSON body and a JSON response. `GET` and `DELETE` answer `405`.
- No session: the server issues no `Mcp-Session-Id` and keeps nothing between requests. Each request is complete in
  itself.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`. Notifications are accepted and answered with `202`.
  There are no resources and no prompts.
- One message per request for protocol version `2025-06-18` and later, which removed batching. Older versions may
  send a batch of up to 8 messages, never with `initialize` in it. A request without the version header is read
  as `2025-03-26`. No request may hold more than one `tools/call`.
- Tool arguments are validated against the tool's input schema before the tool runs.
- A request with a browser `Origin` header is refused with `403` unless the origin is the gateway's own or is
  listed in `MCP_ALLOWED_ORIGINS`. A request without the header, which is what agents and command-line clients
  send, is not affected.
- A tool result is returned twice in one response: as JSON text content and as `structuredContent`. `isError` is true
  when the tool's `ok` is false.
- The endpoint is open: no key is needed. A caller that sends an API key, or is signed in, is treated as known, and
  only known callers get the paid web search.
- The gateway checks a request before the toolkit sees it (the gateway is not in this repository): a body of at most
  256 KiB, one `tools/call` at most, and 30 tool calls per 60 seconds per network address (in the gateway's
  configuration, not in this repository). Only tool calls are counted. A handshake or a tool listing is free.
- The gateway rebuilds the response with a fixed set of headers and removes the private index host from the body.

## Consequences

- Any isolate can answer any request. There is nothing to store, expire or resume.
- Clients that need server-initiated messages, progress streams or subscriptions get none. No tool here needs them.
- A call is bounded by the tool budget of about 15 seconds, so a plain response is enough.
- An open endpoint invites scraping. The tools use shared, rate-limited data sources, so heavy anonymous use degrades
  results for everyone. The rate limit is per network address: callers behind one shared address share it, and a
  caller with many addresses gets it for each.
- The origin rule keeps a web page from using a visitor's browser as a free tool client. It also means a
  browser-based MCP client on another site does not work until its origin is listed. The gateway still answers
  the CORS preflight for `/mcp` with `Access-Control-Allow-Origin: *`, so such a client passes the preflight and
  gets `403` on the request itself. `MCP_ALLOWED_ORIGINS` is not set in the committed configuration (open item).

## Alternatives

- **Stateful sessions in a Durable Object.** Full protocol coverage, with state to manage for no present use.
- **The older HTTP+SSE transport.** Deprecated in the protocol and needs a long-lived stream.
- **Require an API key.** Simpler abuse control, but it puts a wallet in front of read-only public data.
