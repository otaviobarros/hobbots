import { formatCount } from "../../lib/format.ts";

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
    /** Where an entry from another chat or camp waits, as a link there. */
    waitsIn: ({ place }: { place: string }) => `Waits in ${place}`,
  },
  details: { approval: "Why, risk and who asked", question: "Who asked", stuck: "Tries and the error" },
} as const;
