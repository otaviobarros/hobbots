import {
  AgentId,
  DEFAULT_QUEST_LIMITS,
  Quest,
  QuestId,
  Task,
  TaskId,
  type TaskState,
  TaskTree,
  ThreadId,
} from "@hobbots/domain";
import { describe, expect, it } from "vitest";
import { COMMIT_RULE, memberPrompt, ownerBriefing, stepPrompt } from "../src/briefs.ts";

// Issue #742: with no identity to commit with, Nettle asked its lead, the leads invented one and
// prescribed a form the hub refuses, and Frodo committed Nettle's work as its own bot. Every brief
// that can commit now says how commits are made, before any hob has to ask: a lead's, a member's
// and a step's.

const at = "2026-11-07T00:00:00.000Z";
const FRODO = AgentId.make("frodo");
const NETTLE = AgentId.make("nettle");

const task = (id: string, ownerId: AgentId, parentId: string | null, state: TaskState = "active") =>
  new Task({
    id: TaskId.make(id),
    ownerId,
    parentId: parentId === null ? null : TaskId.make(parentId),
    rootId: TaskId.make("ledger"),
    threadId: parentId === null ? ThreadId.make("chat") : null,
    brief: `Brief for ${id}`,
    state,
    dependsOn: [],
    result: null,
    currentAttemptId: null,
    createdAt: at,
    updatedAt: at,
    revision: 1,
  });

const quest = new Quest({
  id: QuestId.make("q"),
  taskId: TaskId.make("ledger"),
  leadId: FRODO,
  parentQuestId: null,
  threadId: ThreadId.make("chat"),
  goal: "Keep a pocket ledger",
  acceptance: [],
  limits: DEFAULT_QUEST_LIMITS,
  depth: 1,
  state: "active",
  createdAt: at,
  endedAt: null,
  revision: 1,
});

const tree = new TaskTree({
  tasks: [
    task("ledger", FRODO, null, "waiting"),
    task("build", NETTLE, "ledger"),
    task("draft", NETTLE, "build"),
    task("check", NETTLE, "build", "queued"),
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

const nth = (index: number) => tree.tasks[index] as Task;

describe("how commits are made, as every brief that can commit says", () => {
  // covers OR-003, OR-004
  it("[TC-OR-742-01] the lead's briefing, a member's prompt and a step's prompt each carry the commit rule", () => {
    const briefs = {
      lead: ownerBriefing(nth(0), tree),
      member: memberPrompt(nth(1), tree, "Frodo"),
      step: stepPrompt(nth(2), tree),
    };
    for (const brief of Object.values(briefs)) expect(brief).toContain(COMMIT_RULE);
    // No hob prescribes an identity, asks another hob for one, or commits another hob's work.
    expect(COMMIT_RULE).toContain("you cannot set or change it");
    expect(COMMIT_RULE).toContain("never ask one: when none is set, Hobbots asks the user itself");
    expect(COMMIT_RULE).toContain("never a member's");
  });
});
