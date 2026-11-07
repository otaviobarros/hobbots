import { Schema } from "effect";
import { AgentId, MessageId, ThreadId } from "./ids.ts";
import { SkillFeedbackKind } from "./skill-tools.ts";
import { SkillId, SkillName, SkillRevisionHash } from "./skills.ts";
import { AttemptId } from "./task.ts";

/**
 * Proposals (ADR 029, Proactive hobs): a new skill, or a revision of one, that a hob drafted with
 * `skill_propose`. New content enters the library only through you, so a proposal waits for your
 * review under every preset: Add takes it as it is, Edit then add takes your edit, and Not now leaves
 * the library as it was. Either way the hob is told. Feedback is a hob's note on a skill, counted on
 * the skill's page, and never changes it.
 */

export const SkillProposalId = Schema.String.pipe(Schema.brand("SkillProposalId"));
export type SkillProposalId = typeof SkillProposalId.Type;

/**
 * Where a proposal stands. `waiting` for your review; `adding` while the hub writes the revision you
 * accepted, recorded first so a second decision is refused and a stopped hub finishes it; `added`
 * once it is in the library; `declined` when you said Not now.
 */
export const SkillProposalState = Schema.Literals(["waiting", "adding", "added", "declined"]);
export type SkillProposalState = typeof SkillProposalState.Type;

/** A revision as a proposal names it: its hash and its number, r1, r2. */
export const SkillRevisionRef = Schema.Struct({ hash: SkillRevisionHash, number: Schema.Int });
export type SkillRevisionRef = typeof SkillRevisionRef.Type;

/**
 * What adding a proposal did to the library: a revision it did not have (`new`), none since the
 * skill's newest already is that content (`same`), or an earlier revision brought back, rolled out
 * as a rollback is (`earlier`).
 */
export const SkillProposalAddedAs = Schema.Literals(["new", "same", "earlier"]);
export type SkillProposalAddedAs = typeof SkillProposalAddedAs.Type;

/** The revision a proposal became, and how. */
export const SkillProposalAdded = Schema.Struct({
  hash: SkillRevisionHash,
  number: Schema.Int,
  as: SkillProposalAddedAs,
});
export type SkillProposalAdded = typeof SkillProposalAdded.Type;

/** A proposal a hob made, recorded and journaled before you see it, once per hob, work and key. */
export class SkillProposal extends Schema.Class<SkillProposal>("SkillProposal")({
  id: SkillProposalId,
  agentId: AgentId,
  /** The work the key belongs to, such as `task:<Task id>`, as for memory saves (#660). */
  work: Schema.String,
  /** The SHA-256 of the key the hob sent, never its text. */
  key: Schema.String,
  /** The SHA-256 of the call's input as stable JSON without its key, so a key sent again with another call is told apart. */
  input: Schema.String,
  name: SkillName,
  /** The description from its front matter, as the card shows it. */
  description: Schema.String,
  /** The skill it revises, or null for a new skill. */
  skillId: Schema.NullOr(SkillId),
  /** The revision the hob read and changed, or null for a new skill. Stale once the skill has a newer one. */
  base: Schema.NullOr(SkillRevisionRef),
  /** The whole `SKILL.md` it proposes, redacted before it was recorded, or as you edited it before you added it. */
  instructions: Schema.String,
  /** Why the hob proposes it, redacted. */
  why: Schema.String,
  state: SkillProposalState,
  /** Whether you changed it before you added it. */
  edited: Schema.Boolean,
  /** The revision it became, once added, and whether it was new, the newest already, or an earlier one. */
  added: Schema.NullOr(SkillProposalAdded),
  /** Learned from: the memory pages it names, as the hob gave them. */
  memoryPages: Schema.Array(Schema.String),
  /** Learned from: the reply it was made from, when it came from a chat turn. */
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  /** The Attempt it was made in, for a proposal made outside any chat, as a party member's or a step's. */
  attemptId: Schema.NullOr(AttemptId),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  /** When you added it or said Not now. */
  decidedAt: Schema.NullOr(Schema.String),
}) {}

/** Whether a proposal waits for you: `adding` counts, since the hub has not finished it. */
export const skillProposalOpen = (proposal: { readonly state: SkillProposalState }): boolean =>
  proposal.state === "waiting" || proposal.state === "adding";

/** Whether a revision proposal was made against a revision older than the skill's newest. */
export const skillProposalStale = (proposal: SkillProposal, latest: SkillRevisionHash | null): boolean =>
  proposal.base !== null && latest !== null && proposal.base.hash !== latest;

/** A hob's note that a skill is wrong, outdated or unclear. Shown and counted on the skill's page. */
export class SkillFeedback extends Schema.Class<SkillFeedback>("SkillFeedback")({
  id: Schema.String,
  agentId: AgentId,
  skillId: SkillId,
  kind: SkillFeedbackKind,
  /** The hob's line, redacted. */
  note: Schema.String,
  /** The revision the hob had when it wrote the note, if it had the skill. */
  revision: Schema.NullOr(SkillRevisionHash),
  threadId: Schema.NullOr(ThreadId),
  messageId: Schema.NullOr(MessageId),
  createdAt: Schema.String,
}) {}

/** How many notes on a skill suggest a revision (ADR 029). */
export const SKILL_FEEDBACK_SUGGESTS_REVISION = 3;

const revisionWords = (proposal: SkillProposal) =>
  proposal.base === null ? `a new skill, ${proposal.name}` : `a change to ${proposal.name}`;

/** What a hob is told when its proposal waits for the user. */
export const skillProposalWaitingText = (proposal: SkillProposal) =>
  `Proposed ${revisionWords(proposal)}. It waits for the user's review in their Inbox, so nothing changed yet, and you are told when they decide. Do not propose it again.`;

/** What a hob is told once the user added its proposal, by what adding it did. */
export const skillProposalAddedText = (proposal: SkillProposal) => {
  const edits = proposal.edited ? ", with their own edits" : "";
  switch (proposal.added?.as) {
    case "same":
      return `The user accepted ${revisionWords(proposal)}${edits}, but it is what r${proposal.added.number} already says, so the library is unchanged.`;
    case "earlier":
      return `The user accepted ${revisionWords(proposal)}${edits}. It is what r${proposal.added.number} said, so ${proposal.name} went back to r${proposal.added.number}. You use it from your next turn.`;
    default:
      return `The user added ${revisionWords(proposal)}${proposal.added === null ? "" : ` as r${proposal.added.number}`}${edits}. You use it from your next turn.`;
  }
};

/** What a hob is told once the user said Not now. */
export const skillProposalDeclinedText = (proposal: SkillProposal) =>
  `The user turned down ${revisionWords(proposal)} for now, so the library is unchanged. Do not propose it again unless they ask.`;

/** What a hob is told of a proposal, by where it stands. */
export const skillProposalText = (proposal: SkillProposal): string => {
  switch (proposal.state) {
    case "waiting":
    case "adding":
      return skillProposalWaitingText(proposal);
    case "added":
      return skillProposalAddedText(proposal);
    case "declined":
      return skillProposalDeclinedText(proposal);
  }
};

/** No proposal with that id. */
export class SkillProposalNotFound extends Schema.TaggedError<SkillProposalNotFound>()("SkillProposalNotFound", {
  id: Schema.String,
}) {}

/** The proposal was decided already, or is being added: `state` is where it stands now. */
export class SkillProposalClosed extends Schema.TaggedError<SkillProposalClosed>()("SkillProposalClosed", {
  id: Schema.String,
  state: SkillProposalState,
}) {}
