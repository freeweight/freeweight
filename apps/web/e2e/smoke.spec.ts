import { expect, test } from "@playwright/test";

// The whole point of the product in one pass: wake a model for free, talk to it, stop, take the receipt.
test("home, wake, chat, receipt", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto("/?mock=speed:40");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Rent any open model");
  await page.getByRole("button", { name: /free for 5 minutes/ }).click();

  // The wake: a timer, then the room.
  await expect(page).toHaveURL(/\/s\/[\w-]+$/);
  await expect(page.locator(".wk-timer")).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message" });
  await expect(message).toBeVisible({ timeout: 30_000 });

  await message.fill("What is a GPU minute?");
  await message.press("Enter");
  await expect(page.locator(".turn.model .turn-foot").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".turn.model .md").first()).not.toBeEmpty();

  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Stop the session" }).click();
  const ticket = page.getByRole("article", { name: "Receipt" });
  await expect(ticket).toBeVisible();
  await expect(ticket).toContainText("$0.00");

  expect(errors).toEqual([]);
});

test("catalog opens a model, and an unknown address is a 404", async ({ page }) => {
  await page.goto("/models?mock=speed:40");
  const first = page.locator(".cat-row a.cat-name").first();
  await expect(first).toBeVisible();
  await first.click();
  await expect(page).toHaveURL(/\/models\/[\w.-]+$/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

  await page.goto("/nothing-here");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Nothing at this address");
});

test("docs render from Markdown and link to the next page", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.locator(".docs-title")).toBeVisible();
  await expect(page.locator(".docs-md")).not.toBeEmpty();
  const next = page.locator(".docs-next");
  await expect(next).toBeVisible();
  await next.click();
  await expect(page).toHaveURL(/\/docs\/[\w-]+$/);

  await page.goto("/docs/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("No docs page with this name");
});
