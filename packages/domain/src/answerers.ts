import type { Actor } from "./actor.ts";
import { AgentId, type ThreadId } from "./ids.ts";
import type { MessageRole } from "./message.ts";
import { isActiveQuest, partyOf, type TaskTree } from "./quest.ts";
import type { ThreadKind } from "./thread.ts";
import { type ThreadMember, ThreadMembers } from "./thread-member.ts";

/**
 * Who answers a message (ADR 039, Who answers): a pure rule, run in the transaction that stores the
 * message, so whether a hob owes an answer is decided once, from the records, before anything else
 * happens. There is no answer-rule or host setting: the members and the message decide.
 */

/**
 * Why a hob answers, which its turn's header says ("Leo mentioned you"):
 * - `mention`: a person @mentioned it.
 * - `reply`: a person replied to one of its messages, which counts as a mention.
 * - `relay`: another hob mentioned it, or replied to it.
 * - `only-hob`: nobody was mentioned and it is the thread's only hob.
 * - `lead`: nobody was mentioned in the thread of a running Quest, and it leads that Quest.
 */
export type AnswerCause = "mention" | "reply" | "relay" | "only-hob" | "lead";

/** A hob that owes the message an answer, and why. */
export interface AnswerOwed {
  readonly hobId: AgentId;
  readonly cause: AnswerCause;
}

/** What `answerersFor` reads of a message: who wrote it, whom it mentions and whom it replies to. */
export interface SaidMessage {
  readonly role: MessageRole;
  /** The author; null only for a message from before authors were recorded, which was yours. */
  readonly actor: Actor | null;
  /** The actors it @mentions, in the order they appear. People are kept but never answer. */
  readonly mentions: ReadonlyArray<Actor>;
  /** The author of the message it replies to, or null when it replies to none. */
  readonly repliesTo: Actor | null;
}

/** A Quest running in the thread (ADR 039, rule 5): its lead and the hobs it brought in. */
export interface RunningQuest {
  readonly leadId: AgentId;
  readonly party: ReadonlyArray<AgentId>;
}

/**
 * The top Quest running in a thread, from the thread's Task trees (oldest first): the latest one
 * started there that is still under way, with its party. Null when none runs there.
 */
export const runningQuestIn = (threadId: ThreadId, trees: ReadonlyArray<TaskTree>): RunningQuest | null =>
  trees
    .flatMap((tree) =>
      tree.quests
        .filter((quest) => quest.parentQuestId === null && quest.threadId === threadId && isActiveQuest(quest.state))
        .map((quest) => ({ leadId: quest.leadId, party: partyOf(quest, tree.delegations) })),
    )
    .at(-1) ?? null;

/** What `answerersFor` reads of the thread. */
export interface AnswerPlace {
  readonly kind: ThreadKind;
  /** The Quest running in the thread, or null when none runs there. */
  readonly quest: RunningQuest | null;
}

/** The hobs that must answer, in order; empty when nobody does. */
export interface Answering {
  readonly _tag: "answering";
  readonly answerers: ReadonlyArray<AnswerOwed>;
}

/** The message mentions hobs that cannot hear it, so it is refused before it is stored. */
export interface MentionRefused {
  readonly _tag: "refused";
  /** The hobs mentioned that are not members, each once, in the order they were mentioned. */
  readonly hobs: ReadonlyArray<AgentId>;
}

const isHob = (actor: Actor | null): actor is Actor => actor?.kind === "hob";

/** A person wrote it: you, another user, or an author from before authors were recorded. */
const byPerson = (message: SaidMessage): boolean => message.actor === null || message.actor.kind === "user";

/** The active hobs among the members, in the order they are listed. */
const activeHobs = (members: ReadonlyArray<ThreadMember>): ReadonlyArray<AgentId> =>
  members
    .filter((member) => member.actor.kind === "hob" && ThreadMembers.isActive(member))
    .map((member) => AgentId.make(member.actor.id));

/**
 * A hob hears a mention when it is an active member, or, in the thread of a running Quest, when it
 * leads the Quest or is in its party: a mention there steers it directly (#1345).
 */
const hears = (hobId: AgentId, members: ReadonlyArray<AgentId>, quest: RunningQuest | null): boolean =>
  members.includes(hobId) || (quest !== null && (quest.leadId === hobId || quest.party.includes(hobId)));

/**
 * Who answers `message` in `thread`, given its `members` in every state. The rules, in order:
 *
 * 1. A note to self wakes nobody, and neither does a hob's message that mentions no other hob.
 * 2. An @mention wakes the mentioned hobs, in the order they were mentioned. A mention of a hob
 *    that cannot hear it is refused before the message is stored.
 * 3. A reply to a hob's message counts as mentioning that hob, after the @mentions. Replying to a
 *    hob that has since left is not refused: it just mentions nobody.
 * 4. With no mention, in a running Quest's thread its lead answers (rule 5 of the ADR: a running
 *    Quest keeps its rules).
 * 5. Otherwise the members decide: the only hob answers, and in a camp with several hobs nobody does.
 *
 * A hob never answers its own message, and there is no mention that wakes every hob.
 */
export function answerersFor(
  message: SaidMessage & { readonly mentions: readonly [] },
  thread: AnswerPlace,
  members: ReadonlyArray<ThreadMember>,
): Answering;
export function answerersFor(
  message: SaidMessage,
  thread: AnswerPlace,
  members: ReadonlyArray<ThreadMember>,
): Answering | MentionRefused;
export function answerersFor(
  message: SaidMessage,
  thread: AnswerPlace,
  members: ReadonlyArray<ThreadMember>,
): Answering | MentionRefused {
  const answering = (answerers: ReadonlyArray<AnswerOwed>): Answering => ({ _tag: "answering", answerers });
  if (message.role === "note") return answering([]);
  const hobs = activeHobs(members);
  const mentioned = [...new Set(message.mentions.filter(isHob).map((actor) => AgentId.make(actor.id)))];
  const missing = mentioned.filter((hobId) => !hears(hobId, hobs, thread.quest));
  if (missing.length > 0) return { _tag: "refused", hobs: missing };

  const relayed = isHob(message.actor);
  const author = relayed ? message.actor?.id : undefined;
  const replied =
    isHob(message.repliesTo) && hears(AgentId.make(message.repliesTo.id), hobs, thread.quest)
      ? [AgentId.make(message.repliesTo.id)]
      : [];
  const named: ReadonlyArray<AnswerOwed> = [
    ...mentioned.map((hobId) => ({ hobId, cause: relayed ? "relay" : "mention" }) as const),
    ...replied
      .filter((hobId) => !mentioned.includes(hobId))
      .map((hobId) => ({ hobId, cause: relayed ? "relay" : "reply" }) as const),
  ].filter((answerer) => answerer.hobId !== author);
  if (named.length > 0 || !byPerson(message)) return answering(named);

  if (thread.quest !== null) return answering([{ hobId: thread.quest.leadId, cause: "lead" }]);
  const [only, ...others] = hobs;
  return answering(only !== undefined && others.length === 0 ? [{ hobId: only, cause: "only-hob" }] : []);
}

/**
 * What the composer says when a message is refused for mentioning hobs that are not members, by
 * their names: "Rook isn't in this camp. Add Rook?". A direct message takes no one else, so it only
 * says so.
 */
export const mentionRefusedText = (names: ReadonlyArray<string>, kind: ThreadKind): string => {
  const who = names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const verb = names.length <= 1 ? "isn't" : "aren't";
  if (kind === "chat") return `${who} ${verb} in this direct message.`;
  return `${who} ${verb} in this camp. Add ${names.length <= 1 ? who : "them"}?`;
};
