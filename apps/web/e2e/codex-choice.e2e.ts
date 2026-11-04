import type { Page } from "@playwright/test";
import {
  emptyDataDir,
  expect,
  fakeCodexAt,
  type Hub,
  removeDataDir,
  signedInClaudeCode,
  signedOutClaudeCode,
  startHub,
  test,
} from "./hub.ts";

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
  readonly runtime: string;
  readonly model: string | null;
  readonly effort: string | null;
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

const hobNamed = async (current: Hub, name: string): Promise<Hob | undefined> =>
  (await api<ReadonlyArray<Hob>>(current, "GET", "/api/agents")).find((hob) => hob.name === name);

/** A hub past onboarding, on the real Claude Code and Codex adapters, with Codex not installed. */
const finishedHub = async (env: Record<string, string>) => {
  const current = await startHub(dataDir, env);
  await api(current, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code", "codex"] });
  return current;
};

/** Walks a new installation to the providers step. */
const openProviders = async (page: Page, current: Hub) => {
  await page.goto(current.url);
  await page.getByRole("link", { name: "Get started" }).click();
  await page.getByRole("link", { name: /Run Hobbots on this computer/ }).click();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Which AI do you already use?" })).toBeVisible();
};

// covers AG-005, OP-001, RT-001
test("[TC-UX-080] onboarding shows a missing Codex with its fix, and a connected Codex alone is enough for the first hob", async ({
  page,
}) => {
  hub = await startHub(dataDir, { HOBBOTS_RUNTIME: "claude", HOBBOTS_CLAUDE_EXECUTABLE: signedOutClaudeCode(dataDir) });
  await openProviders(page, hub);

  // Not installed: Codex says so, links to OpenAI's install guide, and nothing can continue yet.
  const codex = page.getByRole("region", { name: "Codex" });
  await expect(codex.getByText("Not found", { exact: true })).toBeVisible();
  await expect(codex.getByText(/Codex was not found or could not start/)).toBeVisible();
  await expect(codex.getByRole("link", { name: "Install guide" })).toHaveAttribute(
    "href",
    "https://developers.openai.com/codex/cli",
  );
  await expect(page.getByRole("button", { name: "Continue" })).toHaveAttribute("aria-disabled", "true");

  // Installed and signed in with ChatGPT, Check again finds it without a restart.
  fakeCodexAt(dataDir, "ready");
  await codex.getByRole("button", { name: "Check again" }).click();
  await expect(codex.getByText("Found", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Connect Codex" }).click();
  await expect(codex.getByText("✓ Connected")).toBeVisible();
  await expect(codex.getByText("Your ChatGPT plan", { exact: true })).toBeVisible();
  // Claude Code is still signed out: Codex on its own is enough to continue.
  await expect(page.getByText("1 provider connected")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // The first hob offers the connected provider, with Codex's own models and efforts.
  await expect(page.getByRole("heading", { name: "Meet your first hob" })).toBeVisible();
  const providers = page.getByRole("group", { name: "Provider" });
  await expect(providers.getByRole("radio", { name: "Codex", exact: true })).toBeChecked();
  await expect(providers.getByRole("radio", { name: /Claude/ })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /GPT-5\.5/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Medium" })).toBeChecked();
  await expect(page.getByText("Codex · GPT-5.5 · medium effort")).toBeVisible();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Tinker");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "How much should Tinker ask first?" })).toBeVisible();
  await expect(page.getByText("Codex connected")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  // The last step names the provider the hob thinks with.
  await expect(page.getByText(/^Tinker .* · thinks with Codex GPT-5\.5$/)).toBeVisible();
  await page.getByRole("button", { name: "Summon Tinker" }).click();
  await expect(page.getByRole("heading", { name: "Tinker has arrived!" })).toBeVisible();

  expect(await hobNamed(hub, "Tinker")).toMatchObject({ runtime: "codex", model: "gpt-5.5", effort: "medium" });
});

// covers AG-001, AG-005, RT-001
test("[TC-UX-081] Summon shows a missing, signed-out or outdated Codex as unavailable with its fix, and summons a hob on a ready one", async ({
  page,
}) => {
  hub = await finishedHub({ HOBBOTS_RUNTIME: "claude", HOBBOTS_CLAUDE_EXECUTABLE: signedInClaudeCode(dataDir) });
  await page.goto(`${hub.url}/#/summon?step=look`);
  await page.getByRole("textbox", { name: "Hob name" }).fill("Tinker");
  await page.getByRole("button", { name: "Next: check and summon" }).click();
  await expect(page.getByRole("heading", { name: "Ready to summon Tinker?" })).toBeVisible();

  const providers = page.getByRole("group", { name: "Provider" });
  const status = page.getByRole("status", { name: /^Codex:/ });
  await expect(providers.getByRole("radio", { name: "Claude", exact: true })).toBeChecked();

  // Not installed: it cannot be picked, and says how to install it.
  await expect(providers.getByRole("radio", { name: "Codex, unavailable" })).toBeDisabled();
  await expect(status.getByText(/Codex was not found or could not start/)).toBeVisible();
  await expect(status.getByRole("link", { name: "Install guide" })).toBeVisible();

  // Signed out, then outdated: still unavailable, each with its own fix, checked again without a restart.
  fakeCodexAt(dataDir, "signedOut");
  await status.getByRole("button", { name: "Check again" }).click();
  await expect(providers.getByRole("radio", { name: "Codex, signed out" })).toBeDisabled();
  await expect(status.getByText("codex login")).toBeVisible();
  fakeCodexAt(dataDir, "outdated");
  await status.getByRole("button", { name: "Check again" }).click();
  await expect(providers.getByRole("radio", { name: "Codex, outdated" })).toBeDisabled();
  await expect(status.getByText(/older than Hobbots supports/)).toBeVisible();
  await expect(providers.getByRole("radio", { name: "Claude", exact: true })).toBeChecked();

  // Ready: Codex can be picked, and brings its own models and efforts.
  fakeCodexAt(dataDir, "ready");
  await status.getByRole("button", { name: "Check again" }).click();
  await expect(status).toBeHidden();
  // The model and effort open one click further.
  await providers.getByRole("radio", { name: "Codex", exact: true }).check({ force: true });
  await page.getByRole("button", { name: /^Model and effort: Codex · GPT-5\.5/ }).click();
  await expect(page.getByRole("radio", { name: /GPT-5\.5/ })).toBeChecked();
  await page.getByRole("radio", { name: "High" }).check({ force: true });
  await page.getByRole("button", { name: "Fewer options" }).click();
  await expect(page.getByRole("button", { name: "Model and effort: Codex · GPT-5.5 · high effort" })).toBeVisible();

  await page.getByRole("button", { name: "Summon Tinker" }).click();
  await expect(page).toHaveURL(/#\/hobs\/[^/]+\/new$/);
  expect(await hobNamed(hub, "Tinker")).toMatchObject({ runtime: "codex", model: "gpt-5.5", effort: "high" });
});

// covers AG-002, AG-005, RT-001
test("[TC-UX-082] the profile moves a hob to Codex with its model and effort, and its next reply thinks with Codex", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<Hob>(hub, "POST", "/api/agents", {
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
    effort: "max",
    instructions: "",
  });
  await page.goto(`${hub.url}/#/hobs/${pip.id}/profile`);
  await expect(page.getByRole("heading", { name: "Pip", exact: true })).toBeVisible();

  const providers = page.getByRole("group", { name: "Provider" });
  await expect(providers.getByRole("radio", { name: "Claude", exact: true })).toBeChecked();
  await providers.getByRole("radio", { name: "Codex", exact: true }).check({ force: true });
  // Codex's model takes no Max effort, so the effort settles on the model's own.
  await expect(page.getByRole("radio", { name: /Fake Coder/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Medium" })).toBeChecked();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect
    .poll(async () => hobNamed(hub as Hub, "Pip"))
    .toMatchObject({
      runtime: "codex",
      model: "fake-coder",
      effort: "medium",
    });

  await page.goto(`${hub.url}/#/hobs/${pip.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill("hello");
  await expect(page.getByRole("button", { name: "Send" })).toBeEnabled();
  await composer.press("Enter");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByText("Echo: hello")).toBeVisible();
  await expect(page.getByRole("button", { name: /^Thinking with Codex · Fake Coder/ })).toBeVisible();
});

// covers AG-002, AG-005
test("[TC-UX-083] the profile shows a signed-out Codex as unavailable with its fix, and keeps the hob on Claude", async ({
  page,
}) => {
  hub = await startHub(dataDir, { HOBBOTS_FAKE_CODEX_AVAILABILITY: "signedOut" });
  await api(hub, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<Hob>(hub, "POST", "/api/agents", {
    name: "Pip",
    role: null,
    roleTitle: "Writer",
    sigil: "writer",
    hat: null,
    tool: null,
    lookSeed: 4821,
    lookColor: "violet",
    runtime: "claude-code",
    model: "fake-thinker",
    effort: "medium",
    instructions: "",
  });
  await page.goto(`${hub.url}/#/hobs/${pip.id}/profile`);

  const providers = page.getByRole("group", { name: "Provider" });
  await expect(providers.getByRole("radio", { name: "Claude", exact: true })).toBeChecked();
  await expect(providers.getByRole("radio", { name: "Codex, signed out" })).toBeDisabled();
  await expect(page.getByRole("status", { name: /^Codex:/ }).getByText("codex login")).toBeVisible();
  await expect(page.getByRole("radio", { name: /Fake Thinker/ })).toBeChecked();
});

// covers OP-001
test("[TC-UX-084] connecting a second provider waits for the first, so both stay connected", async ({ page }) => {
  hub = await startHub(dataDir);
  await openProviders(page, hub);

  // Hold the first save back, so a second click lands while it is on its way.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let saves = 0;
  await page.route("**/api/setup", async (route) => {
    if (route.request().method() === "PATCH" && saves++ === 0) await held;
    await route.continue();
  });

  await page.getByRole("button", { name: "Connect Claude" }).click();
  await expect(page.getByRole("region", { name: "Claude" }).getByText("Knocking on the door")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Codex" })).toBeDisabled();
  release();
  await expect(page.getByRole("region", { name: "Claude" }).getByText("✓ Connected")).toBeVisible();

  await page.getByRole("button", { name: "Connect Codex" }).click();
  await expect(page.getByRole("region", { name: "Codex" }).getByText("✓ Connected")).toBeVisible();
  await expect(page.getByText("2 providers connected")).toBeVisible();
  expect(await api<{ connectedProviders: ReadonlyArray<string> }>(hub, "GET", "/api/setup")).toMatchObject({
    connectedProviders: ["claude-code", "codex"],
  });
});
