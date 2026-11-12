import { Schema } from "effect";
import { Actor } from "./actor.ts";
import { ChapterId, MessageId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";

/**
 * Decisions (ADR 037, Records): what a chat or camp settled, kept as a record so a turn, the camp
 * sheet and find read it instead of the transcript. A changed decision is never edited: it is
 * superseded, kept and crossed out, and the decision that replaced it is a record of its own.
 */

export const DecisionId = Schema.String.pipe(Schema.brand("DecisionId"));
export type DecisionId = typeof DecisionId.Type;

/** The most characters a decision takes; `record_decision` refuses a longer one (ADR 037). */
export const DECISION_TEXT_MAX = 500;

/** Where a decision stands, held by `DecisionStateMachine`. */
export const DecisionState = Schema.Literals(["active", "superseded"]);
export type DecisionState = typeof DecisionState.Type;

export class Decision extends Schema.Class<Decision>("Decision")({
  id: DecisionId,
  /** The chat or camp it was made in, and its chapter there. */
  threadId: ThreadId,
  chapterId: ChapterId,
  /** The message whose turn recorded it, or null for one you recorded in the app. */
  sourceMessageId: Schema.NullOr(MessageId),
  /** What was decided, at most `DECISION_TEXT_MAX` characters, never edited. */
  text: Schema.String,
  actor: Actor,
  /** Only `DecisionStateMachine` changes it, and code outside reads it through `DecisionStates`. */
  state: DecisionState,
  /** The decision that replaced it, or null: still active, or crossed out with nothing in its place. */
  supersededBy: Schema.NullOr(DecisionId),
  recordedAt: Schema.String,
  /** When it was crossed out, or null while it is active. */
  supersededAt: Schema.NullOr(Schema.String),
  revision: Revision,
}) {}

/** What can happen to a decision: it is crossed out, replaced by `by` or by nothing. */
export type DecisionEvent = { readonly _tag: "Supersede"; readonly by: DecisionId | null; readonly at: string };

/** A change to a decision its state does not allow. */
export class IllegalDecisionTransition extends Schema.TaggedError<IllegalDecisionTransition>()(
  "IllegalDecisionTransition",
  { decisionId: DecisionId, from: DecisionState, to: DecisionState },
) {}

/** A decision's lifecycle (ADR 037), declared once. A superseded decision stays superseded. */
export const DecisionStateMachine = defineMachine<DecisionState, DecisionEvent, Decision, IllegalDecisionTransition>({
  name: "DecisionState",
  states: {
    active: "It holds: the context pack carries it, and the sheet shows it as decided",
    superseded: "It no longer holds: kept and shown crossed out, never in the pack",
  },
  field: "state",
  events: {
    // A decision never replaces itself.
    Supersede: {
      from: ["active"],
      to: "superseded",
      guard: (decision, e) => e.by !== decision.id,
      apply: (decision, e) =>
        new Decision({ ...decision, state: "superseded", supersededBy: e.by, supersededAt: e.at }),
    },
  },
  illegal: (decision, _, to) => new IllegalDecisionTransition({ decisionId: decision.id, from: decision.state, to }),
});

/** `DecisionStateMachine` with the questions code outside this module asks of a decision's state. */
export const DecisionStates = {
  ...DecisionStateMachine,
  isActive: (decision: Decision): boolean => decision.state === "active",
  /** Whether a decision in this state holds, for a copy of a decision that carries only its state. */
  holds: (state: DecisionState): boolean => state === "active",
};

/**
 * Why a decision was not recorded or crossed out. `empty-text`: it has no text. `too-long`: it is
 * longer than `DECISION_TEXT_MAX`. `thread-closed`: its chat or camp is archived or superseded.
 * `not-found`: the decision to replace or cross out is not in this chat or camp. `superseded`: it
 * was crossed out already. `key-reused`: the key was used for another decision.
 */
export const DecisionRefusal = Schema.Literals([
  "empty-text",
  "too-long",
  "thread-closed",
  "not-found",
  "superseded",
  "key-reused",
]);
export type DecisionRefusal = typeof DecisionRefusal.Type;

/** A decision command that changed nothing, with words the hob or you can act on. */
export class DecisionRefused extends Schema.TaggedError<DecisionRefused>()("DecisionRefused", {
  reason: DecisionRefusal,
  message: Schema.String,
}) {}

/** A decision's text as it is kept: trimmed, or the refusal it gets. */
export const decisionText = (text: string): string | DecisionRefused => {
  const kept = text.trim();
  if (kept === "") return new DecisionRefused({ reason: "empty-text", message: "A decision needs its text." });
  if (kept.length > DECISION_TEXT_MAX) {
    return new DecisionRefused({
      reason: "too-long",
      message: `A decision takes at most ${DECISION_TEXT_MAX} characters, and this one has ${kept.length}. Say it in fewer words, or record it as several decisions.`,
    });
  }
  return kept;
};

/** What recording a decision writes: the new decision, and the one it replaced, crossed out. */
export interface DecisionPlan {
  readonly recorded: Decision;
  readonly superseded: Decision | null;
}

/** A decision to record, as the command reads it in its transaction. */
export interface DecisionDraft {
  readonly id: DecisionId;
  readonly threadId: ThreadId;
  readonly chapterId: ChapterId;
  readonly sourceMessageId: MessageId | null;
  readonly text: string;
  readonly actor: Actor;
  readonly at: string;
  /** Whether its chat or camp is open: a closed one takes no new decisions. */
  readonly threadOpen: boolean;
  /**
   * The decision it replaces: undefined when it replaces none, null when the one it names is not in
   * this chat or camp.
   */
  readonly replaces?: Decision | null;
}

/** The decision a replace or a cross-out names, still active, or why not. */
const replaceable = (decision: Decision | null): Decision | DecisionRefused => {
  if (decision === null) {
    return new DecisionRefused({ reason: "not-found", message: "That decision is not in this chat or camp." });
  }
  if (!DecisionStates.isActive(decision)) {
    return new DecisionRefused({
      reason: "superseded",
      message: `Decision ${decision.id} was crossed out already${decision.supersededBy === null ? "" : `, replaced by ${decision.supersededBy}`}.`,
    });
  }
  return decision;
};

/** Why a closed chat or camp takes no new decision. */
const closed = () =>
  new DecisionRefused({
    reason: "thread-closed",
    message: "This chat or camp is closed, so it takes no new decisions.",
  });

/**
 * The pure rule of recording a decision (ADR 037): its text is checked and trimmed, and a decision it
 * replaces is crossed out, pointing at the new one, at the same moment. The repository runs it on the
 * records as stored, in the transaction that writes and journals the result.
 */
export const planDecision = (draft: DecisionDraft): DecisionPlan | DecisionRefused => {
  if (!draft.threadOpen) return closed();
  const text = decisionText(draft.text);
  if (text instanceof DecisionRefused) return text;
  const recorded = new Decision({
    id: draft.id,
    threadId: draft.threadId,
    chapterId: draft.chapterId,
    sourceMessageId: draft.sourceMessageId,
    text,
    actor: draft.actor,
    state: "active",
    supersededBy: null,
    recordedAt: draft.at,
    supersededAt: null,
  });
  if (draft.replaces === undefined) return { recorded, superseded: null };
  const replaced = replaceable(draft.replaces);
  if (replaced instanceof DecisionRefused) return replaced;
  const superseded = DecisionStates.transition(replaced, { _tag: "Supersede", by: draft.id, at: draft.at });
  if (superseded instanceof IllegalDecisionTransition) {
    return new DecisionRefused({ reason: "not-found", message: "A decision cannot replace itself." });
  }
  return { recorded, superseded };
};

/**
 * The pure rule of crossing a decision out with nothing in its place (ADR 037): it is kept, and no
 * longer holds. `decision` is null when it is not in this chat or camp, which must be open.
 */
export const planCrossOut = (
  decision: Decision | null,
  at: string,
  threadOpen: boolean,
): Decision | DecisionRefused => {
  if (!threadOpen) return closed();
  const replaced = replaceable(decision);
  if (replaced instanceof DecisionRefused) return replaced;
  const superseded = DecisionStates.transition(replaced, { _tag: "Supersede", by: null, at });
  return superseded instanceof IllegalDecisionTransition ? replaceable(replaced) : superseded;
};
