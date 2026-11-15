import {
  ChatService,
  ClaimRegister,
  EventPublisher,
  giveBackTask,
  TaskRepository,
  takeOverTask,
} from "@hobbots/agents";
import { HobbotsApi } from "@hobbots/api";
import { Claims } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";

// The open clashes a chat or camp shows as a Heads-up (ADR 037, #1390), for user sessions only
// (PE-006), Take over (#1449, #1537) and Give back (#1538). A hub built without the claims register, as in
// some tests, has no clashes to show and no claim to take over or give back.
export const ClaimsHandlers = HttpApiBuilder.group(HobbotsApi, "claims", (handlers) =>
  Effect.gen(function* () {
    const register = yield* Effect.serviceOption(ClaimRegister);
    const tasks = yield* TaskRepository;
    const publisher = yield* EventPublisher;
    const chat = yield* ChatService;
    return handlers.handleAll({
      clashes: ({ params }) =>
        Option.match(register, {
          onNone: () => Effect.succeed([]),
          onSome: (claims) => claims.clashesIn(params.channelId),
        }),
      taskClaims: ({ params }) =>
        Option.match(register, {
          onNone: () => Effect.succeed([]),
          onSome: (claims) => Effect.map(claims.ofTask(params.taskId), (all) => all.filter(Claims.isOpen)),
        }),
      takeOver: ({ params }) =>
        Option.match(register, {
          onNone: () => Effect.succeed([]),
          onSome: (claims) =>
            takeOverTask(params.taskId).pipe(
              Effect.provideService(ClaimRegister, claims),
              Effect.provideService(TaskRepository, tasks),
              Effect.provideService(EventPublisher, publisher),
              // A turn already running started its sandbox without what you took: it stops, chat and
              // Task sessions alike, and the next one starts with it closed (#1537).
              Effect.tap((moved) => (moved.length === 0 ? Effect.void : chat.reviewAuthority())),
            ),
        }),
      giveBack: ({ params }) =>
        Option.match(register, {
          onNone: () => Effect.succeed([]),
          onSome: (claims) =>
            giveBackTask(params.taskId).pipe(
              Effect.provideService(ClaimRegister, claims),
              Effect.provideService(TaskRepository, tasks),
              Effect.provideService(EventPublisher, publisher),
            ),
        }),
    });
  }),
);
