import {
  AgentId,
  AttemptId,
  DEFAULT_QUEST_LIMITS,
  Quest,
  QuestId,
  Question,
  QuestionId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { renderBrief, SINCE_LAST_TURN } from "../src/brief-parts.ts";
import { ownerBriefing, ownerBriefingParts } from "../src/briefs.ts";
import { reportingRules } from "../src/reporting.ts";

// Issue #1027: a lead's chat resumes the same session on every wake, yet each wake told it the whole
// Quest again, every result so far included. On a real five-hob Quest its prompts grew from about
// 2,900 to 10,900 characters. A session told of the same Task before is now told only what changed.

const at = "2026-11-06T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const MEMBERS = [AgentId.make("quill"), AgentId.make("rook"), AgentId.make("pip"), AgentId.make("nettle")];

const task = (id: string, ownerId: AgentId, state: TaskState, summary?: string) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: id === "app" ? null : TaskId.make("app"),
    rootId: TaskId.make("app"),
    threadId: ThreadId.make("chat"),
    brief: `Brief for ${id}`,
    state,
    dependsOn: [],
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

/** The Quest once the first `done` members have completed, each with a long result. */
const finishedBy = (done: number) =>
  new TaskTree({
    tasks: [
      task("app", FRODO, "waiting"),
      ...MEMBERS.map((member, index) =>
        index < done
          ? task(`t-${member}`, member, "completed", `${member} finished. ${"Details. ".repeat(200)}`)
          : task(`t-${member}`, member, "active"),
      ),
    ],
    quests: [quest],
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

const lead = (tree: TaskTree) => tree.tasks[0] as Task;
const parts = (tree: TaskTree) => [...ownerBriefingParts(lead(tree), tree), ...reportingRules(lead(tree), tree)];

describe("a lead's briefing on a resumed session", () => {
  // covers OR-004, OR-005
  it("[TC-OR-600] a lead told of its Task before is told only what changed, and its rules on every turn", () => {
    let told = renderBrief(lead(finishedBy(0)).id, parts(finishedBy(0)), null).told;
    const sizes: number[] = [];
    for (let done = 1; done <= MEMBERS.length; done++) {
      const briefed = renderBrief(lead(finishedBy(done)).id, parts(finishedBy(done)), told);
      told = briefed.told;
      sizes.push(briefed.text.length);
      expect(briefed.text).toContain(SINCE_LAST_TURN);
      // The member that just finished, with its result, and none that finished before.
      expect(briefed.text).toContain(`${MEMBERS[done - 1]} finished.`);
      for (const earlier of MEMBERS.slice(0, done - 1)) expect(briefed.text).not.toContain(`${earlier} finished.`);
      // The rules still come on every turn.
      expect(briefed.text).toContain("You lead the Quest on this Task.");
      expect(briefed.text).toContain("Call complete_task with the Task's result once everything under it has ended.");
    }
    // Each wake is as long as the last, however many results came before it.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(200);
    expect(Math.max(...sizes)).toBeLessThan(
      ownerBriefing(lead(finishedBy(MEMBERS.length)), finishedBy(MEMBERS.length)).length,
    );
  });

  // covers OR-004
  it("[TC-OR-601] a session told nothing, or told of another Task, is told the whole briefing", () => {
    const tree = finishedBy(2);
    const whole = renderBrief(lead(tree).id, parts(tree), null);
    expect(whole.text).not.toContain(SINCE_LAST_TURN);
    expect(whole.text).toContain(`${MEMBERS[0]} finished.`);
    expect(whole.text).toContain(`${MEMBERS[1]} finished.`);

    const elsewhere = renderBrief(lead(tree).id, parts(tree), { taskId: TaskId.make("other"), entries: {} });
    expect(elsewhere.text).toBe(whole.text);

    // Nothing changed: the rules alone, with no Task listed again.
    const same = renderBrief(lead(tree).id, parts(tree), whole.told);
    expect(same.text).toContain(SINCE_LAST_TURN);
    expect(same.text).not.toContain("finished.");
    expect(same.told).toEqual(whole.told);
  });

  // covers OR-004, IN-004
  it("[TC-OR-602] the questions waiting for the user are told on every turn, so a note is never taken for an answer", () => {
    const tree = finishedBy(0);
    const waiting = new TaskTree({
      ...tree,
      questions: [
        new Question({
          id: QuestionId.make("q-1"),
          taskId: TaskId.make(`t-${MEMBERS[0]}`),
          askerId: MEMBERS[0] as AgentId,
          recipientId: null,
          chain: [FRODO],
          text: "Which colour?",
          state: "open",
          answer: null,
          answeredBy: null,
          createdAt: at,
          answeredAt: null,
          revision: 1,
        }),
      ],
    });
    const asked = renderBrief(lead(waiting).id, parts(waiting), null);
    expect(asked.text).toContain("Which colour?");
    const again = renderBrief(lead(waiting).id, parts(waiting), asked.told);
    expect(again.text).toContain(SINCE_LAST_TURN);
    expect(again.text).toContain("Which colour?");
    expect(again.text).toContain("a note or message from the user is not an answer to them");
    // Once it is answered it is no longer listed as waiting.
    expect(renderBrief(lead(tree).id, parts(tree), again.told).text).not.toContain("Which colour?");
  });
});
