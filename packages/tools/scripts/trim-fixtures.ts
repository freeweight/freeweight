/**
 * Shrink recorded fixtures to the fields the tools read (run after `npm run record`):
 *   npx tsx scripts/trim-fixtures.ts
 * RPC log, block and transaction objects keep only the fields used; explorer listings keep the fields parsed.
 * Page bodies are left as recorded (page analysis reads them in full).
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

type Entry = { key: string; status: number; headers: Record<string, string>; body: string };
const dir = new URL("../test/fixtures/", import.meta.url);

const pick = (o: unknown, keys: string[]) =>
  o && typeof o === "object" ? Object.fromEntries(keys.filter((k) => k in (o as object)).map((k) => [k, (o as Record<string, unknown>)[k]])) : o;

const RPC_KEEP: Record<string, (r: unknown) => unknown> = {
  eth_getLogs: (r) => (Array.isArray(r) ? r.map((l) => pick(l, ["address", "topics", "data", "blockNumber", "transactionHash", "logIndex"])) : r),
  eth_getBlockByNumber: (r) => (r && typeof r === "object" ? { ...(pick(r, ["number", "timestamp", "hash"]) as object), transactions: [] } : r),
  eth_getTransactionByHash: (r) => (r && typeof r === "object" ? { ...(pick(r, ["hash", "blockNumber", "from", "to", "value"]) as object), input: "0x" } : r),
};

function trimRpc(e: Entry): string {
  const req = JSON.parse(e.key.slice(e.key.indexOf(" ", 5) + 1)) as { method?: string } | { method?: string }[];
  const res = JSON.parse(e.body) as { result?: unknown } | { result?: unknown }[];
  const one = (q: { method?: string }, r: { result?: unknown }) => (q.method && RPC_KEEP[q.method] && "result" in r ? { ...r, result: RPC_KEEP[q.method]!(r.result) } : r);
  if (Array.isArray(req) && Array.isArray(res)) return JSON.stringify(res.map((r, i) => one(req[i] ?? {}, r)));
  if (!Array.isArray(req) && !Array.isArray(res)) return JSON.stringify(one(req, res));
  return e.body;
}

function trim(e: Entry): string {
  try {
    if (e.key.startsWith("POST ") && e.key.includes('"jsonrpc"')) return trimRpc(e);
    const url = e.key.split(" ")[1] ?? "";
    if (url.includes("routescan") && url.includes("action=txlist")) {
      const j = JSON.parse(e.body) as { result?: unknown };
      if (Array.isArray(j.result)) j.result = j.result.map((t) => pick(t, ["hash", "from", "to", "contractAddress", "timeStamp"]));
      return JSON.stringify(j);
    }
    if (/blockscout\.com\/api\/v2\/tokens\/0x[0-9a-f]{40}\/holders/i.test(url)) {
      const j = JSON.parse(e.body) as { items?: { address: Record<string, unknown>; value: string }[] };
      j.items = (j.items ?? []).map((i) => ({ address: pick(i.address, ["hash", "is_contract", "name"]) as Record<string, unknown>, value: i.value }));
      return JSON.stringify(j);
    }
  } catch {
    /* leave as recorded */
  }
  return e.body;
}

let before = 0;
let after = 0;
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
  const path = new URL(f, dir);
  const raw = readFileSync(path, "utf8");
  const fx = JSON.parse(raw) as { recorded_at: number; entries: Entry[] };
  fx.entries = fx.entries.map((e) => ({ ...e, body: e.status === 200 ? trim(e) : e.body }));
  const out = JSON.stringify(fx) + "\n";
  before += raw.length;
  after += out.length;
  writeFileSync(path, out);
}
console.log(`fixtures: ${before} -> ${after} bytes`);
