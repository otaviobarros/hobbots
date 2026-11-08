import { DirectoryTools, HobDirectory, makeDirectoryTools } from "@hobbots/agents";
import { decideHubCall, PolicyEngine } from "@hobbots/permissions";
import { Effect, Layer } from "effect";

/**
 * `read_hob` (ADR 032) over the directory in context, served on the hub beside the memory and skill
 * tools on every runtime that serves hub tools. Each call is decided under the hob's Read other hobs
 * answer with its live grants, as every hub tool's call is.
 */
export const DirectoryReadTools = Layer.effect(
  DirectoryTools,
  Effect.gen(function* () {
    const engine = yield* PolicyEngine;
    return yield* makeDirectoryTools((approvals, base, request) => decideHubCall(engine, approvals, base, request));
  }),
).pipe(Layer.provide(PolicyEngine.node));

/**
 * The hob directory and its `read_hob` tool. The directory reads the Charms the hub holds, so it is
 * provided where they are.
 */
export const DirectoryToolsLive = DirectoryReadTools.pipe(Layer.provideMerge(HobDirectory.layer));
