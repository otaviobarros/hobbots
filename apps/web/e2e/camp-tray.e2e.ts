import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { campAt, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
});

const api = async (current: Hub, method: string, path: string, body: unknown) => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as { readonly id: string };
};

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

// Balanced asks before pushing. The fake runtime makes the scripted call without running it.
const PUSH = "Ship it\nfake:tool Bash git push origin feature";

const tray = (page: Page) => page.getByRole("region", { name: /^Needs you/ });
const scope = (page: Page) => tray(page).getByRole("radiogroup", { name: "Show what waits" });

/**
 * Aldric, working in one shared folder under Balanced, asks you a question in his camp "Launch"
 * and asks to push in his chat. Returns where each lives.
 */
const askInBoth = async (page: Page) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const aldric = await api(current, "POST", "/api/agents", {
    name: "Aldric",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
  const camp = await campAt(current, aldric.id, "Launch");

  await page.goto(camp.url);
  const campComposer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await campComposer.fill(
    [
      "Tidy the notes",
      script("start_quest", { key: "quest", goal: "Tidy the notes" }),
      script("ask", { key: "ask", question: "Should the headings be short?" }),
    ].join("\n"),
  );
  await campComposer.press("Enter");
  await expect(tray(page).getByRole("region", { name: "Aldric asks you" })).toBeVisible({ timeout: 30_000 });

  await page.goto(`${current.url}/#/hobs/${aldric.id}/chat`);
  const chatComposer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await chatComposer.fill(PUSH);
  await chatComposer.press("Enter");
  await expect(tray(page).getByRole("region", { name: "Aldric asks permission" })).toBeVisible({ timeout: 15_000 });
  return { camp, chat: page.url() };
};

// covers IN-002, UX-001
test("[TC-IN-1423-01] a camp's tray shows only that camp's questions and approvals, and Everywhere shows the rest with where each waits", async ({
  page,
  scan,
}) => {
  const { camp, chat } = await askInBoth(page);

  // The chat's tray holds its own request, not the camp's question, and offers Everywhere.
  await expect(tray(page)).toHaveAccessibleName("Needs you, 1 of 1");
  await expect(tray(page).getByRole("region", { name: "Aldric asks you" })).toHaveCount(0);
  await expect(scope(page).getByRole("radio", { name: "This chat" })).toBeChecked();

  // The camp's tray holds Aldric's question only.
  await page.goto(camp.url);
  await expect(tray(page).getByRole("region", { name: "Aldric asks you" })).toBeVisible({ timeout: 15_000 });
  await expect(tray(page)).toHaveAccessibleName("Needs you, 1 of 1");
  await expect(tray(page).getByRole("region", { name: "Aldric asks permission" })).toHaveCount(0);
  await expect(scope(page).getByRole("radio", { name: "This camp" })).toBeChecked();
  await scan();

  // Everywhere holds both; the chat's request says where it waits, with a link there.
  await scope(page).getByRole("radio", { name: "Everywhere" }).click();
  await expect(tray(page)).toHaveAccessibleName(/^Needs you, \d of 2$/);
  if ((await tray(page).getByRole("region", { name: "Aldric asks permission" }).count()) === 0) {
    await tray(page).getByRole("button", { name: "Next" }).click();
  }
  const ask = tray(page).getByRole("region", { name: "Aldric asks permission" });
  await expect(ask).toBeVisible();
  await scan();
  await ask.getByRole("link", { name: /^Waits in / }).click();
  await expect(page).toHaveURL(chat);

  // Back in the camp, This camp again holds only Aldric's question.
  await page.goto(camp.url);
  await expect(tray(page)).toHaveAccessibleName("Needs you, 1 of 1");
  await expect(tray(page).getByRole("region", { name: "Aldric asks you" })).toBeVisible();
});

// covers IN-002, UX-001
test("[TC-IN-1423-02] See all from a camp's tray opens the Inbox on that camp, and Everywhere lists every request", async ({
  page,
  scan,
}) => {
  const { camp } = await askInBoth(page);
  await page.goto(camp.url);
  await tray(page).getByRole("link", { name: "See all in Inbox" }).click();

  const list = page.getByRole("list", { name: "Requests" });
  const picker = page.getByRole("radiogroup", { name: "Show what waits" });
  await expect(picker.getByRole("radio", { name: "Launch" })).toBeChecked();
  await expect(list.getByRole("link", { name: /Question/ })).toHaveCount(1);
  await expect(list.getByRole("link", { name: /Approval/ })).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Question from Aldric" })).toBeVisible();
  await scan();

  await picker.getByRole("radio", { name: "Everywhere" }).click();
  await expect(list.getByRole("link", { name: /Approval/ })).toHaveCount(1);
  await expect(list.getByRole("link", { name: /Question/ })).toHaveCount(1);

  // Once Aldric's question is answered, the camp has nothing waiting, and the way to the rest shows.
  await picker.getByRole("radio", { name: "Launch" }).click();
  const asked = page.getByRole("article", { name: "Question from Aldric" });
  await asked.getByRole("textbox", { name: "Your answer to Aldric" }).fill("Yes, Dec 12.");
  await asked.getByRole("button", { name: "Send answer" }).click();
  await expect(page.getByText("Nothing waits in Launch")).toBeVisible();
  await scan();
  await page.getByRole("link", { name: "See everywhere" }).click();
  await expect(list.getByRole("link", { name: /Approval/ })).toHaveCount(1);
});
