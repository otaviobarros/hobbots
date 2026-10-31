import { realpathSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { effectiveFolders, FolderChecks, HobTools } from "@hobbots/agents";
import { SetupRepository } from "@hobbots/persistence";
import { Effect, Layer } from "effect";
import { Installation } from "./installation.ts";

/**
 * Where runtimes keep each hob's own state when it has tools, beside the data folder rather than in
 * it, since the data folder stays closed to every hob.
 */
export const runtimeFolders = (dataDir: string) => `${dataDir}-runtimes`;

/** Whether `folder` is `path` or holds it. */
const holds = (folder: string, path: string) =>
  path === folder || path.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/** The hub's answer for HobTools: the setup and the hob's policy, read at the start of every turn. */
export const HobToolsLive = Layer.effect(
  HobTools,
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    const folderChecks = yield* FolderChecks;
    const { dataDir } = yield* Installation;
    return HobTools.of({
      access: (agent) =>
        Effect.gen(function* () {
          const { safetyPreset, approvedFolders } = yield* setup.get;
          const folders = yield* effectiveFolders(folderChecks, approvedFolders, agent.policy);
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
