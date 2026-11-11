// A model's reasoning arrives as one long run of text. The room shows it as steps: one sentence, list item or
// short line each. Nothing here asks a model for a summary: the steps are the model's own words, cut where it
// paused.

/** Short forms that end in a full stop without ending a sentence. */
const SHORT = /^(?:e\.g|i\.e|etc|vs|cf|approx|no|fig|mr|mrs|ms|dr|st)\.$/i;
/** A list marker, a quote mark or a heading mark at the start of a line. */
const LEAD = /^\s*(?:(?:[-*+•>]|#{1,6}|\d{1,3}[.)])\s+)+/;
const CLOSERS = "\"'”’)]*_`";

function tidy(line: string): string {
  return line
    .replace(LEAD, "")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where the sentences of one line end. A full stop after a number or a short form does not end one. */
function sentences(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if ("。！？".includes(c)) {
      out.push(line.slice(from, i + 1));
      from = i + 1;
      continue;
    }
    if (c !== "." && c !== "!" && c !== "?" && c !== "…") continue;
    let end = i + 1;
    while (end < line.length && ".!?…".includes(line[end]!)) end++;
    while (end < line.length && CLOSERS.includes(line[end]!)) end++;
    // A sentence ends before a space and a capital, a digit or an opening mark. "v0.7", "3.5" and "a.b" go on.
    if (end >= line.length || line[end] !== " ") {
      i = end - 1;
      continue;
    }
    const next = line[end + 1] ?? "";
    const word = line.slice(line.lastIndexOf(" ", i) + 1, i + 1);
    const starts = next !== "" && (next !== next.toLowerCase() || /[\d"'“‘(\[]/.test(next) || next > "⹿");
    if (c === "." && (SHORT.test(word) || /^\d+\.$/.test(word) || /^[A-Za-z]\.$/.test(word))) {
      i = end - 1;
      continue;
    }
    if (!starts) {
      i = end - 1;
      continue;
    }
    out.push(line.slice(from, end));
    from = end + 1;
    i = end;
  }
  if (from < line.length) out.push(line.slice(from));
  return out;
}

/**
 * The steps in a run of reasoning, in order. While the text is still arriving the last step is the one being
 * written: it grows from call to call, and the steps before it stay as they are.
 */
export function steps(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  let code = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced;
      code = false;
      continue;
    }
    const line = tidy(raw);
    // A line with no letter or digit in it ("...", "---") is not a step.
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    if (fenced) {
      // A code block inside reasoning is one step, named by its first line.
      if (!code) out.push(line);
      code = true;
      continue;
    }
    // One or two words ("Okay.", "So.") lead into the sentence that follows them on the same line. Scripts
    // that write without spaces are left alone: there a whole sentence can be one word.
    let lead = "";
    for (const s of sentences(line)) {
      const step = (lead + s).trim();
      if (!/[\p{L}\p{N}]/u.test(step)) continue;
      if (step.split(" ").length < 3 && !/[\u2e80-\uffef]/.test(step)) {
        lead = `${step} `;
        continue;
      }
      lead = "";
      out.push(step);
    }
    if (lead) out.push(lead.trim());
  }
  return out;
}

/** "7 s", "1 min 12 s". Whole seconds, and never zero: a thought that was shown took some time. */
export function thoughtFor(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}
