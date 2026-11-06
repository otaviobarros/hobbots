import { expect, test } from "./hub.ts";

// Text that fades in slowly, inside a box that fades in too, beside a dot that pulses for ever: a
// scan must check the text once the fades are done and must not wait on the dot, which holds no
// text and never ends (#1000).
const FADING = `<!doctype html>
<html lang="en">
  <head>
    <title>Fading</title>
    <style>
      @keyframes in { from { opacity: 0; } to { opacity: 1; } }
      @keyframes pulse { from { opacity: 0.2; } to { opacity: 1; } }
      body { background: #fff; color: #1a1a1a; font: 16px sans-serif; }
      .box { animation: in 1.5s linear both; }
      .dot { display: inline-block; width: 8px; height: 8px; background: #888; animation: pulse 1s linear infinite alternate; }
    </style>
  </head>
  <body>
    <main>
      <section class="box" aria-label="Fading box"><p>Text that fades in</p></section>
      <span class="dot" aria-hidden="true"></span>
    </main>
  </body>
</html>`;

// covers STD-TEST-007, STD-TEST-009, #1000
test("[TC-GEN-390] an accessibility scan checks text that fades in once the fade has finished, on the page and in one part", async ({
  page,
  scan,
}) => {
  // Served from a secure origin, as the app is: a scan of one part marks it with a random ID.
  const url = "http://localhost/fading";
  await page.route(url, (route) => route.fulfill({ contentType: "text/html", body: FADING }));
  await page.goto(url);
  await scan();
  // Read once, not retried: the scan itself must have waited for the fade.
  const box = page.getByRole("region", { name: "Fading box" });
  const opacity = () => box.evaluate((element) => getComputedStyle(element).opacity);
  expect(await opacity()).toBe("1");

  await page.reload();
  await scan(page.getByText("Text that fades in"));
  expect(await opacity()).toBe("1");
});
