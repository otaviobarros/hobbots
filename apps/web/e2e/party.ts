import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// A party of hobs under Aldric on the scripted fake runtime, past setup with a folder they may work
// in, for the browser tests of what you send while their work runs (#909, #1446).

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

/** Starts each test of the file with an empty hub's data and a shared folder, and removes both after it. */
export const registerPartyHooks = () => {
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
};

export const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const summon = (current: Hub, name: string, lookSeed: number) =>
  api<{ readonly id: string }>(current, "POST", "/api/agents", {
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

/** A prompt line that makes the fake call a Hobbots tool. */
export const hubCall = (tool: string, input: object) => `fake:hub ${tool} ${JSON.stringify(input)}`;

/**
 * A delegation whose member reports a blocker and stops, so its Task waits for word from its lead
 * and a note wakes its next turn: its milestone is never reached, so its turn's end does not
 * complete it.
 */
export const stuck = (key: string, hob: string, brief: string) =>
  hubCall("delegate_task", {
    key,
    hob,
    milestones: ["Settled"],
    brief: [
      brief,
      hubCall("report_checkpoint", { key: `${key}-stuck`, kind: "blocker", summary: "The design is not settled" }),
    ].join("\n"),
  });

export interface Tasks {
  readonly trees: ReadonlyArray<{
    readonly tasks: ReadonlyArray<{ readonly id: string; readonly ownerId: string; readonly state: string }>;
  }>;
}

/** Aldric's party, past setup with a folder they may work in. */
export const party = async (names: ReadonlyArray<string>) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
  });
  const ids: Record<string, string> = {};
  for (const [index, name] of ["Aldric", ...names].entries())
    ids[name] = (await summon(current, name, 4000 + index * 911)).id;
  return { current, ids };
};

/**
 * Sends a message to Aldric once his running turn, if any, has ended, and waits until his turn on
 * it ends. A member's blocker starts a turn of his that echoes its briefing word by word, so it can
 * run for a while.
 */
export const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const stop = page.getByRole("button", { name: /Stop/ });
  await expect(stop).toBeHidden({ timeout: 90_000 });
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled({ timeout: 30_000 });
  await composer.press("Enter");
  await expect(stop).toBeHidden({ timeout: 90_000 });
};

/** Starts Aldric's request and waits until each named member's Task is in `state`, giving back their Task ids. */
export const startWork = async (
  page: Page,
  current: Hub,
  ids: Record<string, string>,
  request: ReadonlyArray<string>,
  members: ReadonlyArray<string>,
  state: string,
) => {
  await page.goto(`${current.url}/#/hobs/${ids.Aldric}/chat`);
  await send(page, request);
  await expect(page).toHaveURL(/\/threads\//);
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
  const taskIds: Record<string, string> = {};
  await expect
    .poll(
      async () => {
        const { trees } = await api<Tasks>(current, "GET", `/api/threads/${thread}/tasks`);
        const tasks = trees.flatMap((tree) => tree.tasks);
        for (const name of members) {
          const task = tasks.find((each) => each.ownerId === ids[name] && each.state === state);
          if (task !== undefined) taskIds[name] = task.id;
        }
        return members.every((name) => taskIds[name] !== undefined);
      },
      { timeout: 45_000 },
    )
    .toBe(true);
  return { thread, taskIds };
};
