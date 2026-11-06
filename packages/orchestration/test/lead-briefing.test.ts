import {
  AgentId,
  AttemptId,
  DEFAULT_QUEST_LIMITS,
  FINISH_RULE,
  LEAN_CHAT_RULE,
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
import { type BriefPart, fixed, renderBrief, rule, SINCE_LAST_TURN } from "../src/brief-parts.ts";
import { ownerBriefing, ownerBriefingParts } from "../src/briefs.ts";
import { reportingRules } from "../src/reporting.ts";

// Issue #1027: a lead's chat resumes the same session on every wake, yet each wake told it the whole
// Quest again, every result so far included. On a real five-hob Quest its prompts grew from about
// 2,900 to 10,900 characters. A session told of the same Task before is now told only what changed,
// and its rules only once (#1039).

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

/** The lead's rules, which a session is told once (#1039). */
const RULES = [
  "You lead the Quest on this Task.",
  "Call complete_task with the Task's result once everything under it has ended.",
  LEAN_CHAT_RULE,
  FINISH_RULE,
  "Tell the user only what your Task tools did in this turn",
];

const lead = (tree: TaskTree) => tree.tasks[0] as Task;
const parts = (tree: TaskTree) => [...ownerBriefingParts(lead(tree), tree), ...reportingRules(lead(tree), tree)];

describe("a lead's briefing on a resumed session", () => {
  // covers OR-004, OR-005
  it("[TC-OR-600] a lead told of its Task before is told only what changed, its rules once", () => {
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
      // The session holds its rules from the first briefing (#1039).
      for (const told of RULES) expect(briefed.text).not.toContain(told);
    }
    // Each wake is as long as the last, however many results came before it.
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(200);
    expect(Math.max(...sizes)).toBeLessThan(2_400);
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
    for (const told of RULES) expect(whole.text).toContain(told);
    expect(elsewhere.text).toBe(whole.text);

    // Nothing changed: where the Task stands, with no Task or rule told again.
    const same = renderBrief(lead(tree).id, parts(tree), whole.told);
    expect(same.text).toContain(SINCE_LAST_TURN);
    expect(same.text).not.toContain("finished.");
    for (const told of RULES) expect(same.text).not.toContain(told);
    expect(same.told).toEqual(whole.told);
  });

  // covers OR-004, OR-005
  it("[TC-OR-620] a rule that comes to apply, or changes, partway is told on the next wake, and once", () => {
    const tree = finishedBy(1);
    const noQuest = new TaskTree({ ...tree, quests: [] });
    // Before the Quest starts on the Task, there is no lead guidance to tell.
    const before = renderBrief(lead(noQuest).id, parts(noQuest), null);
    expect(before.text).not.toContain("You lead the Quest on this Task.");
    // The wake after it starts tells it, and only it of the rules.
    const started = renderBrief(lead(tree).id, parts(tree), before.told);
    expect(started.text).toContain("You lead the Quest on this Task.");
    for (const told of RULES.slice(1)) expect(started.text).not.toContain(told);
    // The next wake does not tell it again.
    expect(renderBrief(lead(tree).id, parts(tree), started.told).text).not.toContain(
      "You lead the Quest on this Task.",
    );
    // A mark from before rules were kept in it, as #1027 saved, has none: the session is told them all.
    const older = {
      ...started.told,
      entries: Object.fromEntries(Object.entries(started.told.entries).filter(([key]) => !key.startsWith("rule:"))),
    };
    const resent = renderBrief(lead(tree).id, parts(tree), older);
    for (const told of RULES) expect(resent.text).toContain(told);
  });

  // covers OR-004
  it("[TC-OR-621] a rule whose text changes, or that stops applying and applies again, is told again once", () => {
    const id = lead(finishedBy(0)).id;
    const briefed = (...rules: ReadonlyArray<BriefPart>) => [fixed("You are working on it."), ...rules];
    const first = renderBrief(id, briefed(rule("chat", "Write only the plan.")), null);
    const same = renderBrief(id, briefed(rule("chat", "Write only the plan.")), first.told);
    expect(same.text).not.toContain("Write only the plan.");
    // Its text changes: told again, then kept.
    const changed = renderBrief(id, briefed(rule("chat", "Write only the plan and the finish.")), same.told);
    expect(changed.text).toContain("Write only the plan and the finish.");
    expect(
      renderBrief(id, briefed(rule("chat", "Write only the plan and the finish.")), changed.told).text,
    ).not.toContain("Write only the plan");
    // It stops applying, then applies again: told again on its return.
    const gone = renderBrief(id, briefed(rule("chat")), changed.told);
    expect(gone.text).not.toContain("Write only the plan");
    expect(renderBrief(id, briefed(rule("chat", "Write only the plan and the finish.")), gone.told).text).toContain(
      "Write only the plan and the finish.",
    );
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
    // So is how to report, while a question waits for the user (#1039).
    expect(again.text).toContain("Tell the user only what your Task tools did in this turn");
    // Once it is answered it is no longer listed as waiting.
    expect(renderBrief(lead(tree).id, parts(tree), again.told).text).not.toContain("Which colour?");
  });
});

describe("a result that arrives with a lead's turn", () => {
  // covers OR-004, OR-005
  it("[TC-OR-622] is told in the briefing alone, whole up to the result limit, and once", () => {
    const before = finishedBy(1);
    const told = renderBrief(lead(before).id, parts(before), null).told;
    const tree = finishedBy(2);
    const rook = `t-${MEMBERS[1]}`;
    const result = tree.tasks.find((each) => each.id === rook)?.result?.summary.trim() ?? "";
    const carrying = [...ownerBriefingParts(lead(tree), tree, new Set([rook])), ...reportingRules(lead(tree), tree)];
    // The wake that carries Rook's result: what arrived points here, so its line keeps the result whole.
    const woken = renderBrief(lead(tree).id, carrying, told);
    expect(woken.text).toContain(result);
    // A turn that carries no result, as Continue, gets the summary.
    const plain = renderBrief(lead(tree).id, parts(tree), told);
    expect(plain.text).toContain(`${MEMBERS[1]} finished.`);
    expect(plain.text).not.toContain(result);
    // The mark is the one the summary leaves, so the next wake does not tell it again, and a whole
    // briefing later tells the summary.
    expect(woken.told).toEqual(plain.told);
    expect(renderBrief(lead(tree).id, parts(tree), woken.told).text).not.toContain(`${MEMBERS[1]} finished.`);
  });
});
