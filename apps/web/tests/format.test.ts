import { describe, expect, it } from "vitest";
import { about, ago, clock, clockTenths, compact, context, day, gpuTime, grouped, params, perMin, shortAddr, shortSha, took, usd, typicalWake, wakeBudget } from "../src/lib/format";

describe("money", () => {
  it("prints dollars with two decimals", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(1_250_000)).toBe("$1.25");
    expect(usd(12_000_000)).toBe("$12.00");
  });
  it("keeps the cents that matter below a dollar", () => {
    expect(usd(30_000)).toBe("$0.03");
    expect(usd(100_000)).toBe("$0.10");
    expect(usd(125_000)).toBe("$0.125");
    expect(usd(2_500)).toBe("$0.0025");
  });
  it("prints a price per minute", () => {
    expect(perMin(60_000)).toBe("$0.06/min");
  });
});

describe("time", () => {
  it("prints a clock", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65_000)).toBe("1:05");
    expect(clock(3_725_000)).toBe("1:02:05");
    expect(clock(-5)).toBe("0:00");
    expect(clockTenths(65_430)).toBe("1:05.4");
  });
  it("prints a measured duration", () => {
    expect(took(840)).toBe("840 ms");
    expect(took(9_240)).toBe("9.2 s");
    expect(took(102_000)).toBe("1 min 42 s");
    expect(took(119_600)).toBe("2 min 0 s");
  });
  it("keeps estimates coarse", () => {
    expect(about(2)).toBe("about 5 s");
    // A model nobody has timed has no typical wake, and the page never makes one up.
    expect(typicalWake(30)).toBe("about 30 s");
    expect(typicalWake(null)).toBeNull();
    expect(typicalWake(0)).toBeNull();
    expect(typicalWake(undefined)).toBeNull();
    expect(wakeBudget(1380)).toBe("You stopped several wakes before they finished. Try again in 23 min.");
    expect(wakeBudget(20)).toBe("You stopped several wakes before they finished. Try again in 1 min.");
    expect(wakeBudget(undefined)).toBe("You stopped several wakes before they finished. Try again later.");
    expect(about(42)).toBe("about 40 s");
    expect(about(95)).toBe("about 1.5 min");
    expect(about(120)).toBe("about 2 min");
  });
  it("prints GPU time and ages", () => {
    expect(gpuTime(42)).toBe("42 s");
    expect(gpuTime(750)).toBe("12.5 min");
    expect(gpuTime(11_520)).toBe("3.2 h");
    expect(ago(5_000)).toBe("5 s");
    expect(ago(125_000)).toBe("2 min");
    expect(ago(7_200_000)).toBe("2 h");
    expect(ago(172_800_000)).toBe("2 d");
    expect(day(Date.UTC(2026, 10, 10, 12))).toBe("2026-11-10");
  });
});

describe("counts and names", () => {
  it("compacts big numbers", () => {
    expect(compact(999)).toBe("999");
    expect(compact(1_500)).toBe("1.5k");
    expect(compact(12_000)).toBe("12k");
    expect(compact(250_000)).toBe("250k");
    expect(compact(3_400_000)).toBe("3.4M");
    expect(compact(2e9)).toBe("2B");
    expect(grouped(1_234_567.4)).toBe("1,234,567");
  });
  it("prints model sizes", () => {
    expect(params(8)).toBe("8B");
    expect(params(7.6)).toBe("7.6B");
    expect(params(0.5)).toBe("500M");
    expect(context(32_768)).toBe("32k");
    expect(context(131_072)).toBe("128k");
    expect(context(512)).toBe("512");
  });
  it("shortens addresses and commits", () => {
    expect(shortAddr("0x52a1c0ffee9d3b7a8e6f4c2b0a9d8e7f6c5b4a3e")).toBe("0x52a1…4a3e");
    expect(shortAddr("0xabc")).toBe("0xabc");
    expect(shortSha("9c925d64d72725edaf899c6cb9c377fd0709d9c5")).toBe("9c925d6");
  });
});
