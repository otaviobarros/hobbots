import { randomUUID } from "node:crypto";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// #412: hob management end to end in the browser (ADR 034), on a hub with the fake runtime. Once you
// decide a manager's summon in the chat's Needs-you tray, the call's step shows the card with the hobs
// it made, and each opens from its card in the chat, naming who summoned it.

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

// covers ADR 034 (Asking is a proposal: created hobs come back as cards; Records and events: Summoned by), #412
test("[TC-UX-412-01] once you allow a summon in the chat, each hob it made opens from its card in the chat and shows who summoned it", async ({
  page,
}) => {
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
  const bram = await api("POST", "/agents", hobPayload("Bram", 4121));
  await api("PATCH", `/agents/${bram.id}/permissions`, { charms: { granted: ["summoning"] } });

  await page.goto(`${url}/#/hobs/${bram.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Bram/ });
  const call = {
    key: "hire-pair",
    hobs: [
      { name: "Ines", role: "writer" },
      { name: "Jory", role: "writer" },
    ],
  };
  await composer.fill(`Hire two writers\nfake:hub summoning_summon ${JSON.stringify(call)}`);
  await composer.press("Enter");

  // You decide it in the tray, from the keyboard.
  const tray = page.locator("[data-tray]").getByRole("region", { name: "Bram proposes 2 new hobs" });
  await expect(tray).toBeVisible({ timeout: 20_000 });
  await expectAccessible(page);
  await tray.getByRole("button", { name: "Allow all" }).focus();
  await page.keyboard.press("Enter");
  await expect(tray).toBeHidden({ timeout: 20_000 });

  // Decided, the card folds into the call's step, which opens to a line per hob and a card for each hob it made.
  const decided = page.getByRole("main").getByRole("region", { name: "Bram proposes 2 new hobs" });
  const created = decided.getByRole("region", { name: "Created" });
  const opened = async () => {
    await expect(decided).toHaveCount(0, { timeout: 20_000 });
    await page.getByRole("list", { name: "Reply steps" }).getByRole("button").first().click();
    await expect(created.getByRole("link")).toHaveCount(2, { timeout: 20_000 });
  };
  await opened();
  await expect(decided.getByRole("status")).toContainText("Ines: Allowed");
  await expect(decided.getByRole("status")).toContainText("Jory: Allowed");
  await expectAccessible(page, decided);

  for (const name of ["Ines", "Jory"]) {
    await created.getByRole("link", { name: `Open ${name}` }).click();
    const profile = page.getByRole("main", { name: `${name}'s profile` });
    await expect(profile).toBeVisible();
    await expect(profile.getByText("Summoned by Bram").first()).toBeVisible();
    await expectAccessible(page);
    await page.goBack();
    await opened();
  }
});
