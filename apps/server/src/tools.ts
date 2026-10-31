import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { type Agent, isNarrowerOrEqual, POLICY_OPERATIONS } from "@hobbots/domain";
import { SetupRepository } from "@hobbots/persistence";
import { operationDecision, type ToolAccess } from "@hobbots/runtimes";
import { Context, Effect, Layer } from "effect";
import { Installation } from "./installation.ts";
import { effectiveFolders } from "./permissions.ts";

/**
 * Where runtimes keep each hob's own state when it has tools, beside the data folder rather than in
 * it, since the data folder stays closed to every hob.
 */
export const runtimeFolders = (dataDir: string) => `${dataDir}-runtimes`;

/** Whether `folder` is `path` or holds it. */
const holds = (folder: string, path: string) =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/**
 * Whether `after` takes away anything `before` gave: a folder, the tools altogether, or an operation
 * whose answer gets narrower. A turn granted `before` must then stop, since its calls and commands
 * already run under what it was given (PE-008).
 */
export const narrows = (before: ToolAccess | null, after: ToolAccess | null): boolean => {
  if (before === null) return false;
  if (after === null || after.policy.dataFolder !== before.policy.dataFolder) return true;
  if (before.folders.some((folder) => !after.folders.includes(folder))) return true;
  return POLICY_OPERATIONS.some((operation) => {
    const was = operationDecision(before.policy, operation);
    const is = operationDecision(after.policy, operation);
    return is !== was && isNarrowerOrEqual(is, was);
  });
};

/**
 * What a hob may do with tools on its next turn (ADR 014): the installation's preset and shared
 * folders, the hob's own policy and folders, and Hobbots' data folder, which stays closed. Read at
 * the start of every turn. A change applies from the next one, and a narrower one also stops the
 * turns already running (see `narrows`).
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
            const folders = yield* effectiveFolders(approvedFolders, agent.policy);
            // A folder that holds every hob's runtime state would open one hob's sessions to another,
            // since the sandbox cannot close that state inside a folder it opens for writing. The turn
            // then gets no folders, so it is chat-only but still resumes the hob's latest session.
            const runtimes = join(realpathSync(dirname(dataDir)), basename(runtimeFolders(dataDir)));
            const holder = folders.find((folder) => holds(folder, runtimes));
            if (holder !== undefined)
              yield* Effect.logWarning(`${holder} holds Hobbots' own state; the turn is chat-only`);
            return {
              policy: {
                preset: safetyPreset,
                sharedFolders: approvedFolders,
                hob: agent.policy,
                dataFolder: dataDir,
                // Threads, Quests and delegations add no restrictions yet.
                restrictions: [],
              },
              folders: holder === undefined ? folders : [],
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
