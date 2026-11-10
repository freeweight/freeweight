/**
 * Extract facts from fetched HTML. Everything quoted from a page is untrusted: snippets are short, stripped of markup
 * and control characters, and returned under keys that say so. Never return raw page bodies.
 */

const UNTRUSTED_MAX = 160;
/** Only this much of a page is analysed: title, meta, links and scripts live near the top. */
export const ANALYSE_MAX_BYTES = 256 * 1024;
const TAG_MAX = 4096;

/**
 * Invisible or direction-changing characters used to hide text from people but not from models: C0/C1 controls,
 * soft hyphen, zero-width and joiner characters, bidi embeddings/isolates, word joiner and invisible operators,
 * variation selectors, BOM, interlinear annotation marks, and the Unicode tag block (U+E0000-E007F).
 */
const INVISIBLE =
  /[\u0000-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿￹-￻\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** Remove markup in one linear pass: a tag is "<" up to the next ">" within TAG_MAX chars; anything else is text. */
export function stripTags(s: string): string {
  let out = "";
  let i = 0;
  let nextGt = -2; // cached index of the next ">" at or after i; -1 = none left
  while (i < s.length) {
    const lt = s.indexOf("<", i);
    if (lt < 0) {
      out += s.slice(i);
      break;
    }
    out += s.slice(i, lt);
    if (nextGt !== -1 && nextGt < lt) nextGt = s.indexOf(">", lt);
    if (nextGt !== -1 && nextGt - lt <= TAG_MAX) {
      out += " ";
      i = nextGt + 1;
    } else {
      out += " ";
      i = lt + 1;
    }
  }
  return out;
}

export function cleanSnippet(s: string, max = UNTRUSTED_MAX): string {
  // The result is short; never process more than a bounded prefix.
  const src = s.length > max * 8 + TAG_MAX ? s.slice(0, max * 8 + TAG_MAX) : s;
  return stripTags(src)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[<>]/g, " ")
    .replace(INVISIBLE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Creator-written text for a summary: cleaned, at most 32 characters, in double quotes. */
export function quoteUntrusted(s: string | null | undefined, max = 32): string {
  if (s === null || s === undefined) return '"?"';
  const c = cleanSnippet(String(s), 400).replace(/"/g, "'");
  return `"${c.length > max ? c.slice(0, max - 1) + "…" : c}"`;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]{0,2000})"|'([^']{0,2000})'|([^\\s>]{1,2000}))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

type Tag = { name: string; raw: string; start: number; end: number };

/**
 * Single linear pass over HTML: yields tags (bounded length) and collects visible text, skipping script/style bodies.
 */
function scanHtml(html: string): { tags: Tag[]; text: string } {
  const lower = html.toLowerCase();
  const tags: Tag[] = [];
  let text = "";
  let i = 0;
  let nextGt = -2;
  const noClose = new Set<string>();
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    if (nextGt !== -1 && nextGt < lt) nextGt = html.indexOf(">", lt);
    if (nextGt === -1 || nextGt - lt > TAG_MAX) {
      text += " ";
      i = lt + 1;
      continue;
    }
    const raw = html.slice(lt, nextGt + 1);
    const name = /^<\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw)?.[1]?.toLowerCase() ?? "";
    tags.push({ name: raw.startsWith("</") ? "/" + name : name, raw, start: lt, end: nextGt + 1 });
    i = nextGt + 1;
    text += " ";
    if ((name === "script" || name === "style") && !raw.startsWith("</")) {
      const close = noClose.has(name) ? -1 : lower.indexOf("</" + name, i);
      if (close < 0) {
        noClose.add(name);
        break; // the rest of the document is inside an unclosed script/style
      }
      i = close;
    }
    if (tags.length > 20_000) break;
  }
  return { tags, text };
}

export type PageFacts = {
  title_untrusted: string | null;
  description_untrusted: string | null;
  generator: string | null;
  script_hosts: string[];
  script_srcs_same_origin: string[];
  links: { github: string[]; x: string[]; telegram: string[]; discord: string[]; other_hosts: string[] };
  text_chars: number;
  /** Bytes of the page that were analysed (at most ANALYSE_MAX_BYTES). */
  analysed_bytes: number;
  addresses_found: string[];
  template_signals: string[];
  framework_signals: string[];
};

const TEMPLATE_MARKERS: [RegExp, string][] = [
  [/lorem ipsum/i, "lorem ipsum placeholder text"],
  [/<title>\s*(Create Next App|Vite \+ React|React App|Vite App|Document|Untitled)\s*<\/title>/i, "default framework title"],
  [/coming soon/i, "'coming soon' page"],
  [/Edit\s+<code>src\/App/i, "default starter page"],
  [/Your (site|website) (is|will be) (live|ready)/i, "builder placeholder"],
  [/This domain (is|may be) for sale|buy this domain|parked free/i, "parked or for-sale domain"],
];

const FRAMEWORK_MARKERS: [RegExp, string][] = [
  [/__NEXT_DATA__|\/_next\//, "Next.js"],
  [/\/assets\/index-[A-Za-z0-9_-]+\.js/, "Vite build"],
  [/data-framer-|framerusercontent\.com/, "Framer"],
  [/webflow\.(com|io)|data-wf-page/, "Webflow"],
  [/wix\.com|wixstatic/, "Wix"],
  [/squarespace/, "Squarespace"],
  [/lovable\.app|gpt-engineer/i, "Lovable"],
  [/https:\/\/bolt\.new/i, "Bolt"],
  [/v0\.dev/i, "v0"],
  [/carrd\.co/, "Carrd"],
  [/wp-content|wordpress/i, "WordPress"],
  [/gitbook/i, "GitBook"],
];

export function analyzeHtml(fullHtml: string, pageUrl: string): PageFacts {
  const html = fullHtml.length > ANALYSE_MAX_BYTES ? fullHtml.slice(0, ANALYSE_MAX_BYTES) : fullHtml;
  const origin = new URL(pageUrl);
  const { tags, text: rawText } = scanHtml(html);
  let title: string | null = null;
  let desc: string | null = null;
  let generator: string | null = null;
  const scriptHosts = new Set<string>();
  const sameOrigin: string[] = [];
  const links = { github: new Set<string>(), x: new Set<string>(), telegram: new Set<string>(), discord: new Set<string>(), other_hosts: new Set<string>() };
  const addSameOrigin = (href: string) => {
    try {
      const u = new URL(href, origin);
      if (u.host === origin.host) {
        if (u.protocol === "https:" && sameOrigin.length < 12 && !sameOrigin.includes(u.toString())) sameOrigin.push(u.toString());
      } else scriptHosts.add(u.host);
    } catch {
      /* ignore */
    }
  };
  let titleTried = false;
  for (const t of tags) {
    if (t.name === "title" && !titleTried) {
      titleTried = true; // only the first <title> counts
      const close = html.toLowerCase().indexOf("</title", t.end);
      if (close >= 0 && close - t.end <= 2000) title = html.slice(t.end, close);
    } else if (t.name === "meta") {
      const n = (attr(t.raw, "name") ?? attr(t.raw, "property") ?? "").toLowerCase();
      if (!desc && (n === "description" || n === "og:description")) desc = attr(t.raw, "content");
      if (n === "generator") generator = attr(t.raw, "content");
    } else if (t.name === "script") {
      const src = attr(t.raw, "src");
      if (src) addSameOrigin(src);
    } else if (t.name === "link" && /rel\s*=\s*["']?modulepreload/i.test(t.raw)) {
      // modulepreload links carry the real bundles on Vite sites
      const href = attr(t.raw, "href");
      if (href) {
        try {
          const u = new URL(href, origin);
          if (u.host === origin.host) addSameOrigin(href);
        } catch {
          /* ignore */
        }
      }
    }
    if (t.name === "a" || t.name === "link") {
      const href = attr(t.raw, "href");
      if (!href) continue;
      let u: URL;
      try {
        u = new URL(href, origin);
      } catch {
        continue;
      }
      if (!/^https?:$/.test(u.protocol)) continue;
      const h = u.hostname.replace(/^www\./, "");
      const clean = `https://${h}${u.pathname.replace(/\/+$/, "")}`;
      if (h === "github.com") links.github.add(clean);
      else if (h === "x.com" || h === "twitter.com") links.x.add(clean);
      else if (h === "t.me" || h === "telegram.me") links.telegram.add(clean);
      else if (h === "discord.gg" || h === "discord.com") links.discord.add(clean);
      else if (t.name === "a" && h !== origin.hostname.replace(/^www\./, "")) links.other_hosts.add(h);
    }
  }
  const text = rawText.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  const addresses = [...new Set([...html.matchAll(/(?<![0-9a-fA-Fx])0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))].slice(0, 20);
  const template = TEMPLATE_MARKERS.filter(([re]) => re.test(html)).map(([, l]) => l);
  if (text.length < 200) template.push("very little visible text (client-rendered shell or empty page)");
  const fw = FRAMEWORK_MARKERS.filter(([re]) => re.test(html)).map(([, l]) => l);
  const cap = (s: Set<string>, n = 8) => [...s].slice(0, n);
  return {
    title_untrusted: title ? cleanSnippet(title, 120) : null,
    description_untrusted: desc ? cleanSnippet(desc) : null,
    generator: generator ? cleanSnippet(generator, 60) : null,
    script_hosts: [...scriptHosts].slice(0, 15),
    script_srcs_same_origin: sameOrigin,
    links: { github: cap(links.github), x: cap(links.x), telegram: cap(links.telegram), discord: cap(links.discord), other_hosts: cap(links.other_hosts, 12) },
    text_chars: text.length,
    analysed_bytes: html.length,
    addresses_found: addresses,
    template_signals: template,
    framework_signals: fw,
  };
}

/** Short untrusted snippet around the first occurrence of needle (case-insensitive). */
export function snippetAround(body: string, needle: string, radius = 70): string | null {
  const i = body.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return null;
  let s = body.slice(Math.max(0, i - radius), i + needle.length + radius);
  // Drop a tag cut in half at either edge.
  const gt = s.indexOf(">");
  const lt = s.indexOf("<");
  if (gt >= 0 && (lt < 0 || gt < lt)) s = s.slice(gt + 1);
  const lastLt = s.lastIndexOf("<");
  if (lastLt > s.lastIndexOf(">")) s = s.slice(0, lastLt);
  return cleanSnippet(s, 200);
}

/** Registrable domain (naive eTLD+1 with common two-level suffixes). */
export function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, "").split(".");
  const two = parts.slice(-2).join(".");
  const SECOND = new Set(["co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.jp", "co.kr", "com.br", "com.cn", "com.tr", "co.in", "co.nz", "com.mx", "com.sg", "com.hk", "co.za"]);
  return SECOND.has(two) && parts.length >= 3 ? parts.slice(-3).join(".") : two;
}
