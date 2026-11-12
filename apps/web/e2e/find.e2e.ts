import { DEFAULT_MEMORY_SETTINGS, type Decision } from "@hobbots/domain";
import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { expect, test } from "./hub.ts";
import { aldricHub, script, stopAldricHub } from "./workbench-hub.ts";

// Issue #1386 (ADR 037): Find, on the fake runtime. It finds a chat's decisions, a crossed-out one
// shown crossed out, and Ask answers from them on the hub's brain, citing each; a citation opens
// the message the decision came from.

test.afterEach(stopAldricHub);

/** Sends `lines` as one message to Aldric and waits until his reply, which echoes them, has ended. */
const say = async (page: Page, lines: ReadonlyArray<string>) => {
  const main = page.getByRole("main", { name: "Chat" });
  const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
  await composer.fill(lines.join("\n"));
  await composer.press("Enter");
  await expect(main.getByRole("article").filter({ hasText: lines[0]?.slice(0, 40) ?? "" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
};

const threadOf = (page: Page) => new URL(page.url()).hash.split("/threads/")[1]?.split("?")[0] ?? "";

// covers CH-009, ADR 037 (Find)
test("[TC-CH-1386-08] Ask answers about an old decision, cites it, and the citation opens its message; a crossed-out one shows crossed out", async ({
  page,
}) => {
  const { url, aldric, hub } = await aldricHub();
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await say(page, [
    "Settle the shipping.",
    script("record_decision", { key: "free", text: "Offer free shipping over $50" }),
    script("record_decision", { key: "lead", text: "Lead the banner with free shipping" }),
  ]);
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
  const threadId = threadOf(page);

  // You cross out the banner decision.
  const listed = await fetch(`${url}/api/threads/${threadId}/decisions`, { headers: hub.headers });
  const decisions = (await listed.json()) as ReadonlyArray<Decision>;
  const lead = decisions.find((each) => each.text === "Lead the banner with free shipping");
  if (lead === undefined) throw new Error("Aldric recorded no banner decision");
  const crossed = await fetch(`${url}/api/threads/${threadId}/decisions/${lead.id}/cross-out`, {
    method: "POST",
    headers: hub.headers,
  });
  expect(crossed.ok).toBe(true);

  // The talk moves on; the brain's answer to the question below is scripted for the fake.
  await say(page, [
    "Now the emails.",
    `fake:judgment shipping ${JSON.stringify({
      choice: { answer: "Free shipping over $50 holds; the banner lead was crossed out.", cites: [1, 2] },
      confidence: 0.9,
    })}`,
  ]);

  // Find lists both decisions, the crossed-out one crossed out. The index catches up in a few seconds.
  await page.getByRole("button", { name: "Find", exact: true }).click();
  const box = page.getByRole("searchbox", { name: "Find" });
  await box.fill("shipping");
  const found = page.getByRole("region", { name: "What Find found" });
  const decided = found.getByRole("region", { name: "Decisions · 2" });
  await expect(decided).toBeVisible({ timeout: 20_000 });
  const holds = decided.getByRole("button", { name: /^Offer free shipping over \$50/ });
  await expect(holds).toBeVisible();
  const out = decided.getByRole("button", { name: /^Crossed out: Lead the banner with free shipping/ });
  await expect(out.locator(".line-through")).toBeVisible();

  // Ask answers from the records, citing each.
  await box.fill("What did we decide about shipping?");
  await box.press("Enter");
  const answer = found.getByRole("status");
  await expect(answer).toContainText("Free shipping over $50 holds; the banner lead was crossed out.", {
    timeout: 30_000,
  });
  await expect(answer).toContainText("Aldric · from the records, nothing new was run");
  const sources = answer.getByRole("list", { name: "Sources" });
  await expect(sources.getByRole("button", { name: /decision$/ })).toHaveCount(2);
  await expectAccessible(page, found);

  // A citation opens the message the decision came from and closes Find.
  await sources.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/threads/${threadId}\\?message=`));
  await expect(box).toBeHidden();
});

// covers CH-009, ADR 037 (Find, No AI)
test("[TC-CH-1386-10] under No AI, Ask lists the records it found, even ones Find's every-word search misses, and each opens its message", async ({
  page,
}) => {
  const { url, aldric, api } = await aldricHub();
  await api("PUT", "/memory/settings", { ...DEFAULT_MEMORY_SETTINGS, provider: "none" });
  await page.goto(`${url}/#/hobs/${aldric}/chat`);
  await say(page, [
    "Plan the newsletter.",
    script("record_decision", { key: "day", text: "Launch emails go out on Thursdays" }),
  ]);
  await expect(page).toHaveURL(new RegExp(`#/hobs/${aldric}/threads/`));
  const threadId = threadOf(page);

  // Find needs every word, so the question finds nothing; the index catches up in a few seconds.
  await page.getByRole("button", { name: "Find", exact: true }).click();
  const box = page.getByRole("searchbox", { name: "Find" });
  await box.fill("thursdays");
  const found = page.getByRole("region", { name: "What Find found" });
  await expect(found.getByRole("region", { name: "Decisions · 1" })).toBeVisible({ timeout: 20_000 });
  await box.fill("When do the launch emails go out?");
  await expect(found.getByText("No exact matches. Ask Aldric: the records may still answer it.")).toBeVisible();

  // Ask, with no AI, says so and lists what it found.
  await box.press("Enter");
  const answer = found.getByRole("status");
  await expect(answer).toContainText("No AI is chosen for the hub's brain, so here is what matches, with no answer.");
  const matched = answer.getByRole("region", { name: "Decisions · 1" });
  await expect(matched.getByRole("button", { name: /^Launch emails go out on Thursdays/ })).toBeVisible();
  await expectAccessible(page, found);

  await matched.getByRole("button").first().click();
  await expect(page).toHaveURL(new RegExp(`/threads/${threadId}\\?message=`));
  await expect(box).toBeHidden();
});
