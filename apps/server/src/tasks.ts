import { HobbotsRepository, QuestionService, TaskRepository } from "@hobbots/agents";
import { AgentNotFound, HobbotsApi, QuestNotFound, TaskNotFound, ThreadNotFound } from "@hobbots/api";
import { partyOf } from "@hobbots/domain";
import { EventJournal } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { formatCursor } from "./event-stream.ts";
import { UserSessionOnlyLive } from "./user-session.ts";

// Reads of Task trees and Quests (ADR 018). The cursor is taken before the read, so resuming the
// event stream from it replays every change the read could have missed (ADR 013).
export const TasksHandlers = HttpApiBuilder.group(HobbotsApi, "tasks", (handlers) =>
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const repo = yield* HobbotsRepository;
    const journal = yield* EventJournal;
    const cursor = journal.head.pipe(Effect.map((head) => formatCursor(head.epoch, head.sequence)));
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
      questWork: ({ params }) =>
        Effect.gen(function* () {
          const at = yield* cursor;
          const hob = yield* repo.findAgent(params.agentId);
          if (Option.isNone(hob)) return yield* new AgentNotFound({ agentId: params.agentId });
          return { cursor: at, work: yield* tasks.listMemberWork(params.agentId) };
        }),
    });
  }),
);

// Your answers to questions that reached you (ADR 018), for user sessions only (PE-006).
export const QuestionsHandlers = HttpApiBuilder.group(HobbotsApi, "questions", (handlers) =>
  Effect.gen(function* () {
    const questions = yield* QuestionService;
    return handlers.handleAll({
      answer: ({ params, payload }) => questions.answer(params.questionId, payload.answer),
    });
  }),
).pipe(Layer.provide([UserSessionOnlyLive, QuestionService.layer]));
