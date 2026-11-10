import { describe, expect, it } from "vitest";
import { parseEvent, readSse, type SseMessage } from "../src/api/sse";

function stream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}
async function all(chunks: string[]): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of readSse(stream(chunks))) out.push(m);
  return out;
}

describe("parseEvent", () => {
  it("reads the event name and joins data lines", () => {
    expect(parseEvent("event: stage\ndata: {\"a\":1}")).toEqual({ event: "stage", data: '{"a":1}' });
    expect(parseEvent("data: one\ndata: two")).toEqual({ event: "message", data: "one\ntwo" });
  });
  it("ignores comments and events without data", () => {
    expect(parseEvent(": keep-alive")).toBeNull();
    expect(parseEvent("event: tick")).toBeNull();
  });
});

describe("readSse", () => {
  it("reassembles events split across chunks", async () => {
    const got = await all(["event: sta", "ge\ndata: {\"stage\":\"gpu\"}\n", "\ndata: [DO", "NE]\n\n"]);
    expect(got).toEqual([
      { event: "stage", data: '{"stage":"gpu"}' },
      { event: "message", data: "[DONE]" },
    ]);
  });
  it("accepts CRLF and a last event without a blank line", async () => {
    const got = await all(["event: tick\r\ndata: 1\r\n\r\nevent: ended\r\ndata: 2"]);
    expect(got).toEqual([
      { event: "tick", data: "1" },
      { event: "ended", data: "2" },
    ]);
  });
  it("splits a multi-byte character across chunks without breaking it", async () => {
    const bytes = new TextEncoder().encode("data: café\n\n");
    const cut = bytes.length - 3; // inside the two bytes of the last letter
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const out: SseMessage[] = [];
    for await (const m of readSse(body)) out.push(m);
    expect(out).toEqual([{ event: "message", data: "café" }]);
  });
});
