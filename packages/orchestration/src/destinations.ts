import type { FolderChecksShape } from "@hobbots/agents";
import type { AttemptId, Question, Task, TaskToolInput } from "@hobbots/domain";
import { Effect } from "effect";
import type { PathSeparator } from "./authority.ts";
import type { CallScope } from "./call-scope.ts";
import { parentOf, pathsIn } from "./default-folders.ts";
import type { MissingFile } from "./delivery.ts";
import { DESTINATION_WORDING, EMPTY, INSTEAD } from "./destination-words.ts";

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

/** What the lead is told when a file the user named is not there. */
export const notThere = (task: Task, missing: ReadonlyArray<string>) =>
  `Task ${task.id} is not complete: the user asked for ${missing.join(", ")}, and nothing is there. ` +
  "A file anywhere else is not delivered where they asked. Finish it there, or, if it cannot go there, ask the user with ask, and leave the Quest open until they pick. " +
  `${DESTINATION_WORDING} Never choose another place yourself, nor let a member choose one.`;

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
 * The files the user named: each absolute path that may name a file in the Quest's top Task's brief,
 * which is what the user asked, or in what they wrote since, unless they moved it elsewhere.
 */
const namedByUser = (scope: CallScope, top: Task, separator: PathSeparator) =>
  filePaths([top.brief, ...userWordsSince(scope)], separator).filter((path) => !letGo(scope, path));

/**
 * The files the user named that are not there now: each absolute path that is not a folder in the
 * Quest's top Task's brief, which is what the user asked, or in what they wrote since, unless they
 * moved it elsewhere or allowed the work to take it away. A file the work only reads is there; one it
 * was to write is there only once it was written.
 */
export const missingDestinations = (deps: DestinationDeps, scope: CallScope, top: Task) =>
  Effect.gen(function* () {
    const named = namedByUser(scope, top, deps.separator);
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

/** The request's top Task when it leads a Quest, whose files the user named. */
const questTopOf = (scope: CallScope): Task | undefined => {
  const top = scope.tree.tasks.find((task) => task.parentId === null);
  return top !== undefined && scope.tree.quests.some((quest) => quest.taskId === top.id) ? top : undefined;
};

/** Of `paths`, those that `text` names. */
const namedIn = (text: string, paths: ReadonlyArray<string>, separator: PathSeparator) => {
  const written = new Set(pathsIn(text, separator));
  return paths.filter((path) => written.has(path));
};

/** Whether a choice's consequence is worded as Hobbots words one about `path`: moving it, to it, or leaving it empty. */
const wordedFor = (consequence: string, path: string) => {
  const instead = INSTEAD.exec(consequence);
  return instead !== null ? instead[1] === path || instead[2] === path : EMPTY.exec(consequence)?.[1] === path;
};

/**
 * Why a question with choices about a file the user named, which is not there yet, cannot be asked
 * as it is, or null (#1219). A lead's first such question came before the hub had told it how the
 * choice is worded, so no choice it offered could let the place go, and the one it recommended had
 * the user move the file by hand. Each such file needs a choice worded as Hobbots words it; the
 * question is asked as it is once one is there. A question with no choices, or about anything else,
 * is asked as it is.
 */
export const destinationQuestionProblem = (
  deps: DestinationDeps,
  scope: CallScope,
  input: Pick<TaskToolInput<"ask">, "question" | "options">,
) =>
  Effect.gen(function* () {
    const top = questTopOf(scope);
    const options = input.options ?? [];
    if (top === undefined || options.length === 0) return null;
    const asked = [input.question, ...options.flatMap((option) => [option.label, option.consequence])].join("\n");
    const named = namedIn(asked, namedByUser(scope, top, deps.separator), deps.separator);
    if (named.length === 0) return null;
    const missing = yield* missingDestinations(deps, scope, top);
    const unworded = missing.filter(
      (path) => named.includes(path) && !options.some((option) => wordedFor(option.consequence, path)),
    );
    return unworded.length === 0
      ? null
      : `The user asked for ${unworded.join(", ")}, and nothing is there yet, so no choice you offer lets that place go unless it is worded as Hobbots words it. ${DESTINATION_WORDING} Ask again with those choices.`;
  });

/**
 * Why a lead's answer to a member's question about a file the user named cannot go back as it is, or
 * null (#1219). After the user redirected the work, a lead answered its member's next question about
 * it with a place of its own instead of passing their answer on. A lead that answers a question
 * naming such a file with another absolute path is refused, unless its answer gives the user's own
 * words; it may still pass the question up with escalate.
 */
export const destinationAnswerProblem = (
  scope: CallScope,
  question: Question,
  answer: string,
  separator: PathSeparator,
) => {
  const top = questTopOf(scope);
  if (top === undefined) return null;
  const named = namedByUser(scope, top, separator);
  const about = namedIn(question.text, named, separator);
  if (about.length === 0) return null;
  const said = userWordsSince(scope);
  if (said.some((words) => words.trim().length > 0 && answer.includes(words.trim()))) return null;
  const elsewhere = filePaths([answer], separator).filter(
    (path) => !named.some((each) => each === path || heldBy([each], path, separator)),
  );
  if (elsewhere.length === 0) return null;
  const theirs = said.length === 0 ? "" : ` The user has said: ${said.map((words) => `"${words}"`).join(", ")}.`;
  return (
    `The question is about ${about.join(", ")}, which the user asked for, and your answer puts the work at ${elsewhere.join(", ")} instead. ` +
    `Where the user's work goes is theirs to change.${theirs} Pass their answer on in their own words, or pass the question up with escalate; never choose another place yourself.`
  );
};
