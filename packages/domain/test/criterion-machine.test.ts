import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  Criteria,
  Criterion,
  type CriterionDecision,
  type CriterionEvent,
  CriterionId,
  CriterionMachine,
  type CriterionState,
  CriterionState as CriterionStateSchema,
  type Evidence,
  HUB_ACTOR,
  IllegalCriterionTransition,
  OWNER_ACTOR,
  Quest,
  QuestId,
  RegisteredArtifactId,
  TaskId,
  unmetCriteria,
  unmetCriteriaText,
} from "../src/index.ts";
import { agreesWithModel } from "../testing/machine-model.ts";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 13) + minute * 60_000).toISOString();

const PAGE = RegisteredArtifactId.make("artifact-page");
const COPY = RegisteredArtifactId.make("artifact-copy");
const LEAD: Actor = { kind: "hob", id: "aldric" };

const proof = (artifactId: RegisteredArtifactId, version: number): Evidence => ({
  artifactId,
  version,
  taskId: TaskId.make("task-2"),
  label: artifactId === PAGE ? "index.html" : "copy.md",
  voidedAt: null,
});

const criterion = (state: CriterionState, required: boolean, evidence: ReadonlyArray<Evidence>) =>
  new Criterion({
    id: CriterionId.make("criterion-1"),
    text: "The page loads on a phone",
    required,
    taskIds: [],
    state,
    evidence: state === "accepted" ? evidence : [],
    decided: state === "open" ? null : { by: LEAD, reason: "Checked", at: at(0) },
  });

/** What the model tracks of a criterion: every field a rule writes. */
interface CriterionView {
  readonly state: CriterionState;
  readonly required: boolean;
  readonly evidence: ReadonlyArray<Evidence>;
  readonly decided: CriterionDecision | null;
}

const view = (c: Criterion): CriterionView => ({
  state: c.state,
  required: c.required,
  evidence: c.evidence,
  decided: c.decided,
});

const isReplaced = (each: Evidence, artifactId: RegisteredArtifactId, version: number) =>
  each.voidedAt === null && each.artifactId === artifactId && each.version < version;

const voidModel = (m: CriterionView, e: Extract<CriterionEvent, { _tag: "Void" }>): CriterionView | "refused" => {
  if (m.state !== "accepted" || !m.evidence.some((each) => isReplaced(each, e.artifactId, e.version))) {
    return "refused";
  }
  const label = m.evidence.find((each) => isReplaced(each, e.artifactId, e.version))?.label;
  return {
    ...m,
    state: "open",
    evidence: m.evidence.map((each) =>
      isReplaced(each, e.artifactId, e.version) ? { ...each, voidedAt: e.at } : each,
    ),
    decided: {
      by: HUB_ACTOR,
      reason: `Version ${e.version} of ${label} replaced the version it was accepted on`,
      at: e.at,
    },
  };
};

// #1445's rules, kept apart from the machine: acceptance needs evidence, only you waive a required
// criterion, and only a newer version of evidence it was accepted on voids an accepted criterion.
const stepModel = (m: CriterionView, e: CriterionEvent): CriterionView | "refused" => {
  switch (e._tag) {
    case "Accept":
      if ((m.state !== "open" && m.state !== "needs-rework") || e.evidence.length === 0) return "refused";
      return { ...m, state: "accepted", evidence: e.evidence, decided: { by: e.by, reason: e.reason, at: e.at } };
    case "Rework":
      if (m.state !== "open" && m.state !== "accepted") return "refused";
      return { ...m, state: "needs-rework", decided: { by: e.by, reason: e.reason, at: e.at } };
    case "Waive":
      if (m.state === "waived" || (m.required && e.by.kind !== "user")) return "refused";
      return { ...m, state: "waived", decided: { by: e.by, reason: e.reason, at: e.at } };
    case "Void":
      return voidModel(m, e);
  }
};

const time = fc.integer({ min: 0, max: 10_000 }).map(at);
const version = fc.integer({ min: 1, max: 4 });
const artifact = fc.constantFrom(PAGE, COPY);
const actor = fc.constantFrom<Actor>(LEAD, OWNER_ACTOR, { kind: "hob", id: "quill" });
const reason = fc.constantFrom("Loads in 1.2s on a phone", "The hero image is cut off", "You said it can wait");
const evidence = fc.uniqueArray(
  fc.record({ artifactId: artifact, version }).map(({ artifactId, version: v }) => proof(artifactId, v)),
  { maxLength: 2, selector: (each) => each.artifactId },
);
const events: fc.Arbitrary<CriterionEvent> = fc.oneof(
  fc.record({ _tag: fc.constant("Accept" as const), by: actor, reason, at: time, evidence }),
  fc.record({ _tag: fc.constant("Rework" as const), by: actor, reason, at: time }),
  fc.record({ _tag: fc.constant("Waive" as const), by: actor, reason, at: time }),
  fc.record({ _tag: fc.constant("Void" as const), artifactId: artifact, version, at: time }),
);

const records = fc
  .record({ state: fc.constantFrom(...CriterionStateSchema.literals), required: fc.boolean(), evidence })
  .filter(({ state, evidence: given }) => state !== "accepted" || given.length > 0)
  .map(({ state, required, evidence: given }) => criterion(state, required, given));

describe("CriterionMachine", () => {
  it("[TC-OR-1445-01] agrees with a model of a criterion's checks over random runs of events", () => {
    agreesWithModel({
      machine: CriterionMachine,
      records,
      events,
      model: { init: view, step: stepModel, view },
      isError: (result): result is IllegalCriterionTransition => result instanceof IllegalCriterionTransition,
    });
  });

  it("[TC-OR-1445-02] voids evidence a newer version replaced, and only that, reopening the criterion", () => {
    const accepted = Criteria.transition(criterion("open", true, []), {
      _tag: "Accept",
      by: LEAD,
      reason: "Loads on a phone",
      at: at(1),
      evidence: [proof(PAGE, 2), proof(COPY, 1)],
    });
    if (!(accepted instanceof Criterion)) throw accepted;
    // The same version, or an older one, voids nothing.
    expect(Criteria.can(accepted, { _tag: "Void", artifactId: PAGE, version: 2, at: at(2) })).toBe(false);
    const voided = Criteria.transition(accepted, { _tag: "Void", artifactId: PAGE, version: 3, at: at(2) });
    if (!(voided instanceof Criterion)) throw voided;
    expect(voided.state).toBe("open");
    expect(voided.evidence).toEqual([{ ...proof(PAGE, 2), voidedAt: at(2) }, proof(COPY, 1)]);
    expect(voided.decided).toMatchObject({ by: HUB_ACTOR, at: at(2) });
    expect(unmetCriteria([voided])).toEqual([voided]);
    expect(unmetCriteriaText("task-1", [voided])).toContain("its evidence was voided by a newer version");
  });

  it("[TC-OR-1445-03] lets only you waive a required criterion, and a lead waive an optional one", () => {
    const waive = (by: Actor) => ({ _tag: "Waive" as const, by, reason: "Not needed", at: at(1) });
    expect(Criteria.transition(criterion("open", true, []), waive(LEAD))).toBeInstanceOf(IllegalCriterionTransition);
    expect(Criteria.transition(criterion("open", true, []), waive(OWNER_ACTOR))).toMatchObject({ state: "waived" });
    expect(Criteria.transition(criterion("open", false, []), waive(LEAD))).toMatchObject({ state: "waived" });
    expect(Criteria.holdsOpen(criterion("open", false, []))).toBe(false);
    expect(Criteria.holdsOpen(criterion("needs-rework", true, []))).toBe(true);
  });

  it("exports one row per rule", () => {
    expect(CriterionMachine.table.map((row) => [row.event, row.from, row.to, row.guarded])).toEqual([
      ["Accept", ["open", "needs-rework"], "accepted", true],
      ["Rework", ["open", "accepted"], "needs-rework", false],
      ["Waive", ["open", "accepted", "needs-rework"], "waived", true],
      ["Void", ["accepted"], "open", true],
    ]);
  });

  it("reads a Quest journaled before criteria existed as having none", () => {
    const quest = Quest.make({
      id: QuestId.make("quest-1"),
      taskId: TaskId.make("task-1"),
      leadId: "aldric" as Quest["leadId"],
      parentQuestId: null,
      threadId: null,
      goal: "Spring launch",
      acceptance: ["The page loads on a phone"],
      limits: { maxDepth: 2, deadline: null },
      depth: 1,
      state: "active",
      createdAt: at(0),
      endedAt: null,
      revision: 1 as Quest["revision"],
    });
    const { criteria: _, ...before } = Schema.encodeSync(Quest)(quest);
    expect(Schema.decodeUnknownSync(Quest)(before).criteria).toEqual([]);
  });
});
