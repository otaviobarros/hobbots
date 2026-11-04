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
    const card = document.createElement("div");
    card.className = "cut lbl";
    document.body.append(probe, card);
    const style = getComputedStyle(probe);
    const shape = getComputedStyle(card);
    const seen = {
      background: getComputedStyle(document.body).backgroundColor,
      primary: style.backgroundColor,
      text: style.color,
      animation: style.animationName,
      corner: shape.borderTopLeftRadius,
      clipped: shape.clipPath !== "none",
      labelCase: shape.textTransform,
    };
    probe.remove();
    card.remove();
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
  await page.goto(`${hub.url}/#/settings/app`);
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
    // The skin: Lamplight rounds a card and keeps labels in sentence case; Workshop cuts and capitalizes.
    const workshop = id.startsWith("workshop-");
    expect(now.corner, id).toBe(workshop ? "0px" : "16px");
    expect(now.clipped, id).toBe(workshop);
    expect(now.labelCase, id).toBe(workshop ? "uppercase" : "none");
  }
  expect(await page.evaluate(() => "hobbotsThemeProbe" in window)).toBe(true);

  // Reduce motion stops every animation in any theme.
  await section.getByRole("switch", { name: "Reduce motion" }).click();
  expect((await looks(page)).animation).toBe("none");
});

// covers UX-003
test("[TC-UX-088] the first run opens in Workshop Night, and a saved theme survives a restart", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByRole("region", { name: "This app" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "workshop-night");
  expect((await looks(page)).background).toBe(rgb("ground", "workshop-night"));

  // Saved the way the theme picker saves it, then Hobbots opens again.
  await page.evaluate(() => localStorage.setItem("hobbots.theme", JSON.stringify("lamplight-paper")));
  await page.reload();
  await expect(page.getByRole("region", { name: "This app" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lamplight-paper");
  expect((await looks(page)).background).toBe(rgb("ground", "lamplight-paper"));

  // A value that is not a theme falls back to Workshop Night.
  await page.evaluate(() => localStorage.setItem("hobbots.theme", JSON.stringify("sepia")));
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "workshop-night");
});

// covers UX-003
test("[TC-UX-124] This app picks the look, Dark or Light and the text size by hand, and keeps them on this device", async ({
  page,
}) => {
  await openSettings(page);
  const appearance = page.getByRole("region", { name: "Appearance" });
  await expect(appearance.getByRole("radio", { name: /Workshop/ })).toBeChecked();
  await expect(appearance.getByRole("radio", { name: "Dark", exact: true })).toHaveAttribute("aria-checked", "true");

  // The look keeps the mode, and the mode keeps the look.
  await appearance.getByText("Lamplight", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lamplight-dusk");
  await appearance.getByRole("radio", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "lamplight-paper");
  expect((await looks(page)).background).toBe(rgb("ground", "lamplight-paper"));
  await appearance.getByText("Workshop", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "workshop-daylight");

  // Larger scales the whole app, which still fits the window.
  await appearance.getByRole("radio", { name: "Larger" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "larger");
  // The frame is sized to the screen, so it must end at the window's bottom edge, not past it.
  const fits = () =>
    page.evaluate(() => ({
      zoom: getComputedStyle(document.documentElement).zoom,
      overflows:
        (document.querySelector("#root")?.firstElementChild?.getBoundingClientRect().bottom ?? 0) > innerHeight + 1,
    }));
  expect(await fits()).toEqual({ zoom: "1.125", overflows: false });

  // Both survive a restart, and Standard takes Larger back.
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "workshop-daylight");
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "larger");
  await page.getByRole("region", { name: "Appearance" }).getByRole("radio", { name: "Standard" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-text-size", /.*/);
});
