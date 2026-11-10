import { resolveChain, supportedChainsText, type Chain } from "../chains.js";

export class InputError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function isAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s.trim());
}

export function addr(args: Record<string, unknown>, key: string, required = true): string | null {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new InputError("invalid_input", `${key} is required (0x-prefixed 20-byte address)`);
    return null;
  }
  if (!isAddress(v)) throw new InputError("invalid_input", `${key} must be a 0x-prefixed 20-byte address`);
  return v.trim().toLowerCase();
}

export function chainArg(args: Record<string, unknown>): Chain {
  const c = resolveChain(args.chain);
  if (!c) throw new InputError("unsupported_chain", `unknown chain ${JSON.stringify(args.chain)}; supported: ${supportedChainsText()}`);
  return c;
}

export function str(args: Record<string, unknown>, key: string, max = 500): string | null {
  const v = args[key];
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new InputError("invalid_input", `${key} must be a string`);
  if (v.length > max) throw new InputError("invalid_input", `${key} is longer than ${max} characters`);
  return v.trim();
}

export function int(args: Record<string, unknown>, key: string, dflt: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === "") return dflt;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new InputError("invalid_input", `${key} must be a number`);
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export const CHAIN_PROP = {
  type: "string",
  description: "Chain name or id. Default robinhood (4663). Also: ethereum, base, bsc, arbitrum, optimism, polygon.",
};
export const TOKEN_PROP = { type: "string", description: "Token contract address (0x…)." };

export function short(a: string | null | undefined): string {
  if (!a) return "?";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}k`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return "$0";
  return `$${n.toPrecision(3)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return `${n.toFixed(digits)}%`;
}

export function fmtAge(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "unknown age";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.round(ms / 60_000)} min`;
  if (h < 48) return `${h.toFixed(1)} h`;
  return `${Math.round(h / 24)} d`;
}

export function round(n: number | null | undefined, sig = 6): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  if (n === 0) return 0;
  return Number(n.toPrecision(sig));
}
