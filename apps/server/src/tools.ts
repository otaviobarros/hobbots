import { join } from "node:path";
import type { Agent } from "@hobbots/domain";
import { SetupRepository } from "@hobbots/persistence";
import type { ToolAccess } from "@hobbots/runtimes";
import { Context, Effect, Layer } from "effect";
import { Installation } from "./installation.ts";
import { effectiveFolders } from "./permissions.ts";

/**
 * Where runtimes keep each hob's own state when it has tools, beside the data folder rather than in
 * it, since the data folder stays closed to every hob.
 */
export const runtimeFolders = (dataDir: string) => `${dataDir}-runtimes`;

/**
 * What a hob may do with tools on its next turn (ADR 014): the installation's preset and shared
 * folders, the hob's own policy and folders, and Hobbots' data folder, which stays closed. Read at
 * the start of every turn, so a change applies from the next one.
 */
export class HobTools extends Context.Service<
  HobTools,
  { readonly access: (agent: Agent) => Effect.Effect<ToolAccess | null> }
>()("@hobbots/server/HobTools") {
  static readonly layer = Layer.effect(
    HobTools,
    Effect.gen(function* () {
      const setup = yield* SetupRepository;
      const { dataDir } = yield* Installation;
      return HobTools.of({
        access: (agent) =>
          Effect.gen(function* () {
            const { safetyPreset, approvedFolders } = yield* setup.get;
            return {
              policy: {
                preset: safetyPreset,
                sharedFolders: approvedFolders,
                hob: agent.policy,
                dataFolder: dataDir,
                // Threads, Quests and delegations add no restrictions yet.
                restrictions: [],
              },
              folders: yield* effectiveFolders(approvedFolders, agent.policy),
              runtimeFolder: join(runtimeFolders(dataDir), agent.id),
            };
          }).pipe(
            // Without its policy the hob gets no tools: closed, never open.
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not read the hob's policy; the turn is chat-only", cause).pipe(Effect.as(null)),
            ),
          ),
      });
    }),
  );

  /** Every turn chat-only, for hubs and tests that give hobs no tools. */
  static readonly chatOnly = Layer.succeed(HobTools, HobTools.of({ access: () => Effect.succeed(null) }));
}
