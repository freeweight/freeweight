// 404, and the "no such model / no such page" state other views fall back to.

import { useTitle } from "../lib/hooks";
import { Link } from "../router";
import { Icon } from "../ui/bits";
import "./notfound.css";

type Props = { params?: Record<string, string>; title?: string; text?: string; back?: { href: string; label: string } };

export default function NotFound({ title = "Nothing at this address", text = "The page may have moved, or the link is wrong.", back }: Props) {
  useTitle("Not found");
  const path = typeof location === "undefined" ? "" : location.pathname;
  return (
    <div className="wrap page nf">
      {/* The mark with every plate taken off: outlines only. */}
      <svg className="nf-mark" viewBox="0 0 24 24" width="72" height="72" fill="none" stroke="currentColor" strokeWidth="0.5" aria-hidden="true">
        <rect x="2.25" y="2.25" width="19.5" height="4.5" rx="0.75" strokeDasharray="1.5 1" />
        <rect x="2.25" y="9.75" width="12.5" height="4.5" rx="0.75" strokeDasharray="1.5 1" />
        <rect x="2.25" y="17.25" width="5.5" height="4.5" rx="0.75" strokeDasharray="1.5 1" />
      </svg>
      <p className="micro">404 · not found</p>
      <h1 className="nf-h">{title}</h1>
      <p className="nf-text">{text}</p>
      {path && <p className="nf-path mono">{path}</p>}
      <div className="nf-go">
        <Link href={back?.href ?? "/"} className="btn primary">
          {back?.label ?? "Go to the start"}
          <Icon name="arrow" />
        </Link>
        {!back && (
          <Link href="/models" className="btn">
            See the models
          </Link>
        )}
      </div>
    </div>
  );
}
