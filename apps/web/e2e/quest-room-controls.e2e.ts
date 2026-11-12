import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import {
  cancelInLane,
  dock,
  lane,
  laneHead,
  laneMenu,
  laneTask,
  openRoom,
  roomMenu,
  showInWorkbench,
  ticket,
} from "./quest-room.ts";

test.afterEach(stopQuestHub);

/** The quest button for this request in the chat header. */
const headerQuest = (page: Page, title: string) =>
  page.getByRole("region", { name: "Work in progress" }).getByRole("button", { name: new RegExp(title) });

// covers CH-005, OR-006, UX-001
test("[TC-CH-190] the Quest room shows every lane live with its controls and keeps a pinned Quest in every thread", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // The room has a lane per hob, with its Task, where it stands and who it waits on.
  const title = "Plan the Black Friday campaign";
  const room = await openRoom(page, title);
  await expect(room).toContainText("Aldric's quest");
  await expect(laneHead(page, "Quill")).toContainText("Draft the landing copy");
  await expect(lane(page, "Ada")).toContainText("Waits on Quill");
  await expect(laneHead(page, "Ada")).toContainText("you", { timeout: 15_000 });
  await roomMenu(page, title);
  await expect(page.getByRole("menuitem", { name: "Cancel quest…" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(room).not.toContainText("arrive once the hub can confirm");

  // Each lane's ⋯ menu holds what applies to its Task. It works from the keyboard, and closing it
  // gives focus back to its button.
  const adaMenu = lane(page, "Ada").getByRole("button", { name: "Ada's task menu" });
  await adaMenu.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Ada's task" });
  await expect(menu.getByRole("menuitem")).toHaveText(["Show in the Workbench", "Reassign…", "Cancel task…"]);
  await page.keyboard.press("ArrowDown");
  await expect(menu.getByRole("menuitem", { name: "Reassign…" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(adaMenu).toBeFocused();
  // The lead's lane pins and cancels the Quest, and says what cancelling keeps.
  const aldricMenu = await laneMenu(page, "Aldric");
  await expect(aldricMenu.getByRole("menuitem")).toHaveText(["Show in the Workbench", "Pin quest", "Cancel quest…"]);
  await expect(aldricMenu).toContainText("Cancels every task under it. Aldric keeps what is done.");
  await page.keyboard.press("Escape");

  // Pinned, the Quest stays in the header of another thread, and its room opens there.
  await roomMenu(page, title);
  await page.getByRole("menuitem", { name: "Pin quest" }).click();
  await roomMenu(page, title);
  await expect(page.getByRole("menuitem", { name: "Unpin quest" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
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
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
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

  // Reassign… offers only the hobs the hub would accept, and a refusal says why in the lane.
  const ada = lane(page, "Ada");
  const menu = await laneMenu(page, "Ada");
  await menu.getByRole("menuitem", { name: "Reassign…" }).click();
  await expect(menu).toContainText("Reassign “Build the campaign” to");
  await expect(menu.getByRole("menuitem")).toHaveText(["Quill", "Back"]);
  await menu.getByRole("menuitem", { name: "Back" }).click();
  await menu.getByRole("menuitem", { name: "Reassign…" }).click();
  await menu.getByRole("menuitem", { name: "Quill" }).click();
  await expect(ada.getByRole("alert")).toHaveText("Ada is working on it right now. Reassign it once that turn ends.");
  await expect(build).toContainText("Needs you");

  // Cancel quest… in the lead's lane asks first, then shows Cancelling… until every Task confirms
  // it stopped.
  const leadLane = lane(page, "Aldric");
  await (await laneMenu(page, "Aldric")).getByRole("menuitem", { name: "Cancel quest…" }).click();
  await expect(leadLane).toContainText("Cancel this quest? Every hob on it stops.");
  await expect(leadLane.getByRole("button", { name: "Keep it" })).toBeFocused();
  await leadLane.getByRole("button", { name: "Keep it" }).click();
  await expect(leadLane).not.toContainText("Cancel this quest?");
  await (await laneMenu(page, "Aldric")).getByRole("menuitem", { name: "Cancel quest…" }).click();
  await leadLane.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(room.getByRole("status").filter({ hasText: "Cancelled: 2 tasks confirmed they stopped." })).toBeVisible({
    timeout: 15_000,
  });
  await expect(laneHead(page, "Aldric")).toContainText("Cancelled");
  await expect(build).toContainText("Cancelled");
  await expect(copy).toContainText("Done");
  await roomMenu(page, title);
  await expect(page.getByRole("menuitem", { name: "Cancel quest…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(ticket(page, title)).toContainText("Cancelled after");

  // Once it ended nothing is left to control, but its Workbench still opens.
  const ended = await laneMenu(page, "Ada");
  await expect(ended.getByRole("menuitem")).toHaveText(["Show in the Workbench"]);
  await ended.getByRole("menuitem", { name: "Show in the Workbench" }).click();
  await expect(dock(page).getByRole("heading", { name: "Build the campaign" })).toBeVisible();
});

// covers CH-005, OR-006, EX-001, UX-001
test("[TC-CH-192] a lane cancels a Task, retries a failed one and gives another to a new hob, each live", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a spring sale for the shop");
  await composer.press("Enter");
  const quest = "Plan the spring sale";
  const room = await openRoom(page, quest);
  const signs = laneTask(page, "Order the sale signs");
  const banner = laneTask(page, "Write the sale banner");
  await expect(signs).toContainText("Running", { timeout: 15_000 });
  await expect(banner).toContainText("Failed");
  await expect(lane(page, "Ada")).toContainText("Schedule the sale email");
  // The ticket counts each failed Task as something that needs you.
  await expect(ticket(page, quest)).toContainText("2 need you");

  // A failed Task turns its lane rose and says what stopped it, with Retry and Reassign… there.
  const quill = lane(page, "Quill");
  const bannerFailed = quill.getByRole("region", { name: "Quill's task failed" });
  await expect(bannerFailed).toContainText("Write the sale banner failed");
  await expect(bannerFailed).toContainText("The image service timed out.");
  await expect(bannerFailed.getByRole("button")).toHaveText(["Retry", "Reassign…"]);
  // Quill's lane names the signs, still running, so Reassign… on the banner opens his menu on the banner.
  await expect(laneHead(page, "Quill")).toContainText("Order the sale signs");
  await bannerFailed.getByRole("button", { name: "Reassign…" }).click();
  const quillMenu = page.getByRole("menu", { name: "Quill's task" });
  await expect(quillMenu).toContainText("Reassign “Write the sale banner” to");
  await page.keyboard.press("Escape");
  await expect(quillMenu).toBeHidden();

  // Cancel task… in Quill's menu asks about the signs, his one Task still open, then the Task
  // confirms it stopped; the lane follows.
  await cancelInLane(page, "Quill");
  await expect(quill.getByRole("status").filter({ hasText: "Cancelled: the task confirmed it stopped." })).toBeVisible({
    timeout: 15_000,
  });
  await expect(signs).toContainText("Cancelled");
  await expect((await laneMenu(page, "Quill")).getByRole("menuitem", { name: "Cancel task…" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Retry queues the failed Task again for a new Attempt of the same Task. One try needs no number.
  await expect(banner).not.toContainText("attempt 1");
  await bannerFailed.getByRole("button", { name: "Retry" }).click();
  await expect(banner).toContainText("attempt 2", { timeout: 15_000 });
  // The lane is no longer rose; the failed try stays in its history.
  await expect(bannerFailed).toBeHidden();
  await expect(banner.locator(":scope > span").first()).not.toContainText("Failed");

  // With two tries, the picker in Quill's lane shows the first, and the Workbench follows it.
  const tries = quill.getByRole("group", { name: "Quill's attempts" });
  await expect(tries.getByRole("button")).toHaveText(["1✗", "2"]);
  await expect(tries.getByRole("button", { name: "Attempt 2" })).toHaveAttribute("aria-pressed", "true");
  await tries.getByRole("button", { name: "Attempt 1, failed" }).click();
  await expect(tries.getByRole("button", { name: "Attempt 1, failed" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/attempt=/);
  // The lane shows what the first try did: its number and how it ended.
  await expect(banner).toContainText("attempt 1");
  await expect(banner).toContainText("The image service timed out.");
  await room.getByRole("tab", { name: /Changes/ }).click();
  const bench = dock(page);
  await expect(bench.getByRole("heading", { name: "Write the sale banner" })).toBeVisible();
  await expect(bench.getByRole("radio", { name: "Attempt 1" })).toBeChecked();
  // Picking the latest try again shows the Task as it stands.
  await tries.getByRole("button", { name: "Attempt 2" }).click();
  await expect(banner).toContainText("attempt 2");
  await expect(banner).not.toContainText("The image service timed out.");

  // Reassign… on Ada's failed Task opens her menu on the hobs it can go to: Quill is the only one.
  const emailFailed = lane(page, "Ada").getByRole("region", { name: "Ada's task failed" });
  await expect(emailFailed).toContainText("The mailing tool rejected the sign-in.");
  await emailFailed.getByRole("button", { name: "Reassign…" }).click();
  const adaMenu = page.getByRole("menu", { name: "Ada's task" });
  await expect(adaMenu.getByRole("menuitem")).toHaveText(["Quill", "Back"]);
  await adaMenu.getByRole("menuitem", { name: "Quill" }).click();
  await expect(adaMenu).toBeHidden();
  await expect(laneTask(page, "Schedule the sale email", "Quill")).toBeVisible();
});

// covers CH-005, OR-004
test("[TC-CH-191] a nested Quest's member gets a lane of its own, and the member that leads it names its party", async ({
  page,
}) => {
  const { url, aldric } = await questHub({ nested: true });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
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

// covers OR-004, UX-001, IN-002
test("[TC-UX-240] a question answered in the asking hob's lane goes back to it and clears from the chat, the room and the Inbox", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  const title = "Plan the Black Friday campaign";
  const room = await openRoom(page, title);

  // Ada's question shows lit in her lane, with who passed it up and where the answer goes.
  const ada = lane(page, "Ada");
  const asks = ada.getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("Should international orders get an earlier cutoff", { timeout: 15_000 });
  await expect(asks).toContainText("Passed up by Ada → Aldric → you");
  await expect(laneHead(page, "Ada")).toContainText("Needs you");
  await expect(room).toContainText("1 needs you");

  // Answering there answers it everywhere: the lane moves on and the chat's card keeps the answer.
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(asks).toBeHidden();
  await expect(laneHead(page, "Ada")).not.toContainText("Needs you");
  await expect(room).not.toContainText("1 needs you");
  const inChat = page.getByRole("main", { name: "Chat" }).getByRole("region", { name: "Ada asks you" });
  await expect(inChat).toContainText("You answered in the Quest room: Yes, Dec 12 for international orders.");
  await expect(laneHead(page, "Ada")).toContainText("Done", { timeout: 15_000 });
  await page.goto(`${url}/#/inbox?tab=needs`);
  await expect(page.getByRole("article", { name: "Question from Ada" })).toHaveCount(0);
});
