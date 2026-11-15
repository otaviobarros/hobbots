import { HobbotsRepository, type SentMessage, type SentTo, sessionActor } from "@hobbots/agents";
import {
  Actor,
  Agent,
  AgentConfiguration,
  type AgentId,
  AgentStatus,
  type ChangeActor,
  ChapterId,
  type Committed,
  type HobPolicy,
  heldCharms,
  type JournaledEvent,
  type MentionRefused,
  Message,
  type MessageId,
  mainLine,
  messageEvents,
  previewLine,
  type ReplyUsage,
  type Retiring,
  type SkillUse,
  Channel,
  ChannelCheckpoint,
  ChannelId,
  type TurnRequestId,
  TurnRequests,
  UnreadChannels,
  YOU,
} from "@hobbots/domain";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { answerersIn } from "./answerer-reads.ts";
import { makeCampWrites, channelColumns } from "./camps.ts";
import { makeChapterMoves } from "./chapter-moves.ts";
import { startFirstChapterIn } from "./chapters.ts";
import { makeJournaled, makeJournaledChange } from "./journal.ts";
import { joinedMentions, mentionsToStore, parseMentions, type StoredMentions } from "./message-mentions.ts";
import { mayComplete, mayRelay, relaysFor, stopWasAsked } from "./relays.ts";
import { insertSkillUse } from "./skill-uses.ts";
import { liveChapterColumn, memberUnread } from "./channel-columns.ts";
import { markMemberRead, startMembersIn } from "./channel-member-rows.ts";
import {
  insertRequest,
  requestsFor,
  selectOpenRequests,
  selectOpenRequestsOf,
  stepRequests,
} from "./turn-request-rows.ts";
import { makeTurnRequestWrites, speakFor } from "./turn-requests.ts";

const decodeActor = Schema.decodeUnknownSync(Actor);

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
  readonly retiring?: unknown;
}

// PostgreSQL reads BIGINT as a bigint and SQLite as a number; every look seed and revision fits a number.
// The policy's three JSON text columns (migration 0015), its signing flag (0021) and the ids of its
// Charms (0076), its Summoning scope and the Charms withheld from it (0083) become the hob's one
// `policy` field. Being visible to other hobs is 0 or 1 (0079), and
// so is being summoned unattended on a hob; a configuration version's actor is JSON text (0082), and
// so is a hob's wait to retire (0088).
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
      ...(row.retiring === undefined
        ? {}
        : { retiring: row.retiring === null ? null : JSON.parse(String(row.retiring)) }),
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
// A channel's sessions, own brain and the draft it tries are JSON text columns (migrations 0020 and 0083).
// `read_revision` stays on the hub: a read shows only whether the channel is `unread` (migration 0053).
// `private` is 0 or 1, and `origin` two columns (migration 0095).
export const channelRows = (
  rows: ReadonlyArray<{
    readonly revision?: unknown;
    readonly private?: unknown;
    readonly originChannelId?: unknown;
    readonly originChapterId?: unknown;
    readonly liveChapterId?: unknown;
    readonly liveChapterMerges?: unknown;
    readonly sessions?: unknown;
    readonly brain?: unknown;
    readonly skillTrial?: unknown;
    readonly lastContent?: unknown;
    readonly lastAuthorKind?: unknown;
    readonly lastAuthorId?: unknown;
  }>,
) =>
  rows.map(({ lastContent, lastAuthorKind, lastAuthorId, originChannelId, originChapterId, ...row }) => ({
    ...row,
    private: Number(row.private ?? 0) === 1,
    origin: originChannelId == null ? null : { channelId: originChannelId, chapterId: originChapterId ?? null },
    liveChapterId: row.liveChapterId ?? null,
    liveChapterMerges: Number(row.liveChapterMerges ?? 0),
    lastLine: typeof lastContent === "string" ? previewLine(lastContent) : null,
    lastAuthor:
      typeof lastContent === "string" && lastAuthorKind != null ? { kind: lastAuthorKind, id: lastAuthorId } : null,
    revision: Number(row.revision),
    sessions: JSON.parse(String(row.sessions ?? "[]")),
    brain: row.brain == null ? null : JSON.parse(String(row.brain)),
    skillTrial: row.skillTrial == null ? null : JSON.parse(String(row.skillTrial)),
  }));
/**
 * The last message a channel's transcript shows, joined as `last_message`: queued messages, a lead's
 * quiet progress (#1006) and ones with no text, such as a reply made only of tool calls, are skipped.
 * One correlated lookup per channel row, in the query that reads the channel, so a list of channels
 * reads every last line and its author at once.
 */
const lastMessageJoin = (sql: SqlClient.SqlClient) =>
  sql`LEFT JOIN messages last_message ON last_message.id = (SELECT m.id FROM messages m
    WHERE m.channel_id = channels.id AND m.status <> 'queued' AND m.quiet = 0 AND trim(m.content) <> ''
    ORDER BY m.seq DESC LIMIT 1)`;
/**
 * That message's start, as `last_content`, and its author's two columns (migration 0101), as
 * `last_author_kind` and `last_author_id`. `channelRows` makes them one line and an actor. 600
 * characters leave room for the whitespace that line collapses before it cuts at `PREVIEW_LENGTH`.
 */
const lastMessageColumns = (sql: SqlClient.SqlClient) =>
  sql`substr(last_message.content, 1, 600) AS last_content,
    last_message.actor_kind AS last_author_kind, last_message.actor_id AS last_author_id`;
/** The live chapter of `channelId`, which a new message joins. */
const liveChapterOf = (sql: SqlClient.SqlClient, channelId: ChannelId) =>
  sql`(SELECT c.id FROM chapters c WHERE c.channel_id = ${channelId} AND c.state = 'live')`;
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
export const messageRows = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>) =>
  rows.map((row) => ({
    ...row,
    revision: Number(row.revision),
    steps: JSON.parse(String(row.steps ?? "[]")),
    usage: usageOf(row),
    quiet: Number(row.quiet ?? 0) === 1,
    skills: row.skills === null || row.skills === undefined ? null : JSON.parse(String(row.skills)),
    skillsUsed: JSON.parse(String(row.skillsUsed ?? "[]")),
    askedSkill: row.askedSkill ?? null,
    mentions: JSON.parse(String(row.mentions ?? "[]")),
    readWeb: row.readWeb == null ? null : JSON.parse(String(row.readWeb)),
    // Its author is two columns (migration 0101).
    actor: row.actorKind == null ? null : { kind: row.actorKind, id: row.actorId },
  }));

/** The SQL store of hobs, channels and messages, for SQLite and PostgreSQL (ADR 011). */
export const HobbotsRepositoryLive = Layer.effect(
  HobbotsRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const journaled = makeJournaled(sql);
    const journaledChange = makeJournaledChange(sql);
    // Text sort keys compare byte by byte: SQLite's default, PostgreSQL's "C" collation.
    // ISO-8601 timestamps sort the same under either collation.
    const bytewise = (column: string) =>
      sql.onDialectOrElse({
        pg: () => sql.literal(`${column} COLLATE "C"`),
        orElse: () => sql.literal(column),
      });
    // Ties break on the id.
    const byId = bytewise("id");
    const channelById = bytewise("channels.id");

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
    const listChannels = SqlSchema.findAll({
      Request: Schema.String,
      Result: Channel,
      execute: (agentId) =>
        sql`SELECT channels.*, ${lastMessageColumns(sql)}, ${liveChapterColumn(sql)} FROM channels ${lastMessageJoin(sql)}
          WHERE channels.agent_id = ${agentId} AND channels.archived_at IS NULL
          ORDER BY channels.updated_at DESC, ${channelById}`.pipe(Effect.map(channelRows)),
    });
    const listArchivedChannels = SqlSchema.findAll({
      Request: Schema.String,
      Result: Channel,
      execute: (agentId) =>
        sql`SELECT channels.*, ${lastMessageColumns(sql)}, ${liveChapterColumn(sql)} FROM channels ${lastMessageJoin(sql)}
          WHERE channels.agent_id = ${agentId} AND channels.archived_at IS NOT NULL
          ORDER BY channels.archived_at DESC, ${channelById}`.pipe(Effect.map(channelRows)),
    });
    const findChannel = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Channel,
      execute: (id) =>
        sql`SELECT channels.*, ${lastMessageColumns(sql)}, ${liveChapterColumn(sql)} FROM channels ${lastMessageJoin(sql)}
          WHERE channels.id = ${id}`.pipe(Effect.map(channelRows)),
    });
    const findCheckpoint = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: ChannelCheckpoint,
      execute: (channelId) =>
        sql`SELECT * FROM channel_checkpoints WHERE channel_id = ${channelId}`.pipe(Effect.map(checkpointRows)),
    });
    const listMessages = SqlSchema.findAll({
      Request: Schema.String,
      Result: Message,
      execute: (channelId) =>
        sql`SELECT * FROM messages WHERE channel_id = ${channelId} ORDER BY seq`.pipe(Effect.map(messageRows)),
    });
    const findMessage = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Message,
      execute: (id) => sql`SELECT * FROM messages WHERE id = ${id}`.pipe(Effect.map(messageRows)),
    });
    const nextQueuedMessage = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Message,
      execute: (channelId) =>
        sql`SELECT * FROM messages WHERE channel_id = ${channelId} AND status = 'queued' ORDER BY seq LIMIT 1`.pipe(
          Effect.map(messageRows),
        ),
    });
    const channelsWithQueuedMessages = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Schema.Struct({ channelId: ChannelId }),
      execute: () =>
        sql`SELECT channel_id FROM messages WHERE status = 'queued' GROUP BY channel_id ORDER BY ${bytewise("channel_id")}`,
    });
    const unfinishedMessages = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Message,
      execute: () =>
        sql`SELECT * FROM messages WHERE status IN ('streaming', 'stopping') ORDER BY ${bytewise("channel_id")}, seq`.pipe(
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

    // The hob as stored now, in the change's transaction, so its event carries what a read would show.
    const storedAgent = (id: AgentId) =>
      findAgent(id).pipe(
        Effect.flatMap((found) => (Option.isSome(found) ? Effect.succeed(found.value) : Effect.die(`No hob ${id}`))),
        Effect.catchTag("SchemaError", Effect.die),
      );

    // A retirement ends any wait to retire. Other moves leave that wait as stored, so a move computed
    // from a read made before it began never undoes it.
    const setAgentStatus = (input: Agent, from: AgentStatus, actor: ChangeActor = YOU) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const updated =
            input.status === "retired"
              ? yield* sql`UPDATE agents
                  SET status = ${input.status}, retired_at = ${input.retiredAt}, retiring = NULL, revision = ${revision}
                  WHERE id = ${input.id} AND status = ${from} RETURNING id`
              : yield* sql`UPDATE agents
                  SET status = ${input.status}, retired_at = ${input.retiredAt}, revision = ${revision}
                  WHERE id = ${input.id} AND status = ${from} RETURNING id`;
          if (updated.length === 0) return null;
          const agent = yield* storedAgent(input.id);
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

    // Only a hob that is not retired and not already waiting starts waiting to retire.
    const setAgentRetiring = (agentId: AgentId, retiring: Retiring, actor: ChangeActor) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const updated = yield* sql`UPDATE agents SET retiring = ${JSON.stringify(retiring)}, revision = ${revision}
            WHERE id = ${agentId} AND status <> 'retired' AND retiring IS NULL RETURNING id`;
          if (updated.length === 0) return null;
          const agent = yield* storedAgent(agentId);
          return { value: agent, events: [{ _tag: "AgentUpserted", agent, actor }] };
        }),
      );

    // Starts the channel's first chapter at `revision` unless it has one; null when it had.
    const startFirstChapter = startFirstChapterIn(sql);
    const startMembers = startMembersIn(sql);

    // The channel as a read shows it: its last line and live chapter are read, never
    // written, so the event that journals it carries what a read would show.
    const asRead = (channel: Channel) =>
      Effect.gen(function* () {
        const [read] = channelRows(
          yield* sql<{
            readonly lastContent: unknown;
            readonly lastAuthorKind: unknown;
            readonly lastAuthorId: unknown;
            readonly liveChapterId: unknown;
            readonly liveChapterMerges: unknown;
          }>`SELECT ${lastMessageColumns(sql)}, ${liveChapterColumn(sql)} FROM channels ${lastMessageJoin(sql)}
            WHERE channels.id = ${channel.id}`,
        );
        return new Channel({
          ...channel,
          lastLine: read?.lastLine ?? null,
          lastAuthor: read?.lastAuthor == null ? null : decodeActor(read.lastAuthor),
          liveChapterId: read?.liveChapterId == null ? null : ChapterId.make(String(read.liveChapterId)),
          liveChapterMerges: read?.liveChapterMerges ?? 0,
        });
      });

    // A channel stored for the first time starts its first chapter in the same transaction (ADR 037),
    // journaled after it, so every channel has a live chapter for its messages to join.
    const upsertChannel = (input: Channel) =>
      journaledChange<Channel, never>((revision) =>
        Effect.gen(function* () {
          const channel = new Channel({ ...input, revision });
          yield* sql`INSERT INTO channels ${sql.insert(channelColumns(channel))} ON CONFLICT (id) DO UPDATE SET
            title = excluded.title,
            sessions = excluded.sessions,
            brain = excluded.brain,
            kind = excluded.kind,
            goal = excluded.goal,
            private = excluded.private,
            origin_channel_id = excluded.origin_channel_id,
            origin_chapter_id = excluded.origin_chapter_id,
            state = excluded.state,
            archived_at = excluded.archived_at,
            pinned_at = excluded.pinned_at,
            updated_at = excluded.updated_at,
            revision = excluded.revision`;
          const started = yield* startFirstChapter(channel, revision + 1);
          const shown = yield* asRead(channel);
          const events: Array<JournaledEvent> = [{ _tag: "ChannelUpserted", channel: shown }];
          if (started !== null) {
            events.push({ _tag: "ChapterStarted", channelId: channel.id, chapter: started, ended: null });
            // A channel stored for the first time starts with its person and its hob as members (ADR 039).
            events.push(...(yield* startMembers(channel, revision + 2)));
          }
          return { value: shown, events };
        }),
      );

    // Moves the reader's marker forward to the newest revision of the messages up to this one, capped
    // at the revision they saw, so a reply continued since stays unread, never back, and journals
    // their member row, so every device of theirs clears its unread dot (ADR 027, ADR 039).
    const markChannelRead = (channelId: ChannelId, messageId: MessageId, seenRevision: number) =>
      journaled(1, (revision) =>
        Effect.gen(function* () {
          const seen = sql`(SELECT MAX(m.revision) FROM messages m
            WHERE m.channel_id = ${channelId} AND m.revision <= ${seenRevision}
              AND m.seq <= (SELECT seq FROM messages WHERE id = ${messageId} AND channel_id = ${channelId}))`;
          const moved = yield* markMemberRead(sql, channelId, yield* sessionActor, seen, revision);
          if (Option.isNone(moved)) return null;
          return { value: moved.value, events: [{ _tag: "ChannelMemberChanged", member: moved.value }] };
        }),
      );

    // The channels with a reply the person asking has not read (ADR 039), with the journal's head
    // read first, so a reply that lands meanwhile is either listed or after `through`.
    const listUnreadChannels = Effect.gen(function* () {
      const reader = yield* sessionActor;
      const [head] = yield* sql<{ readonly through: unknown }>`SELECT COALESCE(MAX(sequence), 0) AS through
        FROM event_journal`;
      const rows = yield* sql<{ readonly channelId: ChannelId }>`SELECT channel_id FROM channel_members
        WHERE actor_kind = ${reader.kind} AND actor_id = ${reader.id} AND ${memberUnread(sql)}
        ORDER BY ${bytewise("channel_id")}`;
      return new UnreadChannels({ channelIds: rows.map((row) => row.channelId), through: Number(head?.through ?? 0) });
    }).pipe(Effect.orDie);

    // Writes the message row only; the caller journals its events in the same transaction. A new
    // message joins its channel's live chapter (ADR 037); a stored one stays in its chapter. Returns
    // the message as stored, with its chapter. `parsed` is its mentions when the caller parsed them
    // already in the same transaction.
    const writeMessage = (message: Message, parsed?: StoredMentions) =>
      Effect.suspend(() => {
        const usage = usageColumns(message.usage);
        // A new message names its author as it is stored (ADR 037): the person who sent it, or its
        // channel's hob. A person's message names them already (ADR 039): the hub never assumes one.
        const author = message.actor;
        if (author === null && message.role !== "assistant") {
          return Effect.die(new Error(`A ${message.role} message must name the person who wrote it`));
        }
        return (parsed === undefined ? mentionsToStore(sql, message) : Effect.succeed(parsed)).pipe(
          Effect.flatMap(({ mentions, through }) =>
            sql<{
              readonly chapterId: string;
              readonly actorKind: string;
              readonly actorId: string;
            }>`INSERT INTO messages (id, channel_id, chapter_id, actor_kind, actor_id, role, content, status, error, config_version, runtime, model,
          time_to_request_ms, time_to_first_stream_ms, time_to_first_token_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          resets_at, steps, prompt_id, quiet, skills, skills_used, asked_skill, mentions, mentions_through, read_web, created_at, revision, seq)
        VALUES (
          ${message.id}, ${message.channelId}, COALESCE(${message.chapterId}, ${liveChapterOf(sql, message.channelId)}),
          ${author?.kind ?? "hob"},
          COALESCE(${author?.id ?? null},
            (SELECT t.agent_id FROM channels t WHERE t.id = ${message.channelId})),
          ${message.role}, ${message.content},
          ${message.status}, ${message.error}, ${message.configVersion}, ${message.runtime}, ${message.model},
          ${usage.time_to_request_ms}, ${usage.time_to_first_stream_ms}, ${usage.time_to_first_token_ms},
          ${usage.input_tokens}, ${usage.output_tokens}, ${usage.cache_read_tokens}, ${usage.cache_write_tokens},
          ${message.resetsAt}, ${JSON.stringify(message.steps)}, ${message.promptId},
          ${message.quiet ? 1 : 0},
          ${message.skills === null ? null : JSON.stringify(message.skills)},
          ${JSON.stringify(message.skillsUsed)}, ${message.askedSkill}, ${JSON.stringify(mentions)}, ${through},
          ${message.readWeb === null ? null : JSON.stringify(message.readWeb)},
          ${message.createdAt}, ${message.revision},
          (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE channel_id = ${message.channelId})
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
          mentions = excluded.mentions,
          mentions_through = excluded.mentions_through,
          read_web = excluded.read_web,
          revision = excluded.revision
        RETURNING chapter_id, actor_kind, actor_id`.pipe(
              Effect.map(
                ([row]) =>
                  new Message({
                    ...message,
                    chapterId: ChapterId.make(String(row?.chapterId)),
                    actor: { kind: row?.actorKind as Actor["kind"], id: String(row?.actorId) },
                    mentions,
                  }),
              ),
            ),
          ),
        );
      });

    // The message's revision is its MessageUpserted entry, the first of its events. The skill uses
    // its turn recorded are saved with it, so a count never outlives a reply that lost its line.
    const upsertMessage = (input: Message, uses: ReadonlyArray<SkillUse>) =>
      journaled(messageEvents(input).length + uses.length, (revision) =>
        Effect.gen(function* () {
          // A reply you asked to stop may still complete, and then relays nothing (ADR 039).
          const stopAsked = mayComplete(input) && (yield* stopWasAsked(sql, input.id));
          const message = yield* writeMessage(new Message({ ...input, revision }));
          for (const use of uses) yield* insertSkillUse(sql, use);
          // A hob's reply saved complete owes the hobs it mentions their answers, written with it so
          // no restart loses them, under the journal's lock so Stop all's drop sees them (ADR 039).
          if (mayRelay(message) && !stopAsked) {
            for (const relay of yield* relaysFor(sql, message)) yield* insertRequest(sql, relay);
          }
          const used = uses.map((use): JournaledEvent => ({ _tag: "SkillUsed", use }));
          return { value: message, events: [...messageEvents(message), ...used] };
        }),
      );

    // Who answers is decided after the journal's head is locked, so a member added or a Quest
    // started at the same moment commits wholly before this reads or wholly after it (ADR 039).
    const sendMessage = (input: Message, to: SentTo) =>
      journaledChange<SentMessage, MentionRefused>((revision) =>
        Effect.gen(function* () {
          const [channel] = yield* sql<{ readonly kind: Channel["kind"] }>`SELECT kind FROM channels
            WHERE id = ${input.channelId}`;
          if (channel === undefined) return yield* Effect.die(new Error(`Channel ${input.channelId} does not exist`));
          // Its mentions are parsed from its text first, so who answers reads the ones it stores.
          const found = yield* mentionsToStore(sql, input);
          const parsed = { ...found, mentions: joinedMentions(found.mentions, to.mentions) };
          const said = { ...input, mentions: parsed.mentions, repliesTo: to.repliesTo };
          const answerers = yield* answerersIn(sql, { id: input.channelId, kind: channel.kind }, said);
          // A message nobody answers starts no turn, so it never waits in the queue.
          const status = answerers.length === 0 && input.status === "queued" ? "complete" : input.status;
          const message = yield* writeMessage(new Message({ ...input, status, revision }), parsed);
          const author = message.actor ?? (yield* sessionActor);
          // A person who writes takes over from the hobs the relay budget paused there (ADR 039).
          if (author.kind === "user" && message.role !== "note") {
            const open = yield* selectOpenRequests(sql, mainLine(message.channelId));
            yield* stepRequests(sql, TurnRequests.paused(open), { _tag: "Drop", by: author });
          }
          // Each answer owed waits for the floor, written with the message (ADR 039).
          const elsewhere = new Set<string>(to.takenElsewhere ?? []);
          const requests = requestsFor(message, author, answerers, to.relayDepth ?? 0).filter(
            (request) => !elsewhere.has(request.hobId),
          );
          for (const request of requests) yield* insertRequest(sql, request);
          return { value: { message, answerers, requests }, events: messageEvents(message) };
        }),
      );

    // The new sequence is read in the same statement, as an insert's is. Events: the started
    // message, its dequeue, then the reply's.
    const startQueuedMessage = (input: Message, inputReply: Message, speaking: ReadonlyArray<TurnRequestId> = []) =>
      journaled(2 + messageEvents(inputReply).length, (first) =>
        Effect.gen(function* () {
          // The requests its turn answers take the floor with it, or neither starts.
          if (!(yield* speakFor(sql, speaking, inputReply.id))) return null;
          const queued = new Message({ ...input, revision: first });
          // It joins the live chapter as it starts, as its reply does, wherever it waited (ADR 037).
          const [started] = yield* sql<{ readonly chapterId: string }>`UPDATE messages SET
              status = ${queued.status},
              revision = ${queued.revision},
              chapter_id = ${liveChapterOf(sql, queued.channelId)},
              seq = (SELECT MAX(seq) + 1 FROM messages WHERE channel_id = ${queued.channelId})
            WHERE id = ${queued.id} AND status = 'queued'
            RETURNING chapter_id`;
          if (started === undefined) return null;
          const message = new Message({ ...queued, chapterId: ChapterId.make(started.chapterId) });
          const reply = yield* writeMessage(new Message({ ...inputReply, revision: first + 2, chapterId: null }));
          const events: ReadonlyArray<JournaledEvent> = [
            { _tag: "MessageUpserted", message },
            { _tag: "MessageDequeued", channelId: message.channelId, messageId: message.id, reason: "started" },
            ...messageEvents(reply),
          ];
          return { value: { message, reply }, events };
        }),
      );

    // What was owed for the message goes with it, dropped by whoever removed it.
    const removeQueuedMessage = (channelId: ChannelId, messageId: MessageId) =>
      journaled(1, () =>
        Effect.gen(function* () {
          const removed = yield* sql`DELETE FROM messages
            WHERE id = ${messageId} AND channel_id = ${channelId} AND status = 'queued' RETURNING id`;
          if (removed.length === 0) return null;
          const owed = yield* selectOpenRequestsOf(sql, "message_id", [messageId]);
          yield* stepRequests(sql, owed, { _tag: "Drop", by: yield* sessionActor });
          return {
            value: undefined,
            events: [{ _tag: "MessageDequeued", channelId, messageId, reason: "removed" } as const],
          };
        }),
      );

    const floor = makeTurnRequestWrites(
      sql,
      journaled,
      journaledChange,
      writeMessage,
      (id) => findMessage(id).pipe(Effect.orDie),
      messageEvents,
    );

    const readChannel = (id: ChannelId) => findChannel(id).pipe(Effect.map(Option.getOrUndefined), Effect.orDie);
    const camps = makeCampWrites(sql, readChannel);
    const moves = makeChapterMoves(sql, readChannel, camps);

    return HobbotsRepository.of({
      listAgents: listAgents().pipe(Effect.orDie),
      listAgentsWithStatus: (statuses) =>
        statuses.length === 0 ? Effect.succeed([]) : listAgentsWithStatus(statuses).pipe(Effect.orDie),
      findAgent: (id) => findAgent(id).pipe(Effect.orDie),
      setAgentStatus,
      setAgentRetiring,
      insertAgent,
      findAgentConfig: (agentId, version) => findAgentConfig({ agentId, version }).pipe(Effect.orDie),
      updateAgentConfig: (agent, actor = YOU) =>
        DateTime.now.pipe(Effect.flatMap((now) => updateAgentConfig(agent, actor, DateTime.formatIso(now)))),
      listChannels: (agentId) => listChannels(agentId).pipe(Effect.orDie),
      listArchivedChannels: (agentId) => listArchivedChannels(agentId).pipe(Effect.orDie),
      findChannel: (id) => findChannel(id).pipe(Effect.orDie),
      upsertChannel,
      markChannelRead,
      listUnreadChannels,
      listMessages: (channelId) => listMessages(channelId).pipe(Effect.orDie),
      findMessage: (id) => findMessage(id).pipe(Effect.orDie),
      upsertMessage: (message, uses = []) => always(upsertMessage(message, uses)),
      sendMessage,
      mentionsIn: (text) => (text.includes("@") ? parseMentions(sql, text, 0) : Effect.succeed([])).pipe(Effect.orDie),
      checkpointMessage: (message) =>
        sql`UPDATE messages SET content = ${message.content}
          WHERE id = ${message.id} AND status IN ('streaming', 'stopping')`.pipe(Effect.asVoid, Effect.orDie),
      listUnfinishedMessages: unfinishedMessages().pipe(Effect.orDie),
      nextQueuedMessage: (channelId) => nextQueuedMessage(channelId).pipe(Effect.orDie),
      channelsWithQueuedMessages: channelsWithQueuedMessages().pipe(
        Effect.map((rows) => rows.map((row) => row.channelId)),
        Effect.orDie,
      ),
      startQueuedMessage,
      ...floor,
      removeQueuedMessage,
      findCheckpoint: (channelId) => findCheckpoint(channelId).pipe(Effect.orDie),
      ...camps.writes,
      moveChapter: moves.moveChapter,
      // Not journaled: the summary is the hub's own record, never shown to clients.
      saveCheckpoint: (checkpoint) =>
        sql`INSERT INTO channel_checkpoints ${sql.insert({
          channel_id: checkpoint.channelId,
          through_message_id: checkpoint.throughMessageId,
          lines: JSON.stringify(checkpoint.lines),
          omitted: checkpoint.omitted,
          created_at: checkpoint.createdAt,
        })} ON CONFLICT (channel_id) DO UPDATE SET
          through_message_id = excluded.through_message_id,
          lines = excluded.lines,
          omitted = excluded.omitted,
          created_at = excluded.created_at`.pipe(Effect.asVoid, Effect.orDie),
    });
  }),
);
