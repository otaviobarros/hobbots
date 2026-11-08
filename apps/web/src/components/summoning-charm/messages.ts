import type { CharmOperationId } from "@hobbots/domain";
import type { SummoningGroupId } from "./summoning-model.ts";

/** The copy of the Summoning Charm on a hob's Charms tab and of "Summoning for every hob" in Settings (ADR 034). */
export const messages = {
  hob: {
    name: "Summoning",
    card: "Summoning Charm",
    grant: ({ name }: { name: string }) => `Let ${name} summon and manage hobs`,
    state: { off: "Off", own: "On", "every-hob": "On · for every hob" },
    on: ({ name }: { name: string }) =>
      `Summons, changes, pauses and retires hobs within what you set here, and never wider than ${name}.`,
    offLine: ({ name }: { name: string }) => `Off for ${name}.`,
    off: ({ name }: { name: string }) => `${name} can't summon or change hobs. It hands that work to a hob that can.`,
    fromEveryHob: ({ name }: { name: string }) =>
      `${name} has it from Summoning for every hob. A change here gives ${name} its own.`,
    everyHobLink: "Summoning for every hob",
    who: ({ name }: { name: string }) => `Who ${name} may manage`,
    mayDo: ({ name }: { name: string }) => `What ${name} may set`,
    note: ({ name }: { name: string }) =>
      `Ask puts the call in your Inbox first, and "Always allow" on its card sets the field to Allow here. A hob ${name} summons or changes never gets more than ${name} has.`,
    saveFailed: "Hobbots could not save that change. Try again.",
  },
  everyHob: {
    name: "Summoning for every hob",
    on: "Every hob you made can summon and manage hobs, within what you set here. Hobs a hob summoned never get it.",
    off: "Off. Give Summoning to one hob at a time on its Charms tab, or to every hob you made here.",
    who: "Who each hob may manage",
    mayDo: "What each hob may set",
    note: "A hob's own Charms tab can take Summoning away from that hob, or give it its own scope and answers.",
    saveFailed: "Hobbots could not save that change. Try again.",
  },
  scope: {
    summoned: "Hobs it summoned",
    summonedNote: ({ name }: { name: string }) => `Change, pause and retire the hobs ${name} summoned.`,
    self: "Can manage itself",
    selfNote:
      "Change its own name, good at, look, voice, AI and instructions when you ask. Never its folders, Charms or rules.",
    picked: "Hobs you pick",
    pickedList: "Hobs you picked",
    pickedNote: ({ name }: { name: string }) => `Also these hobs, as long as they are within what ${name} has.`,
    nonePicked: ({ name }: { name: string }) => `None yet. Add a hob ${name} may also change.`,
    add: "Add a hob",
    noMore: "Every hob is picked.",
    remove: ({ hob }: { hob: string }) => `Remove ${hob}`,
    someHob: "A retired hob",
    theHob: "the hob",
  },
  answers: { allow: "Allow", ask: "Ask", deny: "Never", once: "Ask once" },
  groups: {
    new: "New hobs",
    who: "Who they are",
    look: "How they look",
    talk: "How they talk",
    work: "How they work",
    pause: "Pausing and retiring",
    self: ({ name }: { name: string }) => `${name} changing itself`,
  } satisfies Record<SummoningGroupId, unknown>,
  fields: {
    "summoning.summon": { label: "Summon new hobs", note: "One card per call, a row per hob." },
    "summoning.name": { label: "Name", note: "" },
    "summoning.role": { label: "Role", note: "A starter role or a title of its own." },
    "summoning.good-at": { label: "Good at", note: "When other hobs should come to it." },
    "summoning.look": { label: "Look and colour", note: "" },
    "summoning.sigil": { label: "Sigil", note: "" },
    "summoning.hat": { label: "Hat", note: "" },
    "summoning.tool": { label: "Tool it holds", note: "" },
    "summoning.voice": { label: "Voice", note: "" },
    "summoning.length": { label: "Reply length", note: "" },
    "summoning.instructions": { label: "Instructions", note: "" },
    "summoning.brain": { label: "AI and model", note: "" },
    "summoning.effort": { label: "Effort", note: "" },
    "summoning.folders": { label: "Folders", note: "Only folders it has itself." },
    "summoning.charms": { label: "Charms and their rules", note: "Only Charms it has itself, never Summoning." },
    "summoning.pause": { label: "Pause and wake", note: "" },
    "summoning.retire": { label: "Retire", note: "Always asks you once, with the confirmation box." },
    "summoning.self-name": { label: "Its name", note: "" },
    "summoning.self-good-at": { label: "What it is good at", note: "" },
    "summoning.self-look": { label: "Its look", note: "" },
    "summoning.self-voice": { label: "Its voice and reply length", note: "" },
    "summoning.self-brain": { label: "Its AI, model and effort", note: "" },
    "summoning.self-instructions": { label: "Its instructions", note: "Each change shows a before and after." },
  } satisfies Record<CharmOperationId, { readonly label: string; readonly note: string }>,
};

/** A field row's words, by its operation. */
export const fieldWords = (operation: CharmOperationId): { readonly label: string; readonly note: string } =>
  (messages.fields as Readonly<Record<string, { readonly label: string; readonly note: string }>>)[operation] ?? {
    label: operation,
    note: "",
  };
