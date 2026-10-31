import { AgentNotFound, HobbotsApi, ThreadNotFound } from "@hobbots/api";
import { HobbotsRepository } from "@hobbots/persistence";
import { RuntimeAdapter } from "@hobbots/runtimes";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ChatService } from "./chat.ts";
import { HobInputErrorsLayer, HobService } from "./hobs.ts";
import { Installation } from "./installation.ts";
import { HobLifecycle } from "./lifecycle.ts";
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
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new AgentNotFound({ agentId: params.agentId })),
              onSome: () => repo.listThreads(params.agentId),
            }),
          ),
        ),
      createThread: ({ params }) => chat.createThread(params.agentId),
    });
  }),
).pipe(Layer.provide(HobInputErrorsLayer));

const ThreadsHandlers = HttpApiBuilder.group(HobbotsApi, "threads", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
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
    });
  }),
);

const SystemHandlers = HttpApiBuilder.group(HobbotsApi, "system", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeAdapter;
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
      runtimes: () => runtime.health.pipe(Effect.map((health) => [health])),
    });
  }),
);

// Only Claude Code is wired, so every runtime kind is answered by the one adapter.
const RuntimesHandlers = HttpApiBuilder.group(HobbotsApi, "runtimes", (handlers) =>
  Effect.gen(function* () {
    const runtime = yield* RuntimeAdapter;
    return handlers.handleAll({ models: () => runtime.models });
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
  ]),
);
