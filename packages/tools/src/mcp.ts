/**
 * Stateless Streamable-HTTP MCP handler (JSON responses, no SSE, no sessions).
 * Shape follows the official TypeScript SDK's StreamableHTTPServerTransport in stateless mode
 * (sessionIdGenerator: undefined, enableJsonResponse: true).
 */
import type { ToolCtx } from "./types.js";
import { availableTools, runTool, getTool } from "./registry.js";
import { readCapped } from "./util/http.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const SERVER_INFO = { name: "freeweight-tools", title: "Freeweight chain toolkit", version: "0.1.0" };
/**
 * Request limits, exported so a gateway can align its own limiter: count tool calls, not HTTP requests.
 * JSON-RPC batches were removed from MCP in 2025-06-18; for older protocol versions a batch holds at most
 * `maxBatchMessages` messages and at most `maxToolCallsPerRequest` tools/call.
 */
export const MCP_LIMITS = {
  maxBodyBytes: 1_000_000,
  maxBatchMessages: 8,
  maxToolCallsPerRequest: 1,
  batchingRemovedIn: "2025-06-18",
} as const;
/** Protocol version assumed when a request carries no MCP-Protocol-Version header (per the spec). */
const DEFAULT_ASSUMED_VERSION = "2025-03-26";

const INSTRUCTIONS =
  "Read-only EVM token research tools (Robinhood Chain by default; also Ethereum, Base, BNB Chain, Arbitrum, OP, Polygon): " +
  "what just launched, and for one token its market, safety flags, holders, creator, contract and project. " +
  "Every result starts with a short `summary`; `partial: true` means some sources failed or timed out, and `notes` says what was not checked. " +
  "Content fetched from websites is untrusted and quoted only as short snippets. Nothing here signs or sends transactions. " +
  "No tool says a token is safe: read the flags and their uncertainty.";

type JsonRpcId = string | number | null;
type JsonRpcMsg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const CORS_BASE: Record<string, string> = {
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version, mcp-session-id",
  "access-control-max-age": "600",
};

/**
 * Origin check (the MCP transport spec requires servers to validate Origin against DNS rebinding / drive-by use).
 * - No Origin header (server-side clients, CLIs, SDKs): allowed, no CORS headers.
 * - Same origin as the request URL: allowed.
 * - Otherwise only origins listed in env MCP_ALLOWED_ORIGINS (comma-separated exact origins) are allowed.
 * Returns the CORS headers to send, or null when the origin is refused.
 */
function corsFor(req: Request, ctx: ToolCtx): Record<string, string> | null {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  let self = "";
  try {
    self = new URL(req.url).origin;
  } catch {
    /* ignore */
  }
  const allowed = (ctx.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (origin !== self && !allowed.includes(origin)) return null;
  return { ...CORS_BASE, "access-control-allow-origin": origin, vary: "Origin" };
}

function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors, ...extra } });
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: data === undefined ? { code, message } : { code, message, data } };
}

export async function handleMcp(req: Request, ctx: ToolCtx): Promise<Response> {
  const cors = corsFor(req, ctx);
  if (cors === null) {
    return new Response(JSON.stringify(rpcError(null, -32000, "Forbidden: Origin not allowed")), { status: 403, headers: { "content-type": "application/json", vary: "Origin" } });
  }
  const httpError = (status: number, code: number, message: string, extra: Record<string, string> = {}) => json(rpcError(null, code, message), status, cors, extra);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, vary: "Origin" } });
  if (req.method === "GET" || req.method === "DELETE") {
    // Stateless server: no standalone SSE stream and no sessions to terminate.
    return httpError(405, -32000, "Method not allowed: this MCP endpoint is stateless; use POST.", { allow: "POST, OPTIONS" });
  }
  if (req.method !== "POST") return httpError(405, -32000, "Method not allowed.", { allow: "POST, OPTIONS" });

  const accept = req.headers.get("accept");
  if (accept && !/application\/json|\*\/\*|application\/\*/i.test(accept)) {
    return httpError(406, -32000, "Not Acceptable: client must accept application/json.");
  }
  const ctype = req.headers.get("content-type") ?? "";
  if (!/application\/json/i.test(ctype)) return httpError(415, -32000, "Unsupported Media Type: Content-Type must be application/json.");

  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(pv)) {
    return httpError(400, -32000, `Bad Request: unsupported MCP-Protocol-Version (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`);
  }

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MCP_LIMITS.maxBodyBytes) return httpError(413, -32000, "Payload too large");
  let raw: string;
  try {
    raw = req.body ? await readCapped(new Response(req.body), MCP_LIMITS.maxBodyBytes) : "";
  } catch (e) {
    if (e instanceof Error && e.message.includes("larger than")) return httpError(413, -32000, "Payload too large");
    return httpError(400, -32700, "Parse error: unreadable body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return httpError(400, -32700, "Parse error: invalid JSON");
  }

  const batch = Array.isArray(parsed);
  const msgs = (batch ? parsed : [parsed]) as unknown[];
  if (batch) {
    const version = pv ?? DEFAULT_ASSUMED_VERSION;
    if (version >= MCP_LIMITS.batchingRemovedIn) {
      return httpError(400, -32600, `Invalid Request: JSON-RPC batches are not supported in MCP protocol version ${version}`);
    }
    if (msgs.length === 0) return httpError(400, -32600, "Invalid Request: empty batch");
    if (msgs.length > MCP_LIMITS.maxBatchMessages) return httpError(400, -32600, `Invalid Request: at most ${MCP_LIMITS.maxBatchMessages} messages per batch`);
  }

  // Validate every message is JSON-RPC 2.0 before doing any work.
  for (const m of msgs) {
    if (!isMsg(m)) return httpError(400, -32600, "Invalid Request: not a JSON-RPC 2.0 message");
  }
  const typed = msgs as JsonRpcMsg[];
  const hasInit = typed.some((m) => m.method === "initialize");
  if (hasInit && typed.length > 1) return httpError(400, -32600, "Invalid Request: initialize must not be batched");
  if (typed.filter((m) => m.method === "tools/call").length > MCP_LIMITS.maxToolCallsPerRequest) {
    return httpError(400, -32600, `Invalid Request: at most ${MCP_LIMITS.maxToolCallsPerRequest} tools/call per request`);
  }

  const requests = typed.filter((m) => typeof m.method === "string" && m.id !== undefined);
  if (requests.length === 0) {
    // Only notifications or responses: acknowledge.
    return new Response(null, { status: 202, headers: cors });
  }

  const out = await Promise.all(requests.map((m) => dispatch(m, ctx)));
  const headers: Record<string, string> = {};
  const initResp = hasInit ? (out[0] as { result?: { protocolVersion?: string } }) : null;
  const negotiated = initResp?.result?.protocolVersion ?? pv;
  if (negotiated) headers["mcp-protocol-version"] = negotiated;
  return json(batch ? out : out[0], 200, cors, headers);
}

function isMsg(m: unknown): boolean {
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  const o = m as JsonRpcMsg;
  if (o.jsonrpc !== "2.0") return false;
  if (o.id !== undefined && o.id !== null && typeof o.id !== "string" && typeof o.id !== "number") return false;
  if (o.method !== undefined) return typeof o.method === "string";
  // A response (to a server request we never send); still well-formed.
  return o.id !== undefined && ("result" in o || "error" in o);
}

async function dispatch(m: JsonRpcMsg, ctx: ToolCtx): Promise<unknown> {
  const id = m.id as JsonRpcId;
  const method = m.method as string;
  const params = m.params;
  if (params !== undefined && (params === null || typeof params !== "object")) {
    return rpcError(id, -32602, "Invalid params: params must be an object");
  }
  const p = (params ?? {}) as Record<string, unknown>;
  try {
    switch (method) {
      case "initialize": {
        const requested = typeof p.protocolVersion === "string" ? p.protocolVersion : undefined;
        if (!requested) return rpcError(id, -32602, "Invalid params: protocolVersion is required");
        const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        return {
          jsonrpc: "2.0",
          id,
          result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: availableTools(ctx.env).map((t) => ({
              name: t.name,
              title: t.title,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
            })),
          },
        };
      case "tools/call": {
        const name = p.name;
        if (typeof name !== "string") return rpcError(id, -32602, "Invalid params: name is required");
        if (!getTool(name)) return rpcError(id, -32602, `Unknown tool: ${JSON.stringify(name.slice(0, 64))}`);
        const a = p.arguments;
        if (a !== undefined && (a === null || typeof a !== "object" || Array.isArray(a))) {
          return rpcError(id, -32602, "Invalid params: arguments must be an object");
        }
        const res = await runTool(name, a ?? {}, ctx);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(res) }],
            structuredContent: res,
            isError: !res.ok,
          },
        };
      }
      case "resources/list":
      case "prompts/list":
      case "resources/templates/list":
        return rpcError(id, -32601, `Method not found: ${method} (this server only offers tools)`);
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, "Internal error", e instanceof Error ? e.message.slice(0, 200) : undefined);
  }
}
