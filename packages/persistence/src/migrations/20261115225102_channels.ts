import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// A chat or camp is a channel. The code named it a thread, which the product now uses for a
// conversation that hangs off one message, so the code says channel: `Thread` became `Channel`, the
// kind `chat` became `direct`, and a channel's `agentId` became `ownerHobId`. This migration brings
// the stored names along, once, with no alias left behind:
//
// - Tables: threads, thread_members, thread_checkpoints and memory_capture_private_threads.
// - Every column named for a thread, such as `thread_id`, `origin_thread_id` and `from_thread_id`,
//   and every index, constraint and trigger named for one. A channel's owner stays in `agent_id`.
// - A hob's one chat is stored with the kind `direct`, and its one-open index follows it.
// - SQLite's title search is made again over `channels`, since its content table is named in it.
// - The journal and the JSON columns that hold domain records: every key named for a thread, every
//   `_tag` such as `ThreadUpserted`, and in each channel a journal entry carries, `agentId` as
//   `ownerHobId` and the kind `chat` as `direct`, so every stored entry decodes.
//
// Kept as they are: the `thread:<id>` work keys (found URLs, search holds, deliveries, scopes),
// which also tag memory sessions, so the memory system and its stored tags do not change.
// Fixed here rather than taken from the domain, so this migration never changes after it runs.

const PAGE = 500;

/** A name with each word `thread` as `channel`, keeping its case: `thread_id`, `ThreadUpserted`. */
export const channelWord = (name: string): string => {
  const word = (_: string, before: string, found: string, plural: string) =>
    before + ({ thread: "channel", Thread: "Channel", THREAD: "CHANNEL" } as Record<string, string>)[found] + plural;
  let renamed = name;
  for (let pass = 0; pass < 2; pass++) {
    renamed = renamed
      .replace(/(^|[^A-Za-z])(thread)(s?)(?![a-z])/g, word)
      .replace(/(^|[^A-Z])(Thread)(s?)(?![a-z])/g, word)
      .replace(/(^|[^A-Z])(THREAD)(S?)(?![A-Z])/g, word);
  }
  return renamed;
};

// The keys whose value is a whole channel in a journal entry: `ThreadUpserted` and `CampMade`
// carry `thread`, a chapter moved into a camp `thread` and `camp`, and Start fresh `superseded` and
// `chat`. Each is named after the rename here.
const CHANNEL_KEYS = new Set(["channel", "camp", "superseded", "chat"]);

type Json = null | boolean | number | string | ReadonlyArray<Json> | { readonly [key: string]: Json };

const isRecord = (value: Json): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A stored channel: a record with its own title, owner and times, not a member or a hub question's chat. */
const isChannel = (value: Json): value is { readonly [key: string]: Json } =>
  isRecord(value) && "agentId" in value && "title" in value && "createdAt" in value && "updatedAt" in value;

/** `value` with every key and `_tag` renamed, and each channel it holds under `CHANNEL_KEYS` in its new shape. */
export const renamedJson = (value: Json): Json => {
  if (Array.isArray(value)) return value.map(renamedJson);
  if (!isRecord(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, inner] of Object.entries(value)) {
    const name = channelWord(key);
    if (name === "_tag" && typeof inner === "string") out[name] = channelWord(inner);
    else if (CHANNEL_KEYS.has(name) && isChannel(inner)) out[name] = renamedJson(asChannel(inner));
    else out[name] = renamedJson(inner);
  }
  return out;
};

const asChannel = ({ agentId, kind, ...channel }: { readonly [key: string]: Json }): Json => ({
  ...channel,
  ownerHobId: agentId ?? null,
  ...(kind === undefined ? {} : { kind: kind === "chat" ? "direct" : kind }),
});

/** The JSON text columns that hold domain records, by the table's key. */
const JSON_COLUMNS: ReadonlyArray<{
  readonly table: string;
  readonly key: string;
  readonly columns: ReadonlyArray<string>;
}> = [
  { table: "event_journal", key: "sequence", columns: ["payload"] },
  { table: "backpack_items", key: "id", columns: ["payload", "disposition"] },
  { table: "hub_questions", key: "id", columns: ["ask", "options"] },
  { table: "hob_proposals", key: "id", columns: ["rows", "asks"] },
  { table: "camp_suggestions", key: "id", columns: ["reasons"] },
  { table: "quests", key: "id", columns: ["stop"] },
  { table: "setting_changes", key: "id", columns: ["before_value", "after_value"] },
];

/** The stored text `text`, renamed when it is JSON that changes; null when it is not JSON or nothing changes. */
const renamedText = (text: unknown): string | null => {
  if (typeof text !== "string" || !/^\s*[[{]/.test(text)) return null;
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    return null;
  }
  const renamed = JSON.stringify(renamedJson(parsed));
  return renamed === JSON.stringify(parsed) ? null : renamed;
};

const TABLES = ["threads", "thread_members", "thread_checkpoints", "memory_capture_private_threads"];

/**
 * Each event type whose payload names a channel, with its version before and after this migration:
 * a rewritten event takes the next version, so a later migration does not skip it. Fixed here, so
 * this migration never changes after it runs.
 */
const VERSIONS: Record<string, readonly [number, number]> = {
  ChannelUpserted: [7, 8],
  CampMade: [4, 5],
  ChatStartedFresh: [4, 5],
  MessageUpserted: [6, 7],
  MessageQueued: [3, 4],
  MessageDequeued: [1, 2],
  ChapterStarted: [1, 2],
  ChapterSplit: [1, 2],
  ChapterMerged: [1, 2],
  ChapterSummarized: [1, 2],
  ChapterMoved: [2, 3],
  CampSuggested: [1, 2],
  CampSuggestionOffered: [1, 2],
  CampSuggestionKept: [1, 2],
  CampSuggestionAccepted: [1, 2],
  CampSuggestionExpired: [1, 2],
  TurnStopRequested: [1, 2],
  TurnStopped: [1, 2],
  RelayBudgetReset: [1, 2],
  TurnPassed: [1, 2],
  ApprovalRequested: [1, 2],
  ApprovalResolved: [1, 2],
  ApprovalMoved: [1, 2],
  TaskCreated: [1, 2],
  TaskStateChanged: [1, 2],
  QuestStarted: [1, 2],
  HubQuestionRaised: [2, 3],
  HubQuestionAnswered: [2, 3],
  HubQuestionWithdrawn: [2, 3],
  TaskCompleted: [1, 2],
  QuestCompleted: [1, 2],
  QuestStopRequested: [1, 2],
  QuestSummaryChanged: [1, 2],
  DecisionRecorded: [1, 2],
  DecisionSuperseded: [1, 2],
  ArtifactRegistered: [1, 2],
  ArtifactReviewSettled: [1, 2],
  BriefWritten: [1, 2],
  MessagePinned: [1, 2],
  MessageUnpinned: [1, 2],
  BackpackItemRecorded: [1, 2],
  BackpackItemChanged: [1, 2],
  ChannelMemberAdded: [1, 2],
  ChannelMemberChanged: [1, 2],
  MemorySaveRecorded: [1, 2],
  MemorySaveChanged: [1, 2],
  MemoryShareRequested: [1, 2],
  MemoryShareChanged: [1, 2],
  SkillProposalRequested: [1, 2],
  SkillProposalChanged: [1, 2],
  HobProposalRequested: [1, 2],
  HobProposalChanged: [1, 2],
  SkillFeedbackLeft: [1, 2],
  SkillUsed: [1, 2],
  WebSearched: [1, 2],
  WebFetched: [1, 2],
};

/** Each journal entry's type by its new name. */
const renameJournalTypes = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const types = yield* sql<{ type: string }>`SELECT DISTINCT type FROM event_journal WHERE type LIKE '%Thread%'`;
    for (const { type } of types) {
      yield* sql`UPDATE event_journal SET type = ${channelWord(type)} WHERE type = ${type}`;
    }
  });

/** Each rewritten entry at its type's next version. */
const nextVersions = (sql: SqlClient.SqlClient) =>
  Effect.forEach(
    Object.entries(VERSIONS),
    ([type, [before, after]]) =>
      sql`UPDATE event_journal SET schema_version = ${after} WHERE type = ${type} AND schema_version = ${before}`,
    { discard: true },
  );

export default Effect.gen(function* () {
  const sql = (yield* SqlClient.SqlClient).withoutTransforms();
  // Every table and column there is before the rename. A hub has them all; a test of an older
  // migration may keep only some, so each step takes only what is there.
  const stored = yield* sql.onDialectOrElse({
    pg: () => sql<{ table_name: string; column_name: string }>`SELECT table_name, column_name
      FROM information_schema.columns WHERE table_schema = current_schema()`,
    orElse: () => sql<{ table_name: string; column_name: string }>`SELECT m.name AS table_name, c.name AS column_name
      FROM sqlite_master m JOIN pragma_table_info(m.name) c WHERE m.type = 'table'`,
  });
  const has = (table: string, column?: string) =>
    stored.some((row) => row.table_name === table && (column === undefined || row.column_name === column));
  const tables = TABLES.filter((table) => has(table));

  yield* sql.onDialectOrElse({
    pg: () =>
      Effect.gen(function* () {
        for (const table of tables) yield* sql.unsafe(`ALTER TABLE ${table} RENAME TO ${channelWord(table)}`);
        const columns = yield* sql<{ table_name: string; column_name: string }>`SELECT table_name, column_name
          FROM information_schema.columns WHERE table_schema = current_schema() AND column_name LIKE '%thread%'`;
        for (const { table_name, column_name } of columns) {
          yield* sql.unsafe(`ALTER TABLE ${table_name} RENAME COLUMN ${column_name} TO ${channelWord(column_name)}`);
        }
        // A constraint backed by an index renames the index with it; the rest are renamed after.
        const constraints = yield* sql<{ table_name: string; conname: string }>`SELECT conrelid::regclass::text
            AS table_name, conname FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = current_schema() AND conname LIKE '%thread%'`;
        for (const { table_name, conname } of constraints) {
          yield* sql.unsafe(`ALTER TABLE ${table_name} RENAME CONSTRAINT ${conname} TO ${channelWord(conname)}`);
        }
        yield* sql`DROP INDEX IF EXISTS threads_one_open_chat`;
        const indexes = yield* sql<{ indexname: string }>`SELECT indexname FROM pg_indexes
          WHERE schemaname = current_schema() AND indexname LIKE '%thread%'`;
        for (const { indexname } of indexes) {
          yield* sql.unsafe(`ALTER INDEX ${indexname} RENAME TO ${channelWord(indexname)}`);
        }
      }),
    orElse: () =>
      Effect.gen(function* () {
        // The title index names its content table, so it is dropped and made again over `channels`.
        const searched = has("threads_search");
        for (const trigger of ["threads_search_insert", "threads_search_update", "threads_search_delete"]) {
          yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${trigger}`);
        }
        yield* sql`DROP TABLE IF EXISTS threads_search`;
        yield* sql`DROP INDEX IF EXISTS threads_one_open_chat`;
        for (const table of tables) yield* sql.unsafe(`ALTER TABLE ${table} RENAME TO ${channelWord(table)}`);
        const plain = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
          WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite_%'`;
        for (const { name } of plain) {
          const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${name})`);
          for (const column of columns) {
            if (!column.name.includes("thread")) continue;
            yield* sql.unsafe(`ALTER TABLE ${name} RENAME COLUMN ${column.name} TO ${channelWord(column.name)}`);
          }
        }
        // SQLite cannot rename an index or a trigger: each is made again under its new name, from
        // its own definition, which the renames above already point at the new tables and columns.
        const named = yield* sql<{ type: string; name: string; sql: string }>`SELECT type, name, sql
          FROM sqlite_master WHERE type IN ('index', 'trigger') AND name LIKE '%thread%' AND sql IS NOT NULL`;
        for (const each of named) {
          yield* sql.unsafe(`DROP ${each.type.toUpperCase()} ${each.name}`);
          yield* sql.unsafe(channelWord(each.sql));
        }
        if (!searched) return;
        yield* sql`CREATE VIRTUAL TABLE channels_search USING fts5(
          title, content = 'channels', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2'
        )`;
        yield* sql`INSERT INTO channels_search (channels_search) VALUES ('rebuild')`;
        yield* sql`CREATE TRIGGER channels_search_insert AFTER INSERT ON channels BEGIN
          INSERT INTO channels_search (rowid, title) VALUES (new.rowid, new.title);
        END`;
        yield* sql`CREATE TRIGGER channels_search_update AFTER UPDATE OF title ON channels BEGIN
          INSERT INTO channels_search (channels_search, rowid, title) VALUES ('delete', old.rowid, old.title);
          INSERT INTO channels_search (rowid, title) VALUES (new.rowid, new.title);
        END`;
        yield* sql`CREATE TRIGGER channels_search_delete AFTER DELETE ON channels BEGIN
          INSERT INTO channels_search (channels_search, rowid, title) VALUES ('delete', old.rowid, old.title);
        END`;
      }),
  });

  // A hob's one open chat, now of the kind `direct`.
  if (has("threads", "kind")) {
    yield* sql`UPDATE channels SET kind = 'direct' WHERE kind = 'chat'`;
    if (has("threads", "state")) {
      yield* sql`CREATE UNIQUE INDEX channels_one_open_direct ON channels (agent_id)
        WHERE kind = 'direct' AND state = 'open'`;
    }
  }

  yield* renameJournalTypes(sql);

  for (const { table, key, columns: all } of JSON_COLUMNS) {
    const columns = all.filter((column) => has(table, column));
    if (columns.length === 0) continue;
    const read = sql`SELECT ${sql(key)} AS row_key, ${sql.literal(columns.join(", "))} FROM ${sql(table)}`;
    let after: unknown = null;
    for (;;) {
      const rows: ReadonlyArray<Record<string, unknown>> = yield* after === null
        ? sql`${read} ORDER BY ${sql(key)} LIMIT ${PAGE}`
        : sql`${read} WHERE ${sql(key)} > ${after} ORDER BY ${sql(key)} LIMIT ${PAGE}`;
      for (const row of rows) {
        for (const column of columns) {
          const renamed = renamedText(row[column]);
          if (renamed !== null)
            yield* sql`UPDATE ${sql(table)} SET ${sql(column)} = ${renamed} WHERE ${sql(key)} = ${row.row_key}`;
        }
      }
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1]?.row_key ?? null;
    }
  }

  if (has("event_journal")) yield* nextVersions(sql);
});
