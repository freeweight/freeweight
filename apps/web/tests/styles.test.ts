import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Each view brings its own stylesheet, and a sheet stays in the page once its view has loaded. So a rule
// one view writes for a bare class (`.wake { ... }`) also styles every other view's element that carries
// that class name. These tests keep the views' class names apart.

const VIEWS = join(__dirname, "../src/views");

/** The selectors of a stylesheet, one per entry, with comments and at-rule lines left out. */
const selectors = (css: string): string[] =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
    .map((m) => m[1]!.trim())
    .filter((prelude) => prelude && !prelude.startsWith("@") && !/^(from|to|[\d.]+%)/.test(prelude))
    .flatMap((prelude) => prelude.split(",").map((s) => s.trim()));

const classes = (list: string[]) => new Set(list.flatMap((s) => [...s.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!)));
/** Classes a sheet styles on their own: `.name { ... }` and nothing else in the selector. */
const bare = (list: string[]) => new Set(list.filter((s) => /^\.[A-Za-z_][\w-]*$/.test(s)).map((s) => s.slice(1)));

describe("selectors", () => {
  it("reads selectors and skips comments, at-rules and keyframe steps", () => {
    const css = "/* .gone { } */ .a, .b > i { x: 1 } @media (min-width: 9px) { .c.d:hover { y: 2 } } @keyframes k { from { o: 0 } 50% { o: 1 } }";
    expect(selectors(css)).toEqual([".a", ".b > i", ".c.d:hover"]);
  });
});

describe("view stylesheets", () => {
  const sheets = readdirSync(VIEWS)
    .filter((f) => f.endsWith(".css"))
    .map((f) => ({ name: f, list: selectors(readFileSync(join(VIEWS, f), "utf8")) }));

  it("finds the sheets", () => {
    expect(sheets.length).toBeGreaterThan(4);
    expect(sheets.find((s) => s.name === "session.css")?.list).toContain(".wake");
  });

  it("no view styles a bare class that another view also uses", () => {
    const clashes: string[] = [];
    for (const a of sheets) {
      for (const b of sheets) {
        if (a === b) continue;
        const used = classes(b.list);
        for (const name of bare(a.list)) if (used.has(name)) clashes.push(`.${name}: styled on its own in ${a.name}, used in ${b.name}`);
      }
    }
    expect(clashes).toEqual([]);
  });
});
