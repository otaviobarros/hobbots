import type { ThreadKeyReused } from "@hobbots/api";
import type {
  Agent,
  AgentConfiguration,
  AgentId,
  AgentStatus,
  CarriedOver,
  CarriedOverEntry,
  ChangeActor,
  ChapterId,
  ChapterMove,
  ChapterNotFound,
  ChapterRefused,
  ChatWork,
  Committed,
  IllegalChapterTransition,
  Message,
  MessageId,
  Retiring,
  SkillUse,
  StartedFresh,
  Thread,
  ThreadCheckpoint,
  ThreadId,
} from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

/** The camp a chapter moves into: an open camp of the hob's, or `camp`, made in the same transaction under its id as key. */
export type ChapterMoveTarget =
  | { readonly _tag: "camp"; readonly campId: ThreadId }
  | { readonly _tag: "new"; readonly camp: Thread };

/** Where hobs, their configuration versions, threads and messages are stored. Each write journals its events. */
export class HobbotsRepository extends Context.Service<
  HobbotsRepository,
  {
    readonly listAgents: Effect.Effect<ReadonlyArray<Agent>>;
    /** Hobs in any of the given lifecycle states, oldest first. */
    readonly listAgentsWithStatus: (statuses: ReadonlyArray<AgentStatus>) => Effect.Effect<ReadonlyArray<Agent>>;
    readonly findAgent: (id: AgentId) => Effect.Effect<Option.Option<Agent>>;
    /**
     * Saves the hob's lifecycle fields (status and retirement time) from `next`, journaled as made by
     * `actor`, you when left out (ADR 034); a retirement also ends its wait to retire. None, and
     * nothing changed, when its stored status is no longer `from` (another change landed first).
     */
    readonly setAgentStatus: (
      next: Agent,
      from: AgentStatus,
      actor?: ChangeActor,
    ) => Effect.Effect<Option.Option<Committed<Agent>>>;
    /**
     * Has the hob wait to retire until its open Tasks have ended (#408), journaled as made by
     * `actor`. None, and nothing changed, when it is retired or already waiting.
     */
    readonly setAgentRetiring: (
      agentId: AgentId,
      retiring: Retiring,
      actor: ChangeActor,
    ) => Effect.Effect<Option.Option<Committed<Agent>>>;
    /**
     * Inserts the hob and its first configuration, made by `actor` (you when left out), unless one
     * with its id exists; none when it was not inserted.
     */
    readonly insertAgent: (agent: Agent, actor?: ChangeActor) => Effect.Effect<Option.Option<Committed<Agent>>>;
    readonly findAgentConfig: (id: AgentId, version: number) => Effect.Effect<Option.Option<AgentConfiguration>>;
    /**
     * Stores the hob's next configuration version, made by `actor` (you when left out), and makes it
     * current. None, and nothing stored, when the hob's current version is no longer the one before
     * it (another edit landed first).
     */
    readonly updateAgentConfig: (agent: Agent, actor?: ChangeActor) => Effect.Effect<Option.Option<Committed<Agent>>>;
    /** The hob's live threads, most recently active first; archived threads are left out. */
    readonly listThreads: (agentId: AgentId) => Effect.Effect<ReadonlyArray<Thread>>;
    /** The hob's archived threads, most recently archived first. */
    readonly listArchivedThreads: (agentId: AgentId) => Effect.Effect<ReadonlyArray<Thread>>;
    readonly findThread: (id: ThreadId) => Effect.Effect<Option.Option<Thread>>;
    /**
     * Writes the thread, leaving how far you read it as it is: only `markThreadRead` moves that. A
     * thread stored for the first time starts its first chapter in the same transaction (ADR 037),
     * journaled as `ChapterStarted` after its `ThreadUpserted`.
     */
    readonly upsertThread: (thread: Thread) => Effect.Effect<Committed<Thread>>;
    /**
     * Records that you read the thread through `messageId`, as you saw it at `revision` (ADR 027):
     * the marker takes the newest revision of the messages up to it, but never past `revision`, so a
     * reply continued after you saw it stays unread. It only moves forward: none, and nothing
     * journaled, when the message is not in the thread or you had read past it.
     */
    readonly markThreadRead: (
      threadId: ThreadId,
      messageId: MessageId,
      revision: number,
    ) => Effect.Effect<Option.Option<Committed<Thread>>>;
    readonly listMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Message>>;
    /** The message with `id`, in whichever thread it is. */
    readonly findMessage: (id: MessageId) => Effect.Effect<Option.Option<Message>>;
    /**
     * Saves the message with the events it produces (`messageEvents`), and in the same transaction
     * any skill uses its turn recorded, each journaled as `SkillUsed` (ADR 029, The use line). A new
     * message joins its thread's live chapter; the message returned carries the chapter it is in.
     */
    readonly upsertMessage: (message: Message, uses?: ReadonlyArray<SkillUse>) => Effect.Effect<Committed<Message>>;
    /**
     * Saves a reply's text while it is in progress, without journaling or a new revision (ADR 013),
     * so a crash keeps what had streamed by then. Does nothing once the reply has ended.
     */
    readonly checkpointMessage: (message: Message) => Effect.Effect<void>;
    /** Assistant replies whose turn has not ended (streaming or stopping), across every thread. */
    readonly listUnfinishedMessages: Effect.Effect<ReadonlyArray<Message>>;
    /** The thread's queued message that has waited longest, if any (CH-008). */
    readonly nextQueuedMessage: (threadId: ThreadId) => Effect.Effect<Option.Option<Message>>;
    /** Threads with at least one queued message. */
    readonly threadsWithQueuedMessages: Effect.Effect<ReadonlyArray<ThreadId>>;
    /**
     * Saves a queued message that started and its streaming reply in one transaction: the message
     * moves after every message in the thread, into its live chapter, and the reply follows it, so a crash leaves either a
     * queued message or a reply that recovery marks interrupted. None, and nothing changed, when
     * the message is no longer queued.
     */
    readonly startQueuedMessage: (
      message: Message,
      reply: Message,
    ) => Effect.Effect<Option.Option<Committed<{ readonly message: Message; readonly reply: Message }>>>;
    /** Deletes a message that is still queued in the thread; none, and nothing deleted, when it is not. */
    readonly removeQueuedMessage: (threadId: ThreadId, id: MessageId) => Effect.Effect<Option.Option<Committed<void>>>;
    /** The thread's stored summary of older messages, if a handoff made one (ADR 017). */
    readonly findCheckpoint: (threadId: ThreadId) => Effect.Effect<Option.Option<ThreadCheckpoint>>;
    /** Replaces the thread's stored summary. */
    readonly saveCheckpoint: (checkpoint: ThreadCheckpoint) => Effect.Effect<void>;
    /**
     * Writes a new camp and journals `CampMade`, in one transaction (ADR 037). The camp's id is the
     * command's key: the same camp stored under it already is returned as it is, with nothing
     * journaled, and a different thread under it is refused.
     */
    readonly makeCamp: (camp: Thread) => Effect.Effect<Committed<Thread>, ThreadKeyReused>;
    /**
     * Moves a chapter into a camp, in one transaction (ADR 037, #1385): re-parents its messages,
     * decisions, artifacts and the quests started in it with their open questions and backpack
     * items, leaves a stub in the thread, and journals `ChapterMoved`, after `CampMade` for a new
     * camp and before the suggestion it accepts and each moved backpack item. The same move asked
     * again returns what it did and journals nothing.
     */
    readonly moveChapter: (input: {
      readonly threadId: ThreadId;
      readonly chapterId: ChapterId;
      readonly target: ChapterMoveTarget;
      readonly at: string;
    }) => Effect.Effect<
      Committed<ChapterMove>,
      ChapterRefused | ChapterNotFound | IllegalChapterTransition | ThreadKeyReused
    >;
    /**
     * Start fresh, in one transaction (ADR 037): writes `superseded`, the chat after its Supersede,
     * at the revision it was read at, and the new `chat`; moves the chat's open work to the new one,
     * recording each thing as a carried item; journals `ChatStartedFresh`, then each moved backpack
     * item as `BackpackItemChanged`. None, and nothing changed, when the chat changed since it was read.
     */
    readonly startFresh: (input: {
      readonly superseded: Thread;
      readonly chat: Thread;
    }) => Effect.Effect<Option.Option<Committed<StartedFresh>>>;
    /** What Start fresh carried into the thread, in the order it recorded them; none for most threads. */
    readonly listCarriedOver: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CarriedOver>>;
    /**
     * The thread's open work, as Start fresh would carry it (ADR 037): the Tasks asked for there
     * that are not over, with their trees, their open questions and the backpack items the
     * thread's turns carry. The context pack names it (#1380).
     */
    readonly listOpenWork: (threadId: ThreadId) => Effect.Effect<ChatWork>;
    /**
     * What Start fresh would carry out of the thread if it ran now, in the order it would record
     * them, read with the same rule; it changes nothing.
     */
    readonly carryOver: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<CarriedOverEntry>>;
  }
>()("@hobbots/agents/HobbotsRepository") {}
