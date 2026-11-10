// The receipt: a weigh ticket for a session. What was used, in the unit it is billed in.
// The strip under the model draws the whole session to scale: the wake in ink, the awake time in brass.

import type { CSSProperties } from "react";
import type { Model, Session } from "../../api";
import { clock, grouped, perMin, plainCode, shortSha, TIER_CLASS, TIER_NAME, took, usd } from "../../lib/format";
import { useConfig, useMe } from "../../lib/hooks";
import { rack } from "../../lib/wake";
import { Link } from "../../router";
import { Copy, Icon } from "../../ui/bits";

type Line = [label: string, value: string, note?: string];

/** How a session can end, in two words for the ticket and in a sentence beside it. A reason this build does not know has no sentence. */
const ENDED: Record<string, [short: string, sentence: string]> = {
  stopped: ["stopped by you", "You stopped the session."],
  time: ["time ran out", "The session ran its full time."],
  idle: ["idle", "The session ended on its own after a stretch with no request."],
  wake_failed: ["wake failed", "The wake failed, so the session never ran."],
  wake_timeout: ["wake timed out", "The wake ran out of time, so the session never ran."],
  funding_error: ["hold failed", "The balance hold did not go through, so the session never ran."],
  model_lost: ["model lost", "The model stopped and could not be woken again, so the session ended early."],
};
/** The sentence for why this session ended. `idleSeconds` is the gateway's idle limit, when it is known. */
export function endedBecause(s: Session, idleSeconds = 0): string {
  const why = s.receipt?.reason ?? "";
  if (why === "idle" && idleSeconds > 0) {
    const n = idleSeconds % 60 === 0 ? `${idleSeconds / 60} minute${idleSeconds === 60 ? "" : "s"}` : `${idleSeconds} seconds`;
    return `The session ended on its own after ${n} with no request.`;
  }
  return ENDED[why]?.[1] ?? "";
}

function facts(s: Session, model: Model | null) {
  const never = s.started_at == null;
  const wakeMs = s.receipt ? s.receipt.wake_s * 1000 : (s.stages.find((e) => e.stage === "ready")?.t_ms ?? 0);
  const seconds = s.receipt?.gpu_seconds ?? s.gpu_seconds;
  // Billed by the second: the minutes are GPU seconds over sixty, to two places, never rounded up to a whole minute.
  const minutes = (s.receipt?.minutes ?? (never ? 0 : seconds / 60)).toFixed(2);
  const total = s.receipt?.price_usd_micro ?? s.spent_usd_micro;
  const rate = model?.price_usd_micro_per_min ?? null;
  const why = s.receipt?.reason ?? "";
  // A paid session that reached ready costs at least one minute. When that is what was charged, the seconds stay
  // what was used and the minimum is said in so many words.
  const minimum = !s.free && !never && rate != null && rate > 0 && seconds < 60 && total >= rate;
  const lines: Line[] = [
    ["Wake", never ? (why === "stopped" || !why ? "cancelled" : "did not finish") : wakeMs < 1500 ? "already awake" : took(wakeMs), "not billed"],
    ["GPU-seconds", grouped(seconds)],
    ["Minutes billed", s.free ? "0.00" : minimum ? "1.00" : minutes, s.free ? `${minutes} min free` : minimum ? `one-minute minimum, ${minutes} used` : "by the second"],
    ["Rate", rate != null ? perMin(rate) : "", "per GPU minute"],
    ["Tokens in", grouped(s.receipt?.tokens_in ?? s.tokens_in), "counted"],
    ["Tokens out", grouped(s.receipt?.tokens_out ?? s.tokens_out), "counted"],
    // A reason newer than this build is printed as it came, in plain words, so the ticket never hides how it ended.
    ...(ENDED[why] ? [["Ended", ENDED[why][0]] as Line] : plainCode(why) ? [["Ended", plainCode(why)] as Line] : []),
  ];
  return { never, wakeMs, minutes, total, lines, why };
}
/** The last line of a ticket: why it ended, and what that cost. */
function foot(s: Session, f: ReturnType<typeof facts>, idleSeconds = 0): string {
  if (f.never) return f.why && f.why !== "stopped" ? `${endedBecause(s)} Nothing was charged.` : "Stopped before the model woke. Nothing was charged.";
  const because = endedBecause(s, idleSeconds);
  return `${because}${because ? " " : ""}${s.free ? "A free session: nothing was charged." : "Billed by the second, one-minute minimum once the model is awake. Never per token."}`;
}

export function receiptText(s: Session, model: Model | null): string {
  const f = facts(s, model);
  const pad = (k: string, v: string): string => `${k} ${".".repeat(Math.max(2, 34 - k.length - v.length))} ${v}`;
  return [
    "FREEWEIGHT · WEIGH TICKET",
    `No. ${s.id}`,
    "",
    model ? `${model.name}` : s.model_id,
    model ? `${model.hf_repo}@${shortSha(model.sha)}` : "",
    model ? `${TIER_NAME[model.tier]} · ${TIER_CLASS[model.tier]} · ${model.quant}` : "",
    "",
    ...f.lines.map(([k, v, n]) => pad(k, v) + (n ? `  (${n})` : "")),
    "",
    pad("TOTAL", usd(f.total)),
    foot(s, f),
  ]
    .filter((l, i, all) => l !== "" || all[i - 1] !== "")
    .join("\n");
}

/** The ticket itself. Sits on the inverse surface so it reads as a printed object in either theme. */
export function Ticket({ session: s, model }: { session: Session; model: Model | null }) {
  const f = facts(s, model);
  const idle = useConfig()?.idle_seconds ?? 0;
  const r = rack(s.stages, f.wakeMs);
  const segs = r.rows.filter((x) => x.stage !== "ready" && x.took != null && x.took > 0);
  const stamp = new Date(s.ends_at ?? s.now).toISOString().replace("T", " ").slice(0, 16);

  return (
    <article className="ticket" aria-label="Receipt">
      <header className="tk-h">
        <span className="tk-brand">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
            <rect x="2" y="2" width="20" height="5" rx="1" />
            <rect x="2" y="9.5" width="13" height="5" rx="1" />
            <rect x="2" y="17" width="6" height="5" rx="1" />
          </svg>
          Freeweight
        </span>
        <span>Weigh ticket</span>
      </header>
      <div className="tk-meta">
        <span>No. {s.id}</span>
        <span>{stamp} UTC</span>
      </div>

      <div className="tk-model">
        <b className={model ? `tw-${model.tier}` : undefined}>{model?.name ?? s.model_id}</b>
        {model && (
          <>
            <span>
              {model.hf_repo}@{shortSha(model.sha)}
            </span>
            <span>
              {TIER_NAME[model.tier]} · {TIER_CLASS[model.tier]} · {model.quant}
            </span>
          </>
        )}
      </div>

      {segs.length > 0 && (
        <div className="tk-wake" aria-hidden="true">
          <div className="tk-strip">
            {/* A stage can run twice, so the pieces go by position. */}
            {segs.map((x, i) => (
              <i key={i} style={{ flexGrow: x.took ?? 1 } as CSSProperties} />
            ))}
            {!f.never && s.gpu_seconds > 0 && <i className="on" style={{ flexGrow: s.gpu_seconds * 1000 } as CSSProperties} />}
          </div>
          <div className="tk-strip-l">
            <span>wake {clock(Math.round(f.wakeMs / 1000) * 1000)}</span>
            <span>{f.never ? "cancelled" : `awake ${clock(s.gpu_seconds * 1000)}`}</span>
          </div>
        </div>
      )}

      <dl className="tk-lines">
        {f.lines.map(([k, v, n]) => (
          <div key={k}>
            <dt>{k}</dt>
            <i aria-hidden="true" />
            <dd>
              {v}
              {n && <small>{n}</small>}
            </dd>
          </div>
        ))}
      </dl>

      <div className="tk-total">
        <span>Total</span>
        <b>{usd(f.total)}</b>
      </div>
      <p className="tk-foot">{foot(s, f, idle)}</p>
      <div className="tk-rule" aria-hidden="true" />
    </article>
  );
}

/** What to do next, under a ticket. */
export function TicketActions({ session: s, model }: { session: Session; model: Model | null }) {
  const me = useMe();
  return (
    <>
      <div className="row wrapf rcpt-act">
        <Link href={`/models/${s.model_id}`} className="btn primary">
          Wake it again
          <Icon name="arrow" />
        </Link>
        <Link href="/models" className="btn">
          Browse models
        </Link>
        <Copy text={receiptText(s, model)} label="Copy as text" />
      </div>
      {s.free && !me?.address && (
        <p className="small dim rcpt-next">
          That was today's free session. To keep going,{" "}
          <Link href="/account" className="link">
            sign in with a wallet
          </Link>{" "}
          and rent by the minute.
        </p>
      )}
    </>
  );
}

/** A finished session opened on its own: the ticket and one paragraph. */
export function ReceiptView({ session: s, model }: { session: Session; model: Model | null }) {
  const f = facts(s, model);
  const idle = useConfig()?.idle_seconds ?? 0;
  const name = model?.name ?? s.model_id;
  const cancelled = f.never && (!f.why || f.why === "stopped");
  return (
    <div className="wrap rcpt">
      <Ticket session={s} model={model} />
      <div className="rcpt-side">
        <p className="micro">Session ended</p>
        <h1 className="h2">{cancelled ? "Stopped before it woke." : f.never ? "The session never ran." : "The meter has stopped."}</h1>
        <p className="dim">
          {cancelled
            ? `The wake of ${name} was cancelled. A wake is never billed, so this ticket is empty.`
            : f.never
              ? `${endedBecause(s)} A wake is never billed, so this ticket is empty.`
              : `Your session on ${name} ran ${f.minutes} minutes. ${endedBecause(s, idle)} When the last session on a model ends it goes back to sleep, and an asleep model costs nothing.`}
        </p>
        <TicketActions session={s} model={model} />
      </div>
    </div>
  );
}
