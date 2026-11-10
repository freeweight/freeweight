import type { Chain } from "../chains.js";
import type { Run } from "../util/http.js";

export type GoPlusHolder = { address: string; tag?: string; is_contract?: number; balance?: string; percent?: string; is_locked?: number };
export type GoPlusToken = {
  token_name?: string;
  token_symbol?: string;
  total_supply?: string;
  holder_count?: string;
  creator_address?: string;
  creator_balance?: string;
  creator_percent?: string;
  owner_address?: string;
  owner_balance?: string;
  owner_percent?: string;
  is_open_source?: string;
  is_proxy?: string;
  is_mintable?: string;
  can_take_back_ownership?: string;
  owner_change_balance?: string;
  hidden_owner?: string;
  selfdestruct?: string;
  external_call?: string;
  buy_tax?: string;
  sell_tax?: string;
  transfer_tax?: string;
  cannot_buy?: string;
  cannot_sell_all?: string;
  slippage_modifiable?: string;
  is_honeypot?: string;
  honeypot_with_same_creator?: string;
  transfer_pausable?: string;
  is_blacklisted?: string;
  is_whitelisted?: string;
  is_anti_whale?: string;
  anti_whale_modifiable?: string;
  trading_cooldown?: string;
  personal_slippage_modifiable?: string;
  is_in_dex?: string;
  dex?: { name?: string; liquidity?: string; pair?: string; liquidity_type?: string }[];
  holders?: GoPlusHolder[];
  lp_holders?: GoPlusHolder[];
  lp_total_supply?: string;
  lp_holder_count?: string;
  trust_list?: string;
  is_airdrop_scam?: string;
  fake_token?: unknown;
  note?: string;
};

export async function goplusToken(run: Run, chain: Chain, token: string): Promise<GoPlusToken | null> {
  if (!chain.goplus) return null;
  const j = await run.json<{ code: number; message?: string; result?: Record<string, GoPlusToken> }>(
    `https://api.gopluslabs.io/api/v1/token_security/${chain.goplus}?contract_addresses=${token}`,
    { source: "goplus", ttl: 300, timeoutMs: 9000 },
  );
  if (j.code !== 1) throw new Error(`goplus code ${j.code} ${j.message ?? ""}`.trim());
  const r = j.result ?? {};
  return r[token] ?? r[token.toLowerCase()] ?? Object.values(r)[0] ?? null;
}

export function flag(v: string | undefined): boolean | null {
  if (v === "1") return true;
  if (v === "0") return false;
  return null;
}
