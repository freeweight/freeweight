// List a model: paste a Hugging Face repo, see the checks, add the owner line, submit.

import { useEffect, useState, type FormEvent } from "react";
import { api, type Check, type Listing, type Model } from "../api";
import { perMin, shortSha, TIER_CLASS, TIER_NAME } from "../lib/format";
import { toApiError, useConfig, useLive, useMe, useTitle } from "../lib/hooks";
import { parseRepo } from "../lib/repo";
import { Link, navigate } from "../router";
import { Code, Icon, Notice, TierMark } from "../ui/bits";
import "./account.css";

// The gateway names its checks; a name this build does not know still gets a row, under its own name.
const LABEL: Record<string, string> = {
  public: "Public repo",
  license: "Licence",
  safetensors: "Weights format",
  chat_template: "Chat template",
  text_generation: "Text model",
  size: "Size and class",
  owner_proof: "Owner proof",
  pinned: "Pinned commit",
};
// Anything not named here shows the gateway's own sentence.
const ERR: Record<string, string> = {
  bad_repo: "Use the form owner/name, as on Hugging Face.",
  bad_request: "Use the form owner/name, as on Hugging Face.",
  repo_not_found: "Hugging Face has no public repo with that name.",
  listing_not_found: "That listing no longer exists. Check the repo again.",
  hf_unavailable: "Hugging Face did not answer. Check again in a minute.",
  sign_in_required: "Sign in with the wallet that should own the listing, then check again.",
};

function label(c: Check): string {
  return LABEL[c.name] ?? c.name.replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase());
}

export default function ListModel() {
  useTitle("List a model");
  const me = useMe();
  const config = useConfig();
  const { models } = useLive();
  // A listing belongs to a wallet, so the check needs one. Until the account has loaded the form stays as it is.
  const signedOut = me !== null && !me.address;
  const share = (config?.owner_share_bps ?? 3000) / 100;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A reload, or a shared link, picks the listing up again by its id.
  useEffect(() => {
    const id = new URLSearchParams(location.search).get("id");
    if (!id) return;
    let live = true;
    setBusy(true);
    api.listing(id).then(
      (l) => {
        if (!live) return;
        setListing(l);
        setText(l.hf_repo);
        setBusy(false);
      },
      (e: unknown) => {
        if (!live) return;
        const a = toApiError(e);
        setError(ERR[a.code] ?? a.message);
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
  }, []);

  async function check(repo: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const l = await api.createListing(repo);
      setListing(l);
      navigate(`/list?id=${encodeURIComponent(l.id)}`, { replace: true, keepScroll: true });
    } catch (e) {
      const a = toApiError(e);
      setError(ERR[a.code] ?? a.message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent): void {
    e.preventDefault();
    if (busy) return;
    const repo = parseRepo(text);
    if (!repo) {
      setError(ERR.bad_repo!);
      return;
    }
    setText(repo);
    void check(repo);
  }

  const same = listing !== null && parseRepo(text) === listing.hf_repo;

  return (
    <div className="wrap page list">
      <header className="page-head">
        <p className="micro">List a model</p>
        <h1 className="h2">Put your model in the catalog</h1>
        <p>Point at a public Hugging Face repo. The checks run in a few seconds, the commit is pinned, and anyone can rent the model by the minute once it is approved.</p>
      </header>

      <section className="sec" aria-labelledby="list-repo">
        <div className="sec-h">
          <h2 className="h3" id="list-repo">
            Repository
          </h2>
          <p>Safetensors weights, a chat template, and a licence that allows hosting.</p>
        </div>
        <div className="sec-b">
          <form className="list-form" onSubmit={submit} noValidate>
            <label className="label" htmlFor="repo">
              Hugging Face repo
            </label>
            <div className="list-row">
              <input
                id="repo"
                className="input mono"
                placeholder="owner/name"
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setError(null);
                }}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="repo-hint"
                aria-invalid={error ? true : undefined}
              />
              <button type="submit" className="btn primary" disabled={busy || !text.trim() || signedOut}>
                {busy ? "Checking" : same ? "Check again" : "Check it"}
              </button>
            </div>
            <p className="list-hint" id="repo-hint">
              A repo name or its link. Nothing is listed until every check passes.
            </p>
          </form>
          {signedOut && (
            <Notice>
              A listing belongs to a wallet, and one of the checks looks for that wallet in the repo's README.{" "}
              <Link className="link" href="/account">
                Sign in
              </Link>{" "}
              with the wallet that should own the listing, then check the repo.
            </Notice>
          )}
          {error && <Notice kind="err">{error}</Notice>}
        </div>
      </section>

      {(listing || busy) && (
        <section className="sec" aria-labelledby="list-checks" aria-busy={busy}>
          <div className="sec-h">
            <h2 className="h3" id="list-checks">
              Checks
            </h2>
            <p>Run against one commit, which is then pinned.</p>
          </div>
          <div className="sec-b">
            {!listing ? (
              <ul className="checks" aria-hidden="true">
                {[62, 48, 56, 70, 52, 58, 66, 44].map((w) => (
                  <li key={w}>
                    <span className="chk-i" />
                    <span className="skel" style={{ width: `${w}%`, height: 12, marginTop: 4 }} />
                  </li>
                ))}
              </ul>
            ) : (
              <Result listing={listing} models={models} proof={listing.proof_line ?? me?.listing_proof_line ?? null} busy={busy} again={() => void check(listing.hf_repo)} />
            )}
          </div>
        </section>
      )}

      <section className="sec" aria-labelledby="list-terms">
        <div className="sec-h">
          <h2 className="h3" id="list-terms">
            What listing means
          </h2>
          <p>Short, because it is.</p>
        </div>
        <div className="sec-b">
          <dl className="list-terms">
            <div>
              <dt>You earn on rent</dt>
              <dd>{share}% of the rent on your model accrues to your wallet in the ledger. Payouts are manual for now.</dd>
            </div>
            <div>
              <dt>The commit is pinned</dt>
              <dd>Renters get exactly the weights that were checked.</dd>
            </div>
            <div>
              <dt>You prove the repo is yours</dt>
              <dd>One line in the README names your wallet. No keys, no tokens, no upload.</dd>
            </div>
            <div>
              <dt>A person approves</dt>
              <dd>
                Listings are approved by hand for now. Self-serve listing is on the{" "}
                <Link className="link" href="/roadmap">
                  roadmap
                </Link>
                .
              </dd>
            </div>
          </dl>
        </div>
      </section>
    </div>
  );
}

function Result({ listing: l, models, proof, busy, again }: { listing: Listing; models: Model[] | null; proof: string | null; busy: boolean; again: () => void }) {
  const failed = l.checks.filter((c) => !c.ok).length;
  const price = l.tier ? models?.find((m) => m.tier === l.tier)?.price_usd_micro_per_min : undefined;

  return (
    <>
      <p className="list-repo">
        <span className="mono">
          {l.hf_repo}
          {l.sha && <span className="dimmer">@{shortSha(l.sha)}</span>}
        </span>
        {l.tier && (
          <span className="small dim">
            <TierMark tier={l.tier} /> · {TIER_CLASS[l.tier]}
            {price ? ` · ${perMin(price)}` : ""}
          </span>
        )}
      </p>

      <ul className="checks">
        {l.checks.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "no"}>
            <span className="chk-i" aria-hidden="true">
              <Icon name={c.ok ? "check" : "cross"} size={12} />
            </span>
            <div className="chk-h">
              <b>{label(c)}</b>
              <span>{c.ok ? "pass" : "fix this"}</span>
            </div>
            <p className="chk-d">{c.detail}</p>
            {c.name === "size" && c.ok && l.tier && (
              <p className="chk-d">
                It rents as {TIER_NAME[l.tier]}
                {price ? `, ${perMin(price)}` : ""}.
              </p>
            )}
            {/* The line comes from the gateway, which knows the wallet. Without it there is nothing to show, and nothing is guessed. */}
            {c.name === "owner_proof" && !c.ok && proof && (
              <div className="chk-x">
                <p>Add this line to the repo's README.md, commit, then check again.</p>
                <Code title="README.md" code={proof} wrap />
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="list-verdict">
        {l.state === "pending" ? (
          <Notice kind="brass">
            <b>Submitted.</b> Every check passes. A person approves listings for now, and the model appears in the catalog once that is done.
          </Notice>
        ) : l.state === "building" ? (
          <Notice kind="brass">
            <b>Approved, and being prepared.</b> The weights are being stored. The model appears in the catalog when that is done.
          </Notice>
        ) : l.state === "listed" ? (
          <Notice kind="brass">
            <b>Listed.</b> The model is in the{" "}
            <Link className="link" href={l.model_id ? `/models/${l.model_id}` : "/models"}>
              catalog
            </Link>
            .
          </Notice>
        ) : l.state === "failed" ? (
          <Notice kind="err">
            <b>Preparing the model did not finish.</b> {l.detail ?? "Nothing was listed."}
          </Notice>
        ) : failed > 0 ? (
          // Rejected by the checks: nothing to wait for, something to fix. Checking again runs them on the newest commit.
          <>
            <p className="small dim">
              Not listed: {failed} {failed === 1 ? "check" : "checks"} to fix. Fix the repo, then check again. It is submitted by itself when all of them pass.
            </p>
            <button type="button" className="btn" onClick={again} disabled={busy}>
              <Icon name="redo" />
              {busy ? "Checking" : "Check again"}
            </button>
          </>
        ) : (
          <Notice kind="err">
            <b>This listing was not approved.</b> {l.detail ?? ""}
          </Notice>
        )}
      </div>
    </>
  );
}
