// A small markdown renderer for chat and docs. It builds React nodes (never HTML strings), copes with a
// half-streamed document, and covers what models and our docs write: headings, lists, tables, code, quotes, links.

import { Fragment, type ReactNode } from "react";
import { Link } from "../router";
import { Code } from "../ui/bits";
import { visible } from "./inert";
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

/** Where a link may go: a web address, a mail address, a path on this site, or a place on this page. */
export function safeHref(href: string): string | null {
  // A site path starts with one slash. Two slashes, or a slash and a backslash, name another host.
  return /^(https?:\/\/|mailto:|\/(?![/\\])|#)/i.test(href) ? href : null;
}

/** True when a link's label reads as an address on one host while the link goes to another. */
export function namesOtherHost(label: string, href: string): boolean {
  let to: string;
  try {
    to = new URL(href).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  const named = [...label.matchAll(/(?:https?:\/\/|www\.)((?:[a-z0-9-]+\.)+[a-z]{2,})/gi)].map((m) => m[1]!);
  const whole = /^\s*((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[/:?#]\S*)?\s*$/i.exec(label)?.[1];
  if (whole) named.push(whole);
  return named.some((h) => {
    const host = h.toLowerCase().replace(/^www\./, "");
    return host !== to && !to.endsWith(`.${host}`);
  });
}

const TICK = 96;
const STAR = 42;
const UNDER = 95;
const OPEN = 91;
const spaceOr = (c: string | undefined, mark: string): boolean => c === undefined || c === mark || /\s/.test(c);
const wordOr = (c: string | undefined, mark: string): boolean => c !== undefined && (c === mark || /\w/.test(c));
/** Emphasis nested deeper than this is written out as it is. */
const MAX_DEPTH = 6;

type Ticks = { at: number[]; len: number[]; byLen: Map<number, number[]>; next: Map<number, number> };
function tickRuns(text: string): Ticks {
  const t: Ticks = { at: [], len: [], byLen: new Map(), next: new Map() };
  for (let q = text.indexOf("`"); q >= 0; ) {
    let len = 1;
    while (text.charCodeAt(q + len) === TICK) len++;
    const list = t.byLen.get(len) ?? [];
    if (!list.length) t.byLen.set(len, list);
    list.push(t.at.length);
    t.at.push(q);
    t.len.push(len);
    q = text.indexOf("`", q + len);
  }
  return t;
}

/**
 * Inline markdown: code, bold, emphasis, links and bare web addresses. One pass from left to right. A search for a
 * closing mark that fails is not made again, and what a match covers is not read again at the same depth, so the
 * work grows with the length of the text and not with how many marks open and never close.
 */
export function inline(text: string, key = "i", resolve: (href: string) => string | null = safeHref, plain = false, depth = 0): ReactNode[] {
  if (depth > MAX_DEPTH) return [text];
  const out: ReactNode[] = [];
  const n = text.length;
  let i = 0;
  let from = 0;
  let count = 0;
  const none = { strong: false, star: false, under: false, bracket: false };
  let ticks: Ticks | null = null;
  let run = 0;
  let closeAt = -1;
  let stopFrom = -1;
  let stopAt = -1;
  const put = (start: number, end: number, node: (k: string) => ReactNode): void => {
    if (start > from) out.push(text.slice(from, start));
    out.push(node(`${key}${count++}`));
    from = i = end;
  };
  const inner = (part: string, k: string, asPlain = plain): ReactNode[] => inline(part, k, resolve, asPlain, depth + 1);
  /** `mark` opens at `at`: where does the emphasis close? -1 when it does not. */
  const closing = (mark: string, at: number): number => {
    let q = text.indexOf(mark, at + 2);
    while (q >= 0 && (spaceOr(text[q - 1], mark) || wordOr(text[q + 1], mark))) q = text.indexOf(mark, q + 1);
    return q;
  };

  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === TICK) {
      ticks ??= tickRuns(text);
      while (ticks.at[run]! < i) run++;
      const len = ticks.len[run]!;
      let done = false;
      // The whole run opens a span if a run of the same length follows. Failing that, its last marks may.
      for (let l = len; l >= 1 && !done; l--) {
        const list = ticks.byLen.get(l);
        if (!list) continue;
        let p = ticks.next.get(l) ?? 0;
        while (p < list.length && list[p]! <= run) p++;
        ticks.next.set(l, p);
        if (p >= list.length) continue;
        const end = ticks.at[list[p]!]!;
        const code = text.slice(i + len, end);
        put(i + len - l, end + l, (k) => <code key={k} className="ic">{code}</code>);
        done = true;
      }
      if (!done) i += len;
      continue;
    }
    if (c === STAR && text.charCodeAt(i + 1) === STAR && !none.strong && !spaceOr(text[i + 2], "*")) {
      let q = text.indexOf("**", i + 3);
      while (q >= 0 && spaceOr(text[q - 1], "*")) q = text.indexOf("**", q + 1);
      if (q >= 0) {
        const part = text.slice(i + 2, q);
        put(i, q + 2, (k) => <strong key={k}>{inner(part, k)}</strong>);
        continue;
      }
      none.strong = true;
    }
    if ((c === STAR && !none.star) || (c === UNDER && !none.under)) {
      const mark = c === STAR ? "*" : "_";
      if (!wordOr(text[i - 1], mark) && !spaceOr(text[i + 1], mark)) {
        const q = closing(mark, i);
        if (q >= 0) {
          const part = text.slice(i + 1, q);
          put(i, q + 1, (k) => <em key={k}>{inner(part, k)}</em>);
          continue;
        }
        if (c === STAR) none.star = true;
        else none.under = true;
      }
    }
    if (c === OPEN && !none.bracket) {
      if (closeAt < i + 1) closeAt = text.indexOf("]", i + 1);
      if (closeAt < 0) none.bracket = true;
      else if (closeAt > i + 1 && text[closeAt + 1] === "(") {
        const h0 = closeAt + 2;
        if (h0 < stopFrom || h0 > stopAt) {
          stopFrom = h0;
          stopAt = h0;
          while (stopAt < n && text[stopAt] !== ")" && !/\s/.test(text[stopAt]!)) stopAt++;
        }
        if (stopAt > h0 && text[stopAt] === ")") {
          const label = text.slice(i + 1, closeAt);
          const raw = text.slice(h0, stopAt);
          put(i, stopAt + 1, (k) => {
            if (plain) return <Fragment key={k}>{inner(label, k)} ({raw})</Fragment>;
            const href = resolve(raw);
            // The text of a link is never itself a link.
            const shown = inner(label, k, true);
            if (!href) return shown;
            // A label that reads as one address over a link to another is written out, so both can be seen.
            if (namesOtherHost(label, href)) return <Fragment key={k}>{shown} ({href})</Fragment>;
            return link(href, shown, k);
          });
          continue;
        }
      }
    }
    if (c === 104 && (text.startsWith("http://", i) || text.startsWith("https://", i))) {
      const s0 = i + (text[i + 4] === "s" ? 8 : 7);
      let e = s0;
      while (e < n && !/[\s<>)\]]/.test(text[e]!)) e++;
      while (e > s0 && ".,;:!?'\"".includes(text[e - 1]!)) e--;
      if (e > s0) {
        const url = text.slice(i, e);
        put(i, e, (k) => (plain ? url : link(url, url, k)));
        continue;
      }
    }
    i++;
  }
  if (from < n) out.push(text.slice(from));
  return out;
}

function link(href: string, label: ReactNode, k: string): ReactNode {
  if (href.startsWith("/")) return <Link key={k} className="link" href={href}>{label}</Link>;
  return <a key={k} className="link" href={href} {...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{label}</a>;
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

/** `clean` is for text we did not write: hidden and direction-changing characters are shown as a mark. */
export function Markdown({ text, anchors = false, plainLinks = false, clean = false }: { text: string; anchors?: boolean; plainLinks?: boolean; clean?: boolean }) {
  const blocks = parseBlocks(clean ? visible(text) : text);
  return <Blocks blocks={anchors ? uniqueIds(blocks) : blocks} anchors={anchors} plainLinks={plainLinks} />;
}
