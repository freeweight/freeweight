import { describe, expect, it } from "vitest";
import type { Model } from "../src/api/types";
import { filterModels, isFiltered, NO_FILTERS, readFilters, tagsOf, toQuery } from "../src/lib/catalog";
import { firstLoadShown, loadedNote, parseRepo } from "../src/lib/repo";

const model = (over: Partial<Model>): Model => ({
  id: "m",
  name: "M",
  hf_repo: "org/m",
  sha: "0".repeat(40),
  license: "apache-2.0",
  params_b: 8,
  quant: "fp16",
  tier: "light",
  price_usd_micro_per_min: 30_000,
  context: 32_768,
  owner: null,
  state: "asleep",
  wake_estimate_s: 70,
  tags: [],
  blurb: "",
  tools_ok: true,
  ...over,
});

const models = [
  model({ id: "qwen3-8b", name: "Qwen3 8B", hf_repo: "Qwen/Qwen3-8B", tags: ["chat", "tools"], state: "awake" }),
  model({ id: "coder-32b", name: "Coder 32B", hf_repo: "acme/coder-32b", tier: "medium", price_usd_micro_per_min: 60_000, params_b: 32, tags: ["code", "tools"], state: "waking" }),
  model({ id: "big-70b", name: "Big 70B", hf_repo: "acme/big-70b", tier: "heavy", price_usd_micro_per_min: 100_000, params_b: 70, tags: ["chat"], state: "cold" }),
  model({ id: "tiny-1b", name: "Tiny 1B", hf_repo: "acme/tiny-1b", params_b: 1, tags: [], state: "asleep" }),
];
const ids = (list: Model[]): string[] => list.map((m) => m.id);

describe("catalog filters", () => {
  it("round-trips through the address bar", () => {
    const f = readFilters("?class=medium&state=awake&tag=tools&q=coder&sort=-price");
    expect(f).toEqual({ tier: "medium", state: "awake", tag: "tools", q: "coder", sort: "price", desc: true });
    expect(readFilters(toQuery(f))).toEqual(f);
    expect(toQuery(NO_FILTERS)).toBe("");
  });
  it("ignores values it does not know", () => {
    expect(readFilters("?class=giant&state=dreaming&sort=colour")).toEqual(NO_FILTERS);
  });
  it("knows when anything is filtered", () => {
    expect(isFiltered(NO_FILTERS)).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, sort: "price" })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, q: "  " })).toBe(false);
    expect(isFiltered({ ...NO_FILTERS, tag: "code" })).toBe(true);
  });
  it("filters by class, state, tag and text", () => {
    expect(ids(filterModels(models, { ...NO_FILTERS, tier: "light" }))).toEqual(["qwen3-8b", "tiny-1b"]);
    expect(ids(filterModels(models, { ...NO_FILTERS, state: "awake" }))).toEqual(["qwen3-8b", "coder-32b"]);
    expect(ids(filterModels(models, { ...NO_FILTERS, state: "cold" }))).toEqual(["big-70b"]);
    expect(ids(filterModels(models, { ...NO_FILTERS, tag: "tools" }))).toEqual(["qwen3-8b", "coder-32b"]);
    expect(ids(filterModels(models, { ...NO_FILTERS, q: "ACME" }))).toEqual(["coder-32b", "big-70b", "tiny-1b"]);
    expect(ids(filterModels(models, { ...NO_FILTERS, q: "nothing" }))).toEqual([]);
  });
  it("keeps the gateway's order unless a sort is chosen", () => {
    expect(ids(filterModels(models, NO_FILTERS))).toEqual(ids(models));
    expect(ids(filterModels(models, { ...NO_FILTERS, sort: "params" }))).toEqual(["tiny-1b", "qwen3-8b", "coder-32b", "big-70b"]);
    expect(ids(filterModels(models, { ...NO_FILTERS, sort: "price", desc: true }))[0]).toBe("big-70b");
    expect(ids(filterModels(models, { ...NO_FILTERS, sort: "state" }))).toEqual(["qwen3-8b", "coder-32b", "tiny-1b", "big-70b"]);
    expect(ids(filterModels(models, { ...NO_FILTERS, sort: "name" }))).toEqual(["big-70b", "coder-32b", "qwen3-8b", "tiny-1b"]);
  });
  it("sorts a model that needs its load again after the ones that can be woken, and finds pasted models by their tag", () => {
    const more = [...models, model({ id: "acme_old-7b", name: "old-7b", hf_repo: "acme/old-7b", tags: ["untested"], state: "needs_load", origin: "pasted" }), model({ id: "gone-7b", name: "Gone 7B", hf_repo: "acme/gone-7b", tags: [], state: "unavailable" })];
    expect(ids(filterModels(more, { ...NO_FILTERS, sort: "state" })).slice(-3)).toEqual(["big-70b", "acme_old-7b", "gone-7b"]);
    expect(ids(filterModels(more, { ...NO_FILTERS, tag: "untested" }))).toEqual(["acme_old-7b"]);
  });
  it("lists tags, most used first", () => {
    expect(tagsOf(models).slice(0, 2).sort()).toEqual(["chat", "tools"]);
    expect(tagsOf(models)).toHaveLength(3);
    expect(tagsOf(models).at(-1)).toBe("code");
  });
});

describe("loadedNote", () => {
  it("calls the caller's own private copy that, and never says it is in the catalog", () => {
    expect(loadedNote(true)).toMatch(/^This is your private copy, loaded already\. Only this account sees it\./);
    expect(loadedNote(true)).not.toMatch(/catalog/);
    expect(loadedNote(false)).toMatch(/^This model is in the catalog already\./);
    for (const own of [true, false]) expect(loadedNote(own)).toMatch(/It wakes like any other, with no first load\.$/);
  });
  it("shows the cost and the time of a first load only for a model that is not loaded", () => {
    expect(firstLoadShown("loaded")).toBe(false);
    for (const state of ["new", "needs_load", "loading"]) expect(firstLoadShown(state), state).toBe(true);
  });
});

describe("parseRepo", () => {
  it("accepts a name or a link", () => {
    expect(parseRepo("Qwen/Qwen3-8B")).toBe("Qwen/Qwen3-8B");
    expect(parseRepo("  https://huggingface.co/Qwen/Qwen3-8B  ")).toBe("Qwen/Qwen3-8B");
    expect(parseRepo("huggingface.co/acme/coder_7b.v2/tree/main")).toBe("acme/coder_7b.v2");
    expect(parseRepo("https://hf.co/acme/coder-7b?library=transformers#usage")).toBe("acme/coder-7b");
    expect(parseRepo("https://huggingface.co/acme/coder-7b/blob/main/README.md")).toBe("acme/coder-7b");
  });
  it("rejects what is not a repo", () => {
    expect(parseRepo("")).toBeNull();
    expect(parseRepo("coder-7b")).toBeNull();
    expect(parseRepo("acme/coder 7b")).toBeNull();
    expect(parseRepo("acme/coder-7b/extra")).toBeNull();
    expect(parseRepo("https://example.com/acme/coder-7b")).toBeNull();
    expect(parseRepo("acme/<script>")).toBeNull();
  });
});
