import { useEffect } from "react";
import { api, type Awake, type Model, type Stats } from "../api";
import { ago, clock, grouped, perMin, TIER_CLASS, typicalWake, usd } from "../lib/format";
import { loadFailed, refreshMe, useEvery, useLive, useLoad, useMe, useTitle } from "../lib/hooks";
import { Link } from "../router";
import { Icon, Notice, Rule, TierMark } from "../ui/bits";
import { WakeBox } from "../ui/wakebox";
import { ROADMAP } from "./roadmap-data";
import "./home.css";

export function Home() {
  useTitle("");
  const { models, awake, error } = useLive();
  const stats = useLoad(() => api.stats(), [], 10_000);
  const config = useLoad(() => api.config(), []);
  // A session this browser still has running, asked for afresh so one that just ended is not offered.
  const me = useMe();
  useEffect(() => {
    void refreshMe().catch(() => undefined);
  }, []);
  const running = me?.sessions.find((x) => x.state === "waking" || x.state === "active");
  const runningName = running && (models?.find((m) => m.id === running.model_id)?.name ?? running.model_id);

  return (
    <div className="home">
      <section className="wrap hero">
        <div className="hero-main">
          <p className="micro hero-kicker">Preview · open text models · per GPU minute</p>
          <h1 className="hero-h">
            Rent any open model <b>by the minute.</b>
          </h1>
          <p className="lead hero-lead">Models sleep as stored weights and cost nothing. Wake one on a GPU, typically in a minute or two, and pay only while your session runs. Never per token.</p>
          {running && (
            <div className="hero-resume">
              <Notice kind="brass">
                {running.state === "waking" ? "Your wake of " : "Your session on "}
                <strong>{runningName}</strong> is still {running.state === "waking" ? "going" : "running"}.{" "}
                <Link className="link" href={`/s/${running.id}`}>
                  Go back to it
                </Link>
              </Notice>
            </div>
          )}
          {models ? (
            <WakeBox models={models} config={config.data} />
          ) : error ? (
            <Notice kind="err">The catalog did not load. {loadFailed(error)}</Notice>
          ) : (
            <div className="box box-skel" aria-busy="true" />
          )}
        </div>

        <aside className="hero-side" aria-label="Live">
          <AwakeBoard awake={awake} models={models} down={Boolean(error)} />
          <Receipts models={models} />
          <Reps stats={stats.data} down={Boolean(stats.error)} />
        </aside>
      </section>

      <section className="wrap sect">
        <Rule label="How it works" id="how" />
        <HowItWorks />
      </section>

      <section className="wrap sect">
        <Rule label="Ghost hosting" id="ghost" />
        <Ghost />
      </section>

      <section className="wrap sect">
        <Rule label="Weight classes" id="classes" />
        <Classes />
      </section>

      <section className="wrap sect">
        <Rule label="Roadmap" />
        <div className="teaser">
          {ROADMAP.map((g) => (
            <div className="teaser-row" key={g.key}>
              <span className={`micro teaser-when ${g.key}`}>{g.title}</span>
              <span className="teaser-what">{g.items.map((i) => i.title).join(" · ")}</span>
            </div>
          ))}
          <Link href="/roadmap" className="link teaser-more">
            The full roadmap
          </Link>
        </div>
      </section>
    </div>
  );
}

/** The board holds at least this many models: the ones that are awake, then the asleep ones that wake quickest. */
const BOARD_ROWS = 5;
/** The median of a handful of wakes is not a number worth printing. */
const MEDIAN_FROM = 5;

function AwakeBoard({ awake, models, down }: { awake: Awake[] | null; models: Model[] | null; down: boolean }) {
  useEvery(1000);
  const rows = (awake ?? []).map((a) => ({ a, m: models?.find((x) => x.id === a.model_id) })).filter((r): r is { a: Awake; m: Model } => Boolean(r.m));
  const up = new Set(rows.map((r) => r.m.id));
  const near = (models ?? [])
    .filter((m) => m.state === "asleep" && !up.has(m.id))
    .sort((a, b) => (a.wake_estimate_s || 1e9) - (b.wake_estimate_s || 1e9))
    // The line that says nothing is awake takes a row of its own.
    .slice(0, Math.max(0, BOARD_ROWS - Math.max(rows.length, 1)));
  return (
    <div className="board">
      <div className="board-h">
        <span className="micro">Awake now</span>
        <span className="micro num">{awake ? rows.length : ""}</span>
      </div>
      {!awake || !models ? (
        down ? (
          <p className="board-empty dimmer">No answer from the gateway, so this list is empty for now.</p>
        ) : (
          // As many rows as the loaded board has, so nothing below it moves when the list arrives.
          <ul className="board-list" aria-hidden="true">
            {Array.from({ length: BOARD_ROWS }, (_, i) => (
              <li key={i} className="near">
                <span className="board-row">
                  <span className="board-dot" />
                  <span className="board-name">
                    <span className="skel" style={{ width: `${44 + ((i * 23) % 32)}%` }} />
                  </span>
                  <span className="board-meta">
                    <span className="skel" style={{ width: 132 }} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )
      ) : (
        <ul className="board-list">
          {rows.length === 0 && <li className="board-empty">Nothing awake. A wake typically takes a minute or two.</li>}
          {rows.map(({ a, m }) => (
            <li key={a.model_id}>
              <Link href={`/models/${m.id}`} className="board-row">
                <span className="board-dot" aria-hidden="true" />
                <span className="board-name">{m.name}</span>
                <span className="board-meta">
                  <TierMark tier={m.tier} plain />
                  <span className="mono">
                    {a.sessions} {a.sessions === 1 ? "session" : "sessions"} · {ago(Date.now() - a.since)}
                  </span>
                </span>
                <Icon name="arrow" size={14} />
              </Link>
            </li>
          ))}
          {near.map((m) => (
            <li key={m.id} className="near">
              <Link href={`/models/${m.id}`} className="board-row">
                <span className="board-dot" aria-hidden="true" />
                <span className="board-name">{m.name}</span>
                <span className="board-meta">
                  <TierMark tier={m.tier} plain />
                  <span className="mono">asleep · {typicalWake(m.wake_estimate_s) ? `typical wake ${typicalWake(m.wake_estimate_s)}` : "wake not measured yet"}</span>
                </span>
                <Icon name="arrow" size={14} />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p className="board-fine">An awake model is shared. Joining one is instant, and each session pays its own minutes.</p>
    </div>
  );
}

const RECEIPT_ROWS = 3;
/** The last sessions that ended and what each one cost. Shown only once there is one: the board never pads itself. */
function Receipts({ models }: { models: Model[] | null }) {
  const { data } = useLoad(() => api.receipts(), [], 20_000);
  const rows = (data ?? []).slice(0, RECEIPT_ROWS);
  if (rows.length === 0) return null;
  return (
    <div className="board">
      <div className="board-h">
        <span className="micro">Last receipts</span>
        <span className="micro">What sessions cost</span>
      </div>
      <ul className="board-list">
        {rows.map((r, i) => (
          <li key={`${r.model_id}-${r.ended_at}-${i}`} className="rcpt">
            <span className="board-name">{models?.find((m) => m.id === r.model_id)?.name ?? r.model_id}</span>
            <b className={`mono rcpt-total${r.free ? " dim" : ""}`}>{r.free ? "free" : usd(r.price_usd_micro)}</b>
            <span className="board-meta mono">
              {r.minutes.toFixed(2)} min
              {r.wake_s >= 1 ? ` · wake ${clock(r.wake_s * 1000)}` : ""} · {ago(Date.now() - r.ended_at)} ago
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Reps({ stats, down }: { stats: Stats | null; down: boolean }) {
  // A number that did not arrive is shown as missing, never as a zero and never as a loader that spins for ever.
  const cell = (label: string, value: string | null) => (
    <div className="readout">
      <span className="micro">{label}</span>
      <b className={value == null && down ? "dimmer" : undefined}>{value ?? (down ? "n/a" : <span className="skel" />)}</b>
    </div>
  );
  return (
    <div className="reps">
      <div className="board-h">
        <span className="micro">Reps</span>
        <span className="micro">since preview began</span>
      </div>
      <div className="reps-grid">
        {cell("GPU-seconds", stats && grouped(stats.gpu_seconds))}
        {cell("Sessions", stats && grouped(stats.sessions))}
        {cell("Wakes", stats && grouped(stats.wakes))}
        {cell("Median wake", stats && (stats.wakes >= MEDIAN_FROM && stats.median_wake_s ? clock(stats.median_wake_s * 1000) : "\u2014"))}
      </div>
      {stats && stats.wakes < MEDIAN_FROM && <p className="board-fine">{stats.sessions === 0 ? "No sessions yet. " : ""}The median shows after five wakes.</p>}
    </div>
  );
}

const HOW = [
  { k: "Asleep", t: "Stored weights. No GPU, no cost." },
  { k: "Wake", t: "A GPU loads the model, typically in a minute or two. Not billed." },
  { k: "Awake", t: "Chat, call the endpoint, run tools. Billed by the second, one-minute minimum once the model is awake." },
  { k: "Asleep again", t: "You stop, or the time runs out. Back to storage." },
];

function HowItWorks() {
  return (
    <figure className="how">
      <div className="how-plot" aria-hidden="true">
        <div className="how-seg sleep">
          <span className="micro">$0</span>
        </div>
        <div className="how-seg wake">
          {[18, 34, 50, 70, 100].map((h) => (
            <i key={h} style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="how-seg awake">
          {Array.from({ length: 12 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
        <div className="how-seg sleep">
          <span className="micro">$0</span>
        </div>
      </div>
      <div className="scale" aria-hidden="true" />
      <ol className="how-legend">
        {HOW.map((h, i) => (
          <li key={h.k}>
            <span className="micro">
              <span className="num">{i + 1}</span> {h.k}
            </span>
            <p>{h.t}</p>
          </li>
        ))}
      </ol>
    </figure>
  );
}

const DAY = 1440;
const SESSIONS: [number, number][] = [
  [9 * 60 + 10, 30],
  [14 * 60, 25],
  [21 * 60 + 20, 35],
];

function Ghost() {
  const used = SESSIONS.reduce((n, [, d]) => n + d, 0);
  return (
    <div className="ghost">
      <div className="ghost-copy">
        <h2 className="h2">A model nobody is using should cost nothing.</h2>
        <p className="dim">
          Put a custom model on an always-on endpoint and it bills all 1,440 minutes of the day, whether anyone calls it or not. That is ghost hosting. Here an idle model is a file in storage, and
          the meter only runs while a session does.
        </p>
      </div>
      <figure className="ghost-fig">
        <div className="day">
          <div className="day-h">
            <span>Always on</span>
            <span className="mono">
              {grouped(DAY)} min · ${((DAY * 3) / 100).toFixed(2)}
            </span>
          </div>
          <div className="day-strip full" aria-hidden="true" />
        </div>
        <div className="day">
          <div className="day-h">
            <span>Freeweight</span>
            <span className="mono accent">
              {used} min · ${((used * 3) / 100).toFixed(2)}
            </span>
          </div>
          <div className="day-strip" aria-hidden="true">
            {SESSIONS.map(([at, d]) => (
              <i key={at} style={{ left: `${(at / DAY) * 100}%`, width: `${(d / DAY) * 100}%` }} />
            ))}
          </div>
        </div>
        <div className="day-scale" aria-hidden="true">
          <div className="scale" />
          <div className="day-hours micro">
            <span>00</span>
            <span>06</span>
            <span>12</span>
            <span>18</span>
            <span>24</span>
          </div>
        </div>
        <figcaption className="small dimmer">The same day on one Light model at $0.03 per GPU minute: three sessions of 25 to 35 minutes, against a GPU that never sleeps.</figcaption>
      </figure>
    </div>
  );
}

const CLASSES = [
  { tier: "light", price: 30_000, note: "The free try runs here." },
  { tier: "medium", price: 60_000, note: "Mid-size models and longer context." },
  { tier: "heavy", price: 100_000, note: "In preview. Slower to wake." },
] as const;

function Classes() {
  return (
    <div className="classes">
      <p className="dim classes-copy">The model decides its class, never you. One price per class, per GPU minute, whatever the model says or however many tokens it writes.</p>
      <div className="classes-rows">
        {CLASSES.map((c) => (
          <Link key={c.tier} href={`/models?class=${c.tier}`} className="class-row">
            <span className={`class-name tw-${c.tier}`}>
              <TierMark tier={c.tier} />
            </span>
            <span className="micro class-card">{TIER_CLASS[c.tier]}</span>
            <span className="dim class-note">{c.note}</span>
            <span className="mono class-price">{perMin(c.price)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
