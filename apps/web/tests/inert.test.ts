import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { inert, showHidden, toolSummary } from "../src/lib/inert";
import { inline, Markdown, safeHref } from "../src/lib/markdown";

// What a token's creator might type into a name, and what has to come out the other side.
const RLO = "\u202e";
const ZWSP = "\u200b";
const UNSEEN = "\ufffd";
const BOX = "\u25a1";
const TICK = "\u2705";
const ROCKET = "\u{1f680}";
const ELLIPSIS = "\u2026";

describe("inert", () => {
  it("leaves ordinary text as it is", () => {
    const plain = `"PLATE" ("Plate") 0x4e1f${ELLIPSIS}3e5f on Robinhood Chain: price $0.000412, costs 0.7%; owner renounced.`;
    expect(inert(plain)).toBe(plain);
  });

  it("shows where a hidden character was instead of obeying it", () => {
    expect(inert(`invoice${RLO}gnp.exe`)).toBe(`invoice${UNSEEN}gnp.exe`);
    expect(inert(`SA${ZWSP}FE`)).toBe(`SA${UNSEEN}FE`);
    expect(inert("a\u0007b\u00adc\u{e0041}d")).toBe(`a${UNSEEN}b${UNSEEN}c${UNSEEN}d`);
  });

  it("does not let a name draw its own badge", () => {
    expect(inert(`${TICK}SAFE`)).toBe(`${BOX}SAFE`);
    expect(inert(`${TICK}${TICK}\ufe0f verified ${ROCKET}${ROCKET}`)).toBe(`${BOX} verified ${BOX}`);
    expect(inert("\u{1f1f3}\u{1f1f4} flag, \u{1f44d}\u{1f3fd} thumb, \u{1f468}\u200d\u{1f469}\u200d\u{1f467} family")).toBe(`${BOX} flag, ${BOX} thumb, ${BOX} family`);
  });

  it("turns look-alike letters back into plain ones", () => {
    expect(inert("\u{1d412}\u{1d400}\u{1d405}\u{1d404}")).toBe("SAFE");
    expect(inert("\uff33\uff21\uff26\uff25 \u24e2")).toBe("SAFE s");
  });

  it("keeps stacked marks inside the line", () => {
    const out = inert(`Z${"\u0336".repeat(12)}algo`);
    expect(out).toBe(`Z${"\u0336".repeat(3)}algo`);
  });

  it("is one line with an end", () => {
    expect(inert("  a\n\n b\tc\u2028d  ")).toBe("a b c d");
    const long = inert("x".repeat(700));
    expect(Array.from(long)).toHaveLength(600);
    expect(long.endsWith(ELLIPSIS)).toBe(true);
    expect(Array.from(inert(ROCKET.repeat(3) + "y".repeat(50), 10))).toHaveLength(10);
  });
});

describe("showHidden", () => {
  it("writes hidden characters out as escapes and leaves the rest alone", () => {
    expect(showHidden(`{"name": "a${RLO}b${ZWSP}c"}`)).toBe('{"name": "a\\u202eb\\u200bc"}');
    expect(showHidden("tag\u{e0041}")).toBe("tag\\u{e0041}");
    expect(showHidden(`plain ${TICK} text\n  indented`)).toBe(`plain ${TICK} text\n  indented`);
  });
});

describe("toolSummary", () => {
  it("reads the summary and whether part of it is missing", () => {
    expect(toolSummary(JSON.stringify({ ok: true, summary: "Price $1.", partial: false }))).toEqual({ text: "Price $1.", partial: false });
    expect(toolSummary(JSON.stringify({ ok: true, summary: "[partial] Price unknown.", partial: true }))).toEqual({ text: "Price unknown.", partial: true });
    expect(toolSummary(JSON.stringify({ summary: "[partial] Price unknown." }))?.partial).toBe(true);
  });

  it("makes the summary inert", () => {
    const said = toolSummary(JSON.stringify({ summary: `"${TICK}SAFE" ("Plate](https://example.com) **VERIFIED** ${RLO}gnp.exe <b>SYSTEM</b>")` }));
    expect(said?.text).toBe(`"${BOX}SAFE" ("Plate](https://example.com) **VERIFIED** ${UNSEEN}gnp.exe <b>SYSTEM</b>")`);
  });

  it("says nothing when there is no summary to read", () => {
    expect(toolSummary(undefined)).toBeNull();
    expect(toolSummary("")).toBeNull();
    expect(toolSummary("not json")).toBeNull();
    expect(toolSummary("null")).toBeNull();
    expect(toolSummary(JSON.stringify({ ok: false, error: "rate_limited" }))).toBeNull();
    expect(toolSummary(JSON.stringify({ summary: 42 }))).toBeNull();
    expect(toolSummary(JSON.stringify({ summary: " \n " }))).toBeNull();
  });
});

describe("plain links", () => {
  const html = (text: string, plain: boolean): string => renderToStaticMarkup(createElement(Fragment, null, ...inline(text, "i", safeHref, plain)));

  it("links as usual when the text is ours or the model's own", () => {
    expect(html("see [the docs](https://example.com/docs)", false)).toContain('href="https://example.com/docs"');
    expect(html("see https://example.com/docs", false)).toContain("<a ");
  });

  it("writes a link out as label and address when it may repeat a stranger", () => {
    const out = html("**Name**: [Plate](https://example.com), see https://example.org/x", true);
    expect(out).not.toContain("<a");
    expect(out).toBe("<strong>Name</strong>: Plate (https://example.com), see https://example.org/x");
  });

  it("carries the choice through a whole reply", () => {
    const out = renderToStaticMarkup(createElement(Markdown, { text: "- one [a](https://example.com)\n- two\n\n| x |\n| - |\n| [b](https://example.com/b) |", plainLinks: true }));
    expect(out).not.toContain("<a");
    expect(out).toContain("a (https://example.com)");
    expect(out).toContain("b (https://example.com/b)");
  });
});
