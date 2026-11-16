import { formatCount, plural } from "../../lib/format.ts";

interface Named {
  readonly name: string;
}

const count = (n: number, one: string, other: string) => `${formatCount(n)} ${plural(n, { one, other })}`;

/** User-facing copy for who is in a camp (STD-I18N-001): hobs and people, never members of a channel. */
export const messages = {
  picker: {
    label: "Members",
    chosen: "Picked",
    you: "You",
    /** The first hob picked, which leads the camp's quests. */
    leads: ({ name }: Named) => `${name} · lead`,
    hobs: "Hobs",
    noRole: "Hob",
    lockedLine: "Its chapter moves into the camp",
    tick: "✓",
    failed: "Couldn't read your other hobs. Hobbots may be reconnecting.",
    retry: "Try again",
    note: "The first hob you pick leads the quests asked here. With several hobs, only the ones you @mention answer. People join once they have an account on this hub.",
  },
  sheet: {
    /** The header's button, with how many are in the camp besides you. */
    button: ({ total }: { readonly total: number }) => `Members: ${formatCount(total)}`,
    eyebrow: ({ people, hobs }: { readonly people: number; readonly hobs: number }) =>
      people <= 1
        ? `Camp · you and ${count(hobs, "hob", "hobs")}`
        : `Camp · ${count(people, "person", "people")}, ${count(hobs, "hob", "hobs")}`,
    goal: ({ goal }: { readonly goal: string }) => `Goal: ${goal}`,
    close: "Close",
    several:
      "With several hobs here, only the hobs you @mention answer. One hob speaks at a time, and hobs can answer each other up to 3 times in a row, then wait for a person.",
    one: "The hob here answers every message. Add another hob and only the hobs you @mention answer.",
    hobs: ({ total }: { readonly total: number }) => `Hobs · ${formatCount(total)}`,
    people: ({ total }: { readonly total: number }) => `People · ${formatCount(total)}`,
    addHob: "Add a hob",
    adding: "Pick a hob to add",
    add: ({ name }: Named) => `Add ${name}`,
    noneToAdd: "Every hob that takes new work is here already.",
    doneAdding: "Done",
    lead: "Lead",
    owner: "Owner",
    member: "Member",
    ownerLine: "Notifies you on mentions",
    remove: ({ name }: Named) => `Take ${name} out of this camp`,
    removing: ({ name }: Named) => `Taking ${name} out…`,
    speaking: "Answering now",
    waiting: "Next, waiting its turn",
    idle: "Idle",
    answeredAt: ({ time }: { readonly time: string }) => `Idle · answered at ${time}`,
    answeredOn: ({ day }: { readonly day: string }) => `Idle · answered ${day}`,
    left: "Retired, so not answering here",
    turns: ({ turns }: { readonly turns: number }) => count(turns, "turn", "turns"),
    tokens: ({ tokens }: { readonly tokens: string }) => `${tokens} tokens`,
    cost: "Today's cost",
    plan: ({ provider }: { readonly provider: string }) => `${provider} plan`,
    noPlan: "Plan not reported",
    plansLoading: "Reading the plan…",
    plansFailed: "Couldn't read",
    plansFailedLong: "Couldn't read your plans. Hobbots may be reconnecting.",
    /** What the camp's hobs spent here today, on the owner's sign-in: yours when `owner` is null. */
    here: ({
      turns,
      tokens,
      owner,
    }: {
      readonly turns: number;
      readonly tokens: string;
      readonly owner: string | null;
    }) =>
      `${count(turns, "turn", "turns")} here today · ${tokens} tokens. Every turn runs on ${owner === null ? "your" : `${owner}'s`} sign-in, whoever asked.`,
    memory:
      "Each hob keeps its own memory and reads only that. Make the camp private and nothing said here is saved to any hob's memory.",
    loading: "Reading who is here…",
    failed: "Couldn't read who is here. Hobbots may be reconnecting.",
    retry: "Try again",
    archived: "This camp is archived. Bring it back from the Archive to change who is here.",
    errors: {
      archived: () => "This camp was archived. Bring it back from the Archive to change who is here.",
      "hob-unavailable": ({ name }: Named) => `${name} is paused or retired, so it can't join now.`,
      "leads-quest": ({ name }: Named) => `${name} leads a quest still open here, so it stays until that quest ends.`,
      refused: () => "That change isn't possible in this camp.",
      unreachable: () => "Couldn't change who is here. Hobbots may be reconnecting; try again in a moment.",
    },
  },
} as const;
