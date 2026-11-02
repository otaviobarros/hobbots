import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// covers UX-002, UX-006
test("[TC-UX-051] the Workbench chat of Quill's Task talks to Aldric, who leads it, and keeps the note begun in the drawer", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  // The Quest waits on Ada's question for you, so its Tasks are still open.
  await expect(page.getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 30_000 });

  // A note begun in Quill's Task drawer is the same unsent note in its Workbench chat.
  const strip = page.getByRole("region", { name: "Work in progress" });
  await strip.getByRole("button", { name: "Show Aldric's work" }).click();
  const quest = page.getByRole("complementary", { name: "Plan the Black Friday campaign, Task details" });
  await quest.getByRole("button", { name: /Draft the landing copy/ }).click();
  const drawer = page.getByRole("complementary", { name: "Draft the landing copy, Task details" });
  await drawer.getByRole("textbox", { name: "Tell Aldric about this task" }).fill("Keep the headlines short.");
  await drawer.getByRole("button", { name: "Open in Workbench" }).click();
  const bench = page.getByRole("region", { name: "Workbench for Draft the landing copy" });

  // Quill owns the Task, but you talk to Aldric, who leads the work.
  await bench.getByRole("button", { name: "Talk to Aldric" }).click();
  const chat = bench.getByRole("complementary", { name: "Talk about Draft the landing copy" });
  await expect(chat).toContainText("Goes to Aldric, who leads this work and passes it on to Quill.");
  const note = chat.getByRole("textbox", { name: "Tell Aldric about this task" });
  await expect(note).toHaveValue("Keep the headlines short.");
  await expect(chat.getByRole("button", { name: "Send" })).toBeEnabled();
  await note.press("Enter");
  await expect(chat.getByRole("status")).toHaveText("Sent to Aldric.");
  await expect(note).toHaveValue("");
  const notes = chat.getByRole("list", { name: "Your notes on this task" });
  await expect(notes).toContainText("Keep the headlines short.");
  await expect(notes).toContainText("To Aldric");

  // A nudge goes the same way.
  await chat.getByRole("group", { name: "Quick nudges" }).getByRole("button", { name: "Keep going" }).click();
  await expect(chat.getByRole("status")).toHaveText("Sent “Keep going” to Aldric.");
  await expect(notes.getByRole("listitem")).toHaveCount(2);

  // Back in the drawer, the note was sent from there too: its box is empty and both notes show.
  await bench.getByRole("button", { name: "← Back to the task" }).click();
  await expect(drawer.getByRole("textbox", { name: "Tell Aldric about this task" })).toHaveValue("");
  await expect(drawer).toContainText("Keep the headlines short.");
  await expect(drawer).toContainText("Keep going");
});
