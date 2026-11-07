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

/** The hob's skills the composer's `/` offers, and whose they are. */
export interface SkillPicking {
  readonly hobName: string;
  readonly skills: ReadonlyArray<PickerSkill>;
  /** Whether the hob's skills have loaded; until they have, the list says so instead of "no skills". */
  readonly status: "loading" | "failed" | "ready";
  /** Asks for the hob's skills again after they failed to load. */
  readonly onRetry: () => void;
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

/** What a draft that starts with `/` and the start of a name is looking for, and the text after it. */
export interface SlashQuery {
  readonly query: string;
  /** The message after the name, kept as it is while a skill is picked; null when there is none. */
  readonly rest: string | null;
}

/**
 * The `/` the draft starts with, if the list should be open for it: `/` and the start of a name, on
 * its own or before the rest of the message. A name already written out in full, as after a pick,
 * leaves the list closed.
 */
export const slashQuery = (draft: string, names: ReadonlyArray<string> = []): SlashQuery | null => {
  const match = /^\/([a-z0-9-]*)(?: ([\s\S]*))?$/.exec(draft);
  if (!match) return null;
  const query = match[1] ?? "";
  const rest = match[2] ?? null;
  return rest !== null && names.includes(query) ? null : { query, rest };
};

/** The skills whose name starts with what was typed after `/`. */
export const matchingSkills = (skills: ReadonlyArray<PickerSkill>, query: string): ReadonlyArray<PickerSkill> =>
  skills.filter((skill) => skill.name.startsWith(query));

/** The draft once a skill is picked: its `/name`, a space, and the message that was already there. */
export const pickedDraft = (name: string, rest: string | null = null): string => `/${name} ${rest ?? ""}`;

/** The draft once Use a skill is pressed: a `/` before whatever was written, which it keeps. */
export const startedDraft = (draft: string): string => (draft === "" ? "/" : `/ ${draft}`);

/** The draft once the list is closed with Escape after Use a skill: the message as it was. */
export const dismissedDraft = (draft: string, slash: SlashQuery): string =>
  slash.query === "" && slash.rest !== null ? slash.rest : draft;

/** The composer's `/` for the hob, from its skills query: the skills once loaded, and until then whether it is still loading or failed. */
export const skillPicking = (
  query: { readonly data: HobSkills | undefined; readonly isError: boolean; readonly refetch: () => unknown },
  hobName: string,
): SkillPicking => ({
  hobName,
  skills: pickerSkills(query.data, hobName),
  status: query.data !== undefined ? "ready" : query.isError ? "failed" : "loading",
  onRetry: () => void query.refetch(),
});
