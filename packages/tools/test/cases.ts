/** Tool calls recorded into test/fixtures (scripts/record-fixtures.ts) and replayed by test/tools.test.ts. */
export type Case = { name: string; tool: string; args: Record<string, unknown>; env?: Record<string, string> };

export const PEPE_ETH = "0x6982508145454ce325ddbe47a25d4ec3d2311933";
export const DEGEN_BASE = "0x4ed4e862860bed51a9570b96d89af5e1b0efefed";
export const WALLET_RH = "0x0339f5459fc690ac85f1782e15782a151b4a9e1b";
export const ZOLVA_RH = "0x8e04549484d0612be8373a0263b11928a5f7681f";

export const CASES: Case[] = [
  { name: "token_overview-eth-pepe", tool: "token_overview", args: { chain: "ethereum", token: PEPE_ETH } },
  { name: "token_overview-rh-wallet", tool: "token_overview", args: { chain: "robinhood", token: WALLET_RH } },
  { name: "safety_check-rh-wallet", tool: "safety_check", args: { token: WALLET_RH } },
  { name: "safety_check-rh-v4-hooked", tool: "safety_check", args: { token: ZOLVA_RH } },
  { name: "safety_check-eth-pepe", tool: "safety_check", args: { chain: "eth", token: PEPE_ETH } },
  { name: "holders-eth-pepe", tool: "holders", args: { chain: "ethereum", token: PEPE_ETH } },
  { name: "holders-rh-young", tool: "holders", args: { chain: "4663", token: ZOLVA_RH } },
  { name: "dev_history-rh-young", tool: "dev_history", args: { token: ZOLVA_RH } },
  { name: "dev_history-eth-pepe", tool: "dev_history", args: { chain: "ethereum", token: PEPE_ETH } },
  { name: "official_ca-base-degen", tool: "official_ca", args: { chain: "base", token: DEGEN_BASE } },
  { name: "project_check-base-degen", tool: "project_check", args: { url: "https://www.degen.tips" } },
  { name: "market_data-base-degen", tool: "market_data", args: { chain: "base", token: DEGEN_BASE, majors: ["eth", "btc"] } },
  { name: "chain_read-eth-call", tool: "chain_read", args: { chain: "ethereum", op: "call", to: PEPE_ETH, signature: "balanceOf(address) returns (uint256)", args: ["0xf977814e90da44bfa03b6295a0616a897441acec"] } },
  { name: "contract_source-eth-pepe", tool: "contract_source", args: { chain: "ethereum", address: PEPE_ETH, max_chars: 4000 } },
];
