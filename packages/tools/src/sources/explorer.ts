import type { Chain, ExplorerRef } from "../chains.js";
import type { Run } from "../util/http.js";

/**
 * Keyless explorer access. Blockscout v2 REST first, then Etherscan-compatible Routescan.
 * Many Blockscout instances sit behind a Cloudflare bot challenge for server traffic: every helper
 * returns null (and notes why) rather than throwing, so tools can fall back to RPC and GoPlus.
 */

/** Hosts that answered with a bot challenge or 403 are skipped for a while (circuit breaker). */
const BLOCKED = new Map<string, number>();
const BLOCK_MS = 10 * 60_000;

export function explorerBlocked(host: string): boolean {
  const until = BLOCKED.get(host);
  return until !== undefined && until > Date.now();
}

async function firstOf<T>(run: Run, chain: Chain, what: string, fn: (e: ExplorerRef) => Promise<T | null>): Promise<T | null> {
  if (chain.explorers.length === 0) {
    run.note(`no keyless explorer API for ${chain.name}: ${what} from fallbacks only`);
    return null;
  }
  for (const e of chain.explorers) {
    const host = new URL(e.base).host;
    if (explorerBlocked(host)) {
      run.note(`explorer API ${host} is blocking server requests; used fallbacks`);
      continue;
    }
    try {
      const r = await fn(e);
      if (r !== null) return r;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "error";
      if (/challenge|HTTP 403/.test(msg)) {
        BLOCKED.set(host, Date.now() + BLOCK_MS);
        run.note(`explorer API ${host} is blocking server requests; used fallbacks`);
      } else run.note(`explorer ${host} unavailable for ${what} (${msg.slice(0, 80)})`);
    }
  }
  return null;
}

export type Creation = { creator: string; tx: string | null; factory: string | null };

export async function contractCreation(run: Run, chain: Chain, address: string): Promise<Creation | null> {
  return firstOf(run, chain, "contract creator", async (e) => {
    if (e.type === "blockscout") {
      const j = await run.json<Record<string, unknown>>(`${e.base}/api/v2/addresses/${address}`, { source: "blockscout", ttl: 3600, timeoutMs: 7000, retries: 0 });
      const creator = (j.creator_address_hash ?? null) as string | null;
      const tx = (j.creation_transaction_hash ?? j.creation_tx_hash ?? null) as string | null;
      return creator ? { creator: creator.toLowerCase(), tx: tx?.toLowerCase() ?? null, factory: null } : null;
    }
    const j = await run.json<{ status: string; result?: { contractCreator: string; txHash: string; contractFactory?: string }[] | null }>(
      `${e.base}?module=contract&action=getcontractcreation&contractaddresses=${address}`,
      { source: "routescan", ttl: 3600, timeoutMs: 7000, retries: 0 },
    );
    const r = j.result?.[0];
    return r ? { creator: r.contractCreator.toLowerCase(), tx: r.txHash.toLowerCase(), factory: r.contractFactory ? r.contractFactory.toLowerCase() : null } : null;
  });
}

export type HolderRow = { address: string; raw: bigint; is_contract: boolean | null; label: string | null };
export type HolderList = { holders: HolderRow[]; holder_count: number | null; source: string };

export async function tokenHolders(run: Run, chain: Chain, token: string): Promise<HolderList | null> {
  return firstOf(run, chain, "token holders", async (e) => {
    if (e.type === "blockscout") {
      const [list, info] = await Promise.all([
        run.json<{ items?: { address: { hash: string; is_contract?: boolean; name?: string | null }; value: string }[] }>(`${e.base}/api/v2/tokens/${token}/holders`, {
          source: "blockscout",
          ttl: 120,
          timeoutMs: 8000,
          retries: 0,
        }),
        run.json<{ holders_count?: string; holders?: string }>(`${e.base}/api/v2/tokens/${token}`, { source: "blockscout", ttl: 120, timeoutMs: 8000, retries: 0 }).catch(() => null),
      ]);
      const items = list.items ?? [];
      const hc = info?.holders_count ?? info?.holders;
      return {
        holders: items.map((i) => ({ address: i.address.hash.toLowerCase(), raw: BigInt(i.value), is_contract: i.address.is_contract ?? null, label: i.address.name ?? null })),
        holder_count: hc ? Number(hc) : null,
        source: "blockscout",
      };
    }
    const j = await run.json<{ status: string; result?: { TokenHolderAddress: string; TokenHolderQuantity: string }[] | string }>(
      `${e.base}?module=token&action=tokenholderlist&contractaddress=${token}&page=1&offset=50`,
      { source: "routescan", ttl: 120, timeoutMs: 8000, retries: 0 },
    );
    if (!Array.isArray(j.result)) return null;
    return {
      holders: j.result.map((r) => ({ address: r.TokenHolderAddress.toLowerCase(), raw: BigInt(r.TokenHolderQuantity), is_contract: null, label: null })),
      holder_count: null,
      source: "routescan",
    };
  });
}

export type Deployed = { address: string; tx: string | null; timestamp: string | null };

/** Contracts the address deployed directly (top-level creation txs only; factory-made contracts are missed). */
export async function deployedBy(run: Run, chain: Chain, deployer: string): Promise<{ contracts: Deployed[]; scanned_txs: number; more: boolean } | null> {
  // Routescan's txlist marks creations reliably (contractAddress); prefer it where present.
  const ordered = { ...chain, explorers: [...chain.explorers].sort((a, b) => (a.type === "routescan" ? -1 : 0) - (b.type === "routescan" ? -1 : 0)) };
  return firstOf(run, ordered, "deployer history", async (e) => {
    if (e.type === "blockscout") {
      const out: Deployed[] = [];
      let url = `${e.base}/api/v2/addresses/${deployer}/transactions?filter=from`;
      let scanned = 0;
      let more = false;
      for (let page = 0; page < 3 && run.remaining() > 4000; page++) {
        const j = await run.json<{
          items?: { hash: string; timestamp?: string; created_contract?: { hash: string } | null; to?: unknown }[];
          next_page_params?: Record<string, string | number> | null;
        }>(url, { source: "blockscout", ttl: 600, timeoutMs: 8000, retries: 0 });
        for (const it of j.items ?? []) {
          scanned++;
          if (it.created_contract?.hash) out.push({ address: it.created_contract.hash.toLowerCase(), tx: it.hash.toLowerCase(), timestamp: it.timestamp ?? null });
        }
        if (!j.next_page_params) {
          more = false;
          break;
        }
        more = true;
        const qs = new URLSearchParams(Object.entries(j.next_page_params).map(([k, v]) => [k, String(v)]));
        url = `${e.base}/api/v2/addresses/${deployer}/transactions?filter=from&${qs.toString()}`;
      }
      return { contracts: out, scanned_txs: scanned, more };
    }
    const j = await run.json<{ status: string; result?: { hash: string; to: string; contractAddress: string; timeStamp: string; from: string }[] | string }>(
      `${e.base}?module=account&action=txlist&address=${deployer}&page=1&offset=1000&sort=desc`,
      { source: "routescan", ttl: 600, timeoutMs: 9000, retries: 0 },
    );
    if (!Array.isArray(j.result)) return null;
    const contracts = j.result
      .filter((t) => t.contractAddress && t.from.toLowerCase() === deployer)
      .map((t) => ({ address: t.contractAddress.toLowerCase(), tx: t.hash.toLowerCase(), timestamp: new Date(Number(t.timeStamp) * 1000).toISOString() }));
    return { contracts, scanned_txs: j.result.length, more: j.result.length >= 1000 };
  });
}

export type ExplorerSource = {
  verified: boolean;
  name: string | null;
  compiler: string | null;
  language: string | null;
  files: { path: string; content: string }[];
  abi: unknown[] | null;
  proxy_implementations: string[];
};

export async function explorerSource(run: Run, chain: Chain, address: string): Promise<ExplorerSource | null> {
  const bs = chain.explorers.filter((e) => e.type === "blockscout");
  if (bs.length === 0) return null;
  return firstOf(run, { ...chain, explorers: bs }, "verified source", async (e) => {
    const j = await run.json<Record<string, unknown>>(`${e.base}/api/v2/smart-contracts/${address}`, { source: "blockscout", ttl: 3600, timeoutMs: 8000, retries: 0, maxBytes: 6_000_000 });
    const files: { path: string; content: string }[] = [];
    if (typeof j.source_code === "string") files.push({ path: String(j.file_path ?? `${j.name ?? "Contract"}.sol`), content: j.source_code });
    for (const a of (j.additional_sources as { file_path: string; source_code: string }[] | undefined) ?? []) files.push({ path: a.file_path, content: a.source_code });
    const impls = ((j.implementations as { address?: string; address_hash?: string }[] | undefined) ?? []).map((i) => String(i.address ?? i.address_hash ?? "").toLowerCase()).filter(Boolean);
    return {
      verified: Boolean(j.is_verified ?? files.length > 0),
      name: (j.name as string) ?? null,
      compiler: (j.compiler_version as string) ?? null,
      language: (j.language as string) ?? null,
      files,
      abi: Array.isArray(j.abi) ? (j.abi as unknown[]) : null,
      proxy_implementations: impls,
    };
  });
}
