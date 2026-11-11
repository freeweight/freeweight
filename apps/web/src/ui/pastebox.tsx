// Paste a Hugging Face model: the free check, what it found, and the button that starts the paid first load.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type Config, type RepoCheck } from "../api";
import { about, context, params, perMin, shortSha, size, TIER_NAME, usd } from "../lib/format";
import { refreshMe, toApiError, useMe } from "../lib/hooks";
import { parseRepo } from "../lib/repo";
import { Link, navigate } from "../router";
import { Icon, Notice, TierMark } from "./bits";
import "./pastebox.css";

type Passed = Extract<RepoCheck, { ok: true }>;

const CHECK_ERR: Record<string, string> = {
  bad_repo: "That is not a Hugging Face model ID. It looks like org/model.",
  rate_limited: "Too many checks from here. Try again in a minute.",
  hf_unavailable: "Hugging Face did not answer, so the repo could not be checked. Try again in a moment.",
  network: "The check did not get through. Try again.",
};
/** What a refusal is called. The reason under it is the gateway's own sentence about this repo. */
const REFUSED: Record<string, string> = {
  repo_not_found: "Not found",
  disabled: "Switched off by its owner",
  gated: "Behind a gate",
  not_text_generation: "Not a chat model",
  no_safetensors: "Wrong weight format",
  unsupported_architecture: "Architecture not supported",
  custom_code: "Custom code",
  no_chat_template: "No chat template",
  too_big: "Too big",
  blocked: "Blocked",
  removed: "Removed",
};
const LOAD_ERR: Record<string, string> = {
  sign_in_required: "Sign in with a wallet to load a model.",
  daily_load_limit: "This account has used today's first loads. Try again tomorrow.",
  too_many_loads: "You have other loads running. Start this one when one of them is done.",
  storage_full: "The storage for pasted models is full right now. Try again later.",
  load_not_started: "The load could not be started, and nothing was charged. Try again.",
  loads_unavailable: "Pasted models cannot be loaded right now.",
  loaded_privately: "Another account loaded this model and keeps it private.",
  model_id_taken: "A different model in the catalog already has this name, so this one cannot be loaded.",
  network: "The request did not get through. Nothing was charged. Try again.",
};

/** `initial` fills the field and runs the check at once: a model page uses it for a model that needs its load again. */
export function PasteBox({ config, id = "paste", initial = "" }: { config: Config | null | undefined; id?: string; initial?: string }) {
  const me = useMe();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState<"check" | "load" | null>(null);
  const [check, setCheck] = useState<RepoCheck | null>(null);
  const [error, setError] = useState<{ code: string; message: ReactNode } | null>(null);
  const [keep, setKeep] = useState(false);
  const asked = useRef(0);
  const closed = config != null && !config.paste.open;

  async function runCheck(): Promise<void> {
    const repo = parseRepo(value);
    setCheck(null);
    if (!repo) return setError({ code: "bad_repo", message: CHECK_ERR.bad_repo });
    const turn = ++asked.current;
    setBusy("check");
    setError(null);
    try {
      const r = await api.checkRepo(repo);
      if (turn === asked.current) setCheck(r);
    } catch (e) {
      const err = toApiError(e);
      if (turn === asked.current) setError({ code: err.code, message: CHECK_ERR[err.code] ?? err.message });
    } finally {
      if (turn === asked.current) setBusy(null);
    }
  }

  useEffect(() => {
    if (initial) void runCheck();
    // Once, for the repo the page was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  async function load(c: Passed): Promise<void> {
    setBusy("load");
    setError(null);
    try {
      const l = await api.startLoad(c.repo, keep);
      void refreshMe().catch(() => undefined);
      navigate(`/load/${l.id}`);
    } catch (e) {
      const err = toApiError(e);
      if (err.code === "already_loaded" && typeof err.extra.model_id === "string") return navigate(`/models/${encodeURIComponent(err.extra.model_id)}`);
      const needed = typeof err.extra.needed_usd_micro === "number" ? err.extra.needed_usd_micro : c.load_cap_usd_micro;
      setError({
        code: err.code,
        message:
          err.code === "insufficient_balance" ? (
            <>
              A first load holds its cap of {usd(needed)} until it ends, and the balance does not cover that.{" "}
              <Link className="link" href="/account#balance">
                Top up
              </Link>
            </>
          ) : (
            (LOAD_ERR[err.code] ?? err.message)
          ),
      });
      setBusy(null);
    }
  }

  return (
    <div className="pb">
      <form
        className="pb-form"
        onSubmit={(e) => {
          e.preventDefault();
          void runCheck();
        }}
      >
        <label className="micro" htmlFor={id}>
          Paste a Hugging Face model
        </label>
        <div className="pb-row">
          <input
            id={id}
            className="input mono"
            placeholder="org/model, or its huggingface.co address"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            disabled={closed}
          />
          <button type="submit" className="btn primary" disabled={closed || busy !== null || !value.trim()} aria-busy={busy === "check"}>
            {busy === "check" ? "Checking" : "Check it"}
          </button>
        </div>
        {!check && !error && (
          <p className="pb-fine">
            {closed
              ? "Pasted models cannot be loaded right now. The catalog below is open."
              : "The check is free and takes a few seconds. It says whether the model can run here, its weight class, and the most its first load can cost."}
          </p>
        )}
      </form>

      {error && !check && <Notice kind={error.code === "bad_repo" ? "info" : "err"}>{error.message}</Notice>}

      {check && !check.ok && (
        <div className="pb-card no" role="status">
          <p className="pb-head">
            <span className="mono pb-repo">{check.repo}</span>
            <span className="tag">cannot run here</span>
          </p>
          <p className="pb-why">
            <strong>{REFUSED[check.code] ?? "Cannot be served"}.</strong> {check.reason}
          </p>
          <p className="pb-fine">Nothing was charged. The check never is.</p>
        </div>
      )}

      {check?.ok && (
        <div className="pb-card" role="status">
          <p className="pb-head">
            <span className={`pb-name tw-${check.tier}`}>{check.name}</span>
            <span className="mono pb-repo">
              {check.repo} @ {shortSha(check.sha)}
            </span>
          </p>
          <dl className="pb-facts">
            <div>
              <dt>Class</dt>
              <dd>
                <TierMark tier={check.tier} />
              </dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd className="mono">{perMin(check.price_usd_micro_per_min)}</dd>
            </div>
            <div>
              <dt>First load</dt>
              <dd>
                <span className="mono">at most {usd(check.load_cap_usd_micro)}</span>
                <span className="pb-note">
                  the {TIER_NAME[check.tier]} rate while it loads, capped at {check.load_cap_minutes} min
                </span>
              </dd>
            </div>
            <div>
              <dt>Estimate</dt>
              <dd>
                <span className="mono">{about(check.load_estimate_s)}</span>
                <span className="pb-note">to load, from its size. Later wakes: {about(check.wake_estimate_s)}</span>
              </dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd className="mono">
                {size(check.size_bytes)} · {params(check.params_b)} · {context(check.context)} context
              </dd>
            </div>
            <div>
              <dt>Licence</dt>
              <dd>
                <span className="mono">{check.license || "not stated"}</span>
                <span className="pb-note">as the repo states it. Whether your use fits it is yours to check.</span>
              </dd>
            </div>
          </dl>
          <Verdict check={check} signedIn={Boolean(me?.address)} busy={busy === "load"} keep={keep} setKeep={setKeep} onLoad={() => void load(check)} />
          {error && <Notice kind="err">{error.message}</Notice>}
        </div>
      )}
    </div>
  );
}

function Verdict({ check, signedIn, busy, keep, setKeep, onLoad }: { check: Passed; signedIn: boolean; busy: boolean; keep: boolean; setKeep: (v: boolean) => void; onLoad: () => void }) {
  if (check.state === "loaded" && check.model_id)
    return (
      <div className="pb-go">
        <Link href={`/models/${encodeURIComponent(check.model_id)}`} className="btn primary">
          Open it
          <Icon name="arrow" />
        </Link>
        <span className="pb-fine">This model is in the catalog already. It wakes like any other, with no first load.</span>
      </div>
    );
  if (check.state === "loading" && check.load_id)
    return (
      <div className="pb-go">
        <Link href={`/load/${encodeURIComponent(check.load_id)}`} className="btn primary">
          Watch the load
          <Icon name="arrow" />
        </Link>
        <span className="pb-fine">Somebody is loading this model right now. Watching is free, and you can rent it as soon as it is ready.</span>
      </div>
    );
  if (check.state === "taken") return <Notice>Another account loaded this model and keeps it private.</Notice>;
  if (!check.can_load) return <Notice>This model passed the check, but pasted models cannot be loaded right now.</Notice>;
  return (
    <>
      {signedIn && (
        <label className="pb-keep">
          <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
          <span>Keep it private. Only this account sees it and wakes it.</span>
        </label>
      )}
      <div className="pb-go">
        {signedIn ? (
          <button type="button" className="btn primary" onClick={onLoad} disabled={busy} aria-busy={busy}>
            {busy ? "Starting" : check.state === "needs_load" ? "Load it again" : "Load it"}
            {!busy && <span className="mono pb-cost">at most {usd(check.load_cap_usd_micro)}</span>}
            {!busy && <Icon name="arrow" />}
          </button>
        ) : (
          <Link href="/account" className="btn primary">
            Sign in to load it
            <Icon name="arrow" />
          </Link>
        )}
        <span className="pb-fine">
          {check.state === "needs_load" ? "Its stored weights were cleared after weeks without a wake. " : "Nobody has loaded this model here yet. "}
          You pay for the time the load takes and never more than the cap. A load that fails costs nothing. After it, the model wakes like any other.
        </span>
      </div>
    </>
  );
}
