import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    headers: { origin: current.url, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

type Reply = {
  readonly id: string;
  readonly role: string;
  readonly steps: ReadonlyArray<{ readonly id: string; readonly state: string }>;
};

/**
 * Records the reply's cut-off step as a GitHub push whose answer was lost, as the Charm does before
 * it sends (ADR 020). Pushing to GitHub needs a real repository, so the test writes the record the
 * way the hub's call records would.
 */
const recordUncertainPush = (agentId: string, threadId: string, messageId: string, stepId: string) => {
  const database = new DatabaseSync(join(dataDir, "hobbots.sqlite"));
  const at = "2026-11-02T09:00:00.000Z";
  database
    .prepare(
      `INSERT INTO charm_calls (agent_id, call_key, attempt, tool, input, site, plan, state, result,
         thread_id, message_id, step_id, created_at, updated_at)
       VALUES (?, 'push-1', 'push-1-a', 'github_push', '{}', 'github.com/octo/shop refs/heads/feat/cart', ?, 'uncertain',
         'GitHub did not answer the push in time.', ?, ?, ?, ?, ?)`,
    )
    .run(
      agentId,
      JSON.stringify({ repository: "octo/shop", remoteBranch: "feat/cart", commit: "abc", appliedText: "Pushed." }),
      threadId,
      messageId,
      stepId,
      at,
      at,
    );
  database.close();
};

// covers EX-003, PE-006
test("[TC-OR-075] an uncertain GitHub push is settled from its step, once, and the step says how", async ({ page }) => {
  const work = realpathSync(mkdtempSync(`${dataDir}-work-`));
  try {
    const current = await startHub(dataDir);
    hub = current;
    await api(current, "PATCH", "/api/setup", {
      completed: true,
      connectedProviders: ["claude-code"],
      safetyPreset: "balanced",
      approvedFolders: [work],
    });
    const pip = await api<{ id: string }>(current, "POST", "/api/agents", {
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
    await page.goto(`${current.url}/#/hobs/${pip.id}/new`);
    const composer = page.getByRole("textbox", { name: /^Message Pip/ });
    await composer.fill(["Ship it", "fake:tool Bash sleep 600"].join("\n"));
    await composer.press("Enter");
    const steps = page.getByRole("list", { name: "Reply steps" });
    await expect(steps.getByRole("button", { name: "Running sleep 600… in progress" })).toBeVisible();

    // The hub stops while the call runs, so its step comes back uncertain; the call is a push.
    const thread = page.url().match(/threads\/([^/?#]+)/)?.[1] ?? "";
    await current.kill();
    hub = await startHub(dataDir);
    const [reply] = (await api<ReadonlyArray<Reply>>(hub, "GET", `/api/threads/${thread}/messages`)).filter(
      (m) => m.role === "assistant",
    );
    const step = reply?.steps.find((each) => each.state === "uncertain");
    if (reply === undefined || step === undefined) throw new Error("expected the reply's cut-off step");
    await hub.stop();
    recordUncertainPush(pip.id, thread, reply.id, step.id);
    hub = await startHub(dataDir);
    await page.reload();

    await expect(steps.getByText(/^Look on GitHub to see whether it went through/)).toBeVisible();
    await steps.getByRole("button", { name: "It went through" }).click();
    await expect(steps.getByRole("status")).toHaveText("Settled: it went through.");
    await expect(steps.getByRole("button", { name: "It did not go through" })).toHaveCount(0);

    // Settled once: a second settlement is refused, and the record says what the user decided.
    const calls = await api<ReadonlyArray<{ state: string; result: string }>>(
      hub,
      "GET",
      `/api/threads/${thread}/charm-calls`,
    );
    expect(calls).toMatchObject([
      { state: "applied", result: expect.stringContaining("settled this call as applied") },
    ]);
    const again = await fetch(`${hub.url}/api/threads/${thread}/messages/${reply.id}/steps/${step.id}/settlement`, {
      method: "POST",
      headers: { origin: hub.url, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "not-sent" }),
    });
    expect(again.status).toBe(409);
    await page.reload();
    await expect(steps.getByRole("status")).toHaveText("Settled: it went through.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
