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
 * The folder a stored path names now: canonical while it is on the hub, else the path as stored.
 * A folder that was missing when it was stored, such as one on an unmounted drive, keeps its
 * spelling; comparing by this identity matches it again once it returns.
 */
export const folderIdentity = (folder: string): Effect.Effect<string> =>
  checkFolder(folder).pipe(Effect.orElseSucceed(() => folder));

/** Whether `folder` is one of `among`, by spelling or by the folder each names now. */
export const sameFolderIn = (among: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const identities = new Set([...among, ...(yield* Effect.forEach(among, folderIdentity))]);
    return (folder: string) =>
      Effect.map(folderIdentity(folder), (identity) => identities.has(folder) || identities.has(identity));
  });

/**
 * Stores the shared folders canonical when the hub starts, since folders saved before they were
 * stored canonical may be symlink spellings (ADR 014). A folder missing from the hub keeps its
 * spelling; duplicates are kept once. Hidden folders do not depend on this: they compare by
 * `folderIdentity` whenever they are read, so a later rewrite of a spelling cannot show one again.
 */
export const CanonicalSharedFolders = Layer.effectDiscard(
  Effect.gen(function* () {
    const setup = yield* SetupRepository;
    const { approvedFolders } = yield* setup.get;
    const canonical = [...new Set(yield* Effect.forEach(approvedFolders, folderIdentity))];
    if (canonical.join("\0") !== approvedFolders.join("\0")) {
      yield* setup.update({ approvedFolders: canonical });
    }
  }),
);
