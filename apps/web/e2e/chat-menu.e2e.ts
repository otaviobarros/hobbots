import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #510: the chat header's ⋯ menu renames the chat in place, pins it to the top, searches it,
// opens the hob's page, and archives it with Undo.

test.afterEach(stopAldricHub);

// covers CH-001, UX-001
test("[TC-CH-262] the chat menu renames the chat in the header, pins it, searches it, opens the hob's page and archives it with Undo", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  // Two chats, so archiving this one moves to the other.
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  for (const prompt of ["Plan the sale emails", "Draft the spring banner copy"]) {
    await page.goto(`${url}/#/hobs/${aldric}/new`);
    await composer.fill(prompt);
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText(`Echo: ${prompt}`).first()).toBeVisible({ timeout: 20_000 });
  }
  const chat = page.url();
  const header = page.getByRole("main", { name: "Chat" }).locator("header").first();
  const menu = header.getByRole("button", { name: "More for this thread" });
  const item = (name: string | RegExp) => page.getByRole("menuitem", { name });

  // Rename turns the title into a field; Escape keeps the old title, Enter saves the new one.
  await menu.click();
  await item("Rename").click();
  const field = header.getByRole("textbox", { name: /^New title for/ });
  await expect(field).toBeFocused();
  await field.fill("Not this");
  await field.press("Escape");
  await expect(header).toContainText("Draft the spring banner copy");
  await menu.click();
  await item("Rename").click();
  await field.fill("Spring banner");
  await field.press("Enter");
  await expect(field).toBeHidden();
  await expect(header).toContainText("Spring banner");
  await expect(page.getByRole("link", { name: /Spring banner/ }).first()).toBeVisible();

  // Pin to the top shows the lantern pin beside the title; the menu then offers Unpin.
  await menu.click();
  await item("Pin to the top").click();
  await expect(header.getByRole("img", { name: "Pinned to the top" })).toBeVisible();
  await menu.click();
  await expect(item("Unpin")).toBeVisible();
  await page.keyboard.press("Escape");

  // Search this chat opens the same search box as the magnifier.
  await menu.click();
  await item("Search this chat").click();
  const box = page.getByRole("searchbox", { name: "Search this chat" });
  await expect(box).toBeVisible();
  await box.press("Escape");
  await expect(box).toBeHidden();

  // The hob's page.
  await menu.click();
  await item("Aldric's page").click();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}$`));

  // Archive, in rose, leaves a toast whose one action is Undo, which brings the chat back.
  await page.goto(chat);
  await menu.click();
  await item(/^Archive thread/).click();
  const toast = page.getByRole("status").filter({ hasText: "Archived “Spring banner”." });
  await expect(toast).toBeVisible();
  await expect(page.getByRole("button", { name: /Open Archive/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo archive of Spring banner" }).click();
  await expect(page).toHaveURL(chat);
  await expect(header).toContainText("Spring banner");
});
