import { Context, Effect, Option } from "effect";

/**
 * Whether the hub holds work after a restore (ADR 026). Time passed between the backup and the
 * restore, and some of the work waiting in it may already have happened, so while work is held no
 * backpack item is delivered, no continuation or queued step starts and no queued chat message is
 * sent. A message you send yourself still starts. Resume work turns it off.
 */
export class WorkHold extends Context.Service<
  WorkHold,
  {
    readonly held: Effect.Effect<boolean>;
    /** Turns the hold off. Waking the work that waited is the caller's. */
    readonly release: Effect.Effect<void>;
  }
>()("@hobbots/agents/WorkHold") {}

/** Whether work is held now: never, on a hub without the service, as in tests that do not restore. */
export const workHeld: Effect.Effect<Effect.Effect<boolean>> = Effect.map(Effect.serviceOption(WorkHold), (hold) =>
  Option.isSome(hold) ? hold.value.held : Effect.succeed(false),
);
