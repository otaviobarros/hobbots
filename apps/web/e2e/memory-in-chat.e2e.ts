import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Memory in a chat and on a hob's page (ADR 028, #961), on the fake runtime, whose memory tools
// write to the same fake memory the Memory page reads.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with memory on, the fake memory in `memory`, and one shared folder named `site`. */
const hubWithMemory = async (memory: "empty" | "seeded") => {
  dataDir = emptyDataDir();
  const site = join(dataDir, "folders", "site");
  mkdirSync(site, { recursive: true });
  hub = await startHub(dataDir, { HOBBOTS_MEMORY: "on", HOBBOTS_FAKE_MEMORY: memory });
  const started = hub;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [site],
  });
  const pip = await api("POST", "/agents", {
    name: "Pip",
    role: null,
    roleTitle: "Writer",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 1201,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  return { url: started.url, pip };
};

/** A prompt line that makes the fake save a page to the hob's own memory. */
const saveLine = (key: string, markdown: string) =>
  `fake:hub memory_save ${JSON.stringify({ key, scope: "mine", path: "decisions/launch-day.md", markdown })}`;

/** Sends `lines` as one message and waits for the reply to end. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
};

const savedLines = (page: Page) => page.getByRole("list", { name: "What Pip saved to memory" });

// covers ADR 028 (The memory tools, Writes), #961
test("[TC-UX-971] a save shows a quiet line under its reply, Open reads the page, and Undo removes a page it made", async ({
  page,
}) => {
  const { url, pip } = await hubWithMemory("empty");
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  await send(page, ["Hello Pip."]);
  await send(page, [
    "Remember that launch emails go out on Tuesday at 9 AM.",
    saveLine("tuesday", "# Launch emails go out Tuesday at 9 AM\n\nDecided with you."),
  ]);

  // One line, under the reply that saved, and none under the first reply.
  const lines = savedLines(page);
  await expect(lines).toHaveCount(1);
  await expect(lines).toContainText("Saved to Pip's memory · Decision: Launch emails go out Tuesday at 9 AM");
  const reply = page.getByRole("article").filter({ has: lines });
  await expect(reply).toContainText("Remember that launch emails");

  // The line is read back with the thread.
  await page.reload();
  await expect(savedLines(page)).toContainText("Saved to Pip's memory");

  // Open reads the page in Memory.
  await savedLines(page).getByRole("link", { name: "Open Launch emails go out Tuesday at 9 AM in Memory" }).click();
  const memory = page.getByRole("main", { name: "Memory" });
  await expect(memory.getByRole("heading", { name: "Launch emails go out Tuesday at 9 AM", level: 2 })).toBeVisible();
  await page.goBack();

  // Undo removes the page the save made, and the line says so.
  await savedLines(page).getByRole("button", { name: "Undo saving Launch emails go out Tuesday at 9 AM" }).click();
  await expect(savedLines(page)).toContainText("Undone. Pip's memory is back as it was.");
  await expect(savedLines(page).getByRole("button")).toHaveCount(0);
  await page.goto(`${url}/#/memory?scope=hob:${pip.id}`);
  await expect(memory).not.toContainText("Launch emails go out Tuesday");
});

// covers ADR 028 (Writes), #961
// covers ADR 028 (The memory brief), through the whole server rather than a hub built for the test
test("[TC-UX-978] a page a hob saved reaches its next thread's brief", async ({ page }) => {
  const { url, pip } = await hubWithMemory("empty");
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  await send(page, ["Remember this.", saveLine("brief", "# Launch day\n\nLaunch emails go out Tuesday at 9 AM.")]);
  await expect(savedLines(page)).toHaveCount(1);

  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  await send(page, ["What day do launch emails go out?"]);
  // The fake echoes what the session was told ahead of the prompt.
  await expect(page.getByRole("article").last()).toContainText("Launch emails go out Tuesday at 9 AM.");
});

test("[TC-UX-972] Undo puts back the version a save replaced, and refuses an older save the page has moved past", async ({
  page,
}) => {
  const { url, pip } = await hubWithMemory("empty");
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  await send(page, ["Launch emails go out on Monday.", saveLine("monday", "# Launch emails go out Monday")]);
  await send(page, ["No, Tuesday at 9 AM.", saveLine("tuesday", "# Launch emails go out Tuesday at 9 AM")]);
  const [monday, tuesday] = [
    page.getByRole("listitem").filter({ hasText: "Decision: Launch emails go out Monday" }),
    page.getByRole("listitem").filter({ hasText: "Decision: Launch emails go out Tuesday at 9 AM" }),
  ];
  await expect(monday).toBeVisible();
  await expect(tuesday).toBeVisible();

  // Undoing the later save puts the earlier version back.
  await tuesday.getByRole("button", { name: /^Undo saving/ }).click();
  await expect(page.getByText("Undone. Pip's memory is back as it was.")).toBeVisible();
  await page.goto(`${url}/#/memory?scope=hob:${pip.id}&page=decisions/launch-day.md`);
  await expect(page.getByRole("main", { name: "Memory" })).toContainText("Launch emails go out Monday");
  await page.goBack();

  // The earlier save is no longer the page's latest version, so its Undo would lose that.
  await monday.getByRole("button", { name: /^Undo saving/ }).click();
  await expect(monday.getByRole("alert")).toContainText("Pip's memory changed after this, so Undo would lose that.");
});

// covers ADR 028 (Scopes, The memory tools), #961
test("[TC-UX-973] a hob's Memory tab shows what it learned and what it reads, and links to its Memory permissions", async ({
  page,
}) => {
  const { url, pip } = await hubWithMemory("seeded");
  await page.goto(`${url}/#/hobs/${pip.id}?tab=memory`);
  const main = page.getByRole("main", { name: "Pip's page" });
  await expect(main.getByRole("tab", { name: /Memory/ })).toHaveAttribute("aria-selected", "true");
  await expect(main.getByRole("tab", { name: /Memory/ })).toContainText("4");
  await expect(main).toContainText("Pip remembers 4 pages.");

  const lately = main.getByRole("region", { name: "Learned lately" });
  await expect(lately.getByRole("link")).toHaveCount(3);
  const reads = main.getByRole("region", { name: "What Pip can read" });
  await expect(reads.getByRole("listitem")).toHaveText([
    /Its own memory.*4 pages/,
    /About you.*2 pages/,
    /site project.*2 pages/,
  ]);

  await main.getByRole("link", { name: "Open in Memory" }).click();
  await expect(page).toHaveURL(new RegExp(`scope=hob(%3A|:)${pip.id}`));
  await page.goBack();

  // What Pip may remember opens Permissions, where the Memory group sets both rules.
  await main.getByRole("link", { name: "What Pip may remember" }).click();
  const group = page.getByRole("region", { name: "Memory" });
  await expect(group).toContainText("Recall what it learned");
  await expect(group).toContainText("Remember things");
  const remember = group.getByRole("radiogroup", { name: "Remember things" });
  await expect(remember.getByRole("radio", { name: "Allow" })).toBeChecked();
  await remember.getByText("Never", { exact: true }).click();
  await expect(remember.getByRole("radio", { name: "Never" })).toBeChecked();
  await expect(group).toContainText("More careful");
});

// covers ADR 028 (The memory tools), #961, STD-REACT-015
test("[TC-UX-977] when a chat's saves cannot be read, it says so and Try again brings the lines back", async ({
  page,
}) => {
  const { url, pip } = await hubWithMemory("empty");
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  await send(page, [
    "Remember that launch emails go out on Tuesday at 9 AM.",
    saveLine("tuesday", "# Launch emails go out Tuesday at 9 AM"),
  ]);
  await expect(savedLines(page)).toBeVisible();

  const threadSaves = "**/api/threads/*/memory-saves";
  await page.route(threadSaves, (route) => route.fulfill({ status: 500, body: "" }));
  await page.reload();
  const chat = page.getByRole("main", { name: "Chat" });
  // The client asks again a few times before it gives up.
  await expect(chat.getByRole("alert")).toContainText("Hobbots could not read what Pip saved to memory in this chat", {
    timeout: 20_000,
  });
  await expect(savedLines(page)).toHaveCount(0);

  await page.unroute(threadSaves);
  await chat.getByRole("button", { name: "Try again" }).click();
  await expect(savedLines(page)).toContainText("Saved to Pip's memory");
  await expect(chat.getByRole("alert")).toHaveCount(0);
});
