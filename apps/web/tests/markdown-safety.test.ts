import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { visible } from "../src/lib/inert";
import { inline, Markdown, namesOtherHost, safeHref } from "../src/lib/markdown";

const html = (text: string, props: object = {}): string => renderToStaticMarkup(createElement(Markdown, { text, ...props }));
/** Best of five, after a warm-up: a busy machine may be slow once, not five times. */
function fastest(run: () => void): number {
  run();
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    run();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("inline text of any shape is read in one pass", () => {
  const hostile: [string, string][] = [
    ["link openers", "[a]("],
    ["emphasis openers", " *a"],
    ["strong openers", " **a"],
    ["underscores", " _a"],
    ["backticks", " `a"],
    ["brackets", "[["],
    ["mixed backtick runs", "`` ` "],
  ];
  for (const [name, piece] of hostile) {
    it(`reads 64 KB of ${name} without rescanning`, () => {
      const text = piece.repeat(Math.ceil(65_536 / piece.length));
      // Openers that never close cost next to nothing. Backticks do pair up here, into ten thousand code spans,
      // which is honest work: still far from the seconds a rescan from every opener would take.
      expect(fastest(() => inline(text))).toBeLessThan(piece.includes("`") ? 400 : 50);
    });
  }

  it("does not slow down as the text doubles", () => {
    const at = (n: number): number => fastest(() => inline("[a](".repeat(n)));
    const small = Math.max(at(4_000), 0.2);
    expect(at(32_000)).toBeLessThan(small * 40);
  });

  it("still reads what it read before", () => {
    const out = html("Use **bold**, *em*, _em_, `code` and [the docs](/docs/pricing). See https://example.com/a.");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>em</em>");
    expect(out).toMatch(/<code[^>]*>code<\/code>/);
    expect(out).toContain('href="/docs/pricing"');
    expect(out).toContain('href="https://example.com/a"');
    expect(html("a `` b ` c `` d")).toMatch(/<code[^>]*> b ` c <\/code>/);
    expect(html("[see https://example.com/a here](/docs)").match(/<a /g)).toHaveLength(1);
    expect(html("2 * 3 * 4 and snake_case_name stay as they are")).not.toContain("<em>");
  });
});

describe("links in a model's words", () => {
  it("takes no address that leaves the site without saying so", () => {
    expect(safeHref("//evil.example/x")).toBeNull();
    expect(safeHref("/\\evil.example/x")).toBeNull();
    expect(safeHref("/docs/pricing")).toBe("/docs/pricing");
    expect(safeHref("#free")).toBe("#free");
    const out = html("[Your account](//evil.example/account)");
    expect(out).not.toContain("href=");
    expect(out).toContain("Your account");
  });

  it("shows a link plainly when its text names another host", () => {
    expect(namesOtherHost("https://freeweight.example/account", "https://evil.example/x")).toBe(true);
    expect(namesOtherHost("freeweight.example", "https://evil.example/x")).toBe(true);
    expect(namesOtherHost("docs.example.com", "https://docs.example.com/a")).toBe(false);
    expect(namesOtherHost("example.com", "https://docs.example.com/a")).toBe(false);
    expect(namesOtherHost("the docs", "https://docs.example.com/a")).toBe(false);
    const out = html("[https://bank.example/login](https://evil.example/login)");
    expect(out).not.toContain("<a ");
    expect(out).toContain("https://evil.example/login");
  });
});

describe("hidden characters in a model's words", () => {
  const sly = "Token name: ‮LLAW‬ 0x12​34";

  it("are shown as a mark, in the answer as in a tool row", () => {
    expect(visible(sly)).toBe("Token name: �LLAW� 0x12�34");
    const out = html(sly, { clean: true });
    expect(out).not.toMatch(/[‪-‮⁦-⁩​]/);
    expect(out).toContain("�LLAW�");
  });

  it("leaves a joined emoji whole", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    expect(visible(family)).toBe(family);
    expect(visible("a‍b")).toBe("a�b");
  });
});
