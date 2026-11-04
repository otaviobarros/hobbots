import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

interface ThemeFile {
  readonly themes: readonly { readonly id: string }[];
  readonly color: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

const themes: ThemeFile = JSON.parse(
  readFileSync(new URL("../../../docs/design/themes.json", import.meta.url), "utf8"),
);

/** A token's `#rrggbb` value in a theme, as the browser reports a computed color. */
const rgb = (token: string, theme: string) => {
  const hex = themes.color[token]?.[theme] ?? "";
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
};

/** The page's background, and what a probe styled like a primary button shows and runs. */
const looks = (page: Page) =>
  page.evaluate(() => {
    const probe = document.createElement("span");
    probe.className = "animate-hb-bob bg-primary text-text-strong";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const seen = {
      background: getComputedStyle(document.body).backgroundColor,
      primary: style.backgroundColor,
      text: style.color,
      animation: style.animationName,
    };
    probe.remove();
    return seen;
  });

/** Starts a hub whose setup is finished and opens Settings on it. */
const openSettings = async (page: Page) => {
  hub = await startHub(dataDir);
  const response = await fetch(`${hub.url}/api/setup`, {
    method: "PATCH",
    headers: { ...hub.headers, "content-type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  if (!response.ok) throw new Error(`Finishing setup answered ${response.status}`);
  await page.goto(`${hub.url}/#/settings`);
};

// covers UX-003
test("[TC-UX-087] switching data-theme restyles the open screen without a reload, and Reduce motion still works", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await openSettings(page);
  const section = page.getByRole("region", { name: "This app" });
  await expect(section).toBeVisible();

  // The app opens in Workshop Night, today's look.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "workshop-night");
  expect((await looks(page)).background).toBe(rgb("ground", "workshop-night"));

  // Each theme restyles the screen in place: the page is never reloaded.
  await page.evaluate(() => Object.assign(window, { hobbotsThemeProbe: true }));
  for (const { id } of themes.themes) {
    await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), id);
    const now = await looks(page);
    expect(now.background, id).toBe(rgb("ground", id));
    expect(now.primary, id).toBe(rgb("lantern", id));
    expect(now.text, id).toBe(rgb("text-strong", id));
    expect(now.animation, id).toBe("hb-bob");
  }
  expect(await page.evaluate(() => "hobbotsThemeProbe" in window)).toBe(true);

  // Reduce motion stops every animation in any theme.
  await section.getByRole("switch", { name: "Reduce motion" }).click();
  expect((await looks(page)).animation).toBe("none");
});
