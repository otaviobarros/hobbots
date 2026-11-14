import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type GitHubIssuePlan, githubIssueSummary } from "@hobbots/domain";
import { emptyDataDir, expect, type Hub, removeDataDir, startHub, test } from "./hub.ts";

let hub: Hub | undefined;
let dataDir = "";
let shared = "";

test.beforeEach(() => {
  dataDir = emptyDataDir();
  shared = realpathSync(mkdtempSync(`${dataDir}-shared-`));
});

test.afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  removeDataDir(dataDir);
  rmSync(shared, { recursive: true, force: true });
});

const api = async <A>(current: Hub, method: string, path: string, body?: unknown): Promise<A> => {
  const response = await fetch(`${current.url}${path}`, {
    method,
    headers: { ...current.headers, ...(body !== undefined && { "content-type": "application/json" }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as A;
};

/** A sub-issue as the hub plans it once GitHub confirmed the label and the parent (#1350). */
const plan = (folder: string): GitHubIssuePlan => ({
  repository: "octo/shop",
  folder,
  title: "Checkout drops the coupon",
  body: "Steps: add a coupon, then pay. The total ignores it.",
  labels: ["bug"],
  parent: { number: 12, title: "Black Friday checkout" },
  actingAs: { _tag: "You", login: "octocat" },
});

/**
 * Turns the request Pip's turn is waiting on into an issue request, as the hub records one: opening an
 * issue needs a real GitHub repository, so the test writes the card's fields the way the hub would.
 */
const recordIssueRequest = (folder: string) => {
  const issue = plan(folder);
  const database = new DatabaseSync(join(dataDir, "hobbots.sqlite"));
  database.exec("PRAGMA busy_timeout = 5000");
  database
    .prepare(
      `UPDATE approval_requests SET tool = 'github_open_issue', operation = 'github.open-issue', targets = ?,
         arguments = ?, label = ?, reason = 'The safety preset asks before opening issues.', once_only = 0, grantable = 1, rules = ? WHERE state = 'pending'`,
    )
    .run(
      JSON.stringify(["github.com/octo/shop #12"]),
      JSON.stringify({ ...issue, summary: githubIssueSummary(issue) }),
      "Opening a sub-issue under #12 as you (@octocat)",
      JSON.stringify([
        {
          _tag: "CharmSite",
          charm: "github",
          operation: "github.open-issue",
          cwd: folder,
          site: { repository: "octo/shop" },
        },
      ]),
    );
  database.close();
};

// covers PE-003, ADR 020 (Amendment: opening issues)
test("[TC-PE-1350-07] the card for an issue shows its title, labels, parent and body, who opens it, and what it risks", async ({
  page,
}) => {
  const current = await startHub(dataDir);
  hub = current;
  await api(current, "PATCH", "/api/setup", {
    completed: true,
    connectedProviders: ["claude-code"],
    safetyPreset: "balanced",
    approvedFolders: [shared],
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
  await page.goto(`${current.url}/#/hobs/${pip.id}/chat`);
  const composer = page.getByRole("textbox", { name: /^Message Pip/ });
  // Balanced asks before a push, so Pip's turn waits on a request the test makes an issue's.
  await composer.fill("File it\nfake:tool Bash git push origin feature");
  await composer.press("Enter");
  await expect(page.getByRole("region", { name: "Pip asks permission" })).toBeVisible();
  recordIssueRequest(shared);
  await page.reload();

  const card = page.getByRole("region", { name: "Pip asks permission" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Pip asks to open issues");
  await expect(card).toContainText("The safety preset asks before opening issues.");
  const exact = card.locator("code");
  await expect(exact).toContainText("Open a sub-issue in octo/shop under #12: Black Friday checkout");
  await expect(exact).toContainText("Title: Checkout drops the coupon");
  await expect(exact).toContainText("Labels: bug");
  await expect(exact).toContainText("Steps: add a coupon, then pay. The total ignores it.");
  await expect(exact).toContainText("As you (@octocat).");
  await expect(card).toContainText("github.com/octo/shop #12");
  await expect(card).toContainText("Opens an issue others can see at once. You can close or edit it.");
  // Not high risk: no confirmation box, and Always offers this repository.
  await expect(card.getByRole("checkbox")).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Always for this repository" })).toBeVisible();
});
