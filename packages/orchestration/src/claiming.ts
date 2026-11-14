import { type ClaimOutcome, ClaimRegister, GitWorkspace, type TaskRepository } from "@hobbots/agents";
import {
  type Claim,
  ClaimId,
  carriedFrom,
  claimBranch,
  claimClashText,
  claimPath,
  claimSubject,
  isSequenceScope,
  isTerminalTask,
  numberLike,
  numbersIn,
  type TaskToolInput,
} from "@hobbots/domain";
import { Effect, Option } from "effect";
import { holds, type PathSeparator } from "./authority.ts";
import { type CallScope, newId, ownTask, refuse } from "./call-scope.ts";
import { makeRepositoryIdentity } from "./taken-writes.ts";

/** What `claim` reads beside the Tasks: the register, the hob's folders and their Git state. */
interface Deps {
  readonly tasks: TaskRepository["Service"];
  readonly folders: (scope: CallScope, task: CallScope["turnTask"]) => Effect.Effect<ReadonlyArray<string>>;
  readonly separator: PathSeparator;
}

type ClaimInput = Omit<TaskToolInput<"claim">, "key">;

/**
 * The folder a claim is in: the one the call names, or the hob's first folder. A named folder is
 * resolved first, every link and `..` taken as the kernel walks it, and must then be one of the
 * hob's folders or inside one, so no spelling reaches a repository outside them.
 */
const folderOf = (
  input: ClaimInput,
  folders: ReadonlyArray<string>,
  separator: PathSeparator,
  realFolder: (folder: string) => Effect.Effect<string | null>,
) =>
  Effect.gen(function* () {
    const named = input.folder?.trim();
    if (named === undefined || named === "") {
      const first = folders[0];
      return first === undefined ? yield* refuse("not-a-repository", "You have no folder to claim in.") : first;
    }
    const real = yield* realFolder(named);
    return real !== null && folders.some((each) => holds(each, real, separator))
      ? real
      : yield* refuse("not-a-repository", `${named} is not one of your folders or inside one.`);
  });

/**
 * Whether `relative`, a path inside the repository whose top is `top`, is in one of the hob's
 * folders. A hob whose folder is part of a larger repository claims only inside its own part.
 */
const insideFolders = (top: string, relative: string, folders: ReadonlyArray<string>, separator: PathSeparator) => {
  const base = top.endsWith(separator) ? top.slice(0, -separator.length) : top;
  const spelled = `${base}${separator}${relative.split("/").join(separator)}`;
  return folders.some((each) => holds(each, spelled, separator));
};

/** A path the call names, as a claim keys it, or a refusal that says what a path must be. */
const pathOf = (field: string, value: string | undefined) => {
  const path = value === undefined ? null : claimPath(value);
  return path === null
    ? refuse(
        "invalid-input",
        `The ${field} is a file or folder relative to the repository's top, such as docs/decisions, never absolute and never climbing out with "..".`,
      )
    : Effect.succeed(path);
};

/** The key a path or branch claim is held by, or null for a number, which the register picks. */
const keyOf = (input: ClaimInput) => {
  if (input.scope === "path") return pathOf("path", input.path);
  if (input.scope !== "branch") return Effect.succeed(null);
  const branch = claimBranch(input.branch ?? "");
  return branch === null
    ? refuse("invalid-input", "A branch's name has no spaces, such as feat/claims.")
    : Effect.succeed(branch);
};

/** What the main branch held in a number's folder: its names, or null when the clone has no such branch. */
type OnMain = ReadonlyArray<string> | null;

/** What the hob is told of its claim: what it holds, and for a number, the number to use. */
const madeText = (claim: Claim, onMain: OnMain, taken: number | null) => {
  if (isSequenceScope(claim.scope)) {
    const names = onMain ?? [];
    const number = numberLike(Number(claim.key), names);
    const instead =
      taken === null
        ? ""
        : ` ${numberLike(taken, names)} is taken, on main or by another Task, so use ${number} instead.`;
    const unread =
      onMain === null
        ? " Hobbots found no main branch in this clone, so it counted only the numbers hobs claimed: check main for a higher one."
        : "";
    return `Your Task holds ${claimSubject(claim)}.${instead} Use ${number}: no other hob, chat or camp gets it.${unread}`;
  }
  return `Your Task holds ${claimSubject(claim)} until it ends.`;
};

/** The call's result: the hob's text, and the claim's details. */
const doneOf = (outcome: ClaimOutcome, onMain: OnMain) => {
  const names = onMain ?? [];
  const clashes = outcome.clashes.length === 0 ? "" : ` ${claimClashText(outcome.claim, outcome.clashes)}`;
  const text =
    outcome._tag === "Held"
      ? `Your Task already holds ${claimSubject(outcome.claim)}, so nothing changed.`
      : madeText(outcome.claim, onMain, outcome.taken);
  return {
    message: `${text}${clashes}`,
    details: {
      claim_id: outcome.claim.id,
      state: outcome.claim.state,
      ...(isSequenceScope(outcome.claim.scope)
        ? { number: numberLike(Number(outcome.claim.key), names) }
        : { key: outcome.claim.key }),
      ...(outcome.clashes.length === 0
        ? {}
        : { clashes_with: outcome.clashes.map((other) => ({ task_id: other.taskId, key: other.key })) }),
    },
  };
};

/**
 * `claim` (ADR 037): records a claim for the Task the hob works on. A number is the next free one in
 * the folder of its repository, read from `main` and from every claim ever made; a path or branch
 * is checked against every other Task's open claim, and on a clash each lead involved hears of it
 * through the backpack, and neither Task is stopped. The repository is known by its `origin`
 * remote, so two clones or worktrees of it share their claims.
 */
export const makeClaiming = (deps: Deps) =>
  Effect.gen(function* () {
    const register = yield* Effect.serviceOption(ClaimRegister);
    const workspace = yield* Effect.serviceOption(GitWorkspace);
    const { tasks, separator } = deps;
    /** Who the repository is across clones, from its top folder. */
    const identityOf = yield* makeRepositoryIdentity(separator);

    /** The claim's own clash item in the turn's backpack, which its result shows it, so the turn carries it (#662). */
    const shownIn = (scope: CallScope, claim: Claim) =>
      Effect.map(
        tasks.readLedger(scope.turnTask.id),
        Option.match({
          onNone: () => [],
          onSome: (ledger) =>
            carriedFrom(ledger, (item) => item.payload._tag === "claim-clash" && item.payload.claim.id === claim.id),
        }),
      );

    const claim = (scope: CallScope, input: ClaimInput) =>
      Effect.gen(function* () {
        if (Option.isNone(register) || Option.isNone(workspace)) {
          return yield* refuse("no-register", "This hub keeps no claims register, so nothing was claimed.");
        }
        const task = yield* ownTask(scope, input.task_id);
        if (isTerminalTask(task.state)) {
          return yield* refuse("task-state", `Task ${task.id} has ended, so it can claim nothing.`);
        }
        const folders = yield* deps.folders(scope, task);
        const folder = yield* folderOf(input, folders, separator, workspace.value.realFolder);
        const top = yield* workspace.value.repository(folder);
        if (top === null) return yield* refuse("not-a-repository", `${folder} is in no Git repository.`);
        const directory = isSequenceScope(input.scope) ? yield* pathOf("directory", input.directory) : null;
        const key = yield* keyOf(input);
        const place = directory ?? (input.scope === "path" ? key : null);
        if (place !== null && !insideFolders(top, place, folders, separator)) {
          return yield* refuse("not-a-repository", `${place} is outside your folders, so you cannot claim it.`);
        }
        const repository = yield* identityOf(top);
        const onMain = directory === null ? [] : yield* workspace.value.namesOnMain(top, directory);
        const committed = yield* register.value.claim({
          id: ClaimId.make(newId()),
          scope: input.scope,
          repository,
          directory,
          key,
          onMain: numbersIn(onMain ?? []),
          asked: input.number ?? null,
          taskId: task.id,
          actor: { kind: "hob", id: scope.caller.agentId },
          at: scope.at,
        });
        const outcome = committed.value;
        return {
          done: doneOf(outcome, onMain),
          entries: committed.entries,
          shown: outcome.clashes.length === 0 ? [] : yield* shownIn(scope, outcome.claim),
        };
      });

    return { claim };
  });
