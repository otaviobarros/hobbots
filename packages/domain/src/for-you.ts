import { Schema } from "effect";
import { Actor, sameActor } from "./actor.ts";
import { ApprovalRequest } from "./approval.ts";
import { Artifact, ArtifactReviews } from "./artifact.ts";
import { type AwayInput, awayItems, awaySummaryOf, CatchUpItem } from "./catch-up.ts";
import { HubQuestion } from "./hub-question.ts";
import { MessageId, ThreadId } from "./ids.ts";
import { Question } from "./quest.ts";
import { Task } from "./task.ts";

/**
 * For you (ADR 039, Cards every thread shares): one list per person of what is theirs to act on,
 * topped by "While you were away". It is a projection the hub works out from its records and each
 * member's read marker, with no model call, so every device of a person shows the same. It replaces
 * the Needs-you tray, the Inbox and catch-up as separate sources.
 */

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * One thing for a person to act on, each naming who it is `for`:
 * - `Mention`: a message mentions you and you have not read it.
 * - `Question`: a Task's question that climbed every lead and waits for its decider.
 * - `HubQuestion`: a question the hub itself asks its owner (#976).
 * - `Approval`: a tool call waiting for its decider's approval.
 * - `Review`: an artifact waiting for its decider's review (#1422).
 *
 * `at` is when it started waiting, which orders the list, oldest first.
 */
export const ForYouItem = Schema.Union([
  Schema.TaggedStruct("Mention", {
    for: Actor,
    at: Schema.String,
    threadId: ThreadId,
    messageId: MessageId,
    author: Schema.NullOr(Actor),
    excerpt: Schema.String,
  }),
  Schema.TaggedStruct("Question", { for: Actor, at: Schema.String, question: Question, task: Task }),
  Schema.TaggedStruct("HubQuestion", { for: Actor, at: Schema.String, question: HubQuestion }),
  Schema.TaggedStruct("Approval", { for: Actor, at: Schema.String, approval: ApprovalRequest }),
  Schema.TaggedStruct("Review", { for: Actor, at: Schema.String, artifact: Artifact }),
]);
export type ForYouItem = typeof ForYouItem.Type;

/** One thread's part of "While you were away": what changed in it since your read marker. */
export class ThreadAway extends Schema.Class<ThreadAway>("ThreadAway")({
  threadId: ThreadId,
  /** Your read marker in it, or null when you never read it. */
  readRevision: Schema.NullOr(Schema.Number),
  /** The changes, mentions of you and what waits on you first; at most `CATCH_UP_MAX`. */
  items: Schema.Array(CatchUpItem),
  /** How many more changes there were than `items` lists. */
  more: Count,
}) {}

export class ForYou extends Schema.Class<ForYou>("ForYou")({
  /** The person the list is for: the session's user. */
  for: Actor,
  /** What is yours to act on, oldest first. */
  items: Schema.Array(ForYouItem),
  /** While you were away: each thread with changes since your read marker, the latest change first. */
  away: Schema.Array(ThreadAway),
}) {}

/**
 * Who decides what a hob asks in a thread (ADR 039, the decider): the person who asked for the
 * work, else the thread's owner, else the hub's owner, as for work no person caused.
 */
export const deciderOf = (from: {
  readonly requester: Actor | null;
  readonly owner: Actor | null;
  readonly hubOwner: Actor;
}): Actor => from.requester ?? from.owner ?? from.hubOwner;

/** A thread you are an active member of, as For you reads it: your marker and its records since. */
export interface ForYouThread extends Omit<AwayInput, "you"> {
  readonly threadId: ThreadId;
}

/** What For you reads for one person. */
export interface ForYouInput {
  readonly you: Actor;
  /** The hub's owner, who decides what no person caused and answers the hub's own questions. */
  readonly hubOwner: Actor;
  /** The threads you are an active member of, with your read marker and their records. */
  readonly threads: ReadonlyArray<ForYouThread>;
  /** Each thread's owner, who decides what nobody else asked for. */
  readonly owners: ReadonlyMap<ThreadId, Actor>;
  /** The hub's pending approvals, every decider's. */
  readonly approvals: ReadonlyArray<ApprovalRequest>;
  /** The questions waiting for a person, every decider's, with their Tasks. */
  readonly questions: ReadonlyArray<{ readonly question: Question; readonly task: Task }>;
  /** The hub's own open questions, which its owner answers. */
  readonly hubQuestions: ReadonlyArray<HubQuestion>;
  /** The artifacts waiting for review, every decider's. */
  readonly reviews: ReadonlyArray<Artifact>;
}

/** The newest revision past your marker among a thread's records, or 0 when there is none. */
const latestChange = (thread: ForYouThread): number => {
  const since = thread.marker ?? 0;
  return Math.max(
    0,
    ...[...thread.messages, ...thread.decisions, ...thread.artifacts, ...thread.quests.map((quest) => quest.summary)]
      .map((record) => record.revision)
      .filter((revision) => revision > since),
  );
};

/**
 * Your For you list (ADR 039): your unread mentions, the questions, approvals and reviews you
 * decide, and "While you were away" from the same away summary catch-up shows, so both list the
 * same mentions, decisions and changed artifacts for the same records and read marker. Every item
 * names who it is for; only yours are listed.
 */
export const forYouOf = (input: ForYouInput): ForYou => {
  const { you } = input;
  const decider = (threadId: ThreadId | null): Actor =>
    deciderOf({
      requester: null,
      owner: threadId === null ? null : (input.owners.get(threadId) ?? null),
      hubOwner: input.hubOwner,
    });
  const mentions: ReadonlyArray<ForYouItem> = input.threads.flatMap((thread) =>
    awayItems({ ...thread, you }).flatMap((item): ReadonlyArray<ForYouItem> => {
      if (item._tag !== "Mentioned") return [];
      const message = thread.messages.find((each) => each.id === item.messageId);
      if (message === undefined) return [];
      return [
        {
          _tag: "Mention",
          for: you,
          at: message.createdAt,
          threadId: thread.threadId,
          messageId: item.messageId,
          author: item.author,
          excerpt: item.excerpt,
        },
      ];
    }),
  );
  const decided: ReadonlyArray<ForYouItem> = [
    ...input.approvals
      .filter((approval) => approval.state === "pending")
      .map(
        (approval): ForYouItem => ({
          _tag: "Approval",
          for: decider(approval.threadId),
          at: approval.createdAt,
          approval,
        }),
      ),
    ...input.questions
      .filter(({ question }) => question.state === "open" && question.recipientId === null)
      .map(
        ({ question, task }): ForYouItem => ({
          _tag: "Question",
          for: decider(task.threadId),
          at: question.createdAt,
          question,
          task,
        }),
      ),
    ...input.hubQuestions
      .filter((question) => question.state === "open")
      .map((question): ForYouItem => ({ _tag: "HubQuestion", for: input.hubOwner, at: question.createdAt, question })),
    ...input.reviews.filter(ArtifactReviews.awaitsReview).map(
      (artifact): ForYouItem => ({
        _tag: "Review",
        for: decider(artifact.threadId),
        at: artifact.updatedAt,
        artifact,
      }),
    ),
  ];
  const away = input.threads
    .map((thread) => ({ thread, summary: awaySummaryOf({ ...thread, you }), latest: latestChange(thread) }))
    .filter(({ summary }) => summary.items.length > 0)
    .sort((a, b) => b.latest - a.latest)
    .map(
      ({ thread, summary }) =>
        new ThreadAway({
          threadId: thread.threadId,
          readRevision: thread.marker,
          items: summary.items,
          more: summary.more,
        }),
    );
  return new ForYou({
    for: you,
    items: [...mentions, ...decided]
      .filter((item) => sameActor(item.for, you))
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)),
    away,
  });
};
