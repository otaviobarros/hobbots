import { randomUUID } from "node:crypto";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
});

/** A hub past setup with one hob, Wick. */
const hubWithWick = async () => {
  dataDir = emptyDataDir();
  hub = await startHub(dataDir);
  const api = async (method: string, path: string, body: unknown) => {
    const response = await fetch(`${hub?.url}/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...hub?.headers },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json() as Promise<{ readonly id: string }>;
  };
  await api("PATCH", "/setup", { completed: true, connectedProviders: ["claude-code"] });
  const wick = await api("POST", "/agents", {
    id: randomUUID(),
    name: "Wick",
    role: null,
    roleTitle: "Cartographer",
    sigil: "assistant",
    hat: null,
    tool: null,
    lookSeed: 1337,
    lookColor: "moss",
    runtime: "claude-code",
    model: null,
    effort: null,
    instructions: "",
  });
  return { url: hub.url, wickId: wick.id };
};

const AGENTS = /\/api\/agents(\?|$)/;

// covers STD-REACT-002
test("[TC-UX-152] an address with params the page does not know opens the page on its defaults", async ({ page }) => {
  const { url } = await hubWithWick();
  const failed = page.getByRole("heading", { name: "This page could not open" });

  await page.goto(`${url}/#/hobs?show=everything`);
  await expect(page.getByRole("main", { name: "Your hobs" }).getByText("Wick")).toBeVisible();
  await expect(failed).toHaveCount(0);

  await page.goto(`${url}/#/usage?days=99`);
  await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toBeVisible();
  await expect(failed).toHaveCount(0);

  await page.goto(`${url}/#/inbox?tab=nowhere`);
  await expect(page.getByRole("heading", { name: "Inbox", level: 1 })).toBeVisible();
  await expect(failed).toHaveCount(0);
});

// covers STD-REACT-014, STD-UI-009
test("[TC-UX-153] a page that cannot load says why in plain words, keeps the sidebar and opens on Try again", async ({
  page,
}) => {
  const { url, wickId } = await hubWithWick();
  await page.route(AGENTS, (route) => route.abort("connectionrefused"));
  await page.goto(`${url}/#/hobs/${wickId}/arrived`);

  const screen = page.getByRole("alert").filter({ hasText: "This page could not open" });
  await expect(screen.getByRole("heading", { name: "This page could not open", level: 1 })).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen).toContainText("Hobbots cannot reach the hub right now.");
  await expect(screen.getByRole("link", { name: "Go to Your hobs" })).toBeVisible();
  // The rest of the app still works around it.
  await expect(page.getByRole("navigation").first()).toBeVisible();

  await page.unroute(AGENTS);
  await screen.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "This page could not open" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Wick is here!", level: 1 })).toBeVisible();
});
