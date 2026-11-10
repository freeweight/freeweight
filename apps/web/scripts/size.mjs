// Gzipped size of the build: what the landing route loads first, every lazy chunk after it, and the pages of text.
// Usage: node scripts/size.mjs [dist]. It exits 1 when the build is over the budget at the end of this file.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = process.argv[2] ?? "dist";
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1).padStart(7)} kB`;

const html = readFileSync(join(dist, "index.html"), "utf8");
const entryJs = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
// The chunk the page itself starts from, without the shared chunks it preloads.
const entry = html.match(/<script[^>]+src="\/(assets\/[^"]+\.js)"/)?.[1];
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
// A page of the docs is built as a chunk that holds one string and nothing else. That is text, not code, and it
// grows with the docs: it is listed here and left out of the budget for code.
const isText = (file) =>
  /^const (\w+)=(['"`])[\s\S]*\2;export\{\1 as default\};?\s*$/.test(readFileSync(join(dist, file), "utf8"));
const text = rest.filter((f) => f.endsWith(".js") && isText(f));
const sum = (files) => files.reduce((n, f) => n + gz(f), 0);

console.log("Loaded on demand");
for (const f of rest.filter((f) => !text.includes(f)).sort((a, b) => gz(b) - gz(a))) console.log(`  ${kb(gz(f))}  ${f}`);
console.log("Pages of text, outside the budget");
for (const f of text.sort((a, b) => gz(b) - gz(a))) console.log(`  ${kb(gz(f))}  ${f}`);
console.log(`  ${kb(sum(text))}  text total (gzip)`);
const all = js + sum(rest.filter((f) => f.endsWith(".js") && !text.includes(f)));
console.log("Budget");

// The budget, in gzipped bytes. The build runs this file, so a change that grows past a line fails the build.
const KB = 1024;
const BUDGET = [
  ["Landing JS", js, 100 * KB],
  ["The entry chunk", entry ? gz(entry) : 0, 20 * KB],
  ["All JS code", all, 140 * KB],
];
let over = false;
for (const [what, size, limit] of BUDGET) {
  console.log(`  ${kb(size)}  of ${limit / KB} kB  ${what}`);
  if (size > limit) {
    console.error(`${what} is over the budget of ${limit / KB} kB gzipped.`);
    over = true;
  }
}
if (over) process.exit(1);
