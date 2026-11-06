import type { SkillSourcePayload } from "@hobbots/api";
import type { SkillAssignmentId, SkillId, SkillRevisionHash, SkillScope } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { ApiError, call } from "./client.ts";

/**
 * The skills library, as the Skills page reads and changes it through the hub (ADR 029). Every
 * change is yours: a device session makes it, and no hob reaches these routes.
 */

const skillsKey = ["skills"] as const;

const skillsKeys = {
  all: skillsKey,
  list: [...skillsKey, "list"] as const,
  detail: (skillId: SkillId) => [...skillsKey, "detail", skillId] as const,
  revision: (skillId: SkillId, hash: SkillRevisionHash) => [...skillsKey, "revision", skillId, hash] as const,
  file: (skillId: SkillId, hash: SkillRevisionHash, path: string) =>
    [...skillsKey, "file", skillId, hash, path] as const,
};

/** Every skill in the library, its sources, and what `~/.agents/skills` held that the hub did not take. */
export const skillsListQuery = queryOptions({
  queryKey: skillsKeys.list,
  queryFn: () => call((c) => c.skills.list()),
});

/** A skill with its revisions, newest first, and where it is assigned. */
export const skillQuery = (skillId: SkillId) =>
  queryOptions({
    queryKey: skillsKeys.detail(skillId),
    queryFn: () => call((c) => c.skills.get({ params: { skillId } })),
  });

/** A revision never changes, so its `SKILL.md` is read once. */
export const skillRevisionQuery = (skillId: SkillId, hash: SkillRevisionHash) =>
  queryOptions({
    queryKey: skillsKeys.revision(skillId, hash),
    queryFn: () => call((c) => c.skills.revision({ params: { skillId, hash } })),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** One file of a revision, read once for the same reason. */
export const skillFileQuery = (skillId: SkillId, hash: SkillRevisionHash, path: string) =>
  queryOptions({
    queryKey: skillsKeys.file(skillId, hash, path),
    queryFn: () => call((c) => c.skills.file({ params: { skillId, hash }, query: { path } })),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** What a source holds, checked, writing nothing. */
export const scanSkills = (source: SkillSourcePayload) => call((c) => c.skills.scan({ payload: { source } }));

/** Adds the picked folders of a source to the library, each as a new skill. */
export const importSkills = (input: { source: SkillSourcePayload; folders?: ReadonlyArray<string> }) =>
  call((c) => c.skills.import({ payload: input }));

/** A new revision of a skill, from an edit of `base` in Hobbots. */
export const editSkill = (input: {
  skillId: SkillId;
  base: SkillRevisionHash;
  description: string;
  instructions: string;
}) =>
  call((c) =>
    c.skills.edit({
      params: { skillId: input.skillId },
      payload: { base: input.base, description: input.description, instructions: input.instructions },
    }),
  );

/** Gives a skill to a scope, pinned to its newest revision unless `pin` names one, or changes it there. */
export const assignSkill = ({
  skillId,
  ...payload
}: {
  skillId: SkillId;
  scope: SkillScope;
  pin?: SkillRevisionHash;
  onlyWhenAsked?: boolean;
}) => call((c) => c.skills.assign({ params: { skillId }, payload }));

/** Keep on rN, or follow rollouts again. */
export const holdAssignment = (input: { assignmentId: SkillAssignmentId; held: boolean }) =>
  call((c) => c.skills.hold({ params: { assignmentId: input.assignmentId }, payload: { held: input.held } }));

/** Moves one assignment to a revision: Roll back, or moving a held one on. */
export const rollAssignment = (input: { assignmentId: SkillAssignmentId; pin: SkillRevisionHash }) =>
  call((c) =>
    c.skills.rollOutAssignment({ params: { assignmentId: input.assignmentId }, payload: { pin: input.pin } }),
  );

/** Moves every assignment of a skill that is not held to a revision: Roll back from History. */
export const rollOutSkill = (input: { skillId: SkillId; pin: SkillRevisionHash }) =>
  call((c) => c.skills.rollOut({ params: { skillId: input.skillId }, payload: { pin: input.pin } }));

/** Takes a skill from a scope. */
export const unassignSkill = (assignmentId: SkillAssignmentId) =>
  call((c) => c.skills.unassign({ params: { assignmentId } }));

/** Removes a skill nothing assigns. */
export const removeSkill = (skillId: SkillId) => call((c) => c.skills.remove({ params: { skillId } }));

/** Reads the library again after a change: its list and every skill's page. Revisions and files never change. */
export const refreshSkills = async (queryClient: QueryClient) => {
  const live = {
    queryKey: skillsKeys.all,
    predicate: (query: { queryKey: ReadonlyArray<unknown> }) =>
      query.queryKey[1] !== "revision" && query.queryKey[1] !== "file",
  };
  await queryClient.cancelQueries(live);
  await queryClient.invalidateQueries(live);
};

/** The tag of a refusal the skills routes answer, such as `SkillImportRefused`, or null for any other failure. */
export const skillsErrorTag = (error: unknown): string | null =>
  error instanceof ApiError && error.tag !== undefined ? error.tag : null;
