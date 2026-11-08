import type { FolderChecksShape } from "@hobbots/agents";
import type { AttemptId, Task } from "@hobbots/domain";
import { Effect } from "effect";
import type { PathSeparator } from "./authority.ts";
import type { CallScope } from "./call-scope.ts";
import { parentOf, pathsIn } from "./default-folders.ts";
import type { MissingFile } from "./delivery.ts";

/**
 * Where the user asked a Quest's work to go is theirs to change (#1215). A lead whose member could
 * not write the file where the user asked answered the member's question itself, saved it elsewhere,
 * and completed the Quest as delivered. The hub now holds the lead to every file the user named, and
 * lets one go only on the user's own say: a choice they pick whose consequence, worded by the hub,
 * moves it or leaves it empty, or, for a file the work took away, a deletion they approved.
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
  readonly separator: PathSeparator;
}

/** The consequence of a choice that moves a file the user named to `to` instead, as they pick it. */
const deliveredInstead = (to: string, from: string) => `Not delivered at ${from}: delivered at ${to} instead.`;

/** The consequence of a choice that leaves nothing at a file the user named, as they pick it. */
const leftEmpty = (path: string) => `Not delivered at ${path}: nothing is left there.`;

const INSTEAD = /^Not delivered at (.+): delivered at (.+) instead\.$/;
const EMPTY = /^Not delivered at (.+): nothing is left there\.$/;

/** What the lead is told when a file the user named is not there. */
export const notThere = (task: Task, missing: ReadonlyArray<string>) =>
  `Task ${task.id} is not complete: the user asked for ${missing.join(", ")}, and nothing is there. ` +
  "A file anywhere else is not delivered where they asked. Finish it there, or, if it cannot go there, ask the user with ask, and leave the Quest open until they pick. " +
  "Only a choice the user picks lets the place go, and only with its consequence worded exactly as Hobbots words it: " +
  `"${deliveredInstead("<new absolute path>", "<the path they asked for>")}" for another place, or "${leftEmpty("<the path they asked for>")}" when nothing should be there, ` +
  "offered beside a choice to keep the place they asked for. Never choose another place yourself, nor let a member choose one.";

/**
 * The consequences of the choices the user picked on the Quest's questions: what they decided, in
 * the words they read under the choice. Words they typed decide nothing, however they read.
 */
const picked = (scope: CallScope): ReadonlyArray<string> =>
  scope.tree.questions.flatMap((question) => {
    if (question.answeredBy?._tag !== "User" || question.answer === null) return [];
    const choice = question.options.find((option) => option.label === question.answer);
    return choice === undefined ? [] : [choice.consequence];
  });

/**
 * What the user wrote or picked after asking for the Quest: their answers to its questions, the
 * consequences of the choices they picked, their notes on its Tasks, and the message this turn
 * answers when they sent it while the work ran. A path named there is held to as the request's own are.
 */
const userWordsSince = (scope: CallScope): ReadonlyArray<string> => [
  ...scope.tree.questions.flatMap((question) =>
    question.answeredBy?._tag === "User" && question.answer !== null ? [question.answer] : [],
  ),
  ...picked(scope),
  ...scope.tree.notes.flatMap((note) => (note.senderId === undefined || note.senderId === null ? [note.text] : [])),
  ...(scope.caller.steers === undefined ? [] : [scope.caller.steers]),
];

/**
 * Whether the user let `path` go: they picked a choice whose consequence, worded as Hobbots words it,
 * delivers it at another place instead, which is then held to, or leaves nothing there. A typed
 * answer, a choice to keep it, or a choice worded any other way leaves the lead held to it.
 */
const letGo = (scope: CallScope, path: string) =>
  picked(scope).some((consequence) => {
    const instead = INSTEAD.exec(consequence);
    if (instead !== null) return instead[1] === path && instead[2] !== path;
    return EMPTY.exec(consequence)?.[1] === path;
  });

/** Whether `path`, as the hub stores it, is one of `targets` or inside one. */
const heldBy = (targets: ReadonlyArray<string>, path: string, separator: PathSeparator) =>
  targets.some(
    (target) => target === path || path.startsWith(target.endsWith(separator) ? target : `${target}${separator}`),
  );

/**
 * Whether the work took `missing` away as the user allowed: they approved deleting it in this
 * request's work. A record says only what the work did: a move to another path they named may be
 * the rename they asked for, or the copy they asked for done wrong, and a hob's leave to delete files
 * says nothing of what they asked for. Any other removal keeps the file required until they pick a
 * choice that lets it go.
 */
const removalAllowed = (deps: DestinationDeps, missing: MissingFile, approved: ReadonlyArray<string>) =>
  missing.removed && heldBy(approved, missing.stored, deps.separator);

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
      (path) => !letGo(scope, path),
    );
    const files = yield* Effect.filter(named, (path) => Effect.isFailure(deps.folderChecks.check(path)), {
      concurrency: 8,
    });
    const missing = yield* deps.missingAt(
      files,
      scope.tree.attempts.map((attempt) => attempt.id),
    );
    if (missing.length === 0) return [];
    const approved = missing.some((each) => each.removed) ? yield* deps.approvedRemovals(top) : [];
    return missing.filter((each) => !removalAllowed(deps, each, approved)).map((each) => each.path);
  });
