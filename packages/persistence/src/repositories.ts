import { Agent, type AgentId, Message, Thread, type ThreadId } from "@hobbots/domain";
import { Context, Effect, Layer, type Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

// Rows use snake_case columns; the client transforms them to the camelCase domain fields.
// Where SQLite and PostgreSQL differ, the query chooses explicitly (ADR 011).

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every look seed fits a number.
const agentRows = (rows: ReadonlyArray<{ readonly lookSeed?: unknown }>) =>
  rows.map((row) => ({ ...row, lookSeed: Number(row.lookSeed) }));

export class HobbotsRepository extends Context.Service<
  HobbotsRepository,
  {
    readonly listAgents: Effect.Effect<ReadonlyArray<Agent>>;
    readonly findAgent: (id: AgentId) => Effect.Effect<Option.Option<Agent>>;
    readonly insertAgent: (agent: Agent) => Effect.Effect<void>;
    readonly listThreads: (agentId: AgentId) => Effect.Effect<ReadonlyArray<Thread>>;
    readonly findThread: (id: ThreadId) => Effect.Effect<Option.Option<Thread>>;
    readonly upsertThread: (thread: Thread) => Effect.Effect<void>;
    readonly listMessages: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<Message>>;
    readonly upsertMessage: (message: Message) => Effect.Effect<void>;
    /** Marks assistant messages left streaming by a previous process as interrupted. */
    readonly interruptStaleMessages: Effect.Effect<ReadonlyArray<Message>>;
  }
>()("@hobbots/persistence/HobbotsRepository") {
  static readonly layer = Layer.effect(
    HobbotsRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
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
      const findAgent = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Agent,
        execute: (id) => sql`SELECT * FROM agents WHERE id = ${id}`.pipe(Effect.map(agentRows)),
      });
      const listThreads = SqlSchema.findAll({
        Request: Schema.String,
        Result: Thread,
        execute: (agentId) => sql`SELECT * FROM threads WHERE agent_id = ${agentId} ORDER BY updated_at DESC, ${byId}`,
      });
      const findThread = SqlSchema.findOneOption({
        Request: Schema.String,
        Result: Thread,
        execute: (id) => sql`SELECT * FROM threads WHERE id = ${id}`,
      });
      const listMessages = SqlSchema.findAll({
        Request: Schema.String,
        Result: Message,
        execute: (threadId) => sql`SELECT * FROM messages WHERE thread_id = ${threadId} ORDER BY seq`,
      });
      const staleMessages = SqlSchema.findAll({
        Request: Schema.Void,
        Result: Message,
        execute: () => sql`SELECT * FROM messages WHERE status = 'streaming' ORDER BY ${bytewise("thread_id")}, seq`,
      });

      const insertAgent = (agent: Agent) =>
        sql`INSERT INTO agents ${sql.insert({
          id: agent.id,
          name: agent.name,
          role: agent.role,
          runtime: agent.runtime,
          model: agent.model,
          instructions: agent.instructions,
          look_seed: agent.lookSeed,
          look_color: agent.lookColor,
          created_at: agent.createdAt,
        })}`;

      const upsertThread = (thread: Thread) =>
        sql`INSERT INTO threads ${sql.insert({
          id: thread.id,
          agent_id: thread.agentId,
          title: thread.title,
          runtime_session_id: thread.runtimeSessionId,
          created_at: thread.createdAt,
          updated_at: thread.updatedAt,
        })} ON CONFLICT (id) DO UPDATE SET
          title = excluded.title,
          runtime_session_id = excluded.runtime_session_id,
          updated_at = excluded.updated_at`;

      const upsertMessage = (message: Message) =>
        sql`INSERT INTO messages (id, thread_id, role, content, status, error, created_at, seq)
          VALUES (
            ${message.id}, ${message.threadId}, ${message.role}, ${message.content},
            ${message.status}, ${message.error}, ${message.createdAt},
            (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE thread_id = ${message.threadId})
          )
          ON CONFLICT (id) DO UPDATE SET
            content = excluded.content,
            status = excluded.status,
            error = excluded.error`;

      const interruptStaleMessages = Effect.gen(function* () {
        const stale = yield* staleMessages();
        yield* sql`UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'`;
        return stale.map((message) => new Message({ ...message, status: "interrupted" }));
      });

      return HobbotsRepository.of({
        listAgents: listAgents().pipe(Effect.orDie),
        findAgent: (id) => findAgent(id).pipe(Effect.orDie),
        insertAgent: (agent) => insertAgent(agent).pipe(Effect.asVoid, Effect.orDie),
        listThreads: (agentId) => listThreads(agentId).pipe(Effect.orDie),
        findThread: (id) => findThread(id).pipe(Effect.orDie),
        upsertThread: (thread) => upsertThread(thread).pipe(Effect.asVoid, Effect.orDie),
        listMessages: (threadId) => listMessages(threadId).pipe(Effect.orDie),
        upsertMessage: (message) => upsertMessage(message).pipe(Effect.asVoid, Effect.orDie),
        interruptStaleMessages: interruptStaleMessages.pipe(Effect.orDie),
      });
    }),
  );
}
