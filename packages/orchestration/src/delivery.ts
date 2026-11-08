import { HobFiles } from "@hobbots/agents";
import type { ArtifactKind } from "@hobbots/domain";
import { Effect, Option } from "effect";

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

/**
 * Reads, of the absolute paths a user's request names, those where no regular file is now (#1215).
 * A hub that does not read files, as in tests of the tools alone, finds none missing.
 */
export const makeDestinationCheck = Effect.gen(function* () {
  const files = yield* Effect.serviceOption(HobFiles);
  return (paths: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<string>> =>
    Option.isNone(files)
      ? Effect.succeed([])
      : Effect.filter(paths, (path) => Effect.map(files.value.isFile(path), (there) => !there), { concurrency: 8 });
});
