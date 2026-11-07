import type { SkillProposalCheck, SkillProposalView, UserSession } from "@hobbots/api";
import type {
  AgentId,
  Committed,
  EventEnvelope,
  SkillFeedback,
  SkillId,
  SkillMovedOn,
  SkillNameChanged,
  SkillNameTaken,
  SkillNotFound,
  SkillProposal,
  SkillProposalClosed,
  SkillProposalNotFound,
  SkillProposalState,
  SkillReadOnly,
  SkillRefused,
  SkillSourceChanged,
  SkillSourceUnreadable,
} from "@hobbots/domain";
import { SKILL_PROPOSALS_WAITING_MAX, skillProposalOpen } from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";
import type { CharmTurn } from "./charms.ts";
import type { HubTools } from "./runtime.ts";

/**
 * Proposals and feedback (ADR 029, Proactive hobs): what hobs suggest for the library, beside it and
 * never inside it. A proposal is recorded and journaled before you see it and waits for your review
 * under every preset; only your decision, through `SkillReviews`, adds it to the library.
 */

/**
 * What recording a proposal found: it is new and journaled; the hob used its key before in the same
 * work (`Existing`); it already has one waiting under that name (`Duplicate`); or it has as many
 * waiting as it may (`Full`). Only `Started` wrote anything.
 */
export type SkillProposalStart =
  | { readonly _tag: "Started"; readonly entries: ReadonlyArray<EventEnvelope> }
  | { readonly _tag: "Existing"; readonly proposal: SkillProposal }
  | { readonly _tag: "Duplicate"; readonly proposal: SkillProposal }
  | { readonly _tag: "Full"; readonly waiting: ReadonlyArray<SkillProposal> };

/** Why a new proposal is not recorded, from the hob's proposals as they stand (ADR 029, No spam). */
export const proposalLimit = (
  open: ReadonlyArray<SkillProposal>,
  proposal: Pick<SkillProposal, "agentId" | "name">,
  max: number = SKILL_PROPOSALS_WAITING_MAX,
): Exclude<SkillProposalStart, { readonly _tag: "Started" | "Existing" }> | null => {
  const mine = open.filter((one) => one.agentId === proposal.agentId && skillProposalOpen(one));
  const same = mine.find((one) => one.name === proposal.name);
  if (same !== undefined) return { _tag: "Duplicate", proposal: same };
  return mine.length >= max ? { _tag: "Full", waiting: mine } : null;
};

/** The record of every proposal and note, kept by the hub's database. */
export class SkillProposalLog extends Context.Service<
  SkillProposalLog,
  {
    /**
     * Records `proposal` and journals it, unless the hob's key is already taken in the same work or in
     * `also`, or `proposalLimit` refuses it, all read in the same transaction as the write.
     */
    readonly begin: (proposal: SkillProposal, also?: string) => Effect.Effect<SkillProposalStart>;
    /**
     * The proposal the hob made with `key` in `work` or in `also`, whatever became of it, so a call
     * sent again answers as the first did before anything in the library is read again.
     */
    readonly recorded: (
      agentId: AgentId,
      key: string,
      work: string,
      also?: string,
    ) => Effect.Effect<Option.Option<SkillProposal>>;
    /**
     * Saves `proposal` as it now stands, and journals it, when its record is still in one of `from`.
     * None when it moved on meanwhile, so of two decisions racing for one proposal only the first lands.
     */
    readonly move: (
      proposal: SkillProposal,
      from: ReadonlyArray<SkillProposalState>,
    ) => Effect.Effect<Option.Option<Committed<SkillProposal>>>;
    readonly get: (id: string) => Effect.Effect<Option.Option<SkillProposal>>;
    /** Every proposal that waits or is being added, oldest first, then the latest `decided` others, newest first. */
    readonly list: (decided: number) => Effect.Effect<ReadonlyArray<SkillProposal>>;
    /** Records a hob's note on a skill, journaled. */
    readonly leaveFeedback: (feedback: SkillFeedback) => Effect.Effect<Committed<SkillFeedback>>;
    /** A skill's notes, newest first. */
    readonly feedback: (skillId: SkillId) => Effect.Effect<ReadonlyArray<SkillFeedback>>;
  }
>()("@hobbots/agents/SkillProposalLog") {}

/**
 * Errors a decision on a proposal answers with: no such proposal, one decided already, or what the
 * import of its revision refused, such as a check it fails or a name another skill took meanwhile.
 */
export type SkillReviewError =
  | SkillProposalNotFound
  | SkillProposalClosed
  | SkillRefused
  | SkillSourceUnreadable
  | SkillNotFound
  | SkillNameTaken
  | SkillNameChanged
  | SkillMovedOn
  | SkillReadOnly
  | SkillSourceChanged;

/**
 * Your side of proposals: what waits for you and what was decided lately, and your decisions. Only
 * you decide: each decision needs a `UserSession`, which no hob, Charm or runtime tool has (PE-006).
 */
export class SkillReviews extends Context.Service<
  SkillReviews,
  {
    /** Each proposal with what its review shows: what it changes, where it reaches, and what the checks find. */
    readonly list: Effect.Effect<ReadonlyArray<SkillProposalView>>;
    /** What the checks find in your edit of a waiting proposal, as adding it would find it; writes nothing. */
    readonly check: (
      id: string,
      instructions: string,
    ) => Effect.Effect<SkillProposalCheck, SkillReviewError, UserSession>;
    /**
     * Adds the proposal to the library, as the hob wrote it or as you edited it (`instructions`): a new
     * skill for the hob that proposed it, or a new revision rolled out like your own edit. One the
     * import checks refuse stays waiting, with the rule it broke.
     */
    readonly add: (
      id: string,
      instructions: string | undefined,
    ) => Effect.Effect<SkillProposal, SkillReviewError, UserSession>;
    /** Not now: the library stays as it is, and the hob is told. */
    readonly decline: (id: string) => Effect.Effect<SkillProposal, SkillReviewError, UserSession>;
    /** Finishes every proposal a stopped hub left `adding`. The hub runs it at start. */
    readonly recover: Effect.Effect<void>;
  }
>()("@hobbots/agents/SkillReviews") {}

/**
 * The skill tools a turn offers its runtime (ADR 029), served on the hub over the library, decided
 * under the hob's Skills policy group. Absent, a turn offers none.
 */
export class SkillTools extends Context.Service<
  SkillTools,
  {
    /** The tools the turn offers, read at its start: none (null) for a hob without tools. */
    readonly forTurn: (turn: CharmTurn) => Effect.Effect<HubTools | null>;
  }
>()("@hobbots/agents/SkillTools") {}
