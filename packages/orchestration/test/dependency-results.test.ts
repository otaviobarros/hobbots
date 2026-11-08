import {
  AgentId,
  ArtifactId,
  ArtifactRef,
  AttemptId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { memberPrompt } from "../src/briefs.ts";

// Issue #565: a member whose Task comes after others starts only once they have completed, and its
// prompt carries what each of them returned, so it needs no hand-off from its lead to go on.

const at = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const QUILL = AgentId.make("quill");
const ROOK = AgentId.make("rook");

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

const artifact = (id: string, taskId: string, label: string, value: string) =>
  new ArtifactRef({
    id: ArtifactId.make(id),
    taskId: TaskId.make(taskId),
    attemptId: AttemptId.make(`a-${taskId}`),
    kind: "file",
    label,
    value,
    createdAt: at,
  });

const tree = (tasks: ReadonlyArray<Task>, artifacts: ReadonlyArray<ArtifactRef> = []) =>
  new TaskTree({
    tasks: [task("app", FRODO, "waiting"), ...tasks],
    quests: [],
    delegations: [],
    attempts: [],
    milestones: [],
    checkpoints: [],
    questions: [],
    artifacts,
    handOffs: [],
    notes: [],
    waits: [],
  });

describe("a dependent member's prompt", () => {
  // covers OR-002, OR-003
  it("[TC-OR-205] carries the result and artifacts of every Task it comes after, so no hand-off is needed", () => {
    const read = tree(
      [
        task("backend", QUILL, "completed", [], "Stores amounts as integer cents."),
        task("docs", QUILL, "completed", [], "Docs written."),
        task("frontend", ROOK, "queued", ["backend", "docs"]),
      ],
      [artifact("core", "backend", "core.py", "/project/core.py")],
    );
    const prompt = memberPrompt(read.tasks[3] as Task, read, "Frodo");
    expect(prompt).toContain("It came after these Tasks, which have completed. What they returned:");
    expect(prompt).toContain("Task backend (Brief for backend) returned: Stores amounts as integer cents.");
    expect(prompt).toContain("  - core.py (file, artifact core): /project/core.py");
    expect(prompt).toContain("Task docs (Brief for docs) returned: Docs written.");
    expect(prompt).not.toContain("hand-off");
  });

  it("[TC-OR-206] keeps what the Tasks it comes after returned within the step input limit", () => {
    const long = "x".repeat(5_000);
    const many = Array.from({ length: 6 }, (_, index) => task(`dep${index}`, QUILL, "completed", [], long));
    const read = tree([
      ...many,
      task(
        "frontend",
        ROOK,
        "queued",
        many.map((each) => each.id),
      ),
    ]);
    const prompt = memberPrompt(read.tasks.at(-1) as Task, read, "Frodo");
    const alone = memberPrompt(
      task("frontend", ROOK, "queued", []),
      tree([task("frontend", ROOK, "queued", [])]),
      "Frodo",
    );
    // Each result is cut to 4,000 characters, and all of them together to 16,000, beside the lines every member is told.
    expect(prompt.length - alone.length).toBeLessThanOrEqual(16_001);
    expect(prompt).toContain("Task dep0 (Brief for dep0) returned:");
    expect(prompt.endsWith("Task id: frontend.")).toBe(true);
  });
});
