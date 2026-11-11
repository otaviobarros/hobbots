import { Schema } from "effect";
import { defineMachine } from "./machine.ts";
import { Revision } from "./revision.ts";
import { TaskId } from "./task.ts";

/**
 * The claims register (ADR 037, The hub coordinates across every chat and camp). A hob claims a
 * migration or ADR number, a path or a branch with `claim`, and the hub records it for the Task it
 * works on. The hub hands out each number once across every hob, chat and camp, and watches paths
 * and branches for clashes. Every rule here is pure and calls no model.
 */

export const ClaimId = Schema.String.pipe(Schema.brand("ClaimId"));
export type ClaimId = typeof ClaimId.Type;

/**
 * What a claim is on. A number scope counts the files in one folder of a repository, such as its
 * migrations or its ADRs; `path` is a file or a folder; `branch` is a branch name.
 */
export const ClaimScope = Schema.Literals(["migration-number", "adr-number", "path", "branch"]);
export type ClaimScope = typeof ClaimScope.Type;

/** Whether a scope is a number the hub hands out, rather than a name it watches. */
export const isNumberScope = (scope: ClaimScope): boolean => scope === "migration-number" || scope === "adr-number";

/** Where a claim stands, held by `ClaimMachine`. */
export const ClaimState = Schema.Literals(["held", "contested", "released"]);
export type ClaimState = typeof ClaimState.Type;

/** Who wrote a record (ADR 037, Every author is an actor): you, a hob or the hub itself. */
export const Actor = Schema.Struct({ kind: Schema.Literals(["user", "hob", "hub"]), id: Schema.String });
export type Actor = typeof Actor.Type;

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
  | { readonly _tag: "Release"; readonly at: string };

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
    released: "Its Task ended; a released number is never handed out again",
  },
  field: "state",
  events: {
    // Only a path or a branch is watched for clashes.
    Contest: {
      from: ["held"],
      to: "contested",
      guard: (claim) => !isNumberScope(claim.scope),
      apply: (claim, e) => new Claim({ ...claim, state: "contested", updatedAt: e.at }),
    },
    // The last claim it clashed with was released.
    Clear: {
      from: ["contested"],
      to: "held",
      apply: (claim, e) => new Claim({ ...claim, state: "held", updatedAt: e.at }),
    },
    Release: {
      from: ["held", "contested"],
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
  !isNumberScope(a.scope) &&
  (a.scope === "path" ? pathsOverlap(a.key, b.key) : a.key === b.key);

/** `ClaimMachine` with the questions code outside this module asks of a claim's state. */
export const Claims = {
  ...ClaimMachine,
  isOpen,
  isContested: (claim: Claim): boolean => claim.state === "contested",
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

/** The number each file name starts with, such as 97 for `0097_claims.ts`, for the names that start with one. */
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
      return `${claim.scope === "migration-number" ? "migration" : "ADR"} number ${claim.key} in ${claim.directory ?? ""} of ${claim.repository}`;
  }
};

/** What a lead hears of a clash (ADR 037): whose claims clash, on what, and that neither Task was stopped. */
export const claimClashText = (claim: Claim, clashes: ReadonlyArray<Claim>): string =>
  `Task ${claim.taskId}'s claim on ${claimSubject(claim)} clashes with ${clashes
    .map((other) => `Task ${other.taskId}'s claim on ${other.scope} ${other.key}`)
    .join(
      ", ",
    )}. Neither Task was stopped: agree with the other leads which Task changes it, or split the work, before both change it.`;
