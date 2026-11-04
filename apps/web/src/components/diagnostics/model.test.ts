import type { QuestTrace, StalledWork } from "@hobbots/api";
import { AgentId, AttemptId, DelegationId, QuestId, RuntimeHealth, TaskId } from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { eventLabel, recoveryText, runtimeFix, stalledText, traceRows, triesText } from "./model.ts";

const now = new Date("2026-11-02T12:00:00.000Z");
const names: Record<string, string> = { aldric: "Aldric", ada: "Ada" };
const hobName = (id: string) => names[id] ?? "a hob";

const enforcement = { status: "verified", evidence: "" } as const;
const health = (availability: RuntimeHealth["availability"], version: string | null) =>
  new RuntimeHealth({
    runtime: "claude-code",
    availability,
    billing: null,
    version,
    detail: null,
    checkedAt: null,
    enforcement: {
      toolInterception: enforcement,
      processSandbox: enforcement,
      hubTools: enforcement,
      toolEvents: enforcement,
      toolInterruption: enforcement,
    },
  });

describe("Diagnostics copy", () => {
  it("says what to do about a runtime that cannot think", () => {
    expect(runtimeFix(health("ready", "2.1.0"))).toBeNull();
    expect(runtimeFix(health("signedOut", "2.1.0"))).toBe(
      "Claude Code is installed but not signed in. Open it in a terminal and sign in.",
    );
    expect(runtimeFix(health("unavailable", null))).toMatch(/^Claude Code was not found/);
  });

  it("names the hob and how long ago stalled work last moved", () => {
    const stalled: StalledWork = {
      kind: "noProgress",
      agentId: AgentId.make("ada"),
      taskId: TaskId.make("build"),
      questId: QuestId.make("q1"),
      attemptId: AttemptId.make("a1"),
      itemId: null,
      since: "2026-11-02T10:00:00.000Z",
    };
    expect(stalledText(stalled, hobName, now)).toBe(
      "Ada has recorded nothing on this task since 2 hours ago. Open its quest to check on it, or cancel the task and retry it.",
    );
    expect(stalledText({ ...stalled, agentId: AgentId.make("gone") }, hobName, now)).toMatch(/^a hob has/);
  });

  it("words recovery errors, journal types and tries", () => {
    expect(
      recoveryText({
        step: "endAttempt",
        tag: "SqlError",
        message: "database is locked",
        taskId: null,
        attemptId: null,
        at: now.toISOString(),
      }),
    ).toBe(
      "Hobbots could not end a try left running before it stopped (SqlError: database is locked). Open its quest and cancel or retry the task.",
    );
    expect(eventLabel("QuestStarted")).toBe("Quest started");
    expect(eventLabel("SomethingNew")).toBe("SomethingNew");
    expect([triesText(1), triesText(3)]).toEqual(["1 try", "3 tries"]);
  });
});

describe("traceRows", () => {
  it("lists a Quest's Tasks depth first with each one's Delegation, tries and backpack items", () => {
    const task = (id: string, parentId: string | null, brief: string) => ({
      id: TaskId.make(id),
      ownerId: AgentId.make(id === "campaign" ? "aldric" : "ada"),
      parentId: parentId === null ? null : TaskId.make(parentId),
      rootId: TaskId.make("campaign"),
      threadId: null,
      brief,
      state: "active" as const,
      dependsOn: [],
      result: null,
      currentAttemptId: null,
      createdAt: "",
      updatedAt: "",
      revision: 1,
    });
    const trace = {
      quest: {},
      tree: {
        tasks: [
          task("campaign", null, "Plan it\nwith care"),
          task("build", "campaign", "Build it"),
          task("copy", "campaign", "Write it"),
          task("headline", "build", "Name it"),
        ],
        delegations: [{ id: DelegationId.make("d1"), childTaskId: TaskId.make("build") }],
        attempts: [{ id: AttemptId.make("a1"), taskId: TaskId.make("build") }],
      },
      backpack: [{ id: "i1", taskId: TaskId.make("copy") }],
      journal: [],
    } as unknown as QuestTrace;

    expect(
      traceRows(trace).map((row) => [
        row.title,
        row.depth,
        row.delegation?.id ?? null,
        row.attempts.length,
        row.items.length,
      ]),
    ).toEqual([
      ["Plan it", 0, null, 0, 0],
      ["Build it", 1, "d1", 1, 0],
      ["Name it", 2, null, 0, 0],
      ["Write it", 1, null, 0, 1],
    ]);
  });
});
