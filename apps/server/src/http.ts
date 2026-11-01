import {
  ChatService,
  foundAgent,
  HobbotsRepository,
  HobLifecycle,
  HobService,
  missingRuntimeHealth,
  missingRuntimeModels,
  readToolLog,
  runtimeAdapters,
  ToolLogs,
} from "@hobbots/agents";
import { HobbotsApi, type SetBrainPayload, ThreadNotFound } from "@hobbots/api";
import { RuntimeKind, type ThreadId } from "@hobbots/domain";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ApprovalsHandlers } from "./approvals.ts";
import { GrantsHandlers } from "./grants.ts";
import { HobInputErrorsLayer } from "./hob-input-errors.ts";
import { Installation } from "./installation.ts";
import { PermissionsHandlers } from "./permissions.ts";
import { SearchHandlers } from "./search.ts";
import { SetupHandlers } from "./setup.ts";

// The create and update endpoints' middleware is read when the group is built, so it is provided here.
const AgentsHandlers = HttpApiBuilder.group(HobbotsApi, "agents", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const hobs = yield* HobService;
    const lifecycle = yield* HobLifecycle;
    return handlers.handleAll({
      list: ({ query }) => repo.listAgentsWithStatus(query.status ? [query.status] : ["active", "paused"]),
      create: ({ payload }) => hobs.create(payload),
      update: ({ params, payload }) => hobs.update(params.agentId, payload),
      pause: ({ params }) => lifecycle.pause(params.agentId),
      wake: ({ params }) => lifecycle.wake(params.agentId),
      retire: ({ params, payload }) => lifecycle.retire(params.agentId, payload.activeWork),
      threads: ({ params }) =>
        repo.findAgent(params.agentId).pipe(
          Effect.flatMap(foundAgent(params.agentId)),
          Effect.flatMap(() => repo.listThreads(params.agentId)),
        ),
      createThread: ({ params }) => chat.createThread(params.agentId),
    });
  }),
).pipe(Layer.provide(HobInputErrorsLayer));

const ThreadsHandlers = HttpApiBuilder.group(HobbotsApi, "threads", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    const hobs = yield* HobService;
    // Hubs without a log store, as in tests, have no full logs to open.
    const logs = yield* Effect.serviceOption(ToolLogs);
    // Making a brain the hob's default edits the hob (a new configuration version), then the thread
    // follows the hob again. Otherwise only the thread changes (ADR 017).
    const setBrain = (threadId: ThreadId, { brain, makeDefault }: SetBrainPayload) =>
      Effect.gen(function* () {
        if (brain === null || makeDefault !== true) return yield* chat.setBrain(threadId, brain);
        const thread = yield* repo
          .findThread(threadId)
          .pipe(
            Effect.flatMap(
              Option.match({ onNone: () => Effect.fail(new ThreadNotFound({ threadId })), onSome: Effect.succeed }),
            ),
          );
        yield* hobs.update(thread.agentId, brain);
        return yield* chat.setBrain(threadId, null);
      });
    return handlers.handleAll({
      messages: ({ params }) =>
        repo.findThread(params.threadId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ThreadNotFound({ threadId: params.threadId })),
              onSome: () => repo.listMessages(params.threadId),
            }),
          ),
        ),
      sendPrompt: ({ params, payload }) => chat.sendPrompt(params.threadId, payload.content),
      removeQueued: ({ params }) => chat.removeQueued(params.threadId, params.messageId),
      sendNow: ({ params }) => chat.sendNow(params.threadId, params.messageId),
      interrupt: ({ params }) => chat.stop(params.threadId),
      continueReply: ({ params }) => chat.continueReply(params.threadId, params.messageId),
      toolLog: ({ params }) => readToolLog(params, repo, logs),
      setBrain: ({ params, payload }) => setBrain(params.threadId, payload),
    });
  }),
);

const SystemHandlers = HttpApiBuilder.group(HobbotsApi, "system", (handlers) =>
  Effect.gen(function* () {
    const adapters = yield* runtimeAdapters;
    const installation = yield* Installation;
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;

    // A hob is working while one of its threads has a turn in progress.
    const activity = chat.activeThreads.pipe(
      Effect.flatMap((threadIds) =>
        Effect.forEach(threadIds, (threadId) =>
          repo.findThread(threadId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(Option.none()),
                onSome: (thread) =>
                  repo
                    .findAgent(thread.agentId)
                    .pipe(Effect.map(Option.map((agent) => ({ agentId: agent.id, name: agent.name, threadId })))),
              }),
            ),
          ),
        ),
      ),
      Effect.map((hobs) => ({ working: hobs.flatMap(Option.toArray) })),
    );

    return handlers.handleAll({
      health: () => Effect.succeed(installation),
      activity: () => activity,
      // Every runtime, Claude Code first; one the hub has no adapter for is listed as unavailable.
      runtimes: () =>
        Effect.forEach(
          RuntimeKind.literals,
          (kind) => adapters(kind)?.health ?? Effect.succeed(missingRuntimeHealth(kind)),
          {
            concurrency: "unbounded",
          },
        ),
    });
  }),
);

// A runtime the hub has no adapter for offers no models.
const RuntimesHandlers = HttpApiBuilder.group(HobbotsApi, "runtimes", (handlers) =>
  Effect.gen(function* () {
    const adapters = yield* runtimeAdapters;
    return handlers.handleAll({
      models: ({ params }) => adapters(params.runtime)?.models ?? Effect.succeed(missingRuntimeModels(params.runtime)),
    });
  }),
);

export const ApiRoutes = HttpApiBuilder.layer(HobbotsApi).pipe(
  Layer.provide([
    AgentsHandlers,
    ThreadsHandlers,
    SystemHandlers,
    SetupHandlers,
    RuntimesHandlers,
    SearchHandlers,
    PermissionsHandlers,
    ApprovalsHandlers,
    GrantsHandlers,
  ]),
);
