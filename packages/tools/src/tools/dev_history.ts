import { defineTool } from "../tool.js";
import { addr, chainArg, CHAIN_PROP, fmtPct, fmtUsd, round, short, TOKEN_PROP } from "../util/args.js";
import { soft, type Run } from "../util/http.js";
import { balanceOf, blockNumber, erc20Meta, rpc, rpcBatch, TRANSFER_TOPIC, units } from "../util/rpc.js";
import { blockAt, scanTransfers } from "../util/logs.js";
import { creatorOf } from "../sources/common.js";
import { deployedBy } from "../sources/explorer.js";
import { goplusToken } from "../sources/goplus.js";
import { pickMainPool, tokenPairs, type DsPair } from "../sources/dexscreener.js";
import type { Chain } from "../chains.js";
import { encodeFunctionData, parseAbi, decodeFunctionResult, type Hex } from "viem";

const ZERO_TOPIC = "0x" + "0".repeat(64);
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const SYM = parseAbi(["function symbol() view returns (string)"]);

/** Find the mint transaction and its sender (the real launcher when the creator is a factory). */
async function findLauncher(run: Run, chain: Chain, token: string, startMs: number | null): Promise<{ tx: string; from: string; block: number } | null> {
  const head = await blockNumber(run, chain);
  const from = startMs ? await blockAt(run, chain, startMs) : Math.max(0, head - 30 * chain.logsSpan);
  const scan = await scanTransfers(run, chain, token, from, head, { maxCalls: chain.id === 4663 ? 12 : 4, maxLogs: 2000, topics: [TRANSFER_TOPIC, ZERO_TOPIC] });
  const first = scan.transfers.sort((a, b) => a.block - b.block)[0];
  if (!first) return null;
  const tx = await rpc<{ from: string } | null>(run, chain, "eth_getTransactionByHash", [first.tx], { ttl: 86400 });
  return tx ? { tx: first.tx.toLowerCase(), from: tx.from.toLowerCase(), block: first.block } : null;
}

export const devHistory = defineTool({
  name: "dev_history",
  title: "Developer history",
  description:
    "Who launched this token and what happened to their other tokens: creator (and the real launcher when a factory/launchpad created it), " +
    "other contracts the launcher deployed with their current DexScreener state (liquidity, FDV, age), and the launcher's balance and in/out flow of this token. " +
    "Explorer-dependent: full history where a keyless explorer answers (e.g. Ethereum); elsewhere creator + flows only.",
  inputSchema: {
    type: "object",
    properties: { chain: CHAIN_PROP, token: TOKEN_PROP, dev: { type: "string", description: "Optional: the developer wallet to profile instead of the detected one." } },
    required: ["token"],
    additionalProperties: false,
  },
  enrich: (a) => ({ chain: chainArg(a), token: addr(a, "token")! }),
  run: async (args, run) => {
    const chain = chainArg(args);
    const token = addr(args, "token")!;
    const devArg = addr(args, "dev", false);
    const [meta, creator, pairs, gp] = await Promise.all([
      erc20Meta(run, chain, token),
      creatorOf(run, chain, token),
      soft(run, "dexscreener", tokenPairs(run, chain, token)),
      chain.goplus ? soft(run, "goplus", goplusToken(run, chain, token)) : Promise.resolve(undefined),
    ]);
    const firstPool = (pairs ?? []).map((p) => p.pairCreatedAt ?? 0).filter((x) => x > 0).sort((a, b) => a - b)[0] ?? null;
    const startMs = creator.created_at ? Date.parse(creator.created_at) - 3_600_000 : firstPool ? firstPool - 2 * 86_400_000 : null;

    let launcher: string | null = devArg ?? null;
    let launchTx: string | null = creator.tx;
    let launchBlock: number | null = null;
    let launcherVia = devArg ? "input" : "";
    if (!launcher && creator.creator && creator.creator_is_contract === false) {
      launcher = creator.creator;
      launcherVia = `creator (${creator.via})`;
    }
    if (!launcher) {
      const l = await findLauncher(run, chain, token, startMs).catch((e) => {
        run.note(`mint-transaction lookup failed (${e instanceof Error ? e.message.slice(0, 80) : "error"})`);
        return null;
      });
      if (l) {
        launcher = l.from;
        launchTx = l.tx;
        launchBlock = l.block;
        launcherVia = "sender of the mint transaction";
      }
    }
    if (!launcher) {
      return {
        summary: `Could not identify who launched ${short(token)} on ${chain.name}${creator.creator ? ` (creator ${short(creator.creator)} is a contract)` : ""}.`,
        data: { chain: chain.key, chain_id: chain.id, token, creator: creator.creator, creator_is_contract: creator.creator_is_contract ?? null, launcher: null },
      };
    }

    // Other deployments (explorer only).
    const deployed = await deployedBy(run, chain, launcher).catch(() => null);
    const others = (deployed?.contracts ?? []).filter((c) => c.address !== token).slice(0, 25);
    let otherRows: Record<string, unknown>[] = [];
    if (others.length) {
      const addrs = others.map((o) => o.address);
      const [dsAll, syms] = await Promise.all([
        soft(run, "dexscreener", run.json<DsPair[]>(`https://api.dexscreener.com/tokens/v1/${chain.dexscreener}/${addrs.slice(0, 30).join(",")}`, { source: "dexscreener", ttl: 120 })),
        rpcBatch(run, chain, addrs.map((a) => ({ method: "eth_call", params: [{ to: a, data: encodeFunctionData({ abi: SYM, functionName: "symbol" }) }, "latest"] }))).catch(() => []),
      ]);
      otherRows = others.map((o, i) => {
        const ps = (dsAll ?? []).filter((p) => p.baseToken.address.toLowerCase() === o.address || p.quoteToken.address.toLowerCase() === o.address);
        const { main } = pickMainPool(ps, o.address);
        let symbol: string | null = null;
        const raw = syms[i];
        if (typeof raw === "string" && raw.length > 2) {
          try {
            symbol = decodeFunctionResult({ abi: SYM, functionName: "symbol", data: raw as Hex }) as string;
          } catch {
            symbol = null;
          }
        }
        return {
          address: o.address,
          symbol,
          deployed_at: o.timestamp,
          is_token: symbol !== null,
          dex: main ? { liquidity_usd: round(main.liquidity?.usd ?? null), fdv_usd: round(main.fdv ?? null), volume_24h_usd: round(main.volume?.h24 ?? null), pair_created_at: main.pairCreatedAt ? new Date(main.pairCreatedAt).toISOString() : null } : null,
        };
      });
    }
    const tokens = otherRows.filter((r) => r.is_token);
    const live = tokens.filter((r) => ((r.dex as { liquidity_usd?: number } | null)?.liquidity_usd ?? 0) >= 10_000);
    const dead = tokens.filter((r) => r.dex === null || ((r.dex as { liquidity_usd?: number }).liquidity_usd ?? 0) < 1000);

    // Launcher's flow of this token.
    const dec = meta.decimals ?? 18;
    const supply = meta.totalSupply ?? 0n;
    const bal = await balanceOf(run, chain, token, launcher);
    let flow: Record<string, unknown> | null = null;
    if (run.remaining() > 4000) {
      const head = await blockNumber(run, chain).catch(() => null);
      const from = launchBlock ?? (startMs ? await blockAt(run, chain, startMs).catch(() => null) : null);
      if (head !== null && from !== null && (head - from) / chain.logsSpan <= 12) {
        const [outS, inS] = await Promise.all([
          scanTransfers(run, chain, token, from, head, { maxCalls: 12, maxLogs: 5000, topics: [TRANSFER_TOPIC, pad(launcher)] }),
          scanTransfers(run, chain, token, from, head, { maxCalls: 12, maxLogs: 5000, topics: [TRANSFER_TOPIC, null, pad(launcher)] }),
        ]);
        const sent = outS.transfers.reduce((s, t) => s + t.value, 0n);
        const recv = inS.transfers.reduce((s, t) => s + t.value, 0n);
        const recipients = new Map<string, bigint>();
        for (const t of outS.transfers) recipients.set(t.to, (recipients.get(t.to) ?? 0n) + t.value);
        flow = {
          complete: outS.complete && inS.complete,
          received: units(recv, dec),
          sent: units(sent, dec),
          sent_pct_supply: supply > 0n ? round(Number((sent * 1_000_000n) / supply) / 10_000, 4) : null,
          out_transfers: outS.transfers.length,
          top_recipients: [...recipients.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 5).map(([a, v]) => ({ address: a, amount: units(v, dec) })),
          from_block: from,
        };
      } else run.note("launcher flow not computed: token too old for a keyless log scan");
    }

    const parts: string[] = [];
    parts.push(`${meta.symbol ? "$" + meta.symbol : short(token)} on ${chain.name} launched by ${short(launcher)} (${launcherVia})`);
    if (creator.creator && creator.creator !== launcher) parts.push(`via contract ${short(creator.creator)}`);
    if (deployed) parts.push(`${tokens.length} other token(s) deployed directly by this wallet${deployed.more ? " (more not scanned)" : ""}: ${live.length} with ≥$10k liquidity now, ${dead.length} dead or unlisted`);
    else parts.push("other deployments unknown (no keyless explorer answered)");
    if (bal !== null) parts.push(`launcher holds ${fmtPct(supply > 0n ? Number((bal * 1_000_000n) / supply) / 10_000 : null)} of supply`);
    if (flow) parts.push(`sent ${fmtPct(flow.sent_pct_supply as number | null)} of supply out (${flow.out_transfers} transfers${flow.complete ? "" : ", partial"})`);
    if (gp?.honeypot_with_same_creator === "1") parts.push("GoPlus: this creator has made a honeypot before");
    const best = [...live].sort((a, b) => ((b.dex as { fdv_usd: number }).fdv_usd ?? 0) - ((a.dex as { fdv_usd: number }).fdv_usd ?? 0))[0];
    if (best) parts.push(`best other: ${best.symbol ?? short(best.address as string)} FDV ${fmtUsd((best.dex as { fdv_usd: number }).fdv_usd)}`);
    run.note("Direct deployments only: tokens made through a launchpad by the same wallet do not show as its deployments.");

    return {
      summary: parts.join("; ") + ".",
      data: {
        chain: chain.key,
        chain_id: chain.id,
        token,
        creator: creator.creator,
        creator_is_contract: creator.creator_is_contract ?? null,
        launcher,
        launcher_found_via: launcherVia,
        launch_tx: launchTx,
        launcher_balance: units(bal, dec),
        launcher_balance_pct: bal !== null && supply > 0n ? round(Number((bal * 1_000_000n) / supply) / 10_000, 4) : null,
        launcher_flow: flow,
        other_deployments: otherRows,
        other_deployments_scanned_txs: deployed?.scanned_txs ?? null,
        goplus_honeypot_with_same_creator: gp?.honeypot_with_same_creator === undefined ? null : gp.honeypot_with_same_creator === "1",
        unit: "amounts in token units",
      },
    };
  },
});
