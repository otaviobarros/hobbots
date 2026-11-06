import type { AgentId, HobPolicy, SkillAssignment, TurnSkill } from "@hobbots/domain";
import { Effect, Option } from "effect";
import { MemoryProjects, memoryActorFor } from "./memory.ts";
import type { SkillMount } from "./runtime.ts";
import {
  type PinnedSkill,
  type ResolvedSkills,
  resolveSkills,
  SkillFiles,
  SkillLibrary,
  type SkillLibraryShape,
} from "./skills.ts";

/**
 * A hob's skills for a turn (ADR 029, Scopes and Delivery): the hub resolves them from the library
 * when the turn starts and hands the runtime their mounts. Every session gets them the same way, a
 * chat's, a Task step's and a party member's.
 */

/**
 * The Charm ids in a hob's configuration, which a skill's Charm hint is compared with. The GitHub
 * Charm is the only one today, and a hob has it unless its policy turns it off (ADR 020).
 */
export const hobCharms = (policy: HobPolicy): ReadonlyArray<string> => (policy.githubCharm === false ? [] : ["github"]);

/** Each assignment with what resolving reads of the revision it pins; one whose revision is gone is left out. */
export const pinnedSkills = (
  library: SkillLibraryShape,
  assignments: ReadonlyArray<SkillAssignment>,
): Effect.Effect<ReadonlyArray<PinnedSkill>> =>
  Effect.forEach(assignments, (assignment) =>
    Effect.map(library.revision(assignment.skillId, assignment.pin), (revision) =>
      revision === null ? [] : [{ assignment, name: revision.name, charms: revision.charms }],
    ),
  ).pipe(Effect.map((each) => each.flat()));

/** What decides a hob's skills: the hob, its configuration's policy, and the folders it works in. */
export interface SkillHob {
  readonly agentId: AgentId;
  readonly policy: HobPolicy;
  readonly folders: ReadonlyArray<string>;
}

/**
 * Resolves a hob's skills from the library as it is now: Everyone's, the projects' of its folders,
 * its own, less what it opted out of. The projects are those its memory reaches (ADR 028).
 */
export const hobSkills = (
  library: SkillLibraryShape,
  projects: Option.Option<MemoryProjects["Service"]>,
  hob: SkillHob,
): Effect.Effect<ResolvedSkills> =>
  Effect.gen(function* () {
    const actor = yield* memoryActorFor(projects, hob.agentId, hob.folders);
    const pinned = yield* pinnedSkills(library, yield* library.assignments());
    const optedOut = (yield* library.optOuts(hob.agentId)).map((one) => one.skillId);
    return resolveSkills(pinned, {
      agentId: hob.agentId,
      projects: actor.projects,
      charms: hobCharms(hob.policy),
      optedOut,
    });
  });

/** What a turn's skills are: resolved from the library, and read as the runtime's mounts. */
export interface SkillMounterShape {
  /** Whether the hub has a skills library: without one, no turn has skills and nothing is read. */
  readonly enabled: boolean;
  /**
   * The hob's skills as the library assigns them now, to record with the turn: when your message
   * is accepted, so a queued message keeps them, or when a turn with no message of yours starts.
   * Null on a hub without a skills library.
   */
  readonly resolve: (hob: SkillHob) => Effect.Effect<ReadonlyArray<TurnSkill> | null>;
  /** The mounts of recorded skills: each the read-only folder of its pinned revision. */
  readonly mounts: (skills: ReadonlyArray<TurnSkill> | null) => Effect.Effect<ReadonlyArray<SkillMount> | null>;
}

/**
 * What hands each turn its skills (ADR 029, Pins and rollout). A turn is given the skills recorded
 * when it was accepted, and the runtime gets their mounts with its prompt, so the turn keeps those
 * revisions to its end, its follow-up turns included, while the next one gets what a rollout changed.
 */
export const skillMounter = Effect.gen(function* () {
  const library = yield* Effect.serviceOption(SkillLibrary);
  const files = yield* Effect.serviceOption(SkillFiles);
  const projects = yield* Effect.serviceOption(MemoryProjects);
  const shape: SkillMounterShape = {
    enabled: Option.isSome(library) && Option.isSome(files),
    resolve: (hob) =>
      Option.isNone(library) || Option.isNone(files)
        ? Effect.succeed(null)
        : Effect.map(hobSkills(library.value, projects, hob), (resolved) =>
            resolved.skills.map((skill) => ({
              skillId: skill.skillId,
              name: skill.name,
              pin: skill.pin,
              onlyWhenAsked: skill.onlyWhenAsked,
            })),
          ),
    mounts: (skills) =>
      skills === null || Option.isNone(files)
        ? Effect.succeed(null)
        : Effect.forEach(skills, (skill) =>
            Effect.gen(function* () {
              const folder = yield* files.value.folder(skill.pin);
              if (folder !== null) {
                return [{ name: skill.name, revision: skill.pin, folder, implicit: !skill.onlyWhenAsked }];
              }
              // The database names a revision whose files the hub lost: the turn goes on without it.
              yield* Effect.logWarning(`No files for ${skill.name} at ${skill.pin}; the turn goes on without it.`);
              return [];
            }),
          ).pipe(Effect.map((each) => each.flat())),
  };
  return shape;
});
