import { Schema } from "effect";
import { Actor, sameActor } from "./actor.ts";
import { Artifact } from "./artifact.ts";
import { Decision, DecisionStates } from "./decision.ts";
import { MessageId } from "./ids.ts";
import { mentions } from "./mention.ts";
import type { Message } from "./message.ts";
import { QuestId, QuestState } from "./quest.ts";
import type { QuestSummary } from "./quest-summary.ts";
import { leavesUnread } from "./thread.ts";

/**
 * Catch-up (ADR 037): what changed in a chat or camp since you last read it, as the hub works it out
 * from its records and your read marker, so every device shows the same and no client folds records
 * of its own (STD-REACT-028). It is read, never stored: the marker and the records are the state.
 */

/** The most changes a catch-up lists; it counts the rest. */
export const CATCH_UP_MAX = 6;

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One change since you last read:
 * - `Mentioned`: a message mentions you; `author` wrote it, `excerpt` is its opening words.
 * - `NeedsYou`: a Quest started here waits on you, `count` times (questions, approvals, failed work).
 * - `QuestEnded`: a Quest started here ended, as `state` says.
 * - `Decided`: a hob or the hub recorded a decision that holds.
 * - `CrossedOut`: a decision stopped holding, replaced by another or by nothing.
 * - `Made`: an artifact was made or changed; `version` is the one it is at now.
 *
 * `messageId` is the message it happened at, to jump to, or null when no message holds it.
 */
export const CatchUpItem = Schema.Union([
  Schema.TaggedStruct("Mentioned", { messageId: MessageId, author: Schema.NullOr(Actor), excerpt: Schema.String }),
  Schema.TaggedStruct("NeedsYou", { questId: QuestId, goal: Schema.String, count: Count, messageId: Schema.Null }),
  Schema.TaggedStruct("QuestEnded", {
    questId: QuestId,
    goal: Schema.String,
    state: QuestState,
    messageId: Schema.Null,
  }),
  Schema.TaggedStruct("Decided", { decision: Decision, messageId: Schema.NullOr(MessageId) }),
  Schema.TaggedStruct("CrossedOut", { decision: Decision, messageId: Schema.NullOr(MessageId) }),
  Schema.TaggedStruct("Made", { artifact: Artifact, messageId: Schema.NullOr(MessageId) }),
]);
export type CatchUpItem = typeof CatchUpItem.Type;

export class CatchUp extends Schema.Class<CatchUp>("CatchUp")({
  /** When you last read the thread: the time of the last message you had read, or null when never. */
  readUpTo: Schema.NullOr(Schema.String),
  /** The first reply you have not read, where "New since you left" goes; null when none landed. */
  firstUnread: Schema.NullOr(MessageId),
  /** How many replies landed since, routine progress left out. */
  replies: Count,
  /** The changes, what waits on you first, then the newest; at most `CATCH_UP_MAX`. */
  items: Schema.Array(CatchUpItem),
  /** How many more changes there were than `items` lists. */
  more: Count,
}) {}

/** A Quest started in the thread, with what it is for, as catch-up reads it. */
export interface CatchUpQuest {
  readonly summary: Pick<QuestSummary, "questId" | "parentQuestId" | "state" | "needsYou" | "revision">;
  readonly goal: string;
}

/** A message as catch-up and For you read it. */
export type AwayMessage = Pick<
  Message,
  "id" | "role" | "status" | "content" | "quiet" | "revision" | "createdAt" | "actor" | "mentions"
>;

/**
 * What the away summary reads of a thread for one person (ADR 039, For you): who they are, their
 * read marker and the records written since. Only the messages that mention them matter to it.
 */
export interface AwayInput {
  /** The person catching up: their own decisions, artifacts and messages are no news to them. */
  readonly you: Actor;
  /** The newest message revision you read through, or null when you never read the thread. */
  readonly marker: number | null;
  readonly messages: ReadonlyArray<AwayMessage>;
  readonly decisions: ReadonlyArray<Decision>;
  readonly artifacts: ReadonlyArray<Artifact>;
  readonly quests: ReadonlyArray<CatchUpQuest>;
}

/** What catch-up reads of a thread: the away summary's input, with the whole transcript. */
export type CatchUpInput = AwayInput;

/** An item with the revision that orders it, newest first, and whether it waits on you. */
interface Ranked {
  readonly item: CatchUpItem;
  readonly revision: number;
  readonly waits: boolean;
}

const questItems = (quests: AwayInput["quests"], since: number): ReadonlyArray<Ranked> =>
  quests.flatMap(({ summary, goal }): ReadonlyArray<Ranked> => {
    // A member's Quest reaches you through its lead's, which is the one started here.
    if (summary.parentQuestId !== null || summary.revision <= since) return [];
    const { questId, revision } = summary;
    if (summary.state !== "active") {
      return [
        { item: { _tag: "QuestEnded", questId, goal, state: summary.state, messageId: null }, revision, waits: false },
      ];
    }
    if (summary.needsYou === 0) return [];
    return [
      { item: { _tag: "NeedsYou", questId, goal, count: summary.needsYou, messageId: null }, revision, waits: true },
    ];
  });

/** The excerpt a mention shows: the message's first line, cut at `EXCERPT_MAX` characters. */
const EXCERPT_MAX = 140;
const excerptOf = (content: string): string => {
  const line = content.trim().split("\n", 1)[0] ?? "";
  return line.length > EXCERPT_MAX ? `${line.slice(0, EXCERPT_MAX - 1)}…` : line;
};

/**
 * Whether `message` is an unread mention of `you` past `since` (ADR 039, mentions of you): the same
 * rule as the hub's unread-mention count, so a note to self, a lead's quiet progress and your own
 * messages never count.
 */
export const unreadMentionOf = (message: AwayMessage, you: Actor, since: number): boolean =>
  message.revision > since &&
  message.role !== "note" &&
  message.quiet !== true &&
  !(message.actor !== null && sameActor(message.actor, you)) &&
  mentions(message, you);

const mentionItems = (input: AwayInput, since: number): ReadonlyArray<Ranked> =>
  input.messages
    .filter((message) => unreadMentionOf(message, input.you, since))
    .map((message) => ({
      item: { _tag: "Mentioned", messageId: message.id, author: message.actor, excerpt: excerptOf(message.content) },
      revision: message.revision,
      waits: true,
    }));

const decisionItems = (decisions: AwayInput["decisions"], you: Actor, since: number): ReadonlyArray<Ranked> =>
  decisions.flatMap((decision): ReadonlyArray<Ranked> => {
    // What you decided yourself is no news to you, on whichever device you decided it.
    if (decision.revision <= since || sameActor(decision.actor, you)) return [];
    const messageId = decision.sourceMessageId;
    const item: CatchUpItem = DecisionStates.isActive(decision)
      ? { _tag: "Decided", decision, messageId }
      : { _tag: "CrossedOut", decision, messageId };
    return [{ item, revision: decision.revision, waits: false }];
  });

const artifactItems = (artifacts: AwayInput["artifacts"], you: Actor, since: number): ReadonlyArray<Ranked> =>
  artifacts.flatMap((artifact): ReadonlyArray<Ranked> => {
    if (artifact.revision <= since || sameActor(artifact.actor, you)) return [];
    const messageId = artifact.origin.kind === "message" ? MessageId.make(artifact.origin.id) : null;
    return [{ item: { _tag: "Made", artifact, messageId }, revision: artifact.revision, waits: false }];
  });

/**
 * Every change in the thread since `marker` (ADR 039, For you › While you were away), uncapped: the
 * mentions of you and what waits on you first, then the newest, each record once as it stands now.
 * What you wrote yourself is left out, since you made it. Catch-up and For you both list these, so
 * they agree for the same records and read marker.
 */
export const awayItems = (input: AwayInput): ReadonlyArray<CatchUpItem> => {
  const since = input.marker ?? 0;
  return [
    ...mentionItems(input, since),
    ...questItems(input.quests, since),
    ...decisionItems(input.decisions, input.you, since),
    ...artifactItems(input.artifacts, input.you, since),
  ]
    .sort((a, b) => Number(b.waits) - Number(a.waits) || b.revision - a.revision)
    .map((each) => each.item);
};

/** The changes an away summary lists, at most `CATCH_UP_MAX`, and how many more there were. */
export const awaySummaryOf = (
  input: AwayInput,
): { readonly items: ReadonlyArray<CatchUpItem>; readonly more: number } => {
  const all = awayItems(input);
  return { items: all.slice(0, CATCH_UP_MAX), more: Math.max(0, all.length - CATCH_UP_MAX) };
};

/**
 * What changed in the thread since `marker` (ADR 037): the replies that landed, and the away
 * summary of the records written since. Nothing is new in a thread you never left: a marker past
 * every record gives an empty catch-up.
 */
export const catchUpOf = (input: CatchUpInput): CatchUp => {
  const since = input.marker ?? 0;
  const unread = input.messages.filter((message) => message.revision > since && leavesUnread(message));
  const read = input.messages.filter((message) => message.revision <= since && message.status !== "queued");
  const { items, more } = awaySummaryOf(input);
  return new CatchUp({
    readUpTo: input.marker === null ? null : (read.at(-1)?.createdAt ?? null),
    firstUnread: unread[0]?.id ?? null,
    replies: unread.length,
    items,
    more,
  });
};

/** Whether there is anything to catch up on. */
export const hasNews = (catchUp: CatchUp): boolean => catchUp.replies > 0 || catchUp.items.length > 0;
