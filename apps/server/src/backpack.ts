import { EventPublisher, HobbotsRepository, TaskRepository } from "@hobbots/agents";
import { AgentNotFound, HobbotsApi, QuestNotFound } from "@hobbots/api";
import { Backpack, type BackpackScope, DispatcherHost } from "@hobbots/inbox";
import { EventJournal } from "@hobbots/persistence";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { formatCursor } from "./event-stream.ts";

// Reads of hobs' backpacks (ADR 019). The cursor is taken before the read, so resuming the event
// stream from it replays every change the read could have missed (ADR 013).
export const BackpackHandlers = HttpApiBuilder.group(HobbotsApi, "backpack", (handlers) =>
  Effect.gen(function* () {
    const backpack = yield* Backpack;
    const repo = yield* HobbotsRepository;
    const tasks = yield* TaskRepository;
    const journal = yield* EventJournal;
    const read = (scope: BackpackScope) =>
      Effect.gen(function* () {
        const head = yield* journal.head;
        return { cursor: formatCursor(head.epoch, head.sequence), items: yield* backpack.listOpen(scope) };
      });
    return handlers.handleAll({
      workspace: () => read({ _tag: "Workspace" }),
      hob: ({ params }) =>
        Effect.gen(function* () {
          if (Option.isNone(yield* repo.findAgent(params.agentId))) {
            return yield* new AgentNotFound({ agentId: params.agentId });
          }
          return yield* read({ _tag: "Hob", agentId: params.agentId });
        }),
      quest: ({ params }) =>
        Effect.gen(function* () {
          if (Option.isNone(yield* tasks.findQuest(params.questId))) {
            return yield* new QuestNotFound({ questId: params.questId });
          }
          return yield* read({ _tag: "Quest", questId: params.questId });
        }),
    });
  }),
);

/** What the dispatcher reads and announces through: the Task trees, and the hub's event bus. */
export const DispatcherHostLive = Layer.effect(
  DispatcherHost,
  Effect.gen(function* () {
    const tasks = yield* TaskRepository;
    const publisher = yield* EventPublisher;
    return DispatcherHost.of({
      treeOf: (taskId) =>
        tasks.readTree(taskId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed([]),
              onSome: ({ tasks: [task] }) =>
                task === undefined
                  ? Effect.succeed([])
                  : tasks
                      .readTree(task.rootId)
                      .pipe(Effect.map(Option.match({ onNone: () => [], onSome: (tree) => tree.tasks }))),
            }),
          ),
        ),
      announce: publisher.publish,
    });
  }),
);
