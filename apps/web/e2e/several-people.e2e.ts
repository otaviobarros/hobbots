import type { Actor, Message } from "@hobbots/domain";
import { expectAccessible } from "./accessibility.ts";
import { campAt, expect, signInAs, test, testPeople } from "./hub.ts";
import { aldricHub, stopAldricHub } from "./workbench-hub.ts";

// Issue #1457 (ADR 039, How we test several people without accounts): the browser tests' build of
// the hub adds Bruna and Leo, each with a device, so a test plays two people on two devices.

test.afterEach(stopAldricHub);

// covers ADR 039 (Users as actors)
test("[TC-CH-1457-01] Bruna and Leo sign in on two devices, see each other's messages in one camp, and each message names its writer", async ({
  browser,
}) => {
  const { aldric, hub } = await aldricHub(undefined, [], { HOBBOTS_TEST_PEOPLE: "on" });
  const camp = await campAt(hub, aldric, "Winter Market");
  const [bruna, leo] = testPeople(hub);
  if (bruna === undefined || leo === undefined) throw new Error("The hub added fewer than two people.");
  expect([bruna.name, leo.name]).toEqual(["Bruna", "Leo"]);

  const people = [];
  for (const person of [bruna, leo]) {
    // Each person's browser is watched like the test's own: the window never scrolls (STD-TEST-010).
    const { context, watch } = await signInAs(browser, hub, person);
    const page = await context.newPage();
    // Each device is in without the pairing screen, and opens the camp.
    await page.goto(camp.url);
    await expect(page).not.toHaveURL(/#\/pair$/);
    await expect(page.getByRole("textbox", { name: /^Message Aldric/ })).toBeVisible();
    people.push({ person, context, watch, page });
  }

  for (const { person, page } of people) {
    const prompt = `${person.name} asks for the landing page`;
    const composer = page.getByRole("textbox", { name: /^Message Aldric/ });
    await composer.fill(prompt);
    await expect(page.getByRole("button", { name: /^Send( after this reply)?$/ })).toBeEnabled();
    await composer.press("Enter");
    await expect(page.getByText(`Echo: ${prompt}`).first()).toBeVisible({ timeout: 20_000 });
  }

  // Both devices see both people's messages, on one hub, in a camp each can use (STD-TEST-007).
  for (const { page } of people) {
    for (const { person } of people) {
      await expect(page.getByText(`${person.name} asks for the landing page`, { exact: true }).first()).toBeVisible();
    }
    await expectAccessible(page);
  }

  // Each message names the person whose device sent it, never the owner.
  const response = await people[1]?.context.request.get(`${hub.url}/api/threads/${camp.id}/messages`);
  expect(response?.ok()).toBe(true);
  const messages = ((await response?.json()) ?? []) as ReadonlyArray<Pick<Message, "content" | "actor">>;
  const writerOf = (text: string): Actor | null | undefined =>
    messages.find((message) => message.content === text)?.actor;
  expect(writerOf("Bruna asks for the landing page")).toEqual({ kind: "user", id: bruna.userId });
  expect(writerOf("Leo asks for the landing page")).toEqual({ kind: "user", id: leo.userId });

  for (const { person, context, watch } of people) {
    await watch.checkOpenPages();
    expect(watch.breaks(), `${person.name}'s window must never scroll (STD-TEST-010)`).toEqual([]);
    await context.close();
  }
});
