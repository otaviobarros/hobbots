import { formatCount, formatList, plural } from "../../lib/format.ts";

/** A hob's skills (ADR 029): its Skills tab, the list of what it carries, and the picker to give it one. */
export const messages = {
  tab: "Skills",
  intro: ({ name, count }: { name: string; count: number }) =>
    count === 0
      ? `${name} carries no skills yet. Give it one from your library, or give one to Everyone or a project it works in.`
      : `${name} carries ${formatCount(count)} ${plural(count, { one: "skill", other: "skills" })}. Before each chat it reads their names and descriptions, and opens one only when a task matches. Claude Code and Codex get the same set.`,
  failed: "Skills could not be read.",
  warnings: "Needs your hand",
  retry: "Try again",
  charm: {
    title: ({ skill, charm }: { skill: string; charm: string }) => `${skill} needs the ${charm} Charm`,
    body: ({ name, charm }: { name: string; charm: string }) =>
      `${name} has no ${charm} Charm, so this skill would stop halfway. Add the Charm, or turn the skill off for ${name}.`,
    add: "Add the Charm",
  },
  clash: {
    title: ({ skill }: { skill: string }) => `Two projects define ${skill}`,
    body: ({ name, projects }: { name: string; projects: ReadonlyArray<string> }) =>
      `${name} works in ${formatList(projects)}, and each gives a skill of this name, so ${name} loads neither. Give ${name} its own, or take one away.`,
  },
  lately: "Used lately",
  nothingLately: "Not used yet. A line under a reply says each time it uses one.",
  from: "Where they come from",
  everyone: "Everyone",
  project: ({ name }: { name: string }) => `${name} project`,
  own: ({ name }: { name: string }) => `${name}'s own`,
  everyoneLine: ({ names }: { names: ReadonlyArray<string> }) =>
    names.length === 0 ? "Nothing given to every hob yet." : formatList(names),
  projectLine: ({ name, identity, off }: { name: string; identity: string; off: ReadonlyArray<string> }) =>
    off.length === 0
      ? `${name} works in ${identity}`
      : `${name} works in ${identity} · ${formatList(off)} ${off.length === 1 ? "is" : "are"} off for ${name}`,
  ownLine: ({ names }: { names: ReadonlyArray<string> }) => (names.length === 0 ? "None yet." : formatList(names)),
  ofTotal: ({ loads, total }: { loads: number; total: number }) =>
    loads === total ? formatCount(total) : `${formatCount(loads)} of ${formatCount(total)}`,
  clean: ({ name }: { name: string }) =>
    `Only these load. Skills, plugins and MCP servers you installed in your own Claude Code or Codex never reach ${name}. Skills in ~/.agents/skills come in through Everyone.`,
  openInSkills: "Open in Skills",
  give: ({ name }: { name: string }) => `Give ${name} a skill…`,
  carries: {
    inSet: ({ set }: { set: string }) => `In ${set}`,
    title: ({ name }: { name: string }) => `${name}'s skills`,
    line: ({ name, count }: { name: string; count: number }) =>
      `${formatCount(count)} ${plural(count, { one: "skill", other: "skills" })} load for ${name}. Claude Code and Codex load the same set, and nothing else.`,
    fromEveryone: "From Everyone",
    fromProject: ({ name }: { name: string }) => `From the ${name} project`,
    because: ({ name, identity }: { name: string; identity: string }) => `Because ${name} works in ${identity}`,
    own: ({ name }: { name: string }) => `${name}'s own`,
    none: "None",
    noneOwn: ({ name }: { name: string }) => `None yet. Give ${name} a skill and it shows here.`,
    uses: ({ name, skill }: { name: string; skill: string }) => `${name} uses ${skill}`,
    off: ({ name }: { name: string }) => `Off for ${name}`,
    onlyWhenAsked: "Only when asked",
    needs: ({ charm }: { charm: string }) => `Needs the ${charm} Charm`,
    available: ({ rev, held }: { rev: string; held: boolean }) =>
      held ? `Kept on an older revision · ${rev} available` : `An older revision · ${rev} available`,
    replaced: ({ by }: { by: string }) => `Not loaded: ${by}'s own loads instead`,
    clash: "Two projects define it",
    turnedOff: ({ name, skill }: { name: string; skill: string }) => `${skill} is off for ${name} from its next chat.`,
    turnedOn: ({ name, skill }: { name: string; skill: string }) => `${name} gets ${skill} again from its next chat.`,
    failed: "That did not change. Try again.",
    foot: ({ name }: { name: string }) =>
      `Turning a shared skill off here changes only ${name}. A skill of ${name}'s own with the same name as a shared one replaces it for ${name}.`,
  },
  picker: {
    title: ({ name }: { name: string }) => `Give ${name} a skill from your library`,
    close: "Close",
    give: ({ name }: { name: string }) => `Give to ${name}`,
    turnOn: ({ name }: { name: string }) => `Turn on for ${name}`,
    notGiven: "Not given to anyone yet",
    offFor: ({ scope, name }: { scope: string; name: string }) => `${scope} · off for ${name}`,
    foot: ({ name }: { name: string }) => `${name} gets it from its next chat, pinned to the revision shown.`,
    empty: ({ name }: { name: string }) => `Every skill in your library already reaches ${name}.`,
    emptyLibrary: "Your library has no skills yet. Add one on the Skills page.",
    given: ({ name, skill }: { name: string; skill: string }) => `${name} gets ${skill} from its next chat.`,
    failed: "It was not given. Try again.",
  },
  summon: {
    label: "Skills",
    everyone: ({ count }: { count: number }) =>
      count === 0
        ? "No skills are given to every hob yet."
        : `Gets Everyone's ${formatCount(count)} ${plural(count, { one: "skill", other: "skills" })}, and those of the projects it works in.`,
    picked: ({ names }: { names: ReadonlyArray<string> }) => `Also gets ${formatList(names)}.`,
    choose: "Give it a skill…",
    notGiven: ({ name }: { name: string }) => `${name} is here, but the skills you picked were not given yet.`,
    openTab: "Give them from its Skills tab",
  },
};
