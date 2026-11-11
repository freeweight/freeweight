import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { availableTools, handleMcp, LATEST_PROTOCOL_VERSION, MCP_LIMITS, openAiToolSpecs, tools, type ToolCtx } from "../src/index.js";

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
  it("batches are rejected from protocol 2025-06-18 on (#1)", async () => {
    for (const v of ["2025-06-18", "2025-11-25"]) {
      const res = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }], { "mcp-protocol-version": v });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600);
    }
  });
  it("older protocol versions get small batches with at most one tools/call (#1)", async () => {
    const ok = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }, { jsonrpc: "2.0", id: 2, method: "tools/list" }], { "mcp-protocol-version": "2025-03-26" });
    expect(((await ok.json()) as { id: number }[]).map((x) => x.id)).toEqual([1, 2]);
    const many = Array.from({ length: MCP_LIMITS.maxBatchMessages + 1 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "ping" }));
    expect((await post(many, { "mcp-protocol-version": "2025-03-26" })).status).toBe(400);
    const twoCalls = [0, 1].map((i) => ({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "web_search", arguments: { query: "q" } } }));
    expect((await post(twoCalls, { "mcp-protocol-version": "2024-11-05" })).status).toBe(400);
  });
  it("300 tools/call in one POST run nothing (#1)", async () => {
    let calls = 0;
    const counting: ToolCtx = { env: { EXA_KEY: "k" }, fetch: (async () => (calls++, new Response("{}"))) as typeof fetch };
    const batch = Array.from({ length: 300 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "web_search", arguments: { query: `q${i}` } } }));
    for (const v of ["2025-11-25", "2025-03-26"]) {
      const res = await handleMcp(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "mcp-protocol-version": v }, body: JSON.stringify(batch) }), counting);
      expect(res.status).toBe(400);
    }
    expect(calls).toBe(0);
  });
  it("refuses bodies over the cap before parsing (#14)", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MCP_LIMITS.maxBodyBytes) } });
    expect((await post(big)).status).toBe(413);
    const declared = await handleMcp(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", "content-length": String(50_000_000) }, body: "{}" }), ctx);
    expect(declared.status).toBe(413);
  });
  it("validates Origin (#18)", async () => {
    const withOrigin = (origin: string, c: ToolCtx = ctx) =>
      handleMcp(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) }), c);
    const foreign = await withOrigin("https://evil.example.org");
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const same = await withOrigin("https://fw.test");
    expect(same.status).toBe(200);
    expect(same.headers.get("access-control-allow-origin")).toBe("https://fw.test");
    const listed = await withOrigin("https://app.example.org", { ...ctx, env: { MCP_ALLOWED_ORIGINS: "https://app.example.org, https://other.example.org" } });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("access-control-allow-origin")).toBe("https://app.example.org");
    const none = await post({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(none.status).toBe(200);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("validates tool arguments against the advertised schema (#22)", async () => {
    const call = async (args: unknown) =>
      ((await (await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "chain_read", arguments: args } })).json()) as { result: { structuredContent: { error?: { code: string; message: string } } } }).result.structuredContent;
    expect((await call({ op: "logs", address: "0x" + "1".repeat(40), topics: ["0x" + "0".repeat(64), null, null, null, null] })).error?.message).toMatch(/more than 4/);
    expect((await call({ op: "call", bogus: 1 })).error?.message).toMatch(/unknown argument/);
    expect((await call({ op: "nope" })).error?.message).toMatch(/one of/);
    const unknown = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x".repeat(5000), arguments: {} } })).json()) as { error: { message: string } };
    expect(unknown.error.message.length).toBeLessThan(120);
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
  it("OPTIONS preflight from an allowed origin", async () => {
    const res = await handleMcp(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://fw.test" } }), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toMatch(/mcp-protocol-version/);
    expect((await handleMcp(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://evil.example.org" } }), ctx)).status).toBe(403);
  });
});

describe("MCP handler: official SDK client", () => {
  it("connects, lists the read-only tools that can work here and calls one", async () => {
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
      fetch: (input, init) => handleMcp(new Request(input, init), ctx),
    });
    const client = new Client({ name: "sdk-test", version: "1.0.0" });
    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("freeweight-tools");
    const list = await client.listTools();
    expect(list.tools.map((t) => t.name).sort()).toEqual(
      ["chain_read", "contract_source", "dev_history", "holders", "market_data", "new_launches", "official_ca", "project_check", "safety_check", "token_overview"].sort(),
    );
    for (const t of list.tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.inputSchema.type).toBe("object");
    }
    // Not listed without its key, and still answered plainly when called by name.
    const r = await client.callTool({ name: "web_search", arguments: { query: "robinhood chain" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toMatch(/not configured/);
    await client.ping();
    await client.close();
  });
});

describe("OpenAI tool specs", () => {
  it("one function spec per tool with JSON-schema parameters", () => {
    const specs = openAiToolSpecs({ EXA_KEY: "k" }) as { type: string; function: { name: string; parameters: { type: string } } }[];
    expect(specs).toHaveLength(tools.length);
    expect(tools).toHaveLength(11);
    for (const s of specs) {
      expect(s.type).toBe("function");
      expect(s.function.name).toMatch(/^[a-z_]+$/);
      expect(s.function.parameters.type).toBe("object");
    }
  });
});

describe("tools that cannot work are not offered", () => {
  const names = async (c: ToolCtx) => {
    const res = await handleMcp(new Request(URL_, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), c);
    return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  };
  it("web_search is listed only when the server has a search key", async () => {
    expect(await names(ctx)).not.toContain("web_search");
    expect(await names(ctx)).toHaveLength(tools.length - 1);
    expect(await names({ ...ctx, env: { EXA_KEY: "k" } })).toContain("web_search");
    expect(availableTools({}).map((t) => t.name)).not.toContain("web_search");
    expect((openAiToolSpecs({}) as { function: { name: string } }[]).map((s) => s.function.name)).not.toContain("web_search");
  });
  it("every other tool is always offered", () => {
    expect(availableTools({}).map((t) => t.name)).toEqual(tools.filter((t) => t.name !== "web_search").map((t) => t.name));
    expect(availableTools({}).map((t) => t.name)).toContain("new_launches");
  });
});
