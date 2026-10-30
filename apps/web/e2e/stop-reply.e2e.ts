import { expect, test } from "@playwright/test";
import { emptyDataDir, type Hub, removeDataDir, startHub } from "./hub.ts";

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

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    ...(body !== undefined && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

// The fake runtime writes one word every 40 ms and takes 600 ms to end a stopped turn.
const LONG_PROMPT = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");

// covers CH-007
test("[TC-CH-005] Stop shows Stopping, then Stopped with the partial reply kept, and a second Stop is harmless", async ({
  page,
}) => {
  hub = await startHub(dataDir);
  await api(hub, "PATCH", "/api/setup", { completed: true, connectedProviders: ["claude-code"] });
  const pip = await api<{ id: string }>(hub, "POST", "/api/agents", {
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

  await page.goto(`${hub.url}/#/hobs/${pip.id}/new`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  await composer.fill(LONG_PROMPT);
  await composer.press("Enter");
  await expect(page.getByText(/Echo: word0 word1 word2/)).toBeVisible();

  const thread = page.url().match(/threads\/([^/?#]+)/)?.[1];
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  await expect(page.getByText("Stopping this reply…")).toBeVisible();
  // Asking again while stopping, as a second client would, changes nothing.
  const again = await fetch(`${hub.url}/api/threads/${thread}/interrupt`, { method: "POST" });
  expect(again.ok).toBe(true);

  await expect(page.getByText("■ You stopped this reply. Pip kept what it wrote so far.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeHidden();

  const messages = await api<ReadonlyArray<{ role: string; content: string; status: string }>>(
    hub,
    "GET",
    `/api/threads/${thread}/messages`,
  );
  const reply = messages.find((m) => m.role === "assistant");
  expect(reply?.status).toBe("stopped");
  expect(reply?.content).toMatch(/^Echo: word0 word1 word2/);
  expect(reply?.content.length).toBeLessThan(`Echo: ${LONG_PROMPT}`.length);
  await expect(page.getByText(reply?.content.trimEnd() ?? "")).toBeVisible();

  // The thread and Pip take the next message as usual.
  await composer.fill("next");
  await composer.press("Enter");
  await expect(page.getByText("Echo: next")).toBeVisible();
});
