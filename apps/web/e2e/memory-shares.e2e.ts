import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// #960: what hobs want to share (ADR 028, Sharing), from a hob's `memory_save` in a chat to your
// decision in the Inbox and in Memory › To review, on a hub with memory on and the fake memory.

let hub: Hub | undefined;
let dataDir = "";
let folder = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  if (folder !== "") rmSync(folder, { recursive: true, force: true });
  folder = "";
});

const PAGE = "howtos/deploy.md";
const MARKDOWN = "# Deploy the site\n\nRun `pnpm deploy` from the repository root.";

/**
 * A hub past setup under `preset`, with memory on over the fake memory, and Ada, who works in a
 * folder of her own (a project named after it). `ask` has Ada save the deploy how-to to `scope` in
 * a chat of its own, as a `memory_save` call, so it reaches the hub as a share would.
 */
const shareHub = async (preset: "balanced" | "trusting" = "balanced") => {
  dataDir = emptyDataDir();
  folder = realpathSync(mkdtempSync(`${dataDir}-site-`));
  // Memory on with no engine: the hub serves the memory tools over the fake memory.
  hub = await startHub(dataDir, {
    HOBBOTS_MEMORY: "on",
    HOBBOTS_MEMORY_ENGINE_DIR: "",
    HOBBOTS_FAKE_MEMORY: "empty",
    HOBBOTS_MEMORY_LOOK_SECONDS: "1",
  });
  const { url, headers } = hub;
  const api = async (method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"], safetyPreset: preset });
  const ada = await api("POST", "/agents", {
    id: randomUUID(),
    name: "Ada",
    role: null,
    roleTitle: "Builder",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 1301,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  await api("PATCH", `/agents/${ada.id}/permissions`, { ownFolders: [folder] });
  const ask = async (scope: "project" | "everyone", key = "deploy") => {
    const thread = await api("POST", `/agents/${ada.id}/threads`);
    const call = { key, scope, path: PAGE, markdown: MARKDOWN, tags: ["deploy"] };
    await api("POST", `/threads/${thread.id}/messages`, {
      content: `Remember how to deploy\nfake:hub memory_save ${JSON.stringify(call)}`,
    });
  };
  return { url, ask };
};

// covers ADR 028 (Sharing), #960
test("[TC-UX-985] a share arrives in the open Inbox as a Memory request, and Share it then Undo decide it there", async ({
  page,
}) => {
  const { url, ask } = await shareHub();
  await page.goto(`${url}/#/inbox`);
  const needsYou = page.getByRole("link", { name: "Hobbots inbox, something needs you" });
  await expect(needsYou).toHaveCount(0);

  // Ada asks while the Inbox is open: the request streams in, counted in the badge, with no rush.
  await ask("everyone");
  const row = page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Ada wants to teach every hob/ });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("No rush");
  await expect(needsYou).toBeVisible();
  await expect(page.getByRole("banner")).toContainText("1 waiting on you");

  await row.click();
  const request = page.getByRole("article", { name: "Share from Ada" });
  await expect(request.getByRole("region", { name: "The page to share" })).toContainText(
    "Run `pnpm deploy` from the repository root.",
  );
  await expect(request).toContainText("Share it and every hob follows it from its next chat.");
  await expectAccessible(page, request);

  await request.getByRole("button", { name: "Share it" }).click();
  await expect(request.getByRole("status")).toHaveText("Shared. Every hob follows it from its next chat.");
  await expect(needsYou).toHaveCount(0);

  // Undo, from the decided request that stays open where you decided it.
  await request.getByRole("button", { name: "Undo" }).click();
  await expect(request.getByRole("status")).toHaveText("Undone. The page is back in Ada's memory only.");
  await page.goto(`${url}/#/memory?scope=everyone`);
  await expect(page.getByRole("main", { name: "Memory" })).not.toContainText("Deploy the site");
});

// covers ADR 028 (Sharing), #960
test("[TC-UX-986] Edit in Memory opens the share in To review, where an edit is shared and another kept private", async ({
  page,
}) => {
  const { url, ask } = await shareHub();
  await ask("project", "deploy");
  await ask("everyone", "about");
  await page.goto(`${url}/#/inbox`);
  const row = page.getByRole("list", { name: "Requests" }).getByRole("link", { name: /Ada wants to teach every hob/ });
  await row.click({ timeout: 20_000 });
  await page.getByRole("article", { name: "Share from Ada" }).getByRole("link", { name: "Edit in Memory" }).click();

  // To review lists both, and opens the one the Inbox named.
  const main = page.getByRole("main", { name: "Memory" });
  const list = main.getByRole("navigation", { name: "Things to review" });
  await expect(list.getByRole("link")).toHaveCount(2);
  const about = main.getByRole("article", { name: "Ada wants to teach every hob" });
  await expectAccessible(page, main);
  await about.getByRole("button", { name: "Edit, then share" }).click();
  const field = about.getByRole("textbox", { name: "The page to share" });
  await expect(field).toHaveValue(MARKDOWN);
  await field.fill("# Deploy the site\n\nRun `pnpm deploy:prod` from the repository root.");
  await about.getByRole("button", { name: "Share it" }).click();
  await expect(about.getByRole("status")).toHaveText("Shared. Every hob follows it from its next chat.");

  // The project share, kept private: it stays in Ada's own memory and never reaches the project.
  await list.getByRole("link", { name: /Ada wants to add a how-to/ }).click();
  const project = main.getByRole("article", { name: /Ada wants to add a how-to/ });
  await project.getByRole("button", { name: "Keep it private" }).click();
  await expect(project.getByRole("status")).toHaveText("Kept private. Ada keeps it in its own memory.");

  // About you holds your edit, still saved by Ada.
  await page.goto(`${url}/#/memory?scope=everyone`);
  await main.getByRole("link", { name: /Deploy the site/ }).click();
  await expect(main).toContainText("pnpm deploy:prod");
  await expect(page.getByRole("link", { name: "Hobbots inbox, something needs you" })).toHaveCount(0);
});

// covers ADR 028 (Sharing, What changed), #960
test("[TC-UX-987] under Trusting a project share goes through, and Undo in What changed takes it out", async ({
  page,
}) => {
  const { url, ask } = await shareHub("trusting");
  await page.goto(`${url}/#/memory?view=changes`);
  const main = page.getByRole("main", { name: "Memory" });
  await expect(main.getByRole("heading", { name: "What changed", level: 2 })).toBeVisible();
  await ask("project");
  const change = main.getByRole("listitem").filter({ hasText: "Shared under Trusting" });
  await expect(change).toContainText("Deploy the site", { timeout: 20_000 });
  // Nothing waits for you: Trusting let it through.
  await expect(page.getByRole("link", { name: "Hobbots inbox, something needs you" })).toHaveCount(0);
  await expectAccessible(page, main);
  await change.getByRole("button", { name: "Undo" }).click();
  await expect(change.getByRole("status")).toHaveText("Undone. The page is back in Ada's memory only.");
});

// covers ADR 028 (Sharing), #960
test("[TC-UX-988] a decision memory does not take, or that was made elsewhere, says so and leaves the share as it was", async ({
  page,
}) => {
  const { url, ask } = await shareHub();
  await ask("everyone");
  await page.goto(`${url}/#/inbox`);
  await page
    .getByRole("list", { name: "Requests" })
    .getByRole("link", { name: /Ada wants to teach every hob/ })
    .click({ timeout: 20_000 });
  const request = page.getByRole("article", { name: "Share from Ada" });

  // Memory does not answer: nothing changed, and it still waits.
  await page.route("**/api/memory/shares/*/share", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ _tag: "MemoryNotAnswering" }),
    }),
  );
  await request.getByRole("button", { name: "Share it" }).click();
  await expect(request.getByRole("alert")).toHaveText(
    "Memory is not answering, so nothing changed. Try again in a moment.",
  );
  await expect(request.getByRole("button", { name: "Keep it private" })).toBeEnabled();
  await page.unroute("**/api/memory/shares/*/share");

  // Decided in another window meanwhile: this one is refused, and shows how it was decided.
  const other = await page.context().newPage();
  await other.goto(`${url}/#/memory?view=review`);
  await other
    .getByRole("main", { name: "Memory" })
    .getByRole("article", { name: "Ada wants to teach every hob" })
    .getByRole("button", { name: "Keep it private" })
    .click();
  await expect(request.getByRole("status")).toHaveText("Kept private. Ada keeps it in its own memory.", {
    timeout: 15_000,
  });
  await other.close();
});
