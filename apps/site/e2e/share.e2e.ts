import { expect, test } from "@playwright/test";

const content = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(selector).getAttribute("content");

// The share card, icons and crawler files that #186 adds. The local build has no CLOUDFLARE_ENV, like a preview.
test("[TC-GEN-014] shows the share card and icons, and serves every file they name", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://hobbots.app/");
  expect(await content(page, 'meta[name="twitter:card"]')).toBe("summary_large_image");
  expect(await content(page, 'meta[property="og:title"]')).toBe(await page.title());
  expect(await content(page, 'meta[property="og:description"]')).toBe(
    await page.locator("#teaser .lede").textContent(),
  );

  const image = await content(page, 'meta[property="og:image"]');
  expect(image).toBe("https://hobbots.app/og.png");
  const icons = await page
    .locator('link[rel~="icon"]')
    .evaluateAll((links) => links.map((l) => l.getAttribute("href")));
  for (const path of [
    new URL(image ?? "").pathname,
    ...icons,
    "/apple-touch-icon.png",
    "/robots.txt",
    "/sitemap.xml",
  ]) {
    const response = await request.get(path ?? "");
    expect(response.status(), path ?? "").toBe(200);
  }
  expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap: https://hobbots.app/sitemap.xml");
});

test("[TC-GEN-015] keeps a build that is not for production out of search results", async ({ page }) => {
  await page.goto("/");
  expect(await content(page, 'meta[name="robots"]')).toBe("noindex, nofollow");
});
