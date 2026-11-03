import {
  AgentId,
  AttemptId,
  DEFAULT_QUEST_LIMITS,
  Quest,
  QuestId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { memberPrompt, memberReminder, ownerBriefing, RESULTS_RULE } from "../src/briefs.ts";

// Issue #566: a lead answered its member that results "will reach you as context" while the
// member's prompt said they would come as a hand-off. The lead's and the member's prompts now
// state the same rule, the one the hub follows: a dependent gets what the Tasks it comes after
// returned, and anything else moves only by the lead's hand_off.

const at = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const QUILL = AgentId.make("quill");
const PIP = AgentId.make("pip");

const task = (id: string, ownerId: AgentId, state: TaskState, dependsOn: string[] = [], summary?: string) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: id === "app" ? null : TaskId.make("app"),
    rootId: TaskId.make("app"),
    threadId: ThreadId.make("chat"),
    brief: `Brief for ${id}\nMore detail`,
    state,
    dependsOn: dependsOn.map((each) => TaskId.make(each)),
    result: summary === undefined ? null : { summary, attemptId: AttemptId.make(`a-${id}`) },
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const quest = new Quest({
  id: QuestId.make("q"),
  taskId: TaskId.make("app"),
  leadId: FRODO,
  parentQuestId: null,
  threadId: ThreadId.make("chat"),
  goal: "Build the app",
  acceptance: [],
  limits: DEFAULT_QUEST_LIMITS,
  depth: 1,
  state: "active",
  createdAt: at,
  endedAt: null,
  revision: 1,
});

const tree = (quests: ReadonlyArray<Quest>, ...tasks: ReadonlyArray<Task>) =>
  new TaskTree({
    tasks: [task("app", FRODO, "waiting"), ...tasks],
    quests,
    delegations: [],
    attempts: [],
    milestones: [],
    checkpoints: [],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
  });

describe("how results move in a Quest", () => {
  // covers OR-003, OR-005
  it("[TC-OR-216] the lead's turn on a Task that leads a Quest states the hand-off rule, and a turn that leads none does not", () => {
    const read = tree(
      [quest],
      task("backend", QUILL, "completed", [], "Backend ready."),
      task("review", PIP, "active", ["backend"]),
    );
    const briefing = ownerBriefing(read.tasks[0] as Task, read);
    expect(briefing).toContain(`You lead the Quest on this Task. ${RESULTS_RULE}`);
    expect(briefing).toContain("never hand a Task what the Tasks it comes after returned");
    expect(briefing).toContain("Call hand_off when a member needs something else");

    const alone = tree([], task("backend", FRODO, "active"));
    expect(ownerBriefing(alone.tasks[0] as Task, alone)).not.toContain(RESULTS_RULE);
  });

  // covers OR-003, OR-005
  it("[TC-OR-217] the member's prompt states the same rule, word for word, and neither says a dependent needs a hand-off", () => {
    const read = tree([quest], task("backend", QUILL, "active"), task("review", PIP, "queued", ["backend"]));
    const member = memberPrompt(read.tasks[2] as Task, read, "Frodo");
    const lead = ownerBriefing(read.tasks[0] as Task, read);
    expect(member).toContain(RESULTS_RULE);
    expect(lead).toContain(RESULTS_RULE);
    for (const prompt of [member, lead]) {
      expect(prompt).not.toContain("reaches you as a hand-off");
      expect(prompt).not.toMatch(/results move only/);
    }
    expect(RESULTS_RULE).toContain("the hub gives it what they returned");
    expect(RESULTS_RULE).toContain("only when the lead calls hand_off");
  });

  // covers OR-003, OR-004, OR-005
  it("[TC-OR-226] a member that leads a nested Quest is told the rule and the lead's duty on every later turn, and one that leads none is not", () => {
    const nested = new Quest({
      ...quest,
      id: QuestId.make("nested"),
      taskId: TaskId.make("backend"),
      leadId: QUILL,
      parentQuestId: quest.id,
      depth: 2,
    });
    const read = tree([quest, nested], task("backend", QUILL, "active"), task("review", PIP, "active"));
    const leading = memberReminder(read.tasks[1] as Task, read, "Frodo");
    const lead = ownerBriefing(read.tasks[0] as Task, read);
    const guidance = `You lead the Quest on this Task. ${RESULTS_RULE}`;
    expect(leading).toContain(guidance);
    expect(leading).toContain("never hand a Task what the Tasks it comes after returned");
    // The same words the chat lead's turn is told, so every lead of the tree hears one rule.
    expect(lead.split("\n").find((line) => line.startsWith(guidance))).toBe(
      leading.split("\n").find((line) => line.startsWith(guidance)),
    );
    // The finishing line still ends the reminder.
    expect(leading.endsWith("your final reply becomes its result.")).toBe(true);
    expect(memberReminder(read.tasks[2] as Task, read, "Frodo")).not.toContain(RESULTS_RULE);
  });
});
