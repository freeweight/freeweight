/** Run one tool: npx tsx scripts/try.ts <tool> '<json args>' */
import { runTool } from "../src/index.js";

const [name, json] = process.argv.slice(2);
const ctx = { env: { FACTS_URL: process.env.FACTS_URL, FACTS_KEY: process.env.FACTS_KEY, EXA_KEY: process.env.EXA_KEY }, fetch: globalThis.fetch.bind(globalThis) };
const t0 = Date.now();
const r = await runTool(name ?? "", json ? JSON.parse(json) : {}, ctx);
console.log(`${Date.now() - t0} ms`);
console.log(JSON.stringify(r, null, 1).slice(0, Number(process.env.MAX ?? 6000)));
