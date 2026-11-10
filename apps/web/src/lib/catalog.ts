// Catalog filters: read from the URL, written back to it, applied to the model list. Pure.

import { TIERS, type Model, type ModelState, type Tier } from "../api/types";

export type StateFilter = "all" | "awake" | "asleep" | "cold";
export type SortKey = "name" | "tier" | "price" | "params" | "context" | "state";
export type Filters = { tier: Tier | "all"; state: StateFilter; tag: string; q: string; sort: SortKey | ""; desc: boolean };

export const NO_FILTERS: Filters = { tier: "all", state: "all", tag: "", q: "", sort: "", desc: false };

const SORTS: readonly SortKey[] = ["name", "tier", "price", "params", "context", "state"];
const STATE_RANK: Record<ModelState, number> = { awake: 0, waking: 1, asleep: 2, cold: 3, unavailable: 4 };

export function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  const tier = p.get("class");
  const state = p.get("state");
  const sort = p.get("sort") ?? "";
  const key = sort.replace(/^-/, "");
  const known = SORTS.includes(key as SortKey);
  return {
    tier: TIERS.includes(tier as Tier) ? (tier as Tier) : "all",
    state: state === "awake" || state === "asleep" || state === "cold" ? state : "all",
    tag: p.get("tag") ?? "",
    q: p.get("q") ?? "",
    sort: known ? (key as SortKey) : "",
    desc: known && sort.startsWith("-"),
  };
}

export function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  if (f.tier !== "all") p.set("class", f.tier);
  if (f.state !== "all") p.set("state", f.state);
  if (f.tag) p.set("tag", f.tag);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (f.sort) p.set("sort", (f.desc ? "-" : "") + f.sort);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function isFiltered(f: Filters): boolean {
  return f.tier !== "all" || f.state !== "all" || Boolean(f.tag) || Boolean(f.q.trim());
}

/** "Awake" includes models that are waking: both are on a GPU, or about to be. */
function matchesState(m: Model, s: StateFilter): boolean {
  if (s === "all") return true;
  if (s === "awake") return m.state === "awake" || m.state === "waking";
  return m.state === s;
}

function sortValue(m: Model, k: SortKey): number | string {
  switch (k) {
    case "name":
      return m.name.toLowerCase();
    case "tier":
      return TIERS.indexOf(m.tier);
    case "price":
      return m.price_usd_micro_per_min;
    case "params":
      return m.params_b;
    case "context":
      return m.context;
    case "state":
      return STATE_RANK[m.state];
  }
}

export function filterModels(models: Model[], f: Filters): Model[] {
  const q = f.q.trim().toLowerCase();
  const out = models.filter(
    (m) =>
      (f.tier === "all" || m.tier === f.tier) &&
      matchesState(m, f.state) &&
      (!f.tag || m.tags.includes(f.tag)) &&
      (!q || m.name.toLowerCase().includes(q) || m.hf_repo.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)),
  );
  if (!f.sort) return out;
  const k = f.sort;
  const dir = f.desc ? -1 : 1;
  return [...out].sort((a, b) => {
    const x = sortValue(a, k);
    const y = sortValue(b, k);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

/** Tags in the catalog, most used first. */
export function tagsOf(models: Model[]): string[] {
  const n = new Map<string, number>();
  for (const m of models) for (const t of m.tags) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}
