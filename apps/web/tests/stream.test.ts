import { describe, expect, it } from "vitest";
import { createClient, type ChatDelta, type FetchLike } from "../src/api/client";

const enc = new TextEncoder();
const stream = (blocks: string[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const b of blocks) c.enqueue(enc.encode(b));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
const chunk = (delta: object, finish: string | null = null): string => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

async function collect(blocks: string[], into: ChatDelta[] = []): Promise<ChatDelta[]> {
  const f: FetchLike = async () => stream(blocks);
  const api = createClient(f);
  for await (const d of api.chat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { sessionId: "s1", signal: new AbortController().signal })) into.push(d);
  return into;
}
const join = (out: ChatDelta[], k: "content" | "reasoning"): string => out.map((d) => d[k] ?? "").join("");

describe("the chat stream", () => {
  it("reads the thinking an engine streams in its own field", async () => {
    const out = await collect([
      chunk({ role: "assistant", content: "" }),
      chunk({ reasoning: "The user wants a price. " }),
      chunk({ reasoning: "I should call the tool." }),
      chunk({ content: "\n\n" }),
      chunk({ content: "Here is the answer." }),
      chunk({}, "stop"),
      DONE,
    ]);
    expect(join(out, "reasoning")).toBe("The user wants a price. I should call the tool.");
    expect(join(out, "content")).toBe("\n\nHere is the answer.");
  });

  it("reads the same thing under the older field name", async () => {
    const out = await collect([chunk({ reasoning_content: "Thinking it over." }), chunk({ content: "Yes." }, "stop"), DONE]);
    expect(join(out, "reasoning")).toBe("Thinking it over.");
  });

  it("passes on tool calls whose arguments come in pieces", async () => {
    const out = await collect([
      chunk({ content: "\n\n" }),
      chunk({ tool_calls: [{ index: 0, id: "chatcmpl-tool-1", type: "function", function: { name: "token_overview", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"address":' } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: '"0xabc"}' } }] }),
      chunk({}, "tool_calls"),
      DONE,
    ]);
    const args = out.flatMap((d) => d.tool_calls ?? []).map((t) => t.function?.arguments ?? "");
    expect(args.join("")).toBe('{"address":"0xabc"}');
  });

  it("takes a stream that just stops for a cut-off reply, after handing on what came", async () => {
    const got: ChatDelta[] = [];
    await expect(collect([chunk({ content: "The total is 1" })], got)).rejects.toMatchObject({ code: "upstream_error" });
    expect(join(got, "content")).toBe("The total is 1");
  });

  it("takes a stream with a finish reason and no closing line as complete", async () => {
    const out = await collect([chunk({ content: "Done." }, "stop")]);
    expect(join(out, "content")).toBe("Done.");
  });

  it("surfaces the error block the gateway writes when a stream breaks", async () => {
    const block = (code: string): string => `data: ${JSON.stringify({ error: { message: "The model stopped answering.", type: code, code } })}\n\n`;
    await expect(collect([chunk({ content: "Hel" }), block("upstream_error")])).rejects.toMatchObject({ code: "upstream_error" });
    await expect(collect([chunk({ content: "Hel" }), block("session_ended")])).rejects.toMatchObject({ code: "session_ended" });
  });
});

describe("the gateway's settings", () => {
  it("opens top-ups only for a treasury that is an address", async () => {
    const { normalizeConfig } = await import("../src/api/client");
    const ok = "0x52908400098527886E0F7030069857D2E4169EE7";
    expect(normalizeConfig({ topups: { open: true, treasury: ok } }).treasury).toBe(ok);
    for (const bad of ["0x1234", "javascript:alert(1)", `${ok}00`, `${ok} `, "", 7, null]) {
      expect(normalizeConfig({ topups: { open: true, treasury: bad as string } }).treasury).toBeNull();
    }
    expect(normalizeConfig({ topups: { open: false, treasury: ok } }).treasury).toBeNull();
  });
});
