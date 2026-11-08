/** User-facing copy for the line a reply leaves for each skill it used (STD-I18N-001). */
export const messages = {
  label: ({ name }: { name: string }) => `Skills ${name} used`,
  used: "Used",
  /** After the skill's name: its revision, such as "(r4)", or that it came from your organization. */
  revision: ({ number }: { number: number }) => `(r${number})`,
  organization: "(from your organization)",
  /** After the skill's name, in a chat that tries a draft (ADR 029, Try in a chat). */
  draft: "(the draft)",
  /** After the skill's name, for a skill from a set: the set it comes from, before the set's revision. */
  fromSet: ({ set }: { set: string }) => `from ${set}`,
  open: "Open",
  openLabel: ({ title }: { title: string }) => `Open ${title}`,
  picker: {
    /** The `/` list's name and its heading. */
    label: ({ name }: { name: string }) => `${name}'s skills`,
    heading: ({ name }: { name: string }) => `${name}'s skills · type to filter`,
    hint: ({ name }: { name: string }) =>
      `↑ ↓ to move · Enter to pick · ${name} uses the skill for this message, on Claude Code or Codex`,
    none: ({ name }: { name: string }) => `No skill of ${name}'s starts with that.`,
    noSkills: ({ name }: { name: string }) => `${name} has no skills yet.`,
    loading: ({ name }: { name: string }) => `Loading ${name}'s skills…`,
    failed: ({ name }: { name: string }) => `Hobbots could not read ${name}'s skills.`,
    retry: "Try again",
    everyone: "Everyone",
    own: ({ name }: { name: string }) => `${name}'s own`,
    project: ({ name }: { name: string }) => `${name} project`,
    onlyWhenAsked: "only when asked",
    /** In a chat that tries a draft, where the `/` list's one skill comes from. */
    draft: "The draft this chat tries",
    /** The composer's button that starts a `/`. */
    useSkill: "Use a skill",
  },
};
