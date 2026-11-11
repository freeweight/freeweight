import { describe, expect, it } from "vitest";
import { ApiError, type ChatDelta, type ChatMessage, type ToolSpec } from "../src/api/client";
import { addDelta, batcher, converse, MAX_ROUNDS, newReply, parseArgs, type Item, type Turn } from "../src/lib/chat";

const TOOLS: ToolSpec[] = [{ type: "function", function: { name: "token_overview", description: "Facts about a token.", parameters: { type: "object" } } }];
const asks = (args: string[], id = "chatcmpl-tool-1"): ChatDelta[] => [
  { content: "\n\n" },
  { tool_calls: [{ index: 0, id, function: { name: "token_overview", arguments: "" } }] },
  ...args.map((a) => ({ tool_calls: [{ index: 0, function: { arguments: a } }] })),
];

type Step = ChatDelta | Error;
function stage(replies: (Step[] | Error)[], opts: { tools?: boolean; signal?: AbortSignal; callTool?: Turn["callTool"] } = {}) {
  const items: Item[] = [];
  const sent: { messages: ChatMessage[]; tools: ToolSpec[] | undefined }[] = [];
  const called: { name: string; args: Record<string, unknown> }[] = [];
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  let id = 0;
  let n = 0;
  const patch = (at: number, p: object): void => {
    const i = items.findIndex((it) => it.id === at);
    if (i >= 0) items[i] = { ...items[i]!, ...p } as Item;
  };
  const turn: Turn = {
    messages,
    tools: opts.tools === false ? undefined : TOOLS,
    signal: opts.signal ?? new AbortController().signal,
    nextId: () => ++id,
    busyWaitMs: 1,
    sink: {
      add: (more) => void items.push(...more),
      stream: patch,
      patch,
      remove: (at) => void items.splice(items.findIndex((it) => it.id === at), 1),
    },
    chat: async function* (m, tools) {
      sent.push({ messages: structuredClone(m), tools });
      const r = replies[Math.min(n++, replies.length - 1)]!;
      if (r instanceof Error) throw r;
      for (const d of r) {
        if (d instanceof Error) throw d;
        yield d;
      }
    },
    callTool:
      opts.callTool ??
      (async (name, args) => {
        called.push({ name, args });
        return { text: JSON.stringify({ symbol: "TEST" }), ok: true };
      }),
  };
  return { turn, items, sent, called, messages };
}

describe("one reply, delta by delta", () => {
  it("keeps the thinking apart and starts the answer at its first visible character", () => {
    const r = newReply();
    for (const d of [{ reasoning: "The user wants a price. " }, { reasoning: "I should call the tool." }, { content: "\n\n" }, { content: " Here is " }, { content: "the answer.\n" }]) addDelta(r, d);
    expect(r.thinking).toBe("The user wants a price. I should call the tool.");
    expect(r.text).toBe("Here is the answer.\n");
  });

  it("joins the pieces of each call's arguments, by index", () => {
    const r = newReply();
    addDelta(r, { tool_calls: [{ index: 0, id: "a", function: { name: "token_overview", arguments: "" } }] });
    addDelta(r, { tool_calls: [{ index: 1, id: "b", function: { name: "safety_check", arguments: '{"addr' } }] });
    addDelta(r, { tool_calls: [{ index: 0, function: { arguments: '{"address":' } }] });
    addDelta(r, { tool_calls: [{ index: 1, function: { arguments: 'ess":"0xdef"}' } }] });
    addDelta(r, { tool_calls: [{ index: 0, function: { arguments: '"0xabc"}' } }] });
    expect(r.calls.map((c) => [c.id, c.function.name, c.function.arguments])).toEqual([
      ["a", "token_overview", '{"address":"0xabc"}'],
      ["b", "safety_check", '{"address":"0xdef"}'],
    ]);
  });

  it("takes a call without an index as the first", () => {
    const r = newReply();
    addDelta(r, { tool_calls: [{ id: "a", function: { name: "token_overview", arguments: "{" } }] });
    addDelta(r, { tool_calls: [{ function: { arguments: "}" } }] });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]!.function.arguments).toBe("{}");
  });

  it("reads arguments only when they are a JSON object", () => {
    expect(parseArgs("")).toEqual({});
    expect(parseArgs(' {"a":1} ')).toEqual({ a: 1 });
    expect(parseArgs('{"a":')).toBeNull();
    expect(parseArgs("[1]")).toBeNull();
    expect(parseArgs('"text"')).toBeNull();
  });
});

describe("a turn with tools", () => {
  it("drops a blank turn before tool calls and sends it back with no content", async () => {
    const s = stage([asks(['{"address":', '"0xabc"}']), [{ content: "Done." }]]);
    await converse(s.turn);
    expect(s.called).toEqual([{ name: "token_overview", args: { address: "0xabc" } }]);
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1]!.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "chatcmpl-tool-1", type: "function", function: { name: "token_overview", arguments: '{"address":"0xabc"}' } }],
    });
    expect(s.sent[1]!.messages[2]).toMatchObject({ role: "tool", tool_call_id: "chatcmpl-tool-1" });
    expect(s.items.map((it) => it.kind)).toEqual(["tool", "assistant"]);
    expect(s.items[0]).toMatchObject({ state: "ok" });
    expect(s.items[1]).toMatchObject({ text: "Done.", state: "done" });
  });

  it("keeps a turn that has thinking or words before its tool calls", async () => {
    const s = stage([[{ reasoning: "A price is asked." }, ...asks(["{}"])], [{ content: "Done." }]]);
    await converse(s.turn);
    expect(s.items.map((it) => it.kind)).toEqual(["assistant", "tool", "assistant"]);
    expect(s.items[0]).toMatchObject({ text: "", thinking: "A price is asked.", state: "done" });
  });

  it("times the thinking of a reply, and only of one that thought", async () => {
    const s = stage([[{ reasoning: "A price is asked." }, ...asks(["{}"])], [{ content: "Done." }]]);
    await converse(s.turn);
    expect((s.items[0] as { thinkMs?: number }).thinkMs).toBeGreaterThanOrEqual(0);
    expect((s.items[2] as { thinkMs?: number }).thinkMs).toBeUndefined();
  });

  it("stops the thinking time at the first word of the answer", async () => {
    const seen: (number | undefined)[] = [];
    const s = stage([[{ content: "<think>Short question." }, { content: " Short answer.</think>" }, { content: "\n\nYes." }, { content: " It is." }]], { tools: false });
    const stream = s.turn.sink.stream;
    s.turn.sink.stream = (id, p) => (seen.push(p.thinkMs), stream(id, p));
    await converse(s.turn);
    expect(seen).toHaveLength(4);
    expect(seen[0]).toBeTypeOf("number");
    expect(seen[1]).toBeGreaterThanOrEqual(seen[0]!);
    expect(seen[2]).toBe(seen[1]);
    expect(seen[3]).toBe(seen[1]);
    expect(s.items[0]).toMatchObject({ state: "done", thinkMs: seen[1] });
  });

  it("never runs a tool on arguments it cannot read", async () => {
    const s = stage([asks(['{"address": 0xabc']), [{ content: "I could not look that up." }]]);
    await converse(s.turn);
    expect(s.called).toEqual([]);
    expect(s.items[0]).toMatchObject({ kind: "tool", state: "error" });
    const again = s.sent[1]!.messages;
    expect(again[1]).toMatchObject({ role: "assistant", tool_calls: [{ function: { name: "token_overview", arguments: "{}" } }] });
    expect(again[2]).toMatchObject({ role: "tool", tool_call_id: "chatcmpl-tool-1" });
    expect(String((again[2] as { content: unknown }).content)).toContain("not valid JSON");
  });

  it("sends the last round without tools, so the turn ends in an answer", async () => {
    const s = stage([asks(["{}"])]);
    await converse(s.turn);
    expect(s.sent).toHaveLength(MAX_ROUNDS);
    expect(s.sent.slice(0, -1).every((r) => r.tools === TOOLS)).toBe(true);
    expect(s.sent.at(-1)!.tools).toBeUndefined();
    expect(s.called).toHaveLength(MAX_ROUNDS - 1);
    expect(s.items.at(-1)).toMatchObject({ kind: "assistant", state: "done" });
  });

  it("marks the tool rows stopped when the turn is stopped, and still answers each call in the history", async () => {
    const ctl = new AbortController();
    const s = stage([asks(["{}"])], {
      signal: ctl.signal,
      callTool: (_name, _args, signal) => new Promise((_, no) => signal.addEventListener("abort", () => no(new Error("stopped")))),
    });
    const run = converse(s.turn);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    await run;
    expect(s.items.at(-1)).toMatchObject({ kind: "tool", state: "stopped" });
    expect(s.sent).toHaveLength(1);
    expect(s.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "chatcmpl-tool-1" });
  });
});

describe("a turn that goes wrong", () => {
  it("waits once, quietly, when the gateway is busy", async () => {
    const s = stage([new ApiError("too_many_requests", "Busy.", 429), [{ content: "Hello." }]], { tools: false });
    await converse(s.turn);
    expect(s.sent).toHaveLength(2);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ text: "Hello.", state: "done" });
  });

  it("says so when the gateway is still busy after that", async () => {
    const s = stage([new ApiError("too_many_requests", "Busy.", 429)], { tools: false });
    await converse(s.turn);
    expect(s.sent).toHaveLength(2);
    expect(s.items[0]).toMatchObject({ state: "error" });
  });

  it("keeps what was written when the reply is cut off, and marks the turn failed", async () => {
    const s = stage([[{ content: "The total is 1" }, new ApiError("upstream_error", "The reply was cut off before it finished.", 200)]], { tools: false });
    await converse(s.turn);
    expect(s.items[0]).toMatchObject({ text: "The total is 1", state: "error", error: "The reply was cut off before it finished." });
    expect(s.messages).toHaveLength(1);
  });

  it("keeps the part that was written when the reader stops the reply", async () => {
    const ctl = new AbortController();
    const s = stage([[{ content: "One, two" }, new Error("stopped")]], { tools: false, signal: ctl.signal });
    ctl.abort();
    await converse(s.turn);
    expect(s.items[0]).toMatchObject({ text: "One, two", state: "stopped" });
    expect(s.messages.at(-1)).toEqual({ role: "assistant", content: "One, two" });
  });
});

describe("running text on the page", () => {
  it("is handed on once per frame, however many deltas arrive in between", () => {
    const frames: (() => void)[] = [];
    const applied: Map<number, { text?: string; thinking?: string }>[] = [];
    const b = batcher<{ text?: string; thinking?: string }>((run) => void frames.push(run), (u) => void applied.push(u));
    for (let i = 1; i <= 200; i++) b.put(1, { text: "x".repeat(i) });
    b.put(1, { thinking: "t" });
    b.put(2, { text: "other" });
    expect(frames).toHaveLength(1);
    expect(applied).toHaveLength(0);
    frames.shift()!();
    expect(applied).toHaveLength(1);
    expect(applied[0]!.get(1)).toEqual({ text: "x".repeat(200), thinking: "t" });
    expect(applied[0]!.get(2)).toEqual({ text: "other" });
    b.put(1, { text: "late" });
    expect(frames).toHaveLength(1);
    b.drop(1);
    frames.shift()!();
    expect(applied).toHaveLength(1);
  });
});
