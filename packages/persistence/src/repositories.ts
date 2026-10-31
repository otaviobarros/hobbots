import { HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentConfiguration,
  AgentStatus,
  type Committed,
  type HobPolicy,
  type JournaledEvent,
  Message,
  type MessageId,
  messageEvents,
  Thread,
  ThreadId,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { makeJournaled } from "./journal.ts";

// Rows use snake_case columns; the client transforms them to the camelCase domain fields.
// Where SQLite and PostgreSQL differ, the query chooses explicitly (ADR 011).

interface AgentRow {
  readonly lookSeed?: unknown;
  readonly revision?: unknown;
  readonly ownFolders?: unknown;
  readonly hiddenSharedFolders?: unknown;
  readonly policyOverrides?: unknown;
}

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every look seed and revision fits a number.
// The policy's three JSON text columns (migration 0015) become the hob's one `policy` field.
const agentRows = (rows: ReadonlyArray<AgentRow>) =>
  rows.map(({ ownFolders, hiddenSharedFolders, policyOverrides, ...row }) => ({
    ...row,
    lookSeed: Number(row.lookSeed),
    ...(row.revision === undefined ? {} : { revision: Number(row.revision) }),
    policy: {
      ownFolders: JSON.parse(String(ownFolders)),
      hiddenSharedFolders: JSON.parse(String(hiddenSharedFolders)),
      overrides: JSON.parse(String(policyOverrides)),
    },
  }));

// The columns that store a hob's policy.
const policyColumns = (policy: HobPolicy) => ({
  own_folders: JSON.stringify(policy.ownFolders),
  hidden_shared_folders: JSON.stringify(policy.hiddenSharedFolders),
  policy_overrides: JSON.stringify(policy.overrides),
});
// The columns one configuration version sets, on the hob and in its history.
const configColumns = (agent: Agent) => ({
  role: agent.role,
  role_title: agent.roleTitle,
  sigil: agent.sigil,
  hat: agent.hat,
  tool: agent.tool,
  voice: agent.voice,
  length: agent.length,
  ...policyColumns(agent.policy),
  model: agent.model,
  effort: agent.effort,
  instructions: agent.instructions,
  look_seed: agent.lookSeed,
  look_color: agent.lookColor,
});
const revisedRows = (rows: ReadonlyArray<{ readonly revision?: unknown }>) =>
  rows.map((row) => ({ ...row, revision: Number(row.revision) }));

/** The SQL store of hobs, threads and messages, for SQLite and PostgreSQL (ADR 011). */
export const HobbotsRepositoryLive = Layer.effect(
  HobbotsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    // Text sort keys compare byte by byte: SQLite's default, PostgreSQL's "C" collation.
    // ISO-8601 timestamps sort the same under either collation.
    const bytewise = (column: string) =>
      sql.onDialectOrElse({
        pg: () => sql.literal(`${column} COLLATE "C"`),
        orElse: () => sql.literal(column),
      });
    // Ties break on the id.
    const byId = bytewise("id");

    const listAgents = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Agent,
      execute: () => sql`SELECT * FROM agents ORDER BY created_at, ${byId}`.pipe(Effect.map(agentRows)),
    });
    const listAgentsWithStatus = SqlSchema.findAll({
      Request: Schema.Array(AgentStatus),
      Result: Agent,
      execute: (statuses) =>
        sql`SELECT * FROM agents WHERE ${sql.in("status", statuses)} ORDER BY created_at, ${byId}`.pipe(
          Effect.map(agentRows),
        ),
    });
    const findAgent = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Agent,
      execute: (id) => sql`SELECT * FROM agents WHERE id = ${id}`.pipe(Effect.map(agentRows)),
    });
    const findAgentConfig = SqlSchema.findOneOption({
      Request: Schema.Struct({ agentId: Schema.String, version: Schema.Number }),
      Result: AgentConfiguration,
      execute: ({ agentId, version }) =>
        sql`SELECT * FROM agent_config_versions WHERE agent_id = ${agentId} AND version = ${version}`.pipe(
          Effect.map(agentRows),
        ),
    });
    const listThreads = SqlSchema.findAll({
      Request: Schema.String,
      Result: Thread,
      execute: (agentId) =>
        sql`SELECT * FROM threads WHERE agent_id = ${agentId} ORDER BY updated_at DESC, ${byId}`.pipe(
          Effect.map(revisedRows),
        ),
    });
    const findThread = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Thread,
      execute: (id) => sql`SELECT * FROM threads WHERE id = ${id}`.pipe(Effect.map(revisedRows)),
    });
    const listMessages = SqlSchema.findAll({
      Request: Schema.String,
      Result: Message,
      execute: (threadId) =>
        sql`SELECT * FROM messages WHERE thread_id = ${threadId} ORDER BY seq`.pipe(Effect.map(revisedRows)),
    });
    const nextQueuedMessage = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Message,
      execute: (threadId) =>
        sql`SELECT * FROM messages WHERE thread_id = ${threadId} AND status = 'queued' ORDER BY seq LIMIT 1`.pipe(
          Effect.map(revisedRows),
        ),
    });
    const threadsWithQueuedMessages = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ threadId: ThreadId }),
      execute: () =>
        sql`SELECT thread_id FROM messages WHERE status = 'queued' GROUP BY thread_id ORDER BY ${bytewise("thread_id")}`,
    });
    const unfinishedMessages = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Message,
      execute: () =>
        sql`SELECT * FROM messages WHERE status IN ('streaming', 'stopping') ORDER BY ${bytewise("thread_id")}, seq`.pipe(
          Effect.map(revisedRows),
        ),
    });

    const insertConfig = (agent: Agent, createdAt: string) =>
      sql`INSERT INTO agent_config_versions ${sql.insert({
        agent_id: agent.id,
        version: agent.configVersion,
        ...configColumns(agent),
        created_at: createdAt,
      })}`;

    // For changes that always apply.
    const always = <A>(effect: Effect.Effect<Option.Option<Committed<A>>>) =>
      effect.pipe(Effect.map(Option.getOrThrow));

    const insertAgent = (input: Agent) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const agent = new Agent({ ...input, revision });
          const inserted = yield* sql`INSERT INTO agents ${sql.insert({
            id: agent.id,
            name: agent.name,
            ...configColumns(agent),
            runtime: agent.runtime,
            config_version: agent.configVersion,
            status: agent.status,
            retired_at: agent.retiredAt,
            created_at: agent.createdAt,
            revision,
          })} ON CONFLICT (id) DO NOTHING RETURNING id`;
          if (inserted.length === 0) return null;
          yield* insertConfig(agent, agent.createdAt);
          return { value: agent, events: [{ _tag: "AgentUpserted", agent }] };
        }),
      );

    // The version check makes concurrent edits of one hob land one at a time.
    const updateAgentConfig = (input: Agent, createdAt: string) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const agent = new Agent({ ...input, revision });
          const columns = { ...configColumns(agent), config_version: agent.configVersion, revision };
          const updated = yield* sql`UPDATE agents SET ${sql.update(columns)}
            WHERE id = ${agent.id} AND config_version = ${agent.configVersion - 1}
            RETURNING id`;
          if (updated.length === 0) return null;
          yield* insertConfig(agent, createdAt);
          return { value: agent, events: [{ _tag: "AgentUpserted", agent }] };
        }),
      );

    const setAgentStatus = (input: Agent, from: AgentStatus) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const agent = new Agent({ ...input, revision });
          const updated = yield* sql`UPDATE agents
            SET status = ${agent.status}, retired_at = ${agent.retiredAt}, revision = ${revision}
            WHERE id = ${agent.id} AND status = ${from} RETURNING id`;
          if (updated.length === 0) return null;
          return { value: agent, events: [{ _tag: "AgentUpserted", agent }] };
        }),
      );

    const upsertThread = (input: Thread) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const thread = new Thread({ ...input, revision });
          yield* sql`INSERT INTO threads ${sql.insert({
            id: thread.id,
            agent_id: thread.agentId,
            title: thread.title,
            runtime_session_id: thread.runtimeSessionId,
            created_at: thread.createdAt,
            updated_at: thread.updatedAt,
            revision,
          })} ON CONFLICT (id) DO UPDATE SET
            title = excluded.title,
            runtime_session_id = excluded.runtime_session_id,
            updated_at = excluded.updated_at,
            revision = excluded.revision`;
          return { value: thread, events: [{ _tag: "ThreadUpserted", thread }] };
        }),
      );

    // Writes the message row only; the caller journals its events in the same transaction.
    const writeMessage = (message: Message) =>
      sql`INSERT INTO messages (id, thread_id, role, content, status, error, config_version, resets_at, created_at, revision, seq)
        VALUES (
          ${message.id}, ${message.threadId}, ${message.role}, ${message.content},
          ${message.status}, ${message.error}, ${message.configVersion}, ${message.resetsAt}, ${message.createdAt}, ${message.revision},
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE thread_id = ${message.threadId})
        )
        ON CONFLICT (id) DO UPDATE SET
          content = excluded.content,
          status = excluded.status,
          error = excluded.error,
          config_version = excluded.config_version,
          resets_at = excluded.resets_at,
          revision = excluded.revision`;

    // The message's revision is its MessageUpserted entry, the first of its events.
    const upsertMessage = (input: Message) =>
      journaled(messageEvents(input).length, (revision) =>
        Effect.gen(function* () {
          const message = new Message({ ...input, revision });
          yield* writeMessage(message);
          return { value: message, events: messageEvents(message) };
        }),
      );

    // The new sequence is read in the same statement, as an insert's is. Events: the started
    // message, its dequeue, then the reply's.
    const startQueuedMessage = (input: Message, inputReply: Message) =>
      journaled(2 + messageEvents(inputReply).length, (first) =>
        Effect.gen(function* () {
          const message = new Message({ ...input, revision: first });
          const reply = new Message({ ...inputReply, revision: first + 2 });
          const started = yield* sql`UPDATE messages SET
              status = ${message.status},
              revision = ${message.revision},
              seq = (SELECT MAX(seq) + 1 FROM messages WHERE thread_id = ${message.threadId})
            WHERE id = ${message.id} AND status = 'queued'
            RETURNING id`;
          if (started.length === 0) return null;
          yield* writeMessage(reply);
          const events: ReadonlyArray<JournaledEvent> = [
            { _tag: "MessageUpserted", message },
            { _tag: "MessageDequeued", threadId: message.threadId, messageId: message.id, reason: "started" },
            ...messageEvents(reply),
          ];
          return { value: { message, reply }, events };
        }),
      );

    const removeQueuedMessage = (threadId: ThreadId, messageId: MessageId) =>
      journaled(1, () =>
        sql`DELETE FROM messages WHERE id = ${messageId} AND thread_id = ${threadId} AND status = 'queued' RETURNING id`.pipe(
          Effect.map((rows) =>
            rows.length === 0
              ? null
              : {
                  value: undefined,
                  events: [{ _tag: "MessageDequeued", threadId, messageId, reason: "removed" } as const],
                },
          ),
        ),
      );

    return HobbotsRepository.of({
      listAgents: listAgents().pipe(Effect.orDie),
      listAgentsWithStatus: (statuses) =>
        statuses.length === 0 ? Effect.succeed([]) : listAgentsWithStatus(statuses).pipe(Effect.orDie),
      findAgent: (id) => findAgent(id).pipe(Effect.orDie),
      setAgentStatus,
      insertAgent,
      findAgentConfig: (agentId, version) => findAgentConfig({ agentId, version }).pipe(Effect.orDie),
      updateAgentConfig: (agent) =>
        DateTime.now.pipe(Effect.flatMap((now) => updateAgentConfig(agent, DateTime.formatIso(now)))),
      listThreads: (agentId) => listThreads(agentId).pipe(Effect.orDie),
      findThread: (id) => findThread(id).pipe(Effect.orDie),
      upsertThread: (thread) => always(upsertThread(thread)),
      listMessages: (threadId) => listMessages(threadId).pipe(Effect.orDie),
      upsertMessage: (message) => always(upsertMessage(message)),
      checkpointMessage: (message) =>
        sql`UPDATE messages SET content = ${message.content}
          WHERE id = ${message.id} AND status IN ('streaming', 'stopping')`.pipe(Effect.asVoid, Effect.orDie),
      listUnfinishedMessages: unfinishedMessages().pipe(Effect.orDie),
      nextQueuedMessage: (threadId) => nextQueuedMessage(threadId).pipe(Effect.orDie),
      threadsWithQueuedMessages: threadsWithQueuedMessages().pipe(
        Effect.map((rows) => rows.map((row) => row.threadId)),
        Effect.orDie,
      ),
      startQueuedMessage,
      removeQueuedMessage,
    });
  }),
);
