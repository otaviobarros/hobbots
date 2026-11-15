import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { addCampMember, expect, test, testPeople } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #1467 (ADR 039, Members): Make a camp picks its hobs, the first leading, and the camp's
// members sheet lists its hobs and people, what each hob spent here today, and adds and takes out
// hobs, in the four themes, wide and narrow, by keyboard as by pointer.

test.afterEach(stopAldricHub);

const THEMES = ["lamplight-dusk", "lamplight-paper", "workshop-night", "workshop-daylight"] as const;

/** Where screenshots go when `HOBBOTS_E2E_SHOTS` names a folder, to compare with the design. */
const shot = async (page: Page, name: string) => {
  const folder = process.env.HOBBOTS_E2E_SHOTS;
  if (folder !== undefined) await page.screenshot({ path: `${folder}/${name}.png` });
};

/** Puts the app in `theme`, as Settings › This app would. */
const pickTheme = async (page: Page, theme: string) => {
  await page.evaluate((id) => localStorage.setItem("hobbots.theme", JSON.stringify(id)), theme);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
};

const makeCampSheet = (page: Page) => page.getByRole("dialog", { name: "Make a camp" });
const membersSheet = (page: Page) => page.getByRole("dialog", { name: "Launch" });
const hobRows = (page: Page) =>
  membersSheet(page)
    .getByRole("list", { name: /^Hobs · / })
    .getByRole("listitem");

// covers ADR 039 (Members), UX-001
test("Make a camp picks its hobs by keyboard, the first leading, in the four themes", async ({ page }) => {
  const { url, aldric } = await aldricHub(undefined, ["Quill", "Pip"]);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Make a camp" }).first().click();
  const sheet = makeCampSheet(page);
  const picked = sheet.getByRole("list", { name: "Picked" });
  await expect(picked.getByRole("listitem")).toHaveText([/You$/, "Aldric · lead"]);

  // Each hob is a checkbox in the Members group; Space ticks it.
  const members = sheet.getByRole("group", { name: "Members" });
  await expect(members.getByRole("checkbox")).toHaveCount(3);
  await expect(members.getByRole("checkbox", { name: /^Aldric/ })).toBeChecked();
  await members.getByRole("checkbox", { name: /^Quill/ }).focus();
  await page.keyboard.press("Space");
  await expect(picked.getByRole("listitem")).toHaveText([/You$/, "Aldric · lead", "Quill"]);

  // Unticking the lead makes the next hob picked lead; no hob at all is a problem to fix.
  await members.getByRole("checkbox", { name: /^Aldric/ }).focus();
  await page.keyboard.press("Space");
  await expect(picked.getByRole("listitem")).toHaveText([/You$/, "Quill · lead"]);
  await members.getByRole("checkbox", { name: /^Quill/ }).focus();
  await page.keyboard.press("Space");
  await sheet.getByRole("textbox", { name: "Name" }).fill("Launch");
  await sheet.getByRole("button", { name: "Make the camp" }).click();
  await expect(sheet.getByRole("alert")).toHaveText("Pick at least one hob to lead the camp.");
  for (const name of [/^Aldric/, /^Pip/]) {
    await members.getByRole("checkbox", { name }).focus();
    await page.keyboard.press("Space");
  }
  await expect(picked.getByRole("listitem")).toHaveText([/You$/, "Aldric · lead", "Pip"]);
  await expectAccessible(page, sheet);

  for (const theme of THEMES) {
    await pickTheme(page, theme);
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Make a camp" })
      .first()
      .click();
    await expect(sheet.getByRole("group", { name: "Members" })).toBeVisible();
    await expectAccessible(page, sheet);
    await shot(page, `make-camp-hobs--${theme}`);
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  }

  // Made with Aldric leading and Pip, the camp opens under Aldric with its three members.
  await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Make a camp" }).first().click();
  await sheet.getByRole("textbox", { name: "Name" }).fill("Launch");
  await members.getByRole("checkbox", { name: /^Pip/ }).focus();
  await page.keyboard.press("Space");
  await sheet.getByRole("button", { name: "Make the camp" }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
  await expect(page.getByRole("button", { name: "Members: 3" })).toBeVisible();
});

// covers ADR 039 (Members; Status and cost), UX-001
test("the members sheet lists the camp's hobs and people, adds and takes out a hob, wide and narrow in the four themes", async ({
  page,
}) => {
  const { url, aldric, members, api, hub } = await aldricHub(undefined, ["Quill", "Pip"], {
    HOBBOTS_TEST_PEOPLE: "on",
  });
  const [quill, pip] = members;
  const camp = await api("POST", `/agents/${aldric}/camps`, {
    key: crypto.randomUUID(),
    title: "Launch",
    goal: "Ship the launch post",
    private: false,
    hobs: [quill],
  });
  // Bruna joins through the test seam, as #1458's tests add people.
  const [bruna] = testPeople(hub);
  if (bruna === undefined) throw new Error("The hub added no test people.");
  await addCampMember(hub, camp.id, { kind: "user", id: bruna.userId });
  // A turn today, so the sheet has turns and tokens to show.
  await api("POST", `/threads/${camp.id}/messages`, { content: "@Aldric plan the launch" });
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto(`${url}/#/hobs/${aldric}/threads/${camp.id}`);
  // Aldric's echo starts with what the hub told him about the camp.
  await expect(page.getByRole("main").getByRole("article").filter({ hasText: "Echo: ## Who is here" })).toBeVisible({
    timeout: 20_000,
  });

  // The header's button opens the sheet; Escape closes it and gives focus back.
  const button = page.getByRole("button", { name: "Members: 4" });
  await button.focus();
  await page.keyboard.press("Enter");
  const sheet = membersSheet(page);
  await expect(sheet).toContainText("Camp · 2 people, 2 hobs");
  await expect(sheet).toContainText("Goal: Ship the launch post");
  await expect(hobRows(page)).toHaveCount(2);
  await expect(hobRows(page).first()).toContainText("Aldric");
  await expect(hobRows(page).first()).toContainText("Lead");
  await expect(hobRows(page).first()).toContainText("1 turn");
  const people = sheet.getByRole("list", { name: "People · 2" }).getByRole("listitem");
  await expect(people.first()).toContainText("YouOwner");
  await expect(people.nth(1)).toContainText(bruna.name);
  await expect(sheet).toContainText("1 turn here today");
  // The lead cannot be taken out; the other hob can.
  await expect(sheet.getByRole("button", { name: "Take Aldric out of this camp" })).toHaveCount(0);
  await expectAccessible(page, sheet);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(button).toBeFocused();

  // Add a hob lists the hobs not here; adding Pip makes it a member.
  await button.click();
  await sheet.getByRole("button", { name: "Add a hob" }).click();
  await expect(sheet.getByRole("list", { name: "Pick a hob to add" }).getByRole("button")).toHaveAccessibleName(
    "Add Pip",
  );
  await sheet.getByRole("button", { name: "Add Pip" }).click();
  await expect(hobRows(page)).toHaveCount(3);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Members: 5" })).toBeVisible();

  for (const [width, label] of [
    [1280, "wide"],
    [420, "narrow"],
  ] as const) {
    await page.setViewportSize({ width, height: 860 });
    for (const theme of THEMES) {
      await pickTheme(page, theme);
      await page.getByRole("button", { name: "Members: 5" }).click();
      await expect(hobRows(page)).toHaveCount(3);
      await expectAccessible(page, sheet);
      await shot(page, `members-${label}--${theme}`);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();
    }
  }

  // Taking Quill out leaves Aldric and Pip.
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.getByRole("button", { name: "Members: 5" }).click();
  await sheet.getByRole("button", { name: "Take Quill out of this camp" }).click();
  await expect(hobRows(page)).toHaveCount(2);
  await expect(sheet).not.toContainText("Quill");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Members: 4" })).toBeVisible();

  // A hob that retires stays in the camp as left, still named, with what it spent here.
  await api("POST", `/agents/${pip}/retire`, { activeWork: "finish" });
  await page.getByRole("button", { name: /^Members: / }).click();
  await expect(hobRows(page)).toHaveCount(2);
  await expect(hobRows(page).nth(1)).toContainText("Pip");
});
