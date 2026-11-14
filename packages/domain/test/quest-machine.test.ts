import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AgentId,
  IllegalQuestTransition,
  isActiveQuest,
  Quest,
  type QuestEvent,
  QuestId,
  QuestMachine,
  type QuestState,
  QuestState as QuestStateSchema,
  QuestStates,
  type QuestStop,
  TaskId,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

const quest = (state: QuestState) =>
  new Quest({
    id: QuestId.make("quest-1"),
    taskId: TaskId.make("task-1"),
    leadId: "aldric" as AgentId,
    parentQuestId: null,
    threadId: null,
    goal: "Spring launch",
    acceptance: [],
    limits: { maxDepth: 2, deadline: null },
    depth: 1,
    state,
    stop:
      state === "stopping" || state === "stopped" ? { reason: "You asked", summary: "Copy drafted", at: at(0) } : null,
    createdAt: at(0),
    endedAt: state === "active" || state === "paused" || state === "stopping" ? null : at(1),
    revision: 1 as Quest["revision"],
  });

/** What the model tracks of a Quest: every field a rule writes. */
interface QuestView {
  readonly state: QuestState;
  readonly stop: QuestStop | null;
  readonly endedAt: string | null;
}

const view = (q: Quest): QuestView => ({ state: q.state, stop: q.stop, endedAt: q.endedAt });

// ADR 018's rules with #1346's stop, kept apart from the machine: a Quest ends with its Task, a stop
// only comes while it is under way, and a Quest its lead was stopping ends stopped, never completed.
// A paused Quest (#1446) is still under way: it ends, or is stopped, as an active one would.
// complexity-ignore: the model is one case per event, kept apart from the machine on purpose.
const stepModel = (m: QuestView, e: QuestEvent): QuestView | "refused" => {
  const underWay = m.state === "active" || m.state === "paused";
  switch (e._tag) {
    case "Stop":
      return underWay
        ? { ...m, state: "stopping", stop: { reason: e.reason, summary: e.summary, at: e.at } }
        : "refused";
    case "Complete":
      return underWay ? { ...m, state: "completed", endedAt: e.at } : "refused";
    case "Fail":
      return underWay ? { ...m, state: "failed", endedAt: e.at } : "refused";
    case "Cancel":
      if (m.state === "stopping") return { ...m, state: "stopped", endedAt: e.at };
      return underWay ? { ...m, state: "cancelled", endedAt: e.at } : "refused";
    case "Reopen":
      return m.state === "failed" ? { ...m, state: "active", endedAt: null } : "refused";
    case "Pause":
      return m.state === "active" ? { ...m, state: "paused" } : "refused";
    case "Unpause":
      return m.state === "paused" ? { ...m, state: "active" } : "refused";
  }
};

const time = fc.integer({ min: 0, max: 10_000 }).map(at);
const words = fc.constantFrom("You asked to stop", "Not needed any more", "Copy drafted, page not built");
const events: fc.Arbitrary<QuestEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Stop" as const), at: time, reason: words, summary: words }),
  fc.record({ _tag: fc.constant("Complete" as const), at: time }),
  fc.record({ _tag: fc.constant("Fail" as const), at: time }),
  fc.record({ _tag: fc.constant("Cancel" as const), at: time }),
  fc.record({ _tag: fc.constant("Reopen" as const), at: time }),
  fc.record({ _tag: fc.constant("Pause" as const), at: time }),
  fc.record({ _tag: fc.constant("Unpause" as const), at: time }),
);

describe("QuestMachine", () => {
  it("[TC-OR-1346-01] [TC-OR-1446-02] agrees with a model of a Quest's end and its lead's stop over random runs of events", () => {
    agreesWithModel({
      machine: QuestMachine,
      records: fc.constantFrom(...QuestStateSchema.literals).map(quest),
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalQuestTransition => result instanceof IllegalQuestTransition,
    });
  });

  it("[TC-OR-1346-02] ends a Quest its lead was stopping as stopped, never completed or cancelled", () => {
    const stopping = QuestMachine.transition(quest("active"), {
      _tag: "Stop",
      at: at(3),
      reason: "You asked to stop",
      summary: "Copy drafted",
    });
    if (stopping instanceof IllegalQuestTransition) throw stopping;
    expect(stopping).toMatchObject({ state: "stopping", endedAt: null, stop: { summary: "Copy drafted" } });
    expect(isActiveQuest(stopping.state)).toBe(true);
    expect(QuestStates.takesWork(stopping)).toBe(false);
    expect(QuestMachine.transition(stopping, { _tag: "Complete", at: at(4) })).toBeInstanceOf(IllegalQuestTransition);
    const ended = QuestMachine.transition(stopping, { _tag: "Cancel", at: at(4) });
    expect(ended).toMatchObject({ state: "stopped", endedAt: at(4) });
    expect(QuestStates.stoppedByLead(ended as Quest)).toBe(true);
    expect(isActiveQuest("stopped")).toBe(false);
  });

  it("exports one row per rule", () => {
    expect(QuestMachine.table.map((row) => [row.event, row.from, row.to])).toEqual([
      ["Stop", ["active", "paused"], "stopping"],
      ["Complete", ["active", "paused"], "completed"],
      ["Fail", ["active", "paused"], "failed"],
      ["Cancel", ["stopping"], "stopped"],
      ["Cancel", ["active", "paused"], "cancelled"],
      ["Pause", ["active"], "paused"],
      ["Unpause", ["paused"], "active"],
      ["Reopen", ["failed"], "active"],
    ]);
  });

  it("reads a Quest journaled before its stop was recorded as never stopped", () => {
    const { stop: _, ...before } = Schema.encodeSync(Quest)(quest("active"));
    expect(Schema.decodeUnknownSync(Quest)(before).stop).toBeNull();
  });
});
