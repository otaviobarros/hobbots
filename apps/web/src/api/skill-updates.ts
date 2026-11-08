import type { SkillId, SkillRevisionHash } from "@hobbots/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { call } from "./client.ts";

/**
 * Updates from a source (ADR 029, Updates from a source): what the checks of the library's Git sources
 * found, Check now, and your decisions on it. Accept changes the library, and so does a check for a
 * skill set to Update automatically, whose clean updates it accepts and rolls out.
 */

/** Under the skills' key, so reading the library again after a change reads the updates too. */
const updatesKey = ["skills", "updates"] as const;

/** Every update that waits for you, the skills set to Update automatically, and the last check. */
export const skillUpdatesQuery = queryOptions({
  queryKey: updatesKey,
  queryFn: () => call((c) => c.skillUpdates.list()),
});

/** Checks every Git source now. */
export const checkSkillUpdates = () => call((c) => c.skillUpdates.check());

/** Accepts the update of `hash`: a new revision, rolled out to every hob that is not held back. */
export const acceptSkillUpdate = (input: { skillId: SkillId; hash: SkillRevisionHash }) =>
  call((c) => c.skillUpdates.accept({ params: { skillId: input.skillId }, payload: { hash: input.hash } }));

/** Not now: the update leaves Updates until the source changes again. */
export const dismissSkillUpdate = (input: { skillId: SkillId; hash: SkillRevisionHash }) =>
  call((c) => c.skillUpdates.dismiss({ params: { skillId: input.skillId }, payload: { hash: input.hash } }));

/** Turns Update automatically on or off for a skill from Git. */
export const setSkillAutoUpdate = (input: { skillId: SkillId; on: boolean }) =>
  call((c) => c.skillUpdates.automatic({ params: { skillId: input.skillId }, payload: { on: input.on } }));

/**
 * A check found something, or you decided on an update elsewhere: Updates is read again. A read under
 * way may have started before the change, so it is cancelled first, not reused (STD-REACT-012).
 */
export const refreshSkillUpdates = async (queryClient: QueryClient) => {
  await queryClient.cancelQueries({ queryKey: updatesKey });
  await queryClient.invalidateQueries({ queryKey: updatesKey });
};
