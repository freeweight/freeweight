// Screenshots of every screen and state, from a mock build, at three widths in both themes.
//
//   npm run build:mock && npx vite preview --outDir dist-mock --port 4174 &
//   node scripts/shots.mjs [--out shots] [--base http://127.0.0.1:4174] [--only home,wake] [--widths 390,1440] [--themes dark]
//
// Each shot opens in a fresh browser context, so mock options in one address never leak into the next.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const base = arg("base", "http://127.0.0.1:4174");
const out = arg("out", "shots");
const only = arg("only", "")
  .split(",")
  .filter(Boolean);
const widths = arg("widths", "390,768,1440").split(",").map(Number);
const themes = arg("themes", "dark,light").split(",");
const HEIGHT = { 390: 844, 768: 1024, 1440: 900 };

const say = async (page, text) => {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
  await page.locator(".turn.model .turn-foot").last().waitFor({ timeout: 40_000 });
};
/** Ask, and stop at the moment the model has written the last word of its reasoning and not yet answered. */
const pondering = async (page, text) => {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill(text);
  await box.press("Enter");
  await page.locator(".think-tape li.now", { hasText: "then stop." }).waitFor({ timeout: 30_000 });
};
const room = async (page) => {
  await page.getByRole("textbox", { name: "Message" }).waitFor({ timeout: 30_000 });
};
/** Switch the chain tools on, ask about a token, and open the first tool call. */
const tools = async (page, open = false) => {
  await room(page);
  await page.getByRole("switch", { name: /tools/i }).click();
  await say(page, "Is the token 0x4e1f0a6c2b8d9e3f5a7c1b0d2e4f6a8c0b1d3e5f safe to sell?");
  if (open) await page.locator(".tool summary").first().click();
};
/** Send a message the always-awake model does not take, and wait for the reason. */
const refused = async (page) => {
  const box = page.getByRole("textbox", { name: "Message" });
  await box.fill("What can I ask you?");
  await box.press("Enter");
  await page.locator(".hc-refused").waitFor({ timeout: 10_000 });
};
/** Below 1000 px the clock, the endpoint and the receipt sit behind a tab. */
const rail = async (page) => {
  const tab = page.getByRole("group", { name: "View" }).getByRole("button", { name: /Session|Receipt/ });
  if (await tab.isVisible()) await tab.click();
};
const checkRepo = async (page, repo) => {
  await page.locator("#repo").fill(repo);
  await page.locator(".list-form button[type=submit]").click();
  await page.locator(".list-verdict").waitFor({ timeout: 15_000 });
};
/** Paste a repo into the box on the page and wait for what the check says. */
const paste = async (page, repo, shows = ".pb-card") => {
  await page.locator(".pb-form input").fill(repo);
  await page.locator(".pb-form button[type=submit]").click();
  await page.locator(shows).first().waitFor({ timeout: 15_000 });
  await page.locator(".pb").evaluate((el) => el.scrollIntoView({ block: "end" }));
};
const pasteAndLoad = async (page, repo) => {
  await paste(page, repo);
  await page.locator(".pb-go .btn.primary").click();
  await page.locator(".pb .notice").waitFor({ timeout: 15_000 });
  await page.locator(".pb").evaluate((el) => el.scrollIntoView({ block: "end" }));
};

/** name, address, then optionally: what to wait for, what to do, whether to shoot only the viewport, and which widths apply. */
const SHOTS = [
  { name: "home", url: "/?mock=speed:4", wait: ".box" },
  { name: "home-picker", url: "/?mock=speed:4", wait: ".box", view: true, act: (p) => p.locator(".pick-btn").click() },
  { name: "home-empty", url: "/?mock=empty:1", wait: ".box" },
  { name: "home-signed-in", url: "/?mock=user:1", wait: ".box-min", view: true },
  { name: "home-free-used", url: "/?mock=free:used", wait: ".box", view: true },
  { name: "home-budget", url: "/?mock=user:1,budget:1", wait: ".box-min", view: true, act: async (p) => (await p.getByRole("radio", { name: "10 min" }).or(p.getByRole("button", { name: "10 min" })).first().click(), await p.locator(".box button[type=submit]").click(), await p.waitForTimeout(600)) },
  { name: "home-resume", url: "/s/demo?mock=speed:60,active:95", view: true, act: async (p) => (await room(p), await p.locator(".brand").first().click(), await p.locator(".hero-resume").waitFor({ timeout: 10_000 })) },
  { name: "home-down", url: "/?mock=down:1", settle: 2500 },
  { name: "home-loading", url: "/?mock=slow:1", settle: 300, view: true },

  { name: "wake-gpu", url: "/s/demo?mock=speed:40,hold:gpu", wait: ".wk-timer", settle: 2500, view: true },
  { name: "wake-weights", url: "/s/demo?mock=speed:40,hold:weights", wait: ".wk-timer", settle: 3500, view: true },
  { name: "wake-engine", url: "/s/demo?mock=speed:40,hold:engine", wait: ".wk-timer", settle: 4500, view: true },
  { name: "wake-engine-heavy", url: "/s/demo?mock=speed:40,hold:engine,user:1,model:deepseek-r1-distill-70b", wait: ".wk-timer", settle: 6000, view: true },
  { name: "wake-long-name", url: "/s/demo?mock=speed:40,hold:weights,user:1,model:dolphin-3-r1-mistral-24b-abliterated-extended", wait: ".wk-timer", settle: 4000, view: true },
  { name: "wake-page", url: "/s/demo?mock=speed:40,hold:weights", wait: ".wk-timer", settle: 3500 },
  { name: "wake-failed", url: "/s/demo?mock=speed:40,fail:weights", wait: ".wk-timer", settle: 4500, view: true },
  { name: "wake-timeout", url: "/s/demo?mock=speed:40,fail:weights,why:timeout", wait: ".wk-timer", settle: 9000, view: true },
  { name: "wake-retry", url: "/s/demo?mock=speed:40,retry:container,hold:weights", wait: ".wk-timer", settle: 6000, view: true },
  { name: "wake-retry-failed", url: "/s/demo?mock=speed:40,retry:container,fail:weights", wait: ".wk-timer", settle: 7500, view: true },
  { name: "wake-degraded", url: "/s/demo?mock=speed:40,degraded:engine,hold:engine", wait: ".wk-timer", settle: 5000, view: true },
  { name: "wake-twice", url: "/s/demo?mock=speed:40,lane:2,hold:engine", wait: ".wk-timer", settle: 5000, view: true },
  { name: "wake-twice-loading", url: "/s/demo?mock=speed:40,lane:2,hold:weights", wait: ".wk-timer", settle: 4500, view: true },
  { name: "wake-long", url: "/s/demo?mock=speed:60,lane:2,long:container,hold:container,holdat:0.6", wait: ".wk-timer", settle: 4500, view: true },
  { name: "wake-long-late", url: "/s/demo?mock=speed:60,lane:2,long:container,hold:weights,holdat:0.9", wait: ".wk-timer", settle: 7000, view: true },
  { name: "wake-cancelled", url: "/s/demo?mock=speed:40,hold:container", wait: ".wk-timer", settle: 800, view: true, act: async (p) => (await p.waitForTimeout(2500), await p.getByRole("button", { name: "Cancel the wake" }).click()) },

  { name: "room-empty", url: "/s/demo?mock=speed:60,active:95", act: room, view: true },
  { name: "room-chat", url: "/s/demo?mock=speed:60,active:95", view: true, act: async (p) => (await room(p), await say(p, "What should I know about this session?")) },
  { name: "room-code", url: "/s/demo?mock=speed:60,active:95", act: async (p) => (await room(p), await say(p, "Write the billing function in python")) },
  { name: "room-table", url: "/s/demo?mock=speed:60,active:95", view: true, act: async (p) => (await room(p), await say(p, "Compare the price of each tier in a table")) },
  { name: "room-paid", url: "/s/demo?mock=speed:60,active:400,user:1", act: room, view: true },
  { name: "room-low", url: "/s/demo?mock=speed:60,active:262", act: room, view: true },
  { name: "room-stop", url: "/s/demo?mock=speed:60,active:95", view: true, act: async (p) => (await room(p), await rail(p), await p.getByRole("button", { name: "Stop", exact: true }).click()) },
  { name: "room-thinking", url: "/s/demo?mock=speed:60,active:95,think:hold", view: true, act: async (p) => (await room(p), await pondering(p, "What should I know about this session?")) },
  {
    name: "room-thought",
    url: "/s/demo?mock=speed:60,active:95,think:long",
    act: async (p) => (await room(p), await say(p, "What should I know about this session?"), await p.locator(".think > summary").click(), await p.locator(".think-raw > summary").click()),
  },
  { name: "room-tools", url: "/s/demo?mock=speed:60,active:95", act: (p) => tools(p) },
  { name: "room-tools-thought", url: "/s/demo?mock=speed:60,active:95,think:long", act: (p) => tools(p) },
  { name: "room-tools-hostile", url: "/s/demo?mock=speed:60,active:95,tools:hostile", act: (p) => tools(p, true) },
  { name: "room-paused", url: "/s/demo?mock=speed:60,active:95,paused:1", wait: ".room", settle: 1200, view: true },
  { name: "room-session", url: "/s/demo?mock=speed:60,active:95", narrow: true, act: async (p) => (await room(p), await rail(p)) },

  { name: "receipt-free", url: "/s/demo-ended?mock=speed:4", wait: ".ticket" },
  { name: "receipt-paid", url: "/s/demo-ended?mock=user:1,min:16", wait: ".ticket" },
  { name: "receipt-idle", url: "/s/demo-ended?mock=user:1,end:idle", wait: ".ticket" },
  { name: "receipt-minimum", url: "/s/demo-ended?mock=user:1,min:0", wait: ".ticket" },
  { name: "receipt-tab", url: "/s/demo-ended?mock=user:1,min:16", wait: ".room", narrow: true, act: rail },
  { name: "session-missing", url: "/s/no-such-session", wait: ".gone", view: true },

  { name: "hosted-empty", url: "/chat", act: room, view: true },
  { name: "hosted-chat", url: "/chat", view: true, act: async (p) => (await room(p), await say(p, "What can I ask you?")) },
  { name: "hosted-paid", url: "/chat?mock=user:1", act: async (p) => (await room(p), await say(p, "Write a function that prices a request in python")) },
  { name: "hosted-tools", url: "/chat?mock=user:1", act: (p) => tools(p) },
  { name: "hosted-free-used", url: "/chat?mock=hosted:used", view: true, act: (p) => refused(p) },
  { name: "hosted-free-used-in", url: "/chat?mock=hosted:used,user:1,empty:1", view: true, act: room },
  { name: "hosted-busy", url: "/chat?mock=hosted:busy,user:1", view: true, act: (p) => refused(p) },
  { name: "hosted-usage", url: "/chat?mock=user:1", narrow: true, act: async (p) => (await room(p), await say(p, "What can I ask you?"), await p.getByRole("group", { name: "View" }).getByRole("button", { name: "Usage" }).click()) },
  { name: "hosted-off", url: "/chat?mock=hosted:off", wait: ".nf", view: true },
  { name: "home-hosted-off", url: "/?mock=hosted:off", wait: ".box", view: true },

  { name: "catalog", url: "/models", wait: ".cat-row a" },
  { name: "catalog-filtered", url: "/models?class=light&state=awake&sort=-price", wait: ".cat-row a", view: true },
  { name: "catalog-none", url: "/models?q=zzzz", wait: ".cat-none", view: true },
  { name: "catalog-loading", url: "/models?mock=slow:1", settle: 300, view: true },
  { name: "model", url: "/models/hermes-4-14b", wait: ".box" },
  { name: "model-long-name", url: "/models/dolphin-3-r1-mistral-24b-abliterated-extended", wait: ".box" },
  { name: "model-missing", url: "/models/no-such-model", settle: 1200, view: true },

  { name: "paste-new", url: "/?mock=user:1", wait: ".pb", view: true, act: (p) => paste(p, "acme/coder-8b") },
  { name: "paste-new-out", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "https://huggingface.co/acme/coder-8b") },
  { name: "paste-new-heavy", url: "/?mock=user:1", wait: ".pb", view: true, act: (p) => paste(p, "bigiron/atlas-30b") },
  { name: "paste-page", url: "/?mock=user:1", wait: ".pb", act: (p) => paste(p, "acme/coder-8b") },
  { name: "paste-checking", url: "/?mock=slow:1", wait: ".pb", view: true, settle: 200, act: async (p) => (await p.locator(".pb-form input").fill("acme/coder-8b"), await p.locator(".pb-form button[type=submit]").click()) },
  { name: "paste-refused", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "acme/coder-gguf") },
  { name: "paste-refused-big", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "acme/giant-405b") },
  { name: "paste-loaded", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "smallworks/fable-3b") },
  { name: "paste-loading", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "acme/crowd-7b") },
  { name: "paste-taken", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "acme/vault-7b") },
  { name: "paste-again", url: "/?mock=user:1", wait: ".pb", view: true, act: (p) => paste(p, "northfield/ledger-12b") },
  { name: "paste-bad", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "not a repo", ".pb .notice") },
  { name: "paste-busy", url: "/", wait: ".pb", view: true, act: (p) => paste(p, "acme/busy-7b", ".pb .notice") },
  { name: "paste-balance", url: "/?mock=user:1,balance:0.05", wait: ".pb", view: true, act: (p) => pasteAndLoad(p, "acme/coder-8b") },
  { name: "paste-limit", url: "/?mock=user:1,loads:limit", wait: ".pb", view: true, act: (p) => pasteAndLoad(p, "acme/coder-8b") },
  { name: "paste-closed", url: "/?mock=paste:closed", wait: ".pb", view: true },
  { name: "paste-catalog", url: "/models?mock=user:1", wait: ".cat-row a", view: true, act: (p) => paste(p, "acme/coder-8b") },

  { name: "load-queued", url: "/load/demo?mock=user:1,speed:40,load:queued", wait: ".ld-rack", settle: 1500, view: true },
  { name: "load-checking", url: "/load/demo?mock=user:1,speed:40,load:checking", wait: ".ld-rack", settle: 1800, view: true },
  { name: "load-downloading", url: "/load/demo?mock=user:1,speed:40,load:downloading", wait: ".ld-rack", settle: 2500, view: true },
  { name: "load-validating", url: "/load/demo?mock=user:1,speed:40,load:validating", wait: ".ld-rack", settle: 3000, view: true },
  { name: "load-starting", url: "/load/demo?mock=user:1,speed:40,load:starting", wait: ".ld-rack", settle: 4000, view: true },
  { name: "load-heavy", url: "/load/demo-heavy?mock=user:1,speed:400,load:downloading", wait: ".ld-rack", settle: 3000, view: true },
  { name: "load-capped", url: "/load/demo-heavy?mock=user:1,speed:400,load:starting", wait: ".ld-rack", settle: 5000, view: true },
  { name: "load-watching", url: "/load/demo-watch?mock=speed:40,load:downloading", wait: ".ld-rack", settle: 2500, view: true },
  { name: "load-ready", url: "/load/demo-ready?mock=user:1", wait: ".ld-next .box-min", settle: 900 },
  { name: "load-ready-out", url: "/load/demo-ready", wait: ".ld-next .box", settle: 900, view: true },
  { name: "load-failed", url: "/load/demo?mock=user:1,speed:40,loadfail:downloading", wait: ".load.is-failed", settle: 600, view: true },
  { name: "load-failed-late", url: "/load/demo?mock=user:1,speed:40,loadfail:starting", wait: ".load.is-failed", settle: 600, view: true },
  { name: "load-failed-past", url: "/load/demo-failed?mock=user:1", wait: ".load.is-failed", settle: 600, view: true },
  { name: "load-missing", url: "/load/load_nope", wait: ".ld-gone", view: true },
  { name: "load-loading", url: "/load/demo?mock=slow:1", settle: 300, view: true },

  { name: "pasted-catalog", url: "/models?tag=untested&mock=user:1", wait: ".cat-row a" },
  { name: "pasted-model", url: "/models/smallworks_fable-3b", wait: ".box" },
  { name: "pasted-model-mine", url: "/models/you_scratch-7b?mock=user:1", wait: ".model-mine" },
  { name: "pasted-model-cleared", url: "/models/northfield_ledger-12b?mock=user:1", wait: ".pb-card" },
  { name: "pasted-account", url: "/account?mock=user:1", wait: ".mym", view: true, act: (p) => p.locator("#models").scrollIntoViewIfNeeded() },

  { name: "account-out", url: "/account", settle: 900 },
  { name: "account-in", url: "/account?mock=user:1", settle: 900 },
  { name: "account-open", url: "/account?mock=user:1,topups:open,perks:1", settle: 900 },

  { name: "list", url: "/list", wait: "#repo" },
  { name: "list-out", url: "/list", wait: "#repo", view: true },
  { name: "list-checked", url: "/list?mock=user:1", wait: "#repo", act: (p) => checkRepo(p, "acme/coder-7b") },
  { name: "list-pending", url: "/list?mock=user:1", wait: "#repo", act: async (p) => (await checkRepo(p, "acme/coder-7b"), await p.locator(".list-verdict button").click(), await p.waitForTimeout(1800)) },
  { name: "list-building", url: "/list?mock=user:1,build:1", wait: "#repo", act: async (p) => (await checkRepo(p, "acme/coder-7b"), await p.locator(".list-verdict button").click(), await p.waitForTimeout(1800)) },
  { name: "list-bad", url: "/list?mock=user:1", wait: "#repo", view: true, act: async (p) => (await p.locator("#repo").fill("not a repo"), await p.locator(".list-form button[type=submit]").click(), await p.waitForTimeout(300)) },

  { name: "docs", url: "/docs", wait: ".docs-md" },
  { name: "docs-pricing", url: "/docs/pricing", wait: ".docs-md" },
  { name: "docs-api", url: "/docs/api", wait: ".docs-md" },
  { name: "docs-index-open", url: "/docs", wait: ".docs-md", view: true, phone: true, act: (p) => p.locator(".docs-pick").click() },
  { name: "roadmap", url: "/roadmap", wait: ".rm-plate" },
  { name: "notfound", url: "/nothing-here", wait: ".nf", view: true },
  { name: "menu-open", url: "/", wait: ".box", view: true, phone: true, act: (p) => p.locator(".hdr-menu").click() },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
let failed = 0;
for (const shot of SHOTS) {
  if (only.length && !only.some((o) => shot.name === o || shot.name.startsWith(`${o}-`))) continue;
  for (const width of widths) {
    if (shot.phone && width !== 390) continue;
    if (shot.narrow && width >= 1000) continue;
    for (const theme of themes) {
      const ctx = await browser.newContext({ viewport: { width, height: HEIGHT[width] ?? 900 }, colorScheme: theme, deviceScaleFactor: 1, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      const file = join(out, `${shot.name}.${width}.${theme}.png`);
      try {
        await page.goto(base + shot.url, { waitUntil: "load" });
        if (shot.wait) await page.locator(shot.wait).first().waitFor({ timeout: 20_000 });
        if (shot.act) await shot.act(page);
        await page.evaluate(() => document.fonts.ready);
        // A full-page shot taken while scrolled paints the fixed header mid-page.
        if (!shot.view) await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(shot.settle ?? 500);
        await page.screenshot({ path: file, fullPage: !shot.view });
        console.log(file);
      } catch (e) {
        failed++;
        console.error(`FAILED ${file}: ${String(e).split("\n")[0]}`);
        await page.screenshot({ path: file, fullPage: false }).catch(() => undefined);
      }
      await ctx.close();
    }
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
