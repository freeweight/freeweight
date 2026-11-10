// Docs: Markdown pages from the repo, an index built from their front-matter, an outline and a next link.
// A page's text is loaded when it is opened; only the index ships with this view.

import { useEffect, useMemo, useState } from "react";
import { files, index, loaders } from "virtual:docs";
import { docHref, dropTitle, groupDocs, neighbours, outline, type Heading } from "../lib/docs";
import { frontMatter } from "../lib/frontmatter";
import { useTitle } from "../lib/hooks";
import { Blocks, parseBlocks, safeHref, uniqueIds } from "../lib/markdown";
import { Link } from "../router";
import { Icon, Notice } from "../ui/bits";
import NotFound from "./NotFound";
import "./docs.css";

const GROUPS = groupDocs(index);
const SLUGS: ReadonlySet<string> = new Set(index.map((d) => d.slug));
const resolve = (href: string): string | null => docHref(href, SLUGS) ?? safeHref(href);

const FILE_LABEL: Record<string, string> = { "llms.txt": "llms.txt", "openapi.yaml": "OpenAPI" };

export default function Docs({ params }: { params: Record<string, string> }) {
  const slug = (params.slug ?? index[0]?.slug ?? "").toLowerCase();
  const meta = index.find((d) => d.slug === slug) ?? null;
  const [page, setPage] = useState<{ text: string | null; failed: boolean }>({ text: null, failed: false });
  const [tries, setTries] = useState(0);
  const [open, setOpen] = useState(false);
  useTitle(meta ? `${meta.title} · Docs` : "Docs");

  useEffect(() => {
    const load = loaders[slug];
    if (!load) return;
    let live = true;
    setPage({ text: null, failed: false });
    load().then(
      (text) => live && setPage({ text, failed: false }),
      () => live && setPage({ text: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [slug, tries]);

  const blocks = useMemo(() => (page.text === null ? null : uniqueIds(dropTitle(parseBlocks(frontMatter(page.text).body)))), [page.text]);
  const heads = useMemo(() => (blocks ? outline(blocks) : []), [blocks]);
  const at = useSpy(heads);

  // A link to a section of another page lands on that section once the page is in.
  useEffect(() => {
    if (!blocks || !location.hash) return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  }, [blocks]);

  if (!meta) {
    return <NotFound title="No docs page with this name" text="It may have been renamed. The index lists every page." back={{ href: "/docs", label: "Open the docs" }} />;
  }
  const { prev, next } = neighbours(index, slug);

  return (
    <div className="wrap page docs">
      <nav className={`docs-nav${open ? " open" : ""}`} aria-label="Docs">
        <button type="button" className="docs-pick" aria-expanded={open} aria-controls="docs-index" onClick={() => setOpen((o) => !o)}>
          <span className="micro">Docs</span>
          <b>{meta.title}</b>
          <Icon name="chevron" />
        </button>
        <div className="docs-index" id="docs-index">
          {GROUPS.map((g) => (
            <div key={g.group} className="docs-group">
              {g.group && <p className="micro">{g.group}</p>}
              <ul>
                {g.pages.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/docs/${p.slug}`} current={p.slug === slug}>
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {files.length > 0 && (
            <div className="docs-group">
              <p className="micro">For machines</p>
              <ul>
                {files.map((f) => (
                  <li key={f}>
                    <a href={`/${f}`}>
                      {FILE_LABEL[f] ?? f}
                      <Icon name="out" size={12} />
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </nav>

      <article className="docs-main" aria-busy={!blocks && !page.failed}>
        <header className="docs-head">
          <p className="micro">{meta.group || "Docs"}</p>
          <h1 className="docs-title">{meta.title}</h1>
          {meta.summary && <p className="lead">{meta.summary}</p>}
        </header>

        {page.failed ? (
          <Notice kind="err">
            This page did not load.{" "}
            <button type="button" className="link" onClick={() => setTries((n) => n + 1)}>
              Try again
            </button>
          </Notice>
        ) : !blocks ? (
          <div className="docs-skel" aria-hidden="true">
            {[38, 96, 88, 92, 54, 0, 30, 94, 90, 62].map((w, i) => (w ? <span key={i} className="skel" style={{ width: `${w}%` }} /> : <span key={i} className="docs-skel-gap" />))}
          </div>
        ) : (
          <div className="md docs-md">
            <Blocks blocks={blocks} anchors href={resolve} />
          </div>
        )}

        {(prev || next) && (
          <nav className="docs-step" aria-label="More pages">
            {prev ? (
              <Link href={`/docs/${prev.slug}`} className="docs-prev">
                <span className="micro">Previous</span>
                <b>{prev.title}</b>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link href={`/docs/${next.slug}`} className="docs-next">
                <span className="micro">Next</span>
                <b>
                  {next.title}
                  <Icon name="arrow" />
                </b>
                {next.summary && <span className="docs-next-sum">{next.summary}</span>}
              </Link>
            )}
          </nav>
        )}
      </article>

      <aside className="docs-toc" aria-label="On this page">
        {heads.length > 1 && (
          <>
            <p className="micro">On this page</p>
            <ul>
              {heads.map((h) => (
                <li key={h.id}>
                  <a href={`#${h.id}`} aria-current={h.id === at ? "location" : undefined}>
                    {h.text}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
    </div>
  );
}

/** Which section is being read: the last heading that has passed under the header. */
function useSpy(heads: Heading[]): string | null {
  const [at, setAt] = useState<string | null>(null);
  useEffect(() => {
    if (heads.length < 2) return;
    let frame = 0;
    const read = (): void => {
      frame = 0;
      let cur: string | null = heads[0]?.id ?? null;
      for (const h of heads) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top <= 96) cur = h.id;
      }
      setAt(cur);
    };
    const onScroll = (): void => {
      frame ||= requestAnimationFrame(read);
    };
    read();
    addEventListener("scroll", onScroll, { passive: true });
    return () => {
      removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [heads]);
  return at;
}
