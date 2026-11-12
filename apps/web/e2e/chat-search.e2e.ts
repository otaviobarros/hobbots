import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issues #509 and #1386: the magnifier in the chat header opens Find, which lists the messages of
// this chat that match, with the words marked, and opens the one you pick; the first Escape clears
// the words and the next closes it.

test.afterEach(stopAldricHub);

// covers CH-001, UX-001
test("[TC-CH-261] Find lists the messages of this chat that match, opens the one you pick, and clears then closes on Escape", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  for (const prompt of ["Draft the spring banner copy", "Plan the sale emails"]) {
    await composer.fill(prompt);
    await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText(`Echo: ${prompt}`).first()).toBeVisible({ timeout: 20_000 });
  }

  // The magnifier opens the box, focused; each match says who and when, with the words marked.
  const toggle = page.getByRole("button", { name: "Find", exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const box = page.getByRole("searchbox", { name: "Find" });
  await expect(box).toBeFocused();
  await box.fill("BANNER");
  const found = page.getByRole("region", { name: "What Find found" });
  const messages = found.getByRole("region", { name: /^Messages · / });
  const mine = messages.getByRole("button", { name: /Message · You · / });
  await expect(mine).toContainText("Draft the spring banner copy");
  await expect(mine.locator("mark")).toHaveText("banner");
  await expect(messages.getByRole("button", { name: /Message · Aldric · / }).first()).toContainText("banner");
  await expect(messages).not.toContainText("sale emails");
  await expect(found.getByRole("button", { name: "Ask Aldric: “BANNER” Enter" })).toBeVisible();

  // Picking one opens it in the chat and closes the box.
  await mine.click();
  await expect(page).toHaveURL(/message=/);
  await expect(box).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // Nothing found says so, and offers to ask Aldric.
  await toggle.click();
  await box.fill("lighthouse");
  await expect(found.getByText("No exact matches. Ask Aldric: the records may still answer it.")).toBeVisible();

  // The first Escape clears the words and keeps the box open; the next closes it and gives focus
  // back to the magnifier.
  await box.press("Escape");
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  await box.press("Escape");
  await expect(box).toBeHidden();
  await expect(toggle).toBeFocused();
});
