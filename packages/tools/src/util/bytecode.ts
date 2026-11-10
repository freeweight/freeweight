import { toFunctionSelector } from "viem";

/** Collect every PUSH4 immediate in runtime bytecode (skipping other PUSH data), as 0x-prefixed lowercase selectors. */
export function push4Selectors(code: string): Set<string> {
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  const out = new Set<string>();
  const n = hex.length / 2;
  for (let i = 0; i < n; i++) {
    const op = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const len = op - 0x5f;
      if (op === 0x63 && i + 4 < n + 1) out.add("0x" + hex.slice((i + 1) * 2, (i + 5) * 2).toLowerCase());
      i += len;
    }
  }
  return out;
}

/** EIP-1167 minimal proxy: returns the implementation address or null. */
export function minimalProxyTarget(code: string): string | null {
  const m = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/i.exec(code);
  return m ? ("0x" + m[1]!).toLowerCase() : null;
}

export type SelectorGroup = { key: string; label: string; sigs: string[] };

/** Owner-power selector groups. Presence in bytecode = capability exists, not that it was used. */
export const RISK_GROUPS: SelectorGroup[] = [
  { key: "mint", label: "can mint new supply", sigs: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)", "issue(uint256)"] },
  {
    key: "blacklist",
    label: "can block addresses",
    sigs: [
      "blacklist(address)",
      "blacklist(address,bool)",
      "addToBlacklist(address)",
      "setBlacklist(address,bool)",
      "blacklistAddress(address,bool)",
      "setBots(address[],bool)",
      "addBots(address[])",
      "setBot(address,bool)",
      "blockBots(address[])",
      "isBlacklisted(address)",
      "isBot(address)",
      "setIsBot(address,bool)",
      "addBlacklist(address)",
      "setBlacklisted(address,bool)",
    ],
  },
  { key: "pause", label: "can pause transfers", sigs: ["pause()", "unpause()", "setPaused(bool)", "pauseTrading()"] },
  { key: "trading_gate", label: "owner opens/closes trading", sigs: ["enableTrading()", "openTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "startTrading()", "tradingStatus(bool)"] },
  {
    key: "fees",
    label: "can change fees/taxes",
    sigs: [
      "setFees(uint256,uint256)",
      "setFee(uint256)",
      "setFee(uint256,uint256)",
      "setTaxes(uint256,uint256)",
      "setTax(uint256,uint256)",
      "setBuyTax(uint256)",
      "setSellTax(uint256)",
      "setBuyFee(uint256)",
      "setSellFee(uint256)",
      "updateFees(uint256,uint256)",
      "updateBuyFees(uint256,uint256,uint256)",
      "updateSellFees(uint256,uint256,uint256)",
      "setTaxFeePercent(uint256)",
      "setSwapFees(uint256,uint256)",
    ],
  },
  { key: "limits", label: "can set tx/wallet limits", sigs: ["setMaxTxAmount(uint256)", "setMaxWalletSize(uint256)", "updateMaxTxnAmount(uint256)", "setMaxWallet(uint256)", "setMaxTx(uint256)", "removeLimits()"] },
  { key: "exclusions", label: "has fee/limit exclusion lists", sigs: ["excludeFromFee(address)", "setExcludedFromFee(address,bool)", "excludeFromFees(address,bool)", "setExcludeFromFee(address,bool)", "excludeFromMaxTransaction(address,bool)"] },
  { key: "upgrade", label: "upgradeable logic", sigs: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"] },
  { key: "ownable", label: "has an owner role", sigs: ["owner()", "transferOwnership(address)", "renounceOwnership()"] },
  { key: "hooks", label: "pre/post-transfer hook or swap logic", sigs: ["setSwapEnabled(bool)", "setSwapTokensAtAmount(uint256)", "manualSwap()", "setAutomatedMarketMakerPair(address,bool)"] },
];

const SEL_CACHE = new Map<string, string>();
function sel(sig: string): string {
  let s = SEL_CACHE.get(sig);
  if (!s) {
    s = toFunctionSelector(`function ${sig}`).toLowerCase();
    SEL_CACHE.set(sig, s);
  }
  return s;
}

export function scanRisk(selectors: Set<string>): { key: string; label: string; matched: string[] }[] {
  const out: { key: string; label: string; matched: string[] }[] = [];
  for (const g of RISK_GROUPS) {
    const matched = g.sigs.filter((s) => selectors.has(sel(s)));
    if (matched.length) out.push({ key: g.key, label: g.label, matched });
  }
  return out;
}

export const EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const EIP1967_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

export function slotAddress(word: string | null | undefined): string | null {
  if (!word || word === "0x") return null;
  const h = word.replace(/^0x/, "").padStart(64, "0");
  const a = "0x" + h.slice(24);
  return /^0x0{40}$/.test(a) ? null : a.toLowerCase();
}

export const DEAD_ADDRESSES = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xdead000000000000000042069420694206942069"]);
