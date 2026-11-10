// A tiny history router: one path store, a Link, and a pattern matcher.

import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from "react";

const subs = new Set<() => void>();
function emit(): void {
  for (const s of subs) s();
}
if (typeof window !== "undefined") window.addEventListener("popstate", emit);

export function navigate(to: string, opts: { replace?: boolean; keepScroll?: boolean } = {}): void {
  if (to === location.pathname + location.search + location.hash) return;
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  emit();
  if (opts.keepScroll) return;
  const hash = to.split("#")[1];
  const el = hash ? document.getElementById(hash) : null;
  if (el) el.scrollIntoView();
  else window.scrollTo(0, 0);
}

export function usePath(): string {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => location.pathname,
    () => "/",
  );
}

/** Match "/models/:id" against a path. Returns params, or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const v = b[i]!;
    if (p.startsWith(":")) out[p.slice(1)] = decodeURIComponent(v);
    else if (p !== v) return null;
  }
  return out;
}

/** Paths the gateway answers itself: files at the site root and the API. A link to one leaves the app. */
export function isOutside(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || /^\/(api|v1|mcp)(\/|$|[?#])/.test(href) || /\.(txt|ya?ml|json|xml|pdf)([?#]|$)/i.test(href);
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; current?: boolean };

export function Link({ href, onClick, current, ...rest }: LinkProps) {
  function click(e: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (rest.target || isOutside(href)) return;
    e.preventDefault();
    navigate(href);
  }
  return <a href={href} onClick={click} aria-current={current ? "page" : undefined} {...rest} />;
}
