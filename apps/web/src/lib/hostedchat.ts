// Chat on the always-awake model. There is no session and no clock: each message is one request, the gateway runs
// the tool loop and streams what happens, and the page keeps the conversation and adds up what it used.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api } from "../api";
import type { ChatMessage, HostedEvent } from "../api/client";
import { batcher, type Item, type Sink } from "./chat";
import { refreshMe, toApiError, useMe } from "./hooks";
import { takeOpening } from "./hosted";
import { turnstileToken } from "./turnstile";
import type { ApiError } from "../api";

/** What a conversation has used so far. Free messages count their tokens and cost nothing. */
export type Tally = { answers: number; tokens_in: number; tokens_out: number; cost_usd_micro: number };
export const NO_TALLY: Tally = { answers: 0, tokens_in: 0, tokens_out: 0, cost_usd_micro: 0 };

export type Started = { free: boolean; free_left: number | null; tools: boolean };

/** How one turn ended. `heard` says whether the gateway let the turn in: a refusal comes before anything else. */
export type TurnEnd = { text: string; started: Started | null; heard: boolean; stopped: boolean; error: ApiError | null };

export type Follow = {
  signal: AbortSignal;
  nextId: () => number;
  sink: Sink;
  onStart?: (s: Started) => void;
  onUsage?: (u: { tokens_in: number; tokens_out: number; cost_usd_micro: number }) => void;
};

/**
 * Show one turn as it streams: the model's words, each tool call and its short result, then the next answer.
 * A refusal before anything was said leaves no trace in the transcript: the caller decides how to say it.
 */
export async function follow(events: AsyncIterable<HostedEvent>, f: Follow): Promise<TurnEnd> {
  const { sink } = f;
  type Open = { id: number; text: string; thinking: string; thinkMs?: number; t0: number; usage?: { prompt_tokens: number; completion_tokens: number } };
  let cur: Open | null = null;
  const said: string[] = [];
  const running = new Map<string, { row: number; t0: number }>();
  let started: Started | null = null;
  let heard = false;

  const open = (): Open => {
    const o: Open = { id: f.nextId(), text: "", thinking: "", t0: performance.now() };
    sink.add([{ kind: "assistant", id: o.id, text: "", state: "streaming" }]);
    return o;
  };
  /** Close the answer being written. One that said nothing (it only called tools) is taken away. */
  const close = (state: "done" | "stopped" | "error", error?: string): void => {
    const o = cur;
    cur = null;
    if (!o) return;
    if (o.text) said.push(o.text);
    if (!o.text && !o.thinking && state !== "error") return sink.remove(o.id);
    sink.patch(o.id, { text: o.text, thinking: o.thinking, thinkMs: o.thinkMs, state, error, usage: o.usage, ms: performance.now() - o.t0 });
  };
  const haltTools = (): void => {
    for (const r of running.values()) sink.patch(r.row, { state: "stopped" });
    running.clear();
  };

  cur = open();
  try {
    for await (const e of events) {
      heard = true;
      if (e.event === "start") {
        started = { free: e.free, free_left: e.free_left, tools: e.tools };
        f.onStart?.(started);
      } else if (e.event === "delta" || e.event === "reasoning") {
        cur ??= open();
        if (e.event === "delta") cur.text += e.text;
        else {
          cur.thinking += e.text;
          if (!cur.text) cur.thinkMs = performance.now() - cur.t0;
        }
        sink.stream(cur.id, { text: cur.text, thinking: cur.thinking, thinkMs: cur.thinkMs });
      } else if (e.event === "usage") {
        if (cur) cur.usage = { prompt_tokens: e.tokens_in, completion_tokens: e.tokens_out };
        f.onUsage?.(e);
      } else if (e.event === "tool_call") {
        close("done");
        const row = f.nextId();
        running.set(e.id, { row, t0: performance.now() });
        sink.add([{ kind: "tool", id: row, name: e.name, args: e.arguments, state: "running" }]);
      } else if (e.event === "tool_result") {
        const r = running.get(e.id);
        if (!r) continue;
        running.delete(e.id);
        // The page gets the tool's short summary, not its full answer: that went to the model.
        sink.patch(r.row, { state: e.ok ? "ok" : "error", ms: performance.now() - r.t0, result: JSON.stringify({ summary: e.summary }) });
      } else if (e.event === "done") {
        close("done");
      }
    }
    close("done");
    return { text: said.join("\n\n"), started, heard, stopped: false, error: null };
  } catch (e) {
    haltTools();
    if (f.signal.aborted) {
      close("stopped");
      return { text: said.join("\n\n"), started, heard, stopped: true, error: null };
    }
    const error = toApiError(e);
    if (heard) {
      // A turn that broke between answers still says so, in a line of its own.
      cur ??= open();
      close("error", error.message);
    } else {
      // Nothing was let in: the empty answer goes away and the caller says why.
      if (cur) sink.remove(cur.id);
      cur = null;
    }
    return { text: said.join("\n\n"), started, heard, stopped: false, error };
  }
}

/**
 * Ask, and when the gateway wants the human check first, run it and ask once more. `first` is a token the caller
 * already has. A refusal can only be the first thing a turn says, so nothing is ever shown twice.
 */
export async function* withCheck(ask: (token?: string) => AsyncIterable<HostedEvent>, check: () => Promise<string | undefined>, first?: string): AsyncGenerator<HostedEvent> {
  const it = ask(first)[Symbol.asyncIterator]();
  let head: IteratorResult<HostedEvent>;
  try {
    head = await it.next();
  } catch (e) {
    if (toApiError(e).code !== "turnstile_required") throw e;
    const token = await check();
    if (!token) throw e;
    yield* ask(token);
    return;
  }
  while (!head.done) {
    yield head.value;
    head = await it.next();
  }
}

/** Refusals that are no fault: the way out is to wait, sign in, top up or write less. They are said calmly. */
export const CALM = new Set(["free_used", "free_budget_spent", "hosted_busy", "insufficient_balance", "message_too_long", "rate_limited", "too_many_in_flight"]);

export type Refusal = { code: string; message: string };

export function useHostedChat(checkHost: RefObject<HTMLElement | null>) {
  const me = useMe();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [toolsOn, setToolsOn] = useState(false);
  const [tally, setTally] = useState<Tally>(NO_TALLY);
  const [last, setLast] = useState<Started | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  /** A message the gateway did not take goes back to the box it was written in. */
  const [draft, setDraft] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const msgs = useRef<ChatMessage[]>([]);
  const ctl = useRef<AbortController | null>(null);
  const seq = useRef(1);
  const meNow = useRef(me);
  meNow.current = me;

  useEffect(() => () => ctl.current?.abort(), []);

  const frames = useRef<ReturnType<typeof batcher<Partial<Item>>> | null>(null);
  frames.current ??= batcher<Partial<Item>>(
    (go) => requestAnimationFrame(go),
    (updates) => setItems((all) => all.map((it) => (updates.has(it.id) ? ({ ...it, ...updates.get(it.id) } as Item) : it))),
  );

  const run = useCallback(
    async (userItem: number | null) => {
      const ac = new AbortController();
      ctl.current = ac;
      setBusy(true);
      setRefusal(null);
      const shown = frames.current!;
      const check = async (): Promise<string | undefined> => {
        const cfg = await api.config();
        return cfg.turnstile_sitekey && checkHost.current ? turnstileToken(cfg.turnstile_sitekey, checkHost.current) : undefined;
      };
      const ask = (token?: string) => api.hostedChat({ messages: msgs.current, ...(toolsOn ? { tools: true } : {}), ...(token ? { turnstile_token: token } : {}) }, ac.signal);
      try {
        // A visitor's first free message of the day runs the human check. A wallet may pay instead, so it is
        // only checked when the gateway asks.
        const who = meNow.current;
        const first = who?.hosted?.check_needed && !who.address ? await check().catch(() => undefined) : undefined;
        const end = await follow(withCheck(ask, check, first), {
          signal: ac.signal,
          nextId: () => seq.current++,
          sink: {
            add: (more) => setItems((all) => [...all, ...more]),
            stream: (id, p) => shown.put(id, p),
            patch: (id, p) => {
              shown.drop(id);
              setItems((all) => all.map((it) => (it.id === id ? ({ ...it, ...p } as Item) : it)));
            },
            remove: (id) => {
              shown.drop(id);
              setItems((all) => all.filter((it) => it.id !== id));
            },
          },
          onStart: setLast,
          onUsage: (u) => setTally((t) => ({ answers: t.answers + 1, tokens_in: t.tokens_in + u.tokens_in, tokens_out: t.tokens_out + u.tokens_out, cost_usd_micro: t.cost_usd_micro + u.cost_usd_micro })),
        });
        if (end.text) msgs.current.push({ role: "assistant", content: end.text });
        if (end.error && !end.heard) {
          if (CALM.has(end.error.code) && userItem != null) {
            // The message was not taken. It leaves the transcript and returns to the box, with the reason beside it.
            const back = msgs.current.pop();
            setItems((all) => all.filter((it) => it.id !== userItem));
            setDraft((d) => ({ text: back?.role === "user" ? back.content : "", n: d.n + 1 }));
            setRefusal({ code: end.error.code, message: end.error.message });
          } else if (CALM.has(end.error.code)) {
            setRefusal({ code: end.error.code, message: end.error.message });
          } else {
            setItems((all) => [...all, { kind: "assistant", id: seq.current++, text: "", state: "error", error: end.error!.message }]);
          }
        }
      } finally {
        setBusy(false);
        ctl.current = null;
        // The balance and the free messages left have moved.
        void refreshMe().catch(() => undefined);
      }
    },
    [checkHost, toolsOn],
  );

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || busy) return;
      const id = seq.current++;
      msgs.current.push({ role: "user", content: t });
      setItems((all) => [...all, { kind: "user", id, text: t }]);
      void run(id);
    },
    [busy, run],
  );

  // A message typed on the front page arrives with the visitor and is sent as the room opens.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const text = takeOpening();
    if (text) send(text);
  }, [send]);

  const stop = useCallback(() => ctl.current?.abort(), []);

  const regenerate = useCallback(() => {
    if (busy) return;
    const lastUser = msgs.current.map((m) => m.role).lastIndexOf("user");
    if (lastUser < 0) return;
    msgs.current = msgs.current.slice(0, lastUser + 1);
    setItems((all) => {
      const i = all.map((it) => it.kind).lastIndexOf("user");
      return all.slice(0, i + 1);
    });
    void run(null);
  }, [busy, run]);

  const toggleTools = useCallback((on: boolean) => setToolsOn(on), []);
  const toolsState: "idle" | "loading" | "ready" | "error" = toolsOn ? "ready" : "idle";

  return { items, busy, send, stop, regenerate, toolsOn, toggleTools, toolsState, tally, last, refusal, draft };
}
