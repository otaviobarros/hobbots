import { randomUUID } from "node:crypto";

import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with Aldric, whose fake turns script the Task tools. */
const aldricHub = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
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

// covers OR-001, OR-005, CH-005
test("[TC-OR-034] a Task split into four steps shows step 2 of 4 in the chat and finishes with one result", async ({
  page,
}) => {
  const { url, aldric } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  // Steps 1, 3 and 4 return their own result at once. Step 2 writes a long reply, which the fake
  // streams word by word, so it runs long enough to be seen; its reply becomes its result.
  const step = (brief: string, result: string, after: ReadonlyArray<number>) => ({
    brief: `${brief}\n${script("complete_task", { key: brief, summary: result })}`,
    ...(after.length === 0 ? {} : { after }),
  });
  const steps = [
    step("Outline the launch", "Outline: three channels.", []),
    { brief: `Write the copy for every channel. ${"Keep each paragraph short and friendly. ".repeat(30)}`, after: [1] },
    step("Pick the images", "Four images picked.", [2]),
    step("Proofread everything", "No typos left.", [3]),
  ];
  await composer.fill(`Plan the spring launch\n${script("plan_steps", { key: "plan", steps })}`);
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();

  // The card under the request follows the current step while each runs in its own session.
  const card = page.getByRole("region", { name: "Aldric's work on Plan the spring launch" });
  await expect(card).toContainText("step 2 of 4", { timeout: 20_000 });
  await expect(card).toContainText("4 of 4 done", { timeout: 30_000 });

  // Once every step is done, Aldric hears their results, not their sessions, and returns one result.
  await composer.fill(script("complete_task", { key: "done", summary: "The spring launch is planned." }));
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(card).toContainText("Aldric finished this", { timeout: 30_000 });
  // The Task completes as the call is made; the reply that tells of it streams after.
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  const reply = page.getByRole("main");
  await expect(reply).toContainText("Result: Outline: three channels.");
  await expect(reply).toContainText("Result: Four images picked.");
  await expect(reply).toContainText("Result: No typos left.");
});
