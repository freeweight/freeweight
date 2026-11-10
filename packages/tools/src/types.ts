/**
 * Minimal structural view of a Cloudflare KV namespace. A real `KVNamespace` binding satisfies it.
 */
export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export type ToolEnv = {
  /** Optional private enrichment index (Robinhood Chain). */
  FACTS_URL?: string;
  FACTS_KEY?: string;
  /** Per-chain RPC override: key = chain id or name ("4663", "robinhood", "base"), value = URL or comma-separated URLs. */
  RPC_URLS?: Record<string, string>;
  /** Exa search API key; web_search returns "not configured" without it. */
  EXA_KEY?: string;
  /** Optional GitHub token (read-only, no scopes) for project_check; keyless GitHub allows 60 requests/hour per IP. */
  GITHUB_TOKEN?: string;
};

export type ToolCtx = {
  env: ToolEnv;
  fetch: typeof fetch;
  cache?: KVLike;
};

export type ToolResult = {
  /** Tool name. */
  tool: string;
  /** False only for bad input, unsupported chain or a total failure. Partial data still returns ok: true. */
  ok: boolean;
  /** Short human summary, written for a model to read first. */
  summary: string;
  /** True when some sources failed or the time budget ran out. */
  partial: boolean;
  /** Tool-specific payload. Amounts state their unit; addresses are lowercase. */
  data: Record<string, unknown>;
  /** Freeweight index enrichment (Robinhood Chain), present only when configured and reachable. */
  enriched?: unknown;
  /** Caveats: what was not checked, what failed, blind spots. */
  notes: string[];
  /** Where the data came from (source names and public URLs). */
  sources: string[];
  /** Error code when ok is false. */
  error?: { code: string; message: string };
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  handler: (args: Record<string, unknown>, ctx: ToolCtx) => Promise<ToolResult>;
};
