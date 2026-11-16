import { expectAccessible } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1596 (ADR 041): a Quest in the chat, on the fake runtime. One reply starts it with
// `start_work` and its card shows under that reply; a later reply finishes it with `finish_work`,
// the same card reads it ready for review, and the finishing reply leaves one line. The card names who
// asked for it (#1487).

test.afterEach(stopAldricHub);

test("a hob starts a Quest with its card, and a later reply finishes it (#1596)", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  const card = main.getByRole("region", { name: "Quest: Winter market page" });

  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: "Message Aldric…" });
  await composer.fill(
    [
      "A page for the winter market",
      script("start_work", {
        title: "Winter market page",
        goal: "A landing page for the winter market.",
        done_when: ["The page is live", "It shows the map"],
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await expect(card).toContainText("Quest · Running", { timeout: 30_000 });
  await expect(card).toContainText("A landing page for the winter market.");
  await expect(card.getByRole("listitem")).toHaveText(["The page is live", "It shows the map"]);
  // It belongs to the chat it was asked in, and names who runs it and who asked (#1487).
  await expect(card).toContainText("Aldric runs it");
  await expect(card).toContainText("Asked by you");
  await expectAccessible(page, card);

  await composer.fill(
    ["It's up", script("finish_work", { result: "The page is live with the map.", made: ["PR #12"] })].join("\n"),
  );
  await composer.press("Enter");
  await expect(card).toContainText("Quest · Ready for review", { timeout: 30_000 });
  await expect(card).toContainText("The page is live with the map.");
  await expect(
    main.getByRole("status").filter({ hasText: "Aldric finished Winter market page · PR #12" }),
  ).toBeVisible();
});

// covers ADR 039 (Asking for a delivery in a shared camp)
test("a Quest lists what its hob read first, and a chip opens where it was made (#1487)", async ({ page }) => {
  const { url, aldric } = await aldricHub();
  const main = page.getByRole("main", { name: "Chat" });
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  const send = async (lines: ReadonlyArray<string>) => {
    await composer.fill(lines.join("\n"));
    await composer.press("Enter");
    await expect(
      main
        .getByRole("article")
        .filter({ hasText: lines[0] ?? "" })
        .first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible({ timeout: 30_000 });
  };

  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  // A decision, then a new chapter: the next session starts from a pack that carries both.
  await send(["Ship on Fridays.", script("record_decision", { key: "fridays", text: "Ship on Fridays." })]);
  await send(["Now the market.", script("start_chapter", { key: "market", title: "The market" })]);
  await send([
    "A page for the winter market",
    script("start_work", {
      title: "Winter market page",
      goal: "A landing page for the winter market.",
      done_when: ["The page is live"],
    }),
  ]);
  const card = main.getByRole("region", { name: "Quest: Winter market page" });
  await expect(card).toContainText("Quest · Running", { timeout: 30_000 });
  const read = card.getByRole("list", { name: "Read first" });
  await expect(read).toContainText("Decision: Ship on Fridays.");
  await expect(read).toContainText("Chapter 1");
  await expectAccessible(page, card);

  // The decision's chip jumps to the message whose turn recorded it.
  await read.getByRole("button", { name: "Open Decision: Ship on Fridays." }).click();
  await expect(page).toHaveURL(/message=/);
});
