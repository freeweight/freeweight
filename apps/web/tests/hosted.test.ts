import { describe, expect, it } from "vitest";
import { ApiError, createClient, normalizeMe, type FetchLike, type HostedEvent } from "../src/api/client";
import { mockFetch } from "../src/api/mock";
import type { Item, Sink } from "../src/lib/chat";
import { NO_FILTERS } from "../src/lib/catalog";
import { freeLine, HOSTED_PATH, inCatalog, leaveOpening, perMillion, takeOpening, tokenCost, tokenPrices } from "../src/lib/hosted";
import { CALM, follow, withCheck } from "../src/lib/hostedchat";

const PRICES = { price_in_usd_micro_per_mtok: 500_000, price_out_usd_micro_per_mtok: 2_000_000 };
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (text: string): Response => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
const ev = (event: string, data: object): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const never = new AbortController().signal;

async function all<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
async function refusal(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error("nothing was refused");
}

describe("what the pages say about the always-awake model", () => {
  it("quotes the prices for a million tokens", () => {
    expect(perMillion(500_000)).toBe("$0.50");
    expect(tokenPrices(PRICES)).toBe("$0.50 in · $2.00 out per 1M tokens");
  });
  it("prices an answer from its tokens, rounded up to a whole micro", () => {
    expect(tokenCost(PRICES, 1_000_000, 1_000_000)).toBe(2_500_000);
    expect(tokenCost(PRICES, 1_200, 350)).toBe(1_300);
    expect(tokenCost(PRICES, 1, 0)).toBe(1);
    expect(tokenCost(PRICES, 0, 0)).toBe(0);
  });
  it("counts the free messages left, and says when there are none", () => {
    expect(freeLine(3, 20)).toBe("3 of 20 free messages left today");
    expect(freeLine(1, 1)).toBe("1 of 1 free message left today");
    expect(freeLine(0, 20)).toBe("Today's free messages are used.");
  });
  it("shows it in the catalog unless a filter asks for something it is not", () => {
    const m = { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" };
    expect(inCatalog(m, NO_FILTERS)).toBe(true);
    expect(inCatalog(m, { ...NO_FILTERS, state: "awake" })).toBe(true);
    expect(inCatalog(m, { ...NO_FILTERS, state: "asleep" })).toBe(false);
    expect(inCatalog(m, { ...NO_FILTERS, state: "cold" })).toBe(false);
    expect(inCatalog(m, { ...NO_FILTERS, tier: "light" })).toBe(false);
    expect(inCatalog(m, { ...NO_FILTERS, tag: "code" })).toBe(false);
    expect(inCatalog(m, { ...NO_FILTERS, q: " deepseek " })).toBe(true);
    expect(inCatalog(m, { ...NO_FILTERS, q: "V4.1-FLASH" })).toBe(true);
    expect(inCatalog(m, { ...NO_FILTERS, q: "qwen" })).toBe(false);
  });
  it("carries a message from the front page to the room once", () => {
    expect(HOSTED_PATH).toBe("/chat");
    expect(takeOpening()).toBeNull();
    leaveOpening("  hello  ");
    expect(takeOpening()).toBe("hello");
    expect(takeOpening()).toBeNull();
    leaveOpening("   ");
    expect(takeOpening()).toBeNull();
  });
});

describe("client", () => {
  const client = (reply: (path: string, init?: RequestInit) => Response): ReturnType<typeof createClient> => createClient((async (path, init) => reply(path, init)) as FetchLike);

  it("reads the model, and null from a gateway that offers none", async () => {
    expect(await client(() => json({ model: { id: "m", name: "M" } })).hosted()).toMatchObject({ id: "m" });
    expect(await client(() => json({ model: null })).hosted()).toBeNull();
    expect(await client(() => json({})).hosted()).toBeNull();
  });

  it("keeps the account's use of it on /api/me, with times in milliseconds", () => {
    const me = normalizeMe({
      hosted: { model_id: "m", free_per_day: 20, free_left: 7, check_needed: true, recent: [{ id: "r1", at: 1_762_000_000, surface: "api", free: false, tokens_in: 10, tokens_out: 5, charged_usd_micro: 15 }] },
    });
    expect(me.hosted).toMatchObject({ free_left: 7, check_needed: true });
    expect(me.hosted!.recent[0]!.at).toBe(1_762_000_000_000);
    expect(normalizeMe({ hosted: null }).hosted).toBeNull();
  });

  it("posts the turn and yields the events up to done", async () => {
    let sent: { path: string; body: unknown } | null = null;
    const c = client((path, init) => {
      sent = { path, body: JSON.parse(String(init?.body)) };
      return sse(
        ev("start", { free: true, free_left: 19, tools: false }) +
          ev("delta", { text: "Hi" }) +
          ev("ping", {}) +
          "event: delta\ndata: not json\n\n" +
          ev("usage", { tokens_in: 9, tokens_out: 1, cost_usd_micro: 0, free: true }) +
          ev("done", { rounds: 1 }) +
          ev("delta", { text: "after the end" }),
      );
    });
    const events = await all(c.hostedChat({ messages: [{ role: "user", content: "hi" }], tools: true, turnstile_token: "t" }, never));
    expect(events.map((e) => e.event)).toEqual(["start", "delta", "usage", "done"]);
    expect(events[1]).toEqual({ event: "delta", text: "Hi" });
    expect(sent).toEqual({ path: "/api/hosted/chat", body: { messages: [{ role: "user", content: "hi" }], tools: true, turnstile_token: "t" } });
  });

  it("throws a refusal that comes before the stream, with its code", async () => {
    const c = client(() => json({ error: { code: "free_used", message: "Today's free messages are used." } }, 429));
    const e = await refusal(all(c.hostedChat({ messages: [] }, never)));
    expect(e.code).toBe("free_used");
    expect(e.status).toBe(429);
  });

  it("throws an error event, and a stream that stops without done", async () => {
    const broke = client(() => sse(ev("start", { free: false, free_left: null, tools: false }) + ev("error", { code: "upstream_error", message: "The model did not answer." })));
    expect((await refusal(all(broke.hostedChat({ messages: [] }, never)))).message).toBe("The model did not answer.");
    const cut = client(() => sse(ev("start", { free: false, free_left: null, tools: false }) + ev("delta", { text: "Half an ans" })));
    expect((await refusal(all(cut.hostedChat({ messages: [] }, never)))).code).toBe("upstream_error");
  });
});

/** A transcript the way the room keeps it. */
function transcript(): { items: Item[]; sink: Sink } {
  const items: Item[] = [];
  const at = (id: number): number => items.findIndex((it) => it.id === id);
  const set = (id: number, p: Partial<Item>): void => {
    const i = at(id);
    if (i >= 0) items[i] = { ...items[i], ...p } as Item;
  };
  return { items, sink: { add: (more) => void items.push(...more), stream: set, patch: set, remove: (id) => void items.splice(at(id), 1) } };
}
async function* play(events: HostedEvent[], fail?: unknown): AsyncGenerator<HostedEvent> {
  for (const e of events) yield e;
  if (fail) throw fail;
}
function counter(): () => number {
  let n = 1;
  return () => n++;
}

describe("following a turn", () => {
  it("shows a plain answer and reports what it used", async () => {
    const { items, sink } = transcript();
    const used: number[] = [];
    let started: unknown = null;
    const end = await follow(
      play([
        { event: "start", free: true, free_left: 19, tools: false },
        { event: "reasoning", text: "Short." },
        { event: "delta", text: "Hello" },
        { event: "delta", text: " there" },
        { event: "usage", tokens_in: 12, tokens_out: 2, cost_usd_micro: 0, free: true },
        { event: "done", rounds: 1 },
      ]),
      { signal: never, nextId: counter(), sink, onStart: (s) => (started = s), onUsage: (u) => used.push(u.tokens_in + u.tokens_out) },
    );
    expect(end).toMatchObject({ text: "Hello there", heard: true, stopped: false, error: null });
    expect(started).toEqual({ free: true, free_left: 19, tools: false });
    expect(used).toEqual([14]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Hello there", thinking: "Short.", state: "done", usage: { prompt_tokens: 12, completion_tokens: 2 } });
  });

  it("shows each tool call with its short result, then the answer that follows", async () => {
    const { items, sink } = transcript();
    let rounds = 0;
    const end = await follow(
      play([
        { event: "start", free: false, free_left: null, tools: true },
        { event: "usage", tokens_in: 40, tokens_out: 20, cost_usd_micro: 60, free: false },
        { event: "tool_call", id: "a", name: "token_overview", arguments: '{"token":"0x1"}' },
        { event: "tool_call", id: "b", name: "safety_check", arguments: '{"token":"0x1"}' },
        { event: "tool_result", id: "a", name: "token_overview", ok: true, summary: "One pool." },
        { event: "tool_result", id: "zz", name: "nothing", ok: true, summary: "Not asked for." },
        { event: "tool_result", id: "b", name: "safety_check", ok: false, summary: "Could not sell." },
        { event: "delta", text: "Both answered." },
        { event: "usage", tokens_in: 400, tokens_out: 3, cost_usd_micro: 206, free: false },
        { event: "done", rounds: 2 },
      ]),
      { signal: never, nextId: counter(), sink, onUsage: () => rounds++ },
    );
    expect(end.text).toBe("Both answered.");
    expect(rounds).toBe(2);
    // The first answer said nothing and only called tools: it leaves no empty bubble behind.
    expect(items.map((it) => it.kind)).toEqual(["tool", "tool", "assistant"]);
    expect(items[0]).toMatchObject({ name: "token_overview", args: '{"token":"0x1"}', state: "ok", result: JSON.stringify({ summary: "One pool." }) });
    expect(items[1]).toMatchObject({ name: "safety_check", state: "error", result: JSON.stringify({ summary: "Could not sell." }) });
    expect(items[2]).toMatchObject({ text: "Both answered.", state: "done" });
  });

  it("leaves no trace of a turn that was refused before it began", async () => {
    const { items, sink } = transcript();
    const end = await follow(play([], new ApiError("free_used", "Today's free messages are used.", 429)), { signal: never, nextId: counter(), sink });
    expect(items).toEqual([]);
    expect(end).toMatchObject({ text: "", heard: false, stopped: false, started: null });
    expect(end.error?.code).toBe("free_used");
  });

  it("keeps what was said when the turn breaks part-way, and stops the tools still running", async () => {
    const { items, sink } = transcript();
    const end = await follow(
      play(
        [
          { event: "start", free: false, free_left: null, tools: true },
          { event: "delta", text: "Looking it up." },
          { event: "tool_call", id: "a", name: "holders", arguments: "{}" },
        ],
        new ApiError("upstream_error", "The reply was cut off before it finished.", 200),
      ),
      { signal: never, nextId: counter(), sink },
    );
    expect(end).toMatchObject({ text: "Looking it up.", heard: true, stopped: false });
    expect(end.error?.code).toBe("upstream_error");
    expect(items.map((it) => [it.kind, "state" in it ? it.state : ""])).toEqual([
      ["assistant", "done"],
      ["tool", "stopped"],
      ["assistant", "error"],
    ]);
    expect(items[2]).toMatchObject({ error: "The reply was cut off before it finished." });
  });

  it("marks an answer that broke while it was being written", async () => {
    const { items, sink } = transcript();
    await follow(play([{ event: "start", free: true, free_left: 1, tools: false }, { event: "delta", text: "Half" }], new ApiError("upstream_error", "Cut off.", 200)), { signal: never, nextId: counter(), sink });
    expect(items[0]).toMatchObject({ kind: "assistant", text: "Half", state: "error", error: "Cut off." });
  });

  it("ends as stopped when the visitor stops it", async () => {
    const { items, sink } = transcript();
    const ac = new AbortController();
    async function* stopped(): AsyncGenerator<HostedEvent> {
      yield { event: "start", free: true, free_left: 4, tools: false };
      yield { event: "delta", text: "One, two" };
      ac.abort();
      throw new DOMException("Aborted", "AbortError");
    }
    const end = await follow(stopped(), { signal: ac.signal, nextId: counter(), sink });
    expect(end).toMatchObject({ text: "One, two", stopped: true, error: null });
    expect(items[0]).toMatchObject({ state: "stopped", text: "One, two" });
  });
});

describe("the human check", () => {
  const turn: HostedEvent[] = [
    { event: "start", free: true, free_left: 19, tools: false },
    { event: "done", rounds: 1 },
  ];
  const wanted = (): ApiError => new ApiError("turnstile_required", "Confirm you are human.", 400);

  it("is not run when the gateway does not ask", async () => {
    const tokens: (string | undefined)[] = [];
    let checks = 0;
    const got = await all(withCheck((t) => (tokens.push(t), play(turn)), async () => (checks++, "tok"), "first"));
    expect(got).toEqual(turn);
    expect(tokens).toEqual(["first"]);
    expect(checks).toBe(0);
  });
  it("runs once when asked, and the turn is sent again with the token", async () => {
    const tokens: (string | undefined)[] = [];
    const got = await all(withCheck((t) => (tokens.push(t), t ? play(turn) : play([], wanted())), async () => "tok"));
    expect(got).toEqual(turn);
    expect(tokens).toEqual([undefined, "tok"]);
  });
  it("gives up when the check yields nothing or is asked for twice", async () => {
    expect((await refusal(all(withCheck(() => play([], wanted()), async () => undefined)))).code).toBe("turnstile_required");
    let asks = 0;
    expect((await refusal(all(withCheck(() => (asks++, play([], wanted())), async () => "tok")))).code).toBe("turnstile_required");
    expect(asks).toBe(2);
  });
  it("passes any other refusal straight on", async () => {
    let checks = 0;
    const e = await refusal(all(withCheck(() => play([], new ApiError("hosted_busy", "Busy.", 503)), async () => (checks++, "tok"))));
    expect(e.code).toBe("hosted_busy");
    expect(checks).toBe(0);
    for (const code of ["free_used", "free_budget_spent", "hosted_busy", "insufficient_balance", "message_too_long", "rate_limited", "too_many_in_flight"]) expect(CALM.has(code)).toBe(true);
    expect(CALM.has("upstream_error")).toBe(false);
  });
});

// The mock gateway is the demo and the screenshot harness: it has to speak the same contract.
describe("mock gateway", () => {
  const api = createClient(mockFetch);

  it("offers the model at its per-token prices and counts it apart in the stats", async () => {
    const m = (await api.hosted())!;
    expect(m).toMatchObject({ id: "deepseek-v4.1-flash", kind: "hosted", ...PRICES, tools_ok: true });
    expect(m.free.per_day).toBe(20);
    expect(m.blurb).toMatch(/uncensored build: it does not refuse topics, and you are responsible/);
    expect((await api.models()).some((x) => x.id === m.id)).toBe(false);
    const s = await api.stats();
    expect(s.hosted_requests).toBeGreaterThan(0);
    expect(s.hosted_tokens).toBeGreaterThan(0);
  });

  it("answers a visitor for free, without tools, and counts the message", async () => {
    const before = (await api.me()).hosted!;
    expect(before).toMatchObject({ free_left: 20, recent: [] });
    const events = await all(api.hostedChat({ messages: [{ role: "user", content: "Is this token safe?" }], tools: true }, never));
    expect(events[0]).toEqual({ event: "start", free: true, free_left: 19, tools: false });
    expect(events.some((e) => e.event === "tool_call")).toBe(false);
    expect(events.filter((e) => e.event === "usage")).toMatchObject([{ free: true, cost_usd_micro: 0 }]);
    expect(events.at(-1)).toEqual({ event: "done", rounds: 1 });
    expect((await api.me()).hosted!.free_left).toBe(19);
  });

  it("charges a wallet per token and runs a tool round when tools are on", async () => {
    await api.verify("message", "0xsig");
    const before = await api.me();
    const m = (await api.hosted())!;
    const events = await all(api.hostedChat({ messages: [{ role: "user", content: "Check the token 0x4e1f0a6c2b8d9e3f5a7c1b0d2e4f6a8c0b1d3e5f" }], tools: true }, never));
    expect(events[0]).toEqual({ event: "start", free: false, free_left: null, tools: true });
    expect(events.filter((e) => e.event === "tool_call").map((e) => (e.event === "tool_call" ? e.name : ""))).toEqual(["token_overview", "safety_check"]);
    const results = events.filter((e) => e.event === "tool_result");
    expect(results).toHaveLength(2);
    for (const r of results) if (r.event === "tool_result") expect(r.summary).toBeTruthy();
    const usage = events.filter((e) => e.event === "usage");
    expect(usage).toHaveLength(2);
    let cost = 0;
    for (const u of usage)
      if (u.event === "usage") {
        expect(u.cost_usd_micro).toBe(tokenCost(m, u.tokens_in, u.tokens_out));
        cost += u.cost_usd_micro;
      }
    expect(events.at(-1)).toEqual({ event: "done", rounds: 2 });
    const after = await api.me();
    expect(before.balance_usd_micro - after.balance_usd_micro).toBe(cost);
    expect(after.hosted!.free_left).toBe(19);
    expect(after.hosted!.recent.slice(0, 2).map((u) => u.charged_usd_micro).reduce((a, b) => a + b, 0)).toBe(cost);
    expect(after.hosted!.recent[0]).toMatchObject({ surface: "chat", free: false });
  });
});
