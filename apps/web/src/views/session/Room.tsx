// The session room: chat on the left; the meter, the endpoint and, at the end, the receipt on the right.

import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Model, Session } from "../../api";
import { splitThinking, useChat, type Item } from "../../lib/chat";
import { clock, grouped, perMin, took, usd } from "../../lib/format";
import { useConfig, useEvery, useMe } from "../../lib/hooks";
import { showHidden, toolSummary, visible } from "../../lib/inert";
import { Markdown } from "../../lib/markdown";
import type { Live } from "../../lib/session";
import { Link } from "../../router";
import { Code, Copy, Icon, Notice, Segmented, TierMark } from "../../ui/bits";
import { Ticket, TicketActions } from "./Receipt";

type Chat = ReturnType<typeof useChat>;

// ---------- transcript ----------

function compactArgs(args: string): string {
  try {
    const o = JSON.parse(args) as Record<string, unknown>;
    return Object.entries(o)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" ");
  } catch {
    return args;
  }
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

type TurnProps = {
  item: Item;
  last: boolean;
  canAct: boolean;
  onRegenerate: () => void;
  /** Set on replies that follow a tool call. They may repeat text a stranger wrote, so their links stay text. */
  plainLinks: boolean;
};

const Turn = memo(function Turn({ item, last, canAct, onRegenerate, plainLinks }: TurnProps) {
  if (item.kind === "user") {
    return (
      <div className="turn user">
        <div className="who micro">You</div>
        <div className="said">{item.text}</div>
      </div>
    );
  }
  if (item.kind === "tool") {
    // A tool result can quote text its subject wrote (a token name, a revert reason). It goes on the page as
    // plain text only: no markdown, no links, nothing hidden, and never in the model's voice.
    const said = toolSummary(item.result);
    return (
      <div className="turn tool-turn">
        <div className="who micro">Tool</div>
        <details className={`tool ${item.state}`}>
          <summary>
            <span className="tool-mark" aria-hidden="true" />
            <span className="mono tool-name">{item.name}</span>
            <span className="mono tool-args">{showHidden(compactArgs(item.args))}</span>
            <span className="mono tool-ms">{item.state === "running" ? "running" : item.state === "error" ? "failed" : item.state === "stopped" ? "stopped" : took(item.ms ?? 0)}</span>
            <Icon name="chevron" size={14} />
          </summary>
          <div className="tool-io">
            <span className="micro">Arguments</span>
            <pre tabIndex={0}>{showHidden(pretty(item.args || "{}"))}</pre>
            {item.result != null && (
              <>
                <span className="micro">Result</span>
                <pre tabIndex={0}>{showHidden(pretty(item.result))}</pre>
              </>
            )}
          </div>
        </details>
        {said && (
          <p className="tool-said">
            {said.partial && <span className="tag">partial</span>}
            {said.text}
          </p>
        )}
      </div>
    );
  }
  // Thinking comes in its own field from most engines and inside <think> tags from some. Either way it is shown
  // apart from the answer. A model's words are shown with nothing hidden in them.
  const split = splitThinking(item.text);
  const thinking = visible([item.thinking, split.thinking].filter(Boolean).join("\n\n"));
  const answer = visible(split.answer);
  const streaming = item.state === "streaming";
  const open = split.open || (Boolean(item.thinking) && !item.text);
  const rate = item.usage && item.ms ? item.usage.completion_tokens / (item.ms / 1000) : null;
  return (
    <div className="turn model">
      <div className="who micro">Model</div>
      <div className="said">
        {thinking && (
          <details className="think" open={open && streaming}>
            <summary>
              <Icon name="chevron" size={14} />
              {open && streaming ? "Thinking" : `Thought for ${thinking.split(/\s+/).length} words`}
            </summary>
            <div>{thinking}</div>
          </details>
        )}
        {answer ? (
          <div className={`md md-chat${streaming ? " live" : ""}`}>
            <Markdown text={answer} plainLinks={plainLinks} clean />
          </div>
        ) : (
          streaming && !thinking && <i className="caret" aria-hidden="true" />
        )}
        {item.state === "error" && (
          <Notice kind="err">
            {item.error ?? "The reply failed."}{" "}
            {last && canAct && (
              <button type="button" className="link" onClick={onRegenerate}>
                Try again
              </button>
            )}
          </Notice>
        )}
        {!streaming && item.state !== "error" && (
          <div className="turn-foot">
            <span className="mono">
              {item.state === "stopped"
                ? "stopped"
                : item.usage
                  ? `${grouped(item.usage.completion_tokens)} tokens${item.ms ? ` · ${took(item.ms)}` : ""}${rate ? ` · ${rate.toFixed(0)} tok/s` : ""}`
                  : ""}
            </span>
            <span className="turn-acts">
              {answer && <Copy text={answer} />}
              {last && canAct && (
                <button type="button" className="copy" onClick={onRegenerate}>
                  <Icon name="redo" size={14} />
                  Regenerate
                </button>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

const STARTERS = [
  "What does one GPU minute buy me here? Two sentences.",
  "Write a Python function that bills GPU time by the second at a per-minute rate.",
  "Compare the three weight classes in a table.",
];

function Log({ chat, live, paused = false, model }: { chat: Chat; live: boolean; paused?: boolean; model: Model | null }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.items]);

  const lastId = chat.items.at(-1)?.id;
  const firstTool = chat.items.findIndex((it) => it.kind === "tool");
  // A reply that grows word by word is not read out as it grows. One line says that the model is writing, then
  // that it is done; the reply itself is there to be read when the reader wants it.
  const reply = chat.items.findLast((it) => it.kind === "assistant");
  const status = chat.busy
    ? "The model is writing."
    : reply?.kind !== "assistant"
      ? ""
      : reply.state === "error"
        ? "The reply failed."
        : reply.state === "stopped"
          ? "The reply was stopped."
          : `Reply finished${reply.usage ? `, ${grouped(reply.usage.completion_tokens)} tokens` : ""}.`;
  return (
    <>
    <p className="sr" role="status">
      {status}
    </p>
    <div
      className="log"
      ref={box}
      tabIndex={0}
      role="log"
      aria-live={chat.busy ? "off" : "polite"}
      aria-label="Conversation"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
    >
      {chat.items.length === 0 ? (
        <div className="log-empty">
          <p className="h3">{live ? "It is awake. Say something." : paused ? "Nothing said yet." : "Nothing was said in this session."}</p>
          {live && (
            <>
              <p className="dim">The clock on this session is running. Chat here, or call the endpoint from your own code.</p>
              <div className="starters">
                {STARTERS.map((s) => (
                  <button key={s} type="button" className="starter" onClick={() => chat.send(s)}>
                    <span>{s}</span>
                    <Icon name="arrow" size={14} />
                  </button>
                ))}
              </div>
              {model?.tools_ok && <p className="small dimmer">With Tools on, paste a token address and the model can look it up with the chain toolkit.</p>}
            </>
          )}
        </div>
      ) : (
        <div className="turns">
          {chat.items.map((it, i) => (
            <Turn key={it.id} item={it} last={it.id === lastId} canAct={live && !chat.busy} onRegenerate={chat.regenerate} plainLinks={firstTool >= 0 && i > firstTool} />
          ))}
        </div>
      )}
    </div>
    </>
  );
}

function Composer({ chat, model }: { chat: Chat; model: Model | null }) {
  const [text, setText] = useState("");
  const ta = useRef<HTMLTextAreaElement>(null);
  const grow = (): void => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };
  useEffect(grow, [text]);
  useEffect(() => {
    if (matchMedia("(pointer: fine)").matches) ta.current?.focus();
  }, []);

  function submit(): void {
    if (!text.trim() || chat.busy) return;
    chat.send(text);
    setText("");
  }
  function key(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }
  const toolsOk = model?.tools_ok !== false;
  const hint = !toolsOk
    ? "This model does not call tools."
    : chat.toolsState === "loading"
      ? "Loading the toolkit."
      : chat.toolsState === "error"
        ? "The toolkit did not load. Try again."
        : chat.toolsOn
          ? "The model may call the chain toolkit. Read-only."
          : "Let the model call the chain toolkit.";

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea ref={ta} rows={1} value={text} placeholder="Message the model" aria-label="Message" onChange={(e) => setText(e.target.value)} onKeyDown={key} />
      <div className="composer-row">
        <button type="button" role="switch" aria-checked={chat.toolsOn} className="switch" disabled={!toolsOk || chat.busy} onClick={() => chat.toggleTools(!chat.toolsOn)}>
          <span className="switch-track" aria-hidden="true">
            <i />
          </span>
          Tools
        </button>
        <span className="small dimmer composer-hint">{hint}</span>
        {chat.busy ? (
          <button type="button" className="btn sm" onClick={chat.stop}>
            <Icon name="stop" size={14} />
            Stop
          </button>
        ) : (
          <button type="submit" className="btn sm primary" disabled={!text.trim()}>
            Send
            <Icon name="up" size={14} />
          </button>
        )}
      </div>
    </form>
  );
}

// ---------- the meter ----------

type Meter = { left: number; elapsed: number; total: number };
/** The session clock. While the model is being woken again the clock is stopped: it holds its last reading. */
function useMeter(live: Live, s: Session): Meter & { stopped: boolean } {
  const last = useRef<Meter | null>(null);
  const now = live.serverNow();
  if (s.state !== "active" || s.started_at == null || s.ends_at == null) return { ...(last.current ?? { left: 0, elapsed: s.gpu_seconds * 1000, total: 0 }), stopped: true };
  const m = { left: Math.max(0, s.ends_at - now), elapsed: Math.max(0, Math.min(now, s.ends_at) - s.started_at), total: Math.max(0, s.ends_at - s.started_at) };
  last.current = m;
  return { ...m, stopped: false };
}
/** What is left on a stopped clock, or dashes when this page never saw it running. */
const leftText = (m: Meter & { stopped: boolean }): string => (m.stopped && m.total === 0 ? "-:--" : clock(m.left));

// Anything not named here shows the gateway's own sentence (too_long carries the limit).
const ACTION_ERR: Record<string, string> = {
  free_session_fixed: "A free session cannot be extended. Sign in to rent by the minute.",
  insufficient_balance: "Your balance does not cover more minutes.",
  session_ended: "This session is no longer running.",
};
/** "5 minutes", "90 seconds". */
const span = (seconds: number): string => (seconds % 60 === 0 ? `${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `${seconds} seconds`);

function Clock({ live, session: s, model }: { live: Live; session: Session; model: Model | null }) {
  useEvery(250);
  const me = useMe();
  const [confirm, setConfirm] = useState(false);
  /** True once the question was asked and turned down: focus then goes back to the button that asked. */
  const asked = useRef(false);
  const idle = useConfig()?.idle_seconds ?? 0;
  const meter = useMeter(live, s);
  const { left, elapsed, total, stopped } = meter;
  const totalMin = Math.max(1, Math.round(total / 60_000));
  const unit = totalMin <= 20 ? 1 : totalMin <= 100 ? 5 : 15;
  const n = Math.ceil(totalMin / unit);
  const used = elapsed / 60_000 / unit;
  const low = !stopped && left < 60_000;
  const rate = model?.price_usd_micro_per_min ?? 0;

  return (
    <section className="meter" aria-label="Clock">
      <div className="meter-h">
        <span className="micro">Time left</span>
        <span className="micro">
          {stopped ? "clock stopped" : s.free ? "free session" : model ? perMin(rate) : ""}
        </span>
      </div>
      <div className={`meter-left${low ? " low" : ""}`} role="timer" aria-label={`Time left ${leftText(meter)}`}>
        {[...leftText(meter)].map((c, i) => (
          <b key={i} className={/\d/.test(c) ? undefined : "sep"}>
            {c}
          </b>
        ))}
      </div>
      <div className="meter-bar" aria-hidden="true" style={{ "--n": n } as CSSProperties}>
        {Array.from({ length: n }, (_, i) => {
          const f = Math.max(0, Math.min(1, used - i));
          return <i key={i} style={{ "--f": f.toFixed(3) } as CSSProperties} />;
        })}
      </div>
      <div className="meter-scale micro" aria-hidden="true">
        <span>0</span>
        <span>
          1 plate = {unit} min
        </span>
        <span>{totalMin} min</span>
      </div>

      <dl className="meter-read">
        <div className="readout">
          <dt className="micro">Spent</dt>
          <dd>
            <b>{usd(s.spent_usd_micro)}</b>
          </dd>
        </div>
        <div className="readout">
          <dt className="micro">GPU-seconds</dt>
          <dd>
            <b>{grouped(Math.floor(elapsed / 1000))}</b>
          </dd>
        </div>
        <div className="readout">
          <dt className="micro">Tokens in</dt>
          <dd>
            <b>{grouped(s.tokens_in)}</b>
          </dd>
        </div>
        <div className="readout">
          <dt className="micro">Tokens out</dt>
          <dd>
            <b>{grouped(s.tokens_out)}</b>
          </dd>
        </div>
      </dl>
      <p className="small dimmer">
        {s.free ? "This session is free. Tokens are counted, never charged." : "Billed by the second, one-minute minimum once the model is awake. Tokens are counted, never charged."}
        {idle > 0 ? ` A session with no request for ${span(idle)} ends on its own.` : ""}
      </p>

      {live.actionError && <Notice kind="err">{ACTION_ERR[live.actionError.code] ?? live.actionError.message}</Notice>}

      {confirm ? (
        <div className="meter-confirm" key="confirm">
          <span>Stop now and take the receipt?</span>
          <div className="row">
            <button type="button" className="btn sm danger" autoFocus onClick={() => void live.stop()} disabled={live.busy === "stop"} aria-busy={live.busy === "stop"}>
              Stop the session
            </button>
            <button
              type="button"
              className="btn sm quiet"
              onClick={() => {
                asked.current = true;
                setConfirm(false);
              }}
            >
              Keep going
            </button>
          </div>
        </div>
      ) : (
        <div className="meter-act" key="act">
          {s.free ? (
            <span className="small dim meter-free">
              {me?.address ? "A free session cannot be extended." : (
                <>
                  A free session cannot be extended.{" "}
                  <Link href="/account" className="link">
                    Sign in
                  </Link>{" "}
                  to rent by the minute.
                </>
              )}
            </span>
          ) : (
            <>
              <button type="button" className="btn sm" onClick={() => void live.extend(5)} disabled={live.busy != null}>
                +5 min
              </button>
              <button type="button" className="btn sm" onClick={() => void live.extend(15)} disabled={live.busy != null}>
                +15 min
              </button>
            </>
          )}
          <button type="button" className="btn sm meter-stop" autoFocus={asked.current} onClick={() => setConfirm(true)}>
            <Icon name="stop" size={14} />
            Stop
          </button>
        </div>
      )}
    </section>
  );
}

/** The phone bar's time left: its own ticking component so the rest of the room stays still. */
function MiniClock({ live, session: s }: { live: Live; session: Session }) {
  useEvery(500);
  const meter = useMeter(live, s);
  if (meter.stopped) return <span className="room-left mono">clock stopped</span>;
  return (
    <span className={`room-left mono${meter.left < 60_000 ? " low" : ""}`} role="timer" aria-label={`Time left ${clock(meter.left)}`}>
      {clock(meter.left)}
    </span>
  );
}

// ---------- the endpoint ----------

type Lang = "curl" | "python" | "js";

function snippets(base: string, model: string): Record<Lang, string> {
  return {
    curl: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer $FREEWEIGHT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
    python: `import os
from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key=os.environ["FREEWEIGHT_KEY"],
)
r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)`,
    js: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: process.env.FREEWEIGHT_KEY,
});
const r = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);`,
  };
}

export function absoluteBase(baseUrl: string): string {
  try {
    return new URL(baseUrl || "/v1", location.origin).href.replace(/\/$/, "");
  } catch {
    return `${location.origin}/v1`;
  }
}

function Endpoint({ session: s }: { session: Session }) {
  const me = useMe();
  const [lang, setLang] = useState<Lang>("curl");
  const base = absoluteBase(s.base_url);
  const code = snippets(base, s.model_id)[lang];
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
            <span title={s.model_id}>{s.model_id}</span>
            <Copy text={s.model_id} />
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
      <Code code={code} title={lang === "curl" ? "shell" : lang === "python" ? "python" : "javascript"} wrap />
      <p className="small dimmer">The address of this page works like a key to this session until it ends. Do not share it while the session runs.</p>
      <p className="small dim">
        {me?.address ? (
          <>
            Calls need an API key. A key reaches any session of yours that is awake, this one included.{" "}
            <Link href="/account#keys" className="link">
              Your keys
            </Link>
          </>
        ) : (
          <>
            Calls need an API key, and keys belong to a wallet.{" "}
            <Link href="/account" className="link">
              Sign in
            </Link>{" "}
            to make one. The chat on this page needs nothing.
          </>
        )}
      </p>
    </section>
  );
}

// ---------- the room ----------

export function Room({ live, session: s, model }: { live: Live; session: Session; model: Model | null }) {
  const active = s.state === "active";
  // The model is being woken again under a running session: the room stays, the clock is stopped, nothing can be sent.
  const paused = s.state === "waking";
  const open = active || paused;
  const chat = useChat(s.id, s.model_id, active);
  const [tab, setTab] = useState<"chat" | "session">("chat");
  const ended = useRef(false);
  useEffect(() => {
    // While the model wakes again nothing new can be sent, but a request already on its way is left alone: the
    // gateway holds it and answers when the model is back.
    if (!open && !ended.current) {
      ended.current = true;
      chat.stop();
      setTab("session");
    }
  }, [open, chat]);

  const readyAt = s.stages.find((e) => e.stage === "ready")?.t_ms ?? null;
  return (
    <div className="wrap room" data-tab={tab}>
      <div className="room-bar">
        {open ? <MiniClock live={live} session={s} /> : <span className="room-left mono">ended</span>}
        <Segmented
          label="View"
          value={tab}
          onChange={setTab}
          options={[
            { value: "chat", label: "Chat" },
            { value: "session", label: open ? "Session" : "Receipt" },
          ]}
        />
      </div>

      <section className="chat" aria-label="Chat">
        <header className="chat-h">
          <h1 className={`chat-name${model ? ` tw-${model.tier}` : ""}`}>{model?.name ?? s.model_id}</h1>
          <span className={`state ${active ? "awake" : paused ? "waking" : "asleep"}`}>{active ? "awake" : paused ? "waking again" : "session ended"}</span>
          <span className="chat-meta mono">
            {model && <TierMark tier={model.tier} />}
            {readyAt != null && <span>{readyAt < 1500 ? "joined awake" : `woke in ${took(readyAt)}`}</span>}
          </span>
        </header>
        <Log chat={chat} live={active} paused={paused} model={model} />
        {active ? (
          <Composer chat={chat} model={model} />
        ) : paused ? (
          <div className="composer ended" role="status">
            <span>
              <strong>The model is waking again.</strong> The clock is stopped until it is back. Your conversation stays here, and you can write again as soon as it is awake.
            </span>
          </div>
        ) : (
          <div className="composer ended">
            <span>The session has ended and the model is going back to sleep. Your conversation stays on this page until you leave it.</span>
            <Link href={`/models/${s.model_id}`} className="btn sm primary">
              Wake it again
              <Icon name="arrow" size={14} />
            </Link>
          </div>
        )}
      </section>

      <aside className="rail" aria-label={open ? "Session" : "Receipt"}>
        {open ? (
          <>
            <Clock live={live} session={s} model={model} />
            <Endpoint session={s} />
          </>
        ) : (
          <div className="rail-rcpt">
            <Ticket session={s} model={model} />
            <TicketActions session={s} model={model} />
          </div>
        )}
      </aside>
    </div>
  );
}
