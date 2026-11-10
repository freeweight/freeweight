import type { Chain } from "../chains.js";
import type { Run } from "./http.js";
import { blockNumber, rpc, RpcError, TRANSFER_TOPIC } from "./rpc.js";

export type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };
export type Transfer = { from: string; to: string; value: bigint; block: number; tx: string };

const hex = (n: number) => "0x" + Math.max(0, Math.floor(n)).toString(16);

function isRangeError(e: unknown): boolean {
  if (!(e instanceof RpcError)) return false;
  return /span|range|too many|limit|exceed|more than|10000|narrow|block range|response size|timeout/i.test(e.message);
}

/** Estimate the block at a unix-ms timestamp (one refinement step). */
export async function blockAt(run: Run, chain: Chain, tsMs: number): Promise<number> {
  const head = await blockNumber(run, chain);
  const hb = await rpc<{ timestamp: string }>(run, chain, "eth_getBlockByNumber", [hex(head), false], { ttl: 5 });
  const headTs = Number(BigInt(hb.timestamp)) * 1000;
  let guess = head - Math.ceil((headTs - tsMs) / 1000 / chain.blockTime);
  if (guess <= 0) return 0;
  const gb = await rpc<{ timestamp: string } | null>(run, chain, "eth_getBlockByNumber", [hex(guess), false], { ttl: 3600 }).catch(() => null);
  if (gb?.timestamp) {
    const gTs = Number(BigInt(gb.timestamp)) * 1000;
    const rate = (headTs - gTs) / 1000 / Math.max(1, head - guess); // seconds per block, measured
    if (rate > 0) guess = head - Math.ceil((headTs - tsMs) / 1000 / rate);
  }
  return Math.max(0, guess);
}

/**
 * Address-filtered Transfer logs over [from, to], splitting ranges on provider limits.
 * Stops at maxCalls or maxLogs and reports complete=false.
 */
export async function scanTransfers(
  run: Run,
  chain: Chain,
  token: string,
  from: number,
  to: number,
  o: { maxCalls?: number; maxLogs?: number; topics?: (string | null)[] } = {},
): Promise<{ transfers: Transfer[]; complete: boolean; calls: number; scanned_from: number; scanned_to: number }> {
  const maxCalls = o.maxCalls ?? 12;
  const maxLogs = o.maxLogs ?? 40_000;
  const transfers: Transfer[] = [];
  let calls = 0;
  let span = Math.min(chain.logsSpan, to - from + 1);
  let cur = from;
  let complete = true;
  while (cur <= to) {
    if (calls >= maxCalls || run.remaining() < 2500 || transfers.length >= maxLogs) {
      complete = false;
      break;
    }
    const end = Math.min(to, cur + span - 1);
    calls++;
    try {
      const logs = await rpc<RawLog[]>(run, chain, "eth_getLogs", [{ address: token, topics: o.topics ?? [TRANSFER_TOPIC], fromBlock: hex(cur), toBlock: hex(end) }], { ttl: 0, timeoutMs: 9000 });
      for (const l of logs) {
        if (l.topics.length < 3 || l.topics[0] !== TRANSFER_TOPIC) continue;
        transfers.push({
          from: ("0x" + l.topics[1]!.slice(26)).toLowerCase(),
          to: ("0x" + l.topics[2]!.slice(26)).toLowerCase(),
          value: l.data && l.data !== "0x" ? BigInt(l.data.slice(0, 66)) : 0n,
          block: Number(BigInt(l.blockNumber)),
          tx: l.transactionHash,
        });
      }
      cur = end + 1;
    } catch (e) {
      if (isRangeError(e) && span > 1000) {
        // Use the provider's stated limit when it gives one ("only 10000000 are allowed", "over 10000 blocks").
        const m = /(\d[\d,]{2,})\s*(?:blocks|are allowed)/i.exec((e as Error).message);
        const stated = m ? Number(m[1]!.replace(/,/g, "")) : NaN;
        span = Number.isFinite(stated) && stated >= 100 && stated < span ? Math.floor(stated / 2) : Math.max(1000, Math.floor(span / 4));
        continue;
      }
      run.note(`getLogs stopped early on ${chain.key} (${e instanceof Error ? e.message.slice(0, 100) : "error"})`);
      complete = false;
      break;
    }
  }
  return { transfers, complete, calls, scanned_from: from, scanned_to: Math.min(to, cur - 1) };
}

/** Net balances from a complete transfer history. */
export function balancesFrom(transfers: Transfer[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const t of transfers) {
    m.set(t.from, (m.get(t.from) ?? 0n) - t.value);
    m.set(t.to, (m.get(t.to) ?? 0n) + t.value);
  }
  return m;
}
