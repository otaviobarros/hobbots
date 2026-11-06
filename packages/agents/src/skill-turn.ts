import type { AgentId, HobPolicy, SkillAssignment } from "@hobbots/domain";
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

/**
 * What hands each turn its skills: the mounts of the hob's resolved skills, each the read-only folder
 * of the revision its assignment pins. Read once the turn starts and given to the runtime with its
 * prompt, so a turn keeps those revisions to its end, its follow-up turns included, while the next
 * turn gets what a rollout changed. Null on a hub without a skills library: the turn has no skills.
 */
export const skillMounter = Effect.gen(function* () {
  const library = yield* Effect.serviceOption(SkillLibrary);
  const files = yield* Effect.serviceOption(SkillFiles);
  const projects = yield* Effect.serviceOption(MemoryProjects);
  return (hob: SkillHob): Effect.Effect<ReadonlyArray<SkillMount> | null> =>
    Option.isNone(library) || Option.isNone(files)
      ? Effect.succeed(null)
      : Effect.gen(function* () {
          const resolved = yield* hobSkills(library.value, projects, hob);
          const mounts = yield* Effect.forEach(resolved.skills, (skill) =>
            Effect.gen(function* () {
              const folder = yield* files.value.folder(skill.pin);
              if (folder !== null) {
                return [{ name: skill.name, revision: skill.pin, folder, implicit: !skill.onlyWhenAsked }];
              }
              // The database names a revision whose files the hub lost: the turn goes on without it.
              yield* Effect.logWarning(`No files for ${skill.name} at ${skill.pin}; the turn goes on without it.`);
              return [];
            }),
          );
          return mounts.flat();
        });
});
