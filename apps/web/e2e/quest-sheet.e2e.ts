import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { openQuest, taskSheet } from "./work-sheet.ts";

test.afterEach(stopQuestHub);

/** Goes from a task sheet back to the quest sheet it slid in over. */
const backTo = (sheet: Locator, title: string) => sheet.getByRole("button", { name: `Back to ${title}` }).click();

/** The quest button for this request in the chat header. */
const headerQuest = (page: Page, title: string) =>
  page.getByRole("region", { name: "Work in progress" }).getByRole("button", { name: new RegExp(title) });

// covers CH-005, OR-006, UX-001
test("[TC-CH-190] the quest sheet shows the whole tree live with its controls and keeps a pinned Quest in every thread", async ({
  page,
}) => {
  // Ada waits on Quill for only a few steps: slower steps keep that in view on a busy machine.
  const { url, aldric } = await questHub({ stepMs: 1500 });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // The quest sheet lists every Task, its owner, where it stands and who it waits on.
  const room = await openQuest(page, "Plan the Black Friday campaign");
  await expect(room).toContainText("Aldric's quest");
  await expect(room.getByRole("button", { name: /Quill · Draft the landing copy/ })).toBeVisible();
  const build = room.getByRole("button", { name: /Ada · Build the campaign/ });
  await expect(build).toContainText("waiting on Quill");
  await expect(build).toContainText("you", { timeout: 15_000 });
  await expect(room.getByRole("button", { name: "Cancel Quest" })).toBeEnabled();
  await expect(room).not.toContainText("arrive once the hub can confirm");

  // A row opens its task sheet, with the controls that apply to it.
  await build.click();
  const sheet = taskSheet(page, "Build the campaign");
  const controls = sheet.getByRole("region", { name: "Controls for Build the campaign" });
  await expect(controls.getByRole("button", { name: "Reassign" })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "Cancel Task" })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await backTo(sheet, "Plan the Black Friday campaign");

  // Pinned, the Quest stays in the header of another thread, and its Tasks still open there.
  const pin = room.getByRole("button", { name: "Pin" });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(pin).toHaveText("Pinned");
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await page.getByRole("textbox", { name: /^Message Aldric/ }).fill("Something else");
  await page.getByRole("textbox", { name: /^Message Aldric/ }).press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await headerQuest(page, "Plan the Black Friday campaign").click();
  await expect(room).toContainText("Pinned from another thread");
  await room.getByRole("button", { name: /Quill · Draft the landing copy/ }).click();
  const copy = taskSheet(page, "Draft the landing copy");
  await expect(copy).toBeVisible();
  await backTo(copy, "Plan the Black Friday campaign");

  // The answer goes back from the card in the Quest's own thread, and the sheet follows live.
  await room.getByRole("link", { name: "Open its thread" }).click();
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await openQuest(page, "Plan the Black Friday campaign");
  await expect(room.getByRole("button", { name: /Ada · Build the campaign/ })).toContainText("Done", {
    timeout: 15_000,
  });
  // The Quest ends only once Aldric's chat has read each member's result, a paced fake reply apiece.
  await expect(room.getByRole("button", { name: "Cancel Quest" })).toHaveCount(0, { timeout: 30_000 });

  // Unpinned, it leaves the other thread's header.
  await room.getByRole("button", { name: "Pin" }).click();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: /^Message Aldric/ })).toBeVisible();
  await expect(headerQuest(page, "Plan the Black Friday campaign")).toHaveCount(0);

  // A pin the hub no longer has says so and can be unpinned.
  await page.evaluate(() => localStorage.setItem("quest.pinned", JSON.stringify(["gone"])));
  await page.reload();
  await expect(page.getByText("A pinned Quest is no longer on this hub.")).toBeVisible();
  await page.getByRole("button", { name: "Unpin" }).click();
  await expect(page.getByText("A pinned Quest is no longer on this hub.")).toBeHidden();
});

// covers CH-005, OR-006, UX-001
test("[TC-CH-193] the task sheet says why a Reassign is refused, and the quest sheet cancels the Black Friday Quest until every Task confirms", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const room = await openQuest(page, "Plan the Black Friday campaign");
  const copy = room.getByRole("button", { name: /Quill · Draft the landing copy/ });
  const build = room.getByRole("button", { name: /Ada · Build the campaign/ });
  // Quill's copy is done and Ada waits on your answer: two Tasks run when the Quest is cancelled.
  await expect(copy).toContainText("Done", { timeout: 15_000 });
  await expect(build).toContainText("Needs you", { timeout: 15_000 });

  // Reassign offers only the hobs the hub would accept, and a refusal says why on the sheet.
  await build.click();
  const sheet = taskSheet(page, "Build the campaign");
  const controls = sheet.getByRole("region", { name: "Controls for Build the campaign" });
  await controls.getByRole("button", { name: "Reassign" }).click();
  const picker = controls.getByRole("group", { name: "Give Build the campaign to" });
  await expect(picker.getByRole("button", { name: "Aldric" })).toHaveCount(0);
  await picker.getByRole("button", { name: "Quill" }).click();
  await expect(controls.getByRole("alert")).toHaveText(
    "Ada is working on it right now. Reassign it once that turn ends.",
  );
  await picker.getByRole("button", { name: "Keep it" }).click();
  await expect(picker).toBeHidden();
  await backTo(sheet, "Plan the Black Friday campaign");
  await expect(build).toContainText("Needs you");

  // Cancel Quest asks first, then shows Cancelling… until every Task confirms it stopped.
  const cancel = room.getByRole("button", { name: "Cancel Quest" });
  await cancel.click();
  await expect(room).toContainText("Cancel this quest? Every hob on it stops.");
  await room.getByRole("button", { name: "Keep it" }).click();
  await expect(room).not.toContainText("Cancel this quest?");
  await cancel.click();
  await room.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(room.getByRole("status").filter({ hasText: "Cancelled: 2 Tasks confirmed they stopped." })).toBeVisible({
    timeout: 15_000,
  });
  await expect(room.getByRole("button", { name: /Aldric · Plan the Black Friday campaign/ })).toContainText(
    "Cancelled",
  );
  await expect(build).toContainText("Cancelled");
  await expect(copy).toContainText("Done");
  await expect(room.getByRole("button", { name: /Cancel Quest|Cancelling…/ })).toHaveCount(0);
  await expect(page.getByText("Aldric stopped this")).toBeVisible();

  // Once it ended nothing is left to control, but its Workbench still opens.
  await build.click();
  await expect(sheet).toContainText("Cancelled");
  await expect(controls.getByRole("button")).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Open Workbench" })).toBeEnabled();
});

// covers CH-005, OR-006, EX-001, UX-001
test("[TC-CH-192] the task sheet cancels a Task, retries a failed one and gives another to a new hob, each live", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a spring sale for the shop");
  await composer.press("Enter");
  const quest = "Plan the spring sale";
  const room = await openQuest(page, quest);
  const signs = room.getByRole("button", { name: /Quill · Order the sale signs/ });
  const banner = room.getByRole("button", { name: /Quill · Write the sale banner/ });
  const email = room.getByRole("button", { name: /· Schedule the sale email/ });
  await expect(signs).toContainText("Running", { timeout: 15_000 });
  await expect(banner).toContainText("Failed");
  await expect(email).toContainText("Ada");
  await expect(page.getByText("Aldric's party: Quill and Ada")).toBeVisible();

  // Cancel Task asks first, then the Task confirms it stopped; the sheet and the row follow.
  await signs.click();
  const signsSheet = taskSheet(page, "Order the sale signs");
  const signsControls = signsSheet.getByRole("region", { name: "Controls for Order the sale signs" });
  await expect(signsControls.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await signsControls.getByRole("button", { name: "Cancel Task" }).click();
  await expect(signsControls).toContainText("Cancel Order the sale signs and everything under it?");
  await signsControls.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(signsControls.getByRole("status")).toHaveText("Cancelled: the Task confirmed it stopped.", {
    timeout: 15_000,
  });
  await expect(signsSheet).toContainText("Cancelled");
  await expect(signsControls.getByRole("button", { name: "Cancel Task" })).toHaveCount(0);
  await backTo(signsSheet, quest);
  await expect(signs).toContainText("Cancelled");

  // Retry queues the failed Task again for a new Attempt of the same Task.
  await banner.click();
  const bannerSheet = taskSheet(page, "Write the sale banner");
  const bannerControls = bannerSheet.getByRole("region", { name: "Controls for Write the sale banner" });
  await expect(bannerSheet).toContainText("attempt 1");
  await bannerControls.getByRole("button", { name: "Retry" }).click();
  await expect(bannerSheet).toContainText(/Queued: waiting for Quill to start Attempt 2\.|attempt 2/);
  await expect(bannerSheet).toContainText("attempt 2", { timeout: 15_000 });
  await backTo(bannerSheet, quest);
  await expect(banner).not.toContainText("Failed");

  // Reassign gives Ada's failed Task to Quill, the only hob it can go to, and the party follows.
  await email.click();
  const emailControls = taskSheet(page, "Schedule the sale email").getByRole("region", {
    name: "Controls for Schedule the sale email",
  });
  await emailControls.getByRole("button", { name: "Reassign" }).click();
  const picker = emailControls.getByRole("group", { name: "Give Schedule the sale email to" });
  await expect(picker.getByRole("button")).toHaveText(["Quill", "Keep it"]);
  await picker.getByRole("button", { name: "Quill" }).click();
  await expect(picker).toBeHidden();
  await expect(emailControls.getByRole("alert")).toHaveCount(0);
  await backTo(taskSheet(page, "Schedule the sale email"), quest);
  await expect(room.getByRole("button", { name: /Quill · Schedule the sale email/ })).toBeVisible();
  await expect(page.getByText("Aldric's party: Quill", { exact: true })).toBeVisible();
});

// covers CH-005, OR-004
test("[TC-CH-191] a nested Quest shows under its member on the quest sheet, and the member names the party it leads", async ({
  page,
}) => {
  const { url, aldric } = await questHub({ nested: true });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  const room = await openQuest(page, "Plan the Black Friday campaign");
  const rook = room.getByRole("button", { name: /Rook · Run the ads/ });
  const pip = room.getByRole("button", { name: /Pip · Research the keywords/ });
  await expect(rook).toContainText("Leads Pip");
  await expect(pip).toBeVisible();
  // Pip sits under Rook, one level further in.
  const left = async (row: Locator) => (await row.evaluate((each) => getComputedStyle(each).paddingInlineStart)) ?? "";
  const [rookPad, pipPad] = await Promise.all([left(rook), left(pip)]);
  expect(Number.parseFloat(pipPad)).toBeGreaterThan(Number.parseFloat(rookPad));
  await expect(pip).toContainText("Done", { timeout: 30_000 });
  await expect(rook).toContainText("Done", { timeout: 30_000 });
});
