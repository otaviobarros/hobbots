import {
  AgentId,
  Attempt,
  AttemptId,
  ChannelId,
  Checkpoint,
  CheckpointId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { stepPrompt } from "../src/briefs.ts";

// Issue #1446: Pause now stops a step's turn, and Resume starts the step again in a fresh session.
// That session is told the earlier one was stopped, with what it reported, so it never redoes work.

const at = "2026-11-14T00:00:00.000Z";
const NETTLE = AgentId.make("nettle");

const task = (id: string, parentId: string | null, state: TaskState) =>
  new Task({
    id: TaskId.make(id),
    ownerId: NETTLE,
    parentId: parentId === null ? null : TaskId.make(parentId),
    rootId: TaskId.make("build"),
    channelId: parentId === null ? ChannelId.make("chat") : null,
    brief: `Brief for ${id}`,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const attempt = (state: Attempt["state"]) =>
  new Attempt({
    id: AttemptId.make("draft-1"),
    taskId: TaskId.make("draft"),
    number: 1,
    agentId: NETTLE,
    runtime: "claude-code",
    sessionId: "s1",
    configVersion: 1,
    policyVersion: null,
    state,
    outcome: null,
    startedAt: at,
    endedAt: at,
  });

const tree = (attempts: ReadonlyArray<Attempt>) =>
  new TaskTree({
    tasks: [task("build", null, "active"), task("draft", "build", "queued")],
    quests: [],
    delegations: [],
    attempts,
    milestones: [],
    checkpoints: [
      new Checkpoint({
        id: CheckpointId.make("c1"),
        taskId: TaskId.make("draft"),
        attemptId: AttemptId.make("draft-1"),
        source: "unplanned",
        kind: "progress",
        milestoneId: null,
        summary: "Wrote the first two sections",
        createdAt: at,
        revision: 1,
      }),
    ],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
  });

describe("a step started again after its turn was stopped", () => {
  it("is told the earlier session was stopped and what it reported, so it checks before redoing work (#1446)", () => {
    const step = tree([attempt("interrupted")]);
    const prompt = stepPrompt(step.tasks[1] as Task, step);
    expect(prompt).toContain("An earlier session of this step was stopped before it finished");
    expect(prompt).toContain("progress: Wrote the first two sections");
    // A step whose earlier session ended on its own starts with no such line.
    const fresh = tree([attempt("completed")]);
    expect(stepPrompt(fresh.tasks[1] as Task, fresh)).not.toContain("was stopped before it finished");
  });
});
