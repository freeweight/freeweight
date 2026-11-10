// Primitives: the mark, plates, state tags, icons, copy, code, segmented control.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ModelState, Tier } from "../api/types";
import { TIER_NAME, TIER_PLATES } from "../lib/format";

/** The mark: three plates in descending width. An F, and the three weight classes. */
export function Mark({ size = 20, live = false }: { size?: number; live?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="20" height="5" rx="1" className={live ? "live" : undefined} />
      <rect x="2" y="9.5" width="13" height="5" rx="1" />
      <rect x="2" y="17" width="6" height="5" rx="1" />
    </svg>
  );
}

export function Plates({ tier }: { tier: Tier }) {
  const n = TIER_PLATES[tier];
  return (
    <span className="plates" aria-hidden="true">
      {[3, 2, 1].map((i) => (
        <i key={i} className={i <= n ? undefined : "off"} />
      ))}
    </span>
  );
}

/** A tier, named in its own weight. */
export function TierMark({ tier, plain = false }: { tier: Tier; plain?: boolean }) {
  return (
    <span className="tier">
      {!plain && <Plates tier={tier} />}
      <span className={`tw-${tier}`}>{TIER_NAME[tier]}</span>
    </span>
  );
}

const STATE_LABEL: Record<ModelState, string> = { asleep: "asleep", waking: "waking", awake: "awake", cold: "cold", unavailable: "unavailable" };
export function StateTag({ state }: { state: ModelState }) {
  return <span className={`state ${state}`}>{STATE_LABEL[state]}</span>;
}

// ---------- icons: 16 grid, 1.5 stroke, square caps ----------

type IconName = "arrow" | "out" | "check" | "cross" | "copy" | "chevron" | "stop" | "up" | "menu" | "theme" | "redo" | "minus";
const PATHS: Record<IconName, ReactNode> = {
  arrow: <path d="M2.5 8h10M8.5 4l4 4-4 4" />,
  out: <path d="M5 11l6-6M6 5h5v5" />,
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  copy: <path d="M5.5 5.5h7v7h-7zM3.5 10.5v-7h7" />,
  chevron: <path d="M4 6l4 4 4-4" />,
  stop: <rect x="4" y="4" width="8" height="8" fill="currentColor" stroke="none" />,
  up: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
  menu: <path d="M2.5 5.5h11M2.5 10.5h11" />,
  theme: (
    <>
      <rect x="3" y="3" width="10" height="10" />
      <path d="M8 3v10h5V3z" fill="currentColor" stroke="none" />
    </>
  ),
  redo: <path d="M12.5 3.5v3.5H9M12.2 7A4.75 4.75 0 1 0 12.75 9.5" />,
  minus: <path d="M3.5 8h9" />,
};
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square" strokeLinejoin="miter" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

// ---------- copy ----------

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return (
    <button
      type="button"
      className={`copy${done ? " done" : ""}`}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          clearTimeout(t.current);
          t.current = setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
      <span aria-live="polite">{done ? "Copied" : label}</span>
    </button>
  );
}

/**
 * A block of code with a copy button. It scrolls sideways when a line is too long; with `wrap` (narrow panels,
 * one-line values) long lines fold instead, and the folded part hangs under its line.
 */
export function Code({ code, title, wrap = false }: { code: string; title?: string; wrap?: boolean }) {
  return (
    <div className="code">
      <div className="code-h">
        <span className="micro">{title ?? "text"}</span>
        <Copy text={code} />
      </div>
      <pre className={wrap ? "wrap" : undefined} tabIndex={0}>
        <code>{wrap ? code.split("\n").map((line, i) => <span key={i}>{`${line}\n`}</span>) : code}</code>
      </pre>
    </div>
  );
}

// ---------- segmented ----------

export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: readonly { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** A section divider: a graduated rule with a hanging label. */
export function Rule({ label, id }: { label: string; id?: string }) {
  return (
    <div className="rule" id={id}>
      <span className="micro">{label}</span>
      <div className="scale" aria-hidden="true" />
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "err" | "brass"; children: ReactNode }) {
  return (
    <div className={`notice${kind === "info" ? "" : ` ${kind}`}`} role={kind === "err" ? "alert" : undefined}>
      <div>{children}</div>
    </div>
  );
}
