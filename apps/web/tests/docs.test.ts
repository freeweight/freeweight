import { describe, expect, it } from "vitest";
import { docHref, dropTitle, groupDocs, neighbours, outline, plain } from "../src/lib/docs";
import { docMeta, frontMatter, sortDocs, titleFromSlug, type DocMeta } from "../src/lib/frontmatter";
import { parseBlocks } from "../src/lib/markdown";

const page = (slug: string, order: number, group = ""): DocMeta => ({ slug, title: titleFromSlug(slug), summary: "", order, group, fixture: false });

describe("front-matter", () => {
  it("splits the block from the body", () => {
    const { meta, body } = frontMatter('---\ntitle: "Pricing"\nsummary: Per GPU minute: never per token.\norder: 2\n---\n\n## Classes\n');
    expect(meta).toEqual({ title: "Pricing", summary: "Per GPU minute: never per token.", order: "2" });
    expect(body).toBe("\n## Classes\n");
  });
  it("leaves a page without a block alone", () => {
    expect(frontMatter("# Hello\n\n---\n\ntext")).toEqual({ meta: {}, body: "# Hello\n\n---\n\ntext" });
  });
  it("accepts CRLF files", () => {
    expect(frontMatter("---\r\ntitle: A\r\n---\r\nbody").meta).toEqual({ title: "A" });
  });
  it("falls back to the first heading, then the file name, for a title", () => {
    expect(docMeta("faq", "---\norder: 9\n---\n# Questions people ask\n", false)).toMatchObject({ title: "Questions people ask", order: 9, group: "" });
    expect(docMeta("acceptable-use", "plain text", true)).toMatchObject({ title: "Acceptable use", order: 999, fixture: true });
  });
  it("sorts by order, then by name", () => {
    expect(sortDocs([page("b", 2), page("z", 1), page("a", 2)]).map((d) => d.slug)).toEqual(["z", "a", "b"]);
  });
});

describe("docs index", () => {
  const index = [page("quickstart", 1, "Start"), page("pricing", 2, "Start"), page("api", 3, "Build"), page("terms", 9, "Legal")];

  it("groups pages in index order", () => {
    expect(groupDocs(index).map((g) => [g.group, g.pages.map((p) => p.slug)])).toEqual([
      ["Start", ["quickstart", "pricing"]],
      ["Build", ["api"]],
      ["Legal", ["terms"]],
    ]);
  });
  it("finds the pages before and after", () => {
    expect(neighbours(index, "quickstart")).toMatchObject({ prev: null, next: { slug: "pricing" } });
    expect(neighbours(index, "terms")).toMatchObject({ prev: { slug: "api" }, next: null });
    expect(neighbours(index, "nope")).toEqual({ prev: null, next: null });
  });
});

describe("links between pages", () => {
  const slugs = new Set(["pricing", "api", "acceptable-use"]);

  it("maps a page file onto its route", () => {
    expect(docHref("pricing.md", slugs)).toBe("/docs/pricing");
    expect(docHref("./api.md#errors", slugs)).toBe("/docs/api#errors");
    expect(docHref("acceptable-use", slugs)).toBe("/docs/acceptable-use");
    expect(docHref("/docs/API", slugs)).toBe("/docs/api");
  });
  it("maps the published files onto the site root", () => {
    expect(docHref("../api/openapi.yaml", slugs)).toBe("/openapi.yaml");
    expect(docHref("llms.txt", slugs)).toBe("/llms.txt");
    expect(docHref("https://example.com/openapi.yaml", slugs)).toBeNull();
  });
  it("leaves everything else to the ordinary link rules", () => {
    expect(docHref("missing.md", slugs)).toBeNull();
    expect(docHref("https://example.com", slugs)).toBeNull();
    expect(docHref("#errors", slugs)).toBeNull();
    expect(docHref("/models", slugs)).toBeNull();
    expect(docHref("javascript:alert(1)", slugs)).toBeNull();
  });
});

describe("page outline", () => {
  it("lists second-level headings as plain text", () => {
    const blocks = parseBlocks("# Title\n\n## Wake a `model`\n\ntext\n\n### Detail\n\n## See [pricing](pricing.md)\n");
    expect(outline(blocks)).toEqual([
      { id: "wake-a-model", text: "Wake a model" },
      { id: "see-pricingpricingmd", text: "See pricing" },
    ]);
    expect(plain("**Bold** and `code`")).toBe("Bold and code");
  });
  it("drops a leading title, and only a leading one", () => {
    expect(dropTitle(parseBlocks("# Title\n\ntext")).map((b) => b.t)).toEqual(["p"]);
    expect(dropTitle(parseBlocks("text\n\n# Later")).map((b) => b.t)).toEqual(["p", "h"]);
    expect(dropTitle([])).toEqual([]);
  });
});
