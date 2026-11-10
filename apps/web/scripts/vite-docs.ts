// Build-time docs: reads the Markdown pages of the site and exposes them to the app as `virtual:docs`.
//
//   index    front-matter of every page, sorted, for the left index and the "next" link
//   loaders  one lazy import per page, so a page's text is fetched only when it is opened
//   files    the plain files published at the site root (llms.txt, openapi.yaml) that exist in this build
//
// Pages in `site` win. A page that only exists in `fixtures` is a stand-in until the real text lands.
// The plugin also publishes a few plain files (llms.txt, openapi.yaml) at the site root when they exist.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import type { Plugin } from "vite";
import { docMeta, sortDocs, type DocMeta } from "../src/lib/frontmatter";

const VIRTUAL = "virtual:docs";
const RESOLVED = "\0" + VIRTUAL;

const TYPES: Record<string, string> = {
  txt: "text/plain; charset=utf-8",
  yaml: "application/yaml; charset=utf-8",
  yml: "application/yaml; charset=utf-8",
  json: "application/json; charset=utf-8",
};

export type DocsOptions = {
  /** Directory of real pages (`<slug>.md`). May not exist yet. */
  site: string;
  /** Directory of stand-in pages inside the app. */
  fixtures: string;
  /** Files to publish at the site root: served path -> source file. Skipped when the source is missing. */
  publish?: Record<string, string>;
};

type Page = DocMeta & { file: string };

export function collectDocs(site: string, fixtures: string): Page[] {
  const bySlug = new Map<string, Page>();
  for (const [dir, fixture] of [
    [fixtures, true],
    [site, false],
  ] as const) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith(".md")) continue;
      const slug = basename(f, ".md").toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) continue;
      const file = resolve(dir, f);
      bySlug.set(slug, { ...docMeta(slug, readFileSync(file, "utf8"), fixture), file });
    }
  }
  const order = sortDocs([...bySlug.values()]).map((p) => p.slug);
  return order.map((s) => bySlug.get(s)!);
}

export function docs(opts: DocsOptions): Plugin {
  const publish = opts.publish ?? {};
  return {
    name: "freeweight-docs",
    resolveId(id) {
      return id === VIRTUAL ? RESOLVED : undefined;
    },
    load(id) {
      if (id !== RESOLVED) return undefined;
      const pages = collectDocs(opts.site, opts.fixtures);
      for (const p of pages) this.addWatchFile(p.file);
      const index = pages.map(({ file: _file, ...meta }) => meta);
      const loaders = pages.map((p) => `  ${JSON.stringify(p.slug)}: () => import(${JSON.stringify(p.file.split(sep).join("/") + "?raw")}).then((m) => m.default),`);
      const files = Object.keys(publish).filter((name) => existsSync(publish[name]!));
      for (const src of Object.values(publish)) this.addWatchFile(src);
      return `export const index = ${JSON.stringify(index)};\nexport const files = ${JSON.stringify(files)};\nexport const loaders = {\n${loaders.join("\n")}\n};\n`;
    },
    configureServer(server) {
      // A page added or removed changes the index: rebuild the virtual module and reload.
      server.watcher.add([opts.site, opts.fixtures]);
      const refresh = (file: string): void => {
        if (!file.endsWith(".md") || !(file.startsWith(opts.site) || file.startsWith(opts.fixtures))) return;
        const mod = server.moduleGraph.getModuleById(RESOLVED);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", refresh);
      server.watcher.on("unlink", refresh);
      server.watcher.on("change", refresh);
      server.middlewares.use((req, res, next) => {
        const name = (req.url ?? "").split("?")[0]!.slice(1);
        const src = publish[name];
        if (!src || !existsSync(src)) return next();
        res.setHeader("Content-Type", TYPES[name.split(".").pop() ?? ""] ?? "text/plain; charset=utf-8");
        res.end(readFileSync(src));
      });
    },
    generateBundle() {
      for (const [fileName, src] of Object.entries(publish)) {
        if (existsSync(src)) this.emitFile({ type: "asset", fileName, source: readFileSync(src) });
      }
    },
  };
}
