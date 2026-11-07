import type { Page } from "@playwright/test";
import { expectAccessible } from "./accessibility.ts";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// Picking a skill in the composer and the line a reply leaves for each skill it used (ADR 029,
// Explicit use and The use line, #1096), on the fake runtime, which reports a skill it was handed.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

const skillMd = (name: string) => `---\nname: ${name}\ndescription: About ${name}.\n---\n\n# ${name}\n`;

/** A hub past setup with Pip, and each of `names` in the library for everyone, Release steps first. */
const hubWithSkill = async (names: ReadonlyArray<string> = []) => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const started = hub;
  const api = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...started.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<A>;
  };
  /** Imports a skill and assigns it to everyone; answers the assignment's id. */
  const addSkill = async (name: string) => {
    const imported = await api<{ imported: ReadonlyArray<{ skill: { id: string } }> }>("POST", "/skills", {
      source: { _tag: "Written", files: [{ path: "SKILL.md", text: skillMd(name) }] },
    });
    const skill = imported.imported[0]?.skill;
    if (skill === undefined) throw new Error(`${name} was not imported.`);
    return (await api<{ id: string }>("POST", `/skills/${skill.id}/assignments`, { scope: { _tag: "Everyone" } })).id;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ id: string }>("POST", "/agents", {
    name: "Pip",
    role: null,
    roleTitle: "Writer",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 1311,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  const release = await addSkill("release-steps");
  for (const name of names) await addSkill(name);
  return { url: started.url, pip, api, addSkill, release };
};

const composerOf = (page: Page) => page.getByRole("textbox", { name: /^Message Pip/ });
const pickerOf = (page: Page) => page.getByRole("region", { name: "Pip's skills" });
const usedLines = (page: Page) => page.getByRole("list", { name: "Skills Pip used" });

// covers ADR 029 (Explicit use, The use line), #1096
test("[TC-UI-1096-06] Use a skill keeps the draft, the keyboard picks a skill, and the reply's Used line stays after a reload", async ({
  page,
}) => {
  const { url, pip } = await hubWithSkill();
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  const composer = composerOf(page);
  await composer.fill("Ship it\nwith the notes");

  // Use a skill puts a `/` before what was written and leaves it there.
  await page.getByRole("button", { name: "Use a skill" }).click();
  await expect(composer).toHaveValue("/ Ship it\nwith the notes");
  await expect(pickerOf(page)).toContainText("/release-steps");
  await expectAccessible(page, pickerOf(page));

  // Escape closes the list and gives back the message as it was.
  await composer.press("Escape");
  await expect(pickerOf(page)).toBeHidden();
  await expect(composer).toHaveValue("Ship it\nwith the notes");

  // Typing filters from the cursor after the `/`, and Enter picks the highlighted skill.
  await page.getByRole("button", { name: "Use a skill" }).click();
  await page.keyboard.type("rel");
  await expect(composer).toHaveValue("/rel Ship it\nwith the notes");
  await expect(pickerOf(page).getByRole("button", { name: /release-steps/ })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Enter");
  await expect(pickerOf(page)).toBeHidden();
  await expect(composer).toHaveValue("/release-steps Ship it\nwith the notes");

  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
  await expect(usedLines(page)).toContainText("Used Release steps (r1)");
  await expectAccessible(page, usedLines(page));

  await page.reload();
  await expect(usedLines(page)).toContainText("Used Release steps (r1)");
});

// covers ADR 029 (Explicit use), STD-REACT-015
test("[TC-UI-1096-07] when the hob's skills cannot be read, the list says so and Try again brings them", async ({
  page,
}) => {
  const { url, pip } = await hubWithSkill();
  const hobSkills = "**/api/skills/hobs/*";
  await page.route(hobSkills, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  const composer = composerOf(page);
  await composer.fill("/");
  // The client asks again a few times before it gives up; until then the list says it is loading.
  await expect(pickerOf(page)).toContainText("Loading Pip's skills");
  await expect(pickerOf(page).getByRole("alert")).toContainText("Hobbots could not read Pip's skills.", {
    timeout: 20_000,
  });
  await expect(pickerOf(page)).not.toContainText("has no skills");

  await page.unroute(hobSkills);
  await pickerOf(page).getByRole("button", { name: "Try again" }).click();
  await expect(pickerOf(page)).toContainText("/release-steps");
  await expect(composer).toBeFocused();
});

// covers ADR 029 (Explicit use), STD-REACT-012
test("[TC-UI-1096-10] the list follows a skill assigned or taken off while the chat is open", async ({ page }) => {
  const { url, pip, api, addSkill, release } = await hubWithSkill();
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  const composer = composerOf(page);
  await composer.fill("/");
  await expect(pickerOf(page)).toContainText("/release-steps");

  await addSkill("review-notes");
  await expect(pickerOf(page)).toContainText("/review-notes");
  await api("DELETE", `/skills/assignments/${release}`);
  await expect(pickerOf(page)).not.toContainText("/release-steps");
  await expect(pickerOf(page)).toContainText("/review-notes");
});

// covers ADR 029 (Explicit use)
test("[TC-UI-1096-11] a long list scrolls inside its own space and keeps the highlighted skill in view", async ({
  page,
}) => {
  const names = Array.from({ length: 30 }, (_, index) => `step-${String(index).padStart(2, "0")}`);
  const { url, pip } = await hubWithSkill(names);
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.goto(`${url}/#/hobs/${pip.id}/new`);
  const composer = composerOf(page);
  await composer.fill("/");
  const picker = pickerOf(page);
  await expect(picker.getByRole("listitem")).toHaveCount(31);
  const box = await picker.boundingBox();
  expect(box?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(640 / 2);
  // The composer stays on screen under it.
  await expect(composer).toBeInViewport();

  // ↑ from the first skill goes to the last, which scrolls into view.
  await composer.press("ArrowUp");
  const last = picker.getByRole("button", { name: /step-29/ });
  await expect(last).toHaveAttribute("aria-current", "true");
  await expect(last).toBeInViewport();
});
