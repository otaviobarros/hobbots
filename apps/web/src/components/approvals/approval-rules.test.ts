import {
  AgentId,
  ApprovalId,
  ApprovalRequest,
  type GrantRule,
  MessageId,
  offersThisTask,
  Quest,
  QuestId,
  TaskId,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import {
  canNarrow,
  commandText,
  offersAlways,
  rulesToSave,
  ruleText,
  runnerNote,
  workScope,
} from "./approval-rules.ts";

const request = (fields: Partial<ApprovalRequest> = {}) =>
  new ApprovalRequest({
    id: ApprovalId.make("a1"),
    agentId: AgentId.make("pip"),
    threadId: ThreadId.make("t1"),
    messageId: MessageId.make("m1"),
    stepId: "s1",
    tool: "MultiEdit",
    operation: "edit-files",
    targets: ["/w/docs/a.md", "/w/docs/b.md", "/w/notes/c.md"],
    arguments: { file_path: "/w/docs/a.md" },
    label: "Editing files",
    reason: "The Careful preset asks before editing files.",
    actionDigest: "d1",
    policyVersion: "p1",
    grantable: true,
    rules: [
      { _tag: "Folder", operation: "edit-files", folder: "/w/docs" },
      { _tag: "Folder", operation: "edit-files", folder: "/w/notes" },
    ],
    state: "pending",
    denyReason: null,
    createdAt: "2026-10-31T12:00:00.000Z",
    decidedAt: null,
    revision: 1,
    ...fields,
  });

describe("offersAlways", () => {
  it("offers Always only for a grantable request that is not high risk and has rules", () => {
    expect(offersAlways(request())).toBe(true);
    expect(offersAlways(request({ grantable: false }))).toBe(false);
    expect(offersAlways(request({ onceOnly: true }))).toBe(false);
    expect(offersAlways(request({ rules: [] }))).toBe(false);
  });
});

describe("rulesToSave", () => {
  it("keeps the request's rules, or narrows each folder rule to the call's files in that folder", () => {
    const approval = request();
    expect(rulesToSave(approval, false)).toBe(approval.rules);
    expect(rulesToSave(approval, true)).toEqual([
      { _tag: "Paths", operation: "edit-files", paths: ["/w/docs/a.md", "/w/docs/b.md"] },
      { _tag: "Paths", operation: "edit-files", paths: ["/w/notes/c.md"] },
    ]);
  });

  it("offers narrowing only for folder rules", () => {
    expect(canNarrow(request())).toBe(true);
    const host: GrantRule = { _tag: "Host", host: "example.com" };
    expect(canNarrow(request({ operation: "use-web", targets: ["example.com"], rules: [host] }))).toBe(false);
    expect(rulesToSave(request({ rules: [host] }), true)).toEqual([host]);
  });
});

describe("ruleText", () => {
  it("says each rule as it will be saved", () => {
    expect(ruleText({ _tag: "Folder", operation: "edit-files", folder: "/w/docs" }, "Pip")).toBe(
      "Always let Pip create and edit files directly in /w/docs",
    );
    expect(ruleText({ _tag: "Paths", operation: "delete-files", paths: ["/w/a", "/w/b"] }, "Pip")).toBe(
      "Always let Pip delete /w/a, /w/b",
    );
    expect(ruleText({ _tag: "Command", operation: "run-commands", cwd: "/w", words: ["pnpm", "test"] }, "Pip")).toBe(
      "Always let Pip run pnpm test in /w",
    );
    expect(ruleText({ _tag: "Host", host: "example.com" }, "Pip")).toBe("Always let Pip use example.com");
    expect(ruleText({ _tag: "Push", cwd: "/w", remote: "git@host:me/app.git", branch: "feature" }, "Pip")).toBe(
      "Always let Pip push /w to feature on git@host:me/app.git",
    );
  });

  it("says a This Task rule for the Task, or for the Quest once a party joins", () => {
    const host = { _tag: "Host", host: "example.com" } as const;
    expect(ruleText(host, "Pip", "task")).toBe("For this Task, let Pip use example.com");
    expect(ruleText(host, "Pip", "quest")).toBe("For this Quest, let Pip use example.com");
  });

  it("quotes words the shell would not read back as written", () => {
    expect(commandText(["rm", "*.tmp"])).toBe("rm '*.tmp'");
    expect(commandText(["echo", "it's here", ""])).toBe(`echo 'it'\\''s here' ''`);
  });
});

describe("runnerNote", () => {
  it("warns that a package script runs what its file says", () => {
    const test: GrantRule = { _tag: "Command", operation: "run-commands", cwd: "/w", words: ["pnpm", "test"] };
    expect(runnerNote([test], "Pip")).toBe(
      "pnpm test runs what this folder's package.json says. If Pip changes that file, the rule runs the new version.",
    );
    expect(runnerNote([{ ...test, words: ["ls", "-la"] }], "Pip")).toBeNull();
  });
});

describe("This Task", () => {
  const TOP = TaskId.make("top");
  const tree = (quests: ReadonlyArray<Quest>) =>
    new TaskTree({
      tasks: [],
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
  const quest = (taskId: TaskId) =>
    new Quest({
      id: QuestId.make(`q-${taskId}`),
      taskId,
      leadId: AgentId.make("aldric"),
      parentQuestId: null,
      threadId: ThreadId.make("t1"),
      goal: "Launch",
      acceptance: [],
      limits: { maxDepth: 2, deadline: null },
      depth: 1,
      state: "active",
      createdAt: "2026-11-02T00:00:00.000Z",
      endedAt: null,
      revision: 1,
    });

  it("is offered only for a request made in a Task that a rule could answer", () => {
    expect(offersThisTask(request({ rootTaskId: TOP }))).toBe(true);
    expect(offersThisTask(request())).toBe(false);
    expect(offersThisTask(request({ rootTaskId: TOP, onceOnly: true }))).toBe(false);
    expect(offersThisTask(request({ rootTaskId: TOP, grantable: false }))).toBe(false);
  });

  it("reads This Quest once a party joins the request's top Task, and This Task before", () => {
    const asked = request({ rootTaskId: TOP });
    expect(workScope(asked, undefined)).toBe("task");
    expect(workScope(asked, tree([]))).toBe("task");
    // A member's own nested Quest sits on another Task: the top Task still has no party.
    expect(workScope(asked, tree([quest(TaskId.make("member"))]))).toBe("task");
    expect(workScope(asked, tree([quest(TOP)]))).toBe("quest");
  });
});
