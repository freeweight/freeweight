import { describe, expect, it } from "vitest";
import { about, ago, clock, clockTenths, compact, context, day, gpuTime, grouped, licence, params, perMin, plainCode, shortAddr, shortSha, size, took, usd, typicalWake, wakeBudget } from "../src/lib/format";

describe("money", () => {
  it("prints dollars with two decimals", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(1_250_000)).toBe("$1.25");
    expect(usd(12_000_000)).toBe("$12.00");
  });
  // The rule, for every amount the site prints:
  //   1. At least two decimals, always.
  //   2. Four decimals only under a dollar, and only when the third or fourth decimal is not zero. Every amount
  //      under one cent is such an amount.
  //   3. Never three decimals. A dollar and up is always two.
  it("prints two decimals when the cents say everything", () => {
    expect(usd(30_000)).toBe("$0.03");
    expect(usd(100_000)).toBe("$0.10");
    expect(usd(500_000)).toBe("$0.50");
    expect(usd(990_000)).toBe("$0.99");
  });
  it("prints four decimals under a dollar when the extra digits are not zero", () => {
    expect(usd(218_500)).toBe("$0.2185");
    expect(usd(125_000)).toBe("$0.1250");
    expect(usd(120_100)).toBe("$0.1201");
    expect(usd(2_500)).toBe("$0.0025");
    expect(usd(5_000)).toBe("$0.0050");
    expect(usd(100)).toBe("$0.0001");
  });
  it("never prints three decimals, and never four from a dollar up", () => {
    for (const micro of [1, 40, 100, 999, 1_000, 5_000, 12_340, 125_000, 218_500, 500_000, 999_949, 999_990, 1_000_000, 1_118_500, 1_125_000, 37_400_100]) {
      const digits = usd(micro).split(".")[1] ?? "";
      expect([2, 4]).toContain(digits.length);
      if (micro >= 1_000_000) expect(digits.length).toBe(2);
    }
    expect(usd(1_118_500)).toBe("$1.12");
    expect(usd(999_949)).toBe("$0.9999");
    // Rounds to a whole dollar, so it is printed as one.
    expect(usd(999_990)).toBe("$1.00");
  });
  it("rounds a half up, on whole micro-units", () => {
    expect(usd(1_005_000)).toBe("$1.01");
    expect(usd(1_015_000)).toBe("$1.02");
    expect(usd(2_675_000)).toBe("$2.68");
    expect(usd(1_125_000)).toBe("$1.13");
    expect(usd(1_450)).toBe("$0.0015");
    expect(usd(4_950)).toBe("$0.0050");
    expect(usd(-1_005_000)).toBe("-$1.01");
    // Every whole cent from zero to $100, and from a dollar up every half cent too.
    const cents = (c: number) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
    for (let c = 0; c <= 10_000; c++) {
      expect(usd(c * 10_000)).toBe(cents(c));
      if (c >= 100) expect(usd(c * 10_000 + 5_000)).toBe(cents(c + 1));
    }
  });
  it("keeps the sign and the floor", () => {
    expect(usd(-500_000)).toBe("-$0.50");
    expect(usd(-2_500)).toBe("-$0.0025");
    expect(usd(40)).toBe("<$0.0001");
  });
  it("prints a code it has no words for as plain text", () => {
    expect(plainCode("minimum_applied")).toBe("minimum applied");
    expect(plainCode("<b>x</b>")).toBe("b x b");
    expect(plainCode("")).toBe("");
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
    expect(typicalWake({ wake_estimate_s: 30 })?.text).toBe("about 30 s");
    expect(typicalWake(null)).toBeNull();
    expect(typicalWake({ wake_estimate_s: 0 })).toBeNull();
    expect(typicalWake({ wake_estimate_s: null })).toBeNull();
    expect(typicalWake({})).toBeNull();
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

describe("typical wake", () => {
  const one = (s: number) => typicalWake({ wake_estimate_s: s })?.text;
  const span = (est: number, low: number, high: number) => typicalWake({ wake_estimate_s: est, wake_low_s: low, wake_high_s: high })?.text;

  it("says one figure in plain steps, never 26 or 35", () => {
    expect(one(3)).toBe("about 5 s");
    expect(one(14.1)).toBe("about 15 s");
    expect(one(26)).toBe("about 25 s");
    expect(one(28)).toBe("about 30 s");
    expect(one(35)).toBe("about 40 s");
    expect(one(44)).toBe("about 40 s");
    expect(one(57)).toBe("about 1 min");
    expect(one(70)).toBe("about 1 min");
    expect(one(80)).toBe("about 1.5 min");
    expect(one(135)).toBe("about 2.5 min");
    expect(one(170)).toBe("about 3 min");
    expect(one(200)).toBe("about 3 min");
    expect(one(260)).toBe("about 4 min");
  });

  it("says a range when the low and the high end differ: low down, high up", () => {
    expect(span(35, 31, 58)).toBe("usually 30 to 60 s");
    expect(span(26, 14.1, 45.7)).toBe("usually 10 to 50 s");
    expect(span(26, 24, 31)).toBe("usually 20 to 40 s");
    expect(span(90, 62, 115)).toBe("usually 1 to 2 min");
    expect(span(90, 95, 170)).toBe("usually 1.5 to 3 min");
    expect(span(60, 34, 135)).toBe("usually 30 s to 2.5 min");
    expect(span(200, 150, 185)).toBe("usually 2.5 to 4 min");
  });

  it("carries the seconds the words stand for", () => {
    expect(typicalWake({ wake_estimate_s: 35, wake_low_s: 31, wake_high_s: 58 })).toEqual({ text: "usually 30 to 60 s", lowS: 30, highS: 60, range: true });
    expect(typicalWake({ wake_estimate_s: 26 })).toEqual({ text: "about 25 s", lowS: 25, highS: 25, range: false });
  });

  it("falls back to one figure when the ends are missing, zero, the same step, or the wrong way round", () => {
    expect(span(35, 0, 0)).toBe("about 40 s");
    expect(span(35, 31, 0)).toBe("about 40 s");
    expect(span(35, 60, 30)).toBe("about 40 s");
    expect(span(40, 40, 40)).toBe("about 40 s");
    expect(span(2, 2, 4)).toBe("about 5 s"); // nothing wakes in "0 to 5 s"
    expect(typicalWake({ wake_estimate_s: 26, wake_low_s: null, wake_high_s: undefined })?.text).toBe("about 25 s");
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

describe("numbers at the edge of a unit", () => {
  it("chooses the unit for the rounded number", () => {
    expect(took(999.6)).toBe("1.0 s");
    expect(took(59_960)).toBe("1 min 0 s");
    expect(took(59_940)).toBe("59.9 s");
    expect(gpuTime(59.6)).toBe("1 min");
    expect(gpuTime(3599)).toBe("1 h");
    expect(compact(999.6)).toBe("1k");
    expect(compact(999_950)).toBe("1M");
    expect(compact(999_499)).toBe("999k");
  });

  it("prints stored bytes in the units Hugging Face uses", () => {
    expect(size(0)).toBe("1 MB");
    expect(size(840_000_000)).toBe("840 MB");
    expect(size(999_400_000)).toBe("999 MB");
    expect(size(999_600_000)).toBe("1 GB");
    expect(size(16_600_000_000)).toBe("16.6 GB");
    expect(size(143_000_000_000)).toBe("143 GB");
  });

  it("reads a context size in thousands, however it is counted", () => {
    expect(context(128_000)).toBe("128k");
    expect(context(32_000)).toBe("32k");
    expect(context(131_072)).toBe("128k");
    expect(context(200_000)).toBe("200k");
  });

  it("keeps the sign in front and never shows a small amount as nothing", () => {
    expect(usd(-500_000)).toBe("-$0.50");
    expect(usd(-1_250_000)).toBe("-$1.25");
    expect(usd(40)).toBe("<$0.0001");
    expect(usd(999_990)).toBe("$1.00");
  });
});

describe("licence", () => {
  it("shows the licence as stated, or says plainly that there is none", () => {
    expect(licence("apache-2.0")).toBe("apache-2.0");
    expect(licence("")).toBe("No licence stated by the publisher");
  });
});
