import { formatCount, plural } from "../../lib/format.ts";

/** User-facing copy for the Needs-you tray above the composer (STD-I18N-001). */
export const messages = {
  label: ({ index, count }: { index: number; count: number }) =>
    `Needs you, ${formatCount(index)} of ${formatCount(count)}`,
  eyebrow: { needs: "Needs you", risk: "Needs you · high risk", stuck: "Stuck" },
  position: ({ index, count }: { index: number; count: number }) => `${formatCount(index)} of ${formatCount(count)}`,
  next: "Next",
  seeAll: "See all in Inbox",
  approvalTitle: ({ name, action }: { name: string; action: string }) => `${name} asks to ${action}`,
  questionTitle: ({ name }: { name: string }) => `${name} asks you`,
  stuckTitle: ({ name }: { name: string }) => `${name}'s work is stuck`,
  passedUp: ({ names, task, when }: { names: ReadonlyArray<string>; task: string; when: string }) =>
    `${[...names, "you"].join(" → ")} · about ${task} · asked ${when}`,
  /** A question the hub itself asks (#976): no lead passed it up. */
  fromHub: ({ about, when }: { about: string; when: string }) => `Your hub → you · about ${about} · asked ${when}`,
  /** The tray's scope in a chat or camp (#1423): what waits there, or everywhere. */
  scope: {
    label: "Show what waits",
    here: ({ kind }: { kind: "chat" | "camp" }) => (kind === "camp" ? "This camp" : "This chat"),
    everywhere: "Everywhere",
    /** The tray of a chat or camp where nothing waits while something waits elsewhere. */
    elsewhereLabel: "Waiting elsewhere",
    elsewhere: ({ kind, count }: { kind: "chat" | "camp"; count: number }) =>
      plural(count, {
        one: `Nothing waits in this ${kind}. 1 thing waits elsewhere.`,
        other: `Nothing waits in this ${kind}. ${formatCount(count)} things wait elsewhere.`,
      }),
    /** Where an entry from another chat or camp waits, as a link there. */
    waitsIn: ({ place }: { place: string }) => `Waits in ${place}`,
  },
  details: { approval: "Why, risk and who asked", question: "Who asked", stuck: "Tries and the error" },
} as const;
