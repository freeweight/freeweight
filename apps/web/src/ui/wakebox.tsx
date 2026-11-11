// The box that does the real thing: pick a model, wake it. Used on the home page and on a model's page.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, DEFAULT_CONFIG, type Config, type Model, type Session } from "../api";
import { perMin, typicalWake, usd, wakeBudget } from "../lib/format";
import { refreshLive, refreshMe, toApiError, useMe } from "../lib/hooks";
import { turnstileToken } from "../lib/turnstile";
import { Link, navigate } from "../router";
import { Icon, Notice, Segmented, StateTag, TierMark } from "./bits";
import "./wakebox.css";

export function ModelPicker({ models, value, onChange }: { models: Model[]; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const cur = models.find((m) => m.id === value) ?? models[0];

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent): void => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    if (open) root.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function key(e: KeyboardEvent): void {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive(Math.max(0, models.findIndex((m) => m.id === value)));
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape" || e.key === "Tab") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(models.length - 1, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(models.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const m = models[active];
      if (m && m.state !== "unavailable") {
        onChange(m.id);
        setOpen(false);
      }
    }
  }

  if (!cur) return null;
  return (
    <div className="pick" ref={root}>
      <button
        type="button"
        className="pick-btn"
        role="combobox"
        aria-labelledby="box-model"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => {
          setActive(Math.max(0, models.findIndex((m) => m.id === value)));
          setOpen((o) => !o);
        }}
        onKeyDown={key}
      >
        <span className="pick-name">{cur.name}</span>
        <span className="pick-meta">
          <TierMark tier={cur.tier} />
          <span className="mono">{perMin(cur.price_usd_micro_per_min)}</span>
          <StateTag state={cur.state} />
        </span>
        <Icon name="chevron" />
      </button>
      {open && (
        <ul className="pick-list" role="listbox" id={listId} aria-labelledby="box-model">
          {models.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${i}`}
              data-i={i}
              role="option"
              aria-selected={m.id === value}
              aria-disabled={m.state === "unavailable"}
              className={i === active ? "on" : undefined}
              onPointerEnter={() => setActive(i)}
              onClick={() => {
                if (m.state === "unavailable") return;
                onChange(m.id);
                setOpen(false);
              }}
            >
              <span className="pick-name">{m.name}</span>
              <span className="pick-meta">
                <TierMark tier={m.tier} />
                <span className="mono">{perMin(m.price_usd_micro_per_min)}</span>
                <StateTag state={m.state} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FRIENDLY: Record<string, string> = {
  free_used: "Today's free session is used. Sign in to rent by the minute.",
  free_budget_spent: "Today's free sessions are all taken. Sign in to rent by the minute, or come back tomorrow.",
  sign_in_required: "This one needs a wallet. Sign in to rent it by the minute.",
  insufficient_balance: "Your balance does not cover this session.",
  model_unavailable: "This model is not available right now. Pick another.",
  model_not_found: "This model is no longer in the catalog. Pick another.",
  needs_load: "This model's stored weights were cleared. It needs its first load again.",
  trial_unavailable: "The free try is not available right now. Sign in to rent by the minute.",
  turnstile_required: "The human check did not run. Try again.",
  turnstile_failed: "The human check did not pass. Try again.",
  turnstile_unavailable: "The human check could not be reached. Try again in a moment.",
};
/** Errors whose way out is the account page. */
const SIGN_IN = new Set(["free_used", "free_budget_spent", "sign_in_required", "trial_unavailable"]);

const MINUTES = [10, 30, 60] as const;

export function WakeBox({ models, initial, fixed = false, config }: { models: Model[]; initial?: string; fixed?: boolean; config: Config | null }) {
  const me = useMe();
  const firstFree = useMemo(() => models.find((m) => m.tier === "light" && m.state !== "unavailable") ?? models[0], [models]);
  const [id, setId] = useState(initial ?? firstFree?.id ?? "");
  const [minutes, setMinutes] = useState<number>(10);
  const [preferFree, setPreferFree] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const tsHost = useRef<HTMLDivElement>(null);
  const model = models.find((m) => m.id === id) ?? firstFree;
  if (!model) return null;

  const signedIn = Boolean(me?.address);
  const freeOk = model.tier === "light" && me?.free_today !== false;
  const free = freeOk && (!signedIn || preferFree);
  const unavailable = model.state === "unavailable";
  const cleared = model.state === "needs_load";
  const needWallet = !free && !signedIn;
  const cost = minutes * model.price_usd_micro_per_min;
  const short = signedIn && !free && (me?.balance_usd_micro ?? 0) < cost;
  const verb = model.state === "awake" ? "Join" : "Wake it";
  const freeMin = config?.free_minutes ?? DEFAULT_CONFIG.free_minutes;
  const est = typicalWake(model)?.text;

  async function go(): Promise<void> {
    if (!model || busy) return;
    const target = model.id;
    setBusy(true);
    setError(null);
    // Free and paid are said out loud: `free: true` is never charged, `minutes` is a paid session of that length.
    const start = async (cfg: Config | null): Promise<Session> => {
      if (!free) return api.createSession(target, { minutes });
      const turnstile = cfg?.turnstile_sitekey && tsHost.current ? await turnstileToken(cfg.turnstile_sitekey, tsHost.current) : undefined;
      return api.createSession(target, { free: true, turnstile });
    };
    try {
      const s = await start(config).catch(async (e: unknown) => {
        // The gateway asked for a human check this page did not run (its config had not loaded): run it once, on fresh config.
        if (toApiError(e).code !== "turnstile_required") throw e;
        return start(await api.config());
      });
      void refreshMe().catch(() => undefined);
      refreshLive();
      navigate(`/s/${s.id}`);
    } catch (e) {
      const err = toApiError(e);
      // A session is already running on this account: go to it.
      if (err.code === "session_live" && typeof err.extra.session_id === "string") return navigate(`/s/${err.extra.session_id}`);
      // A 403 here carries the gateway's own reason (the free try runs on Light models).
      const own = err.code === "trial_unavailable" && err.status === 403;
      const message = err.code === "wake_budget" ? wakeBudget(err.extra.retry_after) : own ? err.message : (FRIENDLY[err.code] ?? err.message);
      setError({ code: err.code, message });
      if (err.code === "free_used" || err.code === "free_budget_spent") void refreshMe().catch(() => undefined);
      setBusy(false);
    }
  }

  return (
    <form
      className="box"
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      {!fixed && (
        <div className="box-pick">
          <span className="micro" id="box-model">
            Model
          </span>
          <ModelPicker
            models={models}
            value={model.id}
            onChange={(v) => {
              setId(v);
              setError(null);
            }}
          />
        </div>
      )}
      <p className="box-blurb">{model.blurb || (model.origin === "pasted" ? "Pasted from Hugging Face and loaded as it is. Nobody here has tested it, so it may answer badly, or not at all." : "")}</p>

      {signedIn && !unavailable && !cleared && (
        <div className="box-min">
          <span className="micro">Session</span>
          <Segmented
            label="Session length"
            value={free ? "free" : String(minutes)}
            onChange={(v) => {
              if (v === "free") setPreferFree(true);
              else {
                setPreferFree(false);
                setMinutes(Number(v));
              }
            }}
            options={[...(freeOk ? [{ value: "free", label: `${freeMin} min free` }] : []), ...MINUTES.map((n) => ({ value: String(n), label: `${n} min` }))]}
          />
        </div>
      )}

      <div className="box-go">
        {unavailable ? (
          <button type="button" className="btn primary lg" disabled>
            Not available right now
          </button>
        ) : cleared ? (
          <Link href={`/models/${encodeURIComponent(model.id)}`} className="btn primary lg">
            Load it again first
            <Icon name="arrow" />
          </Link>
        ) : needWallet ? (
          <Link href="/account" className="btn primary lg">
            Sign in to rent it
            <Icon name="arrow" />
          </Link>
        ) : (
          <button type="submit" className="btn primary lg" disabled={busy || short} aria-busy={busy}>
            {busy ? "Starting" : free ? `${verb} free for ${freeMin} minutes` : `${verb} for ${minutes} min`}
            {!busy && !free && <span className="mono box-cost">{usd(cost)}</span>}
            {!busy && <Icon name="arrow" />}
          </button>
        )}
        <span className="box-est">
          {cleared ? (
            <>Its stored weights were cleared after weeks without a wake. A first load brings it back.</>
          ) : model.state === "awake" ? (
            <>Awake now. Joining is instant.</>
          ) : model.state === "waking" ? (
            <>Waking now. You join when it is ready.</>
          ) : (
            <>
              {est ? `Wake: ${est}` : "Typical wake: not measured yet"}
              {est && model.state === "cold" ? ", longer from cold" : ""}. The wake is free.
            </>
          )}
        </span>
      </div>
      <div ref={tsHost} className="box-ts" />

      {error && (
        <Notice kind="err">
          {error.message}{" "}
          {SIGN_IN.has(error.code) && (
            <Link className="link" href="/account">
              Sign in
            </Link>
          )}
        </Notice>
      )}
      {short && !error && (
        <Notice>
          Your balance is {usd(me?.balance_usd_micro ?? 0)}; this session reserves {usd(cost)}.{" "}
          <Link className="link" href="/account#balance">
            Top up
          </Link>
        </Notice>
      )}

      <p className="box-fine">
        {free ? (
          <>No wallet, no signup. One free session a day on a Light model. After that it is {perMin(model.price_usd_micro_per_min)}, billed by the second, one-minute minimum once the model is awake.</>
        ) : needWallet && model.tier !== "light" ? (
          <>The free try runs on Light models. {model.tier === "heavy" ? "Heavy is in preview. " : ""}This one is {perMin(model.price_usd_micro_per_min)}.</>
        ) : needWallet ? (
          <>Today's free session is used. From here it is {perMin(model.price_usd_micro_per_min)}, billed by the second, one-minute minimum once the model is awake.</>
        ) : (
          <>
            {perMin(model.price_usd_micro_per_min)}, billed by the second, one-minute minimum once the model is awake. The wake is free. Stop any time.
          </>
        )}
      </p>
    </form>
  );
}
