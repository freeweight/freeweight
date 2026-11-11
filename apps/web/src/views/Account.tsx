// Account: wallet sign-in, balance and top-up, API keys, what the always-awake model was used for, perks.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, TIERS, type ApiKey, type Config, type Me, type Model, type NewKey, type Tier, type Topup } from "../api";
import { ago, day, grouped, TIER_NAME, usd } from "../lib/format";
import { HOSTED_PATH } from "../lib/hosted";
import { refreshMe, toApiError, useLive, useLoad, useMe, useTitle } from "../lib/hooks";
import { discover, signIn, WalletError, type Step, type Wallet } from "../lib/wallet";
import { Link } from "../router";
import { Code, Copy, Icon, Notice } from "../ui/bits";
import "./account.css";

export default function Account() {
  useTitle("Account");
  const me = useMe();
  const first = useLoad(() => refreshMe(), []);
  const config = useLoad(() => api.config(), []);
  const { models } = useLive();
  const signedIn = Boolean(me?.address);

  // "/account#keys" from another page: the section exists only after the first load.
  const ready = me !== null;
  useEffect(() => {
    if (!ready || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [ready]);

  return (
    <div className="wrap page acct">
      <header className="page-head">
        <p className="micro">Account</p>
        <h1 className="h2">{signedIn ? "Your account" : "Sign in"}</h1>
        <p>Your wallet is your account. There is no email and no password. The free 5-minute session needs none of this.</p>
      </header>

      {!me && first.error ? (
        <Notice kind="err">
          Your account did not load: {first.error.message}{" "}
          <button type="button" className="link" onClick={first.reload}>
            Try again
          </button>
        </Notice>
      ) : (
        <>
          <WalletSection me={me} chainId={config.data?.chain_id ?? 4663} />
          <BalanceSection me={me} config={config.data} models={models} />
          <KeysSection me={me} />
          {me?.hosted && <HostedSection me={me} />}
          <PerksSection me={me} />
        </>
      )}
    </div>
  );
}

// ---------- wallet ----------

const STEPS: { key: Step; label: string }[] = [
  { key: "connect", label: "Connect" },
  { key: "sign", label: "Sign the message" },
  { key: "verify", label: "Verify" },
];

function WalletSection({ me, chainId }: { me: Me | null; chainId: number }) {
  const [wallets, setWallets] = useState<Wallet[] | null>(null);
  const [busy, setBusy] = useState<{ wallet: string; step: Step } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const address = me?.address ?? null;

  useEffect(() => {
    if (address) return;
    return discover(setWallets);
  }, [address]);

  async function connect(w: Wallet): Promise<void> {
    if (busy) return;
    setError(null);
    setBusy({ wallet: w.id, step: "connect" });
    try {
      await signIn(w, chainId, (step) => setBusy({ wallet: w.id, step }));
    } catch (e) {
      setError(e instanceof WalletError ? e.message : toApiError(e).message);
    } finally {
      setBusy(null);
    }
  }

  async function signOut(): Promise<void> {
    setLeaving(true);
    try {
      await api.logout();
      await refreshMe();
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setLeaving(false);
    }
  }

  return (
    <section className="sec" aria-labelledby="acct-wallet">
      <div className="sec-h">
        <h2 className="h3" id="acct-wallet">
          Wallet
        </h2>
        <p>Signing in is a signature on a message. It sends no transaction and costs nothing.</p>
      </div>
      <div className="sec-b">
        {me === null ? (
          <span className="skel" style={{ width: 280, height: 40 }} />
        ) : address ? (
          <div className="acct-who">
            <span className="acct-dot" aria-hidden="true" />
            <span className="acct-addr mono" title={address}>
              {address}
            </span>
            <Copy text={address} label="Copy address" />
            <button type="button" className="btn sm" onClick={() => void signOut()} disabled={leaving}>
              {leaving ? "Signing out" : "Sign out"}
            </button>
          </div>
        ) : (
          <>
            {wallets === null ? (
              <span className="skel" style={{ width: "100%", maxWidth: 420, height: 48 }} />
            ) : wallets.length === 0 ? (
              <Notice>No wallet found in this browser. Install a wallet extension, or open this page in your wallet's browser, then come back.</Notice>
            ) : (
              <ul className="wallets">
                {wallets.map((w) => {
                  const mine = busy?.wallet === w.id;
                  return (
                    <li key={w.id}>
                      <button type="button" className="wallet" onClick={() => void connect(w)} disabled={busy !== null} aria-busy={mine}>
                        {w.icon ? (
                          <img src={w.icon} alt="" width="24" height="24" />
                        ) : (
                          <span className="wallet-ph" aria-hidden="true">
                            <Icon name="minus" size={12} />
                          </span>
                        )}
                        <span className="wallet-name">{w.name}</span>
                        <span className="wallet-go">
                          {mine ? "Waiting" : "Connect"}
                          <Icon name="arrow" />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {busy && (
              <ol className="steps" aria-label="Sign-in progress">
                {STEPS.map((s, i) => {
                  const at = STEPS.findIndex((x) => x.key === busy.step);
                  const cls = i < at ? "done" : i === at ? "on" : "";
                  return (
                    <li key={s.key} className={cls} aria-current={i === at ? "step" : undefined}>
                      <i aria-hidden="true" />
                      {s.label}
                    </li>
                  );
                })}
              </ol>
            )}
            {busy?.step === "sign" && <p className="small dim">Check your wallet. It is asking you to sign a short message.</p>}
            {error && <Notice kind="err">{error}</Notice>}
          </>
        )}
        {address && error && <Notice kind="err">{error}</Notice>}
      </div>
    </section>
  );
}

// ---------- balance and top-up ----------

function minutesOn(balance: number, models: Model[] | null, tier: Tier): number | null {
  const price = models?.find((m) => m.tier === tier)?.price_usd_micro_per_min;
  return price ? Math.floor(balance / price) : null;
}

// Anything not named here shows the gateway's own sentence: it knows why a transaction did not count.
const TOPUP_ERR: Record<string, string> = {
  topups_closed: "Top-ups open at launch.",
  bad_request: "That is not a transaction hash. It starts with 0x and has 64 more characters.",
  pending_confirmations: "The transaction is still short of confirmations. Submit it again in a minute.",
};
/** How often to ask again while a transaction gathers confirmations, and for how long. */
const CONFIRM_EVERY_MS = 2500;
const CONFIRM_TRIES = 48;

function BalanceSection({ me, config, models }: { me: Me | null; config: Config | null; models: Model[] | null }) {
  const signedIn = Boolean(me?.address);
  const balance = me?.balance_usd_micro ?? 0;
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Topup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [confirming, setConfirming] = useState<{ have: number; need: number } | null>(null);
  const open = Boolean(config?.treasury) && !closed;
  // Shown with its checksum, so a wallet that checks the case of an address accepts it as typed.
  const [treasury, setTreasury] = useState("");
  useEffect(() => {
    const raw = config?.treasury;
    if (!raw) return;
    let on = true;
    void import("../lib/viem").then(({ getAddress }) => {
      if (on) setTreasury(getAddress(raw));
    });
    return () => {
      on = false;
    };
  }, [config?.treasury]);
  const freeMin = config?.free_minutes ?? 5;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const tx = hash.trim();
    if (!tx || busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      // A fresh transaction is not final yet. The gateway says how far along it is, and the same hash is asked again.
      for (let tries = 1; ; tries++) {
        try {
          setDone(await api.topup(tx));
          break;
        } catch (err) {
          const a = toApiError(err);
          if (a.code !== "pending_confirmations" || tries >= CONFIRM_TRIES) throw err;
          setConfirming({ have: Number(a.extra.confirmations) || 0, need: Number(a.extra.required) || 0 });
          await new Promise((r) => setTimeout(r, CONFIRM_EVERY_MS));
          if (!mounted.current) return;
        }
      }
      setHash("");
      await refreshMe();
    } catch (err) {
      const a = toApiError(err);
      if (a.code === "topups_closed") setClosed(true);
      else setError(TOPUP_ERR[a.code] ?? a.message);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  return (
    <section className="sec" id="balance" aria-labelledby="acct-balance">
      <div className="sec-h">
        <h2 className="h3" id="acct-balance">
          Balance
        </h2>
        <p>Rent comes out of your balance by the second while a session runs, with a one-minute minimum once the model is awake. The wake is free.</p>
      </div>
      <div className="sec-b">
        <div className="bal">
          <div className="readout">
            <span className="micro">Balance</span>
            <b className={`bal-n${signedIn ? "" : " off"}`}>{me === null ? <span className="skel" style={{ width: 96 }} /> : signedIn ? usd(balance) : "$0.00"}</b>
          </div>
          {signedIn && (
            <dl className="bal-buys">
              {TIERS.map((t) => {
                const n = minutesOn(balance, models, t);
                return (
                  <div key={t}>
                    <dt className={`tw-${t}`}>{TIER_NAME[t]}</dt>
                    <dd className="mono">{n === null ? "…" : `${n} min`}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </div>

        {me !== null && !signedIn && <p className="small dim">Sign in with a wallet to hold a balance.</p>}
        {signedIn && (me?.held_usd_micro ?? 0) > 0 && (
          <p className="small dim">
            <span className="mono">{usd(me?.held_usd_micro ?? 0)}</span> is on hold for a running session.
          </p>
        )}

        {config === null ? (
          // Holds the room the usual answer takes, so the sections below stay put when it arrives.
          <div className="later wait" aria-hidden="true">
            <span className="tag">at launch</span>
            <p>
              <b>Top-ups open at launch.</b> You will send ETH or USDG on Robinhood Chain and submit the transaction here. Until then, the free {freeMin}-minute session runs once a day on a Light model.
            </p>
          </div>
        ) : !open ? (
          <div className="later">
            <span className="tag">at launch</span>
            <p>
              <b>Top-ups open at launch.</b> You will send ETH or USDG on Robinhood Chain and submit the transaction here. Until then, the free {freeMin}-minute session runs once a day on a Light model.
            </p>
          </div>
        ) : (
          <div className="topup">
            <h3 className="micro">Top up</h3>
            <ol className="topup-steps">
              <li>
                <p>
                  Send <b>ETH</b> or <b>USDG</b> on Robinhood Chain (chain id <span className="mono">{config?.chain_id}</span>) to the treasury address.
                </p>
                <div className="addr">
                  <span className="mono">{treasury || config?.treasury}</span>
                  <Copy text={treasury || (config?.treasury ?? "")} label="Copy" />
                </div>
              </li>
              <li>
                <p>Paste the transaction hash. It is checked on chain, then your balance is credited in USD.</p>
                <form className="topup-form" onSubmit={(e) => void submit(e)}>
                  <label className="sr" htmlFor="tx">
                    Transaction hash
                  </label>
                  <input id="tx" className="input mono" placeholder="0x…" value={hash} onChange={(e) => setHash(e.target.value)} autoComplete="off" spellCheck={false} disabled={!signedIn || busy} />
                  <button type="submit" className="btn primary" disabled={!signedIn || busy || !hash.trim()}>
                    {confirming ? "Confirming" : busy ? "Checking" : "Credit it"}
                  </button>
                </form>
                {!signedIn && <p className="small dim">Sign in first, so the credit lands on your wallet.</p>}
              </li>
            </ol>
            {confirming && (
              <Notice>
                Waiting for confirmations{confirming.need > 0 ? ` (${confirming.have} of ${confirming.need})` : ""}. This page keeps asking; nothing is credited twice.
              </Notice>
            )}
            {done &&
              (done.already_credited ? (
                <Notice>
                  This transaction was already credited: <b className="mono">{usd(done.credited_usd_micro)}</b> for {done.amount} {done.asset}. Your balance did not change.
                </Notice>
              ) : (
                <Notice kind="brass">
                  Credited <b className="mono">{usd(done.credited_usd_micro)}</b> for {done.amount} {done.asset}.
                </Notice>
              ))}
            {error && <Notice kind="err">{error}</Notice>}
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- keys ----------

function KeysSection({ me }: { me: Me | null }) {
  const signedIn = Boolean(me?.address);
  const keys = me?.keys ?? [];
  const [name, setName] = useState("");
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<NewKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  async function create(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const k = await api.createKey(name.trim() || "untitled", auto);
      setFresh(k);
      setName("");
      setAuto(false);
      await refreshMe();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setBusy(false);
    }
  }

  /** The key whose delete was turned down last: its Delete button takes the focus back. */
  const kept = useRef<string | null>(null);

  async function remove(k: ApiKey): Promise<void> {
    setRemoving(k.id);
    setError(null);
    try {
      await api.deleteKey(k.id);
      if (fresh?.id === k.id) setFresh(null);
      await refreshMe();
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setRemoving(null);
      setConfirm(null);
      // The row and its buttons are gone: the focus goes to the heading of the list, not to nowhere.
      document.getElementById("acct-keys")?.focus();
    }
  }

  return (
    <section className="sec" id="keys" aria-labelledby="acct-keys">
      <div className="sec-h">
        <h2 className="h3" id="acct-keys" tabIndex={-1}>
          API keys
        </h2>
        <p>
          Keys call the endpoint from your code. A key is shown once, when you create it.{" "}
          <Link className="link" href="/docs/api">
            API reference
          </Link>
        </p>
      </div>
      <div className="sec-b">
        {me === null ? (
          <span className="skel" style={{ width: "100%", height: 40 }} />
        ) : !signedIn ? (
          <p className="small dim">Sign in with a wallet to create keys.</p>
        ) : (
          <>
            {fresh && (
              <div className="newkey" role="status">
                <p>
                  <b>Copy this key now.</b> It is not shown again.
                </p>
                <Code title={fresh.name} code={fresh.key} wrap />
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    setFresh(null);
                    document.getElementById("acct-keys")?.focus();
                  }}
                >
                  I have copied it
                </button>
              </div>
            )}

            {keys.length === 0 ? (
              <p className="keys-none">No keys yet.</p>
            ) : (
              <ul className="keys">
                {keys.map((k) => (
                  <li key={k.id} className="key">
                    <span className="key-name" title={k.name}>
                      {k.name}
                    </span>
                    <span className="key-pre mono">{k.prefix}…</span>
                    <span className="key-meta">
                      {k.auto_session && <span className="tag">auto-session</span>}
                      <span>created {day(k.created_at)}</span>
                      <span>{k.last_used_at ? `used ${ago(Date.now() - k.last_used_at)} ago` : "never used"}</span>
                    </span>
                    <span className="key-act">
                      {confirm === k.id ? (
                        <>
                          <button type="button" className="btn sm danger" autoFocus onClick={() => void remove(k)} disabled={removing === k.id}>
                            {removing === k.id ? "Deleting" : "Delete for good"}
                          </button>
                          <button
                            type="button"
                            className="btn sm quiet"
                            onClick={() => {
                              kept.current = k.id;
                              setConfirm(null);
                            }}
                            disabled={removing === k.id}
                          >
                            Keep
                          </button>
                        </>
                      ) : (
                        <button type="button" className="btn sm quiet" autoFocus={kept.current === k.id} onClick={() => setConfirm(k.id)} aria-label={`Delete key ${k.name}`}>
                          Delete
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <form className="keyform" onSubmit={(e) => void create(e)}>
              <div className="field">
                <label htmlFor="key-name">New key</label>
                <div className="keyform-row">
                  <input id="key-name" className="input" placeholder="A name, for example laptop" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
                  <button type="submit" className="btn" disabled={busy}>
                    {busy ? "Creating" : "Create key"}
                  </button>
                </div>
              </div>
              <label className="check">
                <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                <span>
                  <b>Start sessions automatically.</b> A request with no session open wakes the model, waits until it is ready, then answers. It rents by the minute from your balance.
                </span>
              </label>
            </form>
            {error && <Notice kind="err">{error}</Notice>}
          </>
        )}
      </div>
    </section>
  );
}

// ---------- the always-awake model ----------

/** The last answers the always-awake model gave this account: free or paid, from the chat or from the API. */
function HostedSection({ me }: { me: Me }) {
  const h = me.hosted!;
  return (
    <section className="sec" id="hosted-use" aria-labelledby="acct-hosted">
      <div className="sec-h">
        <h2 className="h3" id="acct-hosted">
          Always-awake model
        </h2>
        <p>
          Paid per token from the same balance, with {h.free_per_day} free messages a day in the{" "}
          <Link className="link" href={HOSTED_PATH}>
            chat
          </Link>
          .
        </p>
      </div>
      <div className="sec-b">
        <p className="small dim">
          Free messages left today: <span className="mono">{h.free_left}</span> of <span className="mono">{h.free_per_day}</span>.
        </p>
        {h.recent.length === 0 ? (
          <p className="keys-none">No answers yet.</p>
        ) : (
          <ul className="uses" aria-label="Recent answers">
            {h.recent.map((u) => (
              <li key={u.id} className="use">
                <span className="mono use-when">{new Date(u.at).toISOString().slice(0, 16).replace("T", " ")}</span>
                <span className="use-where">{u.surface === "api" ? "API" : "Chat"}</span>
                <span className="mono use-tok">
                  {grouped(u.tokens_in)} in · {grouped(u.tokens_out)} out
                </span>
                <b className={`mono use-cost${u.free ? " dim" : ""}`}>{u.free ? "free" : usd(u.charged_usd_micro)}</b>
              </li>
            ))}
          </ul>
        )}
        <p className="small dimmer">Times are UTC. Each line is one answer: the tokens it read, the tokens it wrote and what was taken from your balance.</p>
      </div>
    </section>
  );
}

// ---------- perks ----------

function PerksSection({ me }: { me: Me | null }) {
  const p = me?.perks;
  const on = Boolean(p?.enabled);
  return (
    <section className="sec" aria-labelledby="acct-perks">
      <div className="sec-h">
        <h2 className="h3" id="acct-perks">
          Perks
        </h2>
        <p>For stakers of $WEIGHT.{on ? "" : " The token does not exist yet. This switches on at launch."}</p>
      </div>
      <div className="sec-b">
        <ul className="perks">
          <li className={on ? undefined : "off"}>
            <div>
              <h3>Staking credits {!on && <span className="tag">at launch</span>}</h3>
              <p>Daily credits for staked $WEIGHT. They do not roll over.</p>
            </div>
            <span className="perk-v mono">{on ? `${usd(p?.stake?.daily_usd_micro ?? 0)} a day` : "off"}</span>
          </li>
        </ul>
        {on && me && (
          <p className="small dim">
            Left of today's staking credit: <span className="mono">{usd(me.allowance_usd_micro)}</span>.
          </p>
        )}
        {!on && (
          <p className="small dimmer">
            No contract address exists. Anything claiming to be $WEIGHT before launch is not.{" "}
            <Link className="link" href="/roadmap">
              Roadmap
            </Link>
          </p>
        )}
      </div>
    </section>
  );
}
