/**
 * Record live responses for test/cases.ts into test/fixtures/<name>.json (keyless sources only, nothing secret).
 *   npm run record            # all cases
 *   npm run record -- holders # cases whose name contains "holders"
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { runTool } from "../src/index.js";
import { CASES } from "../test/cases.js";
import { recorder, resetState } from "../test/harness.js";

const filter = process.argv[2];
mkdirSync(new URL("../test/fixtures/", import.meta.url), { recursive: true });
const realNow = Date.now.bind(Date);
for (const c of CASES) {
  if (filter && !c.name.includes(filter)) continue;
  resetState();
  const frozen = realNow();
  Date.now = () => frozen; // deterministic block estimates in replay
  const rec = recorder(globalThis.fetch.bind(globalThis));
  const r = await runTool(c.tool, c.args, { env: { ...(c.env ?? {}) }, fetch: rec.fetch });
  Date.now = realNow;
  writeFileSync(new URL(`../test/fixtures/${c.name}.json`, import.meta.url), JSON.stringify({ recorded_at: frozen, entries: rec.entries }) + "\n");
  console.log(`${c.name}: ${rec.entries.length} requests; ${r.ok ? "ok" : "FAIL"}${r.partial ? " partial" : ""}: ${r.summary.slice(0, 200)}`);
}
