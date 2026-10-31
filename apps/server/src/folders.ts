import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { InvalidFolder } from "@hobbots/api";
import { SetupRepository } from "@hobbots/persistence";
import { Effect, Layer } from "effect";

/**
 * A folder the user lets hobs work in, as the hub stores it: `~` expanded to the hub user's home,
 * then canonical, with every symlink resolved and, on a case-insensitive volume, the case the volume
 * stores (ADR 014). Only an existing folder on the hub is accepted, since hobs always work on the
 * hub (ADR 010), whichever device the path was typed on.
 */
export const checkFolder = (typed: string, home: string = homedir()): Effect.Effect<string, InvalidFolder> => {
  const trimmed = typed.trim();
  const expanded = trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  if (!isAbsolute(expanded)) {
    return Effect.fail(
      new InvalidFolder({ folder: typed, message: `"${typed}" is not a full path. Start it with / or ~/` }),
    );
  }
  const folder = resolve(expanded);
  return Effect.tryPromise({
    try: async () => {
      const canonical = await realpath(folder);
      return { canonical, info: await stat(canonical) };
    },
    catch: () => new InvalidFolder({ folder: typed, message: `There is no folder at ${folder} on this hub` }),
  }).pipe(
    Effect.flatMap(({ canonical, info }) =>
      info.isDirectory()
        ? Effect.succeed(canonical)
        : Effect.fail(new InvalidFolder({ folder: typed, message: `${folder} is a file, not a folder` })),
    ),
  );
};

/**
 * Stores the shared folders canonical when the hub starts. Folders saved before they were stored
 * canonical may be symlink spellings; a hob's hidden folders compare by the canonical form, so
 * without this a later save of the unchanged setup would rewrite a hidden folder's spelling and
 * show it again (ADR 014). A folder missing from the hub keeps its spelling; duplicates are kept once.
 */
export const CanonicalSharedFolders = Layer.effectDiscard(
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    const { approvedFolders } = yield* setup.get;
    const canonical = [
      ...new Set(
        yield* Effect.forEach(approvedFolders, (folder) =>
          checkFolder(folder).pipe(Effect.orElseSucceed(() => folder)),
        ),
      ),
    ];
    if (canonical.join("\0") !== approvedFolders.join("\0")) {
      yield* setup.update({ approvedFolders: canonical });
    }
  }),
);
