// One typed client for Contract 1. Everything the UI knows about the gateway goes through here.

import { readSse } from "./sse";
import { DEFAULT_CONFIG, TIERS } from "./types";
import type { ApiKey, Awake, Config, Listing, Me, Model, NewKey, Perks, PublicReceipt, Session, StageEvent, Stats, Tier, Topup } from "./types";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const SESSION_HEADER = "x-freeweight-session";

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    /** Whatever else the gateway put in the error, such as the `session_id` of the session that is already live. */
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Epoch seconds or milliseconds in, milliseconds out. */
export function toMs(n: number | null | undefined): number | null {
  if (n == null) return null;
  return n < 1e11 ? Math.round(n * 1000) : n;
}

export function normalizeSession(raw: Session): Session {
  return {
    ...raw,
    // In the order the gateway reported them: a stage can come round twice, and the order is the only thing that says which is which.
    stages: [...(raw.stages ?? [])],
    started_at: toMs(raw.started_at),
    ends_at: toMs(raw.ends_at),
    now: toMs(raw.now) ?? Date.now(),
    created_at: toMs(raw.created_at),
    spent_usd_micro: raw.spent_usd_micro ?? 0,
    tokens_in: raw.tokens_in ?? 0,
    tokens_out: raw.tokens_out ?? 0,
    gpu_seconds: raw.gpu_seconds ?? 0,
  };
}

/** `/api/me` as the gateway sends it. */
export type RawMe = {
  address?: string | null;
  balance_usd_micro?: number;
  held_usd_micro?: number;
  free_today?: { trial_available?: boolean; trial_minutes?: number; allowance_usd_micro?: number } | null;
  keys?: ApiKey[];
  perks?: Perks;
  sessions?: Session[];
  listing_proof_line?: string;
};
export function normalizeMe(raw: RawMe): Me {
  return {
    address: raw.address ?? null,
    balance_usd_micro: raw.balance_usd_micro ?? 0,
    held_usd_micro: raw.held_usd_micro ?? 0,
    free_today: raw.free_today?.trial_available === true,
    allowance_usd_micro: raw.free_today?.allowance_usd_micro ?? raw.perks?.allowance_usd_micro ?? 0,
    keys: (raw.keys ?? []).map((k) => ({ ...k, created_at: toMs(k.created_at) ?? 0, last_used_at: toMs(k.last_used_at) })),
    perks: raw.perks ?? { enabled: false },
    sessions: (raw.sessions ?? []).map(normalizeSession),
    listing_proof_line: raw.listing_proof_line ?? null,
  };
}

/** `/api/config` as the gateway sends it: nested, and every part optional as far as this app is concerned. */
export type RawConfig = {
  prices_usd_micro_per_min?: Partial<Record<Tier, number>>;
  free_minutes?: number;
  default_minutes?: number;
  max_minutes?: number;
  idle_seconds?: number;
  turnstile?: { enabled?: boolean; sitekey?: string | null };
  chain?: { id?: number; name?: string };
  topups?: { open?: boolean; treasury?: string | null; assets?: Config["topup_assets"]; confirmations?: number };
  perks?: { enabled?: boolean };
  owner_share_bps?: number;
  tool_system_note?: string;
};
export function normalizeConfig(raw: RawConfig | null | undefined): Config {
  const r = raw ?? {};
  const d = DEFAULT_CONFIG;
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback);
  const prices = { ...d.prices_usd_micro_per_min };
  for (const t of TIERS) prices[t] = num(r.prices_usd_micro_per_min?.[t], prices[t]);
  return {
    prices_usd_micro_per_min: prices,
    free_minutes: num(r.free_minutes, d.free_minutes),
    default_minutes: num(r.default_minutes, d.default_minutes),
    max_minutes: num(r.max_minutes, d.max_minutes),
    idle_seconds: num(r.idle_seconds, d.idle_seconds),
    // A sitekey only counts while the check is switched on.
    turnstile_sitekey: r.turnstile?.enabled === false ? null : r.turnstile?.sitekey || null,
    chain_id: num(r.chain?.id, d.chain_id),
    chain_name: r.chain?.name || d.chain_name,
    treasury: r.topups?.open === false ? null : r.topups?.treasury || null,
    topup_assets: r.topups?.assets ?? d.topup_assets,
    topup_confirmations: num(r.topups?.confirmations, d.topup_confirmations),
    perks_enabled: r.perks?.enabled === true,
    owner_share_bps: typeof r.owner_share_bps === "number" ? r.owner_share_bps : d.owner_share_bps,
    tool_system_note: r.tool_system_note || null,
  };
}

/** Fold one message from the session event stream into the session. Pure. */
export function applyEvent(prev: Session, event: string, data: unknown): Session {
  if (!data || typeof data !== "object") return prev;
  if ("stages" in data && "id" in data) return normalizeSession(data as Session);
  if (event === "stage" && "stage" in data) {
    const ev = data as StageEvent;
    // The stream replays what it has on every reconnect, and a stage can come round again (weights twice, a retry),
    // so an event replaces only its own earlier copy (same stage, same time), where that copy stands. Anything else
    // goes on the end: the order is the gateway's, never ours.
    const at = prev.stages.findIndex((s) => s.stage === ev.stage && s.t_ms === ev.t_ms);
    const stages = at < 0 ? [...prev.stages, ev] : prev.stages.map((s, i) => (i === at ? ev : s));
    const state = ev.stage === "failed" ? "failed" : prev.state;
    // A stage we had not seen is live detail again. A replayed one says nothing new.
    const degraded = at < 0 ? false : prev.degraded;
    return { ...prev, stages, state, ...(prev.degraded === undefined ? {} : { degraded }) };
  }
  return prev;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolSpec = { type: "function"; function: { name: string; description?: string; parameters?: unknown } };
export type Usage = { prompt_tokens: number; completion_tokens: number };
export type ChatDelta = {
  content?: string;
  reasoning?: string;
  tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
  finish?: string;
  usage?: Usage;
};

type ChatChunk = {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: ChatDelta["tool_calls"] }; finish_reason?: string | null }[];
  usage?: Usage | null;
  error?: { code?: string; message?: string };
};

export function createClient(f: FetchLike) {
  async function req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal, extra?: Record<string, string>): Promise<T> {
    let res: Response;
    try {
      res = await f(path, {
        method,
        credentials: "same-origin",
        headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      throw new ApiError("network", "Could not reach Freeweight. Check your connection and try again.", 0);
    }
    return parse<T>(res);
  }

  async function parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (!res.ok) throw toError(res.status, json);
    return json as T;
  }

  function toError(status: number, json: unknown): ApiError {
    const err = (json as { error?: ({ code?: string; message?: string } & Record<string, unknown>) | string } | null)?.error;
    if (err && typeof err === "object") {
      const { code, message, type: _type, ...extra } = err;
      return new ApiError(code ?? "error", message ?? "Request failed.", status, extra);
    }
    if (typeof err === "string") return new ApiError("error", err, status);
    return new ApiError(status === 404 ? "not_found" : "error", `Request failed (${status}).`, status);
  }

  return {
    models: (signal?: AbortSignal) => req<{ models: Model[] }>("GET", "/api/models", undefined, signal).then((r) => r.models),
    model: (id: string) => req<Model>("GET", `/api/models/${encodeURIComponent(id)}`),
    awake: () =>
      req<{ awake: Awake[] }>("GET", "/api/awake").then((r) => r.awake.map((a) => ({ ...a, since: toMs(a.since) ?? Date.now() }))),
    stats: () => req<Stats>("GET", "/api/stats"),
    /** Public config. If the gateway cannot be asked, the app runs on its defaults: no human check, top-ups closed. */
    config: (): Promise<Config> => req<RawConfig>("GET", "/api/config").then(normalizeConfig, () => normalizeConfig(null)),
    /** The public board: the latest sessions that ended, with nothing that says whose they were. */
    receipts: () =>
      req<{ receipts: PublicReceipt[] }>("GET", "/api/receipts").then((r) => (r.receipts ?? []).map((x) => ({ ...x, ended_at: toMs(x.ended_at) ?? 0 }))),

    /**
     * Start a session. The choice is always spelled out: the free try (with the human-check token when there is one),
     * or a paid session of so many minutes. The gateway never charges for `free: true`.
     */
    createSession: (model_id: string, how: { free: true; turnstile?: string } | { minutes: number }) =>
      req<Session>("POST", "/api/sessions", { model_id, ...how }).then(normalizeSession),
    // Reading a session names it in a header as well, so a free session started before signing in is still readable
    // after it. Extending and stopping are the owner's alone: this browser's own cookies say who that is.
    session: (id: string, signal?: AbortSignal) =>
      req<Session>("GET", `/api/sessions/${encodeURIComponent(id)}`, undefined, signal, { [SESSION_HEADER]: id }).then(normalizeSession),
    extend: (id: string, minutes: number) =>
      req<Session>("POST", `/api/sessions/${encodeURIComponent(id)}/extend`, { minutes }).then(normalizeSession),
    stop: (id: string) => req<Session>("POST", `/api/sessions/${encodeURIComponent(id)}/stop`, {}).then(normalizeSession),

    /** Session event stream. Resolves when the stream closes; throws on HTTP or network failure. */
    async events(id: string, on: (event: string, data: unknown) => void, signal: AbortSignal): Promise<void> {
      const res = await f(`/api/sessions/${encodeURIComponent(id)}/events`, {
        headers: { accept: "text/event-stream", [SESSION_HEADER]: id },
        credentials: "same-origin",
        signal,
      });
      if (!res.ok || !res.body) throw await parse<never>(res).catch((e: unknown) => e);
      for await (const m of readSse(res.body)) {
        let data: unknown;
        try {
          data = JSON.parse(m.data);
        } catch {
          continue;
        }
        on(m.event, data);
      }
    },

    me: () => req<RawMe>("GET", "/api/me").then(normalizeMe),
    nonce: () => req<{ nonce: string }>("GET", "/api/auth/nonce").then((r) => r.nonce),
    verify: (message: string, signature: string) => req<unknown>("POST", "/api/auth/verify", { message, signature }),
    logout: () => req<unknown>("POST", "/api/auth/logout", {}),
    createKey: (name: string, auto_session: boolean) => req<NewKey>("POST", "/api/keys", { name, auto_session }),
    deleteKey: (id: string) => req<unknown>("DELETE", `/api/keys/${encodeURIComponent(id)}`),
    topup: (tx_hash: string) => req<Topup>("POST", "/api/topups", { tx_hash }),
    createListing: (hf_repo: string) => req<Listing>("POST", "/api/listings", { hf_repo }),
    listing: (id: string) => req<Listing>("GET", `/api/listings/${encodeURIComponent(id)}`),

    /** OpenAI-compatible streaming chat on a session. */
    async *chat(
      body: { model: string; messages: ChatMessage[]; tools?: ToolSpec[]; max_tokens?: number },
      opts: { sessionId: string; signal: AbortSignal },
    ): AsyncGenerator<ChatDelta> {
      let res: Response;
      try {
        res = await f("/v1/chat/completions", {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json", accept: "text/event-stream", [SESSION_HEADER]: opts.sessionId },
          body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
          signal: opts.signal,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        throw new ApiError("network", "The connection dropped. Try again.", 0);
      }
      if (!res.ok || !res.body) {
        await parse<never>(res);
        throw new ApiError("error", "Empty response.", res.status);
      }
      for await (const m of readSse(res.body)) {
        if (m.data === "[DONE]") return;
        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(m.data) as ChatChunk;
        } catch {
          continue;
        }
        if (chunk.error) throw new ApiError(chunk.error.code ?? "error", chunk.error.message ?? "The model returned an error.", 200);
        const c = chunk.choices?.[0];
        const out: ChatDelta = {};
        if (c?.delta?.content) out.content = c.delta.content;
        if (c?.delta?.reasoning_content) out.reasoning = c.delta.reasoning_content;
        if (c?.delta?.tool_calls?.length) out.tool_calls = c.delta.tool_calls;
        if (c?.finish_reason) out.finish = c.finish_reason;
        if (chunk.usage) out.usage = chunk.usage;
        yield out;
      }
    },

    /** One stateless JSON-RPC call to the toolkit's MCP endpoint. */
    async mcp<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
      const res = await f("/mcp", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal,
      });
      type Rpc = { result?: T; error?: { message?: string } };
      let rpc: Rpc | null = null;
      if (res.ok && res.body && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        for await (const m of readSse(res.body)) {
          try {
            const j = JSON.parse(m.data) as Rpc;
            if (j.result !== undefined || j.error) rpc = j;
          } catch {
            /* skip */
          }
        }
      } else {
        rpc = await parse<Rpc>(res);
      }
      if (!rpc || rpc.error || rpc.result === undefined) throw new ApiError("tool_error", rpc?.error?.message ?? "The toolkit did not answer.", res.status);
      return rpc.result;
    },
  };
}

export type Client = ReturnType<typeof createClient>;
