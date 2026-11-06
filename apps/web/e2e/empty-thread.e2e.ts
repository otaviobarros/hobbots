import { expect, test } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #513: an empty thread shows its hob on a small stage asking "What are we making?", with
// three starter prompts that fill the composer.

test.afterEach(stopAldricHub);

// covers UX-001
test("[TC-CH-263] an empty thread shows the hob on its stage asking what we are making, and a starter fills the composer", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  const chat = page.getByRole("main", { name: "Chat" });
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });

  // Aldric has a chat already, so a new one is a fresh page.
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await composer.fill("Draft the spring banner copy");
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByText("Echo: Draft the spring banner copy").first()).toBeVisible({ timeout: 20_000 });
  await page.goto(`${url}/#/hobs/${aldric}/new`);

  await expect(chat.getByText("What are we making?")).toBeVisible();
  await expect(chat.getByRole("heading", { name: "A fresh page" })).toBeVisible();
  await expect(chat).toContainText("Tell Aldric what you want done.");
  const starters = ["Plan a product launch", "Sum up this week's inbox", "Tidy my Downloads folder"];
  for (const starter of starters) await expect(chat.getByRole("button", { name: starter })).toBeVisible();

  await chat.getByRole("button", { name: "Sum up this week's inbox" }).click();
  await expect(composer).toHaveValue("Sum up this week's inbox");
});
