import { NOTE_TEXT_MAX } from "@hobbots/domain";
import { formatCount } from "../../lib/format.ts";

/** User-facing copy for notes to self and pins in a chat or camp (ADR 037, Mine; STD-I18N-001). */
export const messages = {
  toggle: "Note to self",
  placeholder: "Write a note to self…",
  hint: "Note to self · only you · no hob wakes",
  save: "Save the note",
  saving: "Saving the note…",
  saved: "Saved under Mine · no hob woke",
  failed: "Couldn't save the note. Your text is back in the box; try again in a moment.",
  tooLong: `Keep a note to ${formatCount(NOTE_TEXT_MAX)} characters.`,
  /** Above a note in the transcript. */
  meta: ({ time }: { readonly time: string }) => `Note to self · only you · ${time}`,
  menu: {
    more: "More for this message",
    split: "Split here",
    pin: "Pin",
    unpin: "Unpin",
    pinning: "Pinning…",
  },
  pinned: "Pinned",
  pinMark: "◆",
  pinnedToast: "Pinned. Find it under Mine.",
  unpinnedToast: "Unpinned.",
  pinFailed: "Couldn't change the pin. Hobbots may be reconnecting.",
};
