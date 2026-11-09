import type {
  Agent,
  AgentConfiguration,
  AgentId,
  AgentStatus,
  ChangeActor,
  Committed,
  Message,
  MessageId,
  Retiring,
  SkillUse,
  Thread,
  ThreadCheckpoint,
  ThreadId,
} from "@hobbots/domain";
import { Context, type Effect, type Option } from "effect";

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
     * Writes the thread, leaving how far you read it as it is: only `markThreadRead` moves that.
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
    /**
     * Saves the message with the events it produces (`messageEvents`), and in the same transaction
     * any skill uses its turn recorded, each journaled as `SkillUsed` (ADR 029, The use line).
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
     * moves after every message in the thread and the reply follows it, so a crash leaves either a
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
  }
>()("@hobbots/agents/HobbotsRepository") {}
