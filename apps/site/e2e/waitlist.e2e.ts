import { expect, test } from "@playwright/test";

test("[TC-GEN-008] joins the wait-list from the hero form", async ({ page }) => {
  // covers #182: anyone can join the wait-list
  await page.goto("/");
  await page.getByLabel("Email address").fill("pip@example.com");
  await page.getByRole("button", { name: "Join the wait-list" }).click();
  await expect(page.getByText("You're on the list!")).toBeVisible();
  await expect(page.getByText(/We'll write to pip@example.com/)).toBeVisible();
});

test("[TC-GEN-011] joins again with the same email and shows the same message", async ({ page }) => {
  // covers #182: joining again shows the same success message (storing once is #185)
  await page.goto("/");
  const joinWith = async () => {
    await page.getByLabel("Email address").fill("pip@example.com");
    await page.getByRole("button", { name: "Join the wait-list" }).click();
    await expect(page.getByText("You're on the list!")).toBeVisible();
    return page.getByText(/We'll write to pip@example.com/).textContent();
  };
  const first = await joinWith();
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email address")).toBeFocused();
  expect(await joinWith()).toBe(first);
});

test("[TC-GEN-009] refuses an invalid email and says why", async ({ page }) => {
  // covers #182: the form checks the email
  await page.goto("/");
  const email = page.getByLabel("Email address");
  await email.fill("pip@");
  await page.getByRole("button", { name: "Join the wait-list" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That email looks incomplete" })).toBeVisible();
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toBeFocused();
  await expect(page.getByText("You're on the list!")).toBeHidden();
});

test.describe("with Reduce motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("[TC-GEN-010] joins with every animation stopped", async ({ page }) => {
    // covers #182: every animation stops with Reduce motion
    await page.goto("/");
    await page.getByLabel("Email address").fill("pip@example.com");
    await page.getByRole("button", { name: "Join the wait-list" }).click();
    await expect(page.getByText("You're on the list!")).toBeVisible();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
  });
});
