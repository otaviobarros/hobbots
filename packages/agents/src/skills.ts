import type {
  AgentId,
  Committed,
  MemoryProjectIdentity,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillBy,
  SkillDropped,
  SkillFile,
  SkillFlag,
  SkillId,
  SkillInUse,
  SkillName,
  SkillNameChanged,
  SkillNameTaken,
  SkillNotFound,
  SkillOptOut,
  SkillOrigin,
  SkillRevision,
  SkillRevisionHash,
  SkillScope,
  SkillSource,
} from "@hobbots/domain";
import { Context, type Effect } from "effect";

/**
 * Skills, as everything in Hobbots talks to them (ADR 029). The library keeps skills, their
 * immutable revisions, the sources they come from, and where each applies; how and where that is
 * stored is the adapter's business. Policy, such as which skills a hob gets, is built on top of it
 * (`resolveSkills`), never inside it.
 */

/** A revision to add, already checked: its hash is the content's, and its files are in `SkillFiles`. */
export interface SkillRevisionInput {
  readonly hash: SkillRevisionHash;
  readonly name: SkillName;
  readonly description: string;
  readonly charms: ReadonlyArray<string>;
  readonly files: ReadonlyArray<SkillFile>;
  readonly flags: ReadonlyArray<SkillFlag>;
  readonly dropped: ReadonlyArray<SkillDropped>;
  /** Where it was read from; null for a skill written in Hobbots. Recorded once per origin. */
  readonly origin: SkillOrigin | null;
  readonly commit: string | null;
  readonly path: string | null;
  readonly label: string | null;
  readonly addedBy: SkillBy;
}

/**
 * What adding a revision found: `added` false when the skill already had that content, and then
 * `revision` is the one it has and nothing was written.
 */
export interface SkillRevisionAdded {
  readonly skill: Skill;
  readonly revision: SkillRevision;
  readonly added: boolean;
}

/** A new assignment, or a change to the one a skill already has in that scope. */
export interface SkillAssignmentInput {
  readonly skillId: SkillId;
  readonly scope: SkillScope;
  readonly pin: SkillRevisionHash;
  readonly held: boolean;
  readonly onlyWhenAsked: boolean;
  readonly by: SkillBy;
}

type Library<A, E = never> = Effect.Effect<A, E>;

/** The skills library, kept by the hub's database. Every change is journaled in its transaction. */
export interface SkillLibraryShape {
  /** Every skill, by name. */
  readonly list: Library<ReadonlyArray<Skill>>;
  readonly get: (id: SkillId) => Library<Skill | null>;
  readonly byName: (name: SkillName) => Library<Skill | null>;
  /** A skill's revisions, newest first; empty when there is no such skill. */
  readonly revisions: (id: SkillId) => Library<ReadonlyArray<SkillRevision>>;
  readonly revision: (id: SkillId, hash: SkillRevisionHash) => Library<SkillRevision | null>;
  readonly sources: Library<ReadonlyArray<SkillSource>>;
  /**
   * Adds `input` as the newest revision of skill `skillId`, or as the first of a new skill when null.
   * Content the skill already has answers that revision, unchanged, and a new skill whose content a
   * skill of that name already has answers that one. Otherwise a new skill fails on a name the
   * library has (`SkillNameTaken`), and a revision on a name that is not its skill's (`SkillNameChanged`).
   */
  readonly addRevision: (
    skillId: SkillId | null,
    input: SkillRevisionInput,
  ) => Library<Committed<SkillRevisionAdded>, SkillNotFound | SkillNameTaken | SkillNameChanged>;
  /** Every assignment, or a skill's. */
  readonly assignments: (skillId?: SkillId) => Library<ReadonlyArray<SkillAssignment>>;
  /** Assigns a skill to a scope, or changes its assignment there; a skill has one per scope. */
  readonly assign: (input: SkillAssignmentInput) => Library<Committed<SkillAssignment>, SkillNotFound>;
  /** Takes an assignment away; null when there is none. */
  readonly unassign: (id: SkillAssignmentId) => Library<Committed<SkillAssignment> | null>;
  /** Moves an assignment's pin to `pin`, a revision of its skill: a rollout, or a rollback. */
  readonly rollOut: (
    id: SkillAssignmentId,
    pin: SkillRevisionHash,
    by: SkillBy,
  ) => Library<Committed<SkillAssignment>, SkillNotFound>;
  /**
   * Rolls `pin`, a revision of the skill, out to every assignment of it that is not held and not on it
   * already, in one transaction that rereads each, and marks the revision rolled out (ADR 029, Pins
   * and rollout). Answers the assignments it moved.
   *
   * `when` is `pending` for the rollout a save makes on its own: inside the same transaction it rolls
   * out only a revision that is still its skill's newest and was never rolled out, so two saves of
   * one content roll it out once and a rollback made between them stays. `always` is a rollout you
   * ask for, such as Roll back, which goes ahead whatever the revision's past.
   */
  readonly rollOutRevision: (
    skillId: SkillId,
    pin: SkillRevisionHash,
    by: SkillBy,
    when: "pending" | "always",
  ) => Library<Committed<ReadonlyArray<SkillAssignment>>, SkillNotFound>;
  /** Holds an assignment on its revision, or lets it follow rollouts again. */
  readonly hold: (id: SkillAssignmentId, held: boolean) => Library<Committed<SkillAssignment>, SkillNotFound>;
  /** Every hob's opt-outs, or one hob's. */
  readonly optOuts: (agentId?: AgentId) => Library<ReadonlyArray<SkillOptOut>>;
  /** Turns a skill off for one hob, or on again. Null when it already was. */
  readonly setOptOut: (
    agentId: AgentId,
    skillId: SkillId,
    optedOut: boolean,
  ) => Library<Committed<SkillOptOut> | null, SkillNotFound>;
  /** Removes a skill with no assignment left; one that something still assigns is refused with them. */
  readonly remove: (id: SkillId) => Library<Committed<Skill>, SkillNotFound | SkillInUse>;
}

export class SkillLibrary extends Context.Service<SkillLibrary, SkillLibraryShape>()("@hobbots/agents/SkillLibrary") {}

/**
 * The files of every revision, once per hash and never changed (ADR 029, Storage and revisions).
 * Import writes them before it adds the revision; the hub reads them to build a turn's mounts.
 */
export interface SkillFilesShape {
  /** The read-only folder that holds a revision's files, or null when the hub has none for it. */
  readonly folder: (hash: SkillRevisionHash) => Effect.Effect<string | null>;
}

export class SkillFiles extends Context.Service<SkillFiles, SkillFilesShape>()("@hobbots/agents/SkillFiles") {}

/** An assignment with what `resolveSkills` reads of the revision it pins. */
export interface PinnedSkill {
  readonly assignment: SkillAssignment;
  readonly name: SkillName;
  readonly charms: ReadonlyArray<string>;
}

/** The hob a turn is for, and what decides its skills. */
export interface SkillTurn {
  readonly agentId: AgentId;
  /** The project identities of the folders the turn works in. */
  readonly projects: ReadonlyArray<MemoryProjectIdentity>;
  /** The Charm ids in the hob's configuration. */
  readonly charms: ReadonlyArray<string>;
  /** The skills this hob turned off for itself. */
  readonly optedOut: ReadonlyArray<SkillId>;
}

/** A skill a turn loads. */
export interface ResolvedSkill {
  readonly skillId: SkillId;
  readonly name: SkillName;
  readonly pin: SkillRevisionHash;
  readonly scope: SkillScope;
  readonly onlyWhenAsked: boolean;
  /** The Charms it names that the hob does not have: a warning on its profile, never a refusal. */
  readonly missingCharms: ReadonlyArray<string>;
}

/** What a turn's skills came to (ADR 029, Scopes). */
export interface ResolvedSkills {
  /** The skills it loads, by name. */
  readonly skills: ReadonlyArray<ResolvedSkill>;
  /** Wider assignments a narrower one of the same name replaced: struck through on the profile. */
  readonly replaced: ReadonlyArray<{ readonly assignment: SkillAssignment; readonly by: SkillAssignment }>;
  /** Names two projects of the turn both define, so neither loads until you pick one. */
  readonly clashes: ReadonlyArray<{ readonly name: SkillName; readonly assignments: ReadonlyArray<SkillAssignment> }>;
}

/** How narrow a scope is: a hob's own is the narrowest. */
const NARROWNESS: Record<SkillScope["_tag"], number> = { Everyone: 0, Project: 1, Hob: 2 };

/** Whether an assignment reaches the turn at all. */
const reaches = (scope: SkillScope, turn: SkillTurn): boolean => {
  switch (scope._tag) {
    case "Everyone":
      return true;
    case "Project":
      return turn.projects.includes(scope.identity);
    case "Hob":
      return scope.agentId === turn.agentId;
  }
};

/** An opt-out turns off an Everyone or Project skill; a hob's own skill is removed, not opted out of. */
const optedOut = (pinned: PinnedSkill, turn: SkillTurn): boolean =>
  pinned.assignment.scope._tag !== "Hob" && turn.optedOut.includes(pinned.assignment.skillId);

const byName = (a: { readonly name: string }, b: { readonly name: string }) => (a.name < b.name ? -1 : 1);

const resolvedOf = (pinned: PinnedSkill, turn: SkillTurn): ResolvedSkill => ({
  skillId: pinned.assignment.skillId,
  name: pinned.name,
  pin: pinned.assignment.pin,
  scope: pinned.assignment.scope,
  onlyWhenAsked: pinned.assignment.onlyWhenAsked,
  missingCharms: pinned.charms.filter((charm) => !turn.charms.includes(charm)),
});

/**
 * A hob's skills for a turn: Everyone's, plus each project's of the folders it works in, plus its
 * own. The narrower scope wins a name, two projects that define one name load neither, and an
 * Everyone or Project skill the hob opted out of is left out.
 */
export const resolveSkills = (pinned: ReadonlyArray<PinnedSkill>, turn: SkillTurn): ResolvedSkills => {
  const groups = new Map<SkillName, Array<PinnedSkill>>();
  for (const one of pinned) {
    if (!reaches(one.assignment.scope, turn) || optedOut(one, turn)) continue;
    groups.set(one.name, [...(groups.get(one.name) ?? []), one]);
  }
  const skills: Array<ResolvedSkill> = [];
  const replaced: Array<ResolvedSkills["replaced"][number]> = [];
  const clashes: Array<ResolvedSkills["clashes"][number]> = [];
  for (const [name, group] of groups) {
    const narrowest = Math.max(...group.map((one) => NARROWNESS[one.assignment.scope._tag]));
    const winners = group.filter((one) => NARROWNESS[one.assignment.scope._tag] === narrowest);
    const [winner] = winners;
    if (winner === undefined) continue;
    if (winners.length > 1) {
      clashes.push({ name, assignments: winners.map((one) => one.assignment) });
      continue;
    }
    skills.push(resolvedOf(winner, turn));
    for (const one of group) if (one !== winner) replaced.push({ assignment: one.assignment, by: winner.assignment });
  }
  return { skills: skills.sort(byName), replaced, clashes: clashes.sort(byName) };
};

/**
 * The assignments a new revision of a skill rolls out to: every one of that skill that is not held
 * and is not on it already (ADR 029, Pins and rollout).
 */
export const rolloutTargets = (
  assignments: ReadonlyArray<SkillAssignment>,
  skillId: SkillId,
  pin: SkillRevisionHash,
): ReadonlyArray<SkillAssignment> =>
  assignments.filter((one) => one.skillId === skillId && !one.held && one.pin !== pin);
