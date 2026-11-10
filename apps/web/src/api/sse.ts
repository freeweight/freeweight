// Server-sent events over fetch, so the same reader serves the session stream and OpenAI-style chat streams.

export type SseMessage = { event: string; data: string };

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut: number;
      // Events end with a blank line. Accept \n\n and \r\n\r\n.
      while ((cut = boundary(buf)) >= 0) {
        const raw = buf.slice(0, cut);
        buf = buf.slice(cut).replace(/^(\r?\n){1,2}/, "");
        const msg = parseEvent(raw);
        if (msg) yield msg;
      }
    }
    const tail = parseEvent(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function boundary(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

export function parseEvent(raw: string): SseMessage | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  return { event, data: data.join("\n") };
}
