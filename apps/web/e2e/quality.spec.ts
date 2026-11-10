import { expect, test, type Page } from "@playwright/test";

// Two things a screenshot does not show: the page holds still while it loads, and the keyboard can see where it is.

type Shift = PerformanceEntry & { value: number; hadRecentInput: boolean };

/** The sum of the layout shifts the browser reports while a slow gateway answers. */
async function layoutShift(page: Page, url: string): Promise<number> {
  await page.addInitScript(() => {
    const w = window as unknown as { __shift: number };
    w.__shift = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Shift[]) if (!e.hadRecentInput) w.__shift += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(url);
  // The mock answers after 1.5 s when it is slow; wait for that, then for the page to settle.
  await page.waitForTimeout(2600);
  return page.evaluate(() => (window as unknown as { __shift: number }).__shift);
}

const PAGES: [string, string][] = [
  ["home", "/?mock=slow:1"],
  ["catalog", "/models?mock=slow:1"],
  ["model", "/models/hermes-4-14b?mock=slow:1"],
  ["account", "/account?mock=slow:1,user:1"],
  ["docs", "/docs?mock=slow:1"],
];

for (const [name, url] of PAGES) {
  test(`${name} holds still while it loads`, async ({ page }) => {
    // 0.1 is the usual "good" line for cumulative layout shift; these pages are held to half of it.
    expect(await layoutShift(page, url)).toBeLessThan(0.05);
  });
}

test("every tab stop on the home page shows a focus ring", async ({ page }) => {
  await page.goto("/");
  await page.locator(".box").waitFor();
  const stops: string[] = [];
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press("Tab");
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      const ring = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) >= 2;
      return { what: `${el.tagName.toLowerCase()}.${el.className}`, ring };
    });
    expect(stop, `tab ${i + 1} landed nowhere`).not.toBeNull();
    expect(stop?.ring, `no focus ring on ${stop?.what}`).toBe(true);
    stops.push(stop?.what ?? "");
  }
  // The first stop skips the header; the wake box is reachable without a pointer.
  expect(stops[0]).toContain("a.sr");
  expect(stops.some((s) => s.includes("pick-btn"))).toBe(true);
});

test("the model picker works from the keyboard", async ({ page }) => {
  await page.goto("/");
  const pick = page.locator(".pick-btn");
  await pick.focus();
  const before = await pick.locator(".pick-name").innerText();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(pick.locator(".pick-name")).not.toHaveText(before);
  await expect(pick).toBeFocused();
});
