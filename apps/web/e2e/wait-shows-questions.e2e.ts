import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { laneHead, openRoom, taskDetails } from "./quest-room.ts";

// Issue #573 in the browser: a lead that waits on a member's Task reads the member's question in
// what wait_for answers, and the question reaches the lead as soon as its turn ends instead of
// being held. The hub's side is tested in apps/server/test/wait-shows-questions.test.ts.

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

// covers OR-002, OR-003, IN-002, IN-004
test("[TC-OR-245] a question from a Task the lead waits for reaches the lead and is answered, never held in its backpack", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await request(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const frodo = await summon(current, "Frodo", 4100);
  await summon(current, "Quill", 4821);

  // Frodo brings in Quill, who asks him something, and waits for her. His next turn waits again,
  // reads her question in what the wait answers, and answers it.
  await page.goto(`${current.url}/#/hobs/${frodo.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Frodo/ });
  await composer.fill(
    [
      "Ship the release",
      hubCall("delegate_task", {
        key: "copy",
        hob: "Quill",
        brief: [
          "Draft the release notes",
          hubCall("ask", { key: "tone", question: "Playful or formal?" }),
          `fake:then ${hubCall("complete_task", { key: "copy-done", summary: "Playful notes drafted" })}`,
        ].join("\n"),
      }),
      hubCall("wait_for", { key: "wait", tasks: ["$copy.task_id"] }),
      `fake:then ${hubCall("wait_for", { key: "wait-again", tasks: ["$copy.task_id"] })}`,
      `fake:then ${hubCall("answer", { key: "reply", question_id: "$tone.question_id", answer: "Playful" })}`,
      `fake:then fake:then ${hubCall("complete_task", { key: "wrap", summary: "Release shipped" })}`,
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();

  // The wait in his next turn told him the question waits for him.
  await expect(page.getByText("A question from them waits for you").first()).toBeVisible({ timeout: 20_000 });

  // On Frodo's Task, Quill's question was carried into his turn and handled there, not held.
  await openRoom(page, "Ship the release");
  await taskDetails(page, "Ship the release");
  const room = page.getByRole("region", { name: "Backpack for Ship the release" });
  const question = room.getByRole("button", { name: /Quill asks: Playful or formal\?/ });
  await expect(question).toContainText("Consumed", { timeout: 20_000 });
  await expect(question).not.toContainText("Waiting");
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 20_000 });
});
