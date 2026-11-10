// The code a session shows for calling its endpoint from outside the page.

export type Lang = "curl" | "python" | "js";

/**
 * The three snippets. With a session id they carry it as the bearer token, which is how a session without an API
 * key is called; without one they read a key from the environment.
 */
export function snippets(base: string, model: string, sessionId: string | null = null): Record<Lang, string> {
  return {
    curl: `curl ${base}/chat/completions \\
  -H "Authorization: Bearer ${sessionId ?? "$FREEWEIGHT_KEY"}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${model}",
    "messages": [{"role": "user", "content": "Hello"}]
  }'`,
    python: `${sessionId ? "" : "import os\n"}from openai import OpenAI

client = OpenAI(
    base_url="${base}",
    api_key=${sessionId ? `"${sessionId}"` : 'os.environ["FREEWEIGHT_KEY"]'},
)
r = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(r.choices[0].message.content)`,
    js: `import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "${base}",
  apiKey: ${sessionId ? `"${sessionId}"` : "process.env.FREEWEIGHT_KEY"},
});
const r = await client.chat.completions.create({
  model: "${model}",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(r.choices[0].message.content);`,
  };
}

/** The pieces a web address may fold between: scheme and host in one piece, then each step of the path. */
export function addressPieces(url: string): string[] {
  return url.match(/^[a-z]+:\/\/[^/]*\/?|[^/]+\/?|\//g) ?? [url];
}
