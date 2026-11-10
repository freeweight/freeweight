// Draws the raster brand files from the mark: the social card and the PNG icons in public/.
// The output is committed, so this only runs when the mark, the palette or the headline changes.
//
//   node scripts/brand.mjs
//
// Uses the Playwright browser that the smoke tests use. No network: fonts are read from src/assets/fonts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const font = (file) => `data:font/woff2;base64,${readFileSync(join(root, "src/assets/fonts", file)).toString("base64")}`;

const INK = "#ededea";
const BG = "#0c0c0d";
const BRASS = "#e8b44a";

/** The mark on a 24 grid: three plates, each narrower than the one above. The top one is brass. */
const mark = (size) => `
  <svg viewBox="0 0 24 24" width="${size}" height="${size}">
    <rect x="2" y="2" width="20" height="5" rx="1" fill="${BRASS}"/>
    <rect x="2" y="9.5" width="13" height="5" rx="1" fill="${INK}"/>
    <rect x="2" y="17" width="6" height="5" rx="1" fill="${INK}"/>
  </svg>`;

const icon = (size, radius) => `
  <!doctype html>
  <body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px;border-radius:${radius}px;background:${BG};display:grid;place-items:center">
      ${mark(Math.round(size * 0.75))}
    </div>
  </body>`;

const tier = (name, weight, plates, price) => `
  <div class="tier">
    <span class="plates">${[3, 2, 1].map((i) => `<i${i <= plates ? "" : ' class="off"'}></i>`).join("")}</span>
    <b style="font-weight:${weight}">${name}</b>
    <span class="price">${price}</span>
  </div>`;

const card = `
  <!doctype html>
  <style>
    @font-face { font-family: "Mona Sans"; font-weight: 200 900; src: url("${font("mona-sans-latin-wght.woff2")}") format("woff2"); }
    @font-face { font-family: "Geist Mono"; font-weight: 100 900; src: url("${font("geist-mono-latin-wght.woff2")}") format("woff2"); }
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 630px; background: ${BG}; color: ${INK}; font-family: "Mona Sans", sans-serif; -webkit-font-smoothing: antialiased; }
    .card { height: 100%; padding: 64px 72px 60px; display: flex; flex-direction: column; }
    .top { display: flex; align-items: center; justify-content: space-between; }
    .brand { display: flex; align-items: center; gap: 16px; font-size: 32px; font-weight: 650; letter-spacing: -0.02em; }
    .micro { font: 500 15px/20px "Geist Mono", monospace; letter-spacing: 0.08em; text-transform: uppercase; color: #a6a6a1; }
    h1 { margin-top: 84px; font-size: 92px; line-height: 96px; letter-spacing: -0.035em; font-weight: 300; }
    h1 b { display: block; font-weight: 800; }
    p { margin-top: 28px; font-size: 28px; line-height: 38px; color: #a6a6a1; max-width: 900px; }
    .scale { margin-top: auto; height: 12px; border-bottom: 1px solid #3b3b3f; position: relative;
      background:
        repeating-linear-gradient(to right, #3b3b3f 0 1px, transparent 1px 88px) left bottom / 100% 12px no-repeat,
        repeating-linear-gradient(to right, #3b3b3f 0 1px, transparent 1px 17.6px) left bottom / 100% 6px no-repeat; }
    .scale::after { content: ""; position: absolute; left: 0; bottom: -1px; width: 264px; height: 5px; border-radius: 1px; background: ${BRASS}; }
    .tiers { margin-top: 22px; display: flex; align-items: baseline; gap: 56px; font-size: 24px; line-height: 28px; }
    .tier { display: flex; align-items: baseline; gap: 12px; }
    .plates { display: inline-flex; gap: 3px; align-self: center; }
    .plates i { width: 6px; height: 16px; border-radius: 1px; background: ${INK}; }
    .plates i.off { background: #3b3b3f; }
    .price { font: 500 20px/28px "Geist Mono", monospace; color: #a6a6a1; }
    .tiers .micro { margin-left: auto; }
  </style>
  <div class="card">
    <div class="top">
      <div class="brand">${mark(44)}<span>Freeweight</span></div>
      <span class="micro">Preview</span>
    </div>
    <h1>Rent any open model <b>by the minute.</b></h1>
    <p>Models sleep as stored weights and cost nothing. Wake one on a GPU, typically in a minute or two.</p>
    <div class="scale"></div>
    <div class="tiers">
      ${tier("Light", 300, 1, "$0.03/min")}
      ${tier("Medium", 500, 2, "$0.06/min")}
      ${tier("Heavy", 800, 3, "$0.10/min")}
      <span class="micro">Never per token</span>
    </div>
  </div>`;

const JOBS = [
  { file: "og.png", width: 1200, height: 630, html: card },
  { file: "favicon-32.png", width: 32, height: 32, html: icon(32, 4), clear: true },
  { file: "apple-touch-icon.png", width: 180, height: 180, html: icon(180, 0) },
];

const browser = await chromium.launch();
for (const job of JOBS) {
  const page = await browser.newPage({ viewport: { width: job.width, height: job.height }, deviceScaleFactor: 1 });
  await page.setContent(job.html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const path = join(root, "public", job.file);
  await page.screenshot({ path, omitBackground: Boolean(job.clear) });
  await page.close();
  console.log(path.slice(root.length + 1));
}
await browser.close();
