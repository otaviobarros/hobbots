import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup that plays the scripted Black Friday Quest, with Aldric, Quill and Ada. */
const questHub = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir, { HOBBOTS_FAKE_QUEST: "black-friday" });
  const url = hub.url;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids: Record<string, string> = {};
  for (const [index, name] of ["Aldric", "Quill", "Ada"].entries()) {
    const hob = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: "assistant",
      roleTitle: "Assistant",
      sigil: "assistant",
      hat: null,
      tool: null,
      lookSeed: 4000 + index * 911,
      lookColor: (["amber", "sky", "moss"] as const)[index],
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = hob.id;
  }
  return { url, aldric: String(ids.Aldric) };
};

// covers OR-001, OR-004, CH-005, UX-001
test("[TC-OR-013] the Black Friday Quest can be followed end to end from the chat with its lead", async ({ page }) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  // The card sits under the request, with the party and the rows that matter.
  const card = page.getByRole("region", { name: "Aldric's work on Plan the Black Friday campaign" });
  await expect(card).toContainText("Aldric is on it");
  await expect(card).toContainText("Aldric's party: Quill and Ada");
  await expect(card.getByRole("button", { name: "Look inside Build the campaign" })).toContainText("waiting on Quill");

  // The strip keeps it in view; a lead's answer shows as one line; a question for you asks.
  const strip = page.getByRole("region", { name: "Work in progress" });
  await expect(strip.getByRole("button", { name: "Show Aldric's work" })).toContainText("Aldric's quest");
  await expect(page.getByText("Aldric answered Quill for you")).toBeVisible();
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("Should international orders get an earlier cutoff");
  await expect(card.getByRole("button", { name: "Look inside Build the campaign" })).toContainText("Needs you");
  await expect(strip).toContainText("1 needs you");

  // The drawer opens a Task beside the chat, by keyboard too, and Escape closes it.
  await card.getByRole("button", { name: "Look inside Build the campaign" }).click();
  const drawer = page.getByRole("complementary", { name: "Build the campaign, Task details" });
  await expect(drawer.getByRole("heading", { name: "Build the campaign" })).toBeFocused();
  await expect(drawer).toContainText("Aldric gave it");
  await expect(drawer).toContainText("Keyword research done while waiting on Quill");
  await expect(drawer).toContainText("Black Friday: 20% off everything, this weekend only.");
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();

  // A note in the drawer goes to Aldric as a message about that Task, and stays with that Task.
  await strip.getByRole("button", { name: "Show Aldric's work" }).click();
  const quest = page.getByRole("complementary", { name: "Plan the Black Friday campaign, Task details" });
  await quest.getByRole("button", { name: /Draft the landing copy/ }).click();
  const note = page.getByRole("textbox", { name: "Tell Aldric about this task" });
  await note.fill("Keep the headlines short.");
  await page.getByRole("button", { name: "Back to Plan the Black Friday campaign" }).click();
  await expect(quest).toBeVisible();
  await expect(note).toHaveValue("");
  await quest.getByRole("button", { name: /Draft the landing copy/ }).click();
  await expect(note).toHaveValue("Keep the headlines short.");
  await note.press("Enter");
  await expect(page.getByText("About “Draft the landing copy”: Keep the headlines short.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  // Your answer goes back; the Quest finishes and Aldric wraps up in the chat.
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(asks).toContainText("You answered: Yes, Dec 12 for international orders.");
  await expect(card).toContainText("Aldric finished this", { timeout: 15_000 });
  await expect(strip).toBeHidden();
  await expect(page.getByText("The Black Friday campaign is ready.")).toBeVisible();

  // Once it ends, the card still opens the Task with its output.
  await card.getByRole("button", { name: "Show all" }).click();
  await expect(quest).toContainText("Black Friday campaign ready");
});
