import type {
  Agent,
  AgentConfiguration,
  AgentId,
  AgentStatus,
  Committed,
  Message,
  MessageId,
  Thread,
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
     * Saves the hob's lifecycle fields (status and retirement time) from `next`. None, and nothing
     * changed, when its stored status is no longer `from` (another change landed first).
     */
    readonly setAgentStatus: (next: Agent, from: AgentStatus) => Effect.Effect<Option.Option<Committed<Agent>>>;
    /** Inserts the hob and its first configuration unless one with its id exists; none when it was not inserted. */
    readonly insertAgent: (agent: Agent) => Effect.Effect<Option.Option<Committed<Agent>>>;
    readonly findAgentConfig: (id: AgentId, version: number) => Effect.Effect<Option.Option<AgentConfiguration>>;
    /**
     * Stores the hob's next configuration version and makes it current. None, and nothing stored,
     * when the hob's current version is no longer the one before it (another edit landed first).
     */
    readonly updateAgentConfig: (agent: Agent) => Effect.Effect<Option.Option<Committed<Agent>>>;
    readonly listThreads: (agentId: AgentId) => Effect.Effect<ReadonlyArray<Thread>>;
    readonly findThread: (id: ThreadId) => Effect.Effect<Option.Option<Thread>>;
    readonly upsertThread: (thread: Thread) => Effect.Effect<Committed<Thread>>;
    readonly listMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Message>>;
    /** Saves the message with the events it produces (`messageEvents`). */
    readonly upsertMessage: (message: Message) => Effect.Effect<Committed<Message>>;
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
  }
>()("@hobbots/agents/HobbotsRepository") {}
