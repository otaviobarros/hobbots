import { randomUUID } from "node:crypto";
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

  // The card waits on the call's step in the chat.
  const inChat = page.getByRole("region", { name: "Bram proposes 3 new hobs" });
  await expect(inChat).toBeVisible({ timeout: 20_000 });
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
