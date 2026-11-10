// One address for a session's whole life: the wake, the room, the receipt.

import { useEffect, useRef, useState } from "react";
import { useLive, useTitle } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Link } from "../router";
import { ReceiptView } from "./session/Receipt";
import { Room } from "./session/Room";
import { Wake, WakeSkeleton } from "./session/Wake";
import "./session.css";

/** How long the finished wake stays on screen before the room opens (real ms). Long enough to read the time. */
const READY_HOLD_MS = 1600;
const JOIN_HOLD_MS = 450;

export default function SessionView({ params }: { params: Record<string, string> }) {
  const id = params.id ?? "";
  const live = useSession(id);
  const { models } = useLive();
  const s = live.session;
  const model = s ? (models?.find((m) => m.id === s.model_id) ?? null) : null;

  // If this page watched the wake, hold on the finished rack for a moment. If it opened on a running session, go straight in.
  const sawWake = useRef(false);
  const [entered, setEntered] = useState(false);
  const state = s?.state;
  const instant = (s?.stages.length ?? 0) <= 1;
  // The machine can go away under a running session. The gateway wakes the model again with the clock stopped
  // (`paused`), and that is still the room: the conversation must not be thrown away for a second wake screen.
  const rewake = state === "waking" && (s?.paused === true || s?.started_at != null);
  useEffect(() => {
    if (rewake) return setEntered(true);
    if (state === "waking") sawWake.current = true;
    if (state !== "active" || entered) return;
    if (!sawWake.current) return setEntered(true);
    const t = setTimeout(() => setEntered(true), instant ? JOIN_HOLD_MS : READY_HOLD_MS);
    return () => clearTimeout(t);
  }, [state, entered, instant, rewake]);

  const name = model?.name ?? "";
  useTitle(!s ? "Session" : s.state === "waking" ? `Waking ${name}` : s.state === "active" ? name : s.state === "failed" ? "Wake failed" : "Receipt");

  if (live.error && !s) {
    const missing = live.error.status === 404;
    return (
      <div className="wrap page gone">
        <p className="micro">{missing ? "No session" : "Not reachable"}</p>
        <h1 className="h2">{missing ? "There is no session at this address." : "This session did not load."}</h1>
        <p className="dim">
          {missing
            ? "It may have ended some time ago, or the address is wrong. A running session keeps its address until it ends."
            : `${live.error.message} The page keeps trying while it is open.`}
        </p>
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
  if (!s) return <WakeSkeleton />;
  if (entered && (s.state === "active" || s.state === "ended" || rewake)) return <Room live={live} session={s} model={model} />;
  if (s.state === "ended") return <ReceiptView session={s} model={model} />;
  return <Wake live={live} session={s} model={model} />;
}
