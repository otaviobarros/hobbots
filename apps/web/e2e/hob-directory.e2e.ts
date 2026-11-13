import type { Page } from "@playwright/test";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

// The hob directory in the browser (ADR 032, #1234): a hob's turn sees the other visible hobs and
// reads one card with read_hob, on the fake runtime, which echoes what its session was told; and the
// Permissions tab sets Read other hobs.

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

interface Hob {
  readonly id: string;
}

/** A hub past setup with Pip, Quill, and Wren hidden from other hobs. */
const hubWithTeam = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const started = hub;
  const api = async <A>(method: string, path: string, body?: unknown): Promise<A> => {
    const response = await fetch(`${started.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...started.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<A>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"], safetyPreset: "balanced" });
  const summon = (name: string, lookSeed: number, fields: object = {}) =>
    api<Hob>("POST", "/agents", {
      name,
      role: "writer",
      roleTitle: "Writer",
      sigil: "writer",
      hat: null,
      tool: null,
      lookSeed,
      lookColor: "moss",
      runtime: "claude-code",
      model: null,
      effort: null,
      instructions: `${name}'s private notes.`,
      ...fields,
    });
  const pip = await summon("Pip", 1234);
  const quill = await summon("Quill", 1235, { goodAt: "Release notes, short and plain." });
  await summon("Wren", 1236, { visibleToHobs: false });
  return { url: started.url, pip, quill, api };
};

/** Sends `lines` to Pip as one message and waits for the reply to end. */
const send = async (page: Page, lines: ReadonlyArray<string>) => {
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(lines.join("\n"));
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "■ Stop" })).toBeHidden({ timeout: 30_000 });
};

// covers ADR 032 (The roster, read_hob)
test("[TC-UX-1234-01] a hob's reply sees the visible hobs and reads one card with its step shown", async ({
  page,
  scan,
}) => {
  const { url, pip } = await hubWithTeam();
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  // The fake answers this with the roster its turn was briefed with.
  await send(page, ["/roster"]);
  const main = page.getByRole("main");
  await expect(main).toContainText("Other hobs on this hub");
  await expect(main).toContainText('good at "Release notes, short and plain."');
  await send(page, ["Who on the team writes release notes?", 'fake:hub read_hob {"hob":"Quill"}']);
  await expect(main).toContainText("read_hob: Hobbots collected this about the other hobs");
  await expect(main).toContainText("Reading a hob's card");
  await expect(main).not.toContainText("Wren");
  await expect(main).not.toContainText("private notes");
  await scan();
});

// covers ADR 032 (Read other hobs, in the policy), PE-001
test("[TC-UX-1234-02] Permissions sets Read other hobs, which is Allow under Balanced, and Never saves as the next version", async ({
  page,
  scan,
}) => {
  const { url, pip, api } = await hubWithTeam();
  await page.goto(`${url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Permissions" }).click();
  const group = page.getByRole("region", { name: "Other hobs" });
  await expect(group).toContainText("Read other hobs");
  await expect(group).toContainText("Never their instructions or work.");
  const read = group.getByRole("radiogroup", { name: "Read other hobs" });
  await expect(read.getByRole("radio", { name: "Allow" })).toBeChecked();
  await scan(group);

  await read.getByText("Never", { exact: true }).click();
  await expect(read.getByRole("radio", { name: "Never" })).toBeChecked();
  await expect
    .poll(
      async () =>
        (await api<{ decisions: Record<string, string> }>("GET", `/agents/${pip.id}/permissions`)).decisions[
          "read-hobs"
        ],
    )
    .toBe("deny");
});

/** Saves the one change on Quill's profile. */
const saveQuill = async (page: Page) => {
  const profile = page.getByRole("main", { name: "Quill's profile" });
  await expect(page.getByText("1 change not saved yet")).toBeVisible();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Quill gets this from its next turn/)).toBeVisible();
};

/** Asks Pip, in its chat, for the roster its turn was told, and reads the reply. */
const pipsRoster = async (page: Page, url: string, pip: Hob) => {
  await page.goto(`${url}/#/hobs/${pip.id}/chat`);
  await send(page, ["/roster"]);
  return page.getByRole("article").last();
};

// covers ADR 032 (Good at, Visible to other hobs, It applies at once), AG-002
test("[TC-UX-1235-01] good at edited and Visible to other hobs turned off and on in a profile reach another hob's next turn", async ({
  page,
  scan,
}) => {
  const { url, pip, quill } = await hubWithTeam();
  await expect(await pipsRoster(page, url, pip)).toContainText('good at "Release notes, short and plain."');
  await scan();

  await page.goto(`${url}/#/hobs/${quill.id}/profile`);
  const profile = page.getByRole("main", { name: "Quill's profile" });
  await expect(profile.getByRole("textbox", { name: "Good at" })).toHaveValue("Release notes, short and plain.");
  await scan();
  await profile.getByRole("textbox", { name: "Good at" }).fill("Changelogs and release notes.");
  await saveQuill(page);
  await scan(profile);
  const edited = await pipsRoster(page, url, pip);
  await expect(edited).toContainText('good at "Changelogs and release notes."');
  await expect(edited).not.toContainText("short and plain");

  await page.goto(`${url}/#/hobs/${quill.id}/profile`);
  await profile
    .getByRole("region", { name: "Other hobs" })
    .getByRole("switch", { name: "Visible to other hobs" })
    .click();
  await saveQuill(page);
  await scan(profile.getByRole("region", { name: "Other hobs" }));
  await expect(await pipsRoster(page, url, pip)).not.toContainText("Quill");

  await page.goto(`${url}/#/hobs/${quill.id}/profile`);
  await profile
    .getByRole("region", { name: "Other hobs" })
    .getByRole("switch", { name: "Visible to other hobs" })
    .click();
  await saveQuill(page);
  await expect(await pipsRoster(page, url, pip)).toContainText('"Quill": "Writer"');
});
