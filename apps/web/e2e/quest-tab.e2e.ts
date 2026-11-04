import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";

test.afterEach(stopQuestHub);

// covers CH-005, OR-006, UX-001
test("[TC-CH-190] the Quest tab shows the whole tree live with its controls and keeps a pinned Quest in every thread", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // The tab is the control room: every Task, its owner, where it stands and who it waits on.
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Plan the Black Friday campaign" });
  await expect(room).toContainText("Aldric's quest");
  const tasks = room.getByRole("list", { name: "Tasks of Plan the Black Friday campaign" });
  await expect(tasks.getByRole("button", { name: /Quill · Draft the landing copy/ })).toBeVisible();
  const build = tasks.getByRole("button", { name: /Ada · Build the campaign/ });
  await expect(build).toContainText("waiting on Quill");
  await expect(build).toContainText("you", { timeout: 15_000 });

  // A row opens its Task in the drawer and the tab shows the controls that apply to it.
  await build.click();
  await expect(page.getByRole("dialog", { name: "Build the campaign, Task details" })).toBeVisible();
  await expect(build).toHaveAttribute("aria-current", "true");
  const controls = room.getByRole("region", { name: "Controls for Build the campaign" });
  await expect(controls.getByRole("button", { name: "Reassign" })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "Cancel Task" })).toBeEnabled();
  await expect(controls.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await expect(room.getByRole("button", { name: "Cancel Quest" })).toBeEnabled();
  await expect(room).not.toContainText("arrive once the hub can confirm");

  // Pinned, the Quest stays in the tab of another thread, and its Tasks still open there.
  const pin = room.getByRole("button", { name: "Pin" });
  await expect(pin).toHaveAttribute("aria-pressed", "false");
  await pin.click();
  await expect(pin).toHaveAttribute("aria-pressed", "true");
  await expect(pin).toHaveText("Pinned");
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  await page.getByRole("textbox", { name: /^Message Aldric/ }).fill("Something else");
  await page.getByRole("textbox", { name: /^Message Aldric/ }).press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(room).toContainText("Pinned from another thread");
  await room.getByRole("button", { name: /Quill · Draft the landing copy/ }).click();
  await expect(page.getByRole("dialog", { name: "Draft the landing copy, Task details" })).toBeVisible();

  // The answer goes back from the card in the Quest's own thread, and the tab follows live.
  await room.getByRole("link", { name: "Open its thread" }).click();
  const asks = page.getByRole("region", { name: "Ada asks you" });
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(tasks.getByRole("button", { name: /Ada · Build the campaign/ })).toContainText("Done", {
    timeout: 15_000,
  });
  // The Quest ends only once Aldric's chat has read each member's result, a paced fake reply apiece.
  await expect(room.getByRole("button", { name: "Cancel Quest" })).toHaveCount(0, { timeout: 30_000 });

  // Unpinned, it leaves the other thread's tab.
  await room.getByRole("button", { name: "Pin" }).click();
  await page.goBack();
  await expect(page.getByText("No Quest in this thread")).toBeVisible();

  // A pin the hub no longer has says so and can be unpinned.
  await page.evaluate(() => localStorage.setItem("quest.pinned", JSON.stringify(["gone"])));
  await page.reload();
  await expect(page.getByText("A pinned Quest is no longer on this hub.")).toBeVisible();
  await page.getByRole("button", { name: "Unpin" }).click();
  await expect(page.getByText("A pinned Quest is no longer on this hub.")).toBeHidden();
});

// covers CH-005, OR-006, UX-001
test("[TC-CH-193] the Quest tab says why a Reassign is refused, and cancels the Black Friday Quest until every Task confirms", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Plan the Black Friday campaign" });
  const tasks = room.getByRole("list", { name: "Tasks of Plan the Black Friday campaign" });
  const copy = tasks.getByRole("button", { name: /Quill · Draft the landing copy/ });
  const build = tasks.getByRole("button", { name: /Ada · Build the campaign/ });
  // Quill's copy is done and Ada waits on your answer: two Tasks run when the Quest is cancelled.
  await expect(copy).toContainText("Done", { timeout: 15_000 });
  await expect(build).toContainText("Needs you", { timeout: 15_000 });

  // Reassign offers only the hobs the hub would accept, and a refusal says why in the tab.
  await build.click();
  const controls = room.getByRole("region", { name: "Controls for Build the campaign" });
  await controls.getByRole("button", { name: "Reassign" }).click();
  const picker = controls.getByRole("group", { name: "Give Build the campaign to" });
  await expect(picker.getByRole("button", { name: "Aldric" })).toHaveCount(0);
  await picker.getByRole("button", { name: "Quill" }).click();
  await expect(controls.getByRole("alert")).toHaveText(
    "Ada is working on it right now. Reassign it once that turn ends.",
  );
  await expect(build).toContainText("Needs you");
  await picker.getByRole("button", { name: "Keep it" }).click();
  await expect(picker).toBeHidden();

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
  await expect(tasks.getByRole("button", { name: /Aldric · Plan the Black Friday campaign/ })).toContainText(
    "Cancelled",
  );
  await expect(build).toContainText("Cancelled");
  await expect(copy).toContainText("Done");
  await expect(room.getByRole("button", { name: /Cancel Quest|Cancelling…/ })).toHaveCount(0);
  // Once it ended nothing is left to control, but its Workbench still opens.
  await expect(controls.getByRole("button")).toHaveText(["Open in Workbench"]);

  // The card in the chat and the open drawer follow.
  await expect(page.getByText("Aldric stopped this")).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Build the campaign, Task details" })).toContainText("Cancelled");
});

// covers CH-005, OR-006, EX-001, UX-001
test("[TC-CH-192] the Quest tab cancels a Task, retries a failed one and gives another to a new hob, each live", async ({
  page,
}) => {
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a spring sale for the shop");
  await composer.press("Enter");
  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Plan the spring sale" });
  const tasks = room.getByRole("list", { name: "Tasks of Plan the spring sale" });
  const signs = tasks.getByRole("button", { name: /Quill · Order the sale signs/ });
  const banner = tasks.getByRole("button", { name: /Quill · Write the sale banner/ });
  const email = tasks.getByRole("button", { name: /· Schedule the sale email/ });
  await expect(signs).toContainText("Running", { timeout: 15_000 });
  await expect(banner).toContainText("Failed");
  await expect(email).toContainText("Ada");
  await expect(page.getByText("Aldric's party: Quill and Ada")).toBeVisible();

  // Cancel Task asks first, then the Task confirms it stopped; the drawer follows.
  await signs.click();
  const signsControls = room.getByRole("region", { name: "Controls for Order the sale signs" });
  await expect(signsControls.getByRole("button", { name: "Retry" })).toHaveCount(0);
  await signsControls.getByRole("button", { name: "Cancel Task" }).click();
  await expect(signsControls).toContainText("Cancel Order the sale signs and everything under it?");
  await signsControls.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(signsControls.getByRole("status")).toHaveText("Cancelled: the Task confirmed it stopped.", {
    timeout: 15_000,
  });
  await expect(signs).toContainText("Cancelled");
  await expect(page.getByRole("dialog", { name: "Order the sale signs, Task details" })).toContainText("Cancelled");
  await expect(signsControls.getByRole("button", { name: "Cancel Task" })).toHaveCount(0);

  // Retry queues the failed Task again for a new Attempt of the same Task.
  await banner.click();
  const bannerControls = room.getByRole("region", { name: "Controls for Write the sale banner" });
  await expect(bannerControls).toContainText("Attempt 1");
  await bannerControls.getByRole("button", { name: "Retry" }).click();
  await expect(bannerControls).toContainText(/Queued: waiting for Quill to start Attempt 2\.|Attempt 2/);
  await expect(bannerControls).toContainText("Attempt 2", { timeout: 15_000 });
  await expect(banner).not.toContainText("Failed");

  // Reassign gives Ada's failed Task to Quill, the only hob it can go to, and the party follows.
  await email.click();
  const emailControls = room.getByRole("region", { name: "Controls for Schedule the sale email" });
  await emailControls.getByRole("button", { name: "Reassign" }).click();
  const picker = emailControls.getByRole("group", { name: "Give Schedule the sale email to" });
  await expect(picker.getByRole("button")).toHaveText(["Quill", "Keep it"]);
  await picker.getByRole("button", { name: "Quill" }).click();
  await expect(picker).toBeHidden();
  await expect(tasks.getByRole("button", { name: /Quill · Schedule the sale email/ })).toBeVisible();
  await expect(emailControls.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Aldric's party: Quill", { exact: true })).toBeVisible();
});

// covers CH-005, OR-004
test("[TC-CH-191] a nested Quest shows under its member in the Quest tab, and the member names the party it leads", async ({
  page,
}) => {
  const { url, aldric } = await questHub({ nested: true });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill("Plan a Black Friday campaign for the shop");
  await composer.press("Enter");

  await page.getByRole("tab", { name: "Quest" }).click();
  const room = page.getByRole("region", { name: "Control room for Plan the Black Friday campaign" });
  const tasks = room.getByRole("list", { name: "Tasks of Plan the Black Friday campaign" });
  const rook = tasks.getByRole("button", { name: /Rook · Run the ads/ });
  const pip = tasks.getByRole("button", { name: /Pip · Research the keywords/ });
  await expect(rook).toContainText("Leads Pip");
  await expect(pip).toBeVisible();
  // Pip sits under Rook, one level further in than Rook sits under Aldric.
  const left = async (row: typeof rook) =>
    (await row.evaluate((each) => getComputedStyle(each).paddingInlineStart)) ?? "";
  const top = tasks.getByRole("button", { name: /Aldric · Plan the Black Friday campaign/ });
  const [aldricPad, rookPad, pipPad] = await Promise.all([left(top), left(rook), left(pip)]);
  expect(Number.parseFloat(rookPad)).toBeGreaterThan(Number.parseFloat(aldricPad));
  expect(Number.parseFloat(pipPad)).toBeGreaterThan(Number.parseFloat(rookPad));
  await expect(pip).toContainText("Done", { timeout: 30_000 });
  await expect(rook).toContainText("Done", { timeout: 30_000 });
});
