import { describe, expect, it } from "vitest";
import { isOutside, match } from "../src/router";

describe("routes", () => {
  it("matches a pattern and reads its parts", () => {
    expect(match("/", "/")).toEqual({});
    expect(match("/models", "/models")).toEqual({});
    expect(match("/models/:id", "/models/qwen3-8b")).toEqual({ id: "qwen3-8b" });
    expect(match("/models/:id", "/models/a%2Fb")).toEqual({ id: "a/b" });
  });

  it("does not match a longer, shorter or different path", () => {
    expect(match("/models", "/models/x")).toBeNull();
    expect(match("/docs/:slug", "/docs")).toBeNull();
    expect(match("/models/:id", "/docs/x")).toBeNull();
  });

  it("takes a path with a broken escape as no match instead of failing", () => {
    expect(() => match("/models/:id", "/models/%")).not.toThrow();
    expect(match("/models/:id", "/models/%")).toBeNull();
    expect(match("/s/:id", "/s/%E0%A4%A")).toBeNull();
  });

  it("knows a link that leaves the site", () => {
    expect(isOutside("https://example.com/x")).toBe(true);
    expect(isOutside("//evil.example/x")).toBe(true);
    expect(isOutside("/\\evil.example/x")).toBe(true);
    expect(isOutside("/models")).toBe(false);
    expect(isOutside("/docs/pricing#free")).toBe(false);
  });
});
