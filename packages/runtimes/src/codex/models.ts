import { Effort, RuntimeModel, RuntimeModels } from "@hobbots/domain";
import { Effect, Schema } from "effect";
import type { AppServer } from "./app-server.ts";
import type { Model, ModelListResponse } from "./protocol.ts";

const isEffort = Schema.is(Effort);

/**
 * The efforts Hobbots offers for a Codex model: those it lists that Hobbots knows. `ultra` starts
 * Codex's own sub-agents, which Hobbots turns off (ADR 024), so it is never offered.
 */
export const codexEfforts = (model: Model): ReadonlyArray<Effort> =>
  model.supportedReasoningEfforts
    .map((option) => option.reasoningEffort)
    .filter((effort) => effort !== "ultra")
    .filter(isEffort);

/** Codex's model list in Hobbots' shape: the models it does not hide, in its order. */
export const toCodexModels = (models: ReadonlyArray<Model>): RuntimeModels =>
  new RuntimeModels({
    runtime: "codex",
    source: "runtime",
    models: models
      .filter((model) => !model.hidden)
      .map(
        (model) =>
          new RuntimeModel({
            id: model.model,
            displayName: model.displayName,
            description: model.description,
            efforts: codexEfforts(model),
            main: true,
          }),
      ),
  });

/** Offered while Codex cannot list its models, such as before it is installed: none. */
export const codexFallbackModels = new RuntimeModels({ runtime: "codex", source: "fallback", models: [] });

// Codex answered with a single page in the probe; this bounds a list that never ends.
const MAX_PAGES = 20;

/** Every page of `model/list`. Codex lists its built-in catalog even while signed out. */
export const listModels = (server: AppServer) =>
  Effect.gen(function* () {
    const models: Array<Model> = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response: ModelListResponse = yield* server.request("model/list", { cursor, includeHidden: false });
      models.push(...response.data);
      cursor = response.nextCursor;
      if (cursor === null) break;
    }
    return models;
  });
