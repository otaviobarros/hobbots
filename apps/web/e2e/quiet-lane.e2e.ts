import { expect, test } from "./hub.ts";
import { lane, openRoom } from "./quest-room.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1004: a Running hob sat in its lane for minutes with nothing new, and the room never said
// whether it was working, waiting or stuck. Its now line now says when its last step was once a
// minute passes without one, and drops that as soon as the hob does something again.

test.afterEach(stopAldricHub);

const TITLE = "Ship the launch copy";

// covers UX-004, OR-001
test("[TC-UX-1004-02] a running lane that goes quiet says when its hob's last step was, live, and drops it once the hob moves again", async ({
  page,
}) => {
  test.setTimeout(150_000);
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Quill"]);
  for (const member of members) await api("PATCH", `/agents/${member}/permissions`, { ownFolders: [folder] });

  // Quill's push asks you first, so her turn runs with nothing new until you answer; then she starts
  // a long command that keeps her turn running.
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      TITLE,
      script("delegate_task", {
        key: "ship",
        hob: "Quill",
        brief: ["Push the copy", "fake:tool Bash git push origin feature", "fake:tool Bash sleep 600"].join("\n"),
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await openRoom(page, TITLE);

  const did = lane(page, "Quill").getByRole("list", { name: "What Quill did" });
  const now = did.getByRole("listitem").last();
  await expect(now).toHaveText("Working", { timeout: 30_000 });

  // A minute on with nothing new, the same line says when the last step was, with no reload.
  await expect(now).toHaveText(/^Working· last step (1 minute|2 minutes) ago$/, { timeout: 100_000 });

  // Allowing the push lets Quill move again: her line names the step she is on, and the age is gone.
  await page.getByRole("button", { name: "Allow once" }).first().click();
  await expect(now).not.toContainText("last step", { timeout: 30_000 });
  await expect(now).not.toHaveText("Working");
  await expect(now).not.toContainText("sleep");

  // The technical steps name the exact command, and the age stays away.
  await page.getByRole("button", { name: "Show technical steps" }).click();
  await expect(now).toHaveText("Running sleep 600");
});

// covers UX-004, OR-001
test("[TC-UX-1004-04] a lane names the background command its hob's turn waits on, then moves on once it ends", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Quill"]);
  for (const member of members) await api("PATCH", `/agents/${member}/permissions`, { ownFolders: [folder] });

  // Quill starts the tests in the background, checks something else, and her turn then waits for them.
  const tests = { command: "pnpm test", background: true, runsFor: "20 seconds", output: "7 passed\n", exitCode: 0 };
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      TITLE,
      script("delegate_task", {
        key: "ship",
        hob: "Quill",
        brief: ["Check the copy", `fake:run ${JSON.stringify(tests)}`, "fake:tool Bash echo checked"].join("\n"),
      }),
    ].join("\n"),
  );
  await composer.press("Enter");
  await openRoom(page, TITLE);

  const did = lane(page, "Quill").getByRole("list", { name: "What Quill did" });
  const now = did.getByRole("listitem").last();
  await expect(now).toHaveText("Waiting for the tests to finish", { timeout: 30_000 });
  await page.getByRole("button", { name: "Show technical steps" }).click();
  await expect(now).toHaveText("Waiting on pnpm test");

  // Once the tests end, the turn finishes and the wait is gone.
  await expect(did).not.toContainText("Waiting on", { timeout: 40_000 });
  await expect(lane(page, "Quill")).toContainText("Done", { timeout: 20_000 });
});
