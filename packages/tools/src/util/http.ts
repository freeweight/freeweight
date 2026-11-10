import type { ToolCtx } from "../types.js";

/** Total wall-clock budget for one tool call. */
export const TOOL_BUDGET_MS = 15_000;
const UA = "freeweight-tools/0.1 (+read-only token toolkit)";

type MemEntry = { exp: number; value: string };
const MEM = new Map<string, MemEntry>();
const MEM_MAX = 600;
const INFLIGHT = new Map<string, Promise<string>>();

function memGet(key: string): string | undefined {
  const e = MEM.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) {
    MEM.delete(key);
    return undefined;
  }
  return e.value;
}

function memPut(key: string, value: string, ttlS: number): void {
  if (value.length > 400_000) return;
  if (MEM.size >= MEM_MAX) {
    const first = MEM.keys().next().value;
    if (first !== undefined) MEM.delete(first);
  }
  MEM.set(key, { exp: Date.now() + ttlS * 1000, value });
}

/** Test hook. */
export function clearMemCache(): void {
  MEM.clear();
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FetchOpts = {
  /** Source label for the `sources` list and failure notes, e.g. "dexscreener". */
  source: string;
  /** Cache TTL in seconds; 0 disables caching. */
  ttl?: number;
  timeoutMs?: number;
  retries?: number;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  /** Explicit cache key (needed for POST bodies). */
  cacheKey?: string;
  /** Record this public URL in sources (default true). Set false for private endpoints. */
  public?: boolean;
  /** Max response bytes. */
  maxBytes?: number;
  /** Return non-2xx bodies that are JSON-RPC error objects instead of throwing (RPC endpoints). */
  jsonRpc?: boolean;
};

/**
 * One tool invocation: carries the deadline, collected sources and notes, and the partial flag.
 */
export class Run {
  readonly deadline: number;
  readonly sources = new Set<string>();
  readonly notes: string[] = [];
  partial = false;

  constructor(
    readonly ctx: ToolCtx,
    budgetMs = TOOL_BUDGET_MS,
  ) {
    this.deadline = Date.now() + budgetMs;
  }

  remaining(): number {
    return this.deadline - Date.now();
  }

  note(msg: string): void {
    if (!this.notes.includes(msg)) this.notes.push(msg);
  }

  /** Mark partial and note why. */
  miss(source: string, err: unknown): void {
    this.partial = true;
    const m = err instanceof Error ? err.message : String(err);
    this.note(`${source} unavailable (${m.slice(0, 120)})`);
  }

  async text(url: string, o: FetchOpts): Promise<string> {
    const ttl = o.ttl ?? 60;
    const key = "fwt:" + (o.cacheKey ?? `${o.method ?? "GET"} ${url}`);
    if (ttl > 0) {
      const hit = memGet(key);
      if (hit !== undefined) {
        this.addSource(o, url);
        return hit;
      }
      if (this.ctx.cache) {
        try {
          const kv = await this.ctx.cache.get(key, "text");
          if (kv !== null) {
            memPut(key, kv, ttl);
            this.addSource(o, url);
            return kv;
          }
        } catch {
          /* cache is best effort */
        }
      }
    }
    // Coalesce identical in-flight requests (two sources asking for the same GoPlus record at once).
    if (ttl > 0) {
      const pending = INFLIGHT.get(key);
      if (pending) {
        const body = await pending;
        this.addSource(o, url);
        return body;
      }
      const p = this.fetchWithRetry(url, o, key, ttl);
      INFLIGHT.set(key, p);
      try {
        return await p;
      } finally {
        INFLIGHT.delete(key);
      }
    }
    return this.fetchWithRetry(url, o, key, ttl);
  }

  private async fetchWithRetry(url: string, o: FetchOpts, key: string, ttl: number): Promise<string> {
    const retries = o.retries ?? 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const left = this.remaining();
      if (left < 300) throw new HttpError(0, "time budget exhausted");
      const timeout = Math.min(o.timeoutMs ?? 8000, left - 100);
      try {
        const body = await this.once(url, o, timeout);
        if (ttl > 0) {
          memPut(key, body, ttl);
          if (this.ctx.cache && body.length < 200_000) {
            this.ctx.cache.put(key, body, { expirationTtl: Math.max(60, ttl) }).catch(() => undefined);
          }
        }
        this.addSource(o, url);
        return body;
      } catch (e) {
        lastErr = e;
        const st = e instanceof HttpError ? e.status : 0;
        const retryable = st === 0 || st === 429 || st >= 500;
        if (!retryable || attempt === retries) break;
        await sleep(Math.min(250 * (attempt + 1) * (st === 429 ? 3 : 1), Math.max(0, this.remaining() - 500)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async json<T = unknown>(url: string, o: FetchOpts): Promise<T> {
    const t = await this.text(url, o);
    try {
      return JSON.parse(t) as T;
    } catch {
      throw new HttpError(0, "invalid JSON");
    }
  }

  private addSource(o: FetchOpts, url: string): void {
    if (o.public === false) {
      this.sources.add(o.source);
      return;
    }
    let shown = o.source;
    try {
      const u = new URL(url);
      shown = `${o.source}: ${u.origin}${u.pathname}`;
    } catch {
      /* ignore */
    }
    this.sources.add(shown);
  }

  private async once(url: string, o: FetchOpts, timeoutMs: number): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { "user-agent": UA, accept: "application/json, */*;q=0.5", ...o.headers };
      if (o.body && !headers["content-type"]) headers["content-type"] = "application/json";
      const res = await this.ctx.fetch(url, { method: o.method ?? "GET", body: o.body, headers, signal: ac.signal, redirect: "follow" });
      const body = await readCapped(res, o.maxBytes ?? 4_000_000);
      if (!res.ok && o.jsonRpc && res.status !== 429 && body.trimStart().startsWith("{") && body.includes('"jsonrpc"')) return body;
      if (!res.ok) {
        const challenged = body.includes("Just a moment") || body.includes("cf-chl") || body.includes("challenge-platform");
        throw new HttpError(res.status, challenged ? `HTTP ${res.status} (bot challenge)` : `HTTP ${res.status}`);
      }
      return body;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (ac.signal.aborted) throw new HttpError(0, `timeout after ${timeoutMs} ms`);
      throw new HttpError(0, e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(0, `response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

/** Run a promise, returning undefined (and marking partial) on failure. */
export async function soft<T>(run: Run, source: string, p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    run.miss(source, e);
    return undefined;
  }
}

/** Read at most maxBytes, cancelling the rest of the stream. */
export async function readUpTo(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { text: new TextDecoder().decode(buf), truncated };
}
