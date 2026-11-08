import { expect, test } from "@playwright/test";

const content = (page: import("@playwright/test").Page, selector: string) =>
  page.locator(selector).getAttribute("content");

test("[TC-GEN-014] shows the share card and icons, and serves every file they and the page name", async ({
  page,
  request,
}) => {
  // covers #186 and #1224
  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://hobbots.app/");
  expect(await content(page, 'meta[name="twitter:card"]')).toBe("summary_large_image");
  expect(await content(page, 'meta[property="og:title"]')).toBe(await page.title());
  expect(await content(page, 'meta[property="og:description"]')).toBe(await content(page, 'meta[name="description"]'));

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
    ...(await page.locator("img[src^='/']").evaluateAll((images) => images.map((i) => i.getAttribute("src")))),
  ]) {
    const response = await request.get(path ?? "");
    expect(response.status(), path ?? "").toBe(200);
  }
  expect(await (await request.get("/robots.txt")).text()).toContain("Sitemap: https://hobbots.app/sitemap.xml");
});

test("[TC-GEN-015] keeps a build that is not for production out of search results", async ({ page }) => {
  // covers #186. The local build has no CLOUDFLARE_ENV, like a pull request preview.
  await page.goto("/");
  expect(await content(page, 'meta[name="robots"]')).toBe("noindex, nofollow");
});

test("[TC-GEN-1224-08] describes the app and its questions to search engines and language models", async ({
  page,
  request,
}) => {
  // covers #1224
  await page.goto("/");
  const data = await page
    .locator('script[type="application/ld+json"]')
    .evaluateAll((scripts) => scripts.map((script) => JSON.parse(script.textContent ?? "")));
  const app = data.find((item) => item["@type"] === "SoftwareApplication");
  expect(app.isAccessibleForFree).toBe(true);
  expect(app.offers.price).toBe("0");
  const faq = data.find((item) => item["@type"] === "FAQPage");
  expect(faq.mainEntity.map((question: { name: string }) => question.name)).toEqual(
    await page.locator("#faq summary").allTextContents(),
  );
  // Every caption of the tour is in the page, for crawlers that run no script.
  expect(await page.locator("#tour [data-tour-cap]").count()).toBe(await page.locator("#tour [data-tour-tab]").count());
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toContain(`Current version: ${app.softwareVersion} beta`);
});

test("[TC-GEN-1224-09] serves every picture from a hashed name, so it can be cached for good", async ({ page }) => {
  // covers #1224: a changed picture gets a new URL, so no cache purge is needed
  await page.goto("/");
  const sources = await page
    .locator("img[src], img[srcset], video[poster]")
    .evaluateAll((elements) =>
      elements.flatMap((element) =>
        [
          element.getAttribute("src"),
          element.getAttribute("poster"),
          ...(element.getAttribute("srcset") ?? "").split(","),
        ]
          .map((value) => value?.trim().split(" ")[0])
          .filter((value): value is string => Boolean(value)),
      ),
    );
  expect(sources.length).toBeGreaterThan(20);
  for (const source of sources) expect(source).toMatch(/^\/_astro\/[\w-]+\.[\w-]+\.webp$/);
});
