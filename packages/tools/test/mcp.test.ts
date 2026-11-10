import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handleMcp, LATEST_PROTOCOL_VERSION, openAiToolSpecs, tools, type ToolCtx } from "../src/index.js";

const ctx: ToolCtx = { env: {}, fetch: (async () => new Response("offline", { status: 599 })) as typeof fetch };
const URL_ = "https://fw.test/mcp";

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleMcp(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx,
  );
}

describe("MCP handler: protocol", () => {
  it("initialize negotiates the requested version when supported", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const j = (await res.json()) as { id: number; result: { protocolVersion: string; capabilities: { tools: object }; serverInfo: { name: string } } };
    expect(j.id).toBe(1);
    expect(j.result.protocolVersion).toBe("2025-06-18");
    expect(j.result.capabilities.tools).toBeTruthy();
    expect(j.result.serverInfo.name).toBe("freeweight-tools");
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });
  it("initialize falls back to the latest version for unknown ones", async () => {
    const j = (await (await post({ jsonrpc: "2.0", id: "a", method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json()) as {
      result: { protocolVersion: string };
    };
    expect(j.result.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
  it("rejects an unsupported MCP-Protocol-Version header with 400", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-protocol-version": "1999-01-01" });
    expect(res.status).toBe(400);
  });
  it("notifications get 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
  it("ping", async () => {
    const j = (await (await post({ jsonrpc: "2.0", id: 7, method: "ping" })).json()) as { id: number; result: object };
    expect(j).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
  it("parse error -32700", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32700);
  });
  it("invalid request -32600", async () => {
    const res = await post({ id: 1, method: "ping" });
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600);
  });
  it("unknown method -32601", async () => {
    const j = (await (await post({ jsonrpc: "2.0", id: 2, method: "nope/x" })).json()) as { id: number; error: { code: number } };
    expect(j.id).toBe(2);
    expect(j.error.code).toBe(-32601);
  });
  it("unknown tool -32602", async () => {
    const j = (await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } })).json()) as { error: { code: number } };
    expect(j.error.code).toBe(-32602);
  });
  it("tool input errors are results with isError", async () => {
    const j = (await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "holders", arguments: { token: "bad" } } })).json()) as {
      result: { isError: boolean; content: { type: string; text: string }[]; structuredContent: { ok: boolean } };
    };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.type).toBe("text");
    expect(JSON.parse(j.result.content[0]!.text).summary).toMatch(/token must be/);
    expect(j.result.structuredContent.ok).toBe(false);
  });
  it("batches return an array of responses", async () => {
    const j = (await (await post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }])).json()) as { id: number }[];
    expect(j.map((x) => x.id)).toEqual([1, 2]);
  });
  it("GET and DELETE are 405 (stateless, no SSE stream)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await handleMcp(new Request(URL_, { method }), ctx);
      expect(res.status).toBe(405);
    }
  });
  it("wrong content type is 415, unacceptable Accept is 406", async () => {
    expect((await handleMcp(new Request(URL_, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), ctx)).status).toBe(415);
    expect((await handleMcp(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "text/html" }, body: "{}" }), ctx)).status).toBe(406);
  });
  it("OPTIONS preflight", async () => {
    const res = await handleMcp(new Request(URL_, { method: "OPTIONS" }), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/mcp-protocol-version/);
  });
});

describe("MCP handler: official SDK client", () => {
  it("connects, lists ten read-only tools and calls one", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (input, init) => handleMcp(new Request(input, init), ctx),
    });
    const client = new Client({ name: "sdk-test", version: "1.0.0" });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("freeweight-tools");
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name).sort()).toEqual(
      ["chain_read", "contract_source", "dev_history", "holders", "market_data", "official_ca", "project_check", "safety_check", "token_overview", "web_search"].sort(),
    );
    for (const t of list.tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe("object");
    }
    const r = await client.callTool({ name: "web_search", arguments: { query: "robinhood chain" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/not configured/);
    await client.ping();
    await client.close();
  });
});

describe("OpenAI tool specs", () => {
  it("one function spec per tool with JSON-schema parameters", () => {
    const specs = openAiToolSpecs() as { type: string; function: { name: string; parameters: { type: string } } }[];
    expect(specs).toHaveLength(tools.length);
    expect(tools).toHaveLength(10);
    for (const s of specs) {
      expect(s.type).toBe("function");
      expect(s.function.name).toMatch(/^[a-z_]+$/);
      expect(s.function.parameters.type).toBe("object");
    }
  });
});
