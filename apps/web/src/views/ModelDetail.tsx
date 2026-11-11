// One model: what it is, wake it here, call it from code.

import { api, type Model } from "../api";
import { context, params as fmtParams, perMin, shortAddr, shortSha, TIER_CLASS, typicalWake } from "../lib/format";
import { loadFailed, refreshLive, useLive, useLoad, useTitle } from "../lib/hooks";
import { Link } from "../router";
import { Code, Icon, Notice, StateTag, TierMark } from "../ui/bits";
import { WakeBox } from "../ui/wakebox";
import NotFound from "./NotFound";
import "./catalog.css";

function wakeLine(m: Model): string {
  if (m.state === "awake") return "Awake now. Joining takes a few seconds.";
  if (m.state === "waking") return "Waking for someone else. You can join as soon as it is ready.";
  if (m.state === "unavailable") return "Not available right now.";
  const est = typicalWake(m)?.text;
  if (!est) return "Typical wake: not measured yet.";
  return m.state === "cold" ? `Wake: ${est}. Cold: the weights are not cached near a GPU yet, so the first one takes longer.` : `Wake: ${est}.`;
}

function snippet(m: Model): string {
  const origin = typeof location === "undefined" ? "" : location.origin;
  return [
    `curl ${origin}/v1/chat/completions \\`,
    `  -H "Authorization: Bearer $FREEWEIGHT_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{`,
    `    "model": "${m.id}",`,
    `    "messages": [{"role": "user", "content": "Hello"}]`,
    `  }'`,
  ].join("\n");
}

export default function ModelDetail({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const { models, error } = useLive();
  const config = useLoad(() => api.config(), []);
  const model = models?.find((m) => m.id === id) ?? null;
  useTitle(model?.name ?? "Model");

  if (models && !model) {
    return <NotFound title="No model with this id" text="It may have been unlisted, or the link is wrong." back={{ href: "/models", label: "See the models" }} />;
  }

  return (
    <div className="wrap page">
      <Link href="/models" className="micro model-crumb">
        <Icon name="arrow" size={12} />
        Models
      </Link>
      {!model ? (
        error ? (
          <Notice kind="err">
            The model did not load. {loadFailed(error)}{" "}
            <button type="button" className="link" onClick={refreshLive}>
              Try again
            </button>
          </Notice>
        ) : (
          <div className="model-page" aria-busy="true">
            <div className="model-main">
              <span className="skel" style={{ width: "60%", height: 48 }} />
              <div className="box box-skel" />
            </div>
          </div>
        )
      ) : (
        <div className="model-page">
          <div className="model-main">
            <header>
              <h1 className={`model-name tw-${model.tier}`}>{model.name}</h1>
              <p className="model-sub">
                <StateTag state={model.state} />
                <TierMark tier={model.tier} />
                <span className="mono">{perMin(model.price_usd_micro_per_min)}</span>
                {model.owner && <span className="tag">owner-listed</span>}
              </p>
            </header>
            <WakeBox models={models ?? [model]} initial={model.id} fixed config={config.data} />
            <section className="model-call" aria-labelledby="model-call-h">
              <h2 className="h3" id="model-call-h">
                Call it from code
              </h2>
              <p>
                The endpoint speaks the OpenAI chat format. A key with auto-session on wakes the model on the first request and answers when it is ready. Without it, start a session here and use the session's endpoint.
              </p>
              <Code title="curl" code={snippet(model)} />
              <p>
                <Link className="link" href="/account#keys">
                  Create a key
                </Link>{" "}
                ·{" "}
                <Link className="link" href="/docs/api">
                  API reference
                </Link>
              </p>
            </section>
          </div>

          <aside className="model-side" aria-label="Facts">
            <dl className="facts">
              <div>
                <dt>Weights</dt>
                <dd className="mono small">
                  <a className="link" href={`https://huggingface.co/${model.hf_repo}`} target="_blank" rel="noreferrer">
                    {model.hf_repo}
                  </a>
                  <span className="dimmer">@{shortSha(model.sha)}</span>
                </dd>
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
                <dt>Wake</dt>
                <dd>{wakeLine(model)}</dd>
              </div>
              <div>
                <dt>Params</dt>
                <dd className="mono small">{fmtParams(model.params_b)}</dd>
              </div>
              <div>
                <dt>Quant</dt>
                <dd className="mono small">{model.quant}</dd>
              </div>
              <div>
                <dt>Context</dt>
                <dd className="mono small">{context(model.context)} tokens</dd>
              </div>
              <div>
                <dt>Tools</dt>
                <dd>{model.tools_ok ? "Tool calls work" : "No tool calls"}</dd>
              </div>
              <div>
                <dt>Licence</dt>
                <dd className="mono small">{model.license}</dd>
              </div>
              {model.owner && (
                <div>
                  <dt>Listed by</dt>
                  <dd className="mono small" title={model.owner}>
                    {shortAddr(model.owner)}
                  </dd>
                </div>
              )}
              {model.tags.length > 0 && (
                <div>
                  <dt>Tags</dt>
                  <dd className="model-tags">
                    {model.tags.map((t) => (
                      <Link key={t} href={`/models?tag=${encodeURIComponent(t)}`} className="tag">
                        {t}
                      </Link>
                    ))}
                  </dd>
                </div>
              )}
            </dl>
            <p className="model-fine">The commit is pinned: every wake loads exactly these weights. Wake time is never billed.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
