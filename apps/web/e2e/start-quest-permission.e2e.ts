import { expectAccessible } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1597 (ADR 041): the Start a Quest permission, on the fake runtime. Set to Ask on Aldric's
// Permissions tab, his `start_work` waits on a card that shows the Quest he suggests; Always allow
// starts it, and the Permissions tab reads Allow again.

test.afterEach(stopAldricHub);

test("under Ask a hob suggests its Quest, and Always allow starts it and sets Start a Quest to Allow (#1597)", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  const answer = () => page.getByRole("region", { name: "Quests" }).getByRole("radiogroup", { name: "Start a Quest" });

  await page.goto(`${url}/#/hobs/${aldric}/profile?tab=permissions`);
  await expect(answer().getByRole("radio", { name: "Allow" })).toBeChecked();
  await answer().getByRole("radio", { name: "Ask" }).click();
  await expect(answer().getByRole("radio", { name: "Ask" })).toBeChecked();

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
  const card = page.getByRole("region", { name: "Aldric asks permission" });
  await expect(card).toContainText("Suggested Quest", { timeout: 30_000 });
  await expect(card).toContainText("Winter market page");
  await expect(card).toContainText("A landing page for the winter market.");
  await expect(card.getByRole("listitem")).toHaveText(["The page is live", "It shows the map"]);
  await expectAccessible(page, card);

  await card.getByRole("button", { name: "Always allow" }).click();
  await expect(card.getByRole("status")).toContainText("set to Allow on Aldric's Permissions tab");
  const quest = page.getByRole("main", { name: "Chat" }).getByRole("region", { name: "Quest: Winter market page" });
  await expect(quest).toContainText("Quest · Running", { timeout: 30_000 });

  await page.goto(`${url}/#/hobs/${aldric}/profile?tab=permissions`);
  await expect(answer().getByRole("radio", { name: "Allow" })).toBeChecked();
});
