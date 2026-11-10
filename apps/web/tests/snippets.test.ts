import { describe, expect, it } from "vitest";
import { addressPieces, snippets } from "../src/lib/snippets";

const BASE = "https://api.example.test/v1";

describe("endpoint snippets", () => {
  it("carry the session id when the session has no key", () => {
    const s = snippets(BASE, "qwen3-8b", "ses_abc123");
    expect(s.curl).toContain('-H "Authorization: Bearer ses_abc123"');
    expect(s.python).toContain('api_key="ses_abc123"');
    expect(s.js).toContain('apiKey: "ses_abc123"');
    for (const code of Object.values(s)) {
      expect(code).not.toContain("FREEWEIGHT_KEY");
      expect(code).toContain("qwen3-8b");
    }
    // Nothing is read from the environment, so nothing is imported for it.
    expect(s.python.startsWith("from openai import OpenAI")).toBe(true);
  });
  it("read a key from the environment when the session is called with one", () => {
    const s = snippets(BASE, "qwen3-8b");
    expect(s.curl).toContain('-H "Authorization: Bearer $FREEWEIGHT_KEY"');
    expect(s.python).toContain('api_key=os.environ["FREEWEIGHT_KEY"]');
    expect(s.python.startsWith("import os\n")).toBe(true);
    expect(s.js).toContain("apiKey: process.env.FREEWEIGHT_KEY");
    for (const code of Object.values(s)) expect(code).not.toContain("ses_");
  });
  it("name the endpoint in full", () => {
    expect(snippets(BASE, "m").curl.split("\n")[0]).toBe(`curl ${BASE}/chat/completions \\`);
  });
});

describe("folding an address", () => {
  it("keeps the host whole and folds after each slash", () => {
    expect(addressPieces("https://api.example.test/v1/chat/completions")).toEqual(["https://api.example.test/", "v1/", "chat/", "completions"]);
    expect(addressPieces("https://api.example.test")).toEqual(["https://api.example.test"]);
  });
  it("loses nothing", () => {
    for (const url of ["https://a.test/v1", "http://127.0.0.1:8787/v1/", "https://a.test//x", 'https://a.test/v1",']) {
      expect(addressPieces(url).join("")).toBe(url);
    }
  });
});
