import type {
  AgentId,
  Committed,
  MemoryProjectIdentity,
  MessageId,
  Skill,
  SkillAssignment,
  SkillAssignmentId,
  SkillBy,
  SkillDropped,
  SkillFile,
  SkillFlag,
  SkillId,
  SkillInUse,
  SkillMovedOn,
  SkillName,
  SkillNameChanged,
  SkillNameTaken,
  SkillNotFound,
  SkillOptOut,
  SkillOrigin,
  SkillReadOnly,
  SkillRefused,
  SkillRevision,
  SkillRevisionHash,
  SkillScope,
  SkillSetContent,
  SkillSource,
  SkillSourceChanged,
  SkillSourceUnreadable,
  SkillUse,
  SkillUseCounts,
} from "@hobbots/domain";
import { Context, type Effect } from "effect";

/**
 * Skills, as everything in Hobbots talks to them (ADR 029). The library keeps skills, their
 * immutable revisions, the sources they come from, and where each applies; how and where that is
 * stored is the adapter's business. Policy, such as which skills a hob gets, is built on top of it
 * (`resolveSkills`), never inside it.
 */

/** A hold a save changes: keep the assignment on its revision, or let it follow edits again. */
export interface SkillHoldChange {
  readonly assignmentId: SkillAssignmentId;
  readonly held: boolean;
}

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
  /** For a set (ADR 029, Skill sets), the skills it holds; absent or null for a skill. */
  readonly set?: SkillSetContent | null;
  /**
   * The revision this one was made from: adding it fails with `SkillMovedOn` once the skill's newest
   * is another, unless the newest is this very content, added before by the same edit sent again.
   */
  readonly after?: SkillRevisionHash;
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

/**
 * What an approved proposal changes in who uses a skill: an assignment for the hob that proposed a
 * new skill, or a revision rolled out as `rollOutRevision` rolls it out.
 */
export type SkillDelivery =
  | { readonly _tag: "Assign"; readonly input: SkillAssignmentInput }
  | {
      readonly _tag: "RollOut";
      readonly skillId: SkillId;
      readonly pin: SkillRevisionHash;
      readonly by: SkillBy;
      readonly when: "pending" | "always";
    };

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
   * library has (`SkillNameTaken`), and a revision on a name that is not its skill's (`SkillNameChanged`)
   * or made from a revision that is no longer the newest (`SkillMovedOn`), checked as it is written.
   * A skill from `~/.agents/skills` takes a new revision only from that folder (`SkillReadOnly`).
   */
  readonly addRevision: (
    skillId: SkillId | null,
    input: SkillRevisionInput,
  ) => Library<
    Committed<SkillRevisionAdded>,
    SkillNotFound | SkillNameTaken | SkillNameChanged | SkillMovedOn | SkillReadOnly
  >;
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
   *
   * `holds` are the holds a save changed along with its edit: applied only by the `pending` rollout
   * that claims the revision, in its transaction and before anything moves. A save sent again after
   * its rollout ran claims nothing, so it never replays them over a Keep on made since.
   */
  readonly rollOutRevision: (
    skillId: SkillId,
    pin: SkillRevisionHash,
    by: SkillBy,
    when: "pending" | "always",
    holds?: ReadonlyArray<SkillHoldChange>,
  ) => Library<Committed<ReadonlyArray<SkillAssignment>>, SkillNotFound>;
  /**
   * Makes `delivery` once for `operation`, such as one proposal's add: its receipt is recorded in the
   * same transaction as the assignments it moves, so making it again, after a stop or a retry, moves
   * nothing, whatever was decided since. Null when the operation was made already.
   */
  readonly deliver: (
    operation: string,
    delivery: SkillDelivery,
  ) => Library<Committed<ReadonlyArray<SkillAssignment>> | null, SkillNotFound>;
  /** Holds an assignment on its revision, or lets it follow rollouts again. */
  readonly hold: (id: SkillAssignmentId, held: boolean) => Library<Committed<SkillAssignment>, SkillNotFound>;
  /** Every hob's opt-outs, or one hob's. */
  readonly optOuts: (agentId?: AgentId) => Library<ReadonlyArray<SkillOptOut>>;
  /**
   * Turns a skill off for one hob, or on again, or with `member` one skill of a set (ADR 029, Skill
   * sets). Null when it already was.
   */
  readonly setOptOut: (
    agentId: AgentId,
    skillId: SkillId,
    optedOut: boolean,
    member?: SkillName | null,
  ) => Library<Committed<SkillOptOut> | null, SkillNotFound>;
  /** Removes a skill with no assignment left; one that something still assigns is refused with them. */
  readonly remove: (id: SkillId) => Library<Committed<Skill>, SkillNotFound | SkillInUse>;
  /** Records that a hob used a skill in a turn (ADR 029, The use line), journaled as `SkillUsed`. */
  readonly recordUse: (use: SkillUse) => Library<Committed<SkillUse>>;
  /** Uses of one skill, by one hob, or in one reply, the most recent first, at most `limit` (100 unless given). */
  readonly uses: (filter: SkillUseFilter) => Library<ReadonlyArray<SkillUse>>;
  /** A skill's uses counted in all, since `since`, per hob and per thread, as its Activity shows them. */
  readonly useCounts: (skillId: SkillId, since: string) => Library<SkillUseCounts>;
  /** How often each library skill was used since `since`, as the scope lists show "this week". */
  readonly usesSince: (since: string) => Library<ReadonlyArray<{ readonly skillId: SkillId; readonly count: number }>>;
  /** A hob's most recent use of each skill it used, the most recent first, at most `limit`. */
  readonly lastUses: (agentId: AgentId, limit: number) => Library<ReadonlyArray<SkillUse>>;
}

/** Which uses to read: a skill's, a hob's, a reply's, or those they share when several are given. */
export interface SkillUseFilter {
  readonly skillId?: SkillId;
  readonly agentId?: AgentId;
  readonly messageId?: MessageId;
  readonly limit?: number;
}

export class SkillLibrary extends Context.Service<SkillLibrary, SkillLibraryShape>()("@hobbots/agents/SkillLibrary") {}

/**
 * The files of every revision, once per hash and never changed (ADR 029, Storage and revisions).
 * Import writes them before it adds the revision; the hub reads them to build a turn's mounts.
 */
export interface SkillFilesShape {
  /** The read-only folder that holds a revision's files, or null when the hub has none for it. */
  readonly folder: (hash: SkillRevisionHash) => Effect.Effect<string | null>;
  /** One file of a revision, by its path in the skill; unreadable when the hub has no such file. */
  readonly read: (hash: SkillRevisionHash, path: string) => Effect.Effect<Uint8Array, SkillSourceUnreadable>;
}

export class SkillFiles extends Context.Service<SkillFiles, SkillFilesShape>()("@hobbots/agents/SkillFiles") {}

/**
 * A file of a skill written in Hobbots: its text, or its bytes when it is a file kept from an earlier
 * revision, such as a script a proposal leaves as it was, with whether it runs.
 */
export type WrittenFile =
  | { readonly path: string; readonly text: string; readonly executable?: boolean }
  | { readonly path: string; readonly bytes: Uint8Array; readonly executable?: boolean };

/** What import refuses a skill with, or finds in its way. */
export type SkillImportError =
  | SkillSourceUnreadable
  | SkillRefused
  | SkillNotFound
  | SkillNameTaken
  | SkillNameChanged
  | SkillMovedOn
  | SkillReadOnly
  | SkillSourceChanged;

/**
 * A skill's files as import checks them: what it is called and says it is for, what a reader is
 * warned of, and the revision of the library's skill of that name this content already is, if any.
 */
export interface SkillChecked {
  readonly name: SkillName;
  readonly description: string;
  readonly flags: ReadonlyArray<SkillFlag>;
  readonly hash: SkillRevisionHash;
  readonly existing: { readonly skillId: SkillId; readonly number: number | null } | null;
}

/**
 * Skills written in Hobbots, checked and added as import adds any skill (ADR 029, Import): the port
 * the hub's own use cases, such as a proposal you add, write the library through.
 */
export interface SkillWriterShape {
  /** Checks the files as import would, writing nothing. */
  readonly check: (
    files: ReadonlyArray<WrittenFile>,
  ) => Effect.Effect<SkillChecked, SkillRefused | SkillSourceUnreadable>;
  /**
   * Adds the files as a new skill, or as a new revision of `skillId` built `after` the revision it
   * kept files of. Content the library has answers its revision again, unchanged.
   */
  readonly write: (
    files: ReadonlyArray<WrittenFile>,
    options: { readonly by: SkillBy; readonly skillId?: SkillId; readonly after?: SkillRevisionHash },
  ) => Effect.Effect<SkillRevisionAdded, SkillImportError>;
}

export class SkillWriter extends Context.Service<SkillWriter, SkillWriterShape>()("@hobbots/agents/SkillWriter") {}

/** An assignment with what `resolveSkills` reads of the revision it pins. */
export interface PinnedSkill {
  readonly assignment: SkillAssignment;
  /** The skill's name, or the set's. */
  readonly name: SkillName;
  readonly charms: ReadonlyArray<string>;
  /** For a set (ADR 029, Skill sets), its skills: each resolves as a skill of its own, with the set's pin. */
  readonly set?: {
    readonly skills: ReadonlyArray<{ readonly name: SkillName; readonly charms: ReadonlyArray<string> }>;
  } | null;
}

/** The hob a turn is for, and what decides its skills. */
export interface SkillTurn {
  readonly agentId: AgentId;
  /** The project identities of the folders the turn works in. */
  readonly projects: ReadonlyArray<MemoryProjectIdentity>;
  /** The Charm ids in the hob's configuration. */
  readonly charms: ReadonlyArray<string>;
  /** The skills, and sets, this hob turned off for itself. */
  readonly optedOut: ReadonlyArray<SkillId>;
  /** Single skills of a set this hob turned off for itself (ADR 029, Skill sets). */
  readonly optedOutOfSets?: ReadonlyArray<{ readonly skillId: SkillId; readonly name: SkillName }>;
}

/** A skill a turn loads. */
export interface ResolvedSkill {
  readonly skillId: SkillId;
  /** The skill's own name, inside its set for a skill of a set. */
  readonly name: SkillName;
  readonly pin: SkillRevisionHash;
  readonly scope: SkillScope;
  readonly onlyWhenAsked: boolean;
  /** The Charms it names that the hob does not have: a warning on its profile, never a refusal. */
  readonly missingCharms: ReadonlyArray<string>;
  /** The set it comes from, or null for a skill of its own. */
  readonly set: SkillName | null;
}

/** What a turn's skills came to (ADR 029, Scopes). */
export interface ResolvedSkills {
  /** The skills it loads, by name. */
  readonly skills: ReadonlyArray<ResolvedSkill>;
  /**
   * Wider assignments a narrower one of the same name replaced: struck through on the profile. `name`
   * is the skill's, which for a set is one of its skills.
   */
  readonly replaced: ReadonlyArray<{
    readonly assignment: SkillAssignment;
    readonly by: SkillAssignment;
    readonly name: SkillName;
  }>;
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

/** One skill of a set turned off for the hob; a set of the hob's own is changed, not opted out of. */
const optedOutOfSet = (pinned: PinnedSkill, name: SkillName, turn: SkillTurn): boolean =>
  pinned.assignment.scope._tag !== "Hob" &&
  (turn.optedOutOfSets ?? []).some((one) => one.skillId === pinned.assignment.skillId && one.name === name);

/** A skill an assignment brings: the skill itself, or one skill of a set. */
interface Offered {
  readonly pinned: PinnedSkill;
  readonly name: SkillName;
  readonly charms: ReadonlyArray<string>;
  readonly set: SkillName | null;
}

/** The skills an assignment brings the turn: its own, or each of its set's that the hob did not turn off. */
const offeredOf = (pinned: PinnedSkill, turn: SkillTurn): ReadonlyArray<Offered> =>
  pinned.set
    ? pinned.set.skills
        .filter((skill) => !optedOutOfSet(pinned, skill.name, turn))
        .map((skill) => ({ pinned, name: skill.name, charms: skill.charms, set: pinned.name }))
    : [{ pinned, name: pinned.name, charms: pinned.charms, set: null }];

const byName = (a: { readonly name: string }, b: { readonly name: string }) => (a.name < b.name ? -1 : 1);

const bySetAndName = (a: ResolvedSkill, b: ResolvedSkill) =>
  a.name !== b.name ? byName(a, b) : (a.set ?? "") < (b.set ?? "") ? -1 : 1;

const resolvedOf = (offered: Offered, turn: SkillTurn): ResolvedSkill => ({
  skillId: offered.pinned.assignment.skillId,
  name: offered.name,
  pin: offered.pinned.assignment.pin,
  scope: offered.pinned.assignment.scope,
  onlyWhenAsked: offered.pinned.assignment.onlyWhenAsked,
  missingCharms: offered.charms.filter((charm) => !turn.charms.includes(charm)),
  set: offered.set,
});

/** Whether the narrowest assignments of one name come from two projects of the turn: then neither loads. */
const twoProjects = (winners: ReadonlyArray<Offered>): boolean => {
  const identities = new Set(
    winners.flatMap((one) =>
      one.pinned.assignment.scope._tag === "Project" ? [one.pinned.assignment.scope.identity] : [],
    ),
  );
  return identities.size > 1;
};

/**
 * Each set as one unit (ADR 029, Skill sets): of a set's assignments that reach the turn, the
 * narrowest one alone brings its skills, all on that one revision, and the wider ones are replaced
 * by it. When two projects both assign the set, its names are blocked as a Project clash instead.
 */
const wholeSets = (reached: ReadonlyArray<PinnedSkill>, turn: SkillTurn) => {
  const winning = new Set<PinnedSkill>();
  const replaced: Array<ResolvedSkills["replaced"][number]> = [];
  /** Each name of a set that two projects assign, with those assignments. */
  const blocked = new Map<SkillName, Array<SkillAssignment>>();
  const bySet = new Map<SkillId, Array<PinnedSkill>>();
  for (const one of reached) {
    if (one.set) bySet.set(one.assignment.skillId, [...(bySet.get(one.assignment.skillId) ?? []), one]);
  }
  for (const assigned of bySet.values()) {
    const narrowest = Math.max(...assigned.map((one) => NARROWNESS[one.assignment.scope._tag]));
    const winners = assigned.filter((one) => NARROWNESS[one.assignment.scope._tag] === narrowest);
    const [winner] = winners;
    if (winner === undefined) continue;
    if (winners.length > 1) {
      const assignments = winners.map((one) => one.assignment);
      // A skill of the set the hob turned off blocks nothing, as an opted-out skill replaces nothing.
      const names = new Set(
        winners.flatMap((one) =>
          (one.set?.skills ?? []).filter((skill) => !optedOutOfSet(one, skill.name, turn)).map((skill) => skill.name),
        ),
      );
      for (const name of names) blocked.set(name, [...(blocked.get(name) ?? []), ...assignments]);
      continue;
    }
    winning.add(winner);
    for (const one of assigned)
      if (one !== winner) replaced.push({ assignment: one.assignment, by: winner.assignment, name: one.name });
  }
  return { kept: reached.filter((one) => !one.set || winning.has(one)), replaced, blocked };
};

/**
 * The skills of one name that load: those of its narrowest scope, or a clash when two projects define
 * it. `blocked` holds the assignments of a set two projects assign, which clash as Project ones do, so
 * only a hob's own skill of that name passes them.
 */
const winnersOf = (group: ReadonlyArray<Offered>, blocked: ReadonlyArray<SkillAssignment>) => {
  const narrowest = Math.max(
    ...group.map((one) => NARROWNESS[one.pinned.assignment.scope._tag]),
    blocked.length > 0 ? NARROWNESS.Project : -1,
  );
  const all = group.filter((one) => NARROWNESS[one.pinned.assignment.scope._tag] === narrowest);
  const [winner] = all;
  if (winner === undefined || twoProjects(all) || (blocked.length > 0 && narrowest === NARROWNESS.Project)) {
    return { _tag: "Clash", assignments: [...blocked, ...all.map((one) => one.pinned.assignment)] } as const;
  }
  return { _tag: "Load", winner, all } as const;
};

/**
 * A hob's skills for a turn: Everyone's, plus each project's of the folders it works in, plus its
 * own, a set's skills each counted on its own (ADR 029, Skill sets). The narrower scope wins a name,
 * two projects that define one name load neither, and an Everyone or Project skill the hob opted out
 * of is left out. Two skills of one name in the same scope, from two sets or a set and a skill, both
 * load: their set tells them apart.
 */
export const resolveSkills = (pinned: ReadonlyArray<PinnedSkill>, turn: SkillTurn): ResolvedSkills => {
  const reached = pinned.filter((one) => reaches(one.assignment.scope, turn) && !optedOut(one, turn));
  const sets = wholeSets(reached, turn);
  const replaced: Array<ResolvedSkills["replaced"][number]> = [...sets.replaced];
  const clashes: Array<ResolvedSkills["clashes"][number]> = [];
  const groups = new Map<SkillName, Array<Offered>>();
  for (const one of sets.kept) {
    for (const offered of offeredOf(one, turn))
      groups.set(offered.name, [...(groups.get(offered.name) ?? []), offered]);
  }
  for (const name of sets.blocked.keys()) if (!groups.has(name)) groups.set(name, []);
  const skills: Array<ResolvedSkill> = [];
  for (const [name, group] of groups) {
    const winners = winnersOf(group, sets.blocked.get(name) ?? []);
    if (winners._tag === "Clash") {
      clashes.push({ name, assignments: winners.assignments });
      continue;
    }
    const by = winners.winner.pinned.assignment;
    for (const one of winners.all) skills.push(resolvedOf(one, turn));
    for (const one of group)
      if (!winners.all.includes(one)) replaced.push({ assignment: one.pinned.assignment, by, name });
    for (const assignment of sets.blocked.get(name) ?? []) replaced.push({ assignment, by, name });
  }
  return { skills: skills.sort(bySetAndName), replaced, clashes: clashes.sort(byName) };
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
