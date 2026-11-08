import type { FolderChecksShape } from "@hobbots/agents";
import type { AttemptId, Task, TaskId } from "@hobbots/domain";
import { Effect } from "effect";
import type { Authority, PathSeparator } from "./authority.ts";
import type { CallScope } from "./call-scope.ts";
import { parentOf, pathsIn } from "./default-folders.ts";
import type { MissingFile } from "./delivery.ts";

/**
 * Where the user asked a Quest's work to go is theirs to change (#1215). A lead whose member could
 * not write the file where the user asked answered the member's question itself, saved it elsewhere,
 * and completed the Quest as delivered. The hub now holds the lead to every file the user named, and
 * lets one go only on the user's own say: an answer that names where it goes instead, or, for a file
 * the work took away, a removal the user allowed.
 */

export interface DestinationDeps {
  /** Of the paths given, those with no regular file now, with what took each away (see `delivery.ts`). */
  readonly missingAt: (
    paths: ReadonlyArray<string>,
    attempts: ReadonlyArray<AttemptId>,
  ) => Effect.Effect<ReadonlyArray<MissingFile>>;
  /** What the user approved deleting in the request's work: the targets of each approved delete-files request. */
  readonly approvedRemovals: (top: Task) => Effect.Effect<ReadonlyArray<string>>;
  readonly folderChecks: FolderChecksShape;
  readonly authority: (scope: CallScope, task: Task) => Effect.Effect<Authority>;
  readonly separator: PathSeparator;
}

/** What the lead is told when a file the user named is not there. */
export const notThere = (task: Task, missing: ReadonlyArray<string>) =>
  `Task ${task.id} is not complete: the user asked for ${missing.join(", ")}, and nothing is there. ` +
  "A file anywhere else is not delivered where they asked. Finish it there, or, if it cannot go there, ask the user with ask where it should go instead, " +
  `naming ${missing.length === 1 ? "that path" : "those paths"} in the question and offering each place as a choice with its full path, ` +
  "and leave the Quest open until they answer. Never choose another place yourself, nor let a member choose one.";

/**
 * What the user wrote after asking for the Quest: their answers to its questions, their notes on its
 * Tasks, and the message this turn answers when they sent it while the work ran. A path they name
 * there, such as where to save the file instead, is held to as the request's own are.
 */
const userWordsSince = (scope: CallScope): ReadonlyArray<string> => [
  ...scope.tree.questions.flatMap((question) =>
    question.answeredBy?._tag === "User" && question.answer !== null ? [question.answer] : [],
  ),
  ...scope.tree.notes.flatMap((note) => (note.senderId === undefined || note.senderId === null ? [note.text] : [])),
  ...(scope.caller.steers === undefined ? [] : [scope.caller.steers]),
];

/**
 * Whether the user moved `path` somewhere else: they answered a question that named it with an
 * answer that names another place and not `path` itself. "No, keep it there" names no other place,
 * and "Keep it at `path`" names it, so neither lets it go; the place the answer names is then held
 * to in its stead.
 */
const replacedBy = (scope: CallScope, path: string, separator: PathSeparator) =>
  scope.tree.questions.some(
    (question) =>
      question.answeredBy?._tag === "User" &&
      question.answer !== null &&
      question.text.includes(path) &&
      !question.answer.includes(path) &&
      pathsIn(question.answer, separator).some((other) => other !== path),
  );

/** Whether `path`, as the hub stores it, is one of `targets` or inside one. */
const heldBy = (targets: ReadonlyArray<string>, path: string, separator: PathSeparator) =>
  targets.some(
    (target) => target === path || path.startsWith(target.endsWith(separator) ? target : `${target}${separator}`),
  );

/**
 * Whether the user allowed the work to take `missing` away: it moved it to another path they named,
 * as "rename A to B" asks; they approved deleting it in this request's work; or the hob that did it
 * may delete files without asking, as their safety preset or its override says. A record says only
 * what the work did, so a removal with none of these keeps the file required.
 */
const removalAllowed = (
  deps: DestinationDeps,
  scope: CallScope,
  missing: MissingFile,
  approved: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const removed = missing.removed;
    if (removed === null) return false;
    if (removed.toNamed || heldBy(approved, missing.stored, deps.separator)) return true;
    const by = scope.tree.tasks.find((each) => each.id === (removed.taskId as TaskId));
    if (by === undefined) return false;
    return (yield* deps.authority(scope, by)).decisions["delete-files"] === "allow";
  });

/** The absolute paths in `texts` that may name a file: not a folder's spelling, and not right under the root. */
const filePaths = (texts: ReadonlyArray<string>, separator: PathSeparator) =>
  [...new Set(texts.flatMap((text) => pathsIn(text, separator)))].filter(
    // A name right under the root, such as the `/p` of a closing `</p>` tag, is not taken for a file.
    (path) => !path.endsWith(separator) && parentOf(path, separator) !== null,
  );

/**
 * The files the user named that are not there now: each absolute path that is not a folder in the
 * Quest's top Task's brief, which is what the user asked, or in what they wrote since, unless they
 * moved it elsewhere or allowed the work to take it away. A file the work only reads is there; one it
 * was to write is there only once it was written.
 */
export const missingDestinations = (deps: DestinationDeps, scope: CallScope, top: Task) =>
  Effect.gen(function* () {
    const named = filePaths([top.brief, ...userWordsSince(scope)], deps.separator).filter(
      (path) => !replacedBy(scope, path, deps.separator),
    );
    const files = yield* Effect.filter(named, (path) => Effect.isFailure(deps.folderChecks.check(path)), {
      concurrency: 8,
    });
    const missing = yield* deps.missingAt(
      files,
      scope.tree.attempts.map((attempt) => attempt.id),
    );
    if (missing.length === 0) return [];
    const approved = missing.some((each) => each.removed !== null) ? yield* deps.approvedRemovals(top) : [];
    const kept = yield* Effect.filter(missing, (each) =>
      Effect.map(removalAllowed(deps, scope, each, approved), (allowed) => !allowed),
    );
    return kept.map((each) => each.path);
  });
