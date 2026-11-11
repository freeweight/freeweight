import type { Chain } from "./chains.js";
import type { JsonSchema, ToolCtx, ToolDef, ToolEnv, ToolResult } from "./types.js";
import { InputError } from "./util/args.js";
import { Run } from "./util/http.js";
import { fetchEnrichment, type Enrichment } from "./sources/facts.js";

export type Body = {
  summary: string;
  data: Record<string, unknown>;
  ok?: boolean;
  error?: { code: string; message: string };
  /** Named summary sentences, in order. When present the summary is rebuilt from them after index reconciliation. */
  parts?: Record<string, string>;
};

export function partsSummary(parts: Record<string, string>): string {
  return Object.values(parts).filter(Boolean).join("; ") + ".";
}

export type ToolSpec = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /** False when the tool cannot work with this configuration (a missing key). */
  available?: (env: ToolEnv) => boolean;
  /** When set, the Freeweight index is asked for enrichment for this token on Robinhood Chain. */
  enrich?: (args: Record<string, unknown>) => { chain: Chain; token: string } | null;
  run: (args: Record<string, unknown>, run: Run) => Promise<Body>;
  /**
   * Reconcile merged index facts with the public answer: may edit body.parts / body.data (e.g. drop a public price the
   * index marks unreliable) and return the index sentence to use instead of the default one.
   */
  reconcile?: (body: Body, fields: Record<string, unknown>) => string | undefined;
};

export function defineTool(spec: ToolSpec): ToolDef {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    ...(spec.available ? { available: spec.available } : {}),
    handler: (args, ctx) => execute(spec, args, ctx),
  };
}

async function execute(spec: ToolSpec, args: Record<string, unknown>, ctx: ToolCtx): Promise<ToolResult> {
  const run = new Run(ctx);
  let enrichP: Promise<Enrichment | undefined> = Promise.resolve(undefined);
  try {
    const target = spec.enrich?.(args) ?? null;
    if (target && target.chain.id === 4663) enrichP = fetchEnrichment(run, spec.name, target.token);
  } catch {
    /* input errors surface from run() below */
  }
  try {
    const body = await spec.run(args, run);
    const enr = await enrichP.catch(() => undefined);
    let line = enr?.status === "merged" ? enr.line : undefined;
    if (enr?.status === "merged" && spec.reconcile) {
      // undefined = keep the default index sentence; "" = no further index sentence.
      const rl = spec.reconcile(body, { as_of: enr.as_of, ...enr.fields });
      if (rl !== undefined) line = rl;
    }
    let summary = (run.partial ? "[partial] " : "") + (body.parts ? partsSummary(body.parts) : body.summary);
    if (enr?.status === "merged" && line) summary += ` Freeweight index: ${line}.`;
    else if (enr?.status === "not_found") run.note("Not tracked by the Freeweight index (it never reached about $5k market cap or about 30 buyers); public sources only.");
    else if (enr?.status === "failed") run.note(`Freeweight index unavailable (${enr.why}); public sources only.`);
    const res: ToolResult = {
      tool: spec.name,
      ok: body.ok ?? true,
      summary,
      partial: run.partial,
      data: body.data,
      enriched: enr?.status === "merged",
      notes: run.notes,
      sources: [...run.sources],
    };
    if (body.error) res.error = body.error;
    else if (res.ok === false) res.error = { code: "no_result", message: body.summary.slice(0, 200) };
    if (enr?.status === "merged") {
      res.index = { as_of: enr.as_of, ...enr.fields };
      res.sources.push("Freeweight index");
    }
    return res;
  } catch (e) {
    if (e instanceof InputError) {
      return { tool: spec.name, ok: false, summary: e.message, partial: false, data: {}, enriched: false, notes: run.notes, sources: [...run.sources], error: { code: e.code, message: e.message } };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return {
      tool: spec.name,
      ok: false,
      summary: `${spec.name} failed: ${msg.slice(0, 200)}`,
      partial: true,
      data: {},
      enriched: false,
      notes: run.notes,
      sources: [...run.sources],
      error: { code: "upstream_error", message: msg.slice(0, 300) },
    };
  }
}
