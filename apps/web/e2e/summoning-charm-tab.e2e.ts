import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

interface Hob {
  readonly id: string;
}

interface Permissions {
  readonly policy: {
    readonly charms?: {
      readonly granted?: ReadonlyArray<string>;
      readonly withheld?: ReadonlyArray<string>;
      readonly overrides?: Readonly<Record<string, string>>;
      readonly summoning?: { readonly summoned: boolean; readonly hobs: ReadonlyArray<string>; readonly self: boolean };
    };
  };
}

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

const summon = (current: Hub, name: string) =>
  api<Hob>(current, "POST", "/api/agents", {
    name,
    role: "writer",
    roleTitle: "Writer",
    sigil: "writer",
    hat: "pointed",
    tool: "quill",
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "Write short answers.",
  });

const charmsOf = async (current: Hub, hob: Hob) =>
  (await api<Permissions>(current, "GET", `/api/agents/${hob.id}/permissions`)).policy.charms;

// covers AG-002, PE-002
test("[TC-AG-410-01] grants Summoning on a hob's Charms tab and sets its scope and field answers", async ({
  page,
  scan,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const chief = await summon(current, "Chief");
  await summon(current, "Pip");

  await page.goto(`${current.url}/#/hobs/${chief.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  const card = page.getByRole("region", { name: "Summoning Charm" });
  const grant = card.getByRole("switch", { name: "Let Chief summon and manage hobs" });
  await expect(grant).not.toBeChecked();
  await expect(card.getByText("Chief can't summon or change hobs.", { exact: false })).toBeVisible();

  // Granting it writes the defaults: summoning asks, the name is allowed.
  await grant.click();
  await expect(grant).toBeChecked();
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  const summonRow = card.getByRole("radiogroup", { name: "Summon new hobs" });
  await expect(summonRow.getByRole("radio", { name: "Ask" })).toBeChecked();
  await expect(card.getByRole("radiogroup", { name: "Name" }).getByRole("radio", { name: "Allow" })).toBeChecked();
  await expect.poll(async () => (await charmsOf(current, chief))?.granted).toContain("summoning");
  await scan();

  // A field answer and the scope are saved at once, so the next call runs under them.
  await card.getByRole("radiogroup", { name: "AI and model" }).getByText("Never", { exact: true }).click();
  await expect.poll(async () => (await charmsOf(current, chief))?.overrides?.["summoning.brain"]).toBe("deny");
  await card.getByRole("switch", { name: "Hobs it summoned" }).click();
  await expect.poll(async () => (await charmsOf(current, chief))?.summoning?.summoned).toBe(false);

  // A picked hob shows by name and can be taken off again.
  await card.getByRole("button", { name: "Add a hob" }).click();
  await page.getByRole("menuitem", { name: "Pip" }).click();
  await expect(card.getByRole("list", { name: "Hobs you picked" })).toContainText("Pip");
  await expect.poll(async () => (await charmsOf(current, chief))?.summoning?.hobs.length).toBe(1);
  await card.getByRole("button", { name: "Remove Pip" }).click();
  await expect(card.getByRole("list", { name: "Hobs you picked" })).toBeHidden();

  // "Can manage itself" shows its own fields, each asking first.
  await card.getByRole("switch", { name: "Can manage itself" }).click();
  await expect(card.getByRole("heading", { name: "Chief changing itself" })).toBeVisible();
  await expect(
    card.getByRole("radiogroup", { name: "Its instructions" }).getByRole("radio", { name: "Ask" }),
  ).toBeChecked();

  // A field set to Allow outside the tab, as "Always allow" on a card does, shows as Allow here.
  const overrides = (await charmsOf(current, chief))?.overrides ?? {};
  await api(current, "PATCH", `/api/agents/${chief.id}/permissions`, {
    charms: { overrides: { ...overrides, "summoning.summon": "allow" } },
  });
  await page.reload();
  await page.getByRole("tab", { name: "Charms" }).click();
  await expect(summonRow.getByRole("radio", { name: "Allow" })).toBeChecked();

  // Turning it off takes the Charm away.
  await grant.click();
  await expect.poll(async () => (await charmsOf(current, chief))?.granted).not.toContain("summoning");
});

// covers AG-002, PE-002
test("[TC-AG-410-02] Summoning for every hob reaches the hobs you made, and a hob's own tab can take it away", async ({
  page,
  scan,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await summon(current, "Pip");

  await page.goto(`${current.url}/#/settings/connections?tab=charms`);
  const every = page.getByRole("region", { name: "Summoning for every hob" });
  await every.getByRole("switch", { name: "Summoning for every hob" }).click();
  await expect(every.getByRole("radiogroup", { name: "Role" }).getByRole("radio", { name: "Ask" })).toBeChecked();
  await every.getByRole("radiogroup", { name: "Name" }).getByText("Ask", { exact: true }).click();
  await expect
    .poll(async () => (await api<{ summoningForEveryHob: unknown }>(current, "GET", "/api/setup")).summoningForEveryHob)
    .toMatchObject({ overrides: { "summoning.name": "ask" } });
  await scan();

  // Pip has it from Settings, with Settings' answers.
  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  const card = page.getByRole("region", { name: "Summoning Charm" });
  await expect(card.getByText("On · for every hob")).toBeVisible();
  await expect(card.getByText("Pip has it from Summoning for every hob.", { exact: false })).toBeVisible();
  await expect(card.getByRole("radiogroup", { name: "Name" }).getByRole("radio", { name: "Ask" })).toBeChecked();

  // A change here gives Pip its own grant, starting from Settings' answers.
  await card.getByRole("radiogroup", { name: "Voice" }).getByText("Never", { exact: true }).click();
  await expect(card.getByText("On", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await charmsOf(current, pip))?.overrides)
    .toMatchObject({
      "summoning.voice": "deny",
      "summoning.name": "ask",
    });

  // Taking it away withholds what Settings gives, so it stays off.
  await card.getByRole("switch", { name: "Let Pip summon and manage hobs" }).click();
  await expect(card.getByText("Off", { exact: true })).toBeVisible();
  await expect.poll(async () => (await charmsOf(current, pip))?.withheld).toContain("summoning");
});

// covers AG-002
test("[TC-AG-410-03] says when your hobs cannot be read for the hobs you pick, and reads them again on Try again", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    summoningForEveryHob: { scope: { summoned: true, hobs: [], self: false }, overrides: {} },
  });
  await summon(current, "Pip");

  // The hob list fails until the stand-in is lifted.
  const list = (url: URL) => url.pathname === "/api/agents";
  await page.route(list, (route) => route.fulfill({ status: 500, body: "" }));
  await page.goto(`${current.url}/#/settings/connections?tab=charms`);
  const every = page.getByRole("region", { name: "Summoning for every hob" });
  // The client asks again a few times before it gives up.
  await expect(every.getByRole("alert")).toContainText("Hobbots could not read your hobs.", { timeout: 20_000 });
  await expect(every.getByRole("button", { name: "Add a hob" })).toBeHidden();

  await page.unroute(list);
  await every.getByRole("button", { name: "Try again" }).click();
  await every.getByRole("button", { name: "Add a hob" }).click();
  await expect(page.getByRole("menuitem", { name: "Pip" })).toBeVisible();
});

// covers AG-002, ADR 034 (Limits for unattended summons)
test("[TC-AG-410-04] shows the live hobs a hob summoned without asking against its caps, and frees a place when one retires", async ({
  page,
}) => {
  const current = await startHub(dataDir, {
    HOBBOTS_MAX_UNATTENDED_SUMMONS_PER_HOB: "2",
    HOBBOTS_MAX_UNATTENDED_SUMMONS_PER_TREE: "5",
  });
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const chief = await summon(current, "Chief");
  // Chief summons without asking you.
  await api(current, "PATCH", `/api/agents/${chief.id}/permissions`, {
    charms: { granted: ["summoning"], overrides: { "summoning.summon": "allow" } },
  });

  await page.goto(`${current.url}/#/hobs/${chief.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  const caps = page.getByRole("region", { name: "Summoned without asking you" });
  await expect(caps).toContainText("0 of 2");
  await expect(caps).toContainText("Up to 5 in each Task tree");

  // A summon that runs without a card takes a place.
  await page.goto(`${current.url}/#/hobs/${chief.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Chief/ });
  await composer.fill(
    `Hire a writer\nfake:hub summoning_summon ${JSON.stringify({ key: "hire-flo", hobs: [{ name: "Flo", role: "writer" }] })}`,
  );
  await composer.press("Enter");
  await expect
    .poll(async () => (await api<ReadonlyArray<{ id: string; name: string }>>(current, "GET", "/api/agents")).length, {
      timeout: 20_000,
    })
    .toBe(2);
  await page.goto(`${current.url}/#/hobs/${chief.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  await expect(caps).toContainText("1 of 2");

  // Retiring it frees its place, and the tab hears of it while it stays open.
  const hobs = await api<ReadonlyArray<{ id: string; name: string }>>(current, "GET", "/api/agents");
  const flo = hobs.find((hob) => hob.name === "Flo");
  if (flo === undefined) throw new Error("Flo was not summoned");
  await api(current, "POST", `/api/agents/${flo.id}/retire`, { activeWork: "finish" });
  await expect(caps).toContainText("0 of 2");
});

// covers AG-002, STD-REACT-015
test("[TC-AG-410-05] says when the caps cannot be read, at first and on a later read, and reads them again on Try again", async ({
  page,
}) => {
  const current = await startHub(dataDir, { HOBBOTS_MAX_UNATTENDED_SUMMONS_PER_HOB: "2" });
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const chief = await summon(current, "Chief");
  await api(current, "PATCH", `/api/agents/${chief.id}/permissions`, { charms: { granted: ["summoning"] } });

  // The caps fail until the stand-in is lifted.
  const capsUrl = (url: URL) => url.pathname === `/api/agents/${chief.id}/summon-caps`;
  const fail = () => page.route(capsUrl, (route) => route.fulfill({ status: 500, body: "" }));
  await page.clock.install();
  await fail();
  await page.goto(`${current.url}/#/hobs/${chief.id}/profile`);
  await page.getByRole("tab", { name: "Charms" }).click();
  const caps = page.getByRole("region", { name: "Summoned without asking you" });
  const failed = caps.getByRole("alert");
  // The client asks again a few times before it gives up.
  await expect(failed).toContainText("Hobbots could not read how many hobs Chief summoned without asking.", {
    timeout: 20_000,
  });
  await expect(caps.getByRole("progressbar")).toBeHidden();

  await page.unroute(capsUrl);
  await caps.getByRole("button", { name: "Try again" }).click();
  await expect(caps).toContainText("0 of 2");
  await expect(failed).toBeHidden();

  // A later read that fails says so under the count it read before, until Try again reads it.
  await fail();
  await page.clock.fastForward("01:00");
  await page.getByRole("tab", { name: "Profile" }).click();
  await page.getByRole("tab", { name: "Charms" }).click();
  await expect(failed).toBeVisible({ timeout: 20_000 });
  await expect(caps).toContainText("0 of 2");
  await page.unroute(capsUrl);
  await caps.getByRole("button", { name: "Try again" }).click();
  await expect(failed).toBeHidden();
  await expect(caps).toContainText("0 of 2");
});
