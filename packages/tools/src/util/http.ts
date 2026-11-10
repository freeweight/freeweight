import type { ToolCtx } from "../types.js";

/** Total wall-clock budget for one tool call. */
export const TOOL_BUDGET_MS = 15_000;
const UA = "freeweight-tools/0.1 (+read-only token toolkit)";

/**
 * In-memory cache, one per isolate, shared by every request in it. Budgeted by bytes (an isolate has 128 MB), LRU.
 * Bytes are counted exactly for one-byte strings and doubled when a value holds any character above U+00FF.
 */
export const MEM_MAX_BYTES = 16 * 1024 * 1024;
export const MEM_ENTRY_MAX_BYTES = 256 * 1024;
type MemEntry = { exp: number; value: string; bytes: number };
const MEM = new Map<string, MemEntry>();
let memBytes = 0;

function sizeOf(s: string): number {
  // eslint-disable-next-line no-control-regex
  return /[^\u0000-\u00ff]/.test(s) ? s.length * 2 : s.length;
}

function memDelete(key: string): void {
  const e = MEM.get(key);
  if (e) {
    memBytes -= e.bytes + key.length;
    MEM.delete(key);
  }
}

function memGet(key: string): string | undefined {
  const e = MEM.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) {
    memDelete(key);
    return undefined;
  }
  // LRU: move to the end.
  MEM.delete(key);
  MEM.set(key, e);
  return e.value;
}

function memPut(key: string, value: string, ttlS: number): void {
  const bytes = sizeOf(value);
  if (bytes > MEM_ENTRY_MAX_BYTES || key.length > 2048) return;
  memDelete(key);
  while (memBytes + bytes + key.length > MEM_MAX_BYTES && MEM.size > 0) {
    const oldest = MEM.keys().next().value;
    if (oldest === undefined) break;
    memDelete(oldest);
  }
  MEM.set(key, { exp: Date.now() + ttlS * 1000, value, bytes });
  memBytes += bytes + key.length;
}

/** Test hooks. */
export function clearMemCache(): void {
  MEM.clear();
  memBytes = 0;
}
export function memCacheBytes(): number {
  return memBytes;
}

/** Hard cap on outbound requests per tool call (Workers count subrequests per invocation; DoH included). */
export const MAX_SUBREQUESTS = 40;
/** At most this many KV writes per tool call. */
export const MAX_KV_WRITES = 4;
/** Shared (KV) caching only for entries that live at least this long. */
export const KV_MIN_TTL_S = 60;

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
  /** Body check for APIs that signal errors inside a 200 (e.g. rate limits): false = not cached, retried as a 429. */
  validate?: (body: string) => boolean;
  /** Return non-2xx bodies that are JSON-RPC error objects instead of throwing (RPC endpoints). */
  jsonRpc?: boolean;
  /**
   * Also cache in the shared KV (ctx.cache). Only for stable, worth-sharing responses under bounded keys (index facts,
   * source verification, RDAP, creation records, token security); written only when ttl >= 60 s.
   */
  share?: boolean;
  /**
   * "manual" refuses redirects (the request fails). Default: "manual" for private requests (public: false) because they
   * may carry keys, which fetch would replay to the redirect target; "follow" otherwise.
   */
  redirect?: "follow" | "manual";
};

/**
 * One tool invocation: carries the deadline, collected sources and notes, and the partial flag.
 */
export class Run {
  readonly deadline: number;
  readonly sources = new Set<string>();
  readonly notes: string[] = [];
  partial = false;
  /** Outbound requests made by this call (cache hits excluded). */
  subrequests = 0;
  kvWrites = 0;
  private readonly inflight = new Map<string, Promise<string>>();

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

  /** Count one outbound request; throws once the per-call budget is used up. */
  spend(): void {
    if (this.subrequests >= MAX_SUBREQUESTS) {
      this.partial = true;
      this.note(`request budget for this call reached (${MAX_SUBREQUESTS} upstream requests): some sources were skipped`);
      throw new HttpError(0, "request budget exhausted");
    }
    this.subrequests++;
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
      if (this.ctx.cache && o.share && ttl >= KV_MIN_TTL_S) {
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
      // Coalesce identical in-flight requests within this call (two sources asking for the same GoPlus record).
      const pending = this.inflight.get(key);
      if (pending) {
        const body = await pending;
        this.addSource(o, url);
        return body;
      }
      const p = this.fetchWithRetry(url, o, key, ttl);
      this.inflight.set(key, p);
      try {
        return await p;
      } finally {
        this.inflight.delete(key);
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
        if (o.validate && !o.validate(body)) throw new HttpError(429, `rejected response (${body.slice(0, 60)})`);
        if (ttl > 0) {
          memPut(key, body, ttl);
          if (this.ctx.cache && o.share && ttl >= KV_MIN_TTL_S && body.length <= MEM_ENTRY_MAX_BYTES && this.kvWrites < MAX_KV_WRITES) {
            this.kvWrites++;
            this.ctx.cache.put(key, body, { expirationTtl: ttl }).catch(() => undefined);
          }
        }
        this.addSource(o, url);
        return body;
      } catch (e) {
        lastErr = e;
        const st = e instanceof HttpError ? e.status : 0;
        const retryable = (st === 0 || st === 429 || st >= 500) && !(e instanceof Error && /budget|redirect refused/.test(e.message));
        if (!retryable || attempt === retries) break;
        await sleep(Math.min(250 * (attempt + 1) * (st === 429 ? 4 : 1), Math.max(0, this.remaining() - 500)));
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
    this.spend();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const redirect = o.redirect ?? (o.public === false ? "manual" : "follow");
    try {
      const headers: Record<string, string> = { "user-agent": UA, accept: "application/json, */*;q=0.5", ...o.headers };
      if (o.body && !headers["content-type"]) headers["content-type"] = "application/json";
      const res = await this.ctx.fetch(url, { method: o.method ?? "GET", body: o.body, headers, signal: ac.signal, redirect });
      if (redirect === "manual" && (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400))) {
        await res.body?.cancel().catch(() => undefined);
        throw new HttpError(res.status, "redirect refused (keyed request)");
      }
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
