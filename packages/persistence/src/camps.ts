import { ThreadKeyReused } from "@hobbots/api";
import {
  ApprovalRequest,
  type BackpackItem,
  CarriedOver,
  CarriedOverRef,
  carriedOverFrom,
  carriedOverRefId,
  type JournaledEvent,
  StartedFresh,
  Thread,
  type ThreadId,
} from "@hobbots/domain";
import { carryingThread } from "@hobbots/inbox";
import { Data, Effect, Option, Schema } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { approvalRow } from "./approvals.ts";
import { makeItemReads } from "./backpack-rows.ts";
import { startFirstChapterIn } from "./chapters.ts";
import { makeJournaledChange } from "./journal.ts";
import { oldestFirst } from "./order.ts";
import { decodeRows, type Row } from "./task-rows.ts";
import { copyMembersIn, startMembersIn } from "./thread-member-rows.ts";

// Make a camp and Start fresh (ADR 037, #1376): each one transaction that writes the threads, moves
// what Start fresh carries, and journals the change, so a crash between the writes leaves neither half.

/** The columns a thread is stored with, at `revision`; what a read works out is never stored. */
export const threadColumns = (thread: Thread) => ({
  id: thread.id,
  agent_id: thread.agentId,
  title: thread.title,
  sessions: JSON.stringify(thread.sessions),
  brain: thread.brain === null ? null : JSON.stringify(thread.brain),
  kind: thread.kind,
  goal: thread.goal,
  private: thread.private ? 1 : 0,
  origin_thread_id: thread.origin?.threadId ?? null,
  origin_chapter_id: thread.origin?.chapterId ?? null,
  state: thread.state,
  archived_at: thread.archivedAt,
  pinned_at: thread.pinnedAt,
  skill_trial: thread.skillTrial === null ? null : JSON.stringify(thread.skillTrial),
  created_at: thread.createdAt,
  updated_at: thread.updatedAt,
  revision: thread.revision,
});

/** What Make a camp was asked under a key, as it was asked: a later rename does not change it. */
const campRequestColumns = (camp: Thread) => ({
  key: camp.id,
  agent_id: camp.agentId,
  title: camp.title,
  goal: camp.goal,
  private: camp.private ? 1 : 0,
});

/** Whether the request stored under a key is the one asked again: same hob, title, goal and privacy. */
const sameRequest = (stored: Row, asked: Thread) =>
  stored.agentId === asked.agentId &&
  stored.title === asked.title &&
  (stored.goal ?? null) === asked.goal &&
  Boolean(Number(stored.private)) === asked.private;

// The chat changed between the read and the write: the change rolls back, and the caller reads again.
class StaleChat extends Data.TaggedError("StaleChat") {}

/**
 * The records a Task's turn makes outside any message, which name the Task and its thread: web use
 * and hob proposals. They follow their Task's tree to another thread (#1389); those made in a reply
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
        fromThreadId: row.fromThreadId as ThreadId,
        toThreadId: row.toThreadId as ThreadId,
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
  /** The thread as a read shows it, with its last line and unread mark, or undefined. */
  readThread: (id: ThreadId) => Effect.Effect<Thread | undefined, SqlError.SqlError>,
) => {
  const change = makeJournaledChange(sql);
  const items = makeItemReads(sql);
  const oldest = oldestFirst(sql);
  const startFirstChapter = startFirstChapterIn(sql);
  const startMembers = startMembersIn(sql);
  const copyMembers = copyMembersIn(sql);
  // A new thread's first chapter, journaled as `ChapterStarted` at `revision`, after the change's other events.
  const firstChapterOf = (thread: Thread, revision: number) =>
    startFirstChapter(thread, revision).pipe(
      Effect.map(
        (chapter): ReadonlyArray<JournaledEvent> =>
          chapter === null ? [] : [{ _tag: "ChapterStarted", threadId: thread.id, chapter, ended: null }],
      ),
    );

  // A thread this change just wrote is there to read.
  const shown = (id: ThreadId) => readThread(id).pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie);

  /**
   * Makes `camp` at `first`, journaled as `CampMade`, its first chapter's `ChapterStarted` and its first
   * two members' `ThreadMemberAdded`; the
   * camp stored under its key already, with no events, when the same camp was asked for before.
   */
  const insertCamp = (camp: Thread, first: number) =>
    Effect.gen(function* () {
      const stored = yield* readThread(camp.id);
      if (stored !== undefined) {
        const [request] = yield* sql<Row>`SELECT * FROM camp_requests WHERE key = ${camp.id}`;
        if (request !== undefined && sameRequest(request, camp)) return { value: stored, events: [] };
        return yield* new ThreadKeyReused({ threadId: camp.id });
      }
      yield* sql`INSERT INTO threads ${sql.insert(threadColumns(new Thread({ ...camp, revision: first })))}`;
      yield* sql`INSERT INTO camp_requests ${sql.insert(campRequestColumns(camp))}`;
      const started = yield* firstChapterOf(camp, first + 1);
      // Its person and its hob are its first members (ADR 039).
      const members = yield* startMembers(camp, first + 1 + started.length);
      const thread = yield* shown(camp.id);
      const events: ReadonlyArray<JournaledEvent> = [{ _tag: "CampMade", thread }, ...started, ...members];
      return { value: thread, events };
    });

  const makeCamp = (camp: Thread) => change<Thread, ThreadKeyReused>((first) => insertCamp(camp, first));

  // The open work in a chat, as it stands before it moves: the Tasks you asked for there that are not
  // over, with their trees, the questions in them still open, and the backpack items held for the
  // chat that are not resolved. Of those, what the chat's turns carry is carried over; an item a
  // step's own session carries moves with its tree, and is not named.
  const openWork = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const tasks = yield* sql<Row>`SELECT * FROM tasks WHERE thread_id = ${threadId} AND parent_id IS NULL
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
      const held = yield* sql<Row>`SELECT * FROM backpack_items WHERE thread_id = ${threadId} AND state <> 'resolved'
        ORDER BY ${oldest}`.pipe(Effect.flatMap(items.toItems));
      const carried = held.filter((item) => carryingThread(item, trees) === threadId);
      return { work: { tasks, trees, questions, items: carried }, held };
    });

  // Moves open work to another thread, for Start fresh and a chapter's move: whole trees, with their
  // Quests and the records their Tasks' turns made outside any message. From `first` on, each of
  // their approval requests is journaled as its own `ApprovalMoved` at its new revision, so a client
  // takes it out of the thread it left, and then each item as its own `BackpackItemChanged`.
  const moveWork = (
    from: ThreadId,
    to: ThreadId,
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
          yield* sql`UPDATE backpack_items SET thread_id = ${to}, updated_at = ${at}, revision = ${next + index}
            WHERE id = ${item.id}`;
          const moved = yield* items.item(item.id);
          return { _tag: "BackpackItemChanged", item: moved as BackpackItem } as const;
        }),
      );
      return [...approvals, ...moved];
    });

  // The trees' Tasks and Quests, and what their turns made outside any message, with an
  // `ApprovalMoved` for each approval request from `first` on.
  const moveTrees = (from: ThreadId, to: ThreadId, roots: ReadonlyArray<string>, first: number) =>
    Effect.gen(function* () {
      const inTrees = sql`task_id IN (SELECT id FROM tasks WHERE ${sql.in("root_id", roots)})`;
      for (const table of BY_TASK) {
        yield* sql`UPDATE ${sql(table)} SET thread_id = ${to} WHERE thread_id = ${from} AND message_id IS NULL
          AND ${inTrees}`;
      }
      const asked = yield* sql<{ readonly id: string }>`SELECT id FROM approval_requests WHERE thread_id = ${from}
        AND message_id IS NULL AND ${inTrees} ORDER BY ${oldest}`;
      const approvals = yield* Effect.forEach(asked, (row, index) =>
        Effect.gen(function* () {
          yield* sql`UPDATE approval_requests SET thread_id = ${to}, revision = ${first + index} WHERE id = ${row.id}`;
          const [moved] = yield* sql<Row>`SELECT * FROM approval_requests WHERE id = ${row.id}`;
          const approval = yield* decodeApproval(approvalRow(moved as Row));
          return { _tag: "ApprovalMoved", fromThreadId: from, approval } as const;
        }),
      );
      yield* sql`UPDATE quests SET thread_id = ${to} WHERE thread_id = ${from} AND ${inTrees}`;
      yield* sql`UPDATE tasks SET thread_id = ${to} WHERE thread_id = ${from} AND ${sql.in("root_id", roots)}`;
      return approvals;
    });

  const startFresh = (input: { readonly superseded: Thread; readonly chat: Thread }) => {
    const from = input.superseded;
    const at = from.updatedAt;
    return change<StartedFresh, StaleChat>((first) =>
      Effect.gen(function* () {
        const written = yield* sql`UPDATE threads SET state = ${from.state}, archived_at = ${from.archivedAt},
            updated_at = ${from.updatedAt}, revision = ${first}
          WHERE id = ${from.id} AND revision = ${from.revision} AND state = 'open' RETURNING id`;
        if (written.length === 0) return yield* new StaleChat();
        yield* sql`INSERT INTO threads ${sql.insert(threadColumns(new Thread({ ...input.chat, revision: first })))}`;
        const { work, held } = yield* openWork(from.id);
        const carried = carriedOverFrom(work).map(
          (each) => new CarriedOver({ fromThreadId: from.id, toThreadId: input.chat.id, ...each, carriedAt: at }),
        );
        yield* Effect.forEach(
          carried,
          (item, position) =>
            sql`INSERT INTO carried_over ${sql.insert({
              from_thread_id: item.fromThreadId,
              to_thread_id: item.toThreadId,
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
            WHERE c.thread_id = ${input.chat.id} AND c.state = 'live') WHERE ${sql.in("id", roots)}`;
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

  const listCarriedOver = (threadId: ThreadId) =>
    sql<Row>`SELECT * FROM carried_over WHERE to_thread_id = ${threadId} ORDER BY position`.pipe(
      Effect.map(carriedRows),
      Effect.orDie,
    );

  // The thread's open work as the context pack carries it (#1380), read outside any change.
  const listOpenWork = (threadId: ThreadId) =>
    openWork(threadId).pipe(
      Effect.map(({ work }) => work),
      Effect.orDie,
    );

  // What Start fresh would carry from the chat now, read with the same rule it records with.
  const carryOver = (threadId: ThreadId) =>
    openWork(threadId).pipe(
      Effect.map(({ work }) => carriedOverFrom(work)),
      Effect.orDie,
    );

  const writes = { makeCamp, startFresh, listCarriedOver, listOpenWork, carryOver } as const;
  return { writes, insertCamp, moveWork } as const;
};
