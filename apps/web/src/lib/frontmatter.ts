// The small front-matter block at the top of a docs page: `key: value` lines between two `---` rules.
// Shared by the build (to make the docs index) and the page (to strip it before rendering).

export type FrontMatter = { meta: Record<string, string>; body: string };

const BLOCK = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function frontMatter(src: string): FrontMatter {
  const m = BLOCK.exec(src);
  if (!m) return { meta: {}, body: src.replace(/^﻿/, "") };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: src.slice(m[0].length) };
}

export type DocMeta = {
  slug: string;
  title: string;
  summary: string;
  order: number;
  group: string;
  /** True while the page is a stand-in from the app, not text from docs/site. */
  fixture: boolean;
};

export function titleFromSlug(slug: string): string {
  const s = slug.replace(/[-_]+/g, " ").trim();
  return s ? s[0]!.toUpperCase() + s.slice(1) : slug;
}

export function docMeta(slug: string, src: string, fixture: boolean): DocMeta {
  const { meta, body } = frontMatter(src);
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const order = Number(meta.order);
  return {
    slug,
    title: meta.title || h1 || titleFromSlug(slug),
    summary: meta.summary ?? "",
    order: Number.isFinite(order) && meta.order !== undefined && meta.order !== "" ? order : 999,
    group: meta.group ?? "",
    fixture,
  };
}

export function sortDocs(list: DocMeta[]): DocMeta[] {
  return [...list].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}
