import {
  AgentId,
  CHECKPOINT_WORDS,
  Checkpoint,
  CheckpointId,
  DEFAULT_QUEST_LIMITS,
  FINISH_RULE,
  LEAN_CHAT_RULE,
  Quest,
  QuestId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_RULE, memberPrompt, memberReminder, ownerBriefing, planNote, stepPrompt } from "../src/briefs.ts";

// Issue #901: a lane shows each checkpoint as a short beat, and the chat holds only what keeps you
// informed. Hobs are asked for summaries of about eight words, with anything more in the detail,
// and the lead is asked to write only the plan, a question no lead can answer and the finish.

const at = "2026-11-04T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");

const task = (id: string, ownerId: AgentId, state: TaskState, parent: string | null, thread: boolean) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: parent === null ? null : TaskId.make(parent),
    rootId: TaskId.make("campaign"),
    threadId: thread ? ThreadId.make("chat") : null,
    brief: `Brief for ${id}`,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const campaign = task("campaign", ALDRIC, "waiting", null, true);
const copy = task("copy", QUILL, "active", "campaign", false);
const outline = task("outline", ALDRIC, "queued", "campaign", false);

const quest = new Quest({
  id: QuestId.make("q"),
  taskId: campaign.id,
  leadId: ALDRIC,
  parentQuestId: null,
  threadId: ThreadId.make("chat"),
  goal: "A Black Friday campaign",
  acceptance: [],
  limits: DEFAULT_QUEST_LIMITS,
  depth: 1,
  state: "active",
  createdAt: at,
  endedAt: null,
  revision: 1,
});

const finding = (detail: string) =>
  new Checkpoint({
    id: CheckpointId.make("long"),
    taskId: copy.id,
    attemptId: null,
    source: "unplanned",
    kind: "finding",
    milestoneId: null,
    summary: "Two headlines too long",
    detail,
    createdAt: at,
    revision: 1,
  });

const tree = (...tasks: ReadonlyArray<Task>) => treeWith([], ...tasks);

const treeWith = (checkpoints: ReadonlyArray<Checkpoint>, ...tasks: ReadonlyArray<Task>) =>
  new TaskTree({
    tasks: [campaign, ...tasks],
    quests: [quest],
    delegations: [],
    attempts: [],
    milestones: [],
    checkpoints,
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
  });

describe("short checkpoints and a lean chat", () => {
  it("asks every hob that reports for a summary of about eight words, with the rest in its detail", () => {
    expect(CHECKPOINT_WORDS).toBe(8);
    expect(CHECKPOINT_RULE).toContain("about 8 words");
    expect(CHECKPOINT_RULE).toContain('"Three headlines drafted"');
    expect(CHECKPOINT_RULE).toContain("detail");
    expect(stepPrompt(outline, tree(outline))).toContain(CHECKPOINT_RULE);
    expect(memberPrompt(copy, tree(copy), "Aldric")).toContain(CHECKPOINT_RULE);
  });

  it("tells the lead's chat turn to write only the plan, a question no lead can answer and the finish", () => {
    const briefing = ownerBriefing(campaign, tree(copy));
    expect(briefing).toContain(LEAN_CHAT_RULE);
    expect(briefing).toContain(FINISH_RULE);
    expect(LEAN_CHAT_RULE).toContain("write only the plan, a question no lead can answer and the finish");
    expect(LEAN_CHAT_RULE).toContain("otherwise end your turn without a message, until the user writes");
    expect(FINISH_RULE).toContain("what was made, where it is and who did what");
  });

  it("keeps a checkpoint's detail, bounded, in the lead's briefing beside its short summary", () => {
    expect(ownerBriefing(campaign, treeWith([finding("Both run past 60 characters.")], copy))).toContain(
      "Latest: finding, Two headlines too long. Detail: Both run past 60 characters.",
    );
    const long = ownerBriefing(campaign, treeWith([finding("x".repeat(5_000))], copy));
    expect(long).toContain("Two headlines too long. Detail: x");
    expect(long).not.toContain("x".repeat(1_300));
  });

  it("never tells a member, which has no chat, how to write in one", () => {
    expect(memberPrompt(copy, tree(copy), "Aldric")).not.toContain(LEAN_CHAT_RULE);
    expect(memberReminder(copy, tree(copy), "Aldric")).not.toContain(LEAN_CHAT_RULE);
  });

  it("asks for the plan once when work starts in the chat, and not for a member's own Quest", () => {
    expect(planNote(campaign)).toContain("tell the user the plan in a line or two");
    // The work is handed out first: writing the plan starts nothing (#1081).
    expect(planNote(campaign)).toMatch(
      /^ Delegate first: writing the plan starts nothing\. Then tell the user/,
    );
    expect(planNote(campaign)).toContain("stay quiet until a question no lead can answer, or the finish");
    expect(planNote(copy)).toBe("");
  });
});
