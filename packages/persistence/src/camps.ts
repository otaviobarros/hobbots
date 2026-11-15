import { type HobUnavailable, ChannelKeyReused } from "@hobbots/api";
import {
  type AgentId,
  ApprovalRequest,
  type BackpackItem,
  CarriedOver,
  CarriedOverRef,
  carriedOverFrom,
  carriedOverRefId,
  type JournaledEvent,
  StartedFresh,
  Channel,
  type ChannelId,
} from "@hobbots/domain";
import { carryingChannel } from "@hobbots/inbox";
import { Data, Effect, Option, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { approvalRow } from "./approvals.ts";
import { makeItemReads } from "./backpack-rows.ts";
import { startFirstChapterIn } from "./chapters.ts";
import { makeJournaledChange } from "./journal.ts";
import { oldestFirst } from "./order.ts";
import { decodeRows, type Row } from "./task-rows.ts";
import { addHobsIn, copyMembersIn, startMembersIn } from "./channel-member-rows.ts";

// Make a camp and Start fresh (ADR 037, #1376): each one transaction that writes the channels, moves
// what Start fresh carries, and journals the change, so a crash between the writes leaves neither half.

/** The columns a channel is stored with, at `revision`; what a read works out is never stored. */
export const channelColumns = (channel: Channel) => ({
  id: channel.id,
  agent_id: channel.ownerHobId,
  title: channel.title,
  sessions: JSON.stringify(channel.sessions),
  brain: channel.brain === null ? null : JSON.stringify(channel.brain),
  kind: channel.kind,
  goal: channel.goal,
  private: channel.private ? 1 : 0,
  origin_channel_id: channel.origin?.channelId ?? null,
  origin_chapter_id: channel.origin?.chapterId ?? null,
  state: channel.state,
  archived_at: channel.archivedAt,
  pinned_at: channel.pinnedAt,
  skill_trial: channel.skillTrial === null ? null : JSON.stringify(channel.skillTrial),
  created_at: channel.createdAt,
  updated_at: channel.updatedAt,
  revision: channel.revision,
});

/** The hobs a camp is made with besides its lead, each once and sorted, as its request keeps them. */
const otherHobs = (camp: Channel, hobs: ReadonlyArray<AgentId>) =>
  JSON.stringify([...new Set(hobs)].filter((hobId) => hobId !== camp.ownerHobId).sort());

/** What Make a camp was asked under a key, as it was asked: a later rename does not change it. */
const campRequestColumns = (camp: Channel, hobs: ReadonlyArray<AgentId>) => ({
  key: camp.id,
  agent_id: camp.ownerHobId,
  title: camp.title,
  goal: camp.goal,
  private: camp.private ? 1 : 0,
  hobs: otherHobs(camp, hobs),
});

/**
 * Whether the request stored under a key is the one asked again: same hob, title, goal, privacy and
 * other hobs. A request stored before camps kept their hobs was made with none.
 */
const sameRequest = (stored: Row, asked: Channel, hobs: ReadonlyArray<AgentId>) =>
  stored.agentId === asked.ownerHobId &&
  stored.title === asked.title &&
  (stored.goal ?? null) === asked.goal &&
  Boolean(Number(stored.private)) === asked.private &&
  (stored.hobs ?? "[]") === otherHobs(asked, hobs);

// The chat changed between the read and the write: the change rolls back, and the caller reads again.
class StaleChat extends Data.TaggedError("StaleChat") {}

/**
 * The records a Task's turn makes outside any message, which name the Task and its channel: web use
 * and hob proposals. They follow their Task's tree to another channel (#1389); those made in a reply
 * follow the reply's message instead. A member's approval requests follow it too, each journaled.
 */
const BY_TASK = ["web_searches", "web_fetches", "hob_proposals"] as const;

const decodeRef = Schema.decodeUnknownSync(CarriedOverRef);

// A request the hub wrote: one that does not decode is a defect.
const decodeApproval = (row: unknown) => Schema.decodeUnknownEffect(ApprovalRequest)(row).pipe(Effect.orDie);

const carriedRows = (rows: ReadonlyArray<Row>) =>
  rows.map(
    (row) =>
      new CarriedOver({
        fromChannelId: row.fromChannelId as ChannelId,
        toChannelId: row.toChannelId as ChannelId,
        ref: decodeRef(
          row.refKind === "task"
            ? { _tag: "task", taskId: row.refId }
            : row.refKind === "question"
              ? { _tag: "question", questionId: row.refId }
              : { _tag: row.refKind, itemId: row.refId },
        ),
        label: String(row.label),
        carriedAt: String(row.carriedAt),
      }),
  );

export const makeCampWrites = (
  sql: SqlClient.SqlClient,
  /** The channel as a read shows it, with its last line and unread mark, or undefined. */
  readChannel: (id: ChannelId) => Effect.Effect<Channel | undefined, SqlError.SqlError>,
) => {
  const change = makeJournaledChange(sql);
  const items = makeItemReads(sql);
  const oldest = oldestFirst(sql);
  const startFirstChapter = startFirstChapterIn(sql);
  const startMembers = startMembersIn(sql);
  const copyMembers = copyMembersIn(sql);
  const addHobs = addHobsIn(sql);
  // A new channel's first chapter, journaled as `ChapterStarted` at `revision`, after the change's other events.
  const firstChapterOf = (channel: Channel, revision: number) =>
    startFirstChapter(channel, revision).pipe(
      Effect.map(
        (chapter): ReadonlyArray<JournaledEvent> =>
          chapter === null ? [] : [{ _tag: "ChapterStarted", channelId: channel.id, chapter, ended: null }],
      ),
    );

  // A channel this change just wrote is there to read.
  const shown = (id: ChannelId) => readChannel(id).pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie);

  /**
   * Makes `camp` at `first`, journaled as `CampMade`, its first chapter's `ChapterStarted`, its first
   * two members' `ChannelMemberAdded` and one for each of the other `hobs` it is made with; the camp
   * stored under its key already, with no events, when the same camp was asked for before.
   */
  const insertCamp = (camp: Channel, first: number, hobs: ReadonlyArray<AgentId> = []) =>
    Effect.gen(function* () {
      const stored = yield* readChannel(camp.id);
      if (stored !== undefined) {
        const [request] = yield* sql<Row>`SELECT * FROM camp_requests WHERE key = ${camp.id}`;
        if (request !== undefined && sameRequest(request, camp, hobs)) return { value: stored, events: [] };
        return yield* new ChannelKeyReused({ channelId: camp.id });
      }
      yield* sql`INSERT INTO channels ${sql.insert(channelColumns(new Channel({ ...camp, revision: first })))}`;
      yield* sql`INSERT INTO camp_requests ${sql.insert(campRequestColumns(camp, hobs))}`;
      const started = yield* firstChapterOf(camp, first + 1);
      // Its person and its hob are its first members (ADR 039).
      const members = yield* startMembers(camp, first + 1 + started.length);
      // The hob it is made for leads it; each other hob joins once.
      const others = [...new Set(hobs)].filter((hobId) => hobId !== camp.ownerHobId);
      const joined = yield* addHobs(camp, others, first + 1 + started.length + members.length);
      const channel = yield* shown(camp.id);
      const events: ReadonlyArray<JournaledEvent> = [{ _tag: "CampMade", channel }, ...started, ...members, ...joined];
      return { value: channel, events };
    });

  const makeCamp = (camp: Channel, hobs: ReadonlyArray<AgentId> = []) =>
    change<Channel, ChannelKeyReused | HobUnavailable>((first) => insertCamp(camp, first, hobs));

  // The open work in a chat, as it stands before it moves: the Tasks you asked for there that are not
  // over, with their trees, the questions in them still open, and the backpack items held for the
  // chat that are not resolved. Of those, what the chat's turns carry is carried over; an item a
  // step's own session carries moves with its tree, and is not named.
  const openWork = (channelId: ChannelId) =>
    Effect.gen(function* () {
      const tasks = yield* sql<Row>`SELECT * FROM tasks WHERE channel_id = ${channelId} AND parent_id IS NULL
        AND state NOT IN ('completed', 'failed', 'cancelled') ORDER BY ${oldest}`.pipe(
        Effect.flatMap(decodeRows("task")),
      );
      const roots = tasks.map((task) => task.id);
      const trees =
        roots.length === 0
          ? []
          : yield* sql<Row>`SELECT * FROM tasks WHERE ${sql.in("root_id", roots)} ORDER BY ${oldest}`.pipe(
              Effect.flatMap(decodeRows("task")),
            );
      const questions =
        roots.length === 0
          ? []
          : yield* sql<Row>`SELECT * FROM questions WHERE state = 'open'
              AND task_id IN (SELECT id FROM tasks WHERE ${sql.in("root_id", roots)}) ORDER BY ${oldest}`.pipe(
              Effect.flatMap(decodeRows("question")),
            );
      const held = yield* sql<Row>`SELECT * FROM backpack_items WHERE channel_id = ${channelId} AND state <> 'resolved'
        ORDER BY ${oldest}`.pipe(Effect.flatMap(items.toItems));
      const carried = held.filter((item) => carryingChannel(item, trees) === channelId);
      return { work: { tasks, trees, questions, items: carried }, held };
    });

  // Moves open work to another channel, for Start fresh and a chapter's move: whole trees, with their
  // Quests and the records their Tasks' turns made outside any message. From `first` on, each of
  // their approval requests is journaled as its own `ApprovalMoved` at its new revision, so a client
  // takes it out of the channel it left, and then each item as its own `BackpackItemChanged`.
  const moveWork = (
    from: ChannelId,
    to: ChannelId,
    roots: ReadonlyArray<string>,
    held: ReadonlyArray<BackpackItem>,
    at: string,
    first: number,
  ) =>
    Effect.gen(function* () {
      const approvals = roots.length === 0 ? [] : yield* moveTrees(from, to, roots, first);
      const next = first + approvals.length;
      const moved = yield* Effect.forEach(held, (item, index) =>
        Effect.gen(function* () {
          yield* sql`UPDATE backpack_items SET channel_id = ${to}, updated_at = ${at}, revision = ${next + index}
            WHERE id = ${item.id}`;
          const moved = yield* items.item(item.id);
          return { _tag: "BackpackItemChanged", item: moved as BackpackItem } as const;
        }),
      );
      return [...approvals, ...moved];
    });

  // The trees' Tasks and Quests, and what their turns made outside any message, with an
  // `ApprovalMoved` for each approval request from `first` on.
  const moveTrees = (from: ChannelId, to: ChannelId, roots: ReadonlyArray<string>, first: number) =>
    Effect.gen(function* () {
      const inTrees = sql`task_id IN (SELECT id FROM tasks WHERE ${sql.in("root_id", roots)})`;
      for (const table of BY_TASK) {
        yield* sql`UPDATE ${sql(table)} SET channel_id = ${to} WHERE channel_id = ${from} AND message_id IS NULL
          AND ${inTrees}`;
      }
      const asked = yield* sql<{ readonly id: string }>`SELECT id FROM approval_requests WHERE channel_id = ${from}
        AND message_id IS NULL AND ${inTrees} ORDER BY ${oldest}`;
      const approvals = yield* Effect.forEach(asked, (row, index) =>
        Effect.gen(function* () {
          yield* sql`UPDATE approval_requests SET channel_id = ${to}, revision = ${first + index} WHERE id = ${row.id}`;
          const [moved] = yield* sql<Row>`SELECT * FROM approval_requests WHERE id = ${row.id}`;
          const approval = yield* decodeApproval(approvalRow(moved as Row));
          return { _tag: "ApprovalMoved", fromChannelId: from, approval } as const;
        }),
      );
      yield* sql`UPDATE quests SET channel_id = ${to} WHERE channel_id = ${from} AND ${inTrees}`;
      yield* sql`UPDATE tasks SET channel_id = ${to} WHERE channel_id = ${from} AND ${sql.in("root_id", roots)}`;
      return approvals;
    });

  const startFresh = (input: { readonly superseded: Channel; readonly chat: Channel }) => {
    const from = input.superseded;
    const at = from.updatedAt;
    return change<StartedFresh, StaleChat>((first) =>
      Effect.gen(function* () {
        const written = yield* sql`UPDATE channels SET state = ${from.state}, archived_at = ${from.archivedAt},
            updated_at = ${from.updatedAt}, revision = ${first}
          WHERE id = ${from.id} AND revision = ${from.revision} AND state = 'open' RETURNING id`;
        if (written.length === 0) return yield* new StaleChat();
        yield* sql`INSERT INTO channels ${sql.insert(channelColumns(new Channel({ ...input.chat, revision: first })))}`;
        const { work, held } = yield* openWork(from.id);
        const carried = carriedOverFrom(work).map(
          (each) => new CarriedOver({ fromChannelId: from.id, toChannelId: input.chat.id, ...each, carriedAt: at }),
        );
        yield* Effect.forEach(
          carried,
          (item, position) =>
            sql`INSERT INTO carried_over ${sql.insert({
              from_channel_id: item.fromChannelId,
              to_channel_id: item.toChannelId,
              ref_kind: item.ref._tag,
              ref_id: carriedOverRefId(item.ref),
              label: item.label,
              position,
              carried_at: item.carriedAt,
            })}`,
          { discard: true },
        );
        const roots = work.tasks.map((task) => task.id);
        const moved = yield* moveWork(from.id, input.chat.id, roots, held, at, first + 1);
        const started = yield* firstChapterOf(input.chat, first + 1 + moved.length);
        // The new chat is the same direct message: its person and its hob, as they stand (ADR 039).
        const members = yield* copyMembers(from.id, input.chat, first + 1 + moved.length + started.length);
        // The moved Tasks now belong to the new chat's first chapter, and move with it (ADR 037).
        if (roots.length > 0) {
          yield* sql`UPDATE tasks SET chapter_id = (SELECT c.id FROM chapters c
            WHERE c.channel_id = ${input.chat.id} AND c.state = 'live') WHERE ${sql.in("id", roots)}`;
        }
        const value = new StartedFresh({
          superseded: yield* shown(from.id),
          chat: yield* shown(input.chat.id),
          carried,
        });
        const events: ReadonlyArray<JournaledEvent> = [
          { _tag: "ChatStartedFresh", ...value },
          ...moved,
          ...started,
          ...members,
        ];
        return { value, events };
      }),
    ).pipe(
      Effect.map(Option.some),
      Effect.catchTag("StaleChat", () => Effect.succeed(Option.none())),
    );
  };

  const listCarriedOver = (channelId: ChannelId) =>
    sql<Row>`SELECT * FROM carried_over WHERE to_channel_id = ${channelId} ORDER BY position`.pipe(
      Effect.map(carriedRows),
      Effect.orDie,
    );

  // The channel's open work as the context pack carries it (#1380), read outside any change.
  const listOpenWork = (channelId: ChannelId) =>
    openWork(channelId).pipe(
      Effect.map(({ work }) => work),
      Effect.orDie,
    );

  // What Start fresh would carry from the chat now, read with the same rule it records with.
  const carryOver = (channelId: ChannelId) =>
    openWork(channelId).pipe(
      Effect.map(({ work }) => carriedOverFrom(work)),
      Effect.orDie,
    );

  const writes = { makeCamp, startFresh, listCarriedOver, listOpenWork, carryOver } as const;
  return { writes, insertCamp, moveWork } as const;
};
