import { ActivityRepository, ApprovalRepository, FolderChecks, HobFiles } from "@hobbots/agents";
import type { ArtifactKind, AttemptId, FileChange, Task } from "@hobbots/domain";
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
    "If the file has to go where you cannot write, report a blocker with report_checkpoint that says so, rather than complete the Task. " +
    // A lead's summary once said a refused file "succeeded" (#1219): a summary says what Hobbots kept.
    "A file Hobbots refused is not delivered: never call it a success. Your summary names the files you attach as they are, and says the refused one was not kept there."
  );
};

/**
 * What a completion keeps: why its file artifacts could not be opened afterwards, or null, and each
 * artifact's value as the Task's result stores it. A file is kept at its canonical place in the hob's
 * folders, the folder and path joined, so every record of it names it one way (#1434): a Task that
 * returned `social.md` and the Attempt that wrote it in its folder are one artifact.
 */
export interface Delivery {
  readonly refused: string | null;
  readonly values: ReadonlyArray<string>;
}

/** A canonical folder and a path inside it with `/`, as one absolute path. */
const placedAt = (at: { readonly folder: string; readonly path: string }) =>
  `${at.folder.endsWith("/") ? at.folder : `${at.folder}/`}${at.path}`;

/**
 * Reads, for a completion, the file artifacts no one could open afterwards, and where each one it
 * keeps is. A hub that does not read the hob's folders, as in tests of the tools alone, checks
 * nothing and keeps each value as given.
 */
export const makeDeliveryCheck = Effect.gen(function* () {
  const files = yield* Effect.serviceOption(HobFiles);
  return (folders: ReadonlyArray<string>, artifacts: ReadonlyArray<Returned>): Effect.Effect<Delivery> =>
    Effect.gen(function* () {
      const values = artifacts.map((artifact) => artifact.value);
      if (Option.isNone(files)) return { refused: null, values };
      const problems: Array<string> = [];
      for (const [index, artifact] of artifacts.entries()) {
        if (artifact.kind !== "file") continue;
        const placed = yield* files.value.place(folders, artifact.value);
        if (Option.isNone(placed)) {
          problems.push(unreachable(artifact, "outside"));
          continue;
        }
        const found = yield* files.value.look(placed.value.folder, placed.value.path);
        if (Option.isNone(found)) problems.push(unreachable(artifact, "missing"));
        values[index] = placedAt(placed.value);
      }
      return { refused: problems.length === 0 ? null : `${problems.join(" ")} ${instead(folders)}`, values };
    });
});

/** A file the user named that is not there now, and whether the work took it away. */
export interface MissingFile {
  readonly path: string;
  /** The path as the hub stores it: its folder canonical, as approvals and the Workbench name it. */
  readonly stored: string;
  /** Whether the Workbench recorded the work deleting it or moving it away. */
  readonly removed: boolean;
}

/** An absolute path on a hub that divides at `separator`, from a folder and a path inside it with `/`. */
const inFolder = (folder: string, path: string, separator: PathSeparator) =>
  `${folder.endsWith(separator) ? folder : `${folder}${separator}`}${path.split("/").join(separator)}`;

/** Where a change took a file away from, as an absolute path: a deleted file, or a moved file's old place. */
const removedFrom = (change: FileChange, separator: PathSeparator): ReadonlyArray<string> => {
  if (change.kind === "deleted") return [inFolder(change.folder, change.path, separator)];
  if (change.kind === "moved" && change.movedFrom !== null)
    return [inFolder(change.folder, change.movedFrom, separator)];
  return [];
};

/**
 * Reads, of the absolute paths the user named, those where no regular file is now (#1215), each with
 * whether the Workbench recorded the Attempts given deleting it or moving it away. Whether the user
 * allowed that is the caller's to decide, since a record says only what the work did: a move to a
 * path the user also named may be the rename they asked for, or the copy they asked for done wrong. Paths compare by the folder
 * they sit in as the hub stores it, which a file that is gone still sits in. A hub that does not read
 * files, as in tests of the tools alone, finds none missing; one that keeps no Workbench records
 * finds none taken away.
 */
export const makeDestinationCheck = (separator: PathSeparator) =>
  Effect.gen(function* () {
    const files = yield* Effect.serviceOption(HobFiles);
    const activity = yield* Effect.serviceOption(ActivityRepository);
    const checks = yield* FolderChecks;
    const removalsIn = (attempts: ReadonlyArray<AttemptId>) =>
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
        Effect.map((folder) => inFolder(folder, name, separator)),
        Effect.orElseSucceed(() => path),
      );
    };
    return (
      paths: ReadonlyArray<string>,
      attempts: ReadonlyArray<AttemptId>,
    ): Effect.Effect<ReadonlyArray<MissingFile>> =>
      Effect.gen(function* () {
        if (Option.isNone(files)) return [];
        const missing = yield* Effect.filter(paths, (path) => Effect.map(files.value.isFile(path), (there) => !there), {
          concurrency: 8,
        });
        if (missing.length === 0) return [];
        const removals = yield* removalsIn(attempts);
        return yield* Effect.forEach(missing, (path) =>
          Effect.map(stored(path), (at): MissingFile => ({ path, stored: at, removed: removals.has(at) })),
        );
      });
  });

/**
 * What the user approved deleting in a request's work (#1215): the targets of each delete-files
 * request in its thread, from that request, that they approved. A hub that keeps no approvals has none.
 */
export const makeApprovedRemovals = Effect.gen(function* () {
  const approvals = yield* Effect.serviceOption(ApprovalRepository);
  return (top: Task): Effect.Effect<ReadonlyArray<string>> =>
    Option.isNone(approvals) || top.threadId === null
      ? Effect.succeed([])
      : Effect.map(approvals.value.listForThread(top.threadId), (all) =>
          all.flatMap((each) =>
            each.rootTaskId === top.id && each.state === "approved" && each.operation === "delete-files"
              ? each.targets
              : [],
          ),
        );
});
