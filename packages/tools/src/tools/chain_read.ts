import { decodeEventLog, decodeFunctionResult, encodeFunctionData, formatEther, parseAbiItem, type AbiEvent, type AbiFunction, type Hex } from "viem";
import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, InputError, int, short, str } from "../util/args.js";
import { blockNumber, isRevert, rpc, RpcError } from "../util/rpc.js";
import { cleanSnippet, quoteUntrusted } from "../util/page.js";

const OPS = ["call", "balance", "code", "logs", "receipt", "tx", "block", "storage", "nonce"] as const;
type Op = (typeof OPS)[number];
const MAX_LOG_BLOCKS = 10_000;
const MAX_LOGS_OUT = 100;

/** Short summary form of decoded call output: numbers, booleans and addresses as is; strings cleaned, capped, quoted. */
export function summarizeDecoded(v: unknown): string {
  const one = (x: unknown): string => {
    if (typeof x === "string") return /^0x[0-9a-fA-F]*$/.test(x) ? (x.length > 66 ? x.slice(0, 66) + "…" : x) : /^-?\d+$/.test(x) ? x : quoteUntrusted(x);
    if (Array.isArray(x)) return "[" + x.slice(0, 4).map(one).join(", ") + (x.length > 4 ? ", …" : "") + "]";
    if (x && typeof x === "object") return "{" + Object.entries(x).slice(0, 4).map(([k, y]) => `${k.slice(0, 20)}: ${one(y)}`).join(", ") + "}";
    return String(x);
  };
  return one(v).slice(0, 200);
}

/** Cap every string in a nested RPC result (node responses are not ours to trust for size). */
export function capStrings(v: unknown, max: number, depth = 0): unknown {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…" : v;
  if (depth > 6) return null;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => capStrings(x, max, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [k, capStrings(x, max, depth + 1)]));
  return v;
}

/** JSON-safe: bigint -> string, nested. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  return v;
}

function blockTag(v: unknown): string {
  if (v === undefined || v === null || v === "" || v === "latest") return "latest";
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return "0x" + v.toString(16);
  if (typeof v === "string" && /^(0x[0-9a-f]+|\d+)$/i.test(v)) return "0x" + BigInt(v).toString(16);
  if (v === "earliest" || v === "safe" || v === "finalized") return v;
  throw new InputError("invalid_input", "block must be a number, hex, or latest");
}

function parseSig<T extends "function" | "event">(sig: string, kind: T): T extends "function" ? AbiFunction : AbiEvent {
  let s = sig.trim();
  if (!s.startsWith(kind + " ")) s = `${kind} ${s}`;
  if (kind === "function" && !/\breturns\b/.test(s) && !/\b(view|pure)\b/.test(s)) s += " view";
  try {
    const item = parseAbiItem(s);
    if (item.type !== kind) throw new Error("wrong kind");
    return item as never;
  } catch (e) {
    throw new InputError("invalid_input", `cannot parse ${kind} signature: ${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 120) : ""}`);
  }
}

export const chainRead = defineTool({
  name: "chain_read",
  title: "Chain read",
  description:
    "Generic read-only chain access. op=call: eth_call a function by human-readable signature, e.g. signature 'function balanceOf(address) view returns (uint256)' with args ['0x…']. " +
    "op=balance|nonce|code|storage for an address; op=tx|receipt by hash; op=block by number; op=logs (address required, ≤10,000 blocks, optional event signature to decode). " +
    "No transaction is ever sent.",
  inputSchema: {
    type: "object",
    properties: {
      chain: CHAIN_PROP,
      op: { type: "string", enum: [...OPS] },
      to: { type: "string", description: "Contract address (call)." },
      address: { type: "string", description: "Address (balance, nonce, code, storage, logs)." },
      signature: { type: "string", description: "Function (call) or event (logs) signature, human-readable." },
      args: { type: "array", description: "Call arguments, in order. Large integers as strings." },
      from: { type: "string", description: "Optional caller for call." },
      hash: { type: "string", description: "Transaction hash (tx, receipt)." },
      slot: { type: "string", description: "Storage slot (hex)." },
      block: { description: "Block number or 'latest' (call, balance, storage, block)." },
      from_block: { description: "logs: start block (default: latest - 1000)." },
      to_block: { description: "logs: end block (default latest)." },
      topics: { type: "array", items: { type: ["string", "null"] }, maxItems: 4, description: "logs: topic filters." },
    },
    required: ["op"],
    additionalProperties: false,
  },
  run: async (args, run) => {
    const chain = chainArg(args);
    const op = args.op as Op;
    if (!OPS.includes(op)) throw new InputError("invalid_input", `op must be one of ${OPS.join(", ")}`);
    const base = { chain: chain.key, chain_id: chain.id, op };
    try {
      switch (op) {
        case "call": {
          const to = addr(args, "to")!;
          const sig = str(args, "signature", 1000);
          if (!sig) throw new InputError("invalid_input", "signature is required for call");
          const fn = parseSig(sig, "function");
          const a = Array.isArray(args.args) ? args.args : [];
          let data: Hex;
          try {
            data = encodeFunctionData({ abi: [fn], functionName: fn.name, args: a as never });
          } catch (e) {
            throw new InputError("invalid_input", `bad args for ${fn.name}: ${e instanceof Error ? e.message.split("\n")[0]!.slice(0, 160) : ""}`);
          }
          const from = addr(args, "from", false);
          const raw = await rpc<Hex>(run, chain, "eth_call", [{ to, data, ...(from ? { from } : {}) }, blockTag(args.block)], { ttl: 5 });
          let decoded: unknown = null;
          if (fn.outputs.length && raw && raw !== "0x") {
            try {
              decoded = jsonSafe(decodeFunctionResult({ abi: [fn], functionName: fn.name, data: raw }));
            } catch {
              decoded = null;
            }
          }
          // Decoded strings come from the contract: never raw in the summary.
          const shown = decoded === null ? raw.slice(0, 140) : summarizeDecoded(decoded);
          return { summary: `${fn.name}() on ${short(to)} (${chain.name}) = ${shown}`, data: { ...base, to, function: fn.name, raw: raw.length > 4000 ? raw.slice(0, 4000) + "…" : raw, decoded } };
        }
        case "balance":
        case "nonce":
        case "code": {
          const a = addr(args, "address")!;
          if (op === "balance") {
            const w = await rpc<string>(run, chain, "eth_getBalance", [a, blockTag(args.block)], { ttl: 5 });
            const eth = formatEther(BigInt(w));
            return { summary: `${short(a)} holds ${eth} ${chain.nativeSymbol} on ${chain.name}`, data: { ...base, address: a, balance_wei: BigInt(w).toString(), balance: Number(eth), unit: chain.nativeSymbol } };
          }
          if (op === "nonce") {
            const n = Number(BigInt(await rpc<string>(run, chain, "eth_getTransactionCount", [a, "latest"], { ttl: 5 })));
            return { summary: `${short(a)} has sent ${n} transaction(s) on ${chain.name} (nonce)`, data: { ...base, address: a, nonce: n } };
          }
          const code = await rpc<string>(run, chain, "eth_getCode", [a, "latest"], { ttl: 60 });
          const bytes = code === "0x" ? 0 : (code.length - 2) / 2;
          const delegated = code.startsWith("0xef0100") ? "0x" + code.slice(8, 48) : null;
          return {
            summary: bytes === 0 ? `${short(a)} has no code (an EOA or empty) on ${chain.name}` : delegated ? `${short(a)} is an EIP-7702 delegated wallet → ${short(delegated)}` : `${short(a)} is a contract (${bytes} bytes)`,
            data: { ...base, address: a, code_bytes: bytes, eip7702_delegate: delegated, code_prefix: code.slice(0, 200) },
          };
        }
        case "storage": {
          const a = addr(args, "address")!;
          const slot = str(args, "slot", 80);
          if (!slot || !/^0x[0-9a-fA-F]{1,64}$/.test(slot)) throw new InputError("invalid_input", "slot must be hex");
          const v = await rpc<string>(run, chain, "eth_getStorageAt", [a, slot, blockTag(args.block)], { ttl: 5 });
          return { summary: `storage[${slot}] of ${short(a)} = ${v}`, data: { ...base, address: a, slot, value: v } };
        }
        case "tx":
        case "receipt": {
          const h = str(args, "hash", 80);
          if (!h || !/^0x[0-9a-fA-F]{64}$/.test(h)) throw new InputError("invalid_input", "hash must be a 32-byte tx hash");
          const method = op === "tx" ? "eth_getTransactionByHash" : "eth_getTransactionReceipt";
          const r = await rpc<Record<string, unknown> | null>(run, chain, method, [h.toLowerCase()], { ttl: 30 });
          if (!r) return { summary: `${op} ${short(h)} not found on ${chain.name}`, data: { ...base, hash: h, result: null } };
          if (op === "tx") {
            const input = String(r.input ?? "0x");
            return {
              summary: `tx ${short(h)}: ${short(String(r.from))} → ${r.to ? short(String(r.to)) : "contract creation"}, value ${formatEther(BigInt(String(r.value ?? "0x0")))} ${chain.nativeSymbol}, selector ${input.slice(0, 10)}, block ${r.blockNumber ? Number(BigInt(String(r.blockNumber))) : "pending"}`,
              data: { ...base, hash: h, result: capStrings({ ...r, input: input.length > 2000 ? input.slice(0, 2000) + "…" : input }, 2002) },
            };
          }
          const logs = (r.logs as unknown[] | undefined) ?? [];
          return {
            summary: `receipt ${short(h)}: status ${r.status === "0x1" ? "success" : "REVERTED"}, ${logs.length} log(s), gas used ${r.gasUsed ? Number(BigInt(String(r.gasUsed))) : "?"}${r.contractAddress ? `, created ${short(String(r.contractAddress))}` : ""}`,
            data: { ...base, hash: h, result: capStrings({ ...r, logs: logs.slice(0, 50), logs_truncated: logs.length > 50 }, 602) },
          };
        }
        case "block": {
          const b = await rpc<Record<string, unknown> | null>(run, chain, "eth_getBlockByNumber", [blockTag(args.block), false], { ttl: 5 });
          if (!b) return { summary: "block not found", data: { ...base, result: null } };
          const txs = (b.transactions as unknown[]) ?? [];
          const n = Number(BigInt(String(b.number)));
          const ts = new Date(Number(BigInt(String(b.timestamp))) * 1000).toISOString();
          return { summary: `block ${n} at ${ts}, ${txs.length} tx(s)`, data: { ...base, number: n, timestamp: ts, hash: b.hash, tx_count: txs.length, transactions: txs.slice(0, 50) } };
        }
        case "logs": {
          const a = addr(args, "address")!;
          if (typeof args.from_block === "number" && typeof args.to_block === "number" && args.to_block - args.from_block > MAX_LOG_BLOCKS) {
            throw new InputError("invalid_input", `range too wide: at most ${MAX_LOG_BLOCKS} blocks per call`);
          }
          const head = await blockNumber(run, chain);
          const to = args.to_block === undefined ? head : Number(BigInt(blockTag(args.to_block) === "latest" ? head : blockTag(args.to_block)));
          const from = args.from_block === undefined ? Math.max(0, to - 1000) : Number(BigInt(blockTag(args.from_block) === "latest" ? head : blockTag(args.from_block)));
          if (to < from) throw new InputError("invalid_input", "to_block is before from_block");
          if (to - from > MAX_LOG_BLOCKS) throw new InputError("invalid_input", `range too wide: at most ${MAX_LOG_BLOCKS} blocks per call`);
          const sig = str(args, "signature", 1000);
          const ev = sig ? parseSig(sig, "event") : null;
          let topics = Array.isArray(args.topics) ? (args.topics as (string | null)[]) : [];
          if (topics.some((t) => t !== null && (typeof t !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(t)))) throw new InputError("invalid_input", "topics must be 32-byte hex or null");
          if (ev && topics.length === 0) {
            const { toEventSelector } = await import("viem");
            topics = [toEventSelector(ev)];
          }
          const logs = await rpc<{ topics: Hex[]; data: Hex; blockNumber: string; transactionHash: string; logIndex: string }[]>(
            run,
            chain,
            "eth_getLogs",
            [{ address: a, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), ...(topics.length ? { topics } : {}) }],
            { ttl: 0, timeoutMs: 10_000 },
          );
          const out = logs.slice(0, MAX_LOGS_OUT).map((l) => {
            let decoded: unknown = null;
            if (ev) {
              try {
                const d = decodeEventLog({ abi: [ev], data: l.data, topics: l.topics as [Hex, ...Hex[]] });
                decoded = jsonSafe(d.args);
              } catch {
                decoded = null;
              }
            }
            return { block: Number(BigInt(l.blockNumber)), tx: l.transactionHash, log_index: Number(BigInt(l.logIndex)), topics: l.topics, data: l.data.length > 600 ? l.data.slice(0, 600) + "…" : l.data, decoded };
          });
          return {
            summary: `${logs.length} log(s) from ${short(a)} in blocks ${from}–${to}${logs.length > MAX_LOGS_OUT ? ` (first ${MAX_LOGS_OUT} returned)` : ""}${ev ? `, decoded as ${ev.name}` : ""}`,
            data: { ...base, address: a, from_block: from, to_block: to, total: logs.length, logs: out },
          };
        }
      }
    } catch (e) {
      if (isRevert(e)) {
        // A revert string is written by the contract's author: data only, never the summary.
        return {
          ok: false,
          summary: `the call reverted on ${chain.name}`,
          data: { ...base, reverted: true, revert_reason_untrusted: cleanSnippet(e instanceof Error ? e.message : "", 200) },
          error: { code: "reverted", message: "the call reverted" },
        };
      }
      if (e instanceof RpcError) return { ok: false, summary: `RPC error (code ${e.code})`, data: { ...base, rpc_error: { code: e.code, message_untrusted: cleanSnippet(e.message, 200) } } };
      throw e;
    }
    throw new InputError("invalid_input", "unsupported op");
  },
});
