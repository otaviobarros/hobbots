import { expect, type Page, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { origin: current.url, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

// The fake runtime writes one word every 40 ms, so this reply runs for a few seconds.
const LONG_PROMPT = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ");

/** A finished setup with Pip, and one finished thread per title, created in order. */
const pipWithThreads = async (current: Hub, titles: ReadonlyArray<string>) => {
  await api(current, "PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ id: string }>(current, "POST", "/agents", {
    name: "Pip",
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
  const threads: Array<string> = [];
  for (const title of titles) {
    const thread = await api<{ id: string }>(current, "POST", `/agents/${pip.id}/threads`);
    await api(current, "POST", `/threads/${thread.id}/messages`, { content: title });
    await expect
      .poll(async () =>
        (await api<Array<{ status: string }>>(current, "GET", `/threads/${thread.id}/messages`)).map((m) => m.status),
      )
      .toEqual(["complete", "complete"]);
    threads.push(thread.id);
  }
  return { pip: pip.id, threads };
};

const threadList = (page: Page) => page.getByRole("navigation", { name: "Hobs and threads" });
const threadLink = (page: Page, title: string) => threadList(page).getByRole("link", { name: new RegExp(`^${title}`) });

// covers CH-009, UX-003
test("[TC-CH-150] archiving the open thread opens the next one, and Undo brings it back", async ({ page, browser }) => {
  hub = await startHub(dataDir);
  // Newest first in the list: Weekly digest, Support triage, Tagline ideas.
  const { pip, threads } = await pipWithThreads(hub, ["Tagline ideas", "Support triage", "Weekly digest"]);
  const [, triage] = threads;

  // A second window follows along live.
  const other = await browser.newPage();
  await other.goto(`${hub.url}/#/hobs/${pip}/threads/${threads[0]}`);
  await expect(threadLink(other, "Support triage")).toBeVisible();

  await page.goto(`${hub.url}/#/hobs/${pip}/threads/${triage}`);
  await page.getByRole("button", { name: "More for this thread" }).click();
  await page.getByRole("menuitem", { name: /Archive thread/ }).click();

  // The thread below opens and the archived one leaves both windows' lists.
  await expect(page).toHaveURL(new RegExp(`threads/${threads[0]}$`));
  await expect(page.getByRole("status").filter({ hasText: "Archived “Support triage”." })).toBeVisible();
  await expect(threadLink(page, "Support triage")).toHaveCount(0);
  await expect(threadLink(other, "Support triage")).toHaveCount(0);
  await expect(threadList(page).getByText("· 2 threads")).toBeVisible();

  await page.getByRole("button", { name: "Undo archive of Support triage" }).click();
  await expect(page).toHaveURL(new RegExp(`threads/${triage}$`));
  await expect(threadLink(page, "Support triage")).toBeVisible();
  await expect(threadLink(other, "Support triage")).toBeVisible();
  await other.close();
});

// covers CH-009, UX-003
test("[TC-CH-151] a thread row's menu archives it by keyboard, and ⌘Z undoes it", async ({ page }) => {
  hub = await startHub(dataDir);
  const { pip, threads } = await pipWithThreads(hub, ["Tagline ideas", "Weekly digest"]);

  await page.goto(`${hub.url}/#/hobs/${pip}/threads/${threads[1]}`);
  // Shift+F10 on the row opens its menu; the open thread stays open.
  await threadLink(page, "Tagline ideas").focus();
  await page.keyboard.press("Shift+F10");
  await expect(page.getByRole("menuitem", { name: /Archive thread/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(threadLink(page, "Tagline ideas")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`threads/${threads[1]}$`));
  await expect(page.getByRole("status").filter({ hasText: "Archived “Tagline ideas”." })).toBeVisible();

  // Undo by shortcut, with focus outside the composer.
  await threadLink(page, "Weekly digest").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(threadLink(page, "Tagline ideas")).toBeVisible();
  expect(await api<Array<unknown>>(hub, "GET", `/agents/${pip}/threads?archived=true`)).toEqual([]);

  // The ⋯ button holds the same menu.
  await page.getByRole("button", { name: "More for “Tagline ideas”" }).click();
  await expect(page.getByRole("menuitem", { name: /Archive thread/ })).toBeVisible();
});

// covers CH-009
test("[TC-CH-152] a thread cannot be archived while its reply runs, by menu or by shortcut", async ({ page }) => {
  hub = await startHub(dataDir);
  const current = hub;
  const { pip, threads } = await pipWithThreads(current, ["Tagline ideas"]);

  await page.goto(`${hub.url}/#/hobs/${pip}/threads/${threads[0]}`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(LONG_PROMPT);
  await composer.press("Enter");
  await expect(page.getByText(/Echo: word0 word1/)).toBeVisible();

  await page.getByRole("button", { name: "More for this thread" }).click();
  const item = page.getByRole("menuitem", { name: /Archive thread/ });
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toContainText("Pip is still replying. Archive it once the reply ends.");
  await page.keyboard.press("Escape");

  await page.keyboard.press("Control+Alt+a");
  await expect(
    page.getByRole("status").filter({ hasText: "Can't archive yet: Pip is still replying here." }),
  ).toBeVisible();
  await expect(threadLink(page, "Tagline ideas")).toBeVisible();

  // Once the reply ends, the shortcut archives it and the fresh page opens.
  await expect
    .poll(
      async () =>
        (await api<Array<{ status: string }>>(current, "GET", `/threads/${threads[0]}/messages`)).map((m) => m.status),
      { timeout: 15_000 },
    )
    .toEqual(["complete", "complete", "complete", "complete"]);
  await page.getByRole("main", { name: "Chat" }).click();
  await page.keyboard.press("Control+Alt+a");
  await expect(page).toHaveURL(new RegExp(`hobs/${pip}/new$`));
  await expect(threadLink(page, "Tagline ideas")).toHaveCount(0);
});
