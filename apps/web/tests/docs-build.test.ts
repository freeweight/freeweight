import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { collectDocs } from "../scripts/vite-docs";

const made: string[] = [];
function dirs(): { site: string; fixtures: string } {
  const root = mkdtempSync(join(tmpdir(), "fw-docs-"));
  made.push(root);
  const site = join(root, "site");
  const fixtures = join(root, "fixtures");
  mkdirSync(site);
  mkdirSync(fixtures);
  return { site, fixtures };
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

describe("collecting the docs pages for a build", () => {
  it("lets a real page replace its stand-in, and marks the stand-ins that are left", () => {
    const d = dirs();
    writeFileSync(join(d.fixtures, "pricing.md"), "# Pricing\n\nStand-in.\n");
    writeFileSync(join(d.fixtures, "terms.md"), "# Terms\n\nStand-in.\n");
    writeFileSync(join(d.site, "pricing.md"), "# Pricing\n\nThe real page.\n");
    const pages = collectDocs(d.site, d.fixtures);
    expect(pages.find((p) => p.slug === "pricing")?.fixture).toBe(false);
    expect(pages.find((p) => p.slug === "terms")?.fixture).toBe(true);
  });

  it("works from the stand-ins alone when the real pages are not there", () => {
    const d = dirs();
    writeFileSync(join(d.fixtures, "pricing.md"), "# Pricing\n");
    expect(collectDocs(join(d.site, "missing"), d.fixtures).map((p) => p.slug)).toEqual(["pricing"]);
  });

  it("refuses two files that would be the same page", () => {
    const d = dirs();
    writeFileSync(join(d.site, "Pricing.md"), "# Pricing\n");
    writeFileSync(join(d.site, "pricing.md"), "# Pricing\n");
    expect(() => collectDocs(d.site, d.fixtures)).toThrow(/Pricing\.md and pricing\.md/);
  });
});
