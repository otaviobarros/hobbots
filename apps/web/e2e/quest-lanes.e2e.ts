import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { dock, lane, laneHead, openRoom, ticket } from "./quest-room.ts";

test.afterEach(stopQuestHub);

const TITLE = "Plan the Black Friday campaign";

/** Asks Aldric for a scripted request on a fresh page and opens the room on it. */
const startRoom = async (page: Page, url: string, aldric: string, ask: string, title: string) => {
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(ask);
  await composer.press("Enter");
  await expect(ticket(page, title)).toBeVisible();
  return openRoom(page, title);
};

const lineup = (room: Locator) => room.getByRole("list", { name: "The party" }).getByRole("button");

/** Whether every element in a lane has stopped moving. */
const still = (target: Locator) =>
  target.evaluate((element) =>
    [element, ...element.querySelectorAll("*")].every((each) => getComputedStyle(each).animationName === "none"),
  );

// covers UX-002, OR-001
test("[TC-UX-208] the Black Friday party's lanes fill live from the records: beats, waits, chips and results", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  const room = await startRoom(page, url, aldric, "Plan a Black Friday campaign for the shop", TITLE);

  // A lane per hob, each a region named for its hob, the lead's first and named so.
  const lanes = room.getByRole("region", { name: "Lanes" });
  await expect(lanes.getByRole("region", { name: /'s lane$/ })).toHaveCount(3);
  await expect(laneHead(page, "Aldric")).toContainText("Lead");
  await expect(laneHead(page, "Quill")).toContainText("Draft the landing copy");
  await expect(lineup(room)).toHaveCount(3);

  // Quill's milestones show as beats as they come, then the result once the copy is ready.
  const quill = lane(page, "Quill").getByRole("list", { name: "What Quill did" });
  await expect(quill).toContainText("Three headlines drafted", { timeout: 20_000 });
  await expect(quill).toContainText("Landing copy ready", { timeout: 30_000 });
  await expect(laneHead(page, "Quill")).toContainText("Done");

  // Ada's lane takes the copy, reports, and lights up for the question that climbed to you.
  const ada = lane(page, "Ada").getByRole("list", { name: "What Ada did" });
  await expect(ada).toContainText("Keyword research done", { timeout: 30_000 });
  await expect(laneHead(page, "Ada")).toContainText("Needs you", { timeout: 30_000 });
  await expect(lane(page, "Ada").getByRole("region", { name: "Ada asks you" })).toBeVisible();
});

// covers UX-002, OR-001
test("[TC-UX-209] a lane marks the files its hob changed and deleted, by their path in its folder", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await startRoom(page, url, aldric, "Make the shop badge in our green", "Make the shop badge");

  // Aldric cleared the old badge before he delegated; Quill then made it again. In everyday words a
  // lane names the file and what happened to it.
  const aldricDid = lane(page, "Aldric").getByRole("list", { name: "What Aldric did" });
  await expect(aldricDid).toContainText("Deleted badge.png", { timeout: 20_000 });
  const quillDid = lane(page, "Quill").getByRole("list", { name: "What Quill did" });
  await expect(quillDid).toContainText(/(Created|Updated) badge\.png/, { timeout: 20_000 });
  await expect(quillDid).not.toContainText("web/badge.png");

  // The technical steps show each mark by its path in the hob's folder, never the whole path.
  await page.getByRole("button", { name: "Show technical steps" }).click();
  await expect(aldricDid.getByRole("listitem").filter({ hasText: "Deleted" })).toContainText("web/badge.png");
  const quillEdited = quillDid.getByRole("listitem").filter({ hasText: "Edited" });
  await expect(quillEdited).toContainText("web/badge.png");
  // Only the marks: Quill's note on what it left uncommitted names its folder on purpose, and it
  // arrives whenever Quill finishes, so the lane as a whole may or may not show it yet.
  await expect(quillEdited).not.toContainText("/fake/shop");
});

// covers UX-002, OR-004
test("[TC-UX-210] a nested Quest groups its members' lanes under the party of the member that leads it", async ({
  page,
}) => {
  const { url, aldric } = await questHub({ nested: true });
  const room = await startRoom(page, url, aldric, "Plan a Black Friday campaign for the shop", TITLE);

  const party = room.getByRole("region", { name: "Rook's party" });
  await expect(party.getByRole("region", { name: "Rook's lane", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(party.getByRole("region", { name: "Pip's lane", exact: true })).toBeVisible();
  await expect(party.getByRole("region", { name: "Quill's lane", exact: true })).toHaveCount(0);
  await expect(laneHead(page, "Rook")).toContainText("Leads Pip");
  await expect(lineup(room)).toHaveCount(5);
  await expect(lane(page, "Pip").getByRole("list", { name: "What Pip did" })).toContainText(
    "Twelve keywords, led by doorbuster",
    { timeout: 30_000 },
  );
});

// covers UX-002, UX-006
test("[TC-UX-211] six lanes scroll sideways, and a sprite in the lineup goes to its lane, flashes it and lights it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  const { url, aldric } = await questHub({ six: true });
  const room = await startRoom(page, url, aldric, "Plan a Black Friday campaign for the shop", TITLE);
  await expect(lineup(room)).toHaveCount(6, { timeout: 20_000 });

  const lanes = room.getByRole("region", { name: "Lanes" });
  expect(await lanes.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  const bram = lane(page, "Bram");
  await expect(bram).not.toBeInViewport();

  const go = room.getByRole("button", { name: /^Go to Bram's lane/ });
  await go.click();
  await expect(bram).toBeInViewport();
  await expect(bram).toHaveClass(/animate-hb-flash/);
  await expect(go).toHaveAttribute("aria-pressed", "true");
  await expect(laneHead(page, "Bram")).toHaveAttribute("aria-pressed", "true");
  // The flash plays once.
  await expect(bram).not.toHaveClass(/animate-hb-flash/, { timeout: 5_000 });
});

// covers UX-002, UX-006
test("[TC-UX-212] every control in a lane is reached with the keyboard, and its header lights the lane", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await startRoom(page, url, aldric, "Plan a Black Friday campaign for the shop", TITLE);
  const quill = lane(page, "Quill");
  // The Task's details, where Show in the Workbench now sits, are the lane's last control.
  const show = quill.getByText("Everything in this task");
  await expect(show).toBeVisible();

  // The header lights the lane from the keyboard, and again shows everyone.
  await laneHead(page, "Quill").focus();
  await page.keyboard.press("Enter");
  await expect(laneHead(page, "Quill")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(laneHead(page, "Quill")).toHaveAttribute("aria-pressed", "false");

  // Tab goes through the lane's controls in order and reaches its Task's, never the page.
  let reached = false;
  for (let step = 0; step < 12 && !reached; step++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement !== document.body)).toBe(true);
    reached = await show.evaluate((element) => element === document.activeElement);
  }
  expect(reached).toBe(true);
});

// covers UX-002, UX-006
test("[TC-UX-213] with Reduce motion the sprites stop hopping and the lineup's jump does not flash", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const { url, aldric } = await questHub();
  const room = await startRoom(page, url, aldric, "Plan a Black Friday campaign for the shop", TITLE);
  await expect(laneHead(page, "Quill")).toContainText("Running", { timeout: 20_000 });
  expect(await still(lane(page, "Quill"))).toBe(true);
  expect(await still(room.getByRole("region", { name: "Lanes" }))).toBe(true);

  await room.getByRole("button", { name: /^Go to Ada's lane/ }).click();
  await expect(laneHead(page, "Ada")).toHaveAttribute("aria-pressed", "true");
  await expect(lane(page, "Ada")).not.toHaveClass(/animate-hb-flash/);
});

// covers UX-002, OR-001
test("[TC-UX-214] a lane whose records could not be read says so and reads them again with Try again", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  // The lanes read the Quest's Workbench in one call.
  const activity = "**/api/tasks/*/workbench";
  await page.route(activity, (route) => route.fulfill({ status: 500, body: "" }));
  await startRoom(page, url, aldric, "Make the shop badge in our green", "Make the shop badge");

  // The lane keeps what the tree says and says the rest is missing.
  const quill = lane(page, "Quill");
  const alert = quill.getByRole("alert");
  await expect(alert).toContainText("Some of what Quill did could not be read.", { timeout: 30_000 });
  await expect(laneHead(page, "Quill")).toContainText("Make the shop badge");

  // Once the hub answers again, Try again brings the marks in and the alert goes.
  await page.unroute(activity);
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(quill.getByRole("list", { name: "What Quill did" })).toContainText("badge.png", {
    timeout: 20_000,
  });
  await expect(alert).toBeHidden();
});

// covers UX-002
test("[TC-UX-284] a finished Quest says so under the header and folds each lane to its result", async ({ page }) => {
  const { url, aldric } = await questHub();
  const room = await startRoom(page, url, aldric, "Wrap up the spec for the shop", "Wrap up the spec");

  const finished = room.getByRole("region", { name: /^(Quest|Task) finished$/ });
  await expect(finished).toContainText("Spec wrapped up", { timeout: 20_000 });
  await expect(finished).toContainText(/took /);

  // See what changed opens the whole Quest's changes, filtered to no one.
  await finished.getByRole("button", { name: "See what changed" }).click();
  await expect(dock(page).getByRole("tab", { name: /^Changes/ })).toHaveAttribute("aria-selected", "true");
  await expect(dock(page)).toContainText("SPEC.md");
  await expect(dock(page).getByRole("button", { name: /only$/ })).toHaveCount(0);

  // Aldric's lane keeps its result and folds the rest, which opens in everyday words.
  const did = lane(page, "Aldric").getByRole("list", { name: "What Aldric did" });
  await expect(did).not.toContainText("SPEC.md");
  await lane(page, "Aldric")
    .getByRole("button", { name: /^Show the \d+ steps?$/ })
    .click();
  await expect(did).toContainText(/(Created|Updated) SPEC\.md/);

  // In a narrow window the switch for the technical steps sits in the quest's menu.
  await page.setViewportSize({ width: 960, height: 800 });
  await room.getByRole("button", { name: "Wrap up the spec menu" }).click();
  await page.getByRole("menuitem", { name: "Show technical steps" }).click();
  await expect(did).toContainText("docs/SPEC.md");
});
