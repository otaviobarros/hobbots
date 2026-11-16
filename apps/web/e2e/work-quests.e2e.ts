import { expectAccessible } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1596 (ADR 041): a Quest in the chat, on the fake runtime. One reply starts it with
// `start_work` and its card shows under that reply; a later reply finishes it with `finish_work`,
// the same card reads it ready for review, and the finishing reply leaves one line.

test.afterEach(stopAldricHub);

test("a hob starts a Quest with its card, and a later reply finishes it (#1596)", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  const card = main.getByRole("region", { name: "Quest: Winter market page" });

  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: "Message Aldric…" });
  await composer.fill(
    [
      "A page for the winter market",
      script("start_work", {
        title: "Winter market page",
        goal: "A landing page for the winter market.",
        done_when: ["The page is live", "It shows the map"],
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(card).toContainText("Quest · Running", { timeout: 30_000 });
  await expect(card).toContainText("A landing page for the winter market.");
  await expect(card.getByRole("listitem")).toHaveText(["The page is live", "It shows the map"]);
  await expectAccessible(page, card);

  await composer.fill(
    ["It's up", script("finish_work", { result: "The page is live with the map.", made: ["PR #12"] })].join("\n"),
  );
  await composer.press("Enter");
  await expect(card).toContainText("Quest · Ready for review", { timeout: 30_000 });
  await expect(card).toContainText("The page is live with the map.");
  await expect(
    main.getByRole("status").filter({ hasText: "Aldric finished Winter market page · PR #12" }),
  ).toBeVisible();
});
