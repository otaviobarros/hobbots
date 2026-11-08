import { ActivityRepository, FolderChecks, HobFiles } from "@hobbots/agents";
import type { ArtifactKind, AttemptId, FileChange } from "@hobbots/domain";
import { Effect, Option } from "effect";
import type { PathSeparator } from "./authority.ts";
import { parentOf } from "./default-folders.ts";

/**
 * Whether the files a Task returns are there for whoever reads its result. `complete_task` once
 * took any path a hob named, so a hob could attach a page it wrote in its turn's own temporary
 * folder, which the hub removes when the turn ends, or a file outside its folders, which no one may
 * open from the Workbench or copy in an export. Its Task then read done while the file it delivered
 * was gone. A file artifact must be a regular file inside the Task's folders when the Task
 * completes, or the completion is refused with where to put it. Links and text are not checked.
 * The check runs in the hub, so it holds for every runtime.
 */

/** An artifact as `complete_task` takes it. */
interface Returned {
  readonly kind: ArtifactKind;
  readonly label: string;
  readonly value: string;
}

/** Why one file artifact cannot be delivered, in words the hob can act on. */
const unreachable = (artifact: Returned, why: "outside" | "missing") =>
  why === "outside"
    ? `"${artifact.label}" is at ${artifact.value}, outside this Task's folders, so no one can open it once the Task completes. Your turn's temporary folder ($TMPDIR) is removed when the turn ends.`
    : `"${artifact.label}" is not a file at ${artifact.value}.`;

/** What a hob is told to do instead, given the folders it may write in. */
const instead = (folders: ReadonlyArray<string>) => {
  const where = folders.length === 0 ? "" : ` (${folders.join(", ")})`;
  return (
    `Save each file inside one of your folders${where} and attach that path, or return it as kind "text". ` +
    "If the file has to go where you cannot write, report a blocker with report_checkpoint that says so, rather than complete the Task."
  );
};

/**
 * Reads, for a completion, the file artifacts no one could open afterwards. A hub that does not
 * read the hob's folders, as in tests of the tools alone, checks nothing.
 */
export const makeDeliveryCheck = Effect.gen(function* () {
  const files = yield* Effect.serviceOption(HobFiles);
  return (folders: ReadonlyArray<string>, artifacts: ReadonlyArray<Returned>): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      if (Option.isNone(files)) return null;
      const problems: Array<string> = [];
      for (const artifact of artifacts) {
        if (artifact.kind !== "file") continue;
        const placed = yield* files.value.place(folders, artifact.value);
        if (Option.isNone(placed)) {
          problems.push(unreachable(artifact, "outside"));
          continue;
        }
        const found = yield* files.value.look(placed.value.folder, placed.value.path);
        if (Option.isNone(found)) problems.push(unreachable(artifact, "missing"));
      }
      return problems.length === 0 ? null : `${problems.join(" ")} ${instead(folders)}`;
    });
});

/** Where a change took a file away from, as an absolute path on a hub that divides at `separator`. */
const removedFrom = (change: FileChange, separator: PathSeparator): ReadonlyArray<string> => {
  const from = change.kind === "moved" ? change.movedFrom : change.kind === "deleted" ? change.path : null;
  if (from === null) return [];
  const folder = change.folder.endsWith(separator) ? change.folder : `${change.folder}${separator}`;
  return [`${folder}${from.split("/").join(separator)}`];
};

/**
 * Reads, of the absolute paths the user named, those where no regular file is now and that the
 * work did not take away (#1215). A file the work deleted or moved, as a request to remove or rename
 * it asks, is gone because the work was done, so it is not missing: the Workbench's records of the
 * Attempts given say so, compared by the folder the path sits in as the hub stores it. A hub that
 * does not read files, as in tests of the tools alone, finds none missing; one that keeps no
 * Workbench records finds none taken away.
 */
export const makeDestinationCheck = (separator: PathSeparator) =>
  Effect.gen(function* () {
    const files = yield* Effect.serviceOption(HobFiles);
    const activity = yield* Effect.serviceOption(ActivityRepository);
    const checks = yield* FolderChecks;
    const removedIn = (attempts: ReadonlyArray<AttemptId>) =>
      Option.isNone(activity) || attempts.length === 0
        ? Effect.succeed(new Set<string>())
        : Effect.map(
            activity.value.readMany(attempts),
            (read) => new Set(read.flatMap((each) => each.changes.flatMap((change) => removedFrom(change, separator)))),
          );
    /** The path as the hub stores its folder, which a file that is gone still sits in. */
    const stored = (path: string) => {
      const parent = parentOf(path, separator);
      if (parent === null) return Effect.succeed(path);
      const name = path.slice(path.lastIndexOf(separator) + separator.length);
      return checks.check(parent).pipe(
        Effect.map((folder) => `${folder.endsWith(separator) ? folder : `${folder}${separator}`}${name}`),
        Effect.orElseSucceed(() => path),
      );
    };
    return (paths: ReadonlyArray<string>, attempts: ReadonlyArray<AttemptId>): Effect.Effect<ReadonlyArray<string>> =>
      Effect.gen(function* () {
        if (Option.isNone(files)) return [];
        const missing = yield* Effect.filter(paths, (path) => Effect.map(files.value.isFile(path), (there) => !there), {
          concurrency: 8,
        });
        if (missing.length === 0) return [];
        const removed = yield* removedIn(attempts);
        return yield* Effect.filter(missing, (path) => Effect.map(stored(path), (at) => !removed.has(at)));
      });
  });
