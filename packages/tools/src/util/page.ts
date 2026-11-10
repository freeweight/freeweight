/**
 * Extract facts from fetched HTML. Everything quoted from a page is untrusted: snippets are short, stripped of markup
 * and control characters, and returned under keys that say so. Never return raw page bodies.
 */

const UNTRUSTED_MAX = 160;

export function cleanSnippet(s: string, max = UNTRUSTED_MAX): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[<>]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

export type PageFacts = {
  title_untrusted: string | null;
  description_untrusted: string | null;
  generator: string | null;
  script_hosts: string[];
  script_srcs_same_origin: string[];
  links: { github: string[]; x: string[]; telegram: string[]; discord: string[]; other_hosts: string[] };
  text_chars: number;
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
  [/bolt\.new/i, "Bolt"],
  [/v0\.dev/i, "v0"],
  [/carrd\.co/, "Carrd"],
  [/wp-content|wordpress/i, "WordPress"],
  [/gitbook/i, "GitBook"],
];

export function analyzeHtml(html: string, pageUrl: string): PageFacts {
  const origin = new URL(pageUrl);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? null;
  let desc: string | null = null;
  let generator: string | null = null;
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const n = (attr(tag, "name") ?? attr(tag, "property") ?? "").toLowerCase();
    if (!desc && (n === "description" || n === "og:description")) desc = attr(tag, "content");
    if (n === "generator") generator = attr(tag, "content");
  }
  const scriptHosts = new Set<string>();
  const sameOrigin: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)) {
    try {
      const u = new URL(m[1]!, origin);
      if (u.host === origin.host) {
        if (u.protocol === "https:" && sameOrigin.length < 12) sameOrigin.push(u.toString());
      } else scriptHosts.add(u.host);
    } catch {
      /* ignore */
    }
  }
  // modulepreload links carry the real bundles on Vite sites
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["']?modulepreload[^>]*>/gi)) {
    const href = attr(m[0], "href");
    if (!href) continue;
    try {
      const u = new URL(href, origin);
      if (u.host === origin.host && u.protocol === "https:" && sameOrigin.length < 12 && !sameOrigin.includes(u.toString())) sameOrigin.push(u.toString());
    } catch {
      /* ignore */
    }
  }
  const links = { github: new Set<string>(), x: new Set<string>(), telegram: new Set<string>(), discord: new Set<string>(), other_hosts: new Set<string>() };
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    let u: URL;
    try {
      u = new URL(m[1]!, origin);
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
    else if (h !== origin.hostname.replace(/^www\./, "")) links.other_hosts.add(h);
  }
  const text = cleanSnippet(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " "), 1_000_000);
  const addresses = [...new Set([...html.matchAll(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g)].map((m) => m[0].toLowerCase()))].slice(0, 20);
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
