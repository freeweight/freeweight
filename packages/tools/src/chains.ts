/**
 * Chain registry. Add a chain by appending an entry; every field except id/name/rpcs is optional.
 * RPC URLs can be overridden at runtime through ctx.env.RPC_URLS (key = id or any alias).
 */
export type ExplorerRef =
  | { type: "blockscout"; base: string }
  | { type: "routescan"; base: string };

export type Chain = {
  id: number;
  key: string;
  name: string;
  aliases: string[];
  nativeSymbol: string;
  /** CoinGecko id of the native coin (for market_data majors). */
  nativeCoingecko?: string;
  /** Wrapped native token address (lowercase). */
  wrappedNative?: string;
  rpcs: string[];
  /** Tried in order. Blockscout v2 REST and Etherscan-compatible Routescan, both keyless. */
  explorers: ExplorerRef[];
  /** Human explorer for links. */
  explorerUi?: string;
  dexscreener?: string;
  goplus?: string;
  /** Approximate block time in seconds, used to size getLogs windows. */
  blockTime: number;
  /** Max blocks per address-filtered getLogs call we are willing to try. */
  logsSpan: number;
  /** Max concurrent single RPC calls per host (public endpoints rate-limit bursts). */
  rpcConcurrency?: number;
  /** Uniswap v4 singleton + position manager (for the v4 sell simulation). */
  v4?: { poolManager: string; positionManager: string };
};

export const CHAINS: Chain[] = [
  {
    id: 4663,
    key: "robinhood",
    v4: { poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951", positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7" },
    name: "Robinhood Chain",
    aliases: ["robinhood", "rh", "robinhood-chain", "robinhoodchain", "hood"],
    nativeSymbol: "ETH",
    nativeCoingecko: "ethereum",
    wrappedNative: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
    rpcs: ["https://rpc.mainnet.chain.robinhood.com", "https://robinhood.drpc.org"],
    explorers: [{ type: "blockscout", base: "https://robinhoodchain.blockscout.com" }],
    explorerUi: "https://robinhoodchain.blockscout.com",
    dexscreener: "robinhood",
    goplus: "4663",
    blockTime: 0.1,
    logsSpan: 10_000_000,
    rpcConcurrency: 2,
  },
  {
    id: 1,
    key: "ethereum",
    v4: { poolManager: "0x000000000004444c5dc75cb358380d2e3de08a90", positionManager: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e" },
    name: "Ethereum",
    aliases: ["ethereum", "eth", "mainnet", "ethereum-mainnet"],
    nativeSymbol: "ETH",
    nativeCoingecko: "ethereum",
    wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"],
    explorers: [
      { type: "blockscout", base: "https://eth.blockscout.com" },
      { type: "routescan", base: "https://api.routescan.io/v2/network/mainnet/evm/1/etherscan/api" },
    ],
    explorerUi: "https://eth.blockscout.com",
    dexscreener: "ethereum",
    goplus: "1",
    blockTime: 12,
    logsSpan: 50_000,
  },
  {
    id: 8453,
    key: "base",
    v4: { poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b", positionManager: "0x7c5f5a4bbd8fd63184577525326123b519429bdc" },
    name: "Base",
    aliases: ["base", "base-mainnet"],
    nativeSymbol: "ETH",
    nativeCoingecko: "ethereum",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org", "https://base.drpc.org"],
    explorers: [{ type: "blockscout", base: "https://base.blockscout.com" }],
    explorerUi: "https://base.blockscout.com",
    dexscreener: "base",
    goplus: "8453",
    blockTime: 2,
    logsSpan: 50_000,
  },
  {
    id: 56,
    key: "bsc",
    v4: { poolManager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df", positionManager: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b" },
    name: "BNB Chain",
    aliases: ["bsc", "bnb", "binance", "bnb-chain", "bnbchain", "binance-smart-chain"],
    nativeSymbol: "BNB",
    nativeCoingecko: "binancecoin",
    wrappedNative: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    rpcs: ["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.bnbchain.org", "https://bsc.drpc.org"],
    explorers: [],
    explorerUi: "https://bscscan.com",
    dexscreener: "bsc",
    goplus: "56",
    blockTime: 0.75,
    logsSpan: 50_000,
  },
  {
    id: 42161,
    key: "arbitrum",
    v4: { poolManager: "0x360e68faccca8ca495c1b759fd9eee466db9fb32", positionManager: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869" },
    name: "Arbitrum One",
    aliases: ["arbitrum", "arb", "arbitrum-one", "arb1"],
    nativeSymbol: "ETH",
    nativeCoingecko: "ethereum",
    wrappedNative: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"],
    explorers: [{ type: "blockscout", base: "https://arbitrum.blockscout.com" }],
    explorerUi: "https://arbitrum.blockscout.com",
    dexscreener: "arbitrum",
    goplus: "42161",
    blockTime: 0.25,
    logsSpan: 50_000,
  },
  {
    id: 10,
    key: "optimism",
    name: "OP Mainnet",
    aliases: ["optimism", "op", "op-mainnet"],
    nativeSymbol: "ETH",
    nativeCoingecko: "ethereum",
    wrappedNative: "0x4200000000000000000000000000000000000006",
    rpcs: ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"],
    explorers: [{ type: "blockscout", base: "https://optimism.blockscout.com" }],
    explorerUi: "https://optimism.blockscout.com",
    dexscreener: "optimism",
    goplus: "10",
    blockTime: 2,
    logsSpan: 50_000,
  },
  {
    id: 137,
    key: "polygon",
    name: "Polygon PoS",
    aliases: ["polygon", "matic", "pol", "polygon-pos"],
    nativeSymbol: "POL",
    nativeCoingecko: "polygon-ecosystem-token",
    wrappedNative: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
    rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    explorers: [{ type: "blockscout", base: "https://polygon.blockscout.com" }],
    explorerUi: "https://polygon.blockscout.com",
    dexscreener: "polygon",
    goplus: "137",
    blockTime: 2,
    logsSpan: 50_000,
  },
];

export const DEFAULT_CHAIN = "robinhood";

export function resolveChain(input: unknown): Chain | null {
  const raw = input === undefined || input === null || input === "" ? DEFAULT_CHAIN : String(input).trim().toLowerCase();
  const asNum = /^(0x[0-9a-f]+|\d+)$/.test(raw) ? Number(raw) : NaN;
  for (const c of CHAINS) {
    if (c.id === asNum || c.key === raw || c.aliases.includes(raw) || c.name.toLowerCase() === raw) return c;
  }
  return null;
}

export function chainByDexscreener(slug: string): Chain | null {
  return CHAINS.find((c) => c.dexscreener === slug) ?? null;
}

/** RPC list for a chain, honoring env.RPC_URLS overrides (by id, key or alias). */
export function rpcUrls(chain: Chain, overrides?: Record<string, string>): string[] {
  if (overrides) {
    for (const k of [String(chain.id), chain.key, ...chain.aliases]) {
      const v = overrides[k];
      if (v) {
        const list = v.split(",").map((s) => s.trim()).filter((s) => s.startsWith("https://") || s.startsWith("http://"));
        if (list.length) return list;
      }
    }
  }
  return chain.rpcs;
}

export function supportedChainsText(): string {
  return CHAINS.map((c) => `${c.key} (${c.id})`).join(", ");
}
