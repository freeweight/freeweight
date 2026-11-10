// The wake: a timer that gains weight as the machine takes load, and every stage laid out on one time scale.

import { useRef, useState, type CSSProperties } from "react";
import { api, DEFAULT_CONFIG, type Model, type Session, type Stage } from "../../api";
import { clock, clockTenths, context, perMin, shortSha, TIER_CLASS, took, typicalWake } from "../../lib/format";
import { useConfig, useFrame } from "../../lib/hooks";
import { turnstileToken } from "../../lib/turnstile";
import type { Live } from "../../lib/session";
import { loadWeight, rack, scaleMax, ticks, type Row } from "../../lib/wake";
import { Link, navigate } from "../../router";
import { Icon, TierMark } from "../../ui/bits";

// What each stage is, in words that hold whatever order the machine takes them in.
const SAY: Record<Exclude<Stage, "ready" | "failed">, string> = {
  queued: "In the queue.",
  gpu: "Waiting for a GPU.",
  container: "The container is starting.",
  weights: "Loading the weights.",
  engine: "Starting the inference engine.",
};
/** A stage that has run this long on its own gets a word that it is still going. Real stages have sat for two minutes. */
const LONG_STAGE_MS = 45_000;

/** Each character in its own fixed cell, so a running timer never shifts the layout, at any weight. */
export function Digits({ text }: { text: string }) {
  return (
    <>
      {[...text].map((c, i) => (
        <b key={i} className={/\d/.test(c) ? undefined : "sep"}>
          {c}
        </b>
      ))}
    </>
  );
}

export function Facts({ model, session }: { model: Model | null; session: Session | null }) {
  const freeMin = useConfig()?.free_minutes ?? DEFAULT_CONFIG.free_minutes;
  if (!model) {
    return (
      <dl className="facts" aria-busy="true">
        {["Model", "Quant", "Class", "Price", "Context", "Licence"].map((k) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>
              <span className="skel" style={{ width: k === "Model" ? "70%" : "30%" }} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <dl className="facts">
      <div>
        <dt>Model</dt>
        <dd className="mono small">
          {model.hf_repo}
          <span className="dimmer">@{shortSha(model.sha)}</span>
        </dd>
      </div>
      <div>
        <dt>Quant</dt>
        <dd className="mono small">{model.quant}</dd>
      </div>
      <div>
        <dt>Class</dt>
        <dd className="facts-row">
          <TierMark tier={model.tier} />
          <span className="dimmer small">· {TIER_CLASS[model.tier]}</span>
        </dd>
      </div>
      <div>
        <dt>Price</dt>
        <dd>
          <span className="mono small">{perMin(model.price_usd_micro_per_min)}</span> <span className="dimmer small">· by the second once awake, one-minute minimum</span>
        </dd>
      </div>
      <div>
        <dt>Context</dt>
        <dd className="mono small">{context(model.context)} tokens</dd>
      </div>
      <div>
        <dt>Licence</dt>
        <dd className="mono small">{model.license}</dd>
      </div>
      {session && (
        <div>
          <dt>Session</dt>
          <dd>{session.free ? `Free, ${freeMin} minutes` : "Paid, billed by the second"}</dd>
        </div>
      )}
    </dl>
  );
}

function value(row: Row): string {
  if (row.at == null || row.status === "held") return "";
  if (row.stage === "ready") return "awake";
  if (row.took == null) return "";
  // One unit down the whole column, so the stages compare at a glance.
  return row.took >= 600_000 ? clock(row.took) : `${(row.took / 1000).toFixed(1)} s`;
}

/** Why a wake that is over did not end awake. A cancel is the visitor's own doing, so it is not dressed as an error. */
type Ending = "cancelled" | "timeout" | "funding" | "failed";
function ending(s: Session): Ending {
  const why = s.receipt?.reason;
  return why === "stopped" ? "cancelled" : why === "wake_timeout" ? "timeout" : why === "funding_error" ? "funding" : "failed";
}

export function Wake({ live, session: s, model }: { live: Live; session: Session; model: Model | null }) {
  const running = s.state === "waking";
  useFrame(running);
  const [retrying, setRetrying] = useState(false);
  const config = useConfig();
  const tsHost = useRef<HTMLDivElement>(null);

  // A wake the gateway ended without a last event (a timeout, a cancel) still ends: the rows stop where the clock did.
  const cut = s.state === "failed" && !s.stages.some((e) => e.stage === "failed" || e.stage === "ready");
  const r = rack(cut ? [...s.stages, { stage: "failed", t_ms: live.wakeElapsed() }] : s.stages, live.wakeElapsed(), live.heldAt());
  const ready = r.readyAt != null;
  const failed = !ready && (s.state === "failed" || r.failedAt != null);
  const how = failed ? ending(s) : null;
  const cancelled = how === "cancelled";
  const attempt = Math.max(1, r.attempt);
  const degraded = running && Boolean(s.degraded);
  const shown = r.readyAt ?? r.failedAt ?? r.elapsed;
  // A model nobody has timed yet has no typical wake: the scale still needs a width, the page shows no figure.
  const est = typicalWake(model?.wake_estimate_s);
  const estS = est ? (model?.wake_estimate_s ?? 100) : 100;
  // The typical time is the catalog's figure for this model, a mark on the scale and never a promise. It is only
  // worth showing against a first, healthy try: after a failure, a retry or a gap in the detail it goes.
  const typical = Boolean(model) && est !== null && !failed && !degraded && attempt === 1;
  const max = scaleMax(estS, shown);
  const tk = ticks(max);
  const pct = (ms: number): string => `${Math.min(100, (ms / max) * 100).toFixed(3)}%`;
  const instant = ready && s.stages.length === 1;
  const late = running && typical && shown > estS * 1250;
  const long = running && r.rows.some((x) => x.status === "active" && (x.took ?? 0) >= LONG_STAGE_MS);
  const failedRow = r.rows.find((x) => x.status === "failed");
  const [main, tenths] = clockTenths(shown).split(".");
  const where = failedRow ? ` at ${failedRow.label.toLowerCase()}` : "";
  const freeBack = s.free ? ", and today's free session is still yours" : "";

  async function again(): Promise<void> {
    // A failed free wake gives the free session back, so it can start straight away. Anything else goes through the model page.
    if (!s.free || cancelled) return navigate(`/models/${s.model_id}`);
    setRetrying(true);
    try {
      // Every free start needs a human check of its own: the token the first try used is spent.
      const turnstile = config?.turnstile_sitekey && tsHost.current ? await turnstileToken(config.turnstile_sitekey, tsHost.current) : undefined;
      const next = await api.createSession(s.model_id, { free: true, turnstile });
      navigate(`/s/${next.id}`);
    } catch {
      navigate(`/models/${s.model_id}`);
    }
  }

  return (
    <div className={`wrap wake${ready ? " is-ready" : ""}${failed ? " is-failed" : ""}${cancelled ? " is-cancelled" : ""}`}>
      <div className="wk-top">
        <div className="wk-main">
          <div className="wk-kick">
            <span className={`state ${failed ? "asleep" : ready ? "awake" : "waking"}`}>{cancelled ? "wake cancelled" : failed ? "wake failed" : ready ? "awake" : "waking"}</span>
            <h1 className="wk-name">{model?.name ?? s.model_id}</h1>
            {attempt > 1 && <span className="tag">attempt {attempt}</span>}
          </div>
          <div className="wk-timer" style={{ fontWeight: loadWeight(r.current, ready) }} role="timer" aria-label={`Elapsed ${clock(shown)}`}>
            <Digits text={main ?? "0:00"} />
            <span className="wk-tenths">
              <Digits text={`.${tenths ?? "0"}`} />
            </span>
          </div>
          <p className="wk-status" aria-live="polite">
            {how === "cancelled" ? (
              <>
                <strong>You cancelled the wake.</strong>{" "}
                <span className="dim">Nothing was charged.{s.free ? " The wake had already started, so today's free session counts as used." : ""}</span>
              </>
            ) : how === "timeout" ? (
              <>
                <strong className="bad">The wake ran out of time{where}.</strong> <span className="dim">Nothing was charged{freeBack}.</span>
              </>
            ) : how === "funding" ? (
              <>
                <strong className="bad">The balance hold for this session did not go through.</strong> <span className="dim">Nothing was charged.</span>
              </>
            ) : how === "failed" ? (
              <>
                <strong className="bad">
                  {cut ? `The wake did not finish${where}.` : `The wake failed${where} after ${took(shown)}${attempt > 1 ? `, on attempt ${attempt}` : ""}.`}
                </strong>{" "}
                <span className="dim">Nothing was charged{freeBack}.</span>
              </>
            ) : ready ? (
              instant ? (
                <>
                  Already awake. <span className="dim">Joining now.</span>
                </>
              ) : (
                <>
                  Awake in {took(shown)}. <span className="dim">The wake is not billed. Opening your session.</span>
                </>
              )
            ) : degraded ? (
              <>
                The wake is still going.{" "}
                <span className="dim">Live stage detail is unavailable for the moment, so the rows below show the last report. The wake is not billed.</span>
              </>
            ) : (
              <>
                {r.current && r.current !== "ready" && r.current !== "failed" ? SAY[r.current] : "Starting the wake."}{" "}
                <span className="dim">
                  {attempt > 1
                    ? `${attempt > 2 ? "Earlier tries" : "The first try"} did not start, so this is attempt ${attempt}. The clock kept running, and the wake is not billed.`
                    : late
                      ? "Still working. This wake is taking longer than is typical. It is not billed."
                      : long
                        ? r.current === "gpu" || r.current === "queued"
                          ? "Still waiting. When many people want a GPU this can take a few minutes. The wake is not billed."
                          : "Still working. One stage can take a couple of minutes on its own. The wake is not billed."
                        : model
                          ? est
                            ? `Typical wake: ${est}${model.state === "cold" ? ", longer from cold storage" : ""}. It can take longer. The wake is not billed.`
                            : "Typical wake: not measured yet for this model. The wake is not billed."
                          : "The wake is not billed."}
                </span>
              </>
            )}
          </p>
        </div>
        <Facts model={model} session={s} />
      </div>

      <div className={`rack${typical ? "" : " no-est"}`} style={{ "--now": pct(shown), "--est": pct(estS * 1000) } as CSSProperties}>
        <div className="rk rk-head">
          <div className="rk-l micro" aria-hidden="true">
            Stage
          </div>
          <div className="rk-t">
            {typical ? (
              <span className={`rk-est micro${estS * 1000 > max / 2 ? " left" : ""}`} aria-hidden="true">
                typical {clock(estS * 1000)}
              </span>
            ) : degraded ? (
              <span className="rk-hint micro">live detail unavailable</span>
            ) : null}
          </div>
          <div className="rk-v micro" aria-hidden="true">
            <span>at</span>
            <span>took</span>
          </div>
        </div>
        <ol>
          {/* One row for each stretch a stage ran, in the order reported. A stage can come round twice, so rows go by position. */}
          {r.rows.map((row, i) => (
            <li key={i} className={`rk ${row.status}${row.stage === "ready" ? " last" : ""}`}>
              <div className="rk-l">
                <span className="rk-n">
                  {row.label}
                  {row.of > 1 && (
                    <span className="rk-x mono" aria-label={`run ${row.nth} of ${row.of}`}>
                      {" "}
                      {row.nth}/{row.of}
                    </span>
                  )}
                </span>
                <span className="rk-d">{row.at != null ? row.detail : ""}</span>
              </div>
              <div className="rk-t" aria-hidden="true">
                {row.at != null && <i style={row.stage === "ready" ? { left: pct(row.at), right: 0 } : { left: pct(row.at), width: pct(row.took ?? 0) }} />}
              </div>
              <div className="rk-v mono">
                <span className="dimmer">{row.at != null ? clockTenths(row.at) : ""}</span>
                <span>{value(row)}</span>
              </div>
            </li>
          ))}
        </ol>
        <div className="rk rk-axis" aria-hidden="true">
          <div className="rk-l" />
          <div className="rk-t">
            {tk.minor.map((t) => (
              <u key={t} style={{ left: pct(t) }} />
            ))}
            {tk.major.map((t) => (
              <u key={t} className={t === 0 ? "maj first" : t >= max ? "maj last" : "maj"} style={{ left: pct(t) }}>
                <span>{clock(t)}</span>
              </u>
            ))}
          </div>
          <div className="rk-v" />
        </div>
      </div>

      <div className="wk-actions">
        {failed ? (
          <>
            <button type="button" className="btn primary" onClick={() => void again()} disabled={retrying} aria-busy={retrying}>
              {retrying ? "Starting" : cancelled ? "Wake it again" : "Try again"}
              {!retrying && <Icon name="redo" />}
            </button>
            <Link href="/models" className="btn">
              Pick another model
            </Link>
            <span className="small dimmer wk-ref">
              Session <span className="mono">{s.id}</span>
              {failedRow && !cancelled ? `, stopped at ${failedRow.label.toLowerCase()}` : ""}
            </span>
            <div ref={tsHost} className="box-ts" />
          </>
        ) : running ? (
          <>
            <button type="button" className="btn sm quiet wk-cancel" onClick={() => void live.stop()} disabled={live.busy === "stop"}>
              <Icon name="cross" size={14} />
              Cancel the wake
            </button>
            <span className="small dimmer">
              You can leave this page. The wake keeps going, and this address brings you back.
              {s.free ? " Cancelling uses up today's free session." : ""}
            </span>
          </>
        ) : (
          <span className="small dimmer">&nbsp;</span>
        )}
      </div>
    </div>
  );
}

export function WakeSkeleton() {
  return (
    <div className="wrap wake" aria-busy="true">
      <div className="wk-top">
        <div className="wk-main">
          <div className="wk-kick">
            <span className="state">loading</span>
          </div>
          <div className="wk-timer" style={{ fontWeight: 200, opacity: 0.25 }}>
            <Digits text="0:00" />
            <span className="wk-tenths">
              <Digits text=".0" />
            </span>
          </div>
          <p className="wk-status">&nbsp;</p>
        </div>
        <Facts model={null} session={null} />
      </div>
    </div>
  );
}
