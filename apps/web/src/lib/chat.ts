// Chat on a session: a streaming loop with stop and regenerate, and an optional tool loop that runs the
// toolkit over the gateway's MCP endpoint and feeds results back to the model.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ChatMessage, ToolCall, ToolSpec, Usage } from "../api/client";
import { loadConfig, toApiError } from "./hooks";

export type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string; state: "streaming" | "done" | "stopped" | "error"; error?: string; usage?: Usage; ms?: number }
  | { kind: "tool"; id: number; name: string; args: string; state: "running" | "ok" | "error"; ms?: number; result?: string };

/** Reasoning models wrap their scratch work in <think> tags. Split it from the answer; tolerate a half-streamed tag. */
export function splitThinking(text: string): { thinking: string; answer: string; open: boolean } {
  const m = /^\s*<think>([\s\S]*?)(<\/think>|$)/.exec(text);
  if (!m) return { thinking: "", answer: text, open: false };
  return { thinking: m[1]!.trim(), answer: text.slice(m[0].length).replace(/^\s+/, ""), open: m[2] !== "</think>" };
}

type McpTool = { name: string; description?: string; inputSchema?: unknown };
type McpResult = { content?: { type: string; text?: string }[]; isError?: boolean };

const MAX_ROUNDS = 6;

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

  const patch = useCallback((id: number, p: Partial<Item>) => {
    setItems((all) => all.map((it) => (it.id === id ? ({ ...it, ...p } as Item) : it)));
  }, []);

  const run = useCallback(async () => {
    const ac = new AbortController();
    ctl.current = ac;
    setBusy(true);
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const id = seq.current++;
        const t0 = performance.now();
        setItems((all) => [...all, { kind: "assistant", id, text: "", state: "streaming" }]);
        let text = "";
        let usage: Usage | undefined;
        const calls: ToolCall[] = [];
        try {
          const tools = toolsOn && specs.current?.length ? specs.current : undefined;
          const messages = tools ? withToolNote(msgs.current, (await loadConfig()).tool_system_note) : msgs.current;
          for await (const d of api.chat({ model: modelId, messages, tools }, { sessionId, signal: ac.signal })) {
            if (d.content) {
              text += d.content;
              patch(id, { text });
            }
            for (const tc of d.tool_calls ?? []) {
              const c = (calls[tc.index] ??= { id: tc.id ?? `call_${tc.index}`, type: "function", function: { name: "", arguments: "" } });
              if (tc.id) c.id = tc.id;
              if (tc.function?.name) c.function.name += tc.function.name;
              if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
            }
            if (d.usage) usage = d.usage;
          }
        } catch (e) {
          if (ac.signal.aborted) {
            if (text) msgs.current.push({ role: "assistant", content: text });
            patch(id, { state: "stopped" });
            return;
          }
          const err = toApiError(e);
          patch(id, { state: "error", error: err.code === "too_many_requests" ? "Wait for the current answers to finish." : err.message });
          return;
        }
        const real = calls.filter((c) => c?.function.name);
        if (!real.length) {
          msgs.current.push({ role: "assistant", content: text });
          patch(id, { state: "done", usage, ms: performance.now() - t0 });
          return;
        }
        msgs.current.push({ role: "assistant", content: text || null, tool_calls: real });
        if (text) patch(id, { state: "done", usage });
        else setItems((all) => all.filter((it) => it.id !== id));

        const toolItems = real.map((c) => ({ kind: "tool" as const, id: seq.current++, name: c.function.name, args: c.function.arguments, state: "running" as const }));
        setItems((all) => [...all, ...toolItems]);
        await Promise.all(
          real.map(async (c, i) => {
            const tid = toolItems[i]!.id;
            const s0 = performance.now();
            let out: string;
            let ok = true;
            try {
              let args: unknown = {};
              try {
                args = c.function.arguments ? JSON.parse(c.function.arguments) : {};
              } catch {
                /* the model wrote bad JSON; the tool will say so */
              }
              const r = await api.mcp<McpResult>("tools/call", { name: c.function.name, arguments: args }, ac.signal);
              out = (r.content ?? []).map((p) => p.text ?? "").join("\n") || "{}";
              ok = !r.isError;
            } catch (e) {
              out = JSON.stringify({ error: toApiError(e).message });
              ok = false;
            }
            patch(tid, { state: ok ? "ok" : "error", ms: performance.now() - s0, result: out });
            msgs.current.push({ role: "tool", tool_call_id: c.id, content: out });
          }),
        );
        if (ac.signal.aborted) return;
      }
    } finally {
      setBusy(false);
      ctl.current = null;
    }
  }, [modelId, sessionId, toolsOn, patch]);

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
