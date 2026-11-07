import { formatCount, formatList, plural } from "../../lib/format.ts";

/** User-facing copy for a hob's skill proposal, in the Inbox (ADR 029, STD-I18N-001). */
export const messages = {
  whatNew: ({ who, title }: { who: string; title: string }) => `${who} drafted a skill: ${title}`,
  whatChange: ({ who, title }: { who: string; title: string }) => `${who} suggests a change to ${title}`,
  revisionNew: "new · r1",
  revisionChange: ({ from, to }: { from: number; to: number }) => `r${from} → r${to}`,
  file: ({ title }: { title: string }) => `${title} · SKILL.md`,
  destinationOwn: ({ who }: { who: string }) => `${who}'s own skills`,
  destinationEveryone: "every hob",
  destinationProjects: ({ count }: { count: number }) =>
    plural(count, { one: `${formatCount(count)} project`, other: `${formatCount(count)} projects` }),
  destinationHobs: ({ count }: { count: number }) =>
    plural(count, { one: `${formatCount(count)} hob`, other: `${formatCount(count)} hobs` }),
  destinationNone: "no hob yet",
  destination: ({ parts }: { parts: ReadonlyArray<string> }) => formatList(parts),
  addOwn: ({ who }: { who: string }) => `Add it for ${who}`,
  addRollOut: "Accept and roll out",
  addRollOutHobs: ({ count }: { count: number }) =>
    plural(count, {
      one: `Accept and roll out to ${formatCount(count)} hob`,
      other: `Accept and roll out to ${formatCount(count)} hobs`,
    }),
  editThenAdd: "Edit, then add",
  notNow: "Not now",
  editLabel: "The skill to add",
  editHint: "Change it before it is added. It goes through the same checks as any skill you import.",
  addEdited: "Add it",
  cancelEdit: "Back",
  diffLabel: "The skill",
  added: "Added",
  removed: "Removed",
  footNew: "A new skill always waits for you, whatever the safety level. Edit it first if it needs a change.",
  footChange: ({ next }: { next: number }) =>
    `Every hob that uses it moves to r${next} from its next chat, unless you hold it on an older revision.`,
  footHeld: ({ count, next }: { count: number; next: number }) =>
    `${plural(count, { one: `${formatCount(count)} assignment is held and stays where it is`, other: `${formatCount(count)} assignments are held and stay where they are` })}. The others move to r${next} from their next chat.`,
  footSame: ({ number }: { number: number }) => `It is what r${number} already says, so adding it changes nothing.`,
  footEarlier: ({ number }: { number: number }) =>
    `It is what r${number} said, so adding it brings every hob that uses it back to r${number}, unless you hold it.`,
  flagsLabel: "Look at these first",
  flagScript: ({ path }: { path: string }) => `${path} is a script a hob can run.`,
  flagUrl: ({ path, url }: { path: string; url: string }) => `${path} links to ${url}.`,
  flagHidden: ({ path, codePoint }: { path: string; codePoint: string }) =>
    `${path} has characters you cannot see, such as ${codePoint}. Each is marked where it is.`,
  hiddenMark: ({ codePoint }: { codePoint: string }) => `hidden character ${codePoint}`,
  addAnyway: "Add it anyway",
  stale: ({ who, base, latest }: { who: string; base: number; latest: number }) =>
    `${who} changed r${base}, but the skill is on r${latest} now, so the change is shown against r${latest}.`,
  why: ({ who }: { who: string }) => `Why ${who} suggests it`,
  learnedFrom: "Learned from",
  learnedChat: "A chat",
  facts: { suggestedBy: "Suggested by" },
  outcomeAddedOwn: ({ title, who, number }: { title: string; who: string; number: number }) =>
    `Added ${title} r${number} for ${who}. ${who} uses it from its next chat.`,
  outcomeAddedChange: ({ title, number }: { title: string; number: number }) =>
    `Accepted. ${title} r${number} rolls out from each hob's next chat.`,
  outcomeSame: ({ title, number }: { title: string; number: number }) =>
    `Accepted. It is what ${title} r${number} already says, so the library is unchanged.`,
  outcomeEarlier: ({ title, number }: { title: string; number: number }) =>
    `Accepted. It is what ${title} r${number} said, so every hob that uses it goes back to r${number} from its next chat.`,
  outcomeEdited: "You edited it before you added it.",
  outcomeDeclined: ({ who }: { who: string }) => `Not now. ${who} is told, and the library is unchanged.`,
  outcomeAdding: "Adding it to the library…",
  closed: "Someone already decided this one.",
  refused: ({ message }: { message: string }) => `It was not added: ${message}`,
  failed: "That did not work. Try again.",
} as const;
