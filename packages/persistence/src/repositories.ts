import { HobbotsRepository } from "@hobbots/agents";
import {
  Agent,
  AgentConfiguration,
  AgentStatus,
  type ChangeActor,
  type Committed,
  type HobPolicy,
  heldCharms,
  type JournaledEvent,
  Message,
  type MessageId,
  messageEvents,
  previewLine,
  type ReplyUsage,
  type SkillUse,
  Thread,
  ThreadCheckpoint,
  ThreadId,
  YOU,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { makeJournaled } from "./journal.ts";
import { insertSkillUse } from "./skill-uses.ts";

// Rows use snake_case columns; the client transforms them to the camelCase domain fields.
// Where SQLite and PostgreSQL differ, the query chooses explicitly (ADR 011).

interface AgentRow {
  readonly lookSeed?: unknown;
  readonly revision?: unknown;
  readonly ownFolders?: unknown;
  readonly hiddenSharedFolders?: unknown;
  readonly policyOverrides?: unknown;
  readonly signCommits?: unknown;
  readonly charms?: unknown;
  readonly summoningScope?: unknown;
  readonly withheldCharms?: unknown;
  readonly visibleToHobs?: unknown;
  readonly summonedUnattended?: unknown;
  readonly actor?: unknown;
}

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every look seed and revision fits a number.
// The policy's three JSON text columns (migration 0015), its signing flag (0021) and the ids of its
// Charms (0076), its Summoning scope and the Charms withheld from it (0083) become the hob's one
// `policy` field. Being visible to other hobs is 0 or 1 (0079), and
// so is being summoned unattended on a hob; a configuration version's actor is JSON text (0082).
export const agentRows = (rows: ReadonlyArray<AgentRow>) =>
  rows.map(
    ({
      ownFolders,
      hiddenSharedFolders,
      policyOverrides,
      signCommits,
      charms,
      summoningScope,
      withheldCharms,
      visibleToHobs,
      ...row
    }) => ({
      ...row,
      lookSeed: Number(row.lookSeed),
      visibleToHobs: Number(visibleToHobs) === 1,
      ...(row.revision === undefined ? {} : { revision: Number(row.revision) }),
      ...(row.summonedUnattended === undefined ? {} : { summonedUnattended: Number(row.summonedUnattended) === 1 }),
      ...(row.actor === undefined ? {} : { actor: JSON.parse(String(row.actor)) }),
      policy: {
        ownFolders: JSON.parse(String(ownFolders)),
        hiddenSharedFolders: JSON.parse(String(hiddenSharedFolders)),
        overrides: JSON.parse(String(policyOverrides)),
        ...(Number(signCommits) === 1 ? { signCommits: true } : {}),
        charms: {
          granted: JSON.parse(String(charms)),
          ...(summoningScope == null ? {} : { summoning: JSON.parse(String(summoningScope)) }),
          ...charmsWithheld(withheldCharms),
        },
      },
    }),
  );

/** The Charms withheld from a hob, left out when there are none. */
const charmsWithheld = (column: unknown) => {
  const withheld = column == null ? [] : (JSON.parse(String(column)) as ReadonlyArray<string>);
  return withheld.length === 0 ? {} : { withheld };
};

// The columns that store a hob's policy.
const policyColumns = (policy: HobPolicy) => ({
  own_folders: JSON.stringify(policy.ownFolders),
  hidden_shared_folders: JSON.stringify(policy.hiddenSharedFolders),
  // Built-in and Charm overrides share the column; decoding the policy splits them again (ADR 031).
  policy_overrides: JSON.stringify({ ...policy.overrides, ...policy.charms?.overrides }),
  sign_commits: policy.signCommits === true ? 1 : 0,
  charms: JSON.stringify(heldCharms(policy)),
  summoning_scope: policy.charms?.summoning === undefined ? null : JSON.stringify(policy.charms.summoning),
  withheld_charms: JSON.stringify(policy.charms?.withheld ?? []),
});
// The columns one configuration version sets, on the hob and in its history.
const configColumns = (agent: Agent) => ({
  name: agent.name,
  role: agent.role,
  role_title: agent.roleTitle,
  sigil: agent.sigil,
  hat: agent.hat,
  tool: agent.tool,
  good_at: agent.goodAt,
  voice: agent.voice,
  length: agent.length,
  ...policyColumns(agent.policy),
  visible_to_hobs: agent.visibleToHobs ? 1 : 0,
  model: agent.model,
  effort: agent.effort,
  instructions: agent.instructions,
  look_seed: agent.lookSeed,
  look_color: agent.lookColor,
  runtime: agent.runtime,
});
// A thread's sessions, own brain and the draft it tries are JSON text columns (migrations 0020 and 0083).
// `read_revision` stays on the hub: a read shows only whether the thread is `unread` (migration 0053).
export const threadRows = (
  rows: ReadonlyArray<{
    readonly revision?: unknown;
    readonly sessions?: unknown;
    readonly brain?: unknown;
    readonly skillTrial?: unknown;
    readonly lastContent?: unknown;
    readonly readRevision?: unknown;
    readonly unread?: unknown;
  }>,
) =>
  rows.map(({ lastContent, readRevision: _readRevision, unread, ...row }) => ({
    ...row,
    lastLine: typeof lastContent === "string" ? previewLine(lastContent) : null,
    unread: Number(unread ?? 0) === 1,
    revision: Number(row.revision),
    sessions: JSON.parse(String(row.sessions ?? "[]")),
    brain: row.brain == null ? null : JSON.parse(String(row.brain)),
    skillTrial: row.skillTrial == null ? null : JSON.parse(String(row.skillTrial)),
  }));
/**
 * The start of the last message a thread's transcript shows, as `last_content`: queued messages, a
 * lead's quiet progress (#1006) and ones with no text, such as a reply made only of tool calls, are skipped. `threadRows` makes it one line.
 * 600 characters leave room for the whitespace that line collapses before it cuts at `PREVIEW_LENGTH`.
 */
const lastContent = (sql: SqlClient.SqlClient) =>
  sql`(SELECT substr(m.content, 1, 600) FROM messages m
    WHERE m.thread_id = threads.id AND m.status <> 'queued' AND m.quiet = 0 AND trim(m.content) <> ''
    ORDER BY m.seq DESC LIMIT 1) AS last_content`;
/**
 * Whether the hob wrote in the thread since you last read it, as `unread`: a reply that ended with
 * text, or that failed, written after `read_revision` (ADR 027). That counts a reply continued in
 * place after you read it, since its message takes a new revision. A reply still under way waits
 * until it ends, and your own messages and a lead's quiet progress (#1006) never count.
 */
const unreadColumn = (sql: SqlClient.SqlClient) =>
  sql`(CASE WHEN EXISTS (SELECT 1 FROM messages u
    WHERE u.thread_id = threads.id AND u.role = 'assistant' AND u.revision > COALESCE(threads.read_revision, 0)
      AND u.status NOT IN ('queued', 'streaming', 'stopping') AND u.quiet = 0
      AND (trim(u.content) <> '' OR u.status = 'failed')) THEN 1 ELSE 0 END) AS unread`;
const checkpointRows = (rows: ReadonlyArray<{ readonly lines?: unknown; readonly omitted?: unknown }>) =>
  rows.map((row) => ({ ...row, lines: JSON.parse(String(row.lines)), omitted: Number(row.omitted) }));
// A reply's usage is one column per field (migration 0037), read as numbers: PostgreSQL reads
// BIGINT as a bigint. A reply with none of them has no usage.
const measured = (value: unknown) => (value === null || value === undefined ? null : Number(value));

const usageOf = (row: Readonly<Record<string, unknown>>): ReplyUsage | null => {
  const usage: ReplyUsage = {
    timeToRequestMs: measured(row.timeToRequestMs),
    timeToFirstStreamMs: measured(row.timeToFirstStreamMs),
    timeToFirstTokenMs: measured(row.timeToFirstTokenMs),
    inputTokens: measured(row.inputTokens),
    outputTokens: measured(row.outputTokens),
    cacheReadTokens: measured(row.cacheReadTokens),
    cacheWriteTokens: measured(row.cacheWriteTokens),
  };
  return Object.values(usage).every((value) => value === null) ? null : usage;
};

const usageColumns = (usage: ReplyUsage | null) => ({
  time_to_request_ms: usage?.timeToRequestMs ?? null,
  time_to_first_stream_ms: usage?.timeToFirstStreamMs ?? null,
  time_to_first_token_ms: usage?.timeToFirstTokenMs ?? null,
  input_tokens: usage?.inputTokens ?? null,
  output_tokens: usage?.outputTokens ?? null,
  cache_read_tokens: usage?.cacheReadTokens ?? null,
  cache_write_tokens: usage?.cacheWriteTokens ?? null,
});

// A message's steps are one JSON text column (migration 0017).
const messageRows = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  rows.map((row) => ({
    ...row,
    revision: Number(row.revision),
    steps: JSON.parse(String(row.steps ?? "[]")),
    usage: usageOf(row),
    quiet: Number(row.quiet ?? 0) === 1,
    skills: row.skills === null || row.skills === undefined ? null : JSON.parse(String(row.skills)),
    skillsUsed: JSON.parse(String(row.skillsUsed ?? "[]")),
    askedSkill: row.askedSkill ?? null,
  }));

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
        sql`SELECT threads.*, ${lastContent(sql)}, ${unreadColumn(sql)} FROM threads WHERE agent_id = ${agentId} AND archived_at IS NULL
          ORDER BY updated_at DESC, ${byId}`.pipe(Effect.map(threadRows)),
    });
    const listArchivedThreads = SqlSchema.findAll({
      Request: Schema.String,
      Result: Thread,
      execute: (agentId) =>
        sql`SELECT threads.*, ${lastContent(sql)}, ${unreadColumn(sql)} FROM threads WHERE agent_id = ${agentId} AND archived_at IS NOT NULL
          ORDER BY archived_at DESC, ${byId}`.pipe(Effect.map(threadRows)),
    });
    const findThread = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Thread,
      execute: (id) =>
        sql`SELECT threads.*, ${lastContent(sql)}, ${unreadColumn(sql)} FROM threads WHERE id = ${id}`.pipe(
          Effect.map(threadRows),
        ),
    });
    const findCheckpoint = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ThreadCheckpoint,
      execute: (threadId) =>
        sql`SELECT * FROM thread_checkpoints WHERE thread_id = ${threadId}`.pipe(Effect.map(checkpointRows)),
    });
    const listMessages = SqlSchema.findAll({
      Request: Schema.String,
      Result: Message,
      execute: (threadId) =>
        sql`SELECT * FROM messages WHERE thread_id = ${threadId} ORDER BY seq`.pipe(Effect.map(messageRows)),
    });
    const nextQueuedMessage = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Message,
      execute: (threadId) =>
        sql`SELECT * FROM messages WHERE thread_id = ${threadId} AND status = 'queued' ORDER BY seq LIMIT 1`.pipe(
          Effect.map(messageRows),
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
          Effect.map(messageRows),
        ),
    });

    const insertConfig = (agent: Agent, actor: ChangeActor, createdAt: string) =>
      sql`INSERT INTO agent_config_versions ${sql.insert({
        agent_id: agent.id,
        version: agent.configVersion,
        ...configColumns(agent),
        actor: JSON.stringify(actor),
        created_at: createdAt,
      })}`;

    // For changes that always apply.
    const always = <A>(effect: Effect.Effect<Option.Option<Committed<A>>>) =>
      effect.pipe(Effect.map(Option.getOrThrow));

    const insertAgent = (input: Agent, actor: ChangeActor = YOU) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const agent = new Agent({ ...input, revision });
          const inserted = yield* sql`INSERT INTO agents ${sql.insert({
            id: agent.id,
            ...configColumns(agent),
            config_version: agent.configVersion,
            status: agent.status,
            retired_at: agent.retiredAt,
            summoned_by: agent.summonedBy,
            summoned_for: agent.summonedFor,
            summoned_unattended: agent.summonedUnattended ? 1 : 0,
            created_at: agent.createdAt,
            revision,
          })} ON CONFLICT (id) DO NOTHING RETURNING id`;
          if (inserted.length === 0) return null;
          yield* insertConfig(agent, actor, agent.createdAt);
          return { value: agent, events: [{ _tag: "AgentUpserted", agent, actor }] };
        }),
      );

    // The version check makes concurrent edits of one hob land one at a time.
    const updateAgentConfig = (input: Agent, actor: ChangeActor, createdAt: string) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const agent = new Agent({ ...input, revision });
          const columns = { ...configColumns(agent), config_version: agent.configVersion, revision };
          const updated = yield* sql`UPDATE agents SET ${sql.update(columns)}
            WHERE id = ${agent.id} AND config_version = ${agent.configVersion - 1}
            RETURNING id`;
          if (updated.length === 0) return null;
          yield* insertConfig(agent, actor, createdAt);
          return { value: agent, events: [{ _tag: "AgentUpserted", agent, actor }] };
        }),
      );

    const setAgentStatus = (input: Agent, from: AgentStatus, actor: ChangeActor = YOU) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const agent = new Agent({ ...input, revision });
          const updated = yield* sql`UPDATE agents
            SET status = ${agent.status}, retired_at = ${agent.retiredAt}, revision = ${revision}
            WHERE id = ${agent.id} AND status = ${from} RETURNING id`;
          if (updated.length === 0) return null;
          // Kept for the hob's History and the Changes log, which outlive the journal (migration 0085).
          yield* sql`INSERT INTO agent_status_changes ${sql.insert({
            agent_id: agent.id,
            revision,
            from_status: from,
            status: agent.status,
            actor: JSON.stringify(actor),
            created_at: DateTime.formatIso(yield* DateTime.now),
          })}`;
          return { value: agent, events: [{ _tag: "AgentUpserted", agent, actor }] };
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
            sessions: JSON.stringify(thread.sessions),
            brain: thread.brain === null ? null : JSON.stringify(thread.brain),
            archived_at: thread.archivedAt,
            pinned_at: thread.pinnedAt,
            skill_trial: thread.skillTrial === null ? null : JSON.stringify(thread.skillTrial),
            created_at: thread.createdAt,
            updated_at: thread.updatedAt,
            revision,
          })} ON CONFLICT (id) DO UPDATE SET
            title = excluded.title,
            sessions = excluded.sessions,
            brain = excluded.brain,
            archived_at = excluded.archived_at,
            pinned_at = excluded.pinned_at,
            updated_at = excluded.updated_at,
            revision = excluded.revision`;
          // The last line is read, never written, so the event carries what a read would show.
          const [read] = threadRows(
            yield* sql<{
              readonly lastContent: unknown;
              readonly unread: unknown;
            }>`SELECT ${lastContent(sql)}, ${unreadColumn(sql)} FROM threads WHERE id = ${thread.id}`,
          );
          const shown = new Thread({ ...thread, lastLine: read?.lastLine ?? null, unread: read?.unread ?? false });
          return { value: shown, events: [{ _tag: "ThreadUpserted", thread: shown }] };
        }),
      );

    // Moves the read marker forward to the newest revision of the messages up to this one, capped at
    // the revision you saw, so a reply continued since stays unread, never back, and announces the
    // thread with its new revision, so every device clears its unread dot (ADR 027).
    const markThreadRead = (threadId: ThreadId, messageId: MessageId, seenRevision: number) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const seen = sql`(SELECT MAX(m.revision) FROM messages m
            WHERE m.thread_id = ${threadId} AND m.revision <= ${seenRevision}
              AND m.seq <= (SELECT seq FROM messages WHERE id = ${messageId} AND thread_id = ${threadId}))`;
          const moved = yield* sql`UPDATE threads SET read_revision = ${seen}, revision = ${revision}
            WHERE id = ${threadId} AND ${seen} > COALESCE(read_revision, 0)
            RETURNING id`;
          if (moved.length === 0) return null;
          const [thread] = yield* findThread(threadId).pipe(Effect.orDie, Effect.map(Option.toArray));
          if (thread === undefined) return null;
          return { value: thread, events: [{ _tag: "ThreadUpserted", thread }] };
        }),
      );

    // Writes the message row only; the caller journals its events in the same transaction.
    const writeMessage = (message: Message) =>
      Effect.suspend(() => {
        const usage = usageColumns(message.usage);
        return sql`INSERT INTO messages (id, thread_id, role, content, status, error, config_version, runtime, model,
          time_to_request_ms, time_to_first_stream_ms, time_to_first_token_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          resets_at, steps, prompt_id, quiet, skills, skills_used, asked_skill, created_at, revision, seq)
        VALUES (
          ${message.id}, ${message.threadId}, ${message.role}, ${message.content},
          ${message.status}, ${message.error}, ${message.configVersion}, ${message.runtime}, ${message.model},
          ${usage.time_to_request_ms}, ${usage.time_to_first_stream_ms}, ${usage.time_to_first_token_ms},
          ${usage.input_tokens}, ${usage.output_tokens}, ${usage.cache_read_tokens}, ${usage.cache_write_tokens},
          ${message.resetsAt}, ${JSON.stringify(message.steps)}, ${message.promptId},
          ${message.quiet ? 1 : 0},
          ${message.skills === null ? null : JSON.stringify(message.skills)},
          ${JSON.stringify(message.skillsUsed)}, ${message.askedSkill},
          ${message.createdAt}, ${message.revision},
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE thread_id = ${message.threadId})
        )
        ON CONFLICT (id) DO UPDATE SET
          content = excluded.content,
          status = excluded.status,
          error = excluded.error,
          config_version = excluded.config_version,
          runtime = excluded.runtime,
          model = excluded.model,
          time_to_request_ms = excluded.time_to_request_ms,
          time_to_first_stream_ms = excluded.time_to_first_stream_ms,
          time_to_first_token_ms = excluded.time_to_first_token_ms,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          resets_at = excluded.resets_at,
          steps = excluded.steps,
          quiet = excluded.quiet,
          skills = excluded.skills,
          skills_used = excluded.skills_used,
          revision = excluded.revision`;
      });

    // The message's revision is its MessageUpserted entry, the first of its events. The skill uses
    // its turn recorded are saved with it, so a count never outlives a reply that lost its line.
    const upsertMessage = (input: Message, uses: ReadonlyArray<SkillUse>) =>
      journaled(messageEvents(input).length + uses.length, (revision) =>
        Effect.gen(function* () {
          const message = new Message({ ...input, revision });
          yield* writeMessage(message);
          for (const use of uses) yield* insertSkillUse(sql, use);
          const used = uses.map((use): JournaledEvent => ({ _tag: "SkillUsed", use }));
          return { value: message, events: [...messageEvents(message), ...used] };
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
      updateAgentConfig: (agent, actor = YOU) =>
        DateTime.now.pipe(Effect.flatMap((now) => updateAgentConfig(agent, actor, DateTime.formatIso(now)))),
      listThreads: (agentId) => listThreads(agentId).pipe(Effect.orDie),
      listArchivedThreads: (agentId) => listArchivedThreads(agentId).pipe(Effect.orDie),
      findThread: (id) => findThread(id).pipe(Effect.orDie),
      upsertThread: (thread) => always(upsertThread(thread)),
      markThreadRead,
      listMessages: (threadId) => listMessages(threadId).pipe(Effect.orDie),
      upsertMessage: (message, uses = []) => always(upsertMessage(message, uses)),
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
      findCheckpoint: (threadId) => findCheckpoint(threadId).pipe(Effect.orDie),
      // Not journaled: the summary is the hub's own record, never shown to clients.
      saveCheckpoint: (checkpoint) =>
        sql`INSERT INTO thread_checkpoints ${sql.insert({
          thread_id: checkpoint.threadId,
          through_message_id: checkpoint.throughMessageId,
          lines: JSON.stringify(checkpoint.lines),
          omitted: checkpoint.omitted,
          created_at: checkpoint.createdAt,
        })} ON CONFLICT (thread_id) DO UPDATE SET
          through_message_id = excluded.through_message_id,
          lines = excluded.lines,
          omitted = excluded.omitted,
          created_at = excluded.created_at`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
