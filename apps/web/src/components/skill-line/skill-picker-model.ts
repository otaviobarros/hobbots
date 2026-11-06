import type { HobSkills } from "@hobbots/api";
import { skillTitle } from "@hobbots/domain";
import { messages } from "./messages.ts";

const copy = messages.picker;

/** One of the hob's skills as the `/` list shows it. */
export interface PickerSkill {
  readonly name: string;
  readonly title: string;
  /** Where it comes from, and Only when asked. */
  readonly sub: string;
}

/** A project's short name: the last part of its identity, as `site` for `github.com/me/site`. */
const projectName = (identity: string): string => identity.split("/").filter(Boolean).at(-1) ?? identity;

/** The hob's skills the `/` list offers, by name, each with where it comes from. */
export const pickerSkills = (view: HobSkills | undefined, hobName: string): ReadonlyArray<PickerSkill> =>
  (view?.skills ?? [])
    .map((skill) => {
      const where =
        skill.scope._tag === "Everyone"
          ? copy.everyone
          : skill.scope._tag === "Hob"
            ? copy.own({ name: hobName })
            : copy.project({ name: projectName(skill.scope.identity) });
      return {
        name: skill.name,
        title: skillTitle(skill.name),
        sub: skill.onlyWhenAsked ? `${where} · ${copy.onlyWhenAsked}` : where,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

/** What a draft that is only `/` and a start of a name is looking for; null for any other draft. */
export const slashQuery = (draft: string): string | null => {
  const match = /^\/([a-z0-9-]*)$/.exec(draft);
  return match ? (match[1] ?? "") : null;
};

/** The skills whose name starts with what was typed after `/`. */
export const matchingSkills = (skills: ReadonlyArray<PickerSkill>, query: string): ReadonlyArray<PickerSkill> =>
  skills.filter((skill) => skill.name.startsWith(query));

/** The draft once a skill is picked: its `/name` and a space, ready for the message. */
export const pickedDraft = (name: string): string => `/${name} `;
