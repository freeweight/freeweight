import { describe, expect, it, vi } from "vitest";

// The mock gateway keeps model time on timers, so the clock is faked before the mock is loaded.
vi.hoisted(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] }));

import { ApiError, createClient } from "../src/api/client";
import { mockFetch } from "../src/api/mock";
import type { Load, RepoCheck } from "../src/api/types";

const api = createClient(mockFetch);
type Passed = Extract<RepoCheck, { ok: true }>;

/** Let the mock's delays and model time pass while a request is out. */
async function after<T>(p: Promise<T>, ms = 1_000): Promise<T> {
  p.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}
const refused = async (p: Promise<unknown>): Promise<ApiError> => {
  try {
    await after(p);
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("the request was answered");
};
const passed = async (repo: string): Promise<Passed> => {
  const c = await after(api.checkRepo(repo));
  if (!c.ok) throw new Error(`refused: ${c.code}`);
  return c;
};

describe("mock gateway: pasted models", () => {
  it("says what the free check found: class, price, cap, estimates and the licence as stated", async () => {
    const c = await passed("acme/tiny-1b");
    expect(c).toMatchObject({ repo: "acme/tiny-1b", tier: "light", price_usd_micro_per_min: 30_000, load_cap_minutes: 5, load_cap_usd_micro: 150_000, license: "apache-2.0", state: "new", model_id: null, load_id: null, can_load: true });
    expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(c.size_bytes).toBeGreaterThan(0);
    expect(c.load_estimate_s).toBeGreaterThan(c.wake_estimate_s);
    const heavy = await passed("bigiron/atlas-30b");
    expect(heavy).toMatchObject({ tier: "heavy", load_cap_minutes: 15, load_cap_usd_micro: 1_500_000 });
  });

  it("refuses with a code and a plain reason, and answers 200", async () => {
    const codes: string[] = [];
    for (const repo of ["acme/missing-7b", "acme/gated-7b", "acme/coder-gguf", "acme/embed-large", "acme/custom-7b", "acme/notemplate-7b", "acme/giant-405b", "acme/blocked-7b"]) {
      const c = await after(api.checkRepo(repo));
      expect(c.ok).toBe(false);
      if (!c.ok) {
        expect(c.reason.length).toBeGreaterThan(20);
        codes.push(c.code);
      }
    }
    expect(codes).toEqual(["repo_not_found", "gated", "no_safetensors", "not_text_generation", "custom_code", "no_chat_template", "too_big", "blocked"]);
  });

  it("answers a check that could not be made with an error, never with a refusal", async () => {
    expect(await refused(api.checkRepo("not a repo"))).toMatchObject({ code: "bad_repo", status: 400 });
    expect(await refused(api.checkRepo("acme/busy-7b"))).toMatchObject({ code: "rate_limited", status: 429 });
    expect(await refused(api.checkRepo("acme/hfdown-7b"))).toMatchObject({ code: "hf_unavailable", status: 502 });
  });

  it("knows a model that is in the catalog, one that needs its load again, and never one somebody else keeps private", async () => {
    expect(await passed("smallworks/fable-3b")).toMatchObject({ state: "loaded", model_id: "smallworks_fable-3b", can_load: false });
    expect(await passed("northfield/ledger-12b")).toMatchObject({ state: "needs_load", model_id: "northfield_ledger-12b", can_load: true });
    expect(await passed("acme/vault-7b")).toMatchObject({ state: "new", model_id: null, private: false, can_load: true });
    expect(await passed("acme/crowd-7b")).toMatchObject({ state: "loading", load_id: "demo-watch", can_load: false });
  });

  it("shows a visitor the pasted models marked untested, and never a private one", async () => {
    const models = await after(api.models());
    const pasted = models.filter((m) => m.origin === "pasted");
    expect(pasted.map((m) => m.id).sort()).toEqual(["northfield_ledger-12b", "smallworks_fable-3b"]);
    expect(pasted.every((m) => m.tags.includes("untested") && m.private === false && m.mine === false)).toBe(true);
    expect(models.find((m) => m.id === "northfield_ledger-12b")?.state).toBe("needs_load");
    expect(models.some((m) => m.origin !== "pasted" && m.tags.includes("untested"))).toBe(false);
    expect(await refused(api.createSession("you_scratch-7b", { free: true }))).toMatchObject({ code: "model_not_found", status: 404 });
    const cleared = await refused(api.createSession("northfield_ledger-12b", { free: true }));
    expect(cleared).toMatchObject({ code: "needs_load", status: 409 });
    expect(cleared.extra.hf_repo).toBe("northfield/ledger-12b");
  });

  it("wants a wallet for a load, for the list of own models and for the private switch", async () => {
    expect(await refused(api.startLoad("acme/tiny-1b", false))).toMatchObject({ code: "sign_in_required", status: 401 });
    expect(await refused(api.myModels())).toMatchObject({ code: "sign_in_required", status: 401 });
    expect(await refused(api.setPrivate("smallworks_fable-3b", true))).toMatchObject({ code: "sign_in_required", status: 401 });
  });

  it("reads a finished load and a failed one as the gateway sends them", async () => {
    const ready = await after(api.load("demo-ready"));
    expect(ready).toMatchObject({ state: "ready", stage: "ready", model_id: "smallworks_fable-3b" });
    expect(ready.ended_at! - ready.created_at).toBe(214_000);
    const failed = await after(api.load("demo-failed"));
    expect(failed).toMatchObject({ state: "failed", stage: "failed", charged_usd_micro: 0, code: "download_failed" });
    expect(failed.detail).toBeTruthy();
    expect(await refused(api.load("load_nope"))).toMatchObject({ code: "load_not_found", status: 404 });
    // A load that is over sends what it is and ends the stream at once.
    const seen: string[] = [];
    await after(
      api.loadEvents("demo-failed", (event) => void seen.push(event), new AbortController().signal),
    );
    expect(seen).toEqual(["load", "ended"]);
  });

  it("loads a model from the paste to the catalog, charges the time under the cap, and never twice", async () => {
    await after(api.verify("message", "0xsignature"));
    const before = (await after(api.me())).balance_usd_micro;
    const mine = await after(api.models());
    expect(mine.find((m) => m.id === "you_scratch-7b")).toMatchObject({ private: true, mine: true });

    expect(await refused(api.startLoad("acme/gated-7b", false))).toMatchObject({ code: "gated", status: 422 });
    const loaded = await refused(api.startLoad("smallworks/fable-3b", false));
    expect(loaded).toMatchObject({ code: "already_loaded", status: 409 });
    expect(loaded.extra.model_id).toBe("smallworks_fable-3b");

    const l = await after(api.startLoad("acme/tiny-1b", false), 200);
    expect(l).toMatchObject({ hf_repo: "acme/tiny-1b", model_id: "acme_tiny-1b", state: "loading", tier: "light", mine: true, cap_minutes: 5, hold_usd_micro: 150_000, charged_usd_micro: 0 });
    expect(l.id).toMatch(/^load_/);
    // While it runs the check points at it, and a second request joins it instead of starting another.
    expect(await passed("acme/tiny-1b")).toMatchObject({ state: "loading", load_id: l.id, can_load: false });
    expect((await after(api.startLoad("acme/tiny-1b", false), 200)).id).toBe(l.id);

    const events: [string, Load][] = [];
    const stream = api.loadEvents(l.id, (event, data) => void events.push([event, data as Load]), new AbortController().signal);
    await after(stream, 40_000);
    const stages = events.filter(([e]) => e === "load").map(([, d]) => d.stage);
    expect([...new Set(stages)]).toEqual(["queued", "checking", "downloading", "validating", "starting", "ready"].slice(stages[0] === "queued" ? 0 : 1));
    expect(events.some(([e]) => e === "tick")).toBe(true);
    expect(events.filter(([e]) => e === "ended")).toHaveLength(1);
    expect(events.at(-1)![0]).toBe("ended");
    const bytes = events.filter(([, d]) => d.stage === "downloading").map(([, d]) => d.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(bytes.at(-1)).toBeGreaterThan(0);

    const done = await after(api.load(l.id));
    expect(done).toMatchObject({ state: "ready", stage: "ready", bytes: done.size_bytes });
    expect(done.charged_usd_micro).toBeGreaterThan(0);
    expect(done.charged_usd_micro).toBeLessThan(done.hold_usd_micro);
    expect((await after(api.me())).balance_usd_micro).toBe(before - done.charged_usd_micro);

    const model = (await after(api.models())).find((m) => m.id === "acme_tiny-1b");
    expect(model).toMatchObject({ origin: "pasted", state: "asleep", private: false, mine: true, tags: ["untested"], hf_repo: "acme/tiny-1b" });
    const again = await refused(api.startLoad("acme/tiny-1b", false));
    expect(again).toMatchObject({ code: "already_loaded", status: 409 });
    expect((await after(api.me())).balance_usd_micro).toBe(before - done.charged_usd_micro);

    const own = await after(api.myModels());
    expect(own.map((m) => m.id).sort()).toEqual(["acme_tiny-1b", "you_scratch-7b"]);
    expect(own.every((m) => m.size_bytes > 0 && m.clears_at !== null && m.clears_at > m.last_woken_at)).toBe(true);

    // Kept private, the model leaves everybody else's catalog. Only its loader can switch it.
    expect(await refused(api.setPrivate("smallworks_fable-3b", true))).toMatchObject({ code: "not_yours", status: 403 });
    expect((await after(api.setPrivate("acme_tiny-1b", true))).private).toBe(true);
    await after(api.logout());
    expect((await after(api.models())).some((m) => m.id === "acme_tiny-1b")).toBe(false);
    // To anyone else the load reads without its money.
    expect(await after(api.load(l.id))).toMatchObject({ mine: false, hold_usd_micro: 0, charged_usd_micro: 0 });
  });
});
