import { describe, expect, it } from "vitest";
import { splitThinking } from "../src/lib/chat";
import { fromAnnounce, safeIcon, STATEMENT } from "../src/lib/wallet";

const provider = { request: async (): Promise<unknown> => null };

describe("wallet discovery", () => {
  it("accepts only inline images as icons", () => {
    expect(safeIcon("data:image/svg+xml;base64,AAAA")).toBe("data:image/svg+xml;base64,AAAA");
    expect(safeIcon("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(safeIcon("https://example.com/icon.png")).toBeNull();
    expect(safeIcon("javascript:alert(1)")).toBeNull();
    expect(safeIcon("data:text/html,<script>1</script>")).toBeNull();
    expect(safeIcon(undefined)).toBeNull();
  });
  it("reads a well-formed announcement", () => {
    const w = fromAnnounce({ info: { uuid: "u-1", rdns: "io.example.wallet", name: "  Example Wallet  ", icon: "https://example.com/i.png" }, provider });
    expect(w).toMatchObject({ id: "io.example.wallet", name: "Example Wallet", icon: null });
    expect(w?.provider).toBe(provider);
  });
  it("names a wallet that sends no name, and trims a long one", () => {
    expect(fromAnnounce({ info: { uuid: "u-2" }, provider })?.name).toBe("Wallet");
    expect(fromAnnounce({ info: { uuid: "u-3", name: "x".repeat(90) }, provider })?.name).toHaveLength(40);
  });
  it("drops malformed announcements", () => {
    expect(fromAnnounce(null)).toBeNull();
    expect(fromAnnounce({ info: { name: "No id" }, provider })).toBeNull();
    expect(fromAnnounce({ info: { uuid: "u-4" } })).toBeNull();
  });
  it("tells the signer that nothing is being sent", () => {
    expect(STATEMENT).toMatch(/no transaction/);
    expect(STATEMENT).not.toMatch(/\n/);
  });
});

describe("splitThinking", () => {
  it("separates reasoning from the answer", () => {
    expect(splitThinking("<think>\nworking\n</think>\n\nThe answer.")).toEqual({ thinking: "working", answer: "The answer.", open: false });
  });
  it("copes with a tag that is still streaming", () => {
    expect(splitThinking("<think>half a thou")).toEqual({ thinking: "half a thou", answer: "", open: true });
  });
  it("leaves ordinary text alone", () => {
    expect(splitThinking("Use <think> tags sparingly.")).toEqual({ thinking: "", answer: "Use <think> tags sparingly.", open: false });
  });
});
