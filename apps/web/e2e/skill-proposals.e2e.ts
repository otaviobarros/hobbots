import { randomUUID } from "node:crypto";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// #1063: a hob's skill proposal (ADR 029, Proactive hobs), from its `skill_propose` call in a chat to
// your decision in the Inbox: Add, Edit then add, and Not now, on a hub with the fake runtime.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: What ${name} is for, and when to use it.\n---\n\n# ${name}\n\n${body}\n`;

/**
 * A hub past setup with Ada. `propose` has Ada propose a new skill in a chat of its own, as a
 * `skill_propose` call, so it reaches the hub as any hob's proposal would.
 */
const proposalHub = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const { url, headers } = hub;
  const api = async (method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"], safetyPreset: "balanced" });
  const ada = await api("POST", "/agents", {
    id: randomUUID(),
    name: "Ada",
    role: null,
    roleTitle: "Builder",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 1302,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  const propose = async (name: string, body: string) => {
    const thread = await api("POST", `/agents/${ada.id}/threads`);
    const call = { key: name, name, instructions: skillMd(name, body), why: `I repeat the ${name} steps.` };
    await api("POST", `/threads/${thread.id}/messages`, {
      content: `Keep how we release\nfake:hub skill_propose ${JSON.stringify(call)}`,
    });
  };
  return { url, propose };
};

// covers ADR 029 (Proactive hobs), #1063
test("[TC-UX-1063-01] a proposal arrives in the open Inbox as a Skill, and Add puts it in Ada's skills", async ({
  page,
}) => {
  const { url, propose } = await proposalHub();
  await page.goto(`${url}/#/inbox`);
  const needsYou = page.getByRole("link", { name: "Hobbots inbox, something needs you" });
  await expect(needsYou).toHaveCount(0);

  // Ada proposes while the Inbox is open: the proposal streams in under Skills, counted in the badge.
  await propose("release-steps", "Tag the release, then push the tag.");
  const row = page.getByRole("link", { name: /Ada drafted a skill: Release steps/ });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(needsYou).toBeVisible();

  await row.click();
  const review = page.getByRole("article", { name: "Skill from Ada" });
  const diff = review.getByRole("region", { name: "The skill" });
  await expect(diff).toContainText("new · r1");
  await expect(diff).toContainText("Release steps · SKILL.md");
  await expect(diff).toContainText("Tag the release, then push the tag.");
  await expect(review).toContainText("I repeat the release-steps steps.");
  await expect(review).toContainText("A new skill always waits for you, whatever the safety level.");
  await expectAccessible(page, review);

  await review.getByRole("button", { name: "Add it for Ada" }).click();
  await expect(review.getByRole("status")).toHaveText(
    "Added Release steps r1 for Ada. Ada uses it from its next chat.",
  );
  await expect(review.getByRole("button", { name: "Not now" })).toHaveCount(0);
  await expect(needsYou).toHaveCount(0);
});

// covers ADR 029 (Proactive hobs), #1063
test("[TC-UX-1063-02] Edit then add keeps your draft through a refusal and adds your edit, and Not now turns one down", async ({
  page,
}) => {
  const { url, propose } = await proposalHub();
  await propose("release-steps", "Tag the release.");
  await propose("review-steps", "Read the diff.");
  await page.goto(`${url}/#/inbox`);

  await page.getByRole("link", { name: /Ada drafted a skill: Release steps/ }).click({ timeout: 20_000 });
  const release = page.getByRole("article", { name: "Skill from Ada" });
  await release.getByRole("button", { name: "Edit, then add" }).click();
  const field = release.getByRole("textbox", { name: "The skill to add" });
  await expect(field).toHaveValue(skillMd("release-steps", "Tag the release."));

  // A draft the checks refuse says why and stays as you wrote it, to fix.
  const broken = skillMd("release-steps", "Tag, then push.").replace("name: release-steps", "name: Release Steps");
  await field.fill(broken);
  await release.getByRole("button", { name: "Add it" }).click();
  await expect(release.getByRole("alert")).toContainText("It was not added:");
  await expect(field).toHaveValue(broken);

  await field.fill(skillMd("release-steps", "Tag, then push."));
  await field.press("Tab");
  await release.getByRole("button", { name: "Add it" }).click();
  await expect(release.getByRole("status")).toHaveText(
    "Added Release steps r1 for Ada. Ada uses it from its next chat. You edited it before you added it.",
  );

  // Not now, from the keyboard.
  await page.getByRole("link", { name: /Ada drafted a skill: Review steps/ }).click();
  const review = page.getByRole("article", { name: "Skill from Ada" });
  await expect(review).toContainText("Read the diff.");
  await review.getByRole("button", { name: "Not now" }).focus();
  await page.keyboard.press("Enter");
  await expect(review.getByRole("status")).toHaveText("Not now. Ada is told, and the library is unchanged.");
  await expect(page.getByRole("link", { name: "Hobbots inbox, something needs you" })).toHaveCount(0);

  // Decided proposals stay listed in History, but nothing waits: Needs you says so.
  await page.goto(`${url}/#/inbox`);
  await expect(page.getByText("Nothing needs you")).toBeVisible({ timeout: 20_000 });
});

// covers ADR 029 (Proactive hobs), #1063
test("[TC-UX-1063-04] what the checks flag shows before you add it, a hidden character is marked where it is, and an edit is checked first", async ({
  page,
}) => {
  const { url, propose } = await proposalHub();
  await propose("release-steps", "Tag the\u200B release.");
  await page.goto(`${url}/#/inbox`);
  await page.getByRole("link", { name: /Ada drafted a skill: Release steps/ }).click({ timeout: 20_000 });
  const review = page.getByRole("article", { name: "Skill from Ada" });
  const flags = review.getByRole("region", { name: "Look at these first" });
  await expect(flags).toContainText("SKILL.md has characters you cannot see, such as U+200B.");
  await expect(review.getByRole("region", { name: "The skill" }).getByTitle("hidden character U+200B")).toHaveText(
    "U+200B",
  );
  await expectAccessible(page, review);

  // An edit that links out is checked when you add it: it says what it found, then waits for you.
  await review.getByRole("button", { name: "Edit, then add" }).click();
  const field = review.getByRole("textbox", { name: "The skill to add" });
  await field.fill(skillMd("release-steps", "Read https://example.com/release, then tag."));
  await review.getByRole("button", { name: "Add it" }).click();
  await expect(flags).toContainText("SKILL.md links to https://example.com/release.");
  await expect(review.getByRole("status")).toHaveCount(0);
  await review.getByRole("button", { name: "Add it anyway" }).click();
  await expect(review.getByRole("status")).toHaveText(
    "Added Release steps r1 for Ada. Ada uses it from its next chat. You edited it before you added it.",
  );
});

// covers ADR 029 (Proactive hobs), #1063
test("[TC-UX-1063-03] a proposals list that fails to load never reads as all clear, and Try again shows what waits", async ({
  page,
}) => {
  const { url, propose } = await proposalHub();
  await propose("release-steps", "Tag the release.");
  // The proposals fail to read until the hub answers again; every other read of the Inbox answers.
  let down = true;
  await page.route("**/api/skill-proposals", async (route) => {
    if (down) await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    else await route.continue();
  });
  await page.goto(`${url}/#/inbox`);

  const failed = page.getByRole("alert").filter({ hasText: "Hobbots could not read the skills your hobs propose." });
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Nothing needs you")).toHaveCount(0);
  down = false;
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("link", { name: /Ada drafted a skill: Release steps/ })).toBeVisible({
    timeout: 20_000,
  });
  await expect(failed).toHaveCount(0);
});
