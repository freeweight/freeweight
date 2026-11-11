// The first load of a pasted model: one address from the moment it starts until the model can be woken.

import { useEffect } from "react";
import { api, type Load, type LoadStage } from "../api";
import { clockTenths, perMin, shortSha, size, TIER_NAME, took, usd } from "../lib/format";
import { refreshLive, refreshMe, useFrame, useLive, useLoad, useTitle } from "../lib/hooks";
import { loadCostMicro, loadFraction, loadRows, useLoadOf, type LoadRowView } from "../lib/load";
import { Link } from "../router";
import { Icon, Notice, TierMark } from "../ui/bits";
import { WakeBox } from "../ui/wakebox";
import "./load.css";

const STATUS: Record<LoadStage, string> = {
  queued: "Waiting for a machine to take the load.",
  checking: "Reading the repo at the pinned commit.",
  downloading: "Downloading the weights from Hugging Face into storage.",
  validating: "Checking every weight file against the checksum its repo publishes.",
  starting: "Starting the engine on a GPU with these weights, to prove the model answers.",
  ready: "",
  failed: "",
};

export default function LoadView({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const live = useLoadOf(id);
  const l = live.load;
  const state = l?.state;
  useFrame(state === "loading");
  useTitle(!l ? "Load" : state === "loading" ? `Loading ${l.hf_repo}` : state === "ready" ? `${l.hf_repo} is loaded` : "Load failed");
  // The model enters the catalog, and the hold comes back, the moment the load ends.
  useEffect(() => {
    if (state !== "ready" && state !== "failed") return;
    refreshLive();
    void refreshMe().catch(() => undefined);
  }, [state]);

  if (live.error && !l) {
    const missing = live.error.status === 404;
    return (
      <div className="wrap page ld-gone">
        <p className="micro">{missing ? "No load" : "Not reachable"}</p>
        <h1 className="h2">{missing ? "There is no load at this address." : "This load did not show."}</h1>
        <p className="dim">{missing ? "The address may be wrong, or the load was started privately by another account." : `${live.error.message} The page keeps trying while it is open.`}</p>
        <div className="row wrapf">
          <Link href="/models" className="btn primary">
            Browse models
          </Link>
          <Link href="/" className="btn">
            Home
          </Link>
        </div>
      </div>
    );
  }
  if (!l)
    return (
      <div className="wrap load" aria-busy="true">
        <div className="ld-main">
          <span className="skel" style={{ width: 220, height: 20 }} />
          <div className="ld-timer dimmer">0:00.0</div>
        </div>
      </div>
    );

  const elapsed = live.elapsed();
  const capMs = l.cap_minutes * 60_000;
  const rows = loadRows(l, live.lastStage);
  return (
    <div className={`wrap load is-${l.state}`}>
      <div className="ld-main">
        <div className="ld-kick">
          <span className={`state${l.state === "loading" ? " waking" : ""}`}>{l.state === "loading" ? "loading" : l.state === "ready" ? "loaded" : "failed"}</span>
          <h1 className="ld-name mono">{l.hf_repo}</h1>
          <TierMark tier={l.tier} />
        </div>
        <div className="ld-timer" role="timer" aria-label="Time loading">
          {clockTenths(elapsed)}
        </div>
        <p className="ld-status" aria-live="polite">
          {l.state === "loading" ? (
            STATUS[l.stage]
          ) : l.state === "ready" ? (
            <>
              Loaded in {took(elapsed)}.{l.mine && <> Charged <span className="mono">{usd(l.charged_usd_micro)}</span>.</>} From now on it wakes like any model in the catalog.
            </>
          ) : (
            <>
              <span className="ld-bad">The load failed.</span> Nothing was charged{l.mine ? ", and the hold is back in your balance" : ""}.
            </>
          )}
        </p>
      </div>

      <ol className="ld-rack" aria-label="Stages">
        {rows.map((r) => (
          <Row key={r.stage} r={r} l={l} />
        ))}
      </ol>

      {l.state === "failed" && (
        <Notice kind="err">
          <span>
            {l.detail ?? "The load did not finish."}
            {l.code && <span className="mono ld-code"> {l.code}</span>}
          </span>
        </Notice>
      )}
      {l.state === "ready" && <Ready load={l} />}

      <dl className="facts ld-facts">
        <div>
          <dt>Class</dt>
          <dd className="facts-row">
            <TierMark tier={l.tier} />
            <span className="mono">{perMin(l.price_usd_micro_per_min)}</span>
          </dd>
        </div>
        <div>
          <dt>Cap</dt>
          <dd className="facts-row">
            <span className="mono">
              {l.cap_minutes} min · {usd(l.cap_minutes * l.price_usd_micro_per_min)}
            </span>
            <span className="dimmer">the most a first load on {TIER_NAME[l.tier]} costs</span>
          </dd>
        </div>
        {l.mine && l.state === "loading" && (
          <div>
            <dt>So far</dt>
            <dd className="facts-row">
              <span className="mono">{usd(loadCostMicro(l, elapsed))}</span>
              <span className="dimmer">{elapsed >= capMs ? "the cap is reached: the rest of this load is free" : `of ${usd(l.hold_usd_micro)} held. Charged only if the load succeeds`}</span>
            </dd>
          </div>
        )}
        <div>
          <dt>Commit</dt>
          <dd className="mono">{shortSha(l.sha)}</dd>
        </div>
      </dl>

      {l.state === "loading" && (
        <p className="ld-fine">
          {l.mine ? "You can leave this page. The load keeps going, and this address brings you back." : "Another account started this load and pays for it. Watching is free, and you can rent the model as soon as it is ready."}
        </p>
      )}
      {l.state === "failed" && (
        <div className="row wrapf">
          <Link href="/" className="btn primary">
            Paste another model
          </Link>
          <Link href="/models" className="btn">
            Browse models
          </Link>
        </div>
      )}
    </div>
  );
}

function Row({ r, l }: { r: LoadRowView; l: Load }) {
  const frac = r.stage === "downloading" ? loadFraction(l) : null;
  const bar = r.stage === "downloading" && (r.status === "active" || r.status === "failed") && frac !== null;
  return (
    <li className={`ld-row ${r.status}`} aria-current={r.status === "active" ? "step" : undefined}>
      <span className="ld-mark" aria-hidden="true">
        {r.status === "done" ? <Icon name="check" size={14} /> : r.status === "failed" ? <Icon name="cross" size={14} /> : null}
      </span>
      <span className="ld-label">{r.label}</span>
      <span className="ld-val mono">
        {r.stage === "downloading" && l.size_bytes > 0
          ? r.status === "active" || (r.status === "failed" && l.bytes > 0)
            ? `${size(l.bytes)} of ${size(l.size_bytes)}`
            : size(l.size_bytes)
          : r.status === "active"
            ? "now"
            : r.status === "failed"
              ? "stopped here"
              : ""}
      </span>
      {bar && (
        <span className="ld-bar" role="progressbar" aria-label="Weights stored" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}>
          <i style={{ width: `${frac * 100}%` }} />
        </span>
      )}
    </li>
  );
}

/** The load is done: the model's own wake box, so the next click wakes it and opens the room. */
function Ready({ load }: { load: Load }) {
  const { models } = useLive();
  const config = useLoad(() => api.config(), []);
  const model = models?.find((m) => m.id === load.model_id);
  if (!models) return <div className="box box-skel" aria-busy="true" />;
  if (!model)
    return (
      <Notice>
        The model is loaded, but this account cannot see it in the catalog: it was loaded privately.{" "}
        <Link className="link" href="/models">
          Browse models
        </Link>
      </Notice>
    );
  return (
    <div className="ld-next">
      <p className="micro">Wake it</p>
      <WakeBox models={models} initial={model.id} fixed config={config.data} />
      <p className="ld-fine">
        Its page is{" "}
        <Link className="link" href={`/models/${encodeURIComponent(model.id)}`}>
          {model.name}
        </Link>
        {load.mine ? ". You can keep it private there, and it is listed under your models in the account area." : "."}
      </p>
    </div>
  );
}
