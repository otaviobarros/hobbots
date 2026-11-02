import type { ToolAccess } from "@hobbots/agents";
import {
  AgentId,
  Delegation,
  DelegationId,
  EMPTY_HOB_POLICY,
  Milestone,
  MilestoneId,
  QuestId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { memberPrompt } from "../src/briefs.ts";
import { delegatedAccess } from "../src/members.ts";

const at = "2026-11-02T00:00:00.000Z";
const ALDRIC = AgentId.make("aldric");
const QUILL = AgentId.make("quill");
const ADA = AgentId.make("ada");

const task = (id: string, ownerId: AgentId, parentId: string | null, state: TaskState, dependsOn: string[] = []) =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    rootId: TaskId.make("campaign"),
    threadId: ThreadId.make("chat"),
    brief: `Brief for ${id}\nMore detail`,
    state,
    dependsOn: dependsOn.map((each) => TaskId.make(each)),
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const delegation = (child: string, member: AgentId, folders: string[] | null, expectedOutput: string | null = null) =>
  new Delegation({
    id: DelegationId.make(`d-${child}`),
    questId: QuestId.make("q"),
    leadId: ALDRIC,
    memberId: member,
    parentTaskId: TaskId.make("campaign"),
    childTaskId: TaskId.make(child),
    brief: `Brief for ${child}`,
    expectedOutput,
    authority: { overrides: { "edit-files": "ask", push: "deny" }, folders },
    timeoutMs: null,
    createdAt: at,
  });

const tree = (delegations: ReadonlyArray<Delegation>, milestones: ReadonlyArray<Milestone> = []) =>
  new TaskTree({
    tasks: [
      task("campaign", ALDRIC, null, "waiting"),
      task("copy", QUILL, "campaign", "active"),
      task("build", ADA, "campaign", "active", ["copy"]),
    ],
    quests: [],
    delegations,
    attempts: [],
    milestones,
    checkpoints: [],
    questions: [],
    artifacts: [],
    handOffs: [],
    notes: [],
    waits: [],
  });

const access: ToolAccess = {
  policy: {
    preset: "balanced",
    sharedFolders: ["/work"],
    hob: EMPTY_HOB_POLICY,
    dataFolder: "/data",
    restrictions: [],
  },
  folders: ["/work", "/elsewhere"],
  runtimeFolder: "/data/runtime/quill",
};

describe("a party member's session", () => {
  // covers PE-004
  it("[TC-PE-161] works under its own policy narrowed by its delegation: the delegation's decisions and only its folders", () => {
    const read = tree([delegation("copy", QUILL, ["/work/copy"])]);
    const narrowed = delegatedAccess(access, read.tasks[1] as Task, read, "/");
    expect(narrowed?.policy.restrictions).toEqual([{ "edit-files": "ask", push: "deny" }]);
    expect(narrowed?.folders).toEqual(["/work/copy"]);
    // The policy engine reads its folders from the policy, so they are narrowed there too.
    expect(narrowed?.policy.sharedFolders).toEqual(["/work/copy"]);
    expect(narrowed?.policy.hob.ownFolders).toEqual([]);
    // The rest of its policy is its own.
    expect(narrowed?.policy.preset).toBe("balanced");
    expect(narrowed?.runtimeFolder).toBe(access.runtimeFolder);
    // A delegation that names no folders keeps the member's own; a chat-only member stays chat-only.
    const anywhere = tree([delegation("copy", QUILL, null)]);
    expect(delegatedAccess(access, anywhere.tasks[1] as Task, anywhere, "/")?.folders).toEqual(access.folders);
    expect(delegatedAccess(null, anywhere.tasks[1] as Task, anywhere, "/")).toBeNull();
  });

  it("starts from its lead's brief, what the lead expects back, the Tasks it comes after and its milestones", () => {
    const read = tree(
      [delegation("build", ADA, null, "A scheduled launch email")],
      [
        new Milestone({
          id: MilestoneId.make("m1"),
          taskId: TaskId.make("build"),
          title: "Page live",
          position: 0,
          reachedAt: null,
          createdAt: at,
        }),
      ],
    );
    const prompt = memberPrompt(read.tasks[2] as Task, read, "Aldric");
    expect(prompt.startsWith("Brief for build\nMore detail\n---\n")).toBe(true);
    expect(prompt).toContain("Aldric gave you this Task as part of a Quest Aldric leads.");
    expect(prompt).toContain("Aldric expects back: A scheduled launch email");
    expect(prompt).toContain("  - Task copy, active: Brief for copy");
    expect(prompt).toContain("reaches you as a hand-off from your lead");
    expect(prompt).toContain("  - Page live (milestone_id m1)");
    expect(prompt.endsWith("Task id: build.")).toBe(true);
  });
});
