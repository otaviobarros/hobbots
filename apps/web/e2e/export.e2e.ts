import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";
let saved = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  saved = realpathSync(mkdtempSync(join(tmpdir(), "hobbots-e2e-export-")));
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(saved, { recursive: true, force: true });
});

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}/api${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A token you might paste into a message: the export never holds it. */
const TOKEN = `ghp_${"x7Y8".repeat(9)}`;

/** A finished setup whose hobs work in `project`, with Pip and one finished thread that holds a token. */
const pipWithThread = async (current: Hub, project: string) => {
  await api(current, "PATCH", "/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    approvedFolders: [project],
  });
  const pip = await api<{ id: string }>(current, "POST", "/agents", {
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
    instructions: "",
  });
  const thread = await api<{ id: string }>(current, "POST", `/agents/${pip.id}/threads`);
  await api(current, "POST", `/threads/${thread.id}/messages`, { content: `Tagline ideas, with ${TOKEN}` });
  await expect
    .poll(async () =>
      (await api<Array<{ status: string }>>(current, "GET", `/threads/${thread.id}/messages`)).map((m) => m.status),
    )
    .toEqual(["complete", "complete"]);
  return { pip: pip.id, thread: thread.id };
};

/** Every file's text in the one export folder inside `folder`. */
const exported = (folder: string) => {
  const [only] = readdirSync(folder);
  if (only === undefined) throw new Error(`No export in ${folder}`);
  const root = join(folder, only);
  const files = readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
  return {
    root,
    paths: files.map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1)).sort(),
    text: files.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8")).join("\n"),
  };
};

// covers OP-003, UX-005
test("[TC-OP-045] Settings › Export saves a hob's export as a folder that opens without Hobbots, never inside a hob's folder", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  const project = join(saved, "project");
  mkdirSync(project);
  await pipWithThread(hub, project);
  const out = join(saved, "out");
  mkdirSync(out);

  await page.goto(`${hub.url}/#/settings/data`);
  await page.getByRole("region", { name: "Backups" }).getByRole("button", { name: "Export as files" }).click();
  const section = page.getByRole("region", { name: "Export" });
  await section.getByRole("radio", { name: "One hob" }).check();
  await expect(section.getByRole("combobox", { name: "Hob" })).toHaveValue(/.+/);

  // A folder hobs work in is refused, and nothing is written there.
  const destination = section.getByRole("textbox", { name: "Save in" });
  await destination.fill(project);
  await section.getByRole("button", { name: "Export" }).click();
  await expect(section.getByRole("alert")).toContainText("a folder hobs work in");
  expect(readdirSync(project)).toEqual([]);

  await destination.fill(out);
  await section.getByRole("button", { name: "Export" }).click();
  await expect(section.getByRole("status")).toContainText(`Saved to ${join(out, "Hobbots export Pip")}`);

  const { paths, text } = exported(out);
  expect(paths).toEqual([
    "README.md",
    "export.json",
    expect.stringMatching(/^threads\/\d{4}-\d{2}-\d{2} Tagline ideas/),
  ]);
  expect(text).toContain("Tagline ideas");
  expect(text).toContain("[redacted: GitHub token]");
  expect(text).not.toContain(TOKEN);
});

// covers OP-003
test("[TC-OP-046] a thread's menu and a hob's profile export just that thread or hob", async ({ page }) => {
  hub = await startHub(dataDir);
  const project = join(saved, "project");
  mkdirSync(project);
  const { pip, thread } = await pipWithThread(hub, project);
  const fromThread = join(saved, "thread");
  const fromHob = join(saved, "hob");
  mkdirSync(fromThread);
  mkdirSync(fromHob);

  await page.goto(`${hub.url}/#/hobs/${pip}/threads/${thread}`);
  await page.getByRole("button", { name: "More for this chat" }).click();
  await page.getByRole("menuitem", { name: "Export thread…" }).click();
  const dialog = page.getByRole("dialog", { name: /^Export “Tagline ideas/ });
  await dialog.getByRole("textbox", { name: "Save in" }).fill(fromThread);
  await dialog.getByRole("button", { name: "Export" }).click();
  await expect(dialog.getByRole("status")).toContainText("Saved to");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  const threadExport = exported(fromThread);
  expect(JSON.parse(readFileSync(join(threadExport.root, "export.json"), "utf8")).scope).toEqual({
    _tag: "Thread",
    threadId: thread,
  });

  await page.goto(`${hub.url}/#/hobs/${pip}/profile`);
  await page.getByRole("button", { name: "More actions for Pip" }).click();
  await page.getByRole("button", { name: "Export hob…" }).click();
  const hobDialog = page.getByRole("dialog", { name: "Export Pip" });
  await hobDialog.getByRole("textbox", { name: "Save in" }).fill(fromHob);
  await hobDialog.getByRole("button", { name: "Export" }).click();
  await expect(hobDialog.getByRole("status")).toContainText("Saved to");
  const hobExport = exported(fromHob);
  expect(existsSync(join(hobExport.root, "README.md"))).toBe(true);
  expect(JSON.parse(readFileSync(join(hobExport.root, "export.json"), "utf8")).scope).toEqual({
    _tag: "Hob",
    agentId: pip,
  });
});
