import { expect, type Page, test } from "@playwright/test";

/** The widest the page got past the screen while scrolling from top to bottom, in pixels. */
const sidewaysScroll = (page: Page) =>
  page.evaluate(async () => {
    const root = document.documentElement;
    let max = 0;
    for (let y = 0; y <= root.scrollHeight; y += 400) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 30));
      max = Math.max(max, root.scrollWidth - root.clientWidth);
    }
    return max;
  });

test("[TC-GEN-016] keeps a space before the email link in the wait-list note", async ({ page }) => {
  // covers #246
  await page.goto("/");
  await expect(page.locator(".help").first()).toContainText(/write to \S+@hobbots\.app\./);
});

for (const { width, height } of [
  { width: 320, height: 640 },
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`[TC-GEN-017] never scrolls sideways at ${width} pixels wide`, async ({ page }) => {
    // covers #246 and #1224: the hobs walk in from off screen, and the screenshots lift in from the side
    await page.setViewportSize({ width, height });
    await page.goto("/");
    expect(await sidewaysScroll(page)).toBe(0);
  });
}

test("[TC-GEN-1224-01] plays the hero's Quest: answer Ada, and the work is done by morning", async ({ page }) => {
  // covers #1224
  await page.goto("/");
  const stage = page.getByRole("region", { name: /Try it/ });
  await expect(stage.getByText("4 of 5 done")).toBeVisible();
  await stage.getByRole("button", { name: /Dec 18 for everyone/ }).click();
  await expect(stage.getByText("Ada: Got it. Dec 18 for everyone. Telling Quill.")).toBeFocused();
  await expect(stage.getByText("Good morning. It’s done.")).toBeVisible();
  await expect(stage.getByText("Good morning. It’s done.")).toBeFocused();
  await expect(stage.getByText("5 of 5 done")).toBeVisible();
  await stage.getByRole("button", { name: "Play again" }).click();
  await expect(stage.getByRole("button", { name: /Dec 12 for international/ })).toBeFocused();
});

test("[TC-GEN-1224-02] plays the tour by itself, and stops when a screen is picked", async ({ page }) => {
  // covers #1224
  await page.goto("/");
  const tour = page.locator("#tour");
  await expect(tour.getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
  await expect(tour.getByRole("button", { name: "Quest room" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 8000,
  });
  await expect(tour.getByText("Coordination you can watch")).toBeVisible();
  await tour.getByRole("button", { name: "Skills" }).click();
  await expect(tour.getByText("Your standards, every time")).toBeVisible();
  await expect(tour.getByRole("img", { name: /The Skills page/ })).toBeVisible();
  await tour.getByRole("button", { name: "Play the tour" }).click();
  await expect(tour.getByRole("button", { name: "Pause the tour" })).toBeFocused();
  await expect(tour.getByRole("button", { name: "A hob’s page" })).toHaveAttribute("aria-pressed", "true", {
    timeout: 8000,
  });
});

test("[TC-GEN-1224-03] opens the video over the page and closes it with Escape, the button or a click outside", async ({
  page,
}) => {
  // covers #1224. The video itself is on media.hobbots.app; the test never fetches it.
  await page.route("https://media.hobbots.app/**", (route) => route.abort());
  await page.goto("/");
  const opener = page.locator("#hero-title ~ .watch");
  const dialog = page.getByRole("dialog", { name: /Hobbots at work/ });
  await opener.click();
  await expect(dialog).toBeVisible();
  const video = page.locator("[data-video] video");
  await expect(video).toHaveAttribute("src", /^https:\/\/media\.hobbots\.app\/video\//);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  expect(await video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);

  await page.getByRole("button", { name: /Play the video/ }).click();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole("button", { name: /Play the video/ }).click();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
});

test("[TC-GEN-1224-04] offers the release's installers, with Linux marked experimental", async ({ page }) => {
  // covers #1224
  await page.goto("/");
  const download = page.locator("#download");
  const release = /^https:\/\/github\.com\/otaviobarros\/hobbots\/releases\/download\/v\d+\.\d+\.\d+\/Hobbots-/;
  await expect(download.getByRole("link", { name: "Mac with Apple silicon" })).toHaveAttribute(
    "href",
    new RegExp(`${release.source}[\\d.]+-arm64\\.dmg$`),
  );
  await expect(download.getByRole("link", { name: "Mac with Intel" })).toHaveAttribute(
    "href",
    new RegExp(`${release.source}[\\d.]+-x64\\.dmg$`),
  );
  await expect(download.getByText("Experimental. Not fully tested yet.")).toBeHidden();
  await page.getByRole("link", { name: /^Linux/ }).click();
  await expect(download.getByRole("button", { name: /Linux/ })).toHaveAttribute("aria-pressed", "true");
  await expect(download.getByText("Experimental. Not fully tested yet.")).toBeVisible();
  await expect(download.getByRole("link", { name: ".deb for Ubuntu and Debian" })).toHaveAttribute(
    "href",
    new RegExp(`${release.source}[\\d.]+-amd64\\.deb$`),
  );
  await expect(download.getByRole("link", { name: ".rpm for Fedora" })).toHaveAttribute(
    "href",
    new RegExp(`${release.source}[\\d.]+-x86_64\\.rpm$`),
  );
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("[TC-GEN-1224-05] opens the menu, and copies the link to send to a computer", async ({ page, context }) => {
    // covers #1224
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.evaluate(() => {
      // Desktop Chromium has no share sheet; the page falls back to copying, as Firefox does.
      Object.defineProperty(navigator, "share", { value: undefined });
    });
    const menu = page.getByRole("button", { name: "Menu" });
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("navigation").getByRole("link", { name: "Memory" }).click();
    await expect(menu).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Send the link to my computer" }).first().click();
    await expect(
      page.getByRole("status").filter({ hasText: "Link copied. Open hobbots.app on your computer." }),
    ).toHaveCount(1);
    await expect(page.locator("[data-share-toast]")).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://hobbots.app");
  });

  test("[TC-GEN-1224-07] opens and closes the video with taps", async ({ page }) => {
    // covers #1224: the video works with touch
    await page.route("https://media.hobbots.app/**", (route) => route.abort());
    await page.goto("/");
    const dialog = page.getByRole("dialog", { name: /Hobbots at work/ });
    await page.getByRole("button", { name: /Watch Hobbots at work/ }).tap();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).tap();
    await expect(dialog).toBeHidden();
  });
});

test.describe("with Reduce motion", () => {
  test.use({ reducedMotion: "reduce" });

  test("[TC-GEN-1224-06] stops every animation, the tour included", async ({ page }) => {
    // covers #1224: nothing moves by itself with Reduce motion
    await page.goto("/");
    await expect(page.getByRole("button", { name: /Pause the tour|Play the tour/ })).toBeHidden();
    await expect(page.getByRole("button", { name: /Dec 12 for international/ })).toBeVisible();
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    await page.waitForTimeout(5500);
    await expect(page.locator("#tour").getByRole("button", { name: "Home" })).toHaveAttribute("aria-pressed", "true");
  });
});
