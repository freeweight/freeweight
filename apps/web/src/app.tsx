import { lazy, Suspense, useEffect, useRef, useState, type ComponentType } from "react";
import { MOCK } from "./api";
import { shortAddr } from "./lib/format";
import { HOSTED_PATH } from "./lib/hosted";
import { useLive, useMe } from "./lib/hooks";
import { Link, match, usePath } from "./router";
import { Icon, Mark } from "./ui/bits";
import { Home } from "./views/Home";

const loadSession = () => import("./views/Session");
const SessionView = lazy(loadSession);
const Catalog = lazy(() => import("./views/Catalog"));
const ModelDetail = lazy(() => import("./views/ModelDetail"));
const Account = lazy(() => import("./views/Account"));
const ListModel = lazy(() => import("./views/ListModel"));
const Docs = lazy(() => import("./views/Docs"));
const Hosted = lazy(() => import("./views/Hosted"));
const Roadmap = lazy(() => import("./views/Roadmap"));
const NotFound = lazy(() => import("./views/NotFound"));

type Params = Record<string, string>;
const ROUTES: [string, ComponentType<{ params: Params }>][] = [
  ["/", Home],
  ["/s/:id", SessionView],
  [HOSTED_PATH, Hosted],
  ["/models", Catalog],
  ["/models/:id", ModelDetail],
  ["/account", Account],
  ["/list", ListModel],
  ["/docs", Docs],
  ["/docs/:slug", Docs],
  ["/roadmap", Roadmap],
];

const NAV = [
  { href: "/models", label: "Models" },
  { href: "/list", label: "List a model" },
  { href: "/docs", label: "Docs" },
  { href: "/roadmap", label: "Roadmap" },
];

function toggleTheme(): void {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") ?? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  const next = cur === "light" ? "dark" : "light";
  root.setAttribute("data-theme", next);
  try {
    localStorage.setItem("fw_theme", next);
  } catch {
    /* private mode */
  }
}

export function App() {
  const path = usePath();
  const me = useMe();
  const { awake } = useLive();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLElement>(null);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    // The open menu takes the focus, and Escape closes it and hands the focus back to its button.
    if (!open) return;
    drawer.current?.querySelector("a")?.focus();
    const key = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      setOpen(false);
      menu.current?.focus();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [open]);
  const first = useRef(true);
  useEffect(() => {
    // A new page starts at its heading, for the keyboard and for a screen reader alike. The views load on
    // demand, so the heading may be a moment away.
    if (first.current) {
      first.current = false;
      return;
    }
    let tries = 0;
    let timer = 0;
    const go = (): void => {
      const h = document.querySelector<HTMLElement>("#main h1");
      if (h) {
        h.tabIndex = -1;
        h.focus({ preventScroll: true });
      } else if (++tries < 40) timer = window.setTimeout(go, 50);
      else document.getElementById("main")?.focus({ preventScroll: true });
    };
    go();
    return () => clearTimeout(timer);
  }, [path]);
  useEffect(() => {
    // Warm the session view so a wake starts without a network round trip for code.
    const t = setTimeout(() => void loadSession(), 1200);
    return () => clearTimeout(t);
  }, []);

  let View: ComponentType<{ params: Params }> = NotFound;
  let params: Params = {};
  for (const [pattern, C] of ROUTES) {
    const m = match(pattern, path);
    if (m) {
      View = C;
      params = m;
      break;
    }
  }
  // A room fills the window: a session, and the chat of the always-awake model.
  const inSession = path.startsWith("/s/") || path === HOSTED_PATH;
  const live = (awake?.length ?? 0) > 0;

  return (
    <div className="app">
      <a className="sr" href="#main">
        Skip to content
      </a>
      <header className="hdr">
        <div className="wrap hdr-in">
          <Link href="/" className="brand" aria-label="Freeweight, home">
            <Mark live={live} />
            <span>Freeweight</span>
            {MOCK && <span className="micro brand-mock">mock</span>}
          </Link>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} current={path === n.href || path.startsWith(n.href + "/")}>
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="hdr-right">
            <button type="button" className="hdr-btn" onClick={toggleTheme} aria-label="Switch between dark and light">
              <Icon name="theme" />
            </button>
            <Link href="/account" className="hdr-btn hdr-acct">
              {me?.address ? <span className="mono">{shortAddr(me.address)}</span> : "Sign in"}
            </Link>
            <button type="button" className="hdr-btn hdr-menu" ref={menu} aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Icon name={open ? "cross" : "menu"} />
            </button>
          </div>
        </div>
      </header>
      {open && (
        <nav className="drawer" ref={drawer} aria-label="Site menu">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} onClick={() => setOpen(false)}>
              {n.label}
              <Icon name="arrow" />
            </Link>
          ))}
        </nav>
      )}
      <p className="sr" id="page-note" role="status" />
      <main className="main" id="main" tabIndex={-1}>
        <Suspense fallback={<div className="page wrap" aria-busy="true" />}>
          <View params={params} key={path} />
        </Suspense>
      </main>
      {!inSession && (
        <footer className="ftr">
          <div className="wrap ftr-in">
            <span>Freeweight. Rent any open model by the minute. Preview: prices are per GPU minute, in USD; the one always-awake model is priced per token.</span>
            <nav aria-label="Footer">
              <Link href="/docs">Docs</Link>
              <Link href="/docs/pricing">Pricing</Link>
              <Link href="/docs/terms">Terms</Link>
              <Link href="/docs/privacy">Privacy</Link>
              <Link href="/roadmap">Roadmap</Link>
            </nav>
          </div>
        </footer>
      )}
    </div>
  );
}
