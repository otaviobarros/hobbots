import { type CreateAgentPayload, HobInputErrors, InvalidHob } from "@hobbots/api";
import { Agent, AgentId, type Effort, type RuntimeModels } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { RuntimeAdapter } from "@hobbots/runtimes";
import { Context, DateTime, Effect, Layer, SchemaIssue } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import { EventBus } from "./event-bus.ts";

/**
 * Checks a new hob's model and effort against what the runtime offers. A null model is the
 * runtime's default, so its effort is checked against the runtime's "default" entry when it lists one.
 */
export const checkBrain = (
  offered: RuntimeModels,
  brain: { readonly model: string | null; readonly effort: Effort | null },
): InvalidHob | undefined => {
  const model = offered.models.find((candidate) => candidate.id === (brain.model ?? "default"));
  if (brain.model !== null && model === undefined) {
    return new InvalidHob({ field: "model", message: `${offered.runtime} does not offer the model "${brain.model}"` });
  }
  if (brain.effort !== null && model !== undefined && !model.efforts.includes(brain.effort)) {
    return new InvalidHob({
      field: "effort",
      message:
        model.efforts.length === 0
          ? `${model.displayName} takes no effort setting`
          : `${model.displayName} accepts the efforts ${model.efforts.join(", ")}, not "${brain.effort}"`,
    });
  }
  return undefined;
};

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1();

/** The first failing field of a create request, as `InvalidHob`. */
export const HobInputErrorsLayer = HttpApiMiddleware.layerSchemaErrorTransform(HobInputErrors, (error) => {
  const [first] = formatIssue(error.cause.issue).issues;
  const field = first?.path?.[0];
  return Effect.fail(
    new InvalidHob({
      field: typeof field === "string" ? field : null,
      message: first?.message ?? error.cause.message,
    }),
  );
});

export class HobService extends Context.Service<
  HobService,
  { readonly create: (payload: CreateAgentPayload) => Effect.Effect<Agent, InvalidHob> }
>()("@hobbots/server/HobService") {
  static readonly layer = Layer.effect(
    HobService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventBus;
      const runtime = yield* RuntimeAdapter;

      const create = Effect.fn("HobService.create")(function* (payload: CreateAgentPayload) {
        const invalid = checkBrain(yield* runtime.models, payload);
        if (invalid !== undefined) return yield* invalid;
        const agent = new Agent({
          ...payload,
          id: AgentId.make(crypto.randomUUID()),
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* repo.insertAgent(agent);
        yield* bus.publish({ _tag: "AgentUpserted", agent });
        return agent;
      });

      return HobService.of({ create });
    }),
  );
}
