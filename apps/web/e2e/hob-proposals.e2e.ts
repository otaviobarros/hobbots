import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// #409: a manager's Summoning call that asks becomes a hob proposal (ADR 034, Asking is a proposal),
// one card on the call's step in the chat and in the Inbox, decided row by row, on a hub with the
// fake runtime.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const hobPayload = (name: string, lookSeed: number) => ({
  id: randomUUID(),
  name,
  role: "writer",
  roleTitle: "Writer",
  sigil: "writer",
  hat: null,
  tool: null,
  lookSeed,
  lookColor: "moss",
  runtime: "claude-code",
  model: null,
  effort: null,
  instructions: "",
});

/** A hub past setup with Bram, who holds the Summoning Charm at its default answers: summoning asks. */
const managerHub = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
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
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"], safetyPreset: "balanced" });
  const bram = await api("POST", "/agents", hobPayload("Bram", 4091));
  await api("PATCH", `/agents/${bram.id}/permissions`, { charms: { granted: ["summoning"] } });
  return { url, api, bram };
};

const summon = (key: string, names: ReadonlyArray<string>) =>
  `Hire a crew\nfake:hub summoning_summon ${JSON.stringify({ key, hobs: names.map((name) => ({ name, role: "writer" })) })}`;

// covers ADR 034 (Asking is a proposal: the same card in both places, Edit, created cards), #409 done when 1 and 4
test("[TC-UX-409-01] a summon card in the chat and the Inbox: Deny one row, Edit one in Summon, Allow the last, and a created card opens its hob", async ({
  page,
}) => {
  const { url, bram } = await managerHub();
  await page.goto(`${url}/#/hobs/${bram.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Bram/ });
  await composer.fill(summon("hire-trio", ["Flo", "Gus", "Hedda"]));
  await composer.press("Enter");

  // The card waits in the Needs-you tray above the composer, not in the call's step.
  const inChat = page.locator("[data-tray]").getByRole("region", { name: "Bram proposes 3 new hobs" });
  await expect(inChat).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("list", { name: "Reply steps" }).getByRole("region")).toHaveCount(0);
  const rowsInChat = inChat.getByRole("list", { name: "Hobs" });
  await expect(rowsInChat.getByRole("article")).toHaveCount(3);
  await expectAccessible(page, inChat);
  await rowsInChat.getByRole("article", { name: "Hedda" }).getByRole("button", { name: "Deny" }).click();
  await expect(rowsInChat.getByRole("article", { name: "Hedda" })).toHaveAttribute("data-state", "denied");

  // The same card in the Inbox, with Hedda already denied there.
  await page.goto(`${url}/#/inbox`);
  await page.getByRole("link", { name: /Bram proposes 3 new hobs/ }).click({ timeout: 20_000 });
  const card = page.getByRole("region", { name: "Bram proposes 3 new hobs" });
  const rows = card.getByRole("list", { name: "Hobs" });
  await expect(rows.getByRole("article", { name: "Hedda" })).toHaveAttribute("data-state", "denied");
  await expectAccessible(page, card);

  // Edit opens Summon on Gus; your version is allowed from its last step, and Gussie's profile opens.
  await rows.getByRole("article", { name: "Gus" }).getByRole("link", { name: "Edit in Summon" }).click();
  await expect(page.getByRole("heading", { name: "Your version of Bram's proposal" })).toBeVisible();
  await page.getByRole("button", { name: "Next: name and look" }).click();
  await page.getByRole("textbox", { name: "Hob name" }).fill("Gussie");
  await page.getByRole("button", { name: "Next: check and summon" }).click();
  await page.getByRole("button", { name: "Allow Gussie as edited" }).click();
  await expect(page.getByRole("main", { name: "Gussie's profile" })).toBeVisible({ timeout: 20_000 });

  // Back in the Inbox, Flo is allowed from the keyboard, and the proposal settles.
  await page.goto(`${url}/#/inbox`);
  await page.getByRole("link", { name: /Bram proposes 3 new hobs/ }).click({ timeout: 20_000 });
  const gus = rows.getByRole("article", { name: "Gus" });
  await expect(gus).toHaveAttribute("data-state", "allowed");
  await expect(gus).toContainText("Your version");
  await rows.getByRole("article", { name: "Flo" }).getByRole("button", { name: "Allow" }).focus();
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toHaveText("Decided. Bram heard what was made and what was denied.");

  // A created card opens its hob.
  const created = card.getByRole("region", { name: "Created" });
  await expect(created.getByRole("link")).toHaveCount(2);
  await created.getByRole("link", { name: "Open Flo" }).click();
  await expect(page.getByRole("main", { name: "Flo's profile" })).toBeVisible();
});

// covers ADR 034 (Retire is high risk), #409 (the retire card), STD-REACT-015
test("[TC-UX-409-02] a retire card reads what the hob has open first, says so when it cannot, and allows it only with the check box", async ({
  page,
}) => {
  const { url, api, bram } = await managerHub();
  const wren = await api("POST", "/agents", hobPayload("Wren", 4092));
  await api("PATCH", `/agents/${bram.id}/permissions`, {
    charms: { summoning: { summoned: true, hobs: [wren.id], self: false } },
  });
  const thread = await api("POST", `/agents/${bram.id}/threads`);
  const call = { key: "retire-wren", hob: "Wren", running_replies: "finish" };
  await api("POST", `/threads/${thread.id}/messages`, {
    content: `Wren is done\nfake:hub summoning_retire ${JSON.stringify(call)}`,
  });

  // Wren's open work cannot be read at first: the row says so, and cannot be allowed.
  let down = true;
  await page.route(`**/api/agents/${wren.id}/open-work*`, async (route) => {
    if (down) await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    else await route.continue();
  });
  await page.goto(`${url}/#/inbox`);
  await page.getByRole("link", { name: /Bram proposes retiring Wren/ }).click({ timeout: 20_000 });
  const row = page.getByRole("region", { name: "Bram proposes retiring Wren" }).getByRole("article", { name: "Wren" });
  const failed = row.getByRole("alert");
  await expect(failed).toHaveText("Hobbots could not read what Wren has running and open.", { timeout: 20_000 });
  const confirm = row.getByRole("checkbox", { name: "I understand Wren is retired and this cannot be undone" });
  await expect(confirm).toBeDisabled();
  await expect(row.getByRole("button", { name: "Allow" })).toBeDisabled();

  down = false;
  await row.getByRole("button", { name: "Try again" }).click();
  await expect(row.getByText("Wren has nothing running or open.")).toBeVisible();
  await expect(failed).toHaveCount(0);
  await expectAccessible(page, row);
  await expect(row.getByRole("button", { name: "Allow" })).toBeDisabled();
  await confirm.check();
  await row.getByRole("button", { name: "Allow" }).click();
  await expect(row).toHaveAttribute("data-state", "allowed");
  await expect(row).toContainText("Wren is retired now.");
});

/** Presses Tab until `target` has focus, as a keyboard user reaches it, or fails after `limit` presses. */
const tabTo = async (page: Page, target: Locator, limit = 80) => {
  await expect(target).toBeVisible({ timeout: 20_000 });
  for (let presses = 0; presses < limit; presses++) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`Tab never reached ${target}`);
};

// covers STD-TEST-008, ADR 034 (Asking is a proposal), #409
test("[TC-UX-409-03] a summon proposal is decided by keyboard alone: open it from the Inbox, Allow one row, Edit the other in Summon, and open a created hob", async ({
  page,
}) => {
  const { url, api, bram } = await managerHub();
  const thread = await api("POST", `/agents/${bram.id}/threads`);
  await api("POST", `/threads/${thread.id}/messages`, { content: summon("hire-pair", ["Ivo", "Jun"]) });
  await page.goto(`${url}/#/inbox`);

  const entry = page.getByRole("link", { name: /Bram proposes 2 new hobs/ });
  await tabTo(page, entry);
  await page.keyboard.press("Enter");
  const card = page.getByRole("region", { name: "Bram proposes 2 new hobs" });
  const rows = card.getByRole("list", { name: "Hobs" });

  await tabTo(page, rows.getByRole("article", { name: "Ivo" }).getByRole("button", { name: "Allow" }));
  await page.keyboard.press("Enter");
  await expect(rows.getByRole("article", { name: "Ivo" })).toHaveAttribute("data-state", "allowed");

  await tabTo(page, rows.getByRole("article", { name: "Jun" }).getByRole("link", { name: "Edit in Summon" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your version of Bram's proposal" })).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Next: name and look" }));
  await page.keyboard.press("Enter");
  const name = page.getByRole("textbox", { name: "Hob name" });
  await tabTo(page, name);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Juno");
  await tabTo(page, page.getByRole("button", { name: "Next: check and summon" }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Allow Juno as edited" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main", { name: "Juno's profile" })).toBeVisible({ timeout: 20_000 });

  // The same card on the call's step in Bram's chat, settled, opens a created hob.
  await page.goto(`${url}/#/hobs/${bram.id}/threads/${thread.id}`);
  // Decided, the step keeps one line per hob and the hobs it made, folded inside the step until opened.
  const step = page.getByRole("list", { name: "Reply steps" }).getByRole("button").first();
  await tabTo(page, step, 200);
  await expect(card).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(card.getByRole("status")).toContainText("Ivo: Allowed", { timeout: 20_000 });
  await expect(card.getByRole("status")).toContainText("Jun: Allowed");
  await expect(card.getByRole("button", { name: /^(Allow|Deny)/ })).toHaveCount(0);
  await expectAccessible(page, card);
  await tabTo(page, card.getByRole("region", { name: "Created" }).getByRole("link", { name: "Open Ivo" }), 200);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main", { name: "Ivo's profile" })).toBeVisible();
});

// covers ADR 034 ("Always allow" for every field that asked), the design system (one place asks for you)
test("[TC-UX-409-04] a hob's change to itself waits in the tray with its fields on one line each, Always allow all sets every field that asked, and focus moves to the composer once it is decided", async ({
  page,
}) => {
  const { url, api, bram } = await managerHub();
  await api("PATCH", `/agents/${bram.id}/permissions`, {
    charms: { summoning: { summoned: true, hobs: [], self: true } },
  });
  const thread = await api("POST", `/agents/${bram.id}/threads`);
  const call = { key: "tidier", changes: [{ hob: "Bram", good_at: "Tidy notes.", instructions: "Be tidy." }] };
  await api("POST", `/threads/${thread.id}/messages`, {
    content: `Tidy up\nfake:hub summoning_change ${JSON.stringify(call)}`,
  });
  await page.goto(`${url}/#/hobs/${bram.id}/threads/${thread.id}`);

  const card = page.locator("[data-tray]").getByRole("region", { name: "Bram proposes changes to itself" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  // Each field's name stays on one line, however narrow its column.
  const label = card.getByRole("rowheader", { name: "Good at" });
  const box = await label.boundingBox();
  const lineHeight = await label.evaluate((element) => Number.parseFloat(getComputedStyle(element).lineHeight));
  expect(box?.height ?? 0).toBeLessThan(lineHeight * 1.5 + 4);
  await expectAccessible(page, card);

  await card.getByRole("button", { name: "Always allow all of these" }).click();
  await expect(card.getByRole("status")).toContainText("to Allow for Bram");
  await expect(card.getByRole("button", { name: /^Always allow/ })).toHaveCount(0);
  // Deciding the last row takes the card, and its focused button, out of the tray: focus moves on to
  // the composer, never to the page (#995).
  await card.getByRole("button", { name: "Allow", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-tray]")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByRole("textbox", { name: /^Message Bram/ })).toBeFocused();
  // Decided, nothing of it shows in the transcript until its step is opened, and then one line.
  const settled = page.getByRole("region", { name: "Bram proposes changes to itself" });
  await expect(settled).toHaveCount(0);
  await page.getByRole("list", { name: "Reply steps" }).getByRole("button").first().click();
  await expect(settled.getByRole("status")).toContainText("Bram: Allowed");
  await expect(settled.getByRole("article")).toHaveCount(0);
  await expectAccessible(page, settled);
});

// covers STD-TEST-010, the design system (one place asks for you), ADR 034
test("[TC-UX-409-05] a tall proposal scrolls inside the tray at the smallest window, with the hobs it made, keeping the composer and Allow all in view", async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 640 });
  const { url, api, bram } = await managerHub();
  const thread = await api("POST", `/agents/${bram.id}/threads`);
  const names = ["Abe", "Bea", "Cal", "Dee", "Eli", "Fen", "Gil", "Hal", "Ike", "Jo"];
  await api("POST", `/threads/${thread.id}/messages`, { content: summon("hire-ten", names) });
  await page.goto(`${url}/#/hobs/${bram.id}/threads/${thread.id}`);

  const card = page.locator("[data-tray]").getByRole("region", { name: "Bram proposes 10 new hobs" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  const rows = card.getByRole("list", { name: "Hobs" });
  await expect(rows.getByRole("article")).toHaveCount(10);
  const box = rows.locator("xpath=..");
  const composer = page.getByRole("textbox", { name: /^Message Bram/ });
  const inView = async () => {
    expect(await box.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    await expect(card.getByRole("button", { name: "Allow all" })).toBeInViewport();
    await expect(composer).toBeInViewport();
  };
  await inView();

  // Allowing eight rows, with two still waiting, adds a card per hob made; they scroll with the rows.
  for (const name of names.slice(0, 8)) {
    await rows.getByRole("article", { name }).getByRole("button", { name: "Allow" }).click();
    await expect(rows.getByRole("article", { name })).toHaveAttribute("data-state", "allowed", { timeout: 20_000 });
  }
  const created = card.getByRole("region", { name: "Created" });
  await expect(created.getByRole("link")).toHaveCount(8);
  await inView();
  await expectAccessible(page, card);

  await card.getByRole("button", { name: "Deny all" }).click();
  await expect(page.locator("[data-tray]")).toHaveCount(0, { timeout: 20_000 });
});
