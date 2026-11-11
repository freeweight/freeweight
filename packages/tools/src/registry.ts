import { validateArgs } from "./util/schema.js";
import type { ToolCtx, ToolDef, ToolEnv, ToolResult } from "./types.js";
import { tokenOverview } from "./tools/token_overview.js";
import { safetyCheck } from "./tools/safety_check.js";
import { holdersTool } from "./tools/holders.js";
import { devHistory } from "./tools/dev_history.js";
import { officialCa } from "./tools/official_ca.js";
import { projectCheck } from "./tools/project_check.js";
import { webSearch } from "./tools/web_search.js";
import { marketData } from "./tools/market_data.js";
import { chainRead } from "./tools/chain_read.js";
import { contractSource } from "./tools/contract_source.js";
import { newLaunches } from "./tools/new_launches.js";

export const tools: ToolDef[] = [
  tokenOverview,
  safetyCheck,
  holdersTool,
  devHistory,
  officialCa,
  projectCheck,
  webSearch,
  marketData,
  newLaunches,
  chainRead,
  contractSource,
];

export function getTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

export async function runTool(name: string, args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const t = getTool(name);
  const fail = (code: string, message: string): ToolResult => ({ tool: String(name).slice(0, 64), ok: false, summary: message, partial: false, data: {}, enriched: false, notes: [], sources: [], error: { code, message } });
  if (!t) return fail("unknown_tool", `Unknown tool: ${JSON.stringify(String(name).slice(0, 64))}. Available: ${tools.map((x) => x.name).join(", ")}`);
  let a: unknown = args ?? {};
  if (typeof a === "string") {
    // OpenAI-style tool calls carry arguments as a JSON string.
    try {
      a = a.trim() === "" ? {} : JSON.parse(a);
    } catch {
      return fail("invalid_input", "arguments must be a JSON object");
    }
  }
  if (a === null || typeof a !== "object" || Array.isArray(a)) return fail("invalid_input", "arguments must be a JSON object");
  const bad = validateArgs(a as Record<string, unknown>, t.inputSchema);
  if (bad) return fail("invalid_input", bad);
  return t.handler(a as Record<string, unknown>, ctx);
}

/**
 * The tools that can work with this configuration. A tool that needs a key the server does not have is left out of
 * what a model is offered (it would only spend a round on "not configured"); calling it by name still answers.
 */
export function availableTools(env: ToolEnv): ToolDef[] {
  return tools.filter((t) => !t.available || t.available(env));
}

/** OpenAI Chat Completions `tools` array: the tools that can work with this configuration. */
export function openAiToolSpecs(env: ToolEnv): object[] {
  return availableTools(env).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
