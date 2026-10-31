import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";

/** The rows the local D1 database that `astro preview` uses holds for an email, in any case. */
const storedRows = (email: string): { wants_more_platforms: number; source: string }[] => {
  const sql = `SELECT wants_more_platforms, source FROM waitlist WHERE lower(email) = '${email}'`;
  const output = execFileSync(
    "pnpm",
    ["exec", "wrangler", "d1", "execute", "WAITLIST_DB", "--local", "--json", "--command", sql],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  return JSON.parse(output)[0].results;
};

// What the page reported, printed when a test fails: Turnstile and the action run outside the test's view.
const notes = new WeakMap<object, string[]>();

// Each test signs up from its own IP address, so the limit of 5 sign-ups a minute applies per test.
test.beforeEach(async ({ page }) => {
  const seen: string[] = [];
  notes.set(page, seen);
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      seen.push(`console ${message.type()}: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/_actions/")) seen.push(`action ${response.status()}`);
  });
  const ip = `198.51.100.${randomInt(1, 255)}`;
  await page.route("**/_actions/**", (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus) return;
  const alerts = await page.getByRole("alert").allTextContents();
  console.log([...(notes.get(page) ?? []), `alerts: ${JSON.stringify(alerts.filter(Boolean))}`].join("\n"));
});

test("[TC-GEN-008] joins the wait-list from the hero form", async ({ page }) => {
  // covers #182: anyone can join the wait-list
  await page.goto("/");
  await page.getByLabel("Email address").fill("pip@example.com");
  await page.getByRole("button", { name: "Join the wait-list" }).click();
  await expect(page.getByText("You're on the list!")).toBeVisible();
  await expect(page.getByText(/We'll write to pip@example.com/)).toBeVisible();
});

test("[TC-GEN-011] joins again with the same email in other case, shows the same message and stores it once", async ({
  page,
}) => {
  // covers #182 and #185: joining again shows the same success message and stores nothing new
  const email = `pip-${randomUUID()}@example.com`;
  await page.goto("/");
  const joinWith = async (typed: string) => {
    await page.getByLabel("Email address").fill(typed);
    await page.getByRole("button", { name: "Join the wait-list" }).click();
    await expect(page.getByText("You're on the list!")).toBeVisible();
    return page.getByText(`We'll write to ${email}`).textContent();
  };
  const first = await joinWith(email);
  expect(storedRows(email)).toHaveLength(1);
  await page.getByRole("button", { name: "Use a different email" }).click();
  await expect(page.getByLabel("Email address")).toBeFocused();
  expect(await joinWith(email.toUpperCase())).toBe(first);
  expect(storedRows(email)).toHaveLength(1);
});

test("[TC-GEN-012] joins from the roll form with the hero's platforms box ticked", async ({ page }) => {
  // covers #185: the stored choice matches the success message, whichever form was used
  const email = `pip-${randomUUID()}@example.com`;
  await page.goto("/");
  await page.getByLabel("Also tell me about the Windows and phone apps").check();
  await page.getByLabel("Email for the wait-list").fill(email);
  await page.getByRole("button", { name: /spot/ }).click();
  await expect(page.getByText(/is saved\. See you at launch\./)).toBeVisible();
  expect(storedRows(email)).toEqual([{ wants_more_platforms: 1, source: "roll" }]);
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
