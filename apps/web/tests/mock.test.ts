import { describe, expect, it } from "vitest";
import { createClient } from "../src/api/client";
import { mockFetch } from "../src/api/mock";
import { toolSummary } from "../src/lib/inert";
import { TIERS } from "../src/api/types";

// The mock gateway is the demo and the screenshot harness. These tests keep it speaking the contract.
const api = createClient(mockFetch);

describe("mock gateway", () => {
  it("lists models in every weight class at the published prices", async () => {
    const models = await api.models();
    for (const tier of TIERS) expect(models.some((m) => m.tier === tier)).toBe(true);
    const price = (tier: string): number | undefined => models.find((m) => m.tier === tier)?.price_usd_micro_per_min;
    expect([price("light"), price("medium"), price("heavy")]).toEqual([30_000, 60_000, 100_000]);
    expect(new Set(models.map((m) => m.id)).size).toBe(models.length);
    // One model has never been timed: the app must cope with a wake that has no typical figure.
    expect(models.some((m) => m.wake_estimate_s === null)).toBe(true);
  });

  it("sends the config nested, as the gateway does, and the client flattens it", async () => {
    const raw = (await (await mockFetch("/api/config")).json()) as { turnstile: { enabled: boolean }; topups: { open: boolean }; tool_system_note: string };
    expect(raw.turnstile.enabled).toBe(false);
    expect(raw.topups.open).toBe(false);
    const c = await api.config();
    expect(c).toMatchObject({ free_minutes: 5, idle_seconds: 300, treasury: null, turnstile_sitekey: null, chain_id: 4663 });
    expect(c.tool_system_note).toBe(raw.tool_system_note);
    expect(c.tool_system_note).toBeTruthy();
  });

  it("starts a free session in the waking state", async () => {
    const models = await api.models();
    const light = models.find((m) => m.tier === "light" && m.state === "asleep")!;
    expect((await api.me()).free_today).toBe(true);
    const s = await api.createSession(light.id, { free: true });
    expect(s.state).toBe("waking");
    expect(s.free).toBe(true);
    const again = await api.session(s.id);
    expect(again.id).toBe(s.id);
    expect(again.stages[0]?.stage).toBe("queued");
    // Asking again for the same model hands back the session that is already live.
    expect((await api.createSession(light.id, { free: true })).id).toBe(s.id);
    // Cancelling a wake ends it as a wake that did not finish, with a receipt for nothing.
    const stopped = await api.stop(s.id);
    expect(stopped.state).toBe("failed");
    expect(stopped.receipt).toMatchObject({ reason: "stopped", minutes: 0, price_usd_micro: 0, gpu_seconds: 0 });
  });

  it("never lets a paid request or a bigger model fall through to the free try", async () => {
    const models = await api.models();
    const light = models.find((m) => m.tier === "light" && m.state !== "unavailable")!;
    const medium = models.find((m) => m.tier === "medium" && m.state !== "unavailable")!;
    await expect(api.createSession(light.id, { minutes: 10 })).rejects.toMatchObject({ code: "sign_in_required", status: 401 });
    await expect(api.createSession(medium.id, { free: true })).rejects.toMatchObject({ code: "trial_unavailable", status: 403 });
    await expect(api.createSession("no-such-model", { free: true })).rejects.toMatchObject({ code: "model_not_found", status: 404 });
  });

  it("answers tool calls in the toolkit's shape", async () => {
    type Result = { content: { type: string; text: string }[]; structuredContent: { ok: boolean; data: Record<string, unknown> }; isError: boolean };
    const token = `0x${"4e".repeat(20)}`;
    const overview = await api.mcp<Result>("tools/call", { name: "token_overview", arguments: { chain: "robinhood", token } });
    expect(overview.isError).toBe(false);
    expect(overview.structuredContent.data).toMatchObject({ token, name_untrusted: "Plate", market_cap_usd: null });
    expect(JSON.parse(overview.content[0]!.text)).toEqual(overview.structuredContent);
    expect(toolSummary(overview.content[0]!.text)).toMatchObject({ partial: true });
    const safety = await api.mcp<Result>("tools/call", { name: "safety_check", arguments: { chain: "robinhood", token } });
    expect(safety.structuredContent.data.sell_simulation).toMatchObject({ verdict: "ok", wallets: [{ round_trip_cost: 0.007 }] });
    expect(toolSummary(safety.content[0]!.text)?.text).toContain("Not a safety guarantee.");
  });

  it("answers unknown things with the error envelope", async () => {
    await expect(api.session("no-such-session")).rejects.toMatchObject({ code: "session_not_found", status: 404 });
    await expect(api.listing("lst_nope")).rejects.toMatchObject({ code: "listing_not_found", status: 404 });
  });

  it("wants a wallet for listings, keys and top-ups", async () => {
    await expect(api.createListing("acme/coder-7b")).rejects.toMatchObject({ code: "sign_in_required", status: 401 });
    await expect(api.createKey("cli", false)).rejects.toMatchObject({ code: "sign_in_required", status: 401 });
    await expect(api.topup(`0x${"ab".repeat(32)}`)).rejects.toMatchObject({ code: "sign_in_required", status: 401 });
  });

  it("checks a listing under the gateway's check names, and passes it once the owner line is there", async () => {
    expect(await api.nonce()).toMatch(/^[a-z0-9]{8,}$/i);
    await api.verify("message", "0xsignature");
    const me = await api.me();
    expect(me.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(me.listing_proof_line).toBe(`freeweight-owner: ${me.address}`);

    await expect(api.createListing("not a repo")).rejects.toMatchObject({ code: "bad_request", status: 400 });
    const first = await api.createListing("acme/coder-7b");
    expect(first.hf_repo).toBe("acme/coder-7b");
    expect(first.checks.map((c) => c.name)).toEqual(["public", "license", "safetensors", "chat_template", "text_generation", "size", "owner_proof", "pinned"]);
    expect(first.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(["owner_proof"]);
    expect(first.state).toBe("rejected");
    expect(first.proof_line).toBe(me.listing_proof_line);
    expect((await api.listing(first.id)).id).toBe(first.id);

    const second = await api.createListing("acme/coder-7b");
    expect(second.checks.every((c) => c.ok)).toBe(true);
    expect(second.state).toBe("pending");

    // Top-ups stay closed until launch, for a wallet too.
    expect((await api.config()).treasury).toBeNull();
    await expect(api.topup(`0x${"ab".repeat(32)}`)).rejects.toMatchObject({ code: "topups_closed", status: 503 });
    await api.logout();
    expect((await api.me()).address).toBeNull();
  });
});
