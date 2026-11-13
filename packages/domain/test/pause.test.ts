import { describe, expect, it } from "vitest";
import {
  AgentId,
  hobActor,
  mentionedIn,
  mentionTargets,
  pausedAbove,
  pausedHolder,
  pauseTargets,
  Quest,
  QuestId,
  resumedAs,
  resumeNote,
  resumeRecipients,
  resumeTargets,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
} from "../src/index.ts";

const at = "2026-11-13T10:00:00.000Z";
const later = "2026-11-13T11:00:00.000Z";
const LEAD = AgentId.make("aldric");
const ADA = AgentId.make("ada");
const BOB = AgentId.make("bob");
const you = { kind: "user" as const, id: "owner" };

const task = (id: string, owner: AgentId, parent: string | null, state: TaskState, updatedAt = at) =>
  new Task({
    id: TaskId.make(id),
    ownerId: owner,
    parentId: parent === null ? null : TaskId.make(parent),
    rootId: TaskId.make("top"),
    threadId: null,
    brief: id,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt,
    revision: 1,
    pause: state === "paused" ? { from: "waiting", at, by: you, now: false } : null,
  });

const tree = (tasks: ReadonlyArray<Task>, quests: ReadonlyArray<Quest> = []) =>
  new TaskTree({
    tasks,
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

const quest = new Quest({
  id: QuestId.make("q"),
  taskId: TaskId.make("top"),
  parentQuestId: null,
  threadId: null,
  leadId: LEAD,
  goal: "Launch page",
  acceptance: [],
  limits: { maxDepth: 2, deadline: null },
  depth: 1,
  state: "active",
  createdAt: at,
  endedAt: null,
  revision: 1,
});

describe("pause targets", () => {
  it("[TC-OR-1446-03] pauses a Task and everything under it still under way, and resumes only what was paused", () => {
    const work = tree([
      task("top", LEAD, null, "waiting"),
      task("ada", ADA, "top", "active"),
      task("done", BOB, "top", "completed"),
    ]);
    const top = work.tasks[0] as Task;
    expect(pauseTargets(top, work).map((each) => each.id)).toEqual(["top", "ada"]);
    const paused = tree([
      task("top", LEAD, null, "paused"),
      task("ada", ADA, "top", "paused"),
      task("done", BOB, "top", "completed"),
    ]);
    expect(resumeTargets(paused.tasks[0] as Task, paused).map((each) => each.id)).toEqual(["top", "ada"]);
    // A member's Task cannot be resumed on its own while the Quest above holds it.
    expect(pausedAbove(paused.tasks[1] as Task, paused)?.id).toBe("top");
    expect(pausedHolder(paused.tasks[1] as Task, paused.tasks)?.id).toBe("ada");
  });

  it("[TC-OR-1446-04] sends a Task whose paused turn ended without its runner back where a restart would", () => {
    const tasks = [
      task("top", LEAD, null, "paused"),
      task("step", LEAD, "top", "paused"),
      task("ada", ADA, "top", "paused"),
    ];
    expect(tasks.map((each) => resumedAs(each, tasks))).toEqual(["active", "queued", "waiting"]);
  });
});

describe("resumeNote", () => {
  it("[TC-OR-1446-05] tells each hob once what changed while the work was paused", () => {
    const before = task("ada", ADA, "top", "paused");
    const work = tree([
      task("top", LEAD, null, "paused"),
      before,
      task("bob", BOB, "top", "failed", later),
      task("quiet", BOB, "top", "waiting"),
    ]);
    const note = resumeNote(before, work, later);
    expect(note).toContain(`paused this work at ${at} and resumed it at ${later}`);
    expect(note).toContain("Task bob (bob) is failed");
    expect(note).not.toContain("quiet");
    expect(
      resumeRecipients([work.tasks[0] as Task, before, task("ada-2", ADA, "ada", "paused")]).map((each) => each.id),
    ).toEqual(["top", "ada"]);
    expect(resumeNote(before, tree([before]), later)).toContain("Nothing else in the work changed");
  });
});

describe("quest mentions", () => {
  const roster = [
    { actor: hobActor(ADA), name: "Ada" },
    { actor: hobActor(BOB), name: "Bob" },
    { actor: hobActor(LEAD), name: "Aldric" },
  ];

  it("[TC-OR-1446-06] finds @ and a whole name, ignoring case, never inside an address or a longer name", () => {
    expect(mentionedIn("@ada use the blue theme", roster)).toEqual([hobActor(ADA)]);
    expect(mentionedIn("mail ops@ada.dev or @Bobby", roster)).toEqual([]);
    expect(mentionedIn("@Bob and @Ada, both of you", roster)).toEqual([hobActor(ADA), hobActor(BOB)]);
  });

  it("[TC-OR-1446-07] reaches a member's open Task in an open Quest, never the lead's or one without a Task there", () => {
    const work = tree([task("top", LEAD, null, "waiting"), task("ada", ADA, "top", "active")], [quest]);
    const mentioned = mentionedIn("@Ada @Bob @Aldric stop", roster);
    expect(mentionTargets([work], LEAD, mentioned).map((each) => each.id)).toEqual(["ada"]);
    // Without a Quest, as for a request a hob works alone, nothing is mentioned.
    expect(mentionTargets([tree(work.tasks)], LEAD, mentioned)).toEqual([]);
  });
});
