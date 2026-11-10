// Gzipped size of the build: what the landing route loads first, and every lazy chunk after it.
// Usage: node scripts/size.mjs [dist]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = process.argv[2] ?? "dist";
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1).padStart(7)} kB`;

const html = readFileSync(join(dist, "index.html"), "utf8");
const entryJs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
const entryCss = [...html.matchAll(/href="\/(assets\/[^"]+\.css)"/g)].map((m) => m[1]);

// The entry imports a few small shared chunks statically; follow them so the landing total is honest.
const seen = new Set(entryJs);
for (const file of seen) {
  const src = readFileSync(join(dist, file), "utf8");
  for (const m of src.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)) seen.add(`assets/${m[1]}`);
}
const landing = [...seen];
const rest = readdirSync(join(dist, "assets"))
  .filter((f) => /\.(js|css)$/.test(f))
  .map((f) => `assets/${f}`)
  .filter((f) => !landing.includes(f) && !entryCss.includes(f));

let js = 0;
let css = 0;
console.log("Landing route");
for (const f of landing) {
  const n = gz(f);
  js += n;
  console.log(`  ${kb(n)}  ${f}`);
}
for (const f of entryCss) {
  const n = gz(f);
  css += n;
  console.log(`  ${kb(n)}  ${f}`);
}
console.log(`  ${kb(js)}  JS total (gzip)`);
console.log(`  ${kb(css)}  CSS total (gzip)`);
console.log("Loaded on demand");
for (const f of rest.sort((a, b) => gz(b) - gz(a))) console.log(`  ${kb(gz(f))}  ${f}`);

const LIMIT = 100 * 1024;
if (js > LIMIT) {
  console.error(`Landing JS is over ${LIMIT / 1024} kB gzipped.`);
  process.exit(1);
}
