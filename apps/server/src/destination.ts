import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { FolderChecks, HobbotsRepository, InstallationSettings, SaveDestinations } from "@hobbots/agents";
import { InvalidFolder } from "@hobbots/api";
import { Effect, Layer } from "effect";
import { checkFolder } from "./folders.ts";

/**
 * Where the hub may save what you take from it, such as an export or a backup (ADR 026): a folder on
 * the hub, never inside a folder a hob works in, since a hob could read it there.
 */

/** Whether `location` is `folder` or inside it, by spelling: both are canonical. */
const within = (location: string, folder: string) =>
  location === folder || location.startsWith(folder.endsWith(sep) ? folder : `${folder}${sep}`);

/**
 * The folder `typed` names on the hub, canonical, unless it is inside one of `hobFolders`
 * (canonical). `~` is the hub user's home, as for the folders hobs work in.
 */
const checkDestination = (
  typed: string,
  hobFolders: ReadonlyArray<string>,
  home: string = homedir(),
): Effect.Effect<string, InvalidFolder> =>
  Effect.flatMap(checkFolder(typed, home), (canonical) => {
    const inside = hobFolders.find((folder) => within(canonical, folder));
    return inside === undefined
      ? Effect.succeed(canonical)
      : Effect.fail(
          new InvalidFolder({
            folder: typed,
            message: `${canonical} is inside ${inside}, a folder hobs work in. Choose a folder outside it`,
          }),
        );
  });

/**
 * Every folder a hob may work in now, canonical where it is on the hub: the shared folders, each
 * hob's own, retired hobs' included, and the default workspace of a hob without folders.
 */
const hobFolders = (workspaceDir: string) =>
  Effect.gen(function* () {
    const checks = yield* FolderChecks;
    const { approvedFolders } = yield* (yield* InstallationSettings).get;
    const hobs = yield* (yield* HobbotsRepository).listAgentsWithStatus(["active", "paused", "retired"]);
    const every = [...approvedFolders, ...hobs.flatMap((hob) => hob.policy.ownFolders), workspaceDir];
    return [...new Set(yield* Effect.forEach(every, checks.identity))];
  });

/** The hub's save destinations; `workspaceDir` is the default workspace in its data folder. */
export const SaveDestinationsLive = (workspaceDir: string) =>
  Layer.effect(
    SaveDestinations,
    Effect.gen(function* () {
      const context = yield* Effect.context<FolderChecks | InstallationSettings | HobbotsRepository>();
      return SaveDestinations.of({
        check: (typed) =>
          Effect.flatMap(hobFolders(workspaceDir), (folders) => checkDestination(typed, folders)).pipe(
            Effect.provideContext(context),
          ),
      });
    }),
  );

/** Where Hobbots offers to save: the hub user's Downloads folder, or their home folder without one. */
export const defaultSaveFolder = (home: string = homedir()): string => {
  const downloads = join(home, "Downloads");
  return existsSync(downloads) ? downloads : home;
};
