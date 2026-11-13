import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { openQuest } from "./quest-sheet.ts";

// Issue #1445 in the browser: the quest's sheet shows its acceptance criteria under "Done when",
// as the hub records them. Aldric accepts the date on the page Pip returned and waives the optional
// photo; Quill's polish returns the page again, whose version 2 voids that evidence; Aldric's waiver
// of the required date asks you, and only your "Waive it" on its card waives it, as yours. The
// hub's side is packages/persistence/test/quest-criteria.test.ts and apps/server/test/quest-criteria.test.ts.

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
  writeFileSync(join(shared, "index.html"), "<h1>Launch on Friday 6 December</h1>\n");
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
});

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const hobNamed = (current: Hub, name: string, lookSeed: number) =>
  api<{ readonly id: string }>(current, "POST", "/api/agents", {
    name,
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });

/** A prompt line that makes the fake call a Task tool. */
const script = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/** Lines the fake runs on the lead's `turn`th turn after the first: one `fake:then` a turn. */
const on = (turn: number, line: string) => `${"fake:then ".repeat(turn)}${line}`;

/** A member's brief that returns the page, by its path inside the shared folder, under `key`. */
const returnsPage = (brief: string, key: string) =>
  [
    brief,
    script("complete_task", {
      key,
      delivered: true,
      summary: "The page is written",
      artifacts: [{ kind: "file", label: "Launch page", value: "index.html" }],
    }),
  ].join("\n");

const DATE = "$quest.criteria.0.criterion_id";
const PHOTO = "$quest.criteria.1.criterion_id";
const TITLE = "Write the launch page";

/** The criterion with this text under "Done when" in the open quest. */
const criterion = (page: Page, text: string) =>
  page.getByRole("dialog").getByRole("region", { name: "Done when" }).getByRole("listitem").filter({ hasText: text });

// covers OR-004, OR-006, UX-001, UX-002
test("[TC-UX-1445-07] the quest's sheet shows each criterion accepted on a version, voided by a newer one, and waived only by your answer", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const aldric = await hobNamed(current, "Aldric", 4000);
  await hobNamed(current, "Pip", 4821);
  await hobNamed(current, "Quill", 5732);

  await page.goto(`${current.url}/#/hobs/${aldric.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      TITLE,
      script("start_quest", {
        key: "quest",
        goal: TITLE,
        acceptance: ["The page names the launch date", { text: "The page has a photo", optional: true }],
      }),
      script("delegate_task", { key: "page", hob: "Pip", brief: returnsPage(TITLE, "pip-done") }),
      script("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
      // Pip's result: Aldric accepts the date on it, waives the photo and asks before polishing.
      on(
        1,
        script("check_criterion", {
          key: "accept",
          criterion_id: DATE,
          verdict: "accepted",
          reason: "It says Friday 6 December",
          evidence: ["$pip-done.artifacts.0"],
        }),
      ),
      on(
        1,
        script("check_criterion", {
          key: "photo",
          criterion_id: PHOTO,
          verdict: "waived",
          reason: "No photo this time",
        }),
      ),
      on(
        1,
        script("ask", {
          key: "polish?",
          question: "Shall Quill polish the page?",
          options: [
            { label: "Polish it", consequence: "Quill reworks the page." },
            { label: "Leave it", consequence: "The page stays as it is." },
          ],
        }),
      ),
      // Your answer: Quill polishes the page, which returns it again.
      on(
        2,
        script("delegate_task", { key: "polish", hob: "Quill", brief: returnsPage("Polish the page", "quill-done") }),
      ),
      on(2, script("wait_for", { key: "wait-polish", tasks: ["$polish.task_id"] })),
      // Quill's result: Aldric would waive the date, which asks you.
      on(
        3,
        script("check_criterion", {
          key: "waive",
          criterion_id: DATE,
          verdict: "waived",
          reason: "The date is not set yet",
        }),
      ),
      // Your "Waive it": the Quest completes.
      on(4, script("complete_task", { key: "whole", delivered: true, summary: "The page is written, without a date" })),
    ].join("\n"),
  );
  await composer.press("Enter");

  // Aldric asks before polishing: the date is accepted on Pip's page, version 1, and the optional
  // photo waived by Aldric.
  const asks = page.getByRole("region", { name: "Aldric asks you" }).last();
  await expect(asks).toContainText("Shall Quill polish the page?", { timeout: 30_000 });
  const sheet = await openQuest(page, TITLE);
  const date = criterion(page, "The page names the launch date");
  const photo = criterion(page, "The page has a photo");
  await expect(date).toContainText("Accepted");
  await expect(date).toContainText("Launch page, version 1");
  await expect(date).toContainText("Aldric: It says Friday 6 December");
  await expect(photo).toContainText("optional");
  await expect(photo).toContainText("Waived");
  await expect(photo).toContainText("Aldric: No photo this time");
  await expectAccessible(page, sheet);
  await page.keyboard.press("Escape");
  await asks.getByRole("button", { name: /^Polish it/ }).click();

  // Quill's page is version 2: it voided the evidence, and Aldric's waiver asks you instead.
  const waiver = page.getByRole("region", { name: "Aldric asks you" }).last();
  await expect(waiver).toContainText('Waive "The page names the launch date"? The date is not set yet', {
    timeout: 30_000,
  });
  await openQuest(page, TITLE);
  await expect(date).toContainText("Not checked");
  await expect(date).toContainText("Launch page, version 1 · a newer version replaced it");
  await expect(date).toContainText("Hobbots: Version 2 of Launch page replaced the version it was accepted on");
  await expect(date).toContainText("Waiting on your answer to waive it");
  await expectAccessible(page, sheet);
  await page.keyboard.press("Escape");

  // Only your "Waive it" waives it, and it is yours.
  await waiver.getByRole("button", { name: /^Waive it/ }).click();
  await openQuest(page, TITLE);
  await expect(date).toContainText("Waived", { timeout: 30_000 });
  await expect(date).toContainText("You: The date is not set yet");
  await expect(date).not.toContainText("Waiting on your answer");
  await expect(sheet).toContainText("Quest finished", { timeout: 30_000 });
});
