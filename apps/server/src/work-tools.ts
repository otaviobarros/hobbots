import { makeWorkTools, WorkTools } from "@hobbots/agents";
import { decideHubCall, PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer } from "effect";

/**
 * The Quest tools a chat turn offers, `start_work` and `finish_work` (ADR 041), served on the hub
 * beside the memory and skill tools on every runtime that serves hub tools. Each `start_work` call is
 * decided under the hob's Start a Quest answer with its live grants, as every hub tool's call is.
 */
export const WorkToolsLive = Layer.effect(
  WorkTools,
  Effect.gen(function* () {
    const engine = yield* PolicyEngine;
    return yield* makeWorkTools((approvals, base, request) => decideHubCall(engine, approvals, base, request));
  }),
).pipe(Layer.provide(PolicyEngine.node));
