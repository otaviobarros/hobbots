import {
  AgentId,
  BackpackItem,
  BackpackItemId,
  type BackpackItemKind,
  type BackpackPayload,
  Task,
  TaskId,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { startingText } from "../src/index.ts";

// Review of #646 (#574): what a member's first turn on its Task is told of what it carries besides
// the Task itself.

const at = "2026-11-03T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const PIP = AgentId.make("pip");
const threadId = ThreadId.make("chat");

const migrate = new Task({
  id: TaskId.make("migrate"),
  ownerId: PIP,
  parentId: TaskId.make("ship"),
  rootId: TaskId.make("ship"),
  threadId,
  brief: "Run the migration",
  state: "active",
  dependsOn: [],
  result: null,
  currentAttemptId: null,
  createdAt: at,
  updatedAt: at,
  revision: 1,
});

const item = (kind: BackpackItemKind, payload: BackpackPayload) =>
  new BackpackItem({
    id: BackpackItemId.make(`${kind}-migrate`),
    recipientId: PIP,
    kind,
    actionable: kind !== "progress",
    priority: 1,
    state: "pending",
    taskId: migrate.id,
    questId: null,
    attemptId: null,
    threadId,
    dedupeKey: kind,
    payload,
    notBefore: null,
    claim: null,
    fencingToken: 0,
    deliveries: [],
    blockers: [],
    disposition: null,
    error: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const assignment = item("task", { _tag: "task", task: migrate, delegation: null });
const message = item("message", { _tag: "message", senderId: FRODO, text: "The staging database is back." });

describe("what a member's first turn is told besides its Task", () => {
  // covers IN-001, IN-004
  it("[TC-OR-260] lists what arrived before the turn started, leaves out the Task itself, and is empty when nothing else waits", () => {
    const text = startingText([assignment, message]);
    expect(text).toMatch(/^Hobbots wrote this, not the user\. This also arrived for you before you started:/);
    expect(text).toContain("The staging database is back.");
    expect(text).not.toContain("is yours to work on");
    expect(startingText([assignment])).toBe("");
    expect(startingText([])).toBe("");
  });
});
