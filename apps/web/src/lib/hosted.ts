// The always-awake model: the small things every page that shows it needs. The chat itself is in hostedchat.ts.

import type { HostedModel } from "../api/types";
import type { Filters } from "./catalog";
import { usd } from "./format";

/** Where its chat room lives. */
export const HOSTED_PATH = "/chat";

/** A per-token price as it is quoted: US dollars for a million tokens. */
export function perMillion(micro: number): string {
  return usd(micro);
}

/** "$0.50 in · $2.00 out per 1M tokens". */
export function tokenPrices(m: Pick<HostedModel, "price_in_usd_micro_per_mtok" | "price_out_usd_micro_per_mtok">): string {
  return `${perMillion(m.price_in_usd_micro_per_mtok)} in · ${perMillion(m.price_out_usd_micro_per_mtok)} out per 1M tokens`;
}

/** What `tokens_in` and `tokens_out` cost at the model's prices, rounded up to a whole micro as the gateway does. */
export function tokenCost(m: Pick<HostedModel, "price_in_usd_micro_per_mtok" | "price_out_usd_micro_per_mtok">, tokensIn: number, tokensOut: number): number {
  return Math.ceil((tokensIn * m.price_in_usd_micro_per_mtok + tokensOut * m.price_out_usd_micro_per_mtok) / 1_000_000);
}

/** "3 of 20 free messages left today". */
export function freeLine(left: number, perDay: number): string {
  if (left <= 0) return "Today's free messages are used.";
  return `${left} of ${perDay} free ${perDay === 1 ? "message" : "messages"} left today`;
}

/**
 * Whether the catalog shows the always-awake model under these filters. It has no weight class, no tags and is
 * never asleep, so any of those filters leaves it out; a search keeps it when its name or id matches.
 */
export function inCatalog(m: Pick<HostedModel, "id" | "name">, f: Filters): boolean {
  if (f.tier !== "all" || f.tag || f.state === "asleep" || f.state === "cold") return false;
  const q = f.q.trim().toLowerCase();
  return !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
}

// A message typed on the front page travels to the chat room with the visitor. It is taken once.
let opening: string | null = null;
export function leaveOpening(text: string): void {
  opening = text.trim() || null;
}
export function takeOpening(): string | null {
  const t = opening;
  opening = null;
  return t;
}
