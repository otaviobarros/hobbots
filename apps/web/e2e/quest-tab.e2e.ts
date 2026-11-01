import { expect, test } from "@playwright/test";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// covers CH-005, OR-006, UX-001
test("[TC-CH-190] the Quest tab shows the whole tree live, holds its controls and keeps a pinned Quest in every thread", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  // The tab is the control room: every Task, its owner, where it stands and who it waits on.
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Plan the Black Friday campaign" });
  await expect(room).toContainText("Aldric's quest");
  const tasks = room.getByRole("list", { name: "Tasks of Plan the Black Friday campaign" });
  await expect(tasks.getByRole("button", { name: /Quill · Draft the landing copy/ })).toBeVisible();
  const build = tasks.getByRole("button", { name: /Ada · Build the campaign/ });
  await expect(build).toContainText("waiting on Quill");
  await expect(build).toContainText("you", { timeout: 15_000 });

  // A row opens its Task in the drawer and the tab shows what applies to it, held until the hub
  // can confirm each outcome.
  await build.click();
  await expect(page.getByRole("complementary", { name: "Build the campaign, Task details" })).toBeVisible();
  await expect(build).toHaveAttribute("aria-current", "true");
  const controls = room.getByRole("region", { name: "Controls for Build the campaign" });
  await expect(controls.getByRole("button", { name: "Reassign" })).toBeDisabled();
  await expect(controls.getByRole("button", { name: "Cancel Task" })).toBeDisabled();
  await expect(controls.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(room.getByRole("button", { name: "Cancel Quest" })).toBeDisabled();
  await expect(room).toContainText("Retry, Reassign and Cancel arrive once the hub can confirm what each one did.");

  // Pinned, the Quest stays in the tab of another thread, and its Tasks still open there.
  const pin = room.getByRole("button", { name: "Pin" });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(pin).toHaveText("Pinned");
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await page.getByRole("textbox", { name: /^Message Aldric/ }).fill("Something else");
  await page.getByRole("textbox", { name: /^Message Aldric/ }).press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(room).toContainText("Pinned from another thread");
  await room.getByRole("button", { name: /Quill · Draft the landing copy/ }).click();
  await expect(page.getByRole("complementary", { name: "Draft the landing copy, Task details" })).toBeVisible();

  // The answer goes back from the card in the Quest's own thread, and the tab follows live.
  await room.getByRole("link", { name: "Open its thread" }).click();
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(tasks.getByRole("button", { name: /Ada · Build the campaign/ })).toContainText("Done", {
    timeout: 15_000,
  });
  await expect(room.getByRole("button", { name: "Cancel Quest" })).toHaveCount(0, { timeout: 15_000 });

  // Unpinned, it leaves the other thread's tab.
  await room.getByRole("button", { name: "Pin" }).click();
  await page.goBack();
  await expect(page.getByText("No Quest in this thread")).toBeVisible();

  // A pin the hub no longer has says so and can be unpinned.
  await page.evaluate(() => localStorage.setItem("quest.pinned", JSON.stringify(["gone"])));
  await page.reload();
  await expect(page.getByText("A pinned Quest is no longer on this hub.")).toBeVisible();
  await page.getByRole("button", { name: "Unpin" }).click();
  await expect(page.getByText("A pinned Quest is no longer on this hub.")).toBeHidden();
});
