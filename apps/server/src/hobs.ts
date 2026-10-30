import { type CreateAgentPayload, HobInputErrors, InvalidHob } from "@hobbots/api";
import { Agent, AgentId, type Effort, type RuntimeModels } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { RuntimeAdapter } from "@hobbots/runtimes";
import { Context, DateTime, Effect, Layer, Option, SchemaIssue } from "effect";
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

const createdFields = [
  "name",
  "craft",
  "lookSeed",
  "lookColor",
  "runtime",
  "model",
  "effort",
  "instructions",
] as const satisfies ReadonlyArray<keyof CreateAgentPayload & keyof Agent>;

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

      // A retry carries the same id and fields; the same id with other fields is another hob.
      const retried = (existing: Agent, payload: CreateAgentPayload) =>
        createdFields.every((field) => existing[field] === payload[field])
          ? Effect.succeed(existing)
          : Effect.fail(new InvalidHob({ field: "id", message: "Another hob already has this id" }));

      const create = Effect.fn("HobService.create")(function* (payload: CreateAgentPayload) {
        const { id = AgentId.make(crypto.randomUUID()), ...fields } = payload;
        // Reconcile first, so a retry succeeds even if the runtime's model list changed since.
        const earlier = Option.getOrUndefined(yield* repo.findAgent(id));
        if (earlier !== undefined) return yield* retried(earlier, payload);
        const invalid = checkBrain(yield* runtime.models, payload);
        if (invalid !== undefined) return yield* invalid;
        const agent = new Agent({ ...fields, id, createdAt: DateTime.formatIso(yield* DateTime.now) });
        if (!(yield* repo.insertAgent(agent))) {
          // A concurrent request with the same id inserted first.
          const raced = yield* repo.findAgent(id).pipe(Effect.map(Option.getOrThrow));
          return yield* retried(raced, payload);
        }
        yield* bus.publish({ _tag: "AgentUpserted", agent });
        return agent;
      });

      return HobService.of({ create });
    }),
  );
}
