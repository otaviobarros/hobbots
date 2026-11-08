import { opendir, realpath, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { FolderChecks } from "@hobbots/agents";
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

/** Whether opening a folder was refused: what macOS's folder privacy and file permissions answer. */
const refused = (error: unknown) =>
  error instanceof Error && "code" in error && (error.code === "EPERM" || error.code === "EACCES");

/** What to do about a folder the hub may not open: on macOS, most often its folder privacy (#1225). */
const refusedAdvice = (isMac: boolean) =>
  isMac
    ? "If macOS asked, allow Hobbots in System Settings › Privacy & Security › Files and Folders, then add the folder again"
    : "Give the user Hobbots runs as permission to read it, then add the folder again";

/**
 * A folder the user is adding, checked as `checkFolder` does and then opened once. On macOS, opening
 * a protected folder such as Documents is what asks whether Hobbots may use it, so the user answers
 * while adding it rather than in the middle of a hob's turn, where the question held the turn and a
 * refusal failed its writes (#1225). A refused folder is not added.
 */
export const checkNewFolder = (
  typed: string,
  home: string = homedir(),
  isMac: boolean = platform() === "darwin",
): Effect.Effect<string, InvalidFolder> =>
  Effect.flatMap(checkFolder(typed, home), (folder) =>
    Effect.tryPromise({
      try: async () => {
        await (await opendir(folder)).close();
        return folder;
      },
      catch: (error) =>
        new InvalidFolder({
          folder: typed,
          message: refused(error)
            ? `Hobbots can't open ${folder}. ${refusedAdvice(isMac)}`
            : `Hobbots can't open ${folder}`,
        }),
    }),
  );

/**
 * The folder a stored path names now: canonical while it is on the hub, else the path as stored.
 * A folder that was missing when it was stored, such as one on an unmounted drive, keeps its
 * spelling; comparing by this identity matches it again once it returns.
 */
const folderIdentity = (folder: string): Effect.Effect<string> =>
  checkFolder(folder).pipe(Effect.orElseSucceed(() => folder));

/** The hub's folder checks, on the filesystem of the machine the server runs on. */
export const NodeFolderChecks = Layer.succeed(FolderChecks, {
  check: (typed) => checkNewFolder(typed),
  identity: folderIdentity,
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
