import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ChapterId,
  DECISION_TEXT_MAX,
  Decision,
  type DecisionEvent,
  DecisionId,
  DecisionRefused,
  type DecisionState,
  DecisionStateMachine,
  DecisionStates,
  IllegalDecisionTransition,
  MessageId,
  OWNER_ACTOR,
  planCrossOut,
  planDecision,
  ThreadId,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const THREAD = ThreadId.make("thread-1");
const CHAPTER = ChapterId.make("chapter-1");
const at = (minute: number) => new Date(Date.UTC(2026, 10, 12) + minute * 60_000).toISOString();

const decision = (id: string, state: DecisionState = "active") =>
  new Decision({
    id: DecisionId.make(id),
    threadId: THREAD,
    chapterId: CHAPTER,
    sourceMessageId: MessageId.make("message-1"),
    text: "Launch emails go out on Tuesdays.",
    actor: { kind: "hob", id: "hob-1" },
    state,
    supersededBy: state === "superseded" ? DecisionId.make("decision-9") : null,
    recordedAt: at(0),
    supersededAt: state === "superseded" ? at(1) : null,
  });

/** What the model tracks of a decision: every field a rule writes. */
interface DecisionView {
  readonly state: DecisionState;
  readonly supersededBy: string | null;
  readonly supersededAt: string | null;
}

const view = (d: Decision): DecisionView => ({
  state: d.state,
  supersededBy: d.supersededBy,
  supersededAt: d.supersededAt,
});

// ADR 037's rule, kept apart from the machine: an active decision is crossed out once, by another
// decision or by nothing, and a crossed-out one never holds again.
const stepModel =
  (self: string) =>
  (m: DecisionView, e: DecisionEvent): DecisionView | "refused" =>
    m.state === "active" && e.by !== self ? { state: "superseded", supersededBy: e.by, supersededAt: e.at } : "refused";

const events: fc.Arbitrary<DecisionEvent> = fc.record({
  _tag: fc.constant("Supersede" as const),
  by: fc.option(fc.constantFrom("decision-1", "decision-2", "decision-3").map(DecisionId.make), { nil: null }),
  at: fc.integer({ min: 0, max: 10_000 }).map(at),
});

describe("DecisionStateMachine", () => {
  it("agrees with a model of crossing out over random runs of events", () => {
    agreesWithModel({
      machine: DecisionStateMachine,
      records: fc.constantFrom<DecisionState>("active", "superseded").map((state) => decision("decision-1", state)),
      events,
      model: { init: view, step: stepModel("decision-1"), view },
      isError: (result): result is IllegalDecisionTransition => result instanceof IllegalDecisionTransition,
    });
  });

  it("exports one row per event", () => {
    expect(DecisionStateMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Supersede", ["active"], "superseded", true],
    ]);
  });

  it("never brings a crossed-out decision back and never lets one replace itself", () => {
    const crossed = decision("decision-1", "superseded");
    expect(DecisionStates.can(crossed, { _tag: "Supersede", by: null, at: at(2) })).toBe(false);
    const active = decision("decision-1");
    expect(DecisionStates.transition(active, { _tag: "Supersede", by: active.id, at: at(2) })).toBeInstanceOf(
      IllegalDecisionTransition,
    );
    expect(DecisionStates.isActive(active)).toBe(true);
    expect(DecisionStates.isActive(crossed)).toBe(false);
  });
});

const draft = (fields: Partial<Parameters<typeof planDecision>[0]> = {}): Parameters<typeof planDecision>[0] => ({
  id: DecisionId.make("decision-2"),
  threadId: THREAD,
  chapterId: CHAPTER,
  sourceMessageId: null,
  text: "  Ship on Friday.  ",
  actor: OWNER_ACTOR,
  at: at(5),
  threadOpen: true,
  ...fields,
});

describe("decision rules", () => {
  it("records a trimmed decision, active, by its actor", () => {
    const plan = planDecision(draft());
    expect(plan).not.toBeInstanceOf(DecisionRefused);
    if (plan instanceof DecisionRefused) return;
    expect(plan.superseded).toBeNull();
    expect(plan.recorded).toMatchObject({
      text: "Ship on Friday.",
      state: "active",
      actor: OWNER_ACTOR,
      recordedAt: at(5),
    });
  });

  it("refuses an empty decision and one over the limit, and takes one at the limit", () => {
    expect(planDecision(draft({ text: "   " }))).toMatchObject({ reason: "empty-text" });
    expect(planDecision(draft({ text: "x".repeat(DECISION_TEXT_MAX + 1) }))).toMatchObject({ reason: "too-long" });
    expect(planDecision(draft({ text: "x".repeat(DECISION_TEXT_MAX) }))).not.toBeInstanceOf(DecisionRefused);
  });

  it("refuses a decision in a closed chat or camp", () => {
    expect(planDecision(draft({ threadOpen: false }))).toMatchObject({ reason: "thread-closed" });
    expect(planCrossOut(decision("decision-1"), at(5), false)).toMatchObject({ reason: "thread-closed" });
  });

  it("crosses out the decision it replaces, pointing at the new one, at the same moment", () => {
    const plan = planDecision(draft({ replaces: decision("decision-1") }));
    if (plan instanceof DecisionRefused) throw plan;
    expect(plan.superseded).toMatchObject({
      id: "decision-1",
      state: "superseded",
      supersededBy: "decision-2",
      supersededAt: at(5),
      text: "Launch emails go out on Tuesdays.",
    });
  });

  it("refuses to replace a decision that is not there, was crossed out, or is itself", () => {
    expect(planDecision(draft({ replaces: null }))).toMatchObject({ reason: "not-found" });
    expect(planDecision(draft({ replaces: decision("decision-1", "superseded") }))).toMatchObject({
      reason: "superseded",
    });
    expect(planDecision(draft({ replaces: decision("decision-2") }))).toMatchObject({ reason: "not-found" });
  });

  it("crosses a decision out with nothing in its place, once", () => {
    const crossed = planCrossOut(decision("decision-1"), at(7), true);
    expect(crossed).toMatchObject({ state: "superseded", supersededBy: null, supersededAt: at(7) });
    expect(planCrossOut(decision("decision-1", "superseded"), at(8), true)).toMatchObject({ reason: "superseded" });
    expect(planCrossOut(null, at(8), true)).toMatchObject({ reason: "not-found" });
  });
});
