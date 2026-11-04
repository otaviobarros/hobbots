import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { press, tabTo, typeInto } from "./keyboard.ts";

// The main flows from start to finish with the keyboard alone (STD-TEST-008). Each test only opens
// the address the flow starts from; after that every step is a key press.

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

/** A hub past setup, with Pip on the fake runtime working in one shared folder. */
const hubWithPip = async (safetyPreset = "balanced") => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset,
    approvedFolders: [shared],
  });
  const pip = await api<{ readonly id: string }>(current, "POST", "/api/agents", {
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
  return { current, pip: pip.id };
};

// covers OP-001, AG-001, UX-003
test("[TC-OP-078] onboarding runs from Welcome to Home with the keyboard alone", async ({ page }) => {
  hub = await startHub(dataDir);
  await page.goto(hub.url);
  await expect(page).toHaveURL(/#\/welcome$/);

  await press(page, page.getByRole("link", { name: "Get started" }));
  await expect(page.getByRole("heading", { name: "Where should your hobs live?" })).toBeVisible();
  await press(page, page.getByRole("link", { name: /Run Hobbots on this computer/ }));

  await expect(page.getByRole("heading", { name: "Which AI should your hobs think with?" })).toBeVisible();
  await press(page, page.getByRole("button", { name: "Connect Claude" }));
  await expect(page.getByText("✓ Connected")).toBeVisible();
  await press(page, page.getByRole("button", { name: "Continue" }));

  await expect(page.getByRole("heading", { name: "Who should help you first?" })).toBeVisible();
  await typeInto(page, page.getByRole("textbox", { name: "Name", exact: true }), "Pip");
  await press(page, page.getByRole("button", { name: "Continue" }));

  await expect(page.getByRole("heading", { name: "How careful should your hobs be?" })).toBeVisible();
  await press(page, page.getByRole("button", { name: "Continue" }));

  await expect(page.getByRole("heading", { name: "Where can hobs work?" })).toBeVisible();
  await press(page, page.getByRole("button", { name: "Continue" }));

  await expect(page.getByRole("heading", { name: "Use Hobbots on your phone too?" })).toBeVisible();
  await press(page, page.getByRole("button", { name: "Skip for now" }));

  await expect(page.getByRole("heading", { name: "Everything is ready" })).toBeVisible();
  await press(page, page.getByRole("button", { name: "Light the circle" }));
  await expect(page.getByRole("heading", { name: "Pip is here!" })).toBeVisible();
  await press(page, page.getByRole("link", { name: "Go to Home" }));

  await expect(
    page.getByRole("region", { name: "Your hobs right now" }).getByRole("button", { name: /^Pip, / }),
  ).toBeVisible();
});

// covers AG-001, UX-003
test("[TC-AG-118] summoning a hob runs from the Summon card to its first reply with the keyboard alone", async ({
  page,
}) => {
  const { current } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs`);
  const main = page.getByRole("main", { name: "Your hobs" });
  await press(page, main.getByRole("link", { name: /^Summon a hob/ }).first());

  await expect(page.getByRole("heading", { name: "What should your new hob help you with?" })).toBeVisible();
  // The roles are one radio group: Tab enters it and the arrow keys pick a role.
  const roles = page.getByRole("group", { name: "Role" });
  await tabTo(page, roles.getByRole("radio", { checked: true }));
  await page.keyboard.press("ArrowRight");
  await expect(roles.getByRole("radio", { name: /^Researcher/ })).toBeChecked();
  await press(page, page.getByRole("button", { name: "Next: name and look" }));

  await expect(page).toHaveURL(/step=look/);
  const name = page.getByRole("textbox", { name: "Hob name" });
  await tabTo(page, name);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Fern");
  await press(page, page.getByRole("button", { name: "Next: check and summon" }));

  await expect(page.getByRole("heading", { name: "Ready to summon Fern?" })).toBeVisible();
  await press(page, page.getByRole("button", { name: "Summon Fern" }));
  await expect(page).toHaveURL(/#\/hobs\/[^/]+\/arrived$/);
  await expect(page.getByRole("heading", { name: "Fern is here!" })).toBeVisible();

  // A first question opens the chat with it typed in, and Enter sends it.
  const question = page.getByRole("region", { name: "Try asking" }).getByRole("link").first();
  // The link ends with an arrow that is not part of the question.
  const asked = ((await question.textContent()) ?? "").replace(/→$/, "").trim();
  await press(page, question);
  await expect(page).toHaveURL(/#\/hobs\/[^/]+\/new$/);
  const composer = page.getByRole("textbox", { name: /^Message Fern/ });
  await expect(composer).toHaveValue(asked);
  await tabTo(page, composer);
  await page.keyboard.press("Enter");
  await expect(page.getByText(`Echo: ${asked}`)).toBeVisible();
});

// covers CH-001, UX-006
test("[TC-CH-276] chatting with a hob, from Home to its replies, works with the keyboard alone", async ({ page }) => {
  const { current } = await hubWithPip();
  await page.goto(current.url);

  // A hob on Home opens its card, and the card opens the chat.
  await press(page, page.getByRole("region", { name: "Your hobs right now" }).getByRole("button", { name: /^Pip, / }));
  await press(page, page.getByRole("dialog", { name: "Pip" }).getByRole("link", { name: "Open chat" }));
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await typeInto(page, composer, "Hello from the keyboard");
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/threads\//);
  await expect(page.getByText(/^Echo: Hello from the keyboard/)).toBeVisible();
  await expect(composer).toHaveValue("");

  // A second message from the same composer, without leaving the keyboard.
  await typeInto(page, composer, "And once more");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/^Echo: And once more/)).toBeVisible();
});

// covers PE-003, UX-003
test("[TC-PE-451] deciding an approval works with the keyboard alone, from the composer to the resumed reply", async ({
  page,
}) => {
  const { current, pip } = await hubWithPip();
  await page.goto(`${current.url}/#/hobs/${pip}/new`);

  // Balanced asks before pushing; the fake runtime makes the scripted call without running it.
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await typeInto(page, composer, "Ship it");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("fake:tool Bash git push origin feature");
  await page.keyboard.press("Enter");

  const card = page.getByRole("region", { name: "Pip asks permission" });
  await expect(card).toBeVisible();
  await expect(card.getByText("git push origin feature", { exact: true })).toBeVisible();
  await press(page, card.getByRole("button", { name: "Allow once" }));

  await expect(card.getByRole("status")).toHaveText("✓ Allowed once. Pip carries on.");
  await expect(card.getByRole("status")).toBeFocused();
  await expect(page.locator('[data-state="done"]', { hasText: "git push" })).toBeVisible();
  await expect(page.getByText(/^Echo: Ship it/)).toBeVisible();
});
