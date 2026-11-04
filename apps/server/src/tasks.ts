import { HobbotsRepository, QuestionService, TaskControls, TaskRepository } from "@hobbots/agents";
import { AgentNotFound, HobbotsApi, QuestNotFound, TaskNotFound, ThreadNotFound } from "@hobbots/api";
import { type AgentId, HISTORY_PAGE_DAYS, historyEvents, historyPage, partyOf, type TaskId } from "@hobbots/domain";
import { EventJournal } from "@hobbots/persistence";
import { DateTime, Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { formatCursor } from "./event-stream.ts";

// Reads of Task trees and Quests (ADR 018). The cursor is taken before the read, so resuming the
// event stream from it replays every change the read could have missed (ADR 013).
export const TasksHandlers = HttpApiBuilder.group(HobbotsApi, "tasks", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const repo = yield* HobbotsRepository;
    const journal = yield* EventJournal;
    const cursor = journal.head.pipe(Effect.map((head) => formatCursor(head.epoch, head.sequence)));
    // A read of one hob's records, with the cursor taken before it, or 404 for a hob that is not there.
    const ofHob = <A>(agentId: AgentId, records: Effect.Effect<A>) =>
      Effect.gen(function* () {
        const at = yield* cursor;
        const hob = yield* repo.findAgent(agentId);
        if (Option.isNone(hob)) return yield* new AgentNotFound({ agentId });
        return { at, read: yield* records };
      });
    return handlers.handleAll({
      tree: ({ params }) =>
        Effect.gen(function* () {
          const at = yield* cursor;
          const tree = yield* tasks.readTree(params.taskId);
          if (Option.isNone(tree)) return yield* new TaskNotFound({ taskId: params.taskId });
          return { cursor: at, tree: tree.value };
        }),
      ledger: ({ params }) =>
        Effect.gen(function* () {
          const at = yield* cursor;
          const ledger = yield* tasks.readLedger(params.taskId);
          if (Option.isNone(ledger)) return yield* new TaskNotFound({ taskId: params.taskId });
          return { cursor: at, ledger: ledger.value };
        }),
      quest: ({ params }) =>
        Effect.gen(function* () {
          const at = yield* cursor;
          const quest = yield* tasks.findQuest(params.questId);
          const tree = Option.isNone(quest) ? Option.none() : yield* tasks.readTree(quest.value.taskId);
          if (Option.isNone(quest) || Option.isNone(tree)) return yield* new QuestNotFound({ questId: params.questId });
          return {
            cursor: at,
            quest: quest.value,
            party: partyOf(quest.value, tree.value.delegations),
            tree: tree.value,
          };
        }),
      threadTasks: ({ params }) =>
        Effect.gen(function* () {
          const at = yield* cursor;
          const thread = yield* repo.findThread(params.threadId);
          if (Option.isNone(thread)) return yield* new ThreadNotFound({ threadId: params.threadId });
          return { cursor: at, trees: yield* tasks.readThreadTrees(params.threadId) };
        }),
      failed: () =>
        Effect.gen(function* () {
          const at = yield* cursor;
          return { cursor: at, tasks: yield* tasks.listFailedTasks };
        }),
      questWork: ({ params }) =>
        ofHob(params.agentId, tasks.listMemberWork(params.agentId)).pipe(
          Effect.map(({ at, read }) => ({ cursor: at, work: read })),
        ),
      history: ({ params, query }) =>
        ofHob(params.agentId, tasks.readHistoryRecords(params.agentId)).pipe(
          Effect.map(({ at, read }) => ({
            cursor: at,
            page: historyPage(historyEvents(params.agentId, read), {
              timeZone: query.timeZone,
              filter: query.filter ?? "all",
              before: query.before === undefined ? null : DateTime.toEpochMillis(query.before),
              days: query.days ?? HISTORY_PAGE_DAYS,
            }),
          })),
        ),
    });
  }),
);

// What you say about a Quest's work (ADR 018), for user sessions only (PE-006): the questions that
// reached you and your answers, and your notes for a Task's lead.
export const QuestionsHandlers = HttpApiBuilder.group(HobbotsApi, "questions", (handlers) =>
  Effect.gen(function* () {
    const questions = yield* QuestionService;
    const journal = yield* EventJournal;
    return handlers.handleAll({
      list: () =>
        Effect.gen(function* () {
          const head = yield* journal.head;
          return { cursor: formatCursor(head.epoch, head.sequence), questions: yield* questions.listWaiting };
        }),
      answer: ({ params, payload }) => questions.answer(params.questionId, payload.answer, payload.via),
      leaveNote: ({ params, payload }) => questions.leaveNote(params.taskId, payload.key, payload.text),
    });
  }),
).pipe(Layer.provide(QuestionService.layer));

// Your Cancel, Retry and Reassign on a Task (ADR 018), for user sessions only (PE-006). Each answers
// with the tree once the change is recorded, and the cursor taken after it, so the stream brings
// each outcome the hub confirms later.
export const TaskControlsHandlers = HttpApiBuilder.group(HobbotsApi, "taskControls", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const controls = yield* TaskControls;
    const journal = yield* EventJournal;
    const treeOf = (taskId: TaskId) =>
      Effect.gen(function* () {
        const head = yield* journal.head;
        const tree = yield* tasks.readTree(taskId);
        if (Option.isNone(tree)) return yield* new TaskNotFound({ taskId });
        return { cursor: formatCursor(head.epoch, head.sequence), tree: tree.value };
      });
    return handlers.handleAll({
      cancel: ({ params }) => controls.cancel(params.taskId).pipe(Effect.andThen(treeOf(params.taskId))),
      cancelQuest: ({ params }) =>
        controls.cancelQuest(params.questId).pipe(
          Effect.andThen(tasks.findQuest(params.questId)),
          Effect.flatMap((quest) =>
            Option.isNone(quest)
              ? Effect.fail(new QuestNotFound({ questId: params.questId }))
              : treeOf(quest.value.taskId).pipe(
                  Effect.catchTag("TaskNotFound", () => Effect.fail(new QuestNotFound({ questId: params.questId }))),
                ),
          ),
        ),
      retry: ({ params }) => controls.retry(params.taskId).pipe(Effect.andThen(treeOf(params.taskId))),
      reassign: ({ params, payload }) =>
        controls.reassign(params.taskId, payload.agentId).pipe(Effect.andThen(treeOf(params.taskId))),
    });
  }),
).pipe(Layer.provide(TaskControls.layer));
