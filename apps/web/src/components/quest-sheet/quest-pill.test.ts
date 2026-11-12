import { AgentId, QuestId, type QuestState, QuestSummary, TaskId, ThreadId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { questPill } from "./quest-pill.ts";

// #1390: the camp header's quest pill reads the hub's QuestSummary, "2 quests · 1 ready for review · 1 needs you".

const CAMP = ThreadId.make("camp");

const summary = (
  id: string,
  fields: Partial<{
    state: QuestState;
    needsYou: number;
    readyForReview: number;
    parent: string;
    threadId: ThreadId;
  }> = {},
) =>
  new QuestSummary({
    questId: QuestId.make(id),
    taskId: TaskId.make(`task-${id}`),
    leadId: AgentId.make("aldric"),
    parentQuestId: fields.parent === undefined ? null : QuestId.make(fields.parent),
    threadId: fields.threadId ?? CAMP,
    state: fields.state ?? "active",
    tones: { needs: 0, working: 1, waiting: 0, done: 0, problem: 0, idle: 0 },
    needsYou: fields.needsYou ?? 0,
    readyForReview: fields.readyForReview ?? 0,
    revision: 1 as QuestSummary["revision"],
  });

describe("a camp's quest pill", () => {
  it("[TC-UX-1390-08] counts the camp's own quests under way, what they have ready for review and what needs you", () => {
    expect(
      questPill(CAMP, [
        summary("checkout", { readyForReview: 1 }),
        summary("gift", { needsYou: 1 }),
        // A member's own quest inside one counts with its lead's, an ended one and another camp's not at all.
        summary("nested", { parent: "gift", needsYou: 1 }),
        summary("done", { state: "completed", readyForReview: 2 }),
        summary("elsewhere", { threadId: ThreadId.make("other"), needsYou: 3 }),
      ]),
    ).toEqual({ quests: 2, review: 1, needs: 1 });
  });

  it("[TC-UX-1390-09] shows nothing while no quest of the camp is under way", () => {
    expect(questPill(CAMP, [])).toBeNull();
    expect(questPill(CAMP, [summary("done", { state: "completed" })])).toBeNull();
  });
});
