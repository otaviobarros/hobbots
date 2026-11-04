import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// covers CH-005, UX-001, UX-005
test("[TC-UX-150] a hob's History lists what it and its party did by day, filters it and opens where it happened", async ({
  page,
}) => {
  const { url, aldric } = await questHub();

  // A hob that has done nothing says so, without filters to pick from.
  await page.goto(`${url}/#/hobs/${aldric}?tab=history`);
  const history = page.getByRole("tabpanel", { name: "History" });
  await expect(history.getByText("Nothing yet.")).toBeVisible();
  await expect(history.getByRole("group", { name: "Show" })).toHaveCount(0);

  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  await page.goto(`${url}/#/hobs/${aldric}?tab=history`);
  const today = history.getByRole("region", { name: "Today" });
  await expect(today.getByText(/^You asked for “.*Black Friday/)).toBeVisible({
    timeout: 15_000,
  });
  // A lead's History holds the work of the hobs on its Quest.
  await expect(history.getByText("Includes the work of the hobs on its quests")).toBeVisible();
  await expect(today.getByText(/^Picked up “.+” from Aldric$/).first()).toBeVisible({ timeout: 15_000 });

  // Quests shows only the Quest's own events, and the filter stays in the address.
  await history.getByRole("radio", { name: "Quests" }).click();
  await expect(page).toHaveURL(/show=quest/);
  await expect(today.getByText(/^Started /)).toBeVisible();
  await expect(today.getByText(/^You asked for/)).toHaveCount(0);

  // Your decisions holds what you asked for; its Chat opens that chat.
  await history.getByRole("radio", { name: "Your decisions" }).click();
  const asked = today.getByRole("listitem").filter({ hasText: "You asked for" });
  await asked.getByRole("link", { name: "Chat" }).click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
});
