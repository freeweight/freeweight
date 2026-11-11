// Chat on a session: a streaming loop with stop and regenerate, and an optional tool loop that runs the
// toolkit over the gateway's MCP endpoint and feeds results back to the model.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatDelta, ChatMessage, ToolCall, ToolSpec, Usage } from "../api/client";
import { loadConfig, toApiError } from "./hooks";

export type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; thinking?: string; thinkMs?: number; state: "streaming" | "done" | "stopped" | "error"; error?: string; usage?: Usage; ms?: number }
  | { kind: "tool"; id: number; name: string; args: string; state: "running" | "ok" | "error" | "stopped"; ms?: number; result?: string };

/** Reasoning models wrap their scratch work in <think> tags. Split it from the answer; tolerate a half-streamed tag. */
export function splitThinking(text: string): { thinking: string; answer: string; open: boolean } {
  const m = /^\s*<think>([\s\S]*?)(<\/think>|$)/.exec(text);
  if (!m) return { thinking: "", answer: text, open: false };
  return { thinking: m[1]!.trim(), answer: text.slice(m[0].length).replace(/^\s+/, ""), open: m[2] !== "</think>" };
}

type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpResult = { content?: { type: string; text?: string }[]; isError?: boolean };

/** Rounds of model reply in one turn. The last one is asked without tools, so a turn always closes with words. */
export const MAX_ROUNDS = 6;

/**
 * What goes to the model when tools are on: the conversation with the gateway's note about tool results in front.
 * The note is the gateway's text (`tool_system_note` in its config), so there is one wording of it, and it is never
 * part of the transcript the visitor sees.
 */
export function withToolNote(messages: ChatMessage[], note: string | null | undefined): ChatMessage[] {
  if (!note) return messages;
  const first = messages[0];
  if (first?.role === "system") return first.content.includes(note) ? messages : [{ role: "system", content: `${note}\n\n${first.content}` }, ...messages.slice(1)];
  return [{ role: "system", content: note }, ...messages];
}

// ---------- one streamed reply ----------

/** What a streamed reply adds up to so far. */
export type Reply = { text: string; thinking: string; calls: ToolCall[]; usage?: Usage };

export function newReply(): Reply {
  return { text: "", thinking: "", calls: [] };
}

/**
 * Fold one delta into the reply. Thinking arrives in its own field and stays apart from the answer. Engines put
 * blank lines between the thinking and the answer, and before a tool call: the answer starts at its first
 * character that is not white space.
 */
export function addDelta(r: Reply, d: ChatDelta): void {
  if (d.reasoning) r.thinking += d.reasoning;
  if (d.content) r.text += r.text ? d.content : d.content.replace(/^\s+/, "");
  for (const tc of d.tool_calls ?? []) {
    // The arguments of one call come in pieces that share an index. A stream with one call may leave the index out.
    const at = tc.index ?? 0;
    const c = (r.calls[at] ??= { id: tc.id ?? `call_${at}`, type: "function", function: { name: "", arguments: "" } });
    if (tc.id) c.id = tc.id;
    if (tc.function?.name) c.function.name += tc.function.name;
    if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
  }
  if (d.usage) r.usage = d.usage;
}

/** A call's arguments as the tool gets them. Null when what the model wrote is not a JSON object. */
export function parseArgs(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ---------- the turn loop ----------

export type ToolOutcome = { text: string; ok: boolean };

/** Where the loop shows what happens. `stream` may be shown late (it is a running text), the others at once. */
export type Sink = {
  add: (items: Item[]) => void;
  stream: (id: number, p: { text: string; thinking: string; thinkMs?: number }) => void;
  patch: (id: number, p: Partial<Item>) => void;
  remove: (id: number) => void;
};

export type Turn = {
  /** The conversation so far. The loop appends to it. */
  messages: ChatMessage[];
  /** Tool definitions when tools are on. */
  tools?: ToolSpec[];
  note?: string | null;
  signal: AbortSignal;
  nextId: () => number;
  sink: Sink;
  chat: (messages: ChatMessage[], tools: ToolSpec[] | undefined, signal: AbortSignal) => AsyncIterable<ChatDelta>;
  callTool: (name: string, args: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutcome>;
  /** How long to wait before the one quiet retry when the gateway says it is busy with other answers. */
  busyWaitMs?: number;
};

const BAD_ARGS = JSON.stringify({ error: "The arguments were not valid JSON, so the tool did not run." });
const STOPPED = JSON.stringify({ error: "Stopped before the tool answered." });

/** Run one turn: the model answers, and while it asks for tools they run and it answers again. */
export async function converse(t: Turn): Promise<void> {
  const { messages, signal, sink } = t;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const id = t.nextId();
    const t0 = performance.now();
    sink.add([{ kind: "assistant", id, text: "", state: "streaming" }]);
    // The last round goes out without tools: the model has to answer with what it has.
    const tools = t.tools?.length && round < MAX_ROUNDS - 1 ? t.tools : undefined;
    const sent = t.tools?.length ? withToolNote(messages, t.note) : messages;
    let r = newReply();
    // How long the model has been thinking: from the request to the first word of its answer. A round that ends
    // in tool calls with no answer was thinking until its end.
    let thinkMs: number | undefined;
    let answering = false;
    for (let attempt = 0; ; attempt++) {
      r = newReply();
      thinkMs = undefined;
      answering = false;
      let heard = false;
      try {
        for await (const d of t.chat(sent, tools, signal)) {
          heard = true;
          addDelta(r, d);
          if (!answering) {
            const s = splitThinking(r.text);
            answering = Boolean(s.answer.trim());
            if (!answering && (r.thinking || s.thinking)) thinkMs = performance.now() - t0;
          }
          sink.stream(id, { text: r.text, thinking: r.thinking, thinkMs });
        }
        break;
      } catch (e) {
        if (signal.aborted) {
          if (r.text) messages.push({ role: "assistant", content: r.text });
          sink.patch(id, { text: r.text, thinking: r.thinking, thinkMs, state: "stopped" });
          return;
        }
        const err = toApiError(e);
        if (err.code === "too_many_requests" && !heard && attempt === 0) {
          await new Promise((res) => setTimeout(res, t.busyWaitMs ?? 1000));
          if (!signal.aborted) continue;
          sink.patch(id, { state: "stopped" });
          return;
        }
        sink.patch(id, { text: r.text, thinking: r.thinking, thinkMs, state: "error", error: err.code === "too_many_requests" ? "Wait for the current answers to finish." : err.message });
        return;
      }
    }
    const calls = r.calls.filter((c) => c?.function.name);
    if (!calls.length || !tools) {
      messages.push({ role: "assistant", content: r.text });
      sink.patch(id, { text: r.text, thinking: r.thinking, thinkMs, state: "done", usage: r.usage, ms: performance.now() - t0 });
      return;
    }

    const parsed = calls.map((c) => parseArgs(c.function.arguments));
    // The history carries arguments the engine can read back: what the model wrote when it parses, else an empty object.
    const kept = calls.map((c, i) => ({ ...c, function: { name: c.function.name, arguments: parsed[i] && c.function.arguments.trim() ? c.function.arguments : "{}" } }));
    messages.push({ role: "assistant", content: r.text || null, tool_calls: kept });
    if (r.text || r.thinking) sink.patch(id, { text: r.text, thinking: r.thinking, thinkMs, state: "done", usage: r.usage });
    else sink.remove(id);

    const rows = calls.map((c) => ({ kind: "tool" as const, id: t.nextId(), name: c.function.name, args: c.function.arguments, state: "running" as const }));
    sink.add(rows);
    const results = await Promise.all(
      calls.map(async (c, i): Promise<string> => {
        const row = rows[i]!.id;
        const args = parsed[i];
        if (!args) {
          sink.patch(row, { state: "error", result: BAD_ARGS });
          return BAD_ARGS;
        }
        const s0 = performance.now();
        try {
          const out = await t.callTool(c.function.name, args, signal);
          sink.patch(row, { state: out.ok ? "ok" : "error", ms: performance.now() - s0, result: out.text });
          return out.text;
        } catch (e) {
          if (signal.aborted) {
            sink.patch(row, { state: "stopped" });
            return STOPPED;
          }
          const out = JSON.stringify({ error: toApiError(e).message });
          sink.patch(row, { state: "error", ms: performance.now() - s0, result: out });
          return out;
        }
      }),
    );
    // Every call gets its answer in the history, in the order the model asked, so the next request is well formed.
    calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i]! }));
    if (signal.aborted) return;
  }
}

/** Collects running updates and hands them on once per frame, however many arrive in between. */
export function batcher<T extends object>(schedule: (run: () => void) => void, apply: (updates: Map<number, T>) => void) {
  let pending = new Map<number, T>();
  let queued = false;
  const flush = (): void => {
    queued = false;
    if (!pending.size) return;
    const p = pending;
    pending = new Map();
    apply(p);
  };
  return {
    put(id: number, v: T): void {
      pending.set(id, { ...pending.get(id), ...v });
      if (queued) return;
      queued = true;
      schedule(flush);
    },
    /** Drop what is waiting for one id: a later, complete update replaces it. */
    drop(id: number): void {
      pending.delete(id);
    },
    flush,
  };
}

export function useChat(sessionId: string, modelId: string, live: boolean) {
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [toolsOn, setToolsOn] = useState(false);
  const [toolsState, setToolsState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const msgs = useRef<ChatMessage[]>([]);
  const specs = useRef<ToolSpec[] | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const seq = useRef(1);

  useEffect(() => () => ctl.current?.abort(), []);

  const toggleTools = useCallback((on: boolean) => {
    setToolsOn(on);
    if (!on || specs.current) return;
    setToolsState("loading");
    api.mcp<{ tools: McpTool[] }>("tools/list", {}).then(
      (r) => {
        specs.current = r.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} } } }));
        setToolsState("ready");
      },
      () => {
        setToolsState("error");
        setToolsOn(false);
      },
    );
  }, []);

  // A reply can arrive as hundreds of small pieces. The page draws the running text once per frame, not once per piece.
  const frames = useRef<ReturnType<typeof batcher<Partial<Item>>> | null>(null);
  frames.current ??= batcher<Partial<Item>>(
    (go) => requestAnimationFrame(go),
    (updates) => setItems((all) => all.map((it) => (updates.has(it.id) ? ({ ...it, ...updates.get(it.id) } as Item) : it))),
  );

  const run = useCallback(async () => {
    const ac = new AbortController();
    ctl.current = ac;
    setBusy(true);
    const shown = frames.current!;
    try {
      const tools = toolsOn && specs.current?.length ? specs.current : undefined;
      await converse({
        messages: msgs.current,
        tools,
        note: tools ? (await loadConfig()).tool_system_note : null,
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
        chat: (messages, t, signal) => api.chat({ model: modelId, messages, tools: t }, { sessionId, signal }),
        callTool: async (name, args, signal) => {
          const r = await api.mcp<McpResult>("tools/call", { name, arguments: args }, signal);
          return { text: (r.content ?? []).map((p) => p.text ?? "").join("\n") || "{}", ok: !r.isError };
        },
      });
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  }, [modelId, sessionId, toolsOn]);

  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t || busy || !live) return;
      msgs.current.push({ role: "user", content: t });
      setItems((all) => [...all, { kind: "user", id: seq.current++, text: t }]);
      void run();
    },
    [busy, live, run],
  );

  const stop = useCallback(() => ctl.current?.abort(), []);

  const regenerate = useCallback(() => {
    if (busy || !live) return;
    const lastUser = msgs.current.map((m) => m.role).lastIndexOf("user");
    if (lastUser < 0) return;
    msgs.current = msgs.current.slice(0, lastUser + 1);
    setItems((all) => {
      const i = all.map((it) => it.kind).lastIndexOf("user");
      return all.slice(0, i + 1);
    });
    void run();
  }, [busy, live, run]);

  return { items, busy, send, stop, regenerate, toolsOn, toggleTools, toolsState };
}
