import { randomUUID } from "node:crypto";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with Aldric, whose fake turns script the Task tools, and one delivery per item. */
const aldricHub = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir, { HOBBOTS_BACKPACK_MAX_DELIVERIES: "1" });
  const { url, headers } = hub;
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const aldric = await api("POST", "/agents", {
    id: randomUUID(),
    name: "Aldric",
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 4000,
    lookColor: "amber",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  return { url, aldric: aldric.id };
};

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

// covers IN-007, OR-007, UX-004
test("[TC-IN-096] work whose turn is cut off shows as stuck on its Task card and in Needs you, and Retry starts it again", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // One step that returns at once; the turn its result starts is cut off, which uses its one delivery.
  const steps = [
    { brief: `Outline the launch\n${script("complete_task", { key: "outline", summary: "Three channels." })}` },
  ];
  await composer.fill(
    ["Plan the spring launch", "fake:then fake:cut-off", script("plan_steps", { key: "plan", steps })].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // The result could not be delivered: the card says so, with the next action.
  const card = page.getByRole("region", { name: "Aldric's work on Plan the spring launch" });
  const stuck = card.getByRole("region", { name: /^Aldric's work is stuck/ });
  await expect(stuck).toContainText('Reading the result of "Outline the launch"', { timeout: 20_000 });
  await expect(stuck).toContainText("It was tried 1 time, and the turn ended early. The last try was cut off.");
  await expect(stuck).toContainText("Next: retry it");
  await expect(stuck.getByRole("button", { name: "Reassign" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible();

  // Needs you lists it too, and Retry there starts the work again in the chat.
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  const needs = page.getByRole("region", { name: "Stuck work" });
  await expect(needs).toContainText("1 piece of work is stuck");
  await needs.getByRole("button", { name: "Retry" }).click();
  await expect(needs).toBeHidden();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Hobbots wrote this, not the user.").last()).toBeVisible({ timeout: 20_000 });
  await expect(card.getByRole("region", { name: /^Aldric's work is stuck/ })).toBeHidden();
});

// covers IN-007
test("[TC-IN-097] Dismiss takes stuck work off the card and out of Needs you", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  const steps = [
    { brief: `Outline the launch\n${script("complete_task", { key: "outline", summary: "Three channels." })}` },
  ];
  await composer.fill(
    ["Plan the spring launch", "fake:then fake:cut-off", script("plan_steps", { key: "plan", steps })].join("\n"),
  );
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  const card = page.getByRole("region", { name: "Aldric's work on Plan the spring launch" });
  const stuck = card.getByRole("region", { name: /^Aldric's work is stuck/ });
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });
  await stuck.getByRole("button", { name: "Dismiss" }).click();
  await expect(stuck).toBeHidden();
  await expect(page.getByRole("link", { name: "Inbox", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Inbox", exact: true }).click();
  await expect(page.getByText("Nothing needs you")).toBeVisible();
  await expect(page.getByRole("region", { name: "Stuck work" })).toBeHidden();
});

/** The read of the blockers, without the decision endpoint under it. */
const blockersList = /\/api\/blockers(\?.*)?$/;

// covers IN-007, UX-004
test("[TC-IN-098] Needs you never says nothing needs you while stuck work is still being read, or could not be read", async ({
  page,
}) => {
  const { url } = await aldricHub();
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failing = true;
  await page.route(blockersList, async (route) => {
    await held;
    if (failing) await route.fulfill({ status: 500, body: "" });
    else await route.continue();
  });
  await page.goto(`${url}/#/inbox`);

  const list = page.getByRole("complementary", { name: "Inbox" });
  // Approvals are read, stuck work is not yet: no all-clear.
  await expect(list.getByText("Reading stuck work…")).toBeVisible();
  await expect(list.getByText("Nothing needs you")).toHaveCount(0);

  // The read fails: it says so, with a way to read again, and still no all-clear.
  release();
  // The client asks again a few times before it gives up.
  const failed = list.getByRole("alert");
  await expect(failed).toContainText("could not read stuck work", { timeout: 20_000 });
  await expect(list.getByText("Nothing needs you")).toHaveCount(0);

  failing = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(list.getByText("Nothing needs you")).toBeVisible();
  await expect(list.getByRole("alert")).toHaveCount(0);
});
