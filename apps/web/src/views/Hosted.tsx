// The room of the always-awake model. It looks like a session's room with the clock taken out: nothing wakes,
// nothing ends, and what is counted is tokens. The rail shows what the conversation used and how to call it.

import { useEffect, useRef, useState } from "react";
import type { HostedModel, Me } from "../api";
import { context, day, grouped, usd } from "../lib/format";
import { freeLine, perMillion, tokenPrices } from "../lib/hosted";
import { useHostedChat, type Refusal, type Tally } from "../lib/hostedchat";
import { refreshMe, useHosted, useMe, useTitle } from "../lib/hooks";
import { snippets, type Lang } from "../lib/snippets";
import { Link } from "../router";
import { Code, Copy, Icon, Notice, Segmented } from "../ui/bits";
import NotFound from "./NotFound";
import { absoluteBase, Composer, Log } from "./session/Room";
import "./session.css";
import "./hosted.css";

export default function Hosted() {
  const model = useHosted();
  useTitle(model?.name ?? "Chat");
  if (model === undefined) return <div className="page wrap" aria-busy="true" />;
  if (model === null) return <NotFound title="No always-awake model right now" text="Every model in the catalog can still be woken and rented by the minute." back={{ href: "/models", label: "See the models" }} />;
  return <HostedRoom model={model} />;
}

const STARTERS = ["What can I ask you? Three short examples.", "Explain what a token is to someone who has never used a language model.", "Write a Python function that prices a request from its input and output tokens."];

/** Whether the next message is paid from the balance. The gateway decides; this is what the page expects. */
function pays(me: Me | null, lastFree: boolean | undefined): boolean {
  if (!me?.address) return false;
  return lastFree === undefined ? me.balance_usd_micro > 0 : !lastFree;
}

function HostedRoom({ model }: { model: HostedModel }) {
  const me = useMe();
  useEffect(() => {
    // The free messages left are counted per day: ask afresh when the room opens.
    void refreshMe().catch(() => undefined);
  }, []);
  const check = useRef<HTMLDivElement>(null);
  const chat = useHostedChat(check);
  // The rail sits behind a tab on a narrow screen, as in a session's room: the shared sheet knows it as "session".
  const [tab, setTab] = useState<"chat" | "session">("chat");

  const signedIn = Boolean(me?.address);
  const paying = pays(me, chat.last?.free);
  const left = chat.busy && chat.last?.free_left != null ? chat.last.free_left : (me?.hosted?.free_left ?? chat.last?.free_left ?? model.free.per_day);
  // A free message runs without tools. Say so once it has happened, instead of offering a switch that does nothing.
  const note = chat.toolsOn && chat.last?.free && !chat.last.tools ? "Free messages run without tools. Paid ones may call the chain toolkit." : undefined;

  return (
    <div className="wrap room" data-tab={tab}>
      <div className="room-bar">
        <span className="state awake">always awake</span>
        <Segmented
          label="View"
          value={tab}
          onChange={setTab}
          options={[
            { value: "chat", label: "Chat" },
            { value: "session", label: "Usage" },
          ]}
        />
      </div>

      <section className="chat" aria-label="Chat">
        <header className="chat-h">
          <h1 className="chat-name">{model.name}</h1>
          <span className="state awake hc-state">always awake</span>
          <span className="chat-meta mono">
            <span>per token</span>
            <span>{tokenPrices(model)}</span>
          </span>
        </header>
        <Log
          chat={chat}
          live
          model={model}
          empty={
            <>
              <p className="h3">It is always awake. Say something.</p>
              <p className="dim">
                No wake and no clock. {model.free.per_day} messages a day are free; after that each answer is paid per token from your balance.
              </p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s} type="button" className="starter" onClick={() => chat.send(s)}>
                    <span>{s}</span>
                    <Icon name="arrow" size={14} />
                  </button>
                ))}
              </div>
              <p className="small dimmer">With Tools on, paste a token address and the model can look it up with the chain toolkit. Tools run on paid messages.</p>
            </>
          }
        />
        {chat.refusal && <Refused refusal={chat.refusal} signedIn={signedIn} />}
        <p className="hc-line small" aria-live="polite">
          {chat.refusal && WAY_OUT.has(chat.refusal.code) ? null : paying ? (
            <>
              <span className="dim">Paid per token from your balance.</span> <span className="mono">{usd(me?.balance_usd_micro ?? 0)}</span>
            </>
          ) : (
            <span className={left > 0 ? "dim" : undefined}>{freeLine(left, model.free.per_day)}</span>
          )}
        </p>
        <Composer chat={chat} model={model} note={note} draft={chat.draft} />
        <div ref={check} className="hc-check" />
      </section>

      <aside className="rail" aria-label="Usage">
        <Used tally={chat.tally} model={model} />
        <Terms model={model} me={me} left={left} />
        <Calls model={model} signedIn={signedIn} />
        {me?.hosted && me.hosted.recent.length > 0 && <Recent me={me} />}
      </aside>
    </div>
  );
}

// What each calm refusal says, and where its way out leads. Anything else shows the gateway's own sentence.
const SAY: Record<string, { out: string; in: string }> = {
  free_used: { out: "Today's free messages are used. Sign in and top up to keep going, paid per token.", in: "Today's free messages are used. Top up to keep going, paid per token." },
  free_budget_spent: {
    out: "Today's free messages are all taken, by everyone together. Sign in and top up to keep going, or come back tomorrow.",
    in: "Today's free messages are all taken, by everyone together. Top up to keep going, or come back tomorrow.",
  },
  insufficient_balance: { out: "Your balance does not cover this message.", in: "Your balance does not cover this message." },
  hosted_busy: { out: "The model is busy right now. Your message is back in the box: try again later.", in: "The model is busy right now. Your message is back in the box: try again later." },
};
const WAY_OUT = new Set(["free_used", "free_budget_spent", "insufficient_balance"]);

function Refused({ refusal, signedIn }: { refusal: Refusal; signedIn: boolean }) {
  const say = SAY[refusal.code];
  return (
    <div className="hc-refused" role="status">
      <Notice>
        {say ? (signedIn ? say.in : say.out) : refusal.message}{" "}
        {WAY_OUT.has(refusal.code) &&
          (signedIn ? (
            <Link className="link" href="/account#balance">
              Top up
            </Link>
          ) : (
            <Link className="link" href="/account">
              Sign in
            </Link>
          ))}
      </Notice>
    </div>
  );
}

function Used({ tally, model }: { tally: Tally; model: HostedModel }) {
  return (
    <section className="meter" aria-label="This conversation">
      <div className="meter-h">
        <span className="micro">This conversation</span>
        <span className="micro">per token</span>
      </div>
      <dl className="meter-read hc-read">
        <div className="readout">
          <dt className="micro">Cost</dt>
          <dd>
            <b>{usd(tally.cost_usd_micro)}</b>
          </dd>
        </div>
        <div className="readout">
          <dt className="micro">Answers</dt>
          <dd>
            <b>{grouped(tally.answers)}</b>
          </dd>
        </div>
        <div className="readout">
          <dt className="micro">Tokens in</dt>
          <dd>
            <b>{grouped(tally.tokens_in)}</b>
          </dd>
        </div>
        <div className="readout">
          <dt className="micro">Tokens out</dt>
          <dd>
            <b>{grouped(tally.tokens_out)}</b>
          </dd>
        </div>
      </dl>
      <p className="small dimmer">
        There is no clock here. Each answer is charged for the tokens it read and the tokens it wrote, at {tokenPrices(model)}. A free message counts its tokens and costs nothing. The whole
        conversation is read again with every message, so tokens in grow as it gets longer.
      </p>
    </section>
  );
}

function Terms({ model, me, left }: { model: HostedModel; me: Me | null; left: number }) {
  return (
    <section className="endpoint" aria-label="Price">
      <div className="meter-h">
        <span className="micro">Price</span>
        <span className="micro">always awake</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Input</dt>
          <dd className="mono small">{perMillion(model.price_in_usd_micro_per_mtok)} per 1M tokens</dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd className="mono small">{perMillion(model.price_out_usd_micro_per_mtok)} per 1M tokens</dd>
        </div>
        <div>
          <dt>Free</dt>
          <dd className="small">
            {model.free.per_day} messages a day, <span className="mono">{left}</span> left today
          </dd>
        </div>
        {me?.address && (
          <div>
            <dt>Balance</dt>
            <dd className="small ep-row">
              <span className="mono">{usd(me.balance_usd_micro)}</span>
              <Link href="/account#balance" className="link">
                Top up
              </Link>
            </dd>
          </div>
        )}
        <div>
          <dt>Context</dt>
          <dd className="mono small">{context(model.context)} tokens</dd>
        </div>
        {model.source && (
          <div>
            <dt>Source</dt>
            <dd className="small">{model.source}</dd>
          </div>
        )}
      </dl>
      <p className="small dimmer">
        A free message is short: it runs without tools and its answer is cut at {grouped(model.free.max_output_tokens)} tokens. Every other model here sleeps until someone wakes it and is rented{" "}
        <Link href="/docs/pricing" className="link">
          by the GPU minute
        </Link>
        .
      </p>
    </section>
  );
}

function Calls({ model, signedIn }: { model: HostedModel; signedIn: boolean }) {
  const [lang, setLang] = useState<Lang>("curl");
  const base = absoluteBase("");
  return (
    <section className="endpoint" aria-label="Endpoint">
      <div className="meter-h">
        <span className="micro">Endpoint</span>
        <span className="micro">OpenAI-compatible</span>
      </div>
      <dl className="facts">
        <div>
          <dt>Base URL</dt>
          <dd className="mono small ep-row">
            <span title={base}>{base}</span>
            <Copy text={base} />
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd className="mono small ep-row">
            <span title={model.id}>{model.id}</span>
            <Copy text={model.id} />
          </dd>
        </div>
      </dl>
      <Segmented
        label="Language"
        value={lang}
        onChange={setLang}
        options={[
          { value: "curl", label: "curl" },
          { value: "python", label: "Python" },
          { value: "js", label: "JavaScript" },
        ]}
      />
      <Code code={snippets(base, model.id)[lang]} title={lang === "curl" ? "shell" : lang === "python" ? "python" : "javascript"} wrap />
      <p className="small dim">
        No session to start: a call with an API key and this model id is answered at once and paid per token from your balance. Streaming and your own tools work as on any model.{" "}
        {signedIn ? (
          <Link href="/account#keys" className="link">
            Your keys
          </Link>
        ) : (
          <>
            Keys belong to a wallet.{" "}
            <Link href="/account" className="link">
              Sign in
            </Link>{" "}
            to make one.
          </>
        )}
      </p>
    </section>
  );
}

const RECENT_ROWS = 5;
/** The account's last answers from this model, from the chat and from the API alike. */
function Recent({ me }: { me: Me }) {
  const rows = me.hosted!.recent.slice(0, RECENT_ROWS);
  return (
    <section className="endpoint" aria-label="Recent answers">
      <div className="meter-h">
        <span className="micro">Recent answers</span>
        <Link href="/account#hosted-use" className="micro hc-more">
          All history
        </Link>
      </div>
      <ul className="hc-recent">
        {rows.map((u) => (
          <li key={u.id}>
            <span className="mono small">
              {grouped(u.tokens_in)} in · {grouped(u.tokens_out)} out
            </span>
            <b className={`mono small${u.free ? " dim" : ""}`}>{u.free ? "free" : usd(u.charged_usd_micro)}</b>
            <span className="mono hc-when">
              {u.surface === "api" ? "API" : "chat"} · {day(u.at)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
