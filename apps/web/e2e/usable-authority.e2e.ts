import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

test.afterEach(stopAldricHub);

// Issue #661 in the browser: Aldric gives Nettle Save versions with Git and Run commands and tests but denies Edit files,
// which leaves Nettle no command tool. The delegation's step in Aldric's reply shows it refused, with
// the rule and the tools Nettle would have. The hub side is in apps/server/test/usable-authority.test.ts.

// covers OR-002, PE-005, UX-002
test("[TC-OR-432] a delegation that leaves Nettle no command tool shows in Aldric's reply as refused, with what Nettle would have", async ({
  page,
}) => {
  const { url, aldric, members, api, folder } = await aldricHub(undefined, ["Nettle"]);
  // Nettle works in Aldric's folder too, so only the authority Aldric gives can leave it toolless.
  await api("PATCH", `/agents/${members[0]}/permissions`, { ownFolders: [folder] });
  await page.goto(`${url}/#/hobs/${aldric}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(
    [
      "Commit the notes",
      script("start_quest", { key: "quest", goal: "Commit the notes" }),
      script("delegate_task", {
        key: "commit",
        hob: "Nettle",
        brief: "Make the local commit",
        authority: { decisions: { "edit-files": "deny", "local-git": "allow", "run-commands": "allow" } },
      }),
    ].join("\n"),
  );
  await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });

  const steps = page.getByRole("list", { name: "Reply steps" }).last();
  const refused = steps.getByRole("listitem").filter({ hasText: "Delegating a Task" });
  await expect(refused).toHaveAttribute("data-state", "failed");
  await expect(refused).toContainText("Hobbots refused this: Nettle could not use run-commands or local-git");
  await expect(refused).toContainText("Give edit-files allow");
  await expect(refused).toContainText("Nettle will have: file reads; no file edits, no commands, no git_init.");
});
