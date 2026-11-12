import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { expect, test } from "./hub.ts";
import { questHub, stopQuestHub } from "./quest-hub.ts";
import { dock, lane, laneHead, laneTask, openRoom, questRoom, ticket } from "./quest-room.ts";
import { hobTerminal, rows } from "./terminal.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #911: the Quest room's end-to-end proof (ADR 027), in the browser with the fake runtime.
// A Black Friday Quest is followed and steered from the room alone: a question answered in a lane,
// a failed Task retried and another reassigned, a note steered from the chat with its receipt, the
// docked Workbench filtered by lane and by try, and the Terminal split by hob. The room then holds
// up in all four themes at 1280, 1024 and 960 px. Each case uses the play that has its records:
// the hub's scripted Black Friday and spring sale plays, or a party the fake runtime plays turn by
// turn through the hub's Task tools.

// Each case starts one of the two hubs, and stops only that one.
let stop: (() => Promise<void>) | undefined;
test.afterEach(async () => {
  await stop?.();
  stop = undefined;
});

const TITLE = "Plan the Black Friday campaign";

/** The chat beside the room. */
const chat = (page: Page) => page.getByRole("main", { name: "Chat" });

/** Sends Aldric a message from his chat and waits until his turn on it is underway or has ended. */
const ask = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 30_000 });
  await composer.press("Enter");
};

/** Waits until Aldric's turn, if one runs, has ended. */
const idle = (page: Page) => expect(page.getByRole("button", { name: /Stop/ })).toBeHidden({ timeout: 90_000 });

// covers OR-001, OR-004, UX-001, UX-002, IN-002
test("[TC-UX-290] the nested Black Friday Quest is followed from the room alone, with Ada's question answered in her lane, until Aldric reports it done", async ({
  page,
  scan,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  stop = stopQuestHub;
  const { url, aldric } = await questHub({ nested: true });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await ask(page, ["Plan a Black Friday campaign for the shop"]);
  const room = await openRoom(page, TITLE);

  // A lane per hob, live: Rook leads a Quest of his own with Pip, under Aldric's.
  for (const name of ["Aldric", "Quill", "Ada", "Rook", "Pip"]) await expect(lane(page, name)).toBeVisible();
  await expect(laneHead(page, "Quill")).toContainText("Draft the landing copy");
  await expect(laneHead(page, "Rook")).toContainText("Leads Pip");
  await expect(laneHead(page, "Pip")).toContainText("Done", { timeout: 30_000 });
  await expect(laneHead(page, "Rook")).toContainText("Done", { timeout: 30_000 });
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 30_000 });

  // Ada's question climbs to you and lights her lane; it is answered there, not in the chat.
  const asks = lane(page, "Ada").getByRole("region", { name: "Ada asks you" });
  await expect(asks).toContainText("Should international orders get an earlier cutoff", { timeout: 30_000 });
  await expect(asks).toContainText("Passed up by Ada → Aldric → you");
  await expect(room).toContainText("1 needs you");
  await scan();
  await asks.getByRole("textbox", { name: "Your answer to Ada" }).fill("Yes, Dec 12 for international orders.");
  await asks.getByRole("button", { name: "Send answer" }).click();
  await expect(asks).toBeHidden();
  await expect(room).not.toContainText("1 needs you");

  // Ada finishes with the cutoff you chose, the Quest ends, and Aldric says so in the chat column.
  await expect(laneHead(page, "Ada")).toContainText("Done", { timeout: 30_000 });
  await expect(ticket(page, TITLE)).toContainText("Finished in", { timeout: 30_000 });
  await expect(chat(page)).toContainText("The Black Friday campaign is ready.", { timeout: 30_000 });
  await scan();
  await expect(room).toBeVisible();
});

// covers OR-006, EX-001, UX-001
test("[TC-UX-291] from the room, one failed Task is retried and the other is given to another hob, and nothing is left waiting on you", async ({
  page,
  scan,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  stop = stopQuestHub;
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await ask(page, ["Plan a spring sale for the shop"]);
  const quest = "Plan the spring sale";
  await openRoom(page, quest);
  await expect(ticket(page, quest)).toContainText("2 need you", { timeout: 15_000 });

  // Quill's banner failed: Retry starts a second try of the same Task, and the lane is no longer rose.
  const banner = laneTask(page, "Write the sale banner");
  const bannerFailed = lane(page, "Quill").getByRole("region", { name: "Quill's task failed" });
  await expect(bannerFailed).toContainText("The image service timed out.");
  await bannerFailed.getByRole("button", { name: "Retry" }).click();
  await expect(banner).toContainText("attempt 2", { timeout: 15_000 });
  await expect(bannerFailed).toBeHidden();
  await expect(banner.locator(":scope > span").first()).not.toContainText("Failed");

  // Ada's email failed: Reassign… gives it to Quill, whose lane takes it.
  const emailFailed = lane(page, "Ada").getByRole("region", { name: "Ada's task failed" });
  await expect(emailFailed).toContainText("The mailing tool rejected the sign-in.");
  await emailFailed.getByRole("button", { name: "Reassign…" }).click();
  await page.getByRole("menu", { name: "Ada's task" }).getByRole("menuitem", { name: "Quill" }).click();
  await expect(laneTask(page, "Schedule the sale email", "Quill")).toBeVisible({ timeout: 15_000 });
  await expect(emailFailed).toBeHidden();

  // Neither waits on you any more, on the ticket or in the Inbox.
  await expect(ticket(page, quest)).not.toContainText("need you", { timeout: 15_000 });
  await expect(
    page.getByRole("navigation", { name: "Sections" }).getByRole("link", { name: /^Inbox/ }),
  ).not.toHaveAccessibleName(/waiting on you/);
  await scan();
});

/** A prompt line that makes the fake run a command, with what it prints and how it exits. */
const run = (input: object) => `fake:run ${JSON.stringify(input)}`;

// covers OR-001, OR-002, OR-007, UX-002, UX-006
test("[TC-UX-292] a party's Black Friday Quest is steered from the chat with its receipt, and its Workbench is filtered by lane and by try with the Terminal split by hob", async ({
  page,
  scan,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  stop = stopAldricHub;
  const { url, aldric, members, api, hub, folder } = await aldricHub(undefined, ["Quill", "Ada"]);
  for (const member of members) await api("PATCH", `/agents/${member}/permissions`, { ownFolders: [folder] });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);

  // Aldric checks the folder and brings in the party. Quill's first try writes the copy and fails, so
  // a second try finishes it; Ada runs the build, then reports she is stuck until she hears more.
  await ask(page, [
    TITLE,
    run({ command: "git status --short", output: " M notes.md\n", exitCode: 0 }),
    script("start_quest", { key: "quest", goal: TITLE }),
    script("delegate_task", {
      key: "copy",
      hob: "Quill",
      brief: [
        "Draft the landing copy",
        'fake:once fake:write copy.md "# Copy\\n\\n20% off everything.\\n"',
        "fake:fail",
        `fake:then ${script("complete_task", { delivered: true, key: "copy-done", summary: "The landing copy is drafted." })}`,
      ].join("\n"),
    }),
    script("delegate_task", {
      key: "build",
      hob: "Ada",
      milestones: ["Settled"],
      brief: [
        "Build the campaign",
        run({ command: "pnpm build", output: "built the landing page\n", exitCode: 0 }),
        script("report_checkpoint", { key: "build-stuck", kind: "blocker", summary: "The colours are not settled" }),
      ].join("\n"),
    }),
    script("wait_for", { key: "wait", tasks: ["$build.task_id"] }),
  ]);
  await expect(page).toHaveURL(/\/threads\//);
  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";

  // Ada's Task waits for word; the steer below needs its id.
  let adaTask = "";
  await expect
    .poll(
      async () => {
        const response = await fetch(`${url}/api/threads/${thread}/tasks`, { headers: hub.headers });
        const { trees } = (await response.json()) as {
          readonly trees: ReadonlyArray<{
            readonly tasks: ReadonlyArray<{ readonly id: string; readonly ownerId: string; readonly state: string }>;
          }>;
        };
        const task = trees.flatMap((tree) => tree.tasks).find((each) => each.ownerId === members[1]);
        adaTask = task?.state === "blocked" ? task.id : "";
        return adaTask !== "";
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  const room = await openRoom(page, TITLE);
  await expect(laneHead(page, "Quill")).toContainText("Done", { timeout: 60_000 });
  await expect(laneTask(page, "Draft the landing copy")).toContainText("attempt 2");

  // A note from the chat column: the receipt follows it from Aldric to Ada's turn, and the lanes show it.
  await idle(page);
  await ask(page, [
    "Use the blue theme",
    script("message_task", { key: "steer", task_id: adaTask, text: "Use the blue theme." }),
  ]);
  const receipt = chat(page).getByRole("region", { name: "Where your message went" }).last();
  await expect(receipt).toContainText("Aldric got it →", { timeout: 45_000 });
  await expect(receipt).toContainText("Ada picked it up", { timeout: 60_000 });
  await expect(receipt.getByRole("status")).toHaveText("Aldric got your message. Ada picked it up.");
  const notes = (name: string) => lane(page, name).getByRole("list", { name: "Your notes" });
  await expect(notes("Aldric").getByRole("listitem")).toHaveText([
    /Your note: Use the blue theme/,
    /Passed it to Ada$/,
  ]);
  await expect(notes("Ada").getByRole("listitem")).toHaveText([/Your note, via Aldric$/]);
  await scan();
  await idle(page);

  // The docked Workbench, unfiltered: the Terminal has a tab per hob that ran a command, and Split
  // shows them side by side.
  const bench = dock(page);
  await bench.getByRole("button", { name: "Open the Workbench" }).click();
  const terminalTab = bench.getByRole("tab", { name: /^Terminal/ });
  await terminalTab.click();
  const terminal = bench.getByRole("tabpanel", { name: /^Terminal/ });
  await expect(terminal.getByRole("tablist", { name: "Terminals" }).getByRole("tab")).toHaveText(["Aldric", "Ada"], {
    timeout: 30_000,
  });
  await terminal.getByRole("button", { name: "◫ Split" }).click();
  const [aldricTerminal, adaTerminal] = [hobTerminal(terminal, "Aldric"), hobTerminal(terminal, "Ada")];
  await expect(aldricTerminal).toBeVisible();
  await expect(adaTerminal).toBeVisible();
  await expect(rows(aldricTerminal)).toContainText("$ git status --short");
  await expect(rows(adaTerminal)).toContainText("$ pnpm build");
  await expect(rows(adaTerminal)).toContainText("built the landing page");
  const [left, right] = [await aldricTerminal.boundingBox(), await adaTerminal.boundingBox()];
  expect(left !== null && right !== null && left.x + left.width <= right.x + 1 && left.y === right.y).toBe(true);
  await scan();

  // Unfiltered, Changes lists the copy Quill's failed try wrote: her retry works on what it left (#1218).
  const changesTab = bench.getByRole("tab", { name: /^Changes/ });
  await changesTab.click();
  const changed = bench.getByRole("tabpanel", { name: /^Changes/ }).getByRole("navigation", { name: "Changed files" });
  await expect(changed.getByRole("button", { name: /^copy\.md\s*, by Quill/ })).toHaveCount(1);

  // Quill's lane filters every tab to her work; her latest try changed nothing itself, so the copy
  // says it came from her first.
  await laneHead(page, "Quill").click();
  await expect(bench.getByRole("button", { name: /^Quill only/ })).toBeVisible();
  await expect(changesTab).toHaveText("Changes1");
  await expect(terminalTab).toHaveText("TerminalNot used in this task");
  await expect(changed.getByRole("button")).toHaveText([/^copy\.md/]);
  await expect(
    bench.getByRole("tabpanel", { name: /^Changes/ }).getByRole("article", { name: "copy.md" }),
  ).toContainText("Changed in attempt 1.");

  // Her first try, picked in her lane, is what every tab shows: the copy it wrote, kept in the address.
  const tries = lane(page, "Quill").getByRole("group", { name: "Quill's attempts" });
  await expect(tries.getByRole("button")).toHaveText(["1✗", "2"]);
  await tries.getByRole("button", { name: "Attempt 1, failed" }).click();
  await expect(page).toHaveURL(/attempt=/);
  await expect(
    bench.getByRole("radiogroup", { name: "Attempts" }).getByRole("radio", { name: "Attempt 1" }),
  ).toBeChecked();
  await changesTab.click();
  await expect(changed.getByRole("button")).toHaveText([/^copy\.md/]);
  await expect(
    bench.getByRole("tabpanel", { name: /^Changes/ }).getByRole("article", { name: "copy.md" }),
  ).not.toContainText("Changed in attempt");
  await page.reload();
  await expect(questRoom(page, TITLE)).toBeVisible();
  await expect(tries.getByRole("button", { name: "Attempt 1, failed" })).toHaveAttribute("aria-pressed", "true");
  await expect(changed.getByRole("button")).toHaveText([/^copy\.md/]);
  await expect(room).toBeVisible();
  await scan();
});

const themeIds: readonly string[] = (
  JSON.parse(readFileSync(new URL("../../../docs/design/themes.json", import.meta.url), "utf8")) as {
    readonly themes: readonly { readonly id: string }[];
  }
).themes.map((theme) => theme.id);

// covers UX-002, UX-006
test("[TC-UX-293] the room holds up in all four themes at 1280, 1024 and 960 px, with no sideways scroll and the chat column as each width sets it", async ({
  page,
  scan,
}) => {
  test.setTimeout(120_000);
  expect(themeIds).toHaveLength(4);
  await page.setViewportSize({ width: 1280, height: 800 });
  stop = stopQuestHub;
  const { url, aldric } = await questHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await ask(page, ["Plan a Black Friday campaign for the shop"]);
  const room = await openRoom(page, TITLE);
  await expect(lane(page, "Ada").getByRole("region", { name: "Ada asks you" })).toBeVisible({ timeout: 30_000 });

  for (const [width, column] of [
    [1280, 360],
    [1024, 300],
    [960, null],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of themeIds) {
      const at = `${theme} at ${width} px`;
      await page.evaluate((id) => localStorage.setItem("hobbots.theme", JSON.stringify(id)), theme);
      await page.reload();
      await expect(page.locator("html"), at).toHaveAttribute("data-theme", theme);
      await expect(room.getByRole("heading", { name: TITLE }), at).toBeVisible();
      for (const name of ["Aldric", "Quill", "Ada"]) await expect(lane(page, name), at).toBeVisible();
      await expect(lane(page, "Ada").getByRole("region", { name: "Ada asks you" }), at).toBeVisible();
      await expect(dock(page).getByRole("button", { name: "Open the Workbench" }), at).toBeVisible();
      if (column === null) {
        // At 960 the chat starts folded to its rail.
        await expect(page.getByRole("complementary", { name: "Chat, folded" }), at).toBeVisible();
        await expect(chat(page), at).toBeHidden();
      } else {
        const box = await chat(page).boundingBox();
        expect(Math.round(box?.width ?? 0), at).toBeGreaterThanOrEqual(column - 1);
        expect(Math.round(box?.width ?? 0), at).toBeLessThanOrEqual(column);
      }
      // The page never scrolls sideways. A failure names the outermost elements that stick out past
      // the window's right edge with nothing around them to clip or scroll them.
      const overflow = await page.evaluate(() => {
        const edge = document.documentElement.clientWidth;
        const unclipped = (element: Element) => {
          for (let up = element.parentElement; up !== null && up !== document.body; up = up.parentElement) {
            if (getComputedStyle(up).overflowX !== "visible") return false;
          }
          return true;
        };
        const sticking = [...document.body.querySelectorAll("*")].filter(
          (element) => element.getBoundingClientRect().right > edge + 0.5 && unclipped(element),
        );
        return {
          by: document.documentElement.scrollWidth - edge,
          sticking: sticking
            .filter((element) => !sticking.includes(element.parentElement as Element))
            .slice(0, 5)
            .map(
              (element) =>
                `${element.tagName.toLowerCase()}.${element.getAttribute("class") ?? ""} → ${element.getBoundingClientRect().right}`,
            ),
        };
      });
      expect(overflow, at).toEqual({ by: 0, sticking: [] });
      await scan();
    }
  }
});
