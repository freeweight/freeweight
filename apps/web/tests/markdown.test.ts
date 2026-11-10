import { describe, expect, it } from "vitest";
import { parseBlocks, safeHref, slug, uniqueIds, type Block } from "../src/lib/markdown";

const kinds = (src: string): string[] => parseBlocks(src).map((b) => b.t);

describe("parseBlocks", () => {
  it("reads headings with ids", () => {
    expect(parseBlocks("## Call it from `code`")).toEqual([{ t: "h", level: 2, text: "Call it from `code`", id: "call-it-from-code" }]);
    expect(parseBlocks("# Title #")[0]).toMatchObject({ level: 1, text: "Title" });
  });

  it("joins the lines of a paragraph and splits on blank lines", () => {
    expect(parseBlocks("one\ntwo\n\nthree")).toEqual([
      { t: "p", text: "one\ntwo" },
      { t: "p", text: "three" },
    ]);
  });

  it("keeps fenced code verbatim, with its language", () => {
    const [b] = parseBlocks("```ts\nconst a = 1;\n\n# not a heading\n```\nafter");
    expect(b).toEqual({ t: "code", lang: "ts", code: "const a = 1;\n\n# not a heading" });
    expect(kinds("```ts\nconst a = 1;\n```\nafter")).toEqual(["code", "p"]);
  });

  it("renders a half-streamed code block instead of waiting for the closing fence", () => {
    expect(parseBlocks("text\n```py\nprint(1)")).toEqual([
      { t: "p", text: "text" },
      { t: "code", lang: "py", code: "print(1)" },
    ]);
  });

  it("reads lists, ordered lists and nesting", () => {
    const [ul] = parseBlocks("- one\n- two\n  - inner\n- three");
    expect(ul).toMatchObject({ t: "list", ordered: false });
    const items = (ul as Extract<Block, { t: "list" }>).items;
    expect(items.map((i) => i.text)).toEqual(["one", "two", "three"]);
    expect(items[1]!.children[0]).toMatchObject({ t: "list", items: [{ text: "inner" }] });

    const [ol] = parseBlocks("3. three\n4. four");
    expect(ol).toMatchObject({ t: "list", ordered: true, start: 3 });
  });

  it("reads tables with alignment", () => {
    const [t] = parseBlocks("| Class | Price |\n| :-- | --: |\n| Light | $0.03 |\n| a \\| b | 1 |");
    expect(t).toEqual({
      t: "table",
      head: ["Class", "Price"],
      align: ["left", "right"],
      rows: [
        ["Light", "$0.03"],
        ["a | b", "1"],
      ],
    });
  });

  it("reads quotes and notes", () => {
    expect(parseBlocks("> quoted\n> text")).toEqual([{ t: "quote", children: [{ t: "p", text: "quoted\ntext" }] }]);
    expect(parseBlocks("> [!WARNING]\n> Top-ups are closed.")).toEqual([{ t: "quote", note: "warning", children: [{ t: "p", text: "Top-ups are closed." }] }]);
  });

  it("reads rules", () => {
    expect(kinds("a\n\n---\n\nb")).toEqual(["p", "hr", "p"]);
  });

  it("never turns raw HTML into markup: it stays text", () => {
    expect(parseBlocks('<script>alert(1)</script>\n<img src=x onerror="alert(1)">')).toEqual([{ t: "p", text: '<script>alert(1)</script>\n<img src=x onerror="alert(1)">' }]);
  });
});

describe("links and ids", () => {
  it("allows only web, mail, site and in-page links", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("/docs/pricing")).toBe("/docs/pricing");
    expect(safeHref("#errors")).toBe("#errors");
    expect(safeHref("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>1</script>")).toBeNull();
    expect(safeHref("pricing.md")).toBeNull();
  });

  it("makes ids from heading text", () => {
    expect(slug("What you pay, per GPU minute")).toBe("what-you-pay-per-gpu-minute");
    expect(slug("`auto_session` keys")).toBe("auto_session-keys");
  });

  it("keeps repeated headings apart", () => {
    const ids = uniqueIds(parseBlocks("## Errors\n\n## Errors\n\n## Errors")).map((b) => (b.t === "h" ? b.id : ""));
    expect(ids).toEqual(["errors", "errors-2", "errors-3"]);
  });
});
