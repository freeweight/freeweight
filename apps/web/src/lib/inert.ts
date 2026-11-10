// Text written by someone we do not vouch for: a token's name, a revert reason, a tool summary that quotes them.
// React already keeps it from becoming markup. These keep it from reordering the line, hiding characters,
// dressing up in look-alike letters or drawing its own badges.

// Controls, soft hyphen, bidi marks and overrides, zero-width characters, line separators, tag characters.
const HIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;
// Pictures: emoji and their modifiers, dingbats, shapes, box drawing. Inside a name they read as a badge or a control.
// A run of them, with the joiners and tags that glue emoji together, counts as one.
const PICTURE = /[\p{So}\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}\ufe00-\ufe0f\u20e3][\p{So}\p{Extended_Pictographic}\u{1f1e6}-\u{1f1ff}\u{1f3fb}-\u{1f3ff}\ufe00-\ufe0f\u20e3\u200d\u{e0020}-\u{e007f}]*/gu;
// More than three combining marks in a row is decoration that climbs out of its line.
const STACKED = /(\p{M}{3})\p{M}+/gu;

const ELLIPSIS = "\u2026";
const UNSEEN = "\ufffd";
const BLANK = "\u25a1";

/** One line of plain prose: what was written, with nothing hidden, nothing that draws, and an end. */
export function inert(text: string, max = 600): string {
  const plain = text
    // Bold, script and full-width look-alikes go back to plain letters. Our own ellipsis is kept as it is.
    .split(ELLIPSIS)
    .map((part) => part.normalize("NFKC"))
    .join(ELLIPSIS)
    .replace(/\s+/g, " ")
    // Pictures first: the mark for a hidden character is itself a symbol and must survive.
    .replace(PICTURE, BLANK)
    .replace(HIDDEN, UNSEEN)
    .replace(STACKED, "$1")
    .trim();
  const chars = Array.from(plain);
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}${ELLIPSIS}` : plain;
}

/**
 * Running prose from a model: the text as written, line breaks and all, with each hidden character shown as the
 * mark the tool rows use. A joiner between two emoji is part of one picture and stays.
 */
export function visible(text: string): string {
  return text.replace(HIDDEN, (c, at: number, all: string) => (c === "\u200d" && /\p{Extended_Pictographic}/u.test(all.slice(at + 1, at + 3)) && at > 0 ? c : UNSEEN));
}

/** For a raw view (JSON, arguments): the text as it is, with each hidden character written out as its escape. */
export function showHidden(text: string): string {
  return text.replace(HIDDEN, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
  });
}

/** What a tool said, read from the JSON it returned: its short summary, and whether some of it is missing. */
export function toolSummary(result: string | undefined): { text: string; partial: boolean } | null {
  if (!result) return null;
  try {
    const r = JSON.parse(result) as { summary?: unknown; partial?: unknown } | null;
    if (!r || typeof r.summary !== "string") return null;
    const marked = /^\s*\[partial\]\s*/i;
    const text = inert(r.summary.replace(marked, ""), 480);
    return text ? { text, partial: r.partial === true || marked.test(r.summary) } : null;
  } catch {
    return null;
  }
}
