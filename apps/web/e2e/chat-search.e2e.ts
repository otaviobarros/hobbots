import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #509: the magnifier in the chat header searches this chat, marks each match, scrolls the
// chat to the one you pick, clears on the first Escape and closes on the next; with nothing found it offers all of the hob's chats, searching for the same words.

test.afterEach(stopAldricHub);

// covers CH-001, UX-001
test("[TC-CH-261] Search this chat lists the messages that match, opens the one you pick, and clears then closes on Escape", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  for (const prompt of ["Draft the spring banner copy", "Plan the sale emails"]) {
    await composer.fill(prompt);
    await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText(`Echo: ${prompt}`).first()).toBeVisible({ timeout: 20_000 });
  }

  // The magnifier opens the box, focused; each match says who and when, with the words marked.
  const toggle = page.getByRole("button", { name: "Search this chat" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const box = page.getByRole("searchbox", { name: "Search this chat" });
  await expect(box).toBeFocused();
  await box.fill("BANNER");
  const matches = page.getByRole("list", { name: "Matches in this chat" });
  const mine = matches.getByRole("button", { name: /^Y\s*You · / });
  await expect(mine).toContainText("Draft the spring banner copy");
  await expect(mine.locator("mark")).toHaveText("banner");
  await expect(matches.getByRole("button", { name: /^Aldric · / }).first()).toContainText("banner");
  await expect(matches).not.toContainText("sale emails");
  await expect(page.getByRole("search").getByRole("status")).toHaveText(/^\d+ messages?$/);

  // Picking one opens it in the chat and closes the box.
  await mine.click();
  await expect(page).toHaveURL(/message=/);
  await expect(box).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Nothing found offers a search across all of Aldric's chats.
  await toggle.click();
  await box.fill("lighthouse");
  await expect(page.getByText("Nothing in this chat says “lighthouse”.")).toBeVisible();
  const everywhere = page.getByRole("link", { name: "Search all of Aldric's chats" });
  await expect(everywhere).toHaveAttribute("href", `/#/hobs/${aldric}?q=lighthouse`);

  // The first Escape clears the words and keeps the box open; the next closes it and gives focus
  // back to the magnifier.
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await box.press("Escape");
  await expect(box).toBeHidden();
  await expect(toggle).toBeFocused();

  // The link opens Aldric's Chats already searching for the same words.
  await toggle.click();
  await box.fill("lighthouse");
  await everywhere.click();
  await expect(page.getByRole("searchbox", { name: "Search Aldric's chats" })).toHaveValue("lighthouse");
});
