import { Schema } from "effect";
import { AgentStatus, ConfigVersion, RetireWork } from "./agent.ts";
import { ChangeCall } from "./change-actor.ts";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { CharmOperationId } from "./policy.ts";
import { Revision } from "./revision.ts";
import { SummoningChange, SummoningDraft } from "./summoning.ts";
import { TaskId } from "./task.ts";

/**
 * A hob proposal (ADR 034, Asking is a proposal): a Summoning Charm call that asks becomes an Inbox
 * item that only you decide and apply. The hub records it on the manager's call, with one row per hob,
 * and what you allow is made by you on the manager's proposal. No hob decides or applies one, the
 * manager included.
 */

export const HobProposalId = Schema.String.pipe(Schema.brand("HobProposalId"));
export type HobProposalId = typeof HobProposalId.Type;

/** What a proposal does: summon new hobs, change hobs, or pause, wake or retire one. */
export const HobProposalKind = Schema.Literals(["summon", "change", "pause", "wake", "retire"]);
export type HobProposalKind = typeof HobProposalKind.Type;

/**
 * Where one row stands: `pending` until you decide it; `applying` once you allowed it, while the hub
 * makes it; `allowed` once what it proposes was made; `denied` when you said no; `failed` when you
 * allowed it and the hub could not make it, with why. `applying` is saved before the hub makes
 * anything, so a row the hub stopped in the middle of is checked against the hob before anything else
 * decides it.
 */
export const HobProposalRowState = Schema.Literals(["pending", "applying", "allowed", "denied", "failed"]);
export type HobProposalRowState = typeof HobProposalRowState.Type;

/**
 * One hob of a proposal. A summon row holds the draft of a new hob and the id the hub minted for it,
 * a change row the change and its target's fields before it, and a pause, wake or retire row its
 * target. `configVersion` and `status` are the target's when the row was made: a row whose target has
 * moved on since is never applied (changed since), and only Deny is left.
 */
export const HobProposalRow = Schema.Struct({
  id: Schema.String,
  hobId: AgentId,
  /** The hob's name as the row was made: the draft's, or the target's. */
  label: Schema.String,
  draft: Schema.NullOr(SummoningDraft),
  change: Schema.NullOr(SummoningChange),
  /** The target's value of each field the change gives, by the change's own field name. */
  before: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  configVersion: Schema.NullOr(ConfigVersion),
  status: Schema.NullOr(AgentStatus),
  /** For a retire row: what happens to the hob's running replies. */
  runningReplies: Schema.NullOr(RetireWork),
  /** Your version of a summon row, when you edited it before you allowed it. */
  edited: Schema.NullOr(SummoningDraft),
  state: HobProposalRowState,
  /** What the hub did or why it could not, as the manager is told. */
  outcome: Schema.NullOr(Schema.String),
  decidedAt: Schema.NullOr(Schema.String),
});
export type HobProposalRow = typeof HobProposalRow.Type;

/** `open` while a row waits for you; `settled` once every row is decided. */
export const HobProposalState = Schema.Literals(["open", "settled"]);
export type HobProposalState = typeof HobProposalState.Type;

export class HobProposal extends Schema.Class<HobProposal>("HobProposal")({
  id: HobProposalId,
  /** The manager: the hob whose call made the proposal. */
  agentId: AgentId,
  kind: HobProposalKind,
  /** The Summoning tool the manager called. */
  tool: Schema.String,
  /** The call behind it: the work its key belongs to and the key, as a change it applies records (ADR 031). */
  call: ChangeCall,
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  /** The Task the manager's turn worked on, or null outside one. */
  taskId: Schema.NullOr(TaskId),
  /** The call's reply step, which shows the same card in the chat. */
  stepId: Schema.NullOr(Schema.String),
  rows: Schema.Array(HobProposalRow),
  /**
   * The operations that asked and that "Always allow" may set to Allow on the manager's Summoning
   * Charm. Empty for a safety Ask or a high-risk operation, which it never covers.
   */
  asks: Schema.Array(CharmOperationId),
  /** Why every field asks whatever its answer, for a target wider than the manager; null otherwise. */
  safety: Schema.NullOr(Schema.String),
  /** Retire is high risk: allowing it needs the confirmation check box (ADR 015). */
  highRisk: Schema.Boolean,
  /** The operations you set to Allow from this proposal with "Always allow". */
  alwaysAllowed: Schema.Array(CharmOperationId),
  state: HobProposalState,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  settledAt: Schema.NullOr(Schema.String),
  /** The journal sequence of its last change, which a change must name to land. */
  revision: Revision,
}) {}

/** Whether a proposal still waits for you. */
export const hobProposalOpen = (proposal: Pick<HobProposal, "state">): boolean => proposal.state === "open";

/** Whether every row of a proposal is decided, so it settles. */
export const everyRowDecided = (rows: ReadonlyArray<HobProposalRow>): boolean =>
  rows.every((row) => row.state !== "pending" && row.state !== "applying");

/**
 * What the manager is told once a proposal settles: row by row, what was created, changed or denied.
 * It is the call's answer when the call still waits, and its backpack item otherwise (ADR 019).
 */
export const hobProposalOutcomeText = (proposal: Pick<HobProposal, "rows" | "alwaysAllowed">): string => {
  const lines = proposal.rows.map((row) => {
    switch (row.state) {
      case "applying":
        return `- ${row.label}: the user allowed it, and Hobbots is making it.`;
      case "allowed":
        return `- ${row.label}: the user allowed it. ${row.outcome ?? ""}`.trimEnd();
      case "denied":
        return `- ${row.label}: the user denied it, so nothing was done.`;
      case "failed":
        return `- ${row.label}: the user allowed it, but it could not be done. ${row.outcome ?? ""}`.trimEnd();
      default:
        return `- ${row.label}: the user has not decided it yet.`;
    }
  });
  const always =
    proposal.alwaysAllowed.length === 0
      ? []
      : [`The user set ${proposal.alwaysAllowed.join(", ")} to Allow for you, so calls like it no longer ask.`];
  return ["Hobbots showed the user your proposal as a card, and they decided it row by row:", ...lines, ...always].join(
    "\n",
  );
};
