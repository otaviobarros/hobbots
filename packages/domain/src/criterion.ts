import { Schema } from "effect";
import { Actor, HUB_ACTOR } from "./actor.ts";
import { RegisteredArtifactId, TaskId } from "./ids.ts";
import { defineMachine } from "./machine.ts";

/**
 * A Quest's acceptance criteria, checked against evidence (#1445). Each criterion has an id, is
 * required or optional, and is linked to the Tasks that work towards it and the artifacts that prove
 * it. Its lead accepts it with evidence, sends it back for rework, or waives it; only you waive a
 * required one. Evidence names one version of an artifact, and a newer version voids it, so the
 * criterion is open again. A Quest completes only once each required criterion is accepted or waived.
 */

export const CriterionId = Schema.String.pipe(Schema.brand("CriterionId"));
export type CriterionId = typeof CriterionId.Type;

/** Where a criterion stands, held by `CriterionMachine`. */
export const CriterionState = Schema.Literals(["open", "accepted", "needs-rework", "waived"]);
export type CriterionState = typeof CriterionState.Type;

/**
 * One artifact version a criterion was accepted on: the registered artifact, the version checked,
 * the Task that made it (null for one no Task made) and what it is called. `voidedAt` is when a newer
 * version replaced it; voided evidence proves nothing.
 */
export const Evidence = Schema.Struct({
  artifactId: RegisteredArtifactId,
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  taskId: Schema.NullOr(TaskId),
  label: Schema.String,
  voidedAt: Schema.NullOr(Schema.String),
});
export type Evidence = typeof Evidence.Type;

/** Who last changed a criterion's state, why and when. */
export const CriterionDecision = Schema.Struct({
  by: Actor,
  reason: Schema.String,
  at: Schema.String,
});
export type CriterionDecision = typeof CriterionDecision.Type;

export class Criterion extends Schema.Class<Criterion>("Criterion")({
  id: CriterionId,
  /** What has to hold, as its lead wrote it. */
  text: Schema.String,
  /** A required criterion holds the Quest open until it is accepted or you waive it. */
  required: Schema.Boolean,
  /** The Tasks its lead gave work towards it. */
  taskIds: Schema.Array(TaskId),
  /** Only `CriterionMachine` changes it, and code outside reads it through `Criteria`. */
  state: CriterionState,
  /** The artifact versions it was last accepted on, voided ones included. */
  evidence: Schema.Array(Evidence),
  /** The last change to its state; null while nobody has checked it. */
  decided: Schema.NullOr(CriterionDecision),
}) {}

/** What can happen to a criterion. */
export type CriterionEvent =
  /** Its lead checked it against the evidence, which holds. */
  | {
      readonly _tag: "Accept";
      readonly by: Actor;
      readonly reason: string;
      readonly at: string;
      readonly evidence: ReadonlyArray<Evidence>;
    }
  /** Its lead found the work does not meet it yet. */
  | { readonly _tag: "Rework"; readonly by: Actor; readonly reason: string; readonly at: string }
  /** It no longer has to hold: you waive any criterion, its lead only an optional one. */
  | { readonly _tag: "Waive"; readonly by: Actor; readonly reason: string; readonly at: string }
  /** A newer version of an artifact it was accepted on replaced the one checked. */
  | {
      readonly _tag: "Void";
      readonly artifactId: RegisteredArtifactId;
      readonly version: number;
      readonly at: string;
    };

/** A change to a criterion its state or its rules do not allow. */
export class IllegalCriterionTransition extends Schema.TaggedError<IllegalCriterionTransition>()(
  "IllegalCriterionTransition",
  { criterionId: CriterionId, from: CriterionState, to: CriterionState },
) {}

/** Whether a piece of evidence is a version older than `version` of `artifactId`, and not voided yet. */
const replacedBy = (evidence: Evidence, artifactId: RegisteredArtifactId, version: number) =>
  evidence.voidedAt === null && evidence.artifactId === artifactId && evidence.version < version;

const decided = (criterion: Criterion, state: CriterionState, by: Actor, reason: string, at: string) =>
  new Criterion({ ...criterion, state, decided: { by, reason, at } });

/** A criterion's checks (#1445), declared once. */
export const CriterionMachine = defineMachine<CriterionState, CriterionEvent, Criterion, IllegalCriterionTransition>({
  name: "Criterion",
  states: {
    open: "Nobody has checked it yet, or a newer version voided the evidence it was accepted on",
    accepted: "Its lead checked it against evidence that still holds",
    "needs-rework": "Its lead found the work does not meet it yet",
    waived: "It no longer has to hold: you waived it, or its lead waived an optional one",
  },
  field: "state",
  events: {
    // Acceptance always names evidence.
    Accept: {
      from: ["open", "needs-rework"],
      to: "accepted",
      guard: (_, e) => e.evidence.length > 0,
      apply: (criterion, e) =>
        new Criterion({
          ...decided(criterion, "accepted", e.by, e.reason, e.at),
          evidence: e.evidence,
        }),
    },
    Rework: {
      from: ["open", "accepted"],
      to: "needs-rework",
      apply: (criterion, e) => decided(criterion, "needs-rework", e.by, e.reason, e.at),
    },
    // Only you waive a required criterion.
    Waive: {
      from: ["open", "accepted", "needs-rework"],
      to: "waived",
      guard: (criterion, e) => !criterion.required || e.by.kind === "user",
      apply: (criterion, e) => decided(criterion, "waived", e.by, e.reason, e.at),
    },
    // Only evidence it was accepted on, and only a newer version of it, voids it.
    Void: {
      from: ["accepted"],
      to: "open",
      guard: (criterion, e) => criterion.evidence.some((each) => replacedBy(each, e.artifactId, e.version)),
      apply: (criterion, e) => {
        const voided = criterion.evidence.find((each) => replacedBy(each, e.artifactId, e.version));
        return new Criterion({
          ...decided(
            criterion,
            "open",
            HUB_ACTOR,
            `Version ${e.version} of ${voided?.label ?? "an artifact"} replaced the version it was accepted on`,
            e.at,
          ),
          evidence: criterion.evidence.map((each) =>
            replacedBy(each, e.artifactId, e.version) ? { ...each, voidedAt: e.at } : each,
          ),
        });
      },
    },
  },
  illegal: (criterion, _, to) =>
    new IllegalCriterionTransition({ criterionId: criterion.id, from: criterion.state, to }),
});

/** `CriterionMachine` with the questions code outside this module asks of a criterion's state. */
export const Criteria = {
  ...CriterionMachine,
  /** Whether it still holds its Quest open: required, and neither accepted nor waived. */
  holdsOpen: (criterion: Pick<Criterion, "required" | "state">): boolean =>
    criterion.required && criterion.state !== "accepted" && criterion.state !== "waived",
  /** Whether it is settled for now: accepted or waived. */
  settled: (criterion: Pick<Criterion, "state">): boolean =>
    criterion.state === "accepted" || criterion.state === "waived",
};

/** The criteria that still hold a Quest open, in order. */
export const unmetCriteria = (criteria: ReadonlyArray<Criterion>): ReadonlyArray<Criterion> =>
  criteria.filter(Criteria.holdsOpen);

/** What a criterion is waiting on, in a few words, for a lead to read. */
const waitsOn = (criterion: Criterion) =>
  criterion.state === "needs-rework"
    ? "needs rework"
    : criterion.decided !== null && criterion.decided.by.kind === "hub"
      ? "its evidence was voided by a newer version"
      : "not checked yet";

/**
 * Why a Quest cannot complete while required criteria are unmet, and what its lead does about it:
 * check each against evidence, or ask you to waive it.
 */
export const unmetCriteriaText = (taskId: string, unmet: ReadonlyArray<Criterion>): string =>
  `Task ${taskId} is not complete: its Quest has required acceptance criteria that are neither accepted nor waived: ` +
  unmet.map((each) => `${each.id} "${each.text}" (${waitsOn(each)})`).join("; ") +
  ". Check each with check_criterion, accepted with the artifacts that prove it as evidence, " +
  "or finish the work it needs. Only the user waives a required criterion: ask them with ask, and call check_criterion with waived in the turn their answer wakes.";
