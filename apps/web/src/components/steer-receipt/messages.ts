import { formatList } from "../../lib/format.ts";

/** Copy for steer receipts in the chat and your notes in each hob's work in a quest (ADR 027, STD-I18N-001). */
export const messages = {
  /** The receipt's name, read before its steps. */
  label: "Where your message went",
  /** What the receipt shows of the lead, as its turn reads your message and after. */
  lead: {
    reading: ({ name }: { name: string }) => `${name} is reading…`,
    gotIt: ({ name }: { name: string }) => `${name} got it`,
    gotItPassing: ({ name }: { name: string }) => `${name} got it →`,
  },
  /** What the receipt shows of each hob the note was passed on to. */
  hop: {
    passing: ({ name }: { name: string }) => `passing to ${name}…`,
    held: ({ name, action }: { name: string; action: string }) =>
      `Held: ${name} is waiting on your approval: ${action}`,
    picked: ({ name }: { name: string }) => `${name} picked it up`,
    pickedPassing: ({ name }: { name: string }) => `${name} picked it up →`,
    unread: ({ name }: { name: string }) => `${name} never read it`,
    sent: ({ name }: { name: string }) => `Sent to ${name}`,
    waiting: ({ name }: { name: string }) => `Waiting for ${name}'s turn`,
    interrupting: ({ name }: { name: string }) => `Interrupting ${name}'s turn`,
  },
  /** One whole sentence per step, for screen readers. */
  say: {
    reading: ({ name }: { name: string }) => `${name} is reading your message.`,
    gotIt: ({ name }: { name: string }) => `${name} got your message.`,
    passing: ({ from, name }: { from: string; name: string }) => `${from} is passing it to ${name}.`,
    held: ({ name, action }: { name: string; action: string }) =>
      `Your note is held: ${name} is waiting on your approval: ${action}.`,
    picked: ({ name }: { name: string }) => `${name} picked it up.`,
    unread: ({ name }: { name: string }) => `${name} never read it.`,
    sent: ({ name }: { name: string }) => `Your message was sent to ${name}.`,
    waiting: ({ name }: { name: string }) => `Your message waits for ${name}'s turn to reach it.`,
    interrupting: ({ name }: { name: string }) => `Your message is interrupting ${name}'s turn.`,
  },
  /** Your notes as chips in the lanes. */
  chip: {
    yours: ({ text }: { text: string }) => `Your note: ${text}`,
    via: ({ name }: { name: string }) => `Your note, via ${name}`,
    passed: ({ names }: { names: ReadonlyArray<string> }) => `Passed it to ${formatList(names)}`,
  },
  notes: "Your notes",
} as const;
