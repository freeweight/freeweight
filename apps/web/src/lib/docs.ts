// What the docs view needs besides rendering: the grouped index, links between pages, the page outline.

import type { DocMeta } from "./frontmatter";
import type { Block } from "./markdown";

export type DocGroup = { group: string; pages: DocMeta[] };

/** Pages by group, groups in the order they first appear in the sorted index. */
export function groupDocs(index: DocMeta[]): DocGroup[] {
  const out: DocGroup[] = [];
  for (const d of index) {
    let g = out.find((x) => x.group === d.group);
    if (!g) out.push((g = { group: d.group, pages: [] }));
    g.pages.push(d);
  }
  return out;
}

export function neighbours(index: DocMeta[], slug: string): { prev: DocMeta | null; next: DocMeta | null } {
  const i = index.findIndex((d) => d.slug === slug);
  if (i < 0) return { prev: null, next: null };
  return { prev: index[i - 1] ?? null, next: index[i + 1] ?? null };
}

/** Files published at the site root that pages may point at by their path in the repo. */
const ROOT_FILE = /(?:^|\/)(llms\.txt|openapi\.yaml)$/i;

/**
 * Map a link written between docs pages (`pricing.md`, `./api.md#errors`, a bare slug) onto its site route.
 * Returns null when the link is not one of ours, so the caller can fall back to its ordinary link rules.
 */
export function docHref(href: string, slugs: ReadonlySet<string>): string | null {
  const file = ROOT_FILE.exec(href);
  if (file && !/^[a-z][a-z0-9+.-]*:/i.test(href)) return `/${file[1]!.toLowerCase()}`;
  const m = /^(?:\.\/|\/docs\/)?([a-z0-9][a-z0-9-]*)(\.md)?(#[\w-]*)?$/i.exec(href);
  if (!m) return null;
  const slug = m[1]!.toLowerCase();
  return slugs.has(slug) ? `/docs/${slug}${m[3] ?? ""}` : null;
}

/** Heading text without its inline markup, for the outline. */
export function plain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*+/g, "")
    .trim();
}

export type Heading = { id: string; text: string };

export function outline(blocks: Block[]): Heading[] {
  return blocks.flatMap((b) => (b.t === "h" && b.level === 2 && b.id ? [{ id: b.id, text: plain(b.text) }] : []));
}

/** The page header already shows the title: drop a leading h1 from the body. */
export function dropTitle(blocks: Block[]): Block[] {
  const first = blocks[0];
  return first?.t === "h" && first.level === 1 ? blocks.slice(1) : blocks;
}
