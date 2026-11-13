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
  readonly name: string;
  readonly goodAt: string | null;
  readonly instructions: string;
  readonly configVersion: number;
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

/** A hub past onboarding, with Claude Code connected. */
const readyHub = async () => {
  const current = await startHub(dataDir);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  return current;
};

const ASSISTANT_CHORES =
  "Help me with everyday questions and small chores. Keep answers short and ask when something is unclear.";
const RESEARCHER_CHORES = "Look things up for me and answer with a short summary. Link every source you used.";

// covers AG-001
test("[TC-AG-1232-04] Summon fills good at from the chores until you write your own, and the hob is summoned with it", async ({
  page,
  scan,
}) => {
  hub = await readyHub();
  await page.goto(`${hub.url}/#/summon`);
  await expect(page.getByRole("heading", { name: "What should your new hob help you with?" })).toBeVisible();

  const roles = page.getByRole("group", { name: "Role" });
  const chores = page.getByRole("textbox", { name: "What it should do, in your words" });
  const goodAt = page.getByRole("textbox", { name: "Good at" });
  await expect(goodAt).toHaveValue(ASSISTANT_CHORES);
  await expect(goodAt).toHaveAccessibleDescription(/Other hobs read this to know when to come to this hob/);
  await expect(goodAt).toHaveAccessibleDescription(/It never changes how it behaves/);
  await expect(goodAt).toHaveAccessibleDescription(/Filled in from the chores/);
  await scan();

  // Another role, or other chores, fill it again while it is not yours.
  await roles.getByRole("radio", { name: /^Researcher/ }).check({ force: true });
  await expect(goodAt).toHaveValue(RESEARCHER_CHORES);
  await chores.fill("Find papers on soil.\n\nSum them up.");
  await expect(goodAt).toHaveValue("Find papers on soil. Sum them up.");

  // Once you write it, a new role or new chores keep your words.
  await goodAt.fill("Soil science papers");
  await expect(goodAt).not.toHaveAccessibleDescription(/Filled in from/);
  await roles.getByRole("radio", { name: /^Writer/ }).check({ force: true });
  await chores.fill("Write the newsletter.");
  await expect(goodAt).toHaveValue("Soil science papers");

  await page.getByRole("button", { name: "Next: name and look" }).click();
  await page.getByRole("textbox", { name: "Hob name" }).fill("Fern");
  await page.getByRole("button", { name: "Next: check and summon" }).click();
  await page.getByRole("button", { name: "Summon Fern" }).click();
  await expect(page.getByRole("heading", { name: "Fern is here!" })).toBeVisible();

  const hobs = await api<ReadonlyArray<Hob>>(hub, "GET", "/api/agents");
  expect(hobs.find((h) => h.name === "Fern")).toMatchObject({
    goodAt: "Soil science papers",
    instructions: "Your chores, in the user's words:\nWrite the newsletter.",
    configVersion: 1,
  });
});

// covers AG-002
test("[TC-AG-1232-05] editing good at in the profile saves a new version that the header shows, apart from the instructions", async ({
  page,
  scan,
}) => {
  const current = await readyHub();
  hub = current;
  const pip = await api<Hob>(current, "POST", "/api/agents", {
    name: "Pip",
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
    instructions: "Your chores, in the user's words:\nWrite the launch email.",
  });
  expect(pip.goodAt).toBe("Write the launch email.");

  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  const profile = page.getByRole("main", { name: "Pip's profile" });
  const header = profile.locator("header");
  const goodAt = profile.getByRole("textbox", { name: "Good at" });
  const instructions = profile.getByRole("textbox", { name: "What Pip should do" });
  await expect(goodAt).toHaveValue("Write the launch email.");
  await expect(goodAt).toHaveAccessibleDescription(
    /Other hobs read this to know when to come to Pip\. It never changes how Pip behaves\./,
  );
  await expect(header).toContainText("Write the launch email.");
  await scan();

  await goodAt.fill("  Launch emails  and newsletters ");
  await expect(page.getByText("1 change not saved yet")).toBeVisible();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Pip gets this from its next turn/)).toBeVisible();
  await expect(page.getByText(/· Version 2$/)).toBeVisible();
  await expect(header).toContainText("Launch emails and newsletters");
  await page.reload();
  await expect(goodAt).toHaveValue("Launch emails and newsletters");

  // Changing the instructions leaves good at as it is.
  await instructions.fill("Your chores, in the user's words:\nWrite poems.");
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/· Version 3$/)).toBeVisible();
  await expect(goodAt).toHaveValue("Launch emails and newsletters");

  // Clearing it saves none, and the header drops it.
  await goodAt.fill("");
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/· Version 4$/)).toBeVisible();
  await expect(header).not.toContainText("Launch emails");

  const [saved] = await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents");
  expect(saved).toMatchObject({
    goodAt: null,
    instructions: "Your chores, in the user's words:\nWrite poems.",
    configVersion: 4,
  });
});
