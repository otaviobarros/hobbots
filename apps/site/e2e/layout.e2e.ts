import { expect, test } from "@playwright/test";

test("[TC-GEN-016] keeps a space before the email link in the wait-list note", async ({ page }) => {
  // covers #246
  await page.goto("/");
  await expect(page.locator(".help").first()).toContainText(/write to \S+@hobbots\.app\./);
});

test("[TC-GEN-017] never scrolls sideways on a phone while the hob walks in", async ({ page }) => {
  // covers #246: the walk-in starts off the right edge of the screen
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.locator("#coming").scrollIntoViewIfNeeded();
  await expect(page.locator("#coming [data-companion]")).toBeVisible();
  const widest = await page.evaluate(async () => {
    const root = document.documentElement;
    let max = 0;
    for (let i = 0; i < 12; i += 1) {
      max = Math.max(max, root.scrollWidth - root.clientWidth);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return max;
  });
  expect(widest).toBe(0);
});
