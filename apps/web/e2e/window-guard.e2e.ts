import { expect, test } from "./hub.ts";

// The guard behind STD-TEST-010 (#1026): what it finds on one screen stays found after the test
// moves on, by navigating to a still screen or reloading. These pages break the rule on purpose,
// so each test forgets what was found once it has checked it.

const page = (body: string) => `<!doctype html>
<html lang="en">
  <head><title>Guard</title><style>html, body { margin: 0; } .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; }</style></head>
  <body><div id="root">${body}</div></body>
</html>`;

/** A panel holding more than fits, with a label placed outside it at the end, as #1026 had. */
const ESCAPING = page(
  `<main style="height: 100vh; overflow-y: auto"><div style="height: 3000px"></div><span class="sr">Done</span></main>`,
);
/** A window taller than the viewport, with nothing escaping. */
const TALL = page(`<div style="height: 3000px"></div>`);
const STILL = page(`<main style="height: 100vh; overflow-y: auto"><p>Nothing to scroll.</p></main>`);

const ORIGIN = "http://guard.test";

test.beforeEach(async ({ context }) => {
  const pages: Record<string, string> = { "/escaping": ESCAPING, "/tall": TALL, "/still": STILL };
  await context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: pages[new URL(route.request().url()).pathname] ?? STILL }),
  );
});

// covers STD-TEST-010, #1026
test("[TC-GEN-1026-02] a label that escaped its panel, and the window it stretched, stay found after the test moves to a still screen", async ({
  page: tab,
  windowStill,
}) => {
  await tab.goto(`${ORIGIN}/escaping`);
  await tab.goto(`${ORIGIN}/still`);
  const found = windowStill.breaks().join("\n");
  expect(found).toContain('<span class="sr"> is placed outside the panel it scrolls in');
  expect(found).toMatch(/the window is \d+px tall in a 720px viewport/);
  expect(found).toContain(`on ${ORIGIN}/escaping`);
  windowStill.forget();
  await windowStill.check(tab);
  expect(windowStill.breaks()).toEqual([]);
});

// covers STD-TEST-010, #1026
test("[TC-GEN-1026-03] a window scrolled before a reload stays found after it", async ({ page: tab, windowStill }) => {
  await tab.goto(`${ORIGIN}/tall`);
  await tab.evaluate(() => window.scrollTo(0, 500));
  await tab.reload();
  await tab.evaluate(() => window.scrollTo(0, 0));
  expect(windowStill.breaks().join("\n")).toMatch(/the window was scrolled to 500px/);
  windowStill.forget();
  await tab.goto(`${ORIGIN}/still`);
  await windowStill.check(tab);
  expect(windowStill.breaks()).toEqual([]);
});
