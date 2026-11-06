import { readFileSync } from "node:fs";
import type { Locator, Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";
import { openRoom } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1034 in the browser: the composer while a hob replies. The hint stays on one line, Stop
// carries the long sentence as its description, Send says when it goes, and a message sent then
// waits above the box with "Waits its turn" until the reply ends. The shared window guard fails any
// of these tests where the window scrolls (#1026).

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  if (dataDir !== "") removeDataDir(dataDir);
  dataDir = "";
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

/** A hub past onboarding with Moss on the fake runtime, open on Moss's fresh page. */
const openMoss = async (page: Page) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const moss = await api<{ readonly id: string }>(hub, "POST", "/api/agents", {
    name: "Moss",
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: null,
    tool: null,
    lookSeed: 1234,
    lookColor: "violet",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  await page.goto(`${hub.url}/#/hobs/${moss.id}/new`);
  return { current: hub, mossId: moss.id };
};

// The fake hob echoes word by word, so a long prompt keeps its reply running for seconds.
const LONG = `Please ${Array.from({ length: 300 }, (_, i) => `word${i}`).join(" ")}`;
const KEYS = "Enter sends · Shift+Enter adds a line · ↑ brings back your last message";

const composerCard = (page: Page) => page.locator("[data-composer]");
const stopButton = (page: Page) => page.getByRole("button", { name: "■ Stop" });
const waiting = (page: Page) => page.getByRole("region", { name: "Queued message" });

/** The hint is one line: as tall as one line of meta text, and nothing in it is cut off. */
const expectOneLine = async (hint: Locator) => {
  const fits = await hint.evaluate((element) => {
    // Larger text zooms the whole page, so a box measures that much more than its line height.
    const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
    const line = Number.parseFloat(getComputedStyle(element).lineHeight) * zoom;
    const box = element.getBoundingClientRect();
    return { oneLine: box.height <= line + 1, whole: element.scrollWidth <= element.clientWidth + 1 };
  });
  expect(fits, (await hint.textContent()) ?? "").toEqual({ oneLine: true, whole: true });
};

// covers CH-007, CH-008
test("[TC-CH-290] while Moss replies the hint is one line, Stop describes itself, and Send says when it goes", async ({
  page,
  scan,
}) => {
  await openMoss(page);
  const composer = page.getByRole("textbox", { name: /^Message Moss/ });

  // Idle: the keys' hint and Send.
  await expect(composerCard(page)).toContainText(KEYS);
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();

  // The first message opens the thread; the rest of the test stays in it.
  await composer.fill("hello");
  await composer.press("Enter");
  await expect(page.getByText("Echo: hello", { exact: true })).toBeVisible({ timeout: 15_000 });

  // Replying with an empty box: the dot and who is replying, Stop beside Send, and Send dims.
  await composer.fill(LONG);
  await composer.press("Enter");
  await expect(stopButton(page)).toBeVisible();
  const hint = composerCard(page).getByText("Moss is replying", { exact: true });
  await expect(hint).toBeVisible();
  await expect(composerCard(page)).not.toContainText(KEYS);
  await expectOneLine(hint);
  await expect(stopButton(page)).toHaveAccessibleDescription(
    "Stop ends this reply only. What Moss wrote so far is kept. Messages you send now wait their turn.",
  );
  const sendAfter = page.getByRole("button", { name: "Send after this reply", exact: true });
  await expect(sendAfter).toBeDisabled();
  // Stop matches Send's height and sits left of it.
  const [stopBox, sendBox] = [await stopButton(page).boundingBox(), await sendAfter.boundingBox()];
  expect(Math.round(stopBox?.height ?? 0)).toBe(Math.round(sendBox?.height ?? -1));
  expect((stopBox?.x ?? 0) < (sendBox?.x ?? 0)).toBe(true);
  await expect(composer).toBeFocused();
  await scan();

  // With a draft: the hint says when it goes and Send lights up. Escape does not stop the reply.
  await composer.fill("Also check the hero image on phones");
  const sendsAfter = composerCard(page).getByText("Sends after this reply", { exact: true });
  await expect(sendsAfter).toBeVisible();
  await expectOneLine(sendsAfter);
  await expect(sendAfter).toBeEnabled();
  await scan(composerCard(page));
  await composer.press("Escape");
  await expect(stopButton(page)).toBeVisible();
  await expect(composer).toHaveValue("Also check the hero image on phones");

  // Sent while replying: the message waits above the box until the reply ends.
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  const row = waiting(page).filter({ hasText: "Also check the hero image on phones" });
  await expect(row).toContainText("Waits its turn");
  const [rowBox, cardBox] = [await row.boundingBox(), await composerCard(page).boundingBox()];
  expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual(cardBox?.y ?? 0);
  await expect(hint).toBeVisible();
  await scan();

  // Stopping: Stopping… until the hob confirms, and the hint says what is kept.
  await composer.fill("a draft that stays");
  await stopButton(page).click();
  await expect(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  const stopping = composerCard(page).getByText("Stopping. What Moss wrote so far is kept.", { exact: true });
  await expect(stopping).toBeVisible();
  await expectOneLine(stopping);
  await scan(composerCard(page));

  // The waiting message then joins the transcript as usual, and the draft is still there.
  await expect(page.getByText("Echo: Also check the hero image on phones", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(waiting(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();
  await expect(composer).toHaveValue("a draft that stays");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await expect(composerCard(page)).toContainText(KEYS);
});

// covers AG-006, CH-008
test("[TC-CH-291] a paused hob keeps Wake first and Queue in a thread, and a new thread keeps its draft", async ({
  page,
  scan,
}) => {
  const { current, mossId } = await openMoss(page);
  const composer = page.getByRole("textbox", { name: /^Message Moss/ });
  await composer.fill("first");
  await composer.press("Enter");
  await expect(page.getByText("Echo: first", { exact: true })).toBeVisible({ timeout: 15_000 });
  const threadUrl = page.url();

  // A new thread: a paused hob starts none, and the draft typed before stays.
  await page.goto(`${current.url}/#/hobs/${mossId}/new`);
  await composer.fill("Plan the autumn page");
  await api(current, "POST", `/api/agents/${mossId}/pause`);
  await expect(page.getByRole("button", { name: "Wake Moss" })).toBeVisible();
  await expect(composer).toBeDisabled();
  await expect(composer).toHaveValue("Plan the autumn page");
  await expect(composerCard(page)).toContainText("Paused hobs take no new work.");
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toHaveCount(0);
  await scan();

  // In the thread: Wake comes first, then Queue, which keeps the message until Moss wakes.
  await page.goto(threadUrl);
  await expect(composerCard(page)).toContainText("Moss is paused. Messages you queue wait until you wake Moss.");
  await composer.fill("Draft the FAQ next");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await expect(waiting(page).filter({ hasText: "Draft the FAQ next" })).toContainText("Waits until you wake Moss");
  const [wake, queue] = [
    await page.getByRole("button", { name: "Wake Moss" }).boundingBox(),
    await page.getByRole("button", { name: "Queue", exact: true }).boundingBox(),
  ];
  expect((wake?.x ?? 0) < (queue?.x ?? 0)).toBe(true);
  expect(Math.round(wake?.height ?? 0)).toBe(34);
  await scan();
});

const themeIds: readonly string[] = (
  JSON.parse(readFileSync(new URL("../../../docs/design/themes.json", import.meta.url), "utf8")) as {
    readonly themes: readonly { readonly id: string }[];
  }
).themes.map((theme) => theme.id);

test.describe("beside the Quest room", () => {
  test.afterEach(stopAldricHub);

  // covers CH-007, UX-002
  test("[TC-CH-292] beside the Quest room the busy hint keeps only the dot and Replying, on one line in every theme and at larger text", async ({
    page,
    scan,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1024, height: 800 });
    const { url, aldric } = await aldricHub();
    await page.goto(`${url}/#/hobs/${aldric}/new`);
    const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
    await composer.fill(
      ["Plan the launch", script("start_quest", { key: "quest", goal: "Plan the launch" })].join("\n"),
    );
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await composer.press("Enter");
    await expect(stopButton(page)).toBeHidden({ timeout: 30_000 });
    await openRoom(page, "Plan the launch");
    const chat = page.getByRole("main", { name: "Chat" });
    expect((await chat.boundingBox())?.width ?? 0).toBeLessThan(480);

    // This reply runs for over a minute, longer than the looks below take.
    await composer.fill(`Please ${Array.from({ length: 2000 }, (_, i) => `word${i}`).join(" ")}`);
    await composer.press("Enter");
    await expect(stopButton(page)).toBeVisible();
    const card = composerCard(page);
    for (const textSize of ["standard", "larger"]) {
      for (const theme of themeIds) {
        const at = `${theme}, ${textSize} text`;
        // Each look is set in place, as the app sets it, so every one is checked on the same screen
        // as the reply runs, with the window guard watching throughout.
        await page.evaluate(
          ({ id, size }) => {
            const root = document.documentElement;
            root.setAttribute("data-theme", id);
            if (size === "larger") root.setAttribute("data-text-size", size);
            else root.removeAttribute("data-text-size");
          },
          { id: theme, size: textSize },
        );
        await expect(page.locator("html"), at).toHaveAttribute("data-theme", theme);
        const short = card.getByText("Replying", { exact: true });
        await expect(short, at).toBeVisible();
        await expect(card.getByText("Aldric is replying", { exact: true }), at).toBeHidden();
        await expectOneLine(short);
        // The keys' hint stays hidden here, and Stop and Send keep their place in the row.
        await expect(card, at).not.toContainText(KEYS);
        await expect(stopButton(page), at).toBeVisible();
        await expect(page.getByRole("button", { name: "Send after this reply" }), at).toBeVisible();
        const [hintBox, stopBox] = [await short.boundingBox(), await stopButton(page).boundingBox()];
        expect((hintBox?.x ?? 0) + (hintBox?.width ?? 0), at).toBeLessThanOrEqual(stopBox?.x ?? 0);
        await scan(chat);
      }
    }
  });
});
