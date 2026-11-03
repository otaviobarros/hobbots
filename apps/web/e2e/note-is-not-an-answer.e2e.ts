import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Issue #569 in the browser: your note on a Task whose question waits for you is not an answer.
// The question still waits in the Inbox, once, and the lead's turn is told so. Issue #659: once you
// answer it, the lead that passed it up is told so in its next turn. The hub's side is tested in
// apps/server/test/lead-reports-honestly.test.ts.

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
});

const request = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const summon = (current: Hub, name: string, lookSeed: number) =>
  request<{ readonly id: string }>(current, "POST", "/api/agents", {
    name,
    role: "assistant",
    roleTitle: "Assistant",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed,
    lookColor: "sky",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });

/** A prompt line that makes the fake call a Task tool. */
const hubCall = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** Rook asks Frodo, Frodo passes it up to you, and the question waits in your Inbox. */
const escalatedToYou = async (page: Page) => {
  const current = await startHub(dataDir);
  hub = current;
  await request(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const frodo = await summon(current, "Frodo", 4100);
  await summon(current, "Rook", 4821);

  // Rook asks Frodo, and Frodo passes the question up to you in the turn it starts.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Build the frontend",
      hubCall("delegate_task", {
        key: "frontend",
        hob: "Rook",
        brief: ["Build the frontend", hubCall("ask", { key: "theme", question: "Light or dark theme?" })].join("\n"),
      }),
      hubCall("wait_for", { key: "wait", tasks: ["$frontend.task_id"] }),
      `fake:then ${hubCall("escalate", { key: "up", question_id: "$theme.question_id" })}`,
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toBeVisible({ timeout: 20_000 });
  const waiting = await request<{
    readonly questions: ReadonlyArray<{
      readonly question: { readonly id: string };
      readonly task: { readonly id: string };
    }>;
  }>(current, "GET", "/api/questions");
  const first = waiting.questions[0];
  if (first === undefined) throw new Error("no question for you");
  return { current, rook: first.task.id, questionId: first.question.id };
};

// covers OR-002, IN-004, UX-002
test("[TC-OR-254] after your note on a Task whose question waits for you, the question still waits in the Inbox, once", async ({
  page,
}) => {
  // The lead's briefing is echoed word by word, so the line about the note arrives late in its turn.
  test.setTimeout(120_000);
  const { current, rook } = await escalatedToYou(page);

  // You leave a note on Rook's Task instead of answering.
  await request(current, "POST", `/api/tasks/${rook}/notes`, { key: "dark-note", text: "dark" });

  // Frodo's turn about the note is told the question still waits for you.
  await expect(page.getByText("The user left a note").first()).toBeVisible({ timeout: 45_000 });
  await expect(page.getByText("Questions only the user can answer, waiting in the user's Inbox:").last()).toBeVisible();

  // The Inbox still has the question, once, never answered by the note.
  await page.getByRole("link", { name: "Inbox, 1 waiting on you" }).click();
  await expect(page.getByRole("tablist", { name: "Inbox filters" })).toContainText("Needs you1");
  await expect(page.getByText("Light or dark theme?")).toHaveCount(1);
});

// covers OR-002, IN-004
test("[TC-OR-471] after you answer a question the lead passed up, the lead's next turn is told it is answered", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { current, questionId } = await escalatedToYou(page);

  await request(current, "POST", `/api/questions/${questionId}/answer`, { answer: "Dark" });
  await expect(page.getByRole("link", { name: "Inbox, 1 waiting on you" })).toHaveCount(0);

  // Frodo's next turn lists the answer, so Frodo never tells you it is still waiting.
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill("Did the theme get answered?");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 45_000 });
  await composer.press("Enter");
  await expect(page.getByText("Questions you passed up that are answered, latest last").last()).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByText('"Light or dark theme?" Answered by the user: "Dark"').last()).toBeVisible();
});
