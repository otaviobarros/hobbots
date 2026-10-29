import { AgentNotFound, HobbotsApi, ThreadNotFound } from "@hobbots/api";
import { HobbotsRepository } from "@hobbots/persistence";
import { RuntimeAdapter } from "@hobbots/runtimes";
import { Effect, Layer, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ChatService } from "./chat.ts";
import { EventBus } from "./event-bus.ts";
import { Installation } from "./installation.ts";

const AgentsHandlers = HttpApiBuilder.group(HobbotsApi, "agents", (handlers) =>
  Effect.gen(function* () {
    const repo = yield* HobbotsRepository;
    const chat = yield* ChatService;
    return handlers.handleAll({
      list: () => repo.listAgents,
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
);

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
      interrupt: ({ params }) => chat.interrupt(params.threadId),
    });
  }),
);

const SystemHandlers = HttpApiBuilder.group(HobbotsApi, "system", (handlers) =>
  Effect.gen(function* () {
    const bus = yield* EventBus;
    const runtime = yield* RuntimeAdapter;
    const installation = yield* Installation;
    return handlers.handleAll({
      health: () => Effect.succeed(installation),
      runtimes: () => runtime.health.pipe(Effect.map((health) => [health])),
      events: () => Effect.succeed(bus.stream),
    });
  }),
);

export const ApiRoutes = HttpApiBuilder.layer(HobbotsApi).pipe(
  Layer.provide([AgentsHandlers, ThreadsHandlers, SystemHandlers]),
);
