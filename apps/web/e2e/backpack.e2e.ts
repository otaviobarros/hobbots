import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { openQuest, questSheet, taskDetails } from "./quest-sheet.ts";

// Issue #297 in the browser: what a hob is waiting on, on the hob's card and on the lead's Task. The read
// reads themselves are tested in packages/persistence/test/backpack.test.ts.

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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const hobNamed = (current: Hub, name: string, lookSeed: number) =>
  api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name,
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

// covers IN-001, IN-002, IN-004, OR-003
test("[TC-IN-150] Aldric's card and his Task's backpack show Quill's result as awaiting him until his continuation handles it", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const aldric = await hobNamed(current, "Aldric", 4000);
  await hobNamed(current, "Quill", 4821);

  // Aldric brings in Quill, whose push waits for you; Quill finishes once you allow it.
  await page.goto(`${current.url}/#/hobs/${aldric.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Plan the launch",
      script("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the landing copy",
          "fake:tool Bash git push origin feature",
          script("complete_task", { delivered: true, key: "copy-done", summary: "Three headlines." }),
        ].join("\n"),
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/hobs/${aldric.id}/threads/`));
  const thread = page.url();
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });

  // Aldric rests, so Quill's result waits in his backpack instead of starting his continuation.
  await api(current, "POST", `/api/agents/${aldric.id}/pause`);
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Push your work/ })
    .click();
  const request = page.getByRole("article", { name: "Request from Quill: Push your work" });
  await request.getByRole("button", { name: "Allow once" }).click();
  await expect(request.getByRole("status")).toHaveText("✓ Allowed once. Quill carries on.");
  await page.goto(thread);

  // Aldric's card in the sidebar: the result awaits him, from Quill, still waiting for a turn.
  const card = async (name: string) => {
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: new RegExp(`^${name}, `) })
      .click();
    return page.getByRole("dialog", { name }).getByRole("region", { name: "Backpack" });
  };
  const quillResult = /^Quill's result for "Draft the landing copy"/;
  await expect((await card("Aldric")).getByRole("button", { name: quillResult })).toContainText("Waiting", {
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  // Nothing waits on Quill herself.
  await expect(await card("Quill")).not.toContainText("Waiting");
  await page.keyboard.press("Escape");

  // Aldric's Task says the same in its backpack.
  const lead = async () => {
    await openQuest(page, "Plan the launch");
  };
  await lead();
  const room = page.getByRole("region", { name: "Backpack for Plan the launch" });
  await expect(room.getByRole("button", { name: /^Quill's result for "Draft the landing copy"/ })).toContainText(
    "Waiting",
  );

  // Opening it from the card opens the quest in the sheet, with Quill's work in it.
  await page.keyboard.press("Escape");
  await (await card("Aldric")).getByRole("button", { name: quillResult }).click();
  await expect(page).toHaveURL(/quest=/);
  if (await page.getByRole("dialog", { name: "Aldric" }).isVisible()) await page.keyboard.press("Escape");
  await expect(questSheet(page, "Plan the launch").getByRole("region", { name: "Quill's work" })).toBeVisible();

  // Aldric wakes: his continuation reads the result, which shows as consumed and leaves his count.
  await api(current, "POST", `/api/agents/${aldric.id}/wake`);
  await expect(page.getByText("Hobbots wrote this, not the user.").last()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect((await card("Aldric")).getByRole("button", { name: quillResult })).toContainText("Consumed", {
    timeout: 20_000,
  });
  await page.keyboard.press("Escape");
  await lead();
  // Once nothing waits, the backpack moves into the Task's details.
  await taskDetails(page, "Plan the launch");
  await expect(room).toContainText("Consumed");
});
