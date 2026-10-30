import {
  AgentNotFound,
  type CreateAgentPayload,
  HobInputErrors,
  InvalidHob,
  type UpdateAgentPayload,
} from "@hobbots/api";
import { Agent, AgentId, type Effort, type RuntimeModels } from "@hobbots/domain";
import { HobbotsRepository } from "@hobbots/persistence";
import { RuntimeAdapter } from "@hobbots/runtimes";
import { Context, DateTime, Effect, Layer, Option, SchemaIssue } from "effect";
import { HttpApiMiddleware } from "effect/http-api";
import { HobAdmission } from "./admission.ts";
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

/** The first failing field of a create or edit request, as `InvalidHob`. */
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

const editableFields = [
  "craft",
  "lookSeed",
  "lookColor",
  "model",
  "effort",
  "instructions",
] as const satisfies ReadonlyArray<keyof UpdateAgentPayload & keyof Agent>;

export class HobService extends Context.Service<
  HobService,
  {
    readonly create: (payload: CreateAgentPayload) => Effect.Effect<Agent, InvalidHob>;
    /** Applies an edit as the hob's next configuration version; an edit that changes nothing adds none. */
    readonly update: (id: AgentId, payload: UpdateAgentPayload) => Effect.Effect<Agent, InvalidHob | AgentNotFound>;
  }
>()("@hobbots/server/HobService") {
  static readonly layer = Layer.effect(
    HobService,
    Effect.gen(function* () {
      const repo = yield* HobbotsRepository;
      const bus = yield* EventBus;
      const runtime = yield* RuntimeAdapter;
      const admission = yield* HobAdmission;

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
        const agent = new Agent({
          ...fields,
          id,
          configVersion: 1,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        if (!(yield* repo.insertAgent(agent))) {
          // A concurrent request with the same id inserted first.
          const raced = yield* repo.findAgent(id).pipe(Effect.map(Option.getOrThrow));
          return yield* retried(raced, payload);
        }
        yield* bus.publish({ _tag: "AgentUpserted", agent });
        return agent;
      });

      const update = Effect.fn("HobService.update")(function* (id: AgentId, payload: UpdateAgentPayload) {
        // Under the hob's lock, so the event carries the status the hob has when the edit is
        // stored: a retirement publishes after it and a stale edit cannot re-list a retired hob.
        return yield* admission.withHob(
          id,
          Effect.gen(function* () {
            // Another edit may land between reading the hob and storing the next version; then the
            // edit applies again on top of that one, so both survive.
            while (true) {
              const current = yield* repo.findAgent(id);
              if (Option.isNone(current)) return yield* new AgentNotFound({ agentId: id });
              const agent = current.value;
              if (editableFields.every((field) => payload[field] === undefined || payload[field] === agent[field])) {
                return agent;
              }
              // A brain left as it was stays valid even if the runtime stopped offering it.
              if (payload.model !== undefined || payload.effort !== undefined) {
                const invalid = checkBrain(yield* runtime.models, {
                  model: payload.model === undefined ? agent.model : payload.model,
                  effort: payload.effort === undefined ? agent.effort : payload.effort,
                });
                if (invalid !== undefined) return yield* invalid;
              }
              const next = new Agent({ ...agent, ...payload, configVersion: agent.configVersion + 1 });
              if (yield* repo.updateAgentConfig(next)) {
                yield* bus.publish({ _tag: "AgentUpserted", agent: next });
                return next;
              }
            }
          }),
        );
      });

      return HobService.of({ create, update });
    }),
  );
}
