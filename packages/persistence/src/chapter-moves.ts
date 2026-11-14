import type { ChapterMoveTarget } from "@hobbots/agents";
import type { ThreadKeyReused } from "@hobbots/api";
import {
  Artifact,
  type BackpackItem,
  CampSuggestion,
  CampSuggestions,
  Chapter,
  ChapterId,
  ChapterMove,
  type ChapterMovePlan,
  type ChapterNotFound,
  ChapterRefused,
  ChapterStates,
  carriedReview,
  type IllegalChapterTransition,
  type JournaledEvent,
  type MessageId,
  planMove,
  type ReplyStep,
  type Thread,
  type ThreadId,
} from "@hobbots/domain";
import { Effect } from "effect";
import type { SqlClient, SqlError } from "effect/sql";
import { type ArtifactRow, artifactFromRow, renumberVersions, saveReview } from "./artifact-rows.ts";
import { makeItemReads } from "./backpack-rows.ts";
import { settleSuggestion, suggestionOfChapter } from "./camp-suggestion-rows.ts";
import type { makeCampWrites } from "./camps.ts";
import { chapterRows, writeChapters } from "./chapters.ts";
import { makeJournaledChange } from "./journal.ts";
import { oldestFirst } from "./order.ts";
import { keepReadersRead } from "./thread-member-rows.ts";

// Moving a chapter into a camp (ADR 037, #1385): one transaction that runs the pure `planMove` on
// the chapters as stored, re-parents the chapter's messages, decisions, artifacts and the quests
// started in it, with their open questions and backpack items, writes the stub the thread keeps, and
// journals `ChapterMoved`. Nothing is copied, so nothing is ever in two places, and a crash midway
// leaves nothing moved. A new camp is made in the same transaction.

/** The records that name a message and its thread, which follow the message to the camp. */
const BY_MESSAGE = [
  "approval_requests",
  "turn_requests",
  "charm_calls",
  "memory_saves",
  "memory_shares",
  "skill_uses",
  "skill_proposals",
  "skill_feedback",
  "hob_proposals",
  "web_searches",
  "web_fetches",
] as const;

type Refusal = ChapterRefused | ChapterNotFound | IllegalChapterTransition | ThreadKeyReused;

const isPlan = (planned: ChapterMovePlan | Exclude<Refusal, ThreadKeyReused>): planned is ChapterMovePlan =>
  "stub" in planned;

export const makeChapterMoves = (
  sql: SqlClient.SqlClient,
  /** The thread as a read shows it, or undefined. */
  readThread: (id: ThreadId) => Effect.Effect<Thread | undefined, SqlError.SqlError>,
  camps: Pick<ReturnType<typeof makeCampWrites>, "insertCamp" | "moveWork">,
) => {
  const change = makeJournaledChange(sql);
  const items = makeItemReads(sql);
  const oldest = oldestFirst(sql);

  const listChapters = (threadId: ThreadId) =>
    sql`SELECT * FROM chapters WHERE thread_id = ${threadId} ORDER BY number`.pipe(Effect.map(chapterRows));

  const holdsNone = (chapterId: ChapterId | undefined) =>
    chapterId === undefined
      ? Effect.succeed(true)
      : sql`SELECT 1 FROM messages WHERE chapter_id = ${chapterId} LIMIT 1`.pipe(
          Effect.map((rows) => rows.length === 0),
        );

  // A reply under way or queued, or an approval its reply waits on, holds a thread's chapters where
  // they are. A party member's approval waits in its own Task's session, not in the thread's reply,
  // so it moves with its quest instead (#1389).
  const busy = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const replies = yield* sql`SELECT 1 FROM messages WHERE thread_id = ${threadId}
        AND status IN ('queued', 'streaming', 'stopping') LIMIT 1`;
      const approvals = yield* sql`SELECT 1 FROM approval_requests WHERE thread_id = ${threadId}
        AND state = 'pending' AND message_id IS NOT NULL LIMIT 1`;
      return replies.length > 0 || approvals.length > 0;
    });

  // The thread as this transaction wrote it.
  const shown = (id: ThreadId) => readThread(id).pipe(Effect.flatMap(Effect.fromNullishOr), Effect.orDie);

  // The camp the chapter moves into: an open camp of the hob's, or one made now under its key.
  const campFor = (target: ChapterMoveTarget, first: number) =>
    target._tag === "camp"
      ? readThread(target.campId).pipe(Effect.map((camp) => ({ camp, events: [] as ReadonlyArray<JournaledEvent> })))
      : camps.insertCamp(target.camp, first).pipe(Effect.map(({ value, events }) => ({ camp: value, events })));

  // Moves the messages to the camp's chapter in their order, after the camp's own, at `revision`. A
  // thread you had read stays read, and a camp just made starts read.
  const moveMessages = (from: ThreadId, plan: ChapterMovePlan, revision: number) =>
    Effect.gen(function* () {
      const to = plan.landed.threadId;
      yield* keepReadersRead(sql, [from, to], revision);
      const moved = yield* sql<{ readonly id: MessageId; readonly steps: unknown }>`SELECT id, steps FROM messages
        WHERE chapter_id = ${plan.stub.id} ORDER BY seq`;
      const [last] = yield* sql<{
        readonly seq: unknown;
      }>`SELECT MAX(seq) AS seq FROM messages WHERE thread_id = ${to}`;
      const after = Number(last?.seq ?? 0);
      yield* Effect.forEach(
        moved,
        (message, index) =>
          sql`UPDATE messages SET thread_id = ${to}, chapter_id = ${plan.landed.id}, seq = ${after + index + 1},
            steps = ${keptLogsIn(message.steps, from)}, revision = ${revision} WHERE id = ${message.id}`,
        { discard: true },
      );
      const ids = moved.map((message) => message.id);
      if (ids.length > 0) {
        for (const table of BY_MESSAGE) {
          yield* sql`UPDATE ${sql(table)} SET thread_id = ${to} WHERE ${sql.in("message_id", ids)}`;
        }
      }
      return ids;
    });

  // An artifact moves with its chapter. One the camp has already, at the same place, takes the moved
  // one's sightings and keeps whichever version is newer, so it is still one row in the camp. A review
  // the moved one settled is carried over to one still waiting (`carriedReview`); the artifacts whose
  // review that changed are returned, to be written and journaled after the move's other events.
  const moveArtifacts = (plan: ChapterMovePlan, revision: number) =>
    Effect.gen(function* () {
      const carried: Array<Artifact> = [];
      const to = plan.landed.threadId;
      const clashes = yield* sql<{
        readonly id: string;
        readonly keptId: string;
        readonly newer: unknown;
      }>`SELECT a.id, k.id AS kept_id, (CASE WHEN a.updated_at > k.updated_at THEN 1 ELSE 0 END) AS newer
        FROM artifacts a JOIN artifacts k ON k.thread_id = ${to} AND k.locator = a.locator
        WHERE a.chapter_id = ${plan.stub.id}`;
      for (const clash of clashes) {
        yield* sql`INSERT INTO artifact_sightings (artifact_id, origin_kind, origin_id, attempt_id, version, seen_at)
          SELECT ${clash.keptId}, origin_kind, origin_id, attempt_id, version, seen_at FROM artifact_sightings s
          WHERE s.artifact_id = ${clash.id} AND NOT EXISTS (SELECT 1 FROM artifact_sightings e
            WHERE e.artifact_id = ${clash.keptId} AND e.origin_kind = s.origin_kind AND e.origin_id = s.origin_id)`;
        if (Number(clash.newer) === 1) {
          yield* sql`UPDATE artifacts SET (kind, title, origin_kind, origin_id, actor_kind, actor_id,
              updated_at) = (SELECT kind, title, origin_kind, origin_id, actor_kind, actor_id, updated_at
              FROM artifacts WHERE id = ${clash.id}) WHERE id = ${clash.keptId}`;
        }
        // Both rows' versions are now one history, in the order the hub saw them.
        yield* renumberVersions(sql, clash.keptId);
        yield* sql`UPDATE artifacts SET chapter_id = ${plan.landed.id}, revision = ${revision} WHERE id = ${clash.keptId}`;
        const [kept, moved] = yield* Effect.forEach([clash.keptId, clash.id], (id) =>
          sql<ArtifactRow>`SELECT * FROM artifacts WHERE id = ${id}`.pipe(
            Effect.flatMap(([row]) =>
              row === undefined ? Effect.die(new Error(`Artifact ${id} is gone`)) : artifactFromRow(row),
            ),
          ),
        );
        const reviewed = kept === undefined || moved === undefined ? null : carriedReview(kept, moved);
        if (reviewed !== null) carried.push(reviewed);
        yield* sql`DELETE FROM artifact_sightings WHERE artifact_id = ${clash.id}`;
        yield* sql`DELETE FROM artifacts WHERE id = ${clash.id}`;
      }
      yield* sql`UPDATE artifacts SET thread_id = ${to}, chapter_id = ${plan.landed.id}, revision = ${revision}
        WHERE chapter_id = ${plan.stub.id}`;
      return carried;
    });

  // Each carried-over review, written at the sequence of its `ArtifactReviewSettled` from `first` on.
  const settleCarried = (carried: ReadonlyArray<Artifact>, first: number) =>
    Effect.forEach(carried, (artifact, index) =>
      Effect.gen(function* () {
        const settled = new Artifact({ ...artifact, revision: first + index });
        yield* saveReview(sql, settled);
        return { _tag: "ArtifactReviewSettled", artifact: settled } as const;
      }),
    );

  // The quests started in the chapter move whole: every Task of their trees, their Quests and the
  // backpack items held for them, each item journaled as its own `BackpackItemChanged` from `first` on.
  // What their Tasks' turns asked and did outside any message moves too (`moveWork`), so a running
  // quest's approvals, and its later updates, questions and results, are in the camp (#1389).
  const moveQuests = (from: ThreadId, plan: ChapterMovePlan, at: string, first: number) =>
    Effect.gen(function* () {
      const to = plan.landed.threadId;
      const roots = (yield* sql<{ readonly id: string }>`SELECT id FROM tasks WHERE chapter_id = ${plan.stub.id}
        AND parent_id IS NULL AND thread_id = ${from} ORDER BY ${oldest}`).map((row) => row.id);
      if (roots.length === 0) return [];
      const held = yield* sql`SELECT * FROM backpack_items WHERE thread_id = ${from} AND state <> 'resolved'
        AND task_id IN (SELECT id FROM tasks WHERE ${sql.in("root_id", roots)}) ORDER BY ${oldest}`.pipe(
        Effect.flatMap(items.toItems),
      );
      const moved = yield* camps.moveWork(from, to, roots, held as ReadonlyArray<BackpackItem>, at, first);
      yield* sql`UPDATE tasks SET chapter_id = ${plan.landed.id} WHERE ${sql.in("id", roots)}`;
      return moved;
    });

  // A move changes what both threads hold: their briefing checkpoints summed up messages that moved,
  // and every session of either one started from records that are no longer where they were, a
  // resting chapter's decisions and summary included. Both threads' next turns start from their pack.
  const forgetMoved = (from: Thread, plan: ChapterMovePlan) =>
    Effect.gen(function* () {
      const both = [from.id, plan.landed.threadId];
      yield* sql`DELETE FROM thread_checkpoints WHERE ${sql.in("thread_id", both)}`;
      yield* sql`UPDATE threads SET sessions = ${"[]"} WHERE ${sql.in("id", both)}`;
    });

  // The chapter's open suggestion is accepted, journaled after the move at `revision`.
  const acceptSuggestion = (chapterId: ChapterId, campId: ThreadId, at: string, revision: number) =>
    Effect.gen(function* () {
      const suggestion = yield* suggestionOfChapter(sql, chapterId);
      if (suggestion === null || !CampSuggestions.isOpen(suggestion)) return [];
      const next = CampSuggestions.transition(suggestion, { _tag: "Accept", at, campId });
      if (!(next instanceof CampSuggestion)) return [];
      const accepted = new CampSuggestion({ ...next, revision });
      yield* settleSuggestion(sql, accepted);
      return [{ _tag: "CampSuggestionAccepted", threadId: accepted.threadId, suggestion: accepted } as const];
    });

  // The same move asked again: the chapter moved into this camp already.
  const movedBefore = (from: Thread, chapters: ReadonlyArray<Chapter>, chapterId: ChapterId, campId: ThreadId) =>
    Effect.gen(function* () {
      const chapter = chapters.find((each) => each.id === chapterId);
      if (chapter === undefined || ChapterStates.isInThread(chapter) || chapter.movedTo !== campId) return null;
      const camp = yield* shown(campId);
      return new ChapterMove({
        thread: from,
        camp,
        stub: chapter,
        chapters,
        campChapters: yield* listChapters(campId),
      });
    });

  const moveChapter = (input: {
    readonly threadId: ThreadId;
    readonly chapterId: ChapterId;
    readonly target: ChapterMoveTarget;
    readonly at: string;
  }) =>
    change<ChapterMove, Refusal>((first) =>
      Effect.gen(function* () {
        const from = yield* shown(input.threadId);
        const chapters = yield* listChapters(from.id);
        const campId = input.target._tag === "camp" ? input.target.campId : input.target.camp.id;
        const before = yield* movedBefore(from, chapters, input.chapterId, campId);
        if (before !== null) return { value: before, events: [] };
        const made = yield* campFor(input.target, first);
        if (made.camp === undefined) return yield* new ChapterRefused({ threadId: from.id, reason: "not-a-camp" });
        if ((yield* busy(from.id)) || (yield* busy(made.camp.id))) {
          return yield* new ChapterRefused({ threadId: from.id, reason: "reply-running" });
        }
        const campChapters = yield* listChapters(made.camp.id);
        const revision = first + made.events.length;
        const planned = planMove({
          from,
          chapters,
          chapterId: input.chapterId,
          chapterEmpty: yield* holdsNone(chapters.find((each) => each.id === input.chapterId)?.id),
          to: made.camp,
          campChapters,
          campLiveEmpty: yield* holdsNone(campChapters.find(ChapterStates.isLive)?.id),
          ids: { landed: ChapterId.make(crypto.randomUUID()), nextLive: ChapterId.make(crypto.randomUUID()) },
          at: input.at,
        });
        if (!isPlan(planned)) return yield* Effect.fail(planned);
        const plan = stamped(planned, revision);
        yield* writeChapters(sql, plan.from);
        yield* writeChapters(sql, plan.camp);
        yield* moveMessages(from.id, plan, revision);
        yield* sql`UPDATE decisions SET thread_id = ${plan.landed.threadId}, chapter_id = ${plan.landed.id},
          revision = ${revision} WHERE chapter_id = ${plan.stub.id}`;
        const carried = yield* moveArtifacts(plan, revision);
        yield* forgetMoved(from, plan);
        const accepted = yield* acceptSuggestion(input.chapterId, made.camp.id, input.at, revision + 1);
        const items = yield* moveQuests(from.id, plan, input.at, revision + 1 + accepted.length);
        const reviews = yield* settleCarried(carried, revision + 1 + accepted.length + items.length);
        const value = new ChapterMove({
          thread: yield* shown(from.id),
          camp: yield* shown(made.camp.id),
          stub: plan.stub,
          chapters: plan.from.chapters,
          campChapters: plan.camp.chapters,
        });
        const moved: JournaledEvent = { _tag: "ChapterMoved", threadId: from.id, ...value, chapter: plan.landed };
        return { value, events: [...made.events, moved, ...accepted, ...items, ...reviews] };
      }),
    );

  return { moveChapter } as const;
};

/**
 * A moved message's steps, each logged one naming the thread its full log was kept under, since a
 * log's file is named by the thread it was written in.
 */
const keptLogsIn = (steps: unknown, from: ThreadId): string =>
  JSON.stringify(
    (JSON.parse(String(steps ?? "[]")) as ReadonlyArray<ReplyStep>).map((step) =>
      step.output?.logged === true && step.output.loggedIn === undefined
        ? { ...step, output: { ...step.output, loggedIn: from } }
        : step,
    ),
  );

/** The plan with every chapter it changed at `revision`, the sequence of the `ChapterMoved` that journals it. */
const stamped = (plan: ChapterMovePlan, revision: number): ChapterMovePlan => {
  const at = (chapters: ReadonlyArray<Chapter>, changed: ReadonlyArray<Chapter>) => {
    const ids = new Set(changed.map((chapter) => chapter.id));
    return chapters.map((chapter) => (ids.has(chapter.id) ? stampedChapter(chapter, revision) : chapter));
  };
  const from = at(plan.from.chapters, plan.from.changed);
  const camp = at(plan.camp.chapters, plan.camp.changed);
  const byId = (chapters: ReadonlyArray<Chapter>, id: ChapterId) =>
    chapters.find((chapter) => chapter.id === id) as Chapter;
  const changedOf = (chapters: ReadonlyArray<Chapter>, changed: ReadonlyArray<Chapter>) =>
    changed.map((chapter) => byId(chapters, chapter.id));
  return {
    stub: byId(from, plan.stub.id),
    landed: byId(camp, plan.landed.id),
    from: { chapters: from, changed: changedOf(from, plan.from.changed) },
    camp: { chapters: camp, changed: changedOf(camp, plan.camp.changed) },
  };
};

const stampedChapter = (chapter: Chapter, revision: number) => new Chapter({ ...chapter, revision });
