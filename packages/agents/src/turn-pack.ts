import { isActiveQuest, type Message, type PackReport, type Thread, type ThreadId } from "@hobbots/domain";
import { Context, Effect, HashMap, Layer, Option, Ref } from "effect";
import { BriefLog } from "./brief-log.ts";
import { ChapterRepository } from "./chapters.ts";
import {
  buildPack,
  type PackArtifact,
  type PackDecision,
  type PackQuest,
  type PackRecords,
  packChapters,
} from "./context-pack.ts";
import { type PackPeople, reasonLine, type TurnReason } from "./pack-people.ts";
import { HobbotsRepository } from "./repository.ts";
import { TaskRepository } from "./tasks.ts";

// What a new session's turn reads its context pack from (ADR 037, #1380), and the reports of the
// packs turns read.

/** What a pack is built from before the turn knows its memory brief. */
export type PackSources = Omit<PackRecords, "memoryBrief">;

/**
 * The thread's active decisions and its artifacts index, both newest first (#1383). Without it, a
 * pack has neither.
 */
export class PackRecordSource extends Context.Service<
  PackRecordSource,
  {
    readonly activeDecisions: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<PackDecision>>;
    readonly artifactsIndex: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<PackArtifact>>;
  }
>()("@hobbots/agents/PackRecordSource") {}

/**
 * The report of the last pack each thread's turn read, for the Focus chip and the dev-only endpoint.
 * Kept in memory: after a restart, a thread's next new session reports again.
 */
export class PackReports extends Context.Service<
  PackReports,
  {
    readonly record: (threadId: ThreadId, report: PackReport) => Effect.Effect<void>;
    readonly last: (threadId: ThreadId) => Effect.Effect<Option.Option<PackReport>>;
  }
>()("@hobbots/agents/PackReports") {
  static readonly layer = Layer.effect(
    PackReports,
    Effect.gen(function* () {
      // standards-allow STD-ARCH-013: the last report per thread, a log for review, not lifecycle state.
      const reports = yield* Ref.make(HashMap.empty<ThreadId, PackReport>());
      return PackReports.of({
        record: (threadId, report) => Ref.update(reports, HashMap.set(threadId, report)),
        last: (threadId) => Ref.get(reports).pipe(Effect.map(HashMap.get(threadId))),
      });
    }),
  );
}

/**
 * Reads a thread's records for its pack: the resting chapters with their summaries, the plain one
 * for any the projector has not written yet, so a new chapter's first turn always hears of the
 * last; its open work; what Start fresh carried, until the hob first replies; its brief, as the
 * brief projector last wrote it (#1384); its decisions and artifacts; its Quests under way, from their
 * summaries; and who is here and why the turn runs, for `people`'s hob (ADR 039). Only the thread's
 * own chapters are read, so a private camp's summaries reach no other camp's pack. Nothing here is
 * any hob's memory: each hob's memory brief is its own, sent beside the pack.
 */
export const makePackSources = Effect.gen(function* () {
  const repo = yield* HobbotsRepository;
  const chapters = yield* Effect.serviceOption(ChapterRepository);
  const records = yield* Effect.serviceOption(PackRecordSource);
  const briefs = yield* Effect.serviceOption(BriefLog);
  const tasks = yield* Effect.serviceOption(TaskRepository);
  // The Quests under way in the thread, named by their Task's brief, oldest first.
  const questsIn = (thread: Thread, people: PackPeople) =>
    Effect.gen(function* () {
      if (Option.isNone(tasks)) return [];
      const summaries = (yield* tasks.value.listQuestSummaries(thread.id)).filter((each) => isActiveQuest(each.state));
      return yield* Effect.forEach(summaries, (summary) =>
        Effect.map(
          tasks.value.readTree(summary.taskId),
          (tree): PackQuest => ({
            title: Option.match(tree, {
              onNone: () => `Quest ${summary.questId}`,
              onSome: (each) =>
                each.tasks.find((task) => task.id === summary.taskId)?.brief ?? `Quest ${summary.questId}`,
            }),
            lead: people.nameOf({ kind: "hob", id: summary.leadId }),
            state: summary.state,
            open: summary.tones.working + summary.tones.waiting + summary.tones.needs + summary.tones.problem,
            needsYou: summary.needsYou,
            readyForReview: summary.readyForReview,
          }),
        ),
      );
    });
  return (
    thread: Thread,
    live: ReadonlyArray<Message>,
    transcript: ReadonlyArray<Message>,
    people: PackPeople,
    reason: TurnReason | null,
  ) =>
    Effect.gen(function* () {
      const stored = Option.isNone(chapters) ? [] : yield* chapters.value.listChapters(thread.id);
      const replied = transcript.some((m) => m.role === "assistant");
      const sources: PackSources = {
        campBrief: Option.isNone(briefs)
          ? null
          : Option.match(yield* briefs.value.briefOf(thread.id), { onNone: () => null, onSome: (brief) => brief.text }),
        decisions: Option.isNone(records) ? [] : yield* records.value.activeDecisions(thread.id),
        // Only a shared thread lists who is here and why the hob answers (ADR 039).
        members: people.shared
          ? { members: people.members, reason: reason === null ? null : reasonLine(reason, people.nameOf) }
          : null,
        work: yield* repo.listOpenWork(thread.id),
        quests: yield* questsIn(thread, people),
        carried: thread.origin === null || replied ? [] : yield* repo.listCarriedOver(thread.id),
        artifacts: Option.isNone(records) ? [] : yield* records.value.artifactsIndex(thread.id),
        chapters: packChapters(stored, transcript),
        live,
        speaker: people.speaker,
      };
      return sources;
    });
});

/** The pack a turn reads, logged with its report and kept for the Focus chip. */
export const packTurn = (
  reports: Option.Option<PackReports["Service"]>,
  threadId: ThreadId,
  sources: PackSources | null,
  memory: { readonly text: string | null } | null,
) =>
  Effect.gen(function* () {
    // A resumed session has no pack: it already holds what the pack would tell it.
    if (sources === null) return null;
    const pack = buildPack({ ...sources, memoryBrief: memory?.text ?? null });
    yield* Effect.logInfo("Built a context pack").pipe(
      Effect.annotateLogs({ threadId, packTokens: pack.report.tokens, packReport: JSON.stringify(pack.report) }),
    );
    if (Option.isSome(reports)) yield* reports.value.record(threadId, pack.report);
    return pack.text;
  });
