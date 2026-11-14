import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { campAt, emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #1463 (ADR 039, Hobs talking to hobs): two hobs that keep mentioning each other stop after
// HOB_RELAY_BUDGET turns, and the camp says they wait for a person, with Let them go on. The fake
// runtime echoes its prompt, and a relayed turn's prompt is the reply that mentioned its hob, so two
// hobs you mention together keep mentioning each other until the budget stops them.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const THEMES = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"] as const;

/** Puts the app in `theme`, as Settings › This app would. */
const pickTheme = async (page: Page, theme: string) => {
  await page.evaluate((id) => localStorage.setItem("hobbots.theme", JSON.stringify(id)), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
};

/** Where screenshots go when `HOBBOTS_E2E_SHOTS` names a folder, to compare with the design. */
const shot = async (page: Page, name: string) => {
  const folder = process.env.HOBBOTS_E2E_SHOTS;
  if (folder !== undefined) await page.screenshot({ path: `${folder}/${name}.png` });
};

/**
 * Makes `hobId` a member of the camp, as the members sheet will (#1467): the app cannot add one yet,
 * so the test writes the row beside the camp's own hob's, with the hub stopped.
 */
const addMember = (camp: string, hobId: string) => {
  const database = new DatabaseSync(join(dataDir, "hobbots.sqlite"));
  database
    .prepare(
      `INSERT INTO thread_members (thread_id, actor_kind, actor_id, role, state, joined_at, added_by_kind,
         added_by_id, read_revision, muted_until, revision)
       SELECT thread_id, 'hob', ?, 'member', state, joined_at, added_by_kind, added_by_id, read_revision,
         muted_until, revision
       FROM thread_members WHERE thread_id = ? AND actor_kind = 'hob'`,
    )
    .run(hobId, camp);
  database.close();
};

/** How many relays wait for a person in the camp, as the hub stored them. */
const pausedRelays = () => {
  const database = new DatabaseSync(join(dataDir, "hobbots.sqlite"), { readOnly: true });
  const row = database.prepare(`SELECT COUNT(*) AS paused FROM turn_requests WHERE state = 'paused'`).get();
  database.close();
  return Number(row?.paused);
};

// covers ADR 039 (Hobs talking to hobs)
test("[TC-CH-1463-05] two hobs that mention each other pause after 3 turns, and Let them go on gives them 3 more, in the four themes", async ({
  page,
}) => {
  // Each relayed turn echoes a briefing that grows, so the fourteen turns take a few minutes.
  test.setTimeout(360_000);
  dataDir = emptyDataDir();
  let current = await startHub(dataDir);
  hub = current;
  const api = async (method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${current.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...current.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const ids: Record<string, string> = {};
  for (const [i, name] of ["Aldric", "Quill"].entries()) {
    const made = await api("POST", "/agents", {
      id: randomUUID(),
      name,
      role: "assistant",
      roleTitle: "Assistant",
      sigil: "assistant",
      hat: "pointed",
      tool: "none",
      lookSeed: 1000 + i * 337,
      lookColor: "violet",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: "",
    });
    ids[name] = made.id;
  }
  const camp = await campAt(current, ids.Aldric ?? "", "Launch crew");
  await current.stop();
  addMember(camp.id, ids.Quill ?? "");
  current = await startHub(dataDir);
  hub = current;

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(camp.url);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("@Aldric @Quill work out the launch checklist between you");
  await composer.press("Enter");

  // Each hob answers you, then each answer starts a relay that stops after 3 turns.
  const paused = page.getByRole("region", { name: "Hobs paused, waiting for a person" });
  await expect(paused).toBeVisible({ timeout: 60_000 });
  await expect(paused).toContainText(/(Aldric and Quill|Quill and Aldric) answered each other 3 times in a row/);
  // How many replies the hobs finished in the camp, as the hub stores them.
  const replies = async () => {
    const response = await fetch(`${current.url}/api/threads/${camp.id}/messages`, { headers: current.headers });
    const messages = (await response.json()) as ReadonlyArray<{ readonly role: string; readonly status: string }>;
    return messages.filter((message) => message.role === "assistant" && message.status === "complete").length;
  };
  await expect.poll(replies, { timeout: 60_000 }).toBe(8);
  // The last reply's turn writes its paused relay as it ends, just after the reply is saved.
  await expect.poll(pausedRelays, { timeout: 30_000 }).toBe(2);

  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await expect(paused).toBeVisible();
    // The transcript can render again as the theme loads, so scroll to the card once it holds still.
    await expect(() => paused.scrollIntoViewIfNeeded({ timeout: 1_000 })).toPass();
    await expectAccessible(page, paused);
    await shot(page, `hobs-paused--${theme}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await expect(paused).toBeVisible();
    // The transcript can render again as the theme loads, so scroll to the card once it holds still.
    await expect(() => paused.scrollIntoViewIfNeeded({ timeout: 1_000 })).toPass();
    await expectAccessible(page, paused);
    await shot(page, `hobs-paused-narrow--${theme}`);
  }

  // Let them go on: each paused relay takes 3 more turns, the resumed one first, then waits again.
  await paused.getByRole("button", { name: "Let them go on" }).click();
  await expect.poll(replies, { timeout: 180_000 }).toBe(14);
  await expect.poll(pausedRelays, { timeout: 30_000 }).toBe(2);
  await expect(paused).toBeVisible({ timeout: 30_000 });

  // Your message takes over: what was paused is dropped, and with no mention nobody answers.
  await composer.fill("Thanks, I'll take it from here.");
  await composer.press("Enter");
  await expect(paused).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole("main").getByText("Thanks, I'll take it from here.")).toBeVisible();
  expect(await replies()).toBe(14);
});
