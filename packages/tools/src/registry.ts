import type { ToolCtx, ToolDef, ToolResult } from "./types.js";
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

export const tools: ToolDef[] = [
  tokenOverview,
  safetyCheck,
  holdersTool,
  devHistory,
  officialCa,
  projectCheck,
  webSearch,
  marketData,
  chainRead,
  contractSource,
];

export function getTool(name: string): ToolDef | undefined {
  return tools.find((t) => t.name === name);
}

export async function runTool(name: string, args: unknown, ctx: ToolCtx): Promise<ToolResult> {
  const t = getTool(name);
  const fail = (code: string, message: string): ToolResult => ({ tool: name, ok: false, summary: message, partial: false, data: {}, notes: [], sources: [], error: { code, message } });
  if (!t) return fail("unknown_tool", `Unknown tool: ${name}. Available: ${tools.map((x) => x.name).join(", ")}`);
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
  return t.handler(a as Record<string, unknown>, ctx);
}

/** OpenAI Chat Completions `tools` array. */
export function openAiToolSpecs(): object[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}
