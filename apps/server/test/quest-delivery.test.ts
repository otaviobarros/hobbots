import type { RuntimeKind } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { hub, partyHub, send, treeWhen } from "./party-hub.ts";

// Issue #1181: a lead completed the Quest you asked for while its own result said the page was not
// delivered, and the Quest read done. complete_task now completes a Quest's top Task only when its
// lead says, with delivered: true, that the result delivers everything you asked for. The hub
// checks the call, so it holds for every runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

/** Frodo hands Pip the page, and once Pip's result is in, wraps up the Quest with `wrapUps` in turn. */
const quest = (wrapUps: ReadonlyArray<object>) =>
  send([
    "Explain the Skills feature",
    hub("delegate_task", {
      key: "page",
      hob: "Pip",
      brief: ["Write the Skills explainer", hub("complete_task", { key: "pip", summary: "The page is written" })].join(
        "\n",
      ),
    }),
    hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
    ...wrapUps.map((input) => `fake:then ${hub("complete_task", input)}`),
  ]);

describe.each(RUNTIMES)("a Quest its lead wraps up, on %s", (runtime) => {
  // covers OR-004, EX-002
  it("[TC-OR-660] stays open while its lead does not say it delivered, and completes once it does", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, answers } = party;
    await run(
      quest([
        { key: "unsaid", summary: "The explainer" },
        { key: "short", delivered: false, summary: "The page could not be saved where you asked" },
        { key: "whole", delivered: true, summary: "The explainer is saved where you asked" },
      ]),
    );
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("unsaid")).toContain("Refused (not-delivered)");
    expect(answers.get("unsaid")).toContain("delivered: true");
    expect(answers.get("short")).toContain("Refused (not-delivered)");
    expect(answers.get("short")).toContain("does not deliver everything the user asked for");
    expect(answers.get("whole")).toContain("is complete");
    expect(done.tasks[0]?.result?.summary).toBe("The explainer is saved where you asked");
    expect(done.quests[0]?.state).not.toBe("active");
  }, 30_000);

  // covers OR-004
  it("[TC-OR-661] lets a member complete its own Task without saying it delivered", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, answers } = party;
    await run(quest([{ key: "whole", delivered: true, summary: "The explainer" }]));
    const done = await run(treeWhen((tree) => tree.tasks[0]?.state === "completed"));
    expect(answers.get("pip")).toContain("is complete");
    expect(done.tasks.find((each) => each.parentId !== null)?.state).toBe("completed");
  }, 30_000);
});
