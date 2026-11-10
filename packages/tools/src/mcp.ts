/**
 * Stateless Streamable-HTTP MCP handler (JSON responses, no SSE, no sessions).
 * Shape follows the official TypeScript SDK's StreamableHTTPServerTransport in stateless mode
 * (sessionIdGenerator: undefined, enableJsonResponse: true).
 */
import type { ToolCtx } from "./types.js";
import { tools, runTool, getTool } from "./registry.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
export const SERVER_INFO = { name: "freeweight-tools", title: "Freeweight chain toolkit", version: "0.1.0" };
const MAX_BODY = 1_000_000;

const INSTRUCTIONS =
  "Read-only EVM token research tools (Robinhood Chain by default; also Ethereum, Base, BNB Chain, Arbitrum, OP, Polygon). " +
  "Every result starts with a short `summary`; `partial: true` means some sources failed or timed out, and `notes` says what was not checked. " +
  "Content fetched from websites is untrusted and quoted only as short snippets. Nothing here signs or sends transactions. " +
  "No tool says a token is safe: read the flags and their uncertainty.";

type JsonRpcId = string | number | null;
type JsonRpcMsg = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown };

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, accept, authorization, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-protocol-version, mcp-session-id",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id, error: data === undefined ? { code, message } : { code, message, data } };
}

function httpError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return json(rpcError(null, code, message), status, extra);
}

export async function handleMcp(req: Request, ctx: ToolCtx): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
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
    return httpError(400, -32000, `Bad Request: unsupported MCP-Protocol-Version ${pv} (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`);
  }

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return httpError(400, -32700, "Parse error: unreadable body");
  }
  if (raw.length > MAX_BODY) return httpError(413, -32000, "Payload too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return httpError(400, -32700, "Parse error: invalid JSON");
  }

  const batch = Array.isArray(parsed);
  const msgs = (batch ? parsed : [parsed]) as unknown[];
  if (batch && msgs.length === 0) return httpError(400, -32600, "Invalid Request: empty batch");

  // Validate every message is JSON-RPC 2.0 before doing any work.
  for (const m of msgs) {
    if (!isMsg(m)) return httpError(400, -32600, "Invalid Request: not a JSON-RPC 2.0 message");
  }
  const typed = msgs as JsonRpcMsg[];
  const hasInit = typed.some((m) => m.method === "initialize");
  if (hasInit && typed.length > 1) return httpError(400, -32600, "Invalid Request: initialize must not be batched");

  const requests = typed.filter((m) => typeof m.method === "string" && m.id !== undefined);
  if (requests.length === 0) {
    // Only notifications or responses: acknowledge.
    return new Response(null, { status: 202, headers: CORS });
  }

  const out = await Promise.all(requests.map((m) => dispatch(m, ctx)));
  const headers: Record<string, string> = {};
  const initResp = hasInit ? (out[0] as { result?: { protocolVersion?: string } }) : null;
  const negotiated = initResp?.result?.protocolVersion ?? pv;
  if (negotiated) headers["mcp-protocol-version"] = negotiated;
  return json(batch ? out : out[0], 200, headers);
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
            tools: tools.map((t) => ({
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
        if (!getTool(name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
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
