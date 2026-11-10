import { decodeFunctionResult, encodeFunctionData, hexToString, parseAbi, type Hex } from "viem";
import { rpcUrls, type Chain } from "../chains.js";
import { HttpError, type Run } from "./http.js";

/** JSON-RPC methods any tool (and chain_read) may call. Read-only. */
export const RPC_ALLOW = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_call",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getTransactionCount",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_estimateGas",
]);

export class RpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

/** Small per-host concurrency gate so we don't trip public RPC 429s. */
const inflight = new Map<string, number>();
async function gate<T>(host: string, max: number, fn: () => Promise<T>): Promise<T> {
  while ((inflight.get(host) ?? 0) >= max) await new Promise((r) => setTimeout(r, 25));
  inflight.set(host, (inflight.get(host) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    inflight.set(host, (inflight.get(host) ?? 1) - 1);
  }
}

let rpcId = 1;

export type RpcOpts = { ttl?: number; timeoutMs?: number };

/**
 * One JSON-RPC call with failover across the chain's RPC list.
 * JSON-RPC errors (revert, invalid params) are thrown as RpcError and NOT retried on another endpoint,
 * except "limit" style errors which are passed up so callers can shrink ranges.
 */
export async function rpc<T = unknown>(run: Run, chain: Chain, method: string, params: unknown[], o: RpcOpts = {}): Promise<T> {
  if (!RPC_ALLOW.has(method)) throw new RpcError(-32601, `method ${method} not allowed`);
  const urls = rpcUrls(chain, run.ctx.env.RPC_URLS);
  const body = JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params });
  const cacheKey = `rpc:${chain.id}:${method}:${JSON.stringify(params)}`;
  let last: unknown;
  for (const url of urls) {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      /* ignore */
    }
    try {
      const txt = await gate(host, 4, () =>
        run.text(url, {
          source: `rpc ${chain.key}`,
          method: "POST",
          body,
          cacheKey,
          ttl: o.ttl ?? 0,
          timeoutMs: o.timeoutMs ?? 7000,
          retries: 1,
          public: false,
          jsonRpc: true,
        }),
      );
      const j = JSON.parse(txt) as { result?: T; error?: { code: number; message: string; data?: unknown } };
      if (j.error) throw new RpcError(j.error.code, j.error.message, j.error.data);
      return j.result as T;
    } catch (e) {
      last = e;
      if (e instanceof RpcError) throw e;
      if (e instanceof HttpError && e.message.includes("time budget")) throw e;
    }
  }
  throw last instanceof Error ? last : new Error("rpc failed");
}

const ERC20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function owner() view returns (address)",
]);

export async function ethCall(run: Run, chain: Chain, to: string, data: Hex, o: RpcOpts & { from?: string; block?: string } = {}): Promise<Hex> {
  const tx: Record<string, string> = { to, data };
  if (o.from) tx.from = o.from;
  return rpc<Hex>(run, chain, "eth_call", [tx, o.block ?? "latest"], o);
}

async function readString(run: Run, chain: Chain, token: string, fn: "name" | "symbol"): Promise<string | null> {
  const raw = await ethCall(run, chain, token, encodeFunctionData({ abi: ERC20, functionName: fn }), { ttl: 3600 });
  if (!raw || raw === "0x") return null;
  try {
    return decodeFunctionResult({ abi: ERC20, functionName: fn, data: raw }) as string;
  } catch {
    // bytes32-style (e.g. MKR)
    if (raw.length === 66) {
      try {
        return hexToString(raw, { size: 32 }).replace(/\0+$/, "");
      } catch {
        return null;
      }
    }
    return null;
  }
}

export type Erc20Meta = { name: string | null; symbol: string | null; decimals: number | null; totalSupply: bigint | null; isContract: boolean };

export async function erc20Meta(run: Run, chain: Chain, token: string): Promise<Erc20Meta> {
  const [code, name, symbol, decRaw, tsRaw] = await Promise.all([
    rpc<string>(run, chain, "eth_getCode", [token, "latest"], { ttl: 600 }).catch(() => null),
    readString(run, chain, token, "name").catch(() => null),
    readString(run, chain, token, "symbol").catch(() => null),
    ethCall(run, chain, token, encodeFunctionData({ abi: ERC20, functionName: "decimals" }), { ttl: 3600 }).catch(() => null),
    ethCall(run, chain, token, encodeFunctionData({ abi: ERC20, functionName: "totalSupply" }), { ttl: 60 }).catch(() => null),
  ]);
  const dec = decRaw && decRaw !== "0x" ? Number(BigInt(decRaw.slice(0, 66))) : null;
  const ts = tsRaw && tsRaw !== "0x" ? BigInt(tsRaw.slice(0, 66)) : null;
  return { name, symbol, decimals: dec !== null && dec <= 255 ? dec : null, totalSupply: ts, isContract: !!code && code !== "0x" };
}

export async function balanceOf(run: Run, chain: Chain, token: string, holder: string): Promise<bigint | null> {
  try {
    const raw = await ethCall(run, chain, token, encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [holder as Hex] }), { ttl: 30 });
    return raw && raw !== "0x" ? BigInt(raw.slice(0, 66)) : null;
  } catch {
    return null;
  }
}

export async function ownerOf(run: Run, chain: Chain, contract: string): Promise<string | null> {
  try {
    const raw = await ethCall(run, chain, contract, encodeFunctionData({ abi: ERC20, functionName: "owner" }), { ttl: 300 });
    if (!raw || raw.length < 66) return null;
    return ("0x" + raw.slice(26, 66)).toLowerCase();
  } catch {
    return null;
  }
}

export async function blockNumber(run: Run, chain: Chain): Promise<number> {
  return Number(BigInt(await rpc<string>(run, chain, "eth_blockNumber", [], { ttl: 2 })));
}

/** Format a raw integer amount with decimals into a JS number (token units). */
export function units(raw: bigint | null | undefined, decimals: number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const d = decimals ?? 18;
  const s = raw.toString().padStart(d + 1, "0");
  const whole = s.slice(0, s.length - d);
  const frac = s.slice(s.length - d, s.length - d + 8);
  return Number(`${whole}.${frac || "0"}`);
}

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * JSON-RPC batch (one HTTP request). Returns per-call results, null for a failed item.
 * Falls back to individual calls if the endpoint rejects batches.
 */
export async function rpcBatch(run: Run, chain: Chain, calls: { method: string; params: unknown[] }[]): Promise<(unknown | null)[]> {
  if (calls.length === 0) return [];
  for (const c of calls) if (!RPC_ALLOW.has(c.method)) throw new RpcError(-32601, `method ${c.method} not allowed`);
  const urls = rpcUrls(chain, run.ctx.env.RPC_URLS);
  const base = rpcId;
  rpcId += calls.length;
  const body = JSON.stringify(calls.map((c, i) => ({ jsonrpc: "2.0", id: base + i, method: c.method, params: c.params })));
  for (const url of urls) {
    try {
      const txt = await run.text(url, { source: `rpc ${chain.key}`, method: "POST", body, ttl: 0, timeoutMs: 8000, retries: 1, public: false });
      const arr = JSON.parse(txt) as { id: number; result?: unknown; error?: unknown }[];
      if (!Array.isArray(arr)) continue;
      const byId = new Map(arr.map((r) => [r.id, r]));
      return calls.map((_, i) => {
        const r = byId.get(base + i);
        return r && r.error === undefined ? (r.result ?? null) : null;
      });
    } catch (e) {
      if (e instanceof HttpError && e.message.includes("time budget")) throw e;
    }
  }
  return Promise.all(calls.map((c) => rpc(run, chain, c.method, c.params).catch(() => null)));
}

export function balanceOfData(holder: string): Hex {
  return encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [holder as Hex] });
}
