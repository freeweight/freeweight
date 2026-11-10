// A small markdown renderer for chat and docs. It builds React nodes (never HTML strings), copes with a
// half-streamed document, and covers what models and our docs write: headings, lists, tables, code, quotes, links.

import { Fragment, type ReactNode } from "react";
import { Link } from "../router";
import { Code } from "../ui/bits";
import "../styles/md.css";

export type Block =
  | { t: "h"; level: number; text: string; id: string }
  | { t: "p"; text: string }
  | { t: "code"; lang: string; code: string }
  | { t: "list"; ordered: boolean; start: number; items: { text: string; children: Block[] }[] }
  | { t: "quote"; children: Block[]; note?: Note }
  | { t: "table"; head: string[]; align: ("left" | "right" | "center")[]; rows: string[][] }
  | { t: "hr" };

/** GitHub-style callouts: a quote that opens with [!NOTE], [!WARNING] and so on. */
export type Note = "note" | "tip" | "important" | "warning" | "caution";
const NOTE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;

/**
 * How a renderer treats links. Docs map their relative links onto site routes. With `plainLinks` nothing becomes
 * clickable: a link is written out as its label and its address, for text that may repeat what a stranger wrote.
 */
export type Ctx = { anchors: boolean; href?: (href: string) => string | null; plainLinks?: boolean };

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s{0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[i]!)) body.push(lines[i++]!);
      i++; // closing fence, or end of a half-streamed block
      out.push({ t: "code", lang: fence[2] ?? "", code: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]!, id: slug(h[2]!) });
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s{0,3}>\s?/, ""));
      const note = NOTE.exec(body[0] ?? "")?.[1]?.toLowerCase() as Note | undefined;
      if (note) body.shift();
      out.push({ t: "quote", children: parseBlocks(body.join("\n")), ...(note ? { note } : {}) });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const head = cells(line);
      const align = cells(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push({ t: "table", head, align, rows });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const indent = item[1]!.length;
      const ordered = /\d/.test(item[2]!);
      const items: { text: string; children: Block[] }[] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m || m[1]!.length !== indent || /\d/.test(m[2]!) !== ordered) break;
        const text = [m[3]!];
        const sub: string[] = [];
        i++;
        while (i < lines.length) {
          const l = lines[i]!;
          const blank = !l.trim();
          const deeper = /^\s+/.exec(l)?.[0].length ?? 0;
          if (blank) {
            // A blank line stays in the item only if indented content follows.
            const nxt = lines[i + 1];
            if (nxt !== undefined && (/^\s+/.exec(nxt)?.[0].length ?? 0) > indent && nxt.trim()) {
              sub.push("");
              i++;
              continue;
            }
            break;
          }
          if (deeper <= indent) break;
          if (!sub.length && !ITEM.test(l) && !FENCE.test(l)) text.push(l.trim());
          else sub.push(l.slice(Math.min(deeper, indent + 2)));
          i++;
        }
        items.push({ text: text.join(" "), children: sub.length ? parseBlocks(sub.join("\n")) : [] });
        while (i < lines.length && !lines[i]!.trim() && ITEM.exec(lines[i + 1] ?? "")?.[1]?.length === indent) i++;
      }
      out.push({ t: "list", ordered, start: ordered ? parseInt(item[2]!, 10) : 1, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !FENCE.test(lines[i]!) && !/^#{1,6}\s/.test(lines[i]!) && !/^\s{0,3}>/.test(lines[i]!) && !(para.length && ITEM.test(lines[i]!))) {
      para.push(lines[i++]!.trim());
    }
    if (para.length) out.push({ t: "p", text: para.join("\n") });
    else i++;
  }
  return out;
}

const INLINE = /(`+)([^`]|[^`].*?[^`])\1(?!`)|\*\*([^\s*](?:.*?[^\s*])?)\*\*|(?<![\w*])\*([^\s*](?:.*?[^\s*])?)\*(?![\w*])|(?<![\w_])_([^\s_](?:.*?[^\s_])?)_(?![\w_])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?'"])/s;

export function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:|\/|#)/i.test(href) ? href : null;
}

export function inline(text: string, key = "i", resolve: (href: string) => string | null = safeHref, plain = false): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const k = `${key}${n++}`;
    if (m[1]) out.push(<code key={k} className="ic">{m[2]}</code>);
    else if (m[3] !== undefined) out.push(<strong key={k}>{inline(m[3], k, resolve, plain)}</strong>);
    else if (m[4] !== undefined) out.push(<em key={k}>{inline(m[4], k, resolve, plain)}</em>);
    else if (m[5] !== undefined) out.push(<em key={k}>{inline(m[5], k, resolve, plain)}</em>);
    else if (plain && m[6] !== undefined) out.push(<Fragment key={k}>{inline(m[6], k, resolve, plain)} ({m[7]})</Fragment>);
    else if (plain && m[8] !== undefined) out.push(m[8]);
    else if (m[6] !== undefined || m[8] !== undefined) {
      const href = m[7] !== undefined ? resolve(m[7]) : safeHref(m[8]!);
      const label = m[6] !== undefined ? inline(m[6], k, resolve) : m[8];
      if (!href) out.push(label);
      else if (href.startsWith("/")) out.push(<Link key={k} className="link" href={href}>{label}</Link>);
      else out.push(<a key={k} className="link" href={href} {...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{label}</a>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

const NOTE_LABEL: Record<Note, string> = { note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution" };

function renderBlock(b: Block, k: number, ctx: Ctx): ReactNode {
  const text = (t: string): ReactNode[] => inline(t, "i", ctx.href, ctx.plainLinks);
  switch (b.t) {
    case "h": {
      const Tag = `h${Math.min(6, b.level)}` as "h1";
      if (!ctx.anchors || !b.id) return <Tag key={k}>{text(b.text)}</Tag>;
      return (
        <Tag key={k} id={b.id}>
          {text(b.text)}
          <a className="md-anchor" href={`#${b.id}`} aria-label="Link to this section">
            #
          </a>
        </Tag>
      );
    }
    case "p":
      return <p key={k}>{text(b.text)}</p>;
    case "code":
      return <Code key={k} code={b.code} title={b.lang || "code"} />;
    case "hr":
      return <hr key={k} />;
    case "quote": {
      const inner = b.children.map((c, j) => renderBlock(c, j, { ...ctx, anchors: false }));
      if (!b.note) return <blockquote key={k}>{inner}</blockquote>;
      return (
        <aside key={k} className={`md-note ${b.note}`}>
          <span className="micro">{NOTE_LABEL[b.note]}</span>
          {inner}
        </aside>
      );
    }
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag key={k} start={b.ordered && b.start !== 1 ? b.start : undefined} style={b.ordered && b.start !== 1 ? { counterReset: `md ${b.start - 1}` } : undefined}>
          {b.items.map((it, j) => (
            <li key={j}>
              {text(it.text)}
              {it.children.map((c, x) => renderBlock(c, x, { ...ctx, anchors: false }))}
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div key={k} className="md-table" tabIndex={0} role="group" aria-label="Table">
          <table>
            <thead>
              <tr>{b.head.map((c, j) => <th key={j} style={{ textAlign: b.align[j] ?? "left" }}>{text(c)}</th>)}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, j) => (
                <tr key={j}>{b.head.map((_, x) => <td key={x} style={{ textAlign: b.align[x] ?? "left" }}>{text(r[x] ?? "")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Give repeated headings distinct ids, so every anchor on a page is unique. */
export function uniqueIds(blocks: Block[]): Block[] {
  const seen = new Map<string, number>();
  return blocks.map((b) => {
    if (b.t !== "h" || !b.id) return b;
    const n = (seen.get(b.id) ?? 0) + 1;
    seen.set(b.id, n);
    return n === 1 ? b : { ...b, id: `${b.id}-${n}` };
  });
}

export function Blocks({ blocks, anchors = false, href, plainLinks = false }: { blocks: Block[]; anchors?: boolean; href?: Ctx["href"]; plainLinks?: boolean }) {
  const ctx: Ctx = { anchors, href, plainLinks };
  return <Fragment>{blocks.map((b, k) => renderBlock(b, k, ctx))}</Fragment>;
}

export function Markdown({ text, anchors = false, plainLinks = false }: { text: string; anchors?: boolean; plainLinks?: boolean }) {
  const blocks = parseBlocks(text);
  return <Blocks blocks={anchors ? uniqueIds(blocks) : blocks} anchors={anchors} plainLinks={plainLinks} />;
}
