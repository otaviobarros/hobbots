import type { Effort, RuntimeHealth, RuntimeModels } from "@hobbots/domain";
import { Context, type Effect, Schema, type Stream } from "effect";

/** Normalized runtime output. Vendor message shapes stay inside each adapter. */
export type RuntimeEvent =
  | {
      readonly _tag: "SessionStarted";
      readonly sessionId: string;
      readonly billing: string | null;
    }
  | { readonly _tag: "TextDelta"; readonly text: string }
  /** The runtime began something other than writing, such as thinking. `id` is unique within the turn. */
  | {
      readonly _tag: "StepStarted";
      readonly id: string;
      readonly kind: "thinking" | "tool";
      readonly label: string;
    }
  | { readonly _tag: "StepEnded"; readonly id: string }
  | {
      readonly _tag: "Completed";
      readonly sessionId: string;
      readonly text: string;
    };

export class RuntimeError extends Schema.TaggedError<RuntimeError>()("RuntimeError", {
  message: Schema.String,
}) {}

/** The provider refused the turn because its usage limit was reached. */
export class RuntimeLimitReached extends Schema.TaggedError<RuntimeLimitReached>()("RuntimeLimitReached", {
  /** When the allowance refills (ISO 8601), if the provider said. */
  resetsAt: Schema.NullOr(Schema.String),
}) {}

export interface PromptRequest {
  readonly prompt: string;
  /** Runtime session to resume, or null to start a new one. */
  readonly sessionId: string | null;
  readonly instructions: string;
  /** The hob's model, or null for the runtime's default. */
  readonly model: string | null;
  /** The hob's effort, or null for the model's default. */
  readonly effort: Effort | null;
}

export interface RuntimeAdapterShape {
  readonly health: Effect.Effect<RuntimeHealth>;
  /** Models a hob can choose, from the runtime when it reports them, otherwise a documented list. */
  readonly models: Effect.Effect<RuntimeModels>;
  /** Runs one turn. Interrupting the stream cancels the turn. */
  readonly sendPrompt: (request: PromptRequest) => Stream.Stream<RuntimeEvent, RuntimeError | RuntimeLimitReached>;
}

export class RuntimeAdapter extends Context.Service<RuntimeAdapter, RuntimeAdapterShape>()(
  "@hobbots/runtimes/RuntimeAdapter",
) {}
