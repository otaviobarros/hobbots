import {
  AgentId,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  HandOff,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { memberReminder } from "../src/briefs.ts";

// Issue #567: every later turn of a member's session says where each Task its work builds on stands
// now, with its result once it has one, read when the turn starts, so a session resumed after one of
// them completed never keeps the state its first prompt showed.

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

const tree = (tasks: ReadonlyArray<Task>, handed: ReadonlyArray<{ from: string; to: string }> = []) =>
  new TaskTree({
    tasks: [task("app", FRODO, "waiting"), ...tasks],
    quests: [],
    delegations: [],
    attempts: [],
    milestones: [],
    checkpoints: [],
    questions: [],
    artifacts: handed.map(
      ({ from }) =>
        new ArtifactRef({
          id: ArtifactId.make(`art-${from}`),
          taskId: TaskId.make(from),
          attemptId: AttemptId.make(`a-${from}`),
          kind: "file",
          label: `${from}.py`,
          value: `/project/${from}.py`,
          createdAt: at,
        }),
    ),
    handOffs: handed.map(
      ({ from, to }) =>
        new HandOff({ artifactId: ArtifactId.make(`art-${from}`), toTaskId: TaskId.make(to), createdAt: at }),
    ),
    notes: [],
    waits: [],
  });

describe("a member's later turn", () => {
  // covers OR-003
  it("[TC-OR-210] states the current state and result of each Task its Task comes after", () => {
    const running = tree([task("backend", QUILL, "active"), task("review", PIP, "waiting", ["backend"])]);
    const before = memberReminder(running.tasks[2] as Task, running, "Frodo");
    expect(before.startsWith("You work on Task review for Frodo.")).toBe(true);
    expect(before).toContain("  - Task backend (Brief for backend), active");
    expect(before).not.toContain("completed");

    // The same session's next turn, once the backend completed: its state and result, read anew.
    const done = tree([
      task("backend", QUILL, "completed", [], "Stores amounts as integer cents."),
      task("review", PIP, "waiting", ["backend"]),
    ]);
    const after = memberReminder(done.tasks[2] as Task, done, "Frodo");
    expect(after).toContain("  - Task backend (Brief for backend), completed: Stores amounts as integer cents.");
    expect(after.split("Stores amounts as integer cents.")).toHaveLength(2);
    expect(after).toContain("When it is done, call complete_task with its result");
  });

  // covers OR-003, OR-005
  it("[TC-OR-211] also states the result of a Task whose artifact was handed to it, once, and nothing when its work builds on none", () => {
    const read = tree(
      [
        task("backend", QUILL, "completed", [], "Backend ready."),
        task("frontend", QUILL, "completed", [], "Frontend ready."),
        task("review", PIP, "waiting", ["backend"]),
      ],
      [
        { from: "backend", to: "review" },
        { from: "frontend", to: "review" },
      ],
    );
    const reminder = memberReminder(read.tasks[3] as Task, read, "Frodo");
    expect(reminder.split("Backend ready.")).toHaveLength(2);
    expect(reminder).toContain("  - Task frontend (Brief for frontend), completed: Frontend ready.");

    const alone = tree([task("review", PIP, "waiting")]);
    expect(memberReminder(alone.tasks[1] as Task, alone, "Frodo")).not.toContain("stand now");
  });
});
