import { type AgentNotFound, type HobUnavailable, SkillDraftGone } from "@hobbots/api";
import {
  type AgentId,
  type SkillId,
  SkillNotFound,
  SkillProposalNotFound,
  type SkillRefused,
  type SkillRevisionHash,
  type SkillSourceUnreadable,
  SkillTrial,
  skillTitle,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import { Context, Effect, Layer, Option } from "effect";
import { ChatService } from "./chat.ts";
import { HobbotsRepository } from "./repository.ts";
import { SkillProposalLog } from "./skill-proposals.ts";
import { proposalFiles } from "./skill-reviews.ts";
import { type SkillDraftSource, SkillFiles, SkillLibrary, SkillWriter } from "./skills.ts";

/**
 * Try in a chat (ADR 029, Proactive hobs, #1099): a draft that is not in the library yet, loaded alone
 * in a new chat with one hob, so you see whether it triggers and works before anyone else gets it. The
 * draft is checked as import checks any skill and its files are kept outside the library, so nothing
 * reaches it: no skill, revision, assignment or use. Every runtime gets the draft as the one mount of
 * each turn of that chat, the way it gets any skill.
 */

/** What to try: a hob's proposal, with your edit if you made one, an edit you have not saved, or a new skill. */
export type SkillTrialDraft =
  | {
      readonly _tag: "Proposal";
      readonly proposalId: string;
      /** The whole `SKILL.md` as the card holds it now; the proposal's own when absent. */
      readonly instructions?: string | undefined;
    }
  | {
      readonly _tag: "Edit";
      readonly skillId: SkillId;
      readonly base: SkillRevisionHash;
      readonly description: string;
      /** The `SKILL.md` text after its front matter. */
      readonly instructions: string;
    }
  | {
      readonly _tag: "Written";
      /** The whole `SKILL.md` of a new skill. */
      readonly text: string;
    };

export type SkillTrialError =
  | SkillRefused
  | SkillSourceUnreadable
  | SkillNotFound
  | SkillProposalNotFound
  | AgentNotFound
  | HobUnavailable;

export class SkillTrials extends Context.Service<
  SkillTrials,
  {
    /** Checks the draft, keeps its files apart, and opens a new chat with the hob that loads only it. */
    readonly start: (agentId: AgentId, draft: SkillTrialDraft) => Effect.Effect<Thread, SkillTrialError>;
    /**
     * The whole `SKILL.md` the chat tries, so you can go on editing it where it came from; gone when the
     * chat tries no draft or the hub no longer has its files, as after a restore.
     */
    readonly draft: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly trial: SkillTrial; readonly text: string }, SkillDraftGone>;
  }
>()("@hobbots/agents/SkillTrials") {}

/** The title a chat that tries a draft starts with. */
export const trialTitle = (name: string): string => `Trying ${skillTitle(name)}`;

export const SkillTrialsLive = Layer.effect(
  SkillTrials,
  Effect.gen(function* () {
    const writer = yield* SkillWriter;
    const library = yield* SkillLibrary;
    const files = yield* SkillFiles;
    const chat = yield* ChatService;
    const repo = yield* HobbotsRepository;
    const proposals = yield* Effect.serviceOption(SkillProposalLog);
    const filesOf = proposalFiles(library, files);

    /** The draft as the writer stages it, with the skill and revision it changes. */
    const sourceOf = (draft: SkillTrialDraft) =>
      Effect.gen(function* () {
        switch (draft._tag) {
          case "Written":
            return {
              source: { _tag: "Written", files: [{ path: "SKILL.md", text: draft.text }] } satisfies SkillDraftSource,
              skillId: null,
              base: null,
              proposalId: null,
            };
          case "Edit": {
            if ((yield* library.revision(draft.skillId, draft.base)) === null) {
              return yield* new SkillNotFound({ id: draft.base });
            }
            const { skillId, base, description, instructions } = draft;
            const source: SkillDraftSource = { _tag: "Edited", skillId, base, description, instructions };
            return { source, skillId, base, proposalId: null };
          }
          case "Proposal": {
            const found = Option.isSome(proposals) ? yield* proposals.value.get(draft.proposalId) : Option.none();
            if (Option.isNone(found)) return yield* new SkillProposalNotFound({ id: draft.proposalId });
            const proposal = found.value;
            const built = yield* filesOf(proposal, draft.instructions ?? proposal.instructions);
            return {
              source: { _tag: "Written", files: built.files } satisfies SkillDraftSource,
              skillId: proposal.skillId,
              base: built.after,
              proposalId: proposal.id,
            };
          }
        }
      });

    return SkillTrials.of({
      start: (agentId, draft) =>
        Effect.gen(function* () {
          const { source, skillId, base, proposalId } = yield* sourceOf(draft);
          const staged = yield* writer.stage(source);
          const skillTrial = new SkillTrial({ ...staged, skillId, base, proposalId });
          return yield* chat.createThread(agentId, { title: trialTitle(staged.name), skillTrial });
        }),
      draft: (threadId) =>
        Effect.gen(function* () {
          const thread = yield* repo.findThread(threadId);
          const trial = Option.isSome(thread) ? thread.value.skillTrial : null;
          const text = trial === null ? null : yield* files.draftText(trial.hash);
          if (trial === null || text === null) return yield* new SkillDraftGone({ threadId });
          return { trial, text };
        }),
    });
  }),
);
