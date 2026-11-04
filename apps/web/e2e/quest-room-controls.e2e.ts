import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { lane, laneHead, laneTask, openRoom, roomMenu, showInWorkbench } from "./quest-room.ts";

test.afterEach(stopQuestHub);

/** The quest button for this request in the chat header. */
const headerQuest = (page: Page, title: string) =>
  page.getByRole("region", { name: "Work in progress" }).getByRole("button", { name: new RegExp(title) });

/** The controls of one Task in its lane. */
const controlsOf = (page: Page, title: string, owner?: string) =>
  laneTask(page, title, owner).getByRole("region", { name: `Controls for ${title}` });

// covers CH-005, OR-006, UX-001
test("[TC-CH-190] the Quest room shows every lane live with its controls and keeps a pinned Quest in every thread", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // The room has a lane per hob, with its Task, where it stands and who it waits on.
  const title = "Plan the Black Friday campaign";
  const room = await openRoom(page, title);
  await expect(room).toContainText("Aldric's quest");
  await expect(laneHead(page, "Quill")).toContainText("Draft the landing copy");
  await expect(laneTask(page, "Build the campaign")).toContainText("waiting on Quill");
  await expect(laneHead(page, "Ada")).toContainText("you", { timeout: 15_000 });
  await roomMenu(page, title);
  await expect(page.getByRole("menuitem", { name: "Cancel quest…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(room).not.toContainText("arrive once the hub can confirm");

  // Each lane holds the controls that apply to its Task.
  const controls = controlsOf(page, "Build the campaign");
  await expect(controls.getByRole("button", { name: "Reassign" })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "Cancel task" })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // Pinned, the Quest stays in the header of another thread, and its room opens there.
  await roomMenu(page, title);
  await page.getByRole("menuitem", { name: "Pin quest" }).click();
  await roomMenu(page, title);
  await expect(page.getByRole("menuitem", { name: "Unpin quest" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await page.getByRole("textbox", { name: /^Message Aldric/ }).fill("Something else");
  await page.getByRole("textbox", { name: /^Message Aldric/ }).press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await headerQuest(page, title).click();
  await expect(room).toContainText("Pinned from another thread");
  await expect(lane(page, "Quill")).toBeVisible();

  // The answer goes back from the card in the Quest's own thread, and the room follows live.
  await room.getByRole("link", { name: "Open its thread" }).click();
  const asks = page.getByRole("main", { name: "Chat" }).getByRole("region", { name: "Ada asks you" });
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(laneHead(page, "Ada")).toContainText("Done", { timeout: 15_000 });
  // The Quest ends only once Aldric's chat has read each member's result, a paced fake reply apiece.
  await expect
    .poll(
      async () => {
        await roomMenu(page, title);
        const open = await page.getByRole("menuitem", { name: "Cancel quest…" }).count();
        await page.keyboard.press("Escape");
        return open;
      },
      { timeout: 30_000 },
    )
    .toBe(0);

  // Unpinned, it leaves the other thread's header.
  await roomMenu(page, title);
  await page.getByRole("menuitem", { name: "Unpin quest" }).click();
  await page.goBack();
  await expect(page.getByRole("textbox", { name: /^Message Aldric/ })).toBeVisible();
  // The room this thread had open stays until it is closed; closed, the header has no quest left.
  if (await room.isVisible()) await room.getByRole("button", { name: "Close room" }).click();
  await expect(headerQuest(page, title)).toHaveCount(0);

  // A pin the hub no longer has says so and can be unpinned.
  await page.evaluate(() => localStorage.setItem("quest.pinned", JSON.stringify(["gone"])));
  await page.reload();
  await expect(page.getByText("A pinned quest is no longer on this hub.")).toBeVisible();
  await page.getByRole("button", { name: "Unpin" }).click();
  await expect(page.getByText("A pinned quest is no longer on this hub.")).toBeHidden();
});

// covers CH-005, OR-006, UX-001
test("[TC-CH-193] a lane says why a Reassign is refused, and the room cancels the Black Friday Quest until every Task confirms", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const title = "Plan the Black Friday campaign";
  const room = await openRoom(page, title);
  const copy = laneHead(page, "Quill");
  const build = laneHead(page, "Ada");
  // Quill's copy is done and Ada waits on your answer: two Tasks run when the Quest is cancelled.
  await expect(copy).toContainText("Done", { timeout: 15_000 });
  await expect(build).toContainText("Needs you", { timeout: 15_000 });

  // Reassign offers only the hobs the hub would accept, and a refusal says why in the lane.
  const controls = controlsOf(page, "Build the campaign");
  await controls.getByRole("button", { name: "Reassign" }).click();
  const picker = controls.getByRole("group", { name: "Give Build the campaign to" });
  await expect(picker.getByRole("button", { name: "Aldric" })).toHaveCount(0);
  await picker.getByRole("button", { name: "Quill" }).click();
  await expect(controls.getByRole("alert")).toHaveText(
    "Ada is working on it right now. Reassign it once that turn ends.",
  );
  await picker.getByRole("button", { name: "Keep it" }).click();
  await expect(picker).toBeHidden();
  await expect(build).toContainText("Needs you");

  // Cancel quest… asks first, then shows Cancelling… until every Task confirms it stopped.
  await roomMenu(page, title);
  await page.getByRole("menuitem", { name: "Cancel quest…" }).click();
  await expect(room).toContainText("Cancel this quest? Every hob on it stops.");
  await room.getByRole("button", { name: "Keep it" }).click();
  await expect(room).not.toContainText("Cancel this quest?");
  await roomMenu(page, title);
  await page.getByRole("menuitem", { name: "Cancel quest…" }).click();
  await room.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(room.getByRole("status").filter({ hasText: "Cancelled: 2 tasks confirmed they stopped." })).toBeVisible({
    timeout: 15_000,
  });
  await expect(laneHead(page, "Aldric")).toContainText("Cancelled");
  await expect(build).toContainText("Cancelled");
  await expect(copy).toContainText("Done");
  await roomMenu(page, title);
  await expect(page.getByRole("menuitem", { name: "Cancel quest…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByText("Aldric stopped this")).toBeVisible();

  // Once it ended nothing is left to control, but its Workbench still opens.
  await expect(controls.getByRole("button")).toHaveCount(0);
  await expect(
    laneTask(page, "Build the campaign").getByRole("button", { name: "Show in the Workbench" }),
  ).toBeEnabled();
});

// covers CH-005, OR-006, EX-001, UX-001
test("[TC-CH-192] a lane cancels a Task, retries a failed one and gives another to a new hob, each live", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a spring sale for the shop");
  await composer.press("Enter");
  const quest = "Plan the spring sale";
  await openRoom(page, quest);
  const signs = laneTask(page, "Order the sale signs");
  const banner = laneTask(page, "Write the sale banner");
  await expect(signs).toContainText("Running", { timeout: 15_000 });
  await expect(banner).toContainText("Failed");
  await expect(lane(page, "Ada")).toContainText("Schedule the sale email");
  const card = page.getByRole("region", { name: `Aldric's work on ${quest}` });
  await expect(card.getByRole("button", { name: "Look inside Schedule the sale email" })).toContainText("Ada");

  // Cancel task asks first, then the Task confirms it stopped; the lane follows.
  const signsControls = controlsOf(page, "Order the sale signs");
  await expect(signsControls.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await signsControls.getByRole("button", { name: "Cancel task" }).click();
  await expect(signsControls).toContainText("Cancel Order the sale signs and everything under it?");
  await signsControls.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(signsControls.getByRole("status")).toHaveText("Cancelled: the task confirmed it stopped.", {
    timeout: 15_000,
  });
  await expect(signs).toContainText("Cancelled");
  await expect(signsControls.getByRole("button", { name: "Cancel task" })).toHaveCount(0);

  // Retry queues the failed Task again for a new Attempt of the same Task.
  const bannerControls = controlsOf(page, "Write the sale banner");
  await expect(banner).toContainText("attempt 1");
  await bannerControls.getByRole("button", { name: "Retry" }).click();
  await expect(banner).toContainText(/Queued: waiting for Quill to start Attempt 2\.|attempt 2/);
  await expect(banner).toContainText("attempt 2", { timeout: 15_000 });
  // Its state tag no longer says Failed; the failed try stays in its history.
  await expect(banner.locator(":scope > span").first()).not.toContainText("Failed");

  // Reassign gives Ada's failed Task to Quill, the only hob it can go to, and the lanes follow.
  const emailControls = controlsOf(page, "Schedule the sale email");
  await emailControls.getByRole("button", { name: "Reassign" }).click();
  const picker = emailControls.getByRole("group", { name: "Give Schedule the sale email to" });
  await expect(picker.getByRole("button")).toHaveText(["Quill", "Keep it"]);
  await picker.getByRole("button", { name: "Quill" }).click();
  await expect(picker).toBeHidden();
  await expect(laneTask(page, "Schedule the sale email", "Quill")).toBeVisible();
  await expect(card.getByRole("button", { name: "Look inside Schedule the sale email" })).toContainText("Quill");
});

// covers CH-005, OR-004
test("[TC-CH-191] a nested Quest's member gets a lane of its own, and the member that leads it names its party", async ({
  page,
}) => {
  const { url, aldric } = await questHub({ nested: true });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  await openRoom(page, "Plan the Black Friday campaign");
  const rook = laneHead(page, "Rook");
  const pip = laneHead(page, "Pip");
  await expect(rook).toContainText("Leads Pip");
  await expect(rook).toContainText("Run the ads");
  await expect(pip).toContainText("Research the keywords");
  await expect(pip).toContainText("Done", { timeout: 30_000 });
  await expect(rook).toContainText("Done", { timeout: 30_000 });
  // Pip's work shows in the Workbench like any other lane's.
  await showInWorkbench(page, "Research the keywords");
});
