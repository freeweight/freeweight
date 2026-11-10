import type { Chain } from "../chains.js";
import type { Run } from "../util/http.js";
import { rpc } from "../util/rpc.js";
import { contractCreation } from "./explorer.js";
import { goplusToken } from "./goplus.js";

export type CreatorInfo = { creator: string | null; tx: string | null; created_at: string | null; via: string | null; creator_is_contract?: boolean | null };

/** Unix ms of a transaction's block, via RPC. */
export async function txTime(run: Run, chain: Chain, tx: string): Promise<number | null> {
  const t = await rpc<{ blockNumber?: string } | null>(run, chain, "eth_getTransactionByHash", [tx], { ttl: 86400 });
  if (!t?.blockNumber) return null;
  const b = await rpc<{ timestamp?: string } | null>(run, chain, "eth_getBlockByNumber", [t.blockNumber, false], { ttl: 86400 });
  return b?.timestamp ? Number(BigInt(b.timestamp)) * 1000 : null;
}

/** Creator + creation time: explorer first, GoPlus creator as a fallback (no time then). */
export async function creatorOf(run: Run, chain: Chain, token: string): Promise<CreatorInfo> {
  const info = await creatorRaw(run, chain, token);
  if (info.creator) {
    const code = await rpc<string>(run, chain, "eth_getCode", [info.creator, "latest"], { ttl: 3600 }).catch(() => null);
    // EIP-7702 delegated EOAs have code 0xef0100…; they are still wallets.
    info.creator_is_contract = code === null ? null : code !== "0x" && !code.startsWith("0xef0100");
    if (info.creator_is_contract) run.note("The recorded creator is a contract (a launchpad or factory): the person behind the launch is the sender of the creation transaction, not this address.");
  }
  return info;
}

async function creatorRaw(run: Run, chain: Chain, token: string): Promise<CreatorInfo> {
  const c = await contractCreation(run, chain, token).catch(() => null);
  if (c) {
    const ms = c.tx ? await txTime(run, chain, c.tx).catch(() => null) : null;
    return { creator: c.creator, tx: c.tx, created_at: ms ? new Date(ms).toISOString() : null, via: "explorer" };
  }
  const g = await goplusToken(run, chain, token).catch(() => null);
  if (g?.creator_address) return { creator: g.creator_address.toLowerCase(), tx: null, created_at: null, via: "goplus" };
  return { creator: null, tx: null, created_at: null, via: null };
}
