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
  readonly configVersion: number;
  readonly summonedBy: string | null;
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

// covers AG-002
test("[TC-AG-405-05] renaming a hob from its profile saves a new version, says you summoned it, and follows a rename made elsewhere", async ({
  page,
  scan,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
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
    instructions: "Write short answers.",
  });
  expect(pip.summonedBy).toBeNull();

  await page.goto(`${current.url}/#/hobs/${pip.id}/profile`);
  const profile = page.getByRole("main", { name: "Pip's profile" });
  await expect(profile.getByRole("heading", { level: 1, name: "Pip" })).toBeVisible();
  await expect(profile.getByText(/^Works on the hub · Summoned by you on \w+ \d+ · Version 1$/)).toBeVisible();

  await profile.getByRole("button", { name: "Change name or look" }).click();
  const name = profile.getByRole("textbox", { name: "Name" });
  await expect(
    profile.getByText("The new name shows everywhere, past chats included. Other hobs learn it from its next reply."),
  ).toBeVisible();
  await scan();

  // A blank name cannot be saved, as on Summon.
  await name.fill("   ");
  await expect(profile.getByText("Give the hob a name.")).toBeVisible();
  await expect(profile.getByRole("button", { name: "Save changes" })).toBeDisabled();

  // Spaces around the name are dropped, as on Summon.
  await name.fill("  Bramble ");
  await expect(page.getByText("1 change not saved yet")).toBeVisible();
  await profile.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText(/^Saved\. Bramble's next reply uses the new settings/)).toBeVisible();
  const renamed = page.getByRole("main", { name: "Bramble's profile" });
  await expect(renamed.getByRole("heading", { level: 1, name: "Bramble" })).toBeVisible();
  await expect(renamed.getByText(/ · Summoned by you on \w+ \d+ · Version 2$/)).toBeVisible();
  await scan();

  // A rename made elsewhere reaches the open profile without a reload.
  await api(current, "PATCH", `/api/agents/${pip.id}`, { name: "Quill" });
  const elsewhere = page.getByRole("main", { name: "Quill's profile" });
  await expect(elsewhere.getByRole("heading", { level: 1, name: "Quill" })).toBeVisible();
  await expect(elsewhere.getByText(/ · Version 3$/)).toBeVisible();
  await expect(elsewhere.getByRole("textbox", { name: "Name" })).toHaveValue("Quill");

  const [saved] = await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents");
  expect(saved).toMatchObject({ name: "Quill", configVersion: 3, summonedBy: null });
});
