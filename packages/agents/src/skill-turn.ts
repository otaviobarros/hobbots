import {
  type AgentId,
  type HobPolicy,
  type MessageId,
  type SkillAssignment,
  type SkillName,
  SkillUse,
  SkillUseId,
  type ThreadId,
  type TurnSkill,
  type UsedSkill,
} from "@hobbots/domain";
import { DateTime, Effect, Option } from "effect";
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

/** Where a turn's skill uses are counted: the hob, and the thread and reply when it has them. */
export interface SkillUseTurn {
  readonly agentId: AgentId;
  readonly threadId: ThreadId | null;
  readonly messageId: MessageId | null;
}

/** Records the skills a turn uses (ADR 029, The use line), each once per turn. */
export interface SkillUseRecorderShape {
  /** The turn's skills, once they are known: what its message was accepted with, or resolved as it started. */
  readonly given: (skills: ReadonlyArray<TurnSkill> | null) => void;
  /** The skills an administrator's settings bring, as the session reported them when it started. */
  readonly organization: (names: ReadonlyArray<string> | undefined) => void;
  /**
   * Maps a use the runtime reported to the revision the turn mounted, and journals it. Answers the
   * skill as the reply records it, or null for a skill the turn already used or was never given.
   */
  readonly record: (used: { readonly name: string; readonly explicit: boolean }) => Effect.Effect<UsedSkill | null>;
}

/**
 * What records a turn's skill uses. A name is mapped only to a skill the turn was given, so a
 * runtime that names any other records nothing; without a skills library nothing is journaled, and
 * the use still shows under the reply.
 */
export const skillUseRecorder = (turn: SkillUseTurn) =>
  Effect.gen(function* () {
    const library = yield* Effect.serviceOption(SkillLibrary);
    let skills: ReadonlyArray<TurnSkill> = [];
    let organization: ReadonlyArray<string> = [];
    const recorded = new Set<string>();
    const usedOf = (name: string, explicit: boolean) =>
      Effect.gen(function* () {
        const mounted = skills.find((skill) => skill.name === name);
        if (mounted === undefined) {
          if (!organization.includes(name)) return null;
          const used: UsedSkill = { source: "organization", skillId: null, name, pin: null, number: null, explicit };
          return used;
        }
        const revision = Option.isSome(library) ? yield* library.value.revision(mounted.skillId, mounted.pin) : null;
        const used: UsedSkill = {
          source: "library",
          skillId: mounted.skillId,
          name,
          pin: mounted.pin,
          number: revision?.number ?? null,
          explicit,
        };
        return used;
      });
    const shape: SkillUseRecorderShape = {
      given: (given) => {
        skills = given ?? [];
      },
      organization: (names) => {
        organization = names ?? [];
      },
      record: ({ name, explicit }) =>
        Effect.gen(function* () {
          if (recorded.has(name)) return null;
          const used = yield* usedOf(name, explicit);
          if (used === null) return null;
          recorded.add(name);
          if (Option.isSome(library)) {
            const at = DateTime.formatIso(yield* DateTime.now);
            yield* library.value.recordUse(
              new SkillUse({ id: SkillUseId.make(crypto.randomUUID()), ...used, ...turn, at }),
            );
          }
          return used;
        }),
    };
    return shape;
  });

/** `skills` with `used` added, unless it already holds that skill: a reply records each skill once. */
export const withUsedSkill = (skills: ReadonlyArray<UsedSkill>, used: UsedSkill): ReadonlyArray<UsedSkill> =>
  skills.some((one) => one.source === used.source && one.name === used.name && one.pin === used.pin)
    ? skills
    : [...skills, used];

/**
 * The skill you picked for your message, if the turn was given it (ADR 029, Explicit use): one you
 * since lost, as after an unassign while the message waited, is dropped, and the turn runs without it.
 */
export const askedSkillOf = (
  yours: { readonly askedSkill: string | null } | undefined,
  given: ReadonlyArray<TurnSkill> | null,
): string | null => {
  const asked = yours?.askedSkill ?? null;
  return asked !== null && (given ?? []).some((skill) => skill.name === asked) ? asked : null;
};

/** A `/name` at the start of a message, as the composer writes a skill you picked. */
const MENTION = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/;

/**
 * The skill a message names at its start with `/` (ADR 029, Explicit use), when the hob has a skill
 * of that name; null otherwise, so a `/` that names no skill of the hob's stays plain text.
 */
export const mentionedSkill = (content: string, given: ReadonlyArray<TurnSkill> | null): SkillName | null => {
  const name = MENTION.exec(content)?.[1];
  return (given ?? []).find((skill) => skill.name === name)?.name ?? null;
};

/**
 * The prompt without its leading `/name` for the skill you picked, which the runtime gets as its own
 * mention instead; as it is when you picked none.
 */
export const withoutMention = (prompt: string, name: string | null): string =>
  name !== null && MENTION.exec(prompt)?.[1] === name ? prompt.slice(name.length + 1).trimStart() : prompt;
