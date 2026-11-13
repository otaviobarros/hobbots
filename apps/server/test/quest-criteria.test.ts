import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeKind, TaskTree } from "@hobbots/domain";
import { afterEach, describe, expect, it } from "vitest";
import { hub, ownedBy, PIP, partyHub, QUILL, send, treeWhen } from "./party-hub.ts";

// Issue #1445: a Quest's acceptance criteria were strings folded into its brief, and `delivered`
// was its lead's own word. Each criterion now has an id, and a Quest completes only once each
// required one is accepted on evidence or you waive it. Evidence names an artifact version, and a
// newer version voids it. The hub checks every call, so it holds for every runtime.

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

const RUNTIMES: ReadonlyArray<RuntimeKind> = ["claude-code", "codex"];

const DATE = "$quest.criteria.0.criterion_id";
const PHOTO = "$quest.criteria.1.criterion_id";

const startQuest = hub("start_quest", {
  key: "quest",
  goal: "Write the launch page",
  acceptance: ["The page names the launch date", { text: "The page has a photo", optional: true }],
});

/**
 * A member's brief that returns the page at `path` under `key`: a path inside its folder, never
 * absolute, so your message names no file the Quest must deliver at a path its JSON escapes.
 */
const returnsPage = (brief: string, key: string, path: string) =>
  [
    brief,
    hub("complete_task", {
      key,
      summary: "The page is written",
      artifacts: [{ kind: "file", label: "Launch page", value: path }],
    }),
  ].join("\n");

const done = (tree: TaskTree) => tree.tasks[0]?.state === "completed";

describe.each(RUNTIMES)("a Quest's acceptance criteria, on %s", (runtime) => {
  // covers OR-004, OR-006, EX-002
  it("[TC-OR-1445-04] hold the Quest open until its lead accepts the required one on evidence", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    const page = join(project, "index.html");
    writeFileSync(page, "<h1>Launch on Friday 6 December</h1>\n");
    await run(
      send([
        "Write the launch page",
        startQuest,
        hub("delegate_task", {
          key: "page",
          hob: "Pip",
          brief: returnsPage("Write the launch page", "pip-done", "index.html"),
          criteria: [DATE],
        }),
        hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
        // The turn Pip's result wakes is no request of yours.
        `fake:then ${hub("complete_task", { key: "early", delivered: true, summary: "The page is written" })}`,
        `fake:then ${hub("check_criterion", { key: "waive-date", criterion_id: DATE, verdict: "waived", reason: "No date yet" })}`,
        `fake:then ${hub("check_criterion", { key: "waive-photo", criterion_id: PHOTO, verdict: "waived", reason: "No photo this time" })}`,
        `fake:then ${hub("check_criterion", { key: "accept", criterion_id: DATE, verdict: "accepted", reason: "It says Friday 6 December", evidence: ["$pip-done.artifacts.0"] })}`,
        `fake:then ${hub("complete_task", { key: "whole", delivered: true, summary: "The page is written" })}`,
      ]),
    );
    const finished = await run(treeWhen(done));

    expect(answers.get("quest")).toContain("Its acceptance criteria have ids");
    expect(answers.get("early")).toContain("Refused (criteria-unmet)");
    expect(answers.get("early")).toContain('"The page names the launch date" (not checked yet)');
    expect(answers.get("waive-date")).toContain("Refused (waive-not-asked)");
    expect(answers.get("waive-photo")).toContain("is waived by you");
    expect(answers.get("accept")).toContain('is accepted on "Launch page" version 1');
    expect(answers.get("accept")).toContain("Every required criterion of the Quest is accepted or waived.");
    const [quest] = finished.quests;
    expect(quest?.state).toBe("completed");
    expect(quest?.criteria.map((each) => [each.text, each.required, each.state, each.decided?.by.kind])).toEqual([
      ["The page names the launch date", true, "accepted", "hob"],
      ["The page has a photo", false, "waived", "hob"],
    ]);
    const pip = ownedBy(finished, PIP);
    expect(quest?.criteria[0]?.taskIds).toEqual([pip?.id]);
    expect(quest?.criteria[0]?.evidence).toMatchObject([{ version: 1, taskId: pip?.id, voidedAt: null }]);
  }, 30_000);

  // covers OR-004, OR-006
  it("[TC-OR-1445-05] voids the evidence when a newer version of the page arrives, until its lead checks it again", async () => {
    const party = partyHub({ lead: runtime, members: runtime, files: true });
    dispose = party.dispose;
    const { run, answers, project } = party;
    const page = join(project, "index.html");
    writeFileSync(page, "<h1>Launch on Friday 6 December</h1>\n");
    await run(
      send([
        "Write the launch page",
        startQuest,
        hub("delegate_task", {
          key: "page",
          hob: "Pip",
          brief: returnsPage("Write the launch page", "pip-done", "index.html"),
        }),
        hub("wait_for", { key: "wait", tasks: ["$page.task_id"] }),
        // Pip's result: Frodo accepts it, then has Quill rework the same page.
        `fake:then ${hub("check_criterion", { key: "accept", criterion_id: DATE, verdict: "accepted", reason: "It says Friday 6 December", evidence: ["$pip-done.artifacts.0"] })}`,
        `fake:then ${hub("delegate_task", { key: "polish", hob: "Quill", brief: returnsPage("Polish the launch page", "quill-done", "index.html") })}`,
        `fake:then ${hub("wait_for", { key: "wait-polish", tasks: ["$polish.task_id"] })}`,
        // Quill's result is the page's next version.
        `fake:then fake:then ${hub("complete_task", { key: "early", delivered: true, summary: "The page is written" })}`,
        `fake:then fake:then ${hub("check_criterion", { key: "stale", criterion_id: DATE, verdict: "accepted", reason: "Still says it", evidence: ["$pip-done.artifacts.0"] })}`,
        `fake:then fake:then ${hub("check_criterion", { key: "again", criterion_id: DATE, verdict: "accepted", reason: "Still says Friday 6 December", evidence: ["$quill-done.artifacts.0"] })}`,
        `fake:then fake:then ${hub("complete_task", { key: "whole", delivered: true, summary: "The page is written" })}`,
      ]),
    );
    const finished = await run(treeWhen(done));

    expect(answers.get("accept")).toContain("is accepted");
    expect(answers.get("early")).toContain("Refused (criteria-unmet)");
    expect(answers.get("early")).toContain("its evidence was voided by a newer version");
    expect(answers.get("stale")).toContain("Refused (evidence-stale)");
    expect(answers.get("again")).toContain('is accepted on "Launch page" version 2');
    const [quest] = finished.quests;
    expect(quest?.state).toBe("completed");
    expect(quest?.criteria[0]).toMatchObject({
      state: "accepted",
      evidence: [{ version: 2, taskId: ownedBy(finished, QUILL)?.id, voidedAt: null }],
    });
  }, 30_000);

  // covers OR-004, IN-004
  it("[TC-OR-1445-06] waives a required criterion when you ask in the message its turn answers, as yours", async () => {
    const party = partyHub({ lead: runtime, members: runtime });
    dispose = party.dispose;
    const { run, answers } = party;
    await run(
      send([
        "Write the launch page. The date is not set, so skip that check.",
        startQuest,
        hub("check_criterion", { key: "waive", criterion_id: DATE, verdict: "waived", reason: "You said to skip it" }),
        hub("complete_task", { key: "whole", delivered: true, summary: "The page is written, without a date" }),
      ]),
    );
    const finished = await run(treeWhen(done));
    expect(answers.get("waive")).toContain("is waived by the user");
    const [quest] = finished.quests;
    expect(quest?.state).toBe("completed");
    expect(quest?.criteria[0]).toMatchObject({
      state: "waived",
      decided: { by: { kind: "user" }, reason: "You said to skip it" },
    });
  }, 30_000);
});
