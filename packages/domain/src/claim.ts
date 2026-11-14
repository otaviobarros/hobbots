import { Schema } from "effect";
import { Actor } from "./actor.ts";
import { AgentId, ThreadId } from "./ids.ts";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";
import { TaskId } from "./task.ts";

/**
 * The claims register (ADR 037, The hub coordinates across every chat and camp). A hob claims the
 * next number in a folder, such as a migration's or an ADR's, a path or a branch with `claim`, and
 * the hub records it for the Task it works on. The hub hands out each number once across every hob, chat and camp, and watches paths
 * and branches for clashes. Every rule here is pure and calls no model.
 */

export const ClaimId = Schema.String.pipe(Schema.brand("ClaimId"));
export type ClaimId = typeof ClaimId.Type;

/**
 * What a claim is on. `sequence` is the next number in one folder of a repository whose files start
 * with one, such as its migrations, its ADRs or its invoices; `path` is a file or a folder; `branch`
 * is a branch name.
 */
export const ClaimScope = Schema.Literals(["sequence", "path", "branch"]);
export type ClaimScope = typeof ClaimScope.Type;

/** Whether a scope is a number the hub hands out, rather than a name it watches. */
export const isSequenceScope = (scope: ClaimScope): boolean => scope === "sequence";

/** Where a claim stands, held by `ClaimMachine`. */
export const ClaimState = Schema.Literals(["held", "contested", "taken", "released"]);
export type ClaimState = typeof ClaimState.Type;

export class Claim extends Schema.Class<Claim>("Claim")({
  id: ClaimId,
  scope: ClaimScope,
  /** Who the repository is across clones and worktrees: its normalized `origin` remote, or its folder's name. */
  repository: Schema.String,
  /** For a number, the folder inside the repository whose files the numbers count, with `/` between names; null otherwise. */
  directory: Schema.NullOr(Schema.String),
  /** The number in decimal, the path inside the repository with `/` between names, or the branch's name. */
  key: Schema.String,
  /** The Task that holds the claim; the claim is released when the Task ends. */
  taskId: TaskId,
  actor: Actor,
  /** Only `ClaimMachine` changes it, and code outside reads it through `Claims`. */
  state: ClaimState,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  releasedAt: Schema.NullOr(Schema.String),
  revision: Revision,
}) {}

/** What can happen to a claim. */
export type ClaimEvent =
  | { readonly _tag: "Contest"; readonly at: string }
  | { readonly _tag: "Clear"; readonly at: string }
  | { readonly _tag: "Release"; readonly at: string }
  /** You took over the claim's Task (#1449): the claim is yours, and its hob may not write to it. */
  | { readonly _tag: "TakeOver"; readonly at: string; readonly by: Actor };

/** A change to a claim its state does not allow. */
export class IllegalClaimTransition extends Schema.TaggedError<IllegalClaimTransition>()("IllegalClaimTransition", {
  claimId: ClaimId,
  from: ClaimState,
  to: ClaimState,
}) {}

/**
 * A claim's lifecycle (ADR 037), declared once. A number is never contested, since the hub hands
 * each one out once. A released claim stays released: its number is never handed out again.
 */
export const ClaimMachine = defineMachine<ClaimState, ClaimEvent, Claim, IllegalClaimTransition>({
  name: "Claim",
  states: {
    held: "The Task holds it, and no other open claim clashes with it",
    contested: "Another Task's open claim on the same path or branch clashes with it; neither Task is stopped",
    taken:
      "You took it over from its Task: it is yours, and the hub refuses its hob's writes to it until the Task ends",
    released: "Its Task ended; a released number is never handed out again",
  },
  field: "state",
  events: {
    // Only a path or a branch is watched for clashes.
    Contest: {
      from: ["held"],
      to: "contested",
      guard: (claim) => !isSequenceScope(claim.scope),
      apply: (claim, e) => new Claim({ ...claim, state: "contested", updatedAt: e.at }),
    },
    // The last claim it clashed with was released.
    Clear: {
      from: ["contested"],
      to: "held",
      apply: (claim, e) => new Claim({ ...claim, state: "held", updatedAt: e.at }),
    },
    // Only you take a claim over, and it moves to you as it stands, contested or not.
    TakeOver: {
      from: ["held", "contested"],
      to: "taken",
      guard: (_claim, e) => e.by.kind === "user",
      apply: (claim, e) => new Claim({ ...claim, state: "taken", actor: e.by, updatedAt: e.at }),
    },
    Release: {
      from: ["held", "contested", "taken"],
      to: "released",
      apply: (claim, e) => new Claim({ ...claim, state: "released", updatedAt: e.at, releasedAt: e.at }),
    },
  },
  illegal: (claim, _event, to) => new IllegalClaimTransition({ claimId: claim.id, from: claim.state, to }),
});

/** Whether a claim is still held by its Task, contested or not. */
const isOpen = (claim: Claim): boolean => claim.state !== "released";

/** Whether one path is the other or inside it, comparing whole names, so `a/b` and `a/bc` never clash. */
const pathsOverlap = (a: string, b: string): boolean => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * Whether two claims clash: open claims of two Tasks on the same branch, or on paths in the same
 * repository where one is the other or inside it. Numbers never clash, since each is handed out once.
 */
export const claimsClash = (a: Claim, b: Claim): boolean =>
  isOpen(a) &&
  isOpen(b) &&
  a.id !== b.id &&
  a.taskId !== b.taskId &&
  a.scope === b.scope &&
  a.repository === b.repository &&
  !isSequenceScope(a.scope) &&
  (a.scope === "path" ? pathsOverlap(a.key, b.key) : a.key === b.key);

/** `ClaimMachine` with the questions code outside this module asks of a claim's state. */
export const Claims = {
  ...ClaimMachine,
  isOpen,
  isContested: (claim: Claim): boolean => claim.state === "contested",
  /** Whether you took the claim over (#1449), so its hob may not write to it. */
  isTaken: (claim: Claim): boolean => claim.state === "taken",
  /**
   * Whether a new clash makes the claim contested: only a held one is. A contested claim already
   * is, and a claim you took over stays yours, while the new claim that clashes with it is contested.
   */
  contestable: (claim: Claim): boolean => claim.state === "held",
  /** The open claims in `others` that clash with `claim`. */
  clashesOf: (claim: Claim, others: ReadonlyArray<Claim>): ReadonlyArray<Claim> =>
    others.filter((other) => claimsClash(claim, other)),
  /**
   * The contested claims in `open` that clash with nothing once `released` are released: each moves
   * back to held.
   */
  clearedBy: (released: ReadonlyArray<Claim>, open: ReadonlyArray<Claim>): ReadonlyArray<Claim> => {
    const gone = new Set<string>(released.map((claim) => claim.id));
    const left = open.filter((claim) => isOpen(claim) && !gone.has(claim.id));
    return left.filter((claim) => claim.state === "contested" && !left.some((other) => claimsClash(claim, other)));
  },
};

/**
 * A path or folder inside a repository, as a claim keys it: names joined by `/`, without `.` or
 * empty names. Null for an absolute path, one that climbs out with `..`, or one with no name left.
 * Split by plain string methods, so a long input costs no more than reading it (STD-SEC-005).
 */
export const claimPath = (input: string): string | null => {
  const trimmed = input.trim().replaceAll("\\", "/");
  if (trimmed.startsWith("/") || trimmed.startsWith("~") || /^[A-Za-z]:/.test(trimmed)) return null;
  const names = trimmed.split("/").filter((name) => name !== "" && name !== ".");
  if (names.length === 0 || names.includes("..")) return null;
  return names.join("/");
};

/** A branch's name as a claim keys it, without `refs/heads/`; null when nothing is left. */
export const claimBranch = (input: string): string | null => {
  const trimmed = input.trim();
  const name = trimmed.startsWith("refs/heads/") ? trimmed.slice("refs/heads/".length) : trimmed;
  return name === "" || /\s/.test(name) ? null : name;
};

/** How many digits `name` starts with. */
const leadingDigits = (name: string): number => {
  let end = 0;
  while (end < name.length && "0123456789".includes(name.charAt(end))) end++;
  return end;
};

/** The number each file name starts with, such as 98 for `0098_claims.ts`, for the names that start with one. */
export const numbersIn = (names: ReadonlyArray<string>): ReadonlyArray<number> =>
  names.flatMap((name) => {
    const end = leadingDigits(name);
    return end === 0 ? [] : [Number(name.slice(0, end))];
  });

/** `number` written as the names it counts write theirs: padded with zeros to their width when they are. */
export const numberLike = (number: number, names: ReadonlyArray<string>): string => {
  const widths = names.flatMap((name) => {
    const end = leadingDigits(name);
    return end > 1 && name.startsWith("0") ? [end] : [];
  });
  return widths.length === 0 ? String(number) : String(number).padStart(Math.max(...widths), "0");
};

/** The number a claim gets, and whether the hub picked another than the one asked for. */
export interface NumberPick {
  readonly number: number;
  /** The number asked for, when another file or claim has it and the hub settled on `number` instead. */
  readonly taken: number | null;
}

/**
 * The number the hub hands out: the one asked for when neither `main` nor any claim has it, else
 * one past every number `main` and the register have ever held. Released claims count, so a
 * number is never handed out twice, even after its Task ended.
 */
export const pickNumber = (input: {
  readonly onMain: ReadonlyArray<number>;
  readonly claimed: ReadonlyArray<number>;
  readonly asked: number | null;
}): NumberPick => {
  const { onMain, claimed, asked } = input;
  if (asked !== null && !onMain.includes(asked) && !claimed.includes(asked)) return { number: asked, taken: null };
  return { number: Math.max(0, ...onMain, ...claimed) + 1, taken: asked };
};

/** What a claim is on, as a hob reads it, such as "path docs/a.md in github.com/me/app". */
export const claimSubject = (claim: Claim): string => {
  switch (claim.scope) {
    case "path":
      return `path ${claim.key} in ${claim.repository}`;
    case "branch":
      return `branch ${claim.key} in ${claim.repository}`;
    default:
      return `number ${claim.key} in ${claim.directory ?? ""} of ${claim.repository}`;
  }
};

/**
 * Whether a write to `path`, inside the claim's repository with `/` between names, touches the path
 * the claim is on: the file itself, a file inside its folder, or a folder that holds it. An empty
 * path is the repository's top folder, which holds every path in it.
 */
export const touchesPath = (claim: Claim, path: string): boolean =>
  claim.scope === "path" && (path === "" || pathsOverlap(claim.key, path));

/** The claims a list names, as a hob reads them: "path docs/a.md and branch feat/x in github.com/me/app". */
const subjects = (claims: ReadonlyArray<Claim>): string => {
  const names = claims.map(claimSubject);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
};

/**
 * What a hob hears when you take over a Task it works on (#1449): which of its claims are yours now,
 * that the hub refuses its writes to them, and what it may still do.
 */
export const claimsTakenText = (taskId: TaskId, claims: ReadonlyArray<Claim>): string =>
  `The user took over Task ${taskId}'s claims on ${subjects(claims)}. They are the user's now: Hobbots refuses your writes to them until the Task ends. Carry on with the rest of the Task, and ask the user before you need to change them.`;

/** Why the hub refuses a hob's write to a claim you took over (#1449). */
export const takenWriteText = (claim: Claim): string =>
  `The user took over ${claimSubject(claim)} from Task ${claim.taskId}, so Hobbots refuses your writes to it. Leave it to them, and ask the user if your work needs it changed.`;

/** What a lead hears of a clash (ADR 037): whose claims clash, on what, and that neither Task was stopped. */
export const claimClashText = (claim: Claim, clashes: ReadonlyArray<Claim>): string =>
  `Task ${claim.taskId}'s claim on ${claimSubject(claim)} clashes with ${clashes
    .map((other) => `Task ${other.taskId}'s claim on ${other.scope} ${other.key}`)
    .join(
      ", ",
    )}. Neither Task was stopped: agree with the other leads which Task changes it, or split the work, before both change it.`;

/** One side of a clash a chat or camp shows: a claim, and who holds it for which Task and where. */
export class ClashSide extends Schema.Class<ClashSide>("ClashSide")({
  claim: Claim,
  /** The hob that owns the claim's Task. */
  ownerId: AgentId,
  /** The Task's brief, whose first line is its title. */
  brief: Schema.String,
  /** The chat or camp the Task's work belongs to: the thread of its top Task. */
  threadId: Schema.NullOr(ThreadId),
}) {}

/**
 * An open clash on a path or a branch, as a chat or camp shows it in a Heads-up (ADR 037): the open
 * claims that clash, oldest first, at least one of them a Task's in that thread, and when it began,
 * which is when its newest claim was made.
 */
export class ClaimClash extends Schema.Class<ClaimClash>("ClaimClash")({
  sides: Schema.Array(ClashSide),
  since: Schema.String,
}) {}

/**
 * The open clashes among `open` claims that touch `ours`, each once: claims that clash with one
 * another, directly or through a third, form one clash, so two quests on one file make one Heads-up
 * however many times either claimed it. Oldest first, by when each began.
 */
export const clashGroups = (
  ours: ReadonlyArray<Claim>,
  open: ReadonlyArray<Claim>,
): ReadonlyArray<ReadonlyArray<Claim>> => {
  const all = [...new Map([...open, ...ours].filter(isOpen).map((claim) => [claim.id, claim])).values()];
  const placed = new Set<string>();
  const groups: Array<ReadonlyArray<Claim>> = [];
  for (const start of ours) {
    if (placed.has(start.id) || !isOpen(start) || !all.some((other) => claimsClash(start, other))) continue;
    const group: Array<Claim> = [];
    const queue: Array<Claim> = [start];
    placed.add(start.id);
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      group.push(next);
      for (const other of all) {
        if (placed.has(other.id) || !claimsClash(next, other)) continue;
        placed.add(other.id);
        queue.push(other);
      }
    }
    groups.push(group.sort(byCreation));
  }
  return groups.sort((a, b) => sinceOf(a).localeCompare(sinceOf(b)));
};

const byCreation = (a: Claim, b: Claim): number => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** When a clash began: when its newest claim was made. */
export const sinceOf = (group: ReadonlyArray<Claim>): string =>
  group
    .map((claim) => claim.createdAt)
    .sort()
    .at(-1) ?? "";
