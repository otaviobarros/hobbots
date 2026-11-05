import { HobbotsApi } from "@hobbots/api";
import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HubBackups } from "./backups.ts";
import { HubReset } from "./resets.ts";
import { HubRestores } from "./restores.ts";

const IDLE = { state: { _tag: "Idle" } as const, defaultDestination: "" };
const NEVER_RESTORED = { latest: null, failed: null };

// Settings › Your data: backups and restores (ADR 026), and Start over (#948). A hub without backups, as in tests that do not need them,
// reports none and refuses to start one.
export const BackupHandlers = HttpApiBuilder.group(HobbotsApi, "backup", (handlers) =>
  Effect.gen(function* () {
    const backups = yield* Effect.serviceOption(HubBackups);
    const restores = yield* Effect.serviceOption(HubRestores);
    const reset = yield* Effect.serviceOption(HubReset);
    const unavailable = Effect.die("This hub does not make backups");
    return handlers.handleAll({
      status: () => (Option.isSome(backups) ? backups.value.status : Effect.succeed(IDLE)),
      start: ({ payload }) => (Option.isSome(backups) ? backups.value.start(payload.destination) : unavailable),
      cancel: () => (Option.isSome(backups) ? backups.value.cancel : Effect.succeed(IDLE)),
      restoreStatus: () => (Option.isSome(restores) ? restores.value.status : Effect.succeed(NEVER_RESTORED)),
      inspect: ({ payload }) => (Option.isSome(restores) ? restores.value.inspect(payload.path) : unavailable),
      restore: ({ payload }) => (Option.isSome(restores) ? restores.value.restore(payload.path) : unavailable),
      resume: () => (Option.isSome(restores) ? restores.value.resume : Effect.succeed(NEVER_RESTORED)),
      deleteSetAside: () => (Option.isSome(restores) ? restores.value.deleteSetAside : Effect.succeed(NEVER_RESTORED)),
      reset: () => (Option.isSome(reset) ? reset.value.start : unavailable),
    });
  }),
);
