import { Schema } from "effect";

/**
 * How a hob talks: one voice and one length, picked apart so a hob can be both brief and friendly.
 * Each choice carries the line the runtime is told, fixed here so it can be tested and evaluated.
 * The defaults add nothing, so a hob nobody tuned talks the way Hobbots always has.
 */

export const Voice = Schema.Literals([
  "default",
  "friendly",
  "professional",
  "candid",
  "efficient",
  "technical",
  "professor",
  "mentor",
  "skeptic",
  "bard",
  "wizard",
  "pirate",
  "noir",
  "shakespearean",
]);
export type Voice = typeof Voice.Type;

export const ReplyLength = Schema.Literals(["brief", "balanced", "detailed"]);
export type ReplyLength = typeof ReplyLength.Type;

export const DEFAULT_VOICE: Voice = "default";
export const DEFAULT_LENGTH: ReplyLength = "balanced";

/** The picker's groups. Themed voices change the wording only, and say so. */
export const VoiceGroup = Schema.Literals(["everyday", "expert", "themed"]);
export type VoiceGroup = typeof VoiceGroup.Type;

export interface ToneChoice<Id extends string> {
  readonly id: Id;
  readonly title: string;
  /** The one line the picker shows under the title. */
  readonly description: string;
  /** What the runtime is told, or null for a default that adds nothing. */
  readonly line: string | null;
}

export interface VoiceChoice extends ToneChoice<Voice> {
  readonly group: VoiceGroup;
}

/** The voice groups in the order the picker lists them. */
export const VOICE_GROUPS: ReadonlyArray<{ readonly id: VoiceGroup; readonly title: string }> = [
  { id: "everyday", title: "Everyday" },
  { id: "expert", title: "Expert" },
  { id: "themed", title: "Themed" },
];

/** Every voice, in the picker's order. */
export const VOICES: ReadonlyArray<VoiceChoice> = [
  { id: "default", group: "everyday", title: "Default", description: "Hobbots' usual voice", line: null },
  {
    id: "friendly",
    group: "everyday",
    title: "Friendly",
    description: "Warm and chatty",
    line: "Talk like a warm, friendly colleague: casual words, a little encouragement, never stiff.",
  },
  {
    id: "professional",
    group: "everyday",
    title: "Professional",
    description: "Polished and precise",
    line: "Talk like a polished professional: precise, courteous and well organized, with no slang or jokes.",
  },
  {
    id: "candid",
    group: "everyday",
    title: "Candid",
    description: "Direct and encouraging",
    line: "Be direct: say plainly what is wrong or risky and what you would do instead, kindly but without softening the point.",
  },
  {
    id: "efficient",
    group: "everyday",
    title: "Efficient",
    description: "Plain, no small talk",
    line: "Be plain and to the point: no greetings, no filler, no restating the question.",
  },
  {
    id: "technical",
    group: "expert",
    title: "Technical",
    description: "Exact terms, code and numbers first",
    line: "Talk like a senior specialist to a peer: use exact technical terms without explaining the basics, and lead with the code, numbers or commands.",
  },
  {
    id: "professor",
    group: "expert",
    title: "Professor",
    description: "Explains the why, step by step",
    line: "Teach like a good professor: explain why, not just what, build up from the basics step by step, and give a concrete example.",
  },
  {
    id: "mentor",
    group: "expert",
    title: "Mentor",
    description: "Helps you work it out yourself",
    line: "Act as a mentor: when the user asks how or why, guide them with hints and a question before giving the full answer; when they ask you to do something, do it and explain the key step.",
  },
  {
    id: "skeptic",
    group: "expert",
    title: "Skeptic",
    description: "Questions assumptions, flags risks",
    line: "Be a constructive skeptic: question assumptions, point out risks and weak evidence, and say how sure you are. Stay respectful, never sarcastic.",
  },
  {
    id: "bard",
    group: "themed",
    title: "Bard",
    description: "Tells it like a tale",
    line: "Speak as a hob bard: tell your replies like a short tale, with a little rhyme or flourish.",
  },
  {
    id: "wizard",
    group: "themed",
    title: "Old wizard",
    description: "Grand and a little cryptic",
    line: "Speak as an old hob wizard: grand, a little cryptic and fond of lore, yet always clear in the end.",
  },
  {
    id: "pirate",
    group: "themed",
    title: "Pirate",
    description: "Salty and swaggering",
    line: "Speak like a pirate: nautical slang and swagger.",
  },
  {
    id: "noir",
    group: "themed",
    title: "Noir detective",
    description: "Terse and moody",
    line: "Speak like a hard-boiled noir detective: terse, moody, first-person narration.",
  },
  {
    id: "shakespearean",
    group: "themed",
    title: "Shakespearean",
    description: "Thee, thou and flourish",
    line: "Speak in Shakespearean English: thee, thou and the flourish of the Elizabethan stage.",
  },
];

/** Every length, in the picker's order. */
export const REPLY_LENGTHS: ReadonlyArray<ToneChoice<ReplyLength>> = [
  {
    id: "brief",
    title: "Brief",
    description: "A few sentences",
    line: "Keep replies short: a few sentences or a short list, unless the user asks for more.",
  },
  { id: "balanced", title: "Balanced", description: "Hobbots' usual length", line: null },
  {
    id: "detailed",
    title: "Detailed",
    description: "Reasoning, edge cases, next steps",
    line: "Be thorough: cover the reasoning, edge cases and next steps, using headings or lists when they help.",
  },
];

/** Follows every themed voice, so the costume never touches facts, code or warnings. */
export const THEMED_VOICE_GUARD =
  "This voice is a costume for your wording only. Keep facts as accurate as ever. Write code, commands, file contents, commit messages, links and warnings plainly, outside the voice. Drop the voice when the user is upset or the matter is serious.";

export const voiceChoice = (id: Voice): VoiceChoice => {
  const voice = VOICES.find((v) => v.id === id);
  if (voice === undefined) throw new Error(`Unknown voice: ${id}`);
  return voice;
};

export const lengthChoice = (id: ReplyLength): ToneChoice<ReplyLength> => {
  const length = REPLY_LENGTHS.find((l) => l.id === id);
  if (length === undefined) throw new Error(`Unknown reply length: ${id}`);
  return length;
};

/**
 * The lines that tell the runtime how the hob talks: the voice, then the length, then the guard a
 * themed voice needs. Empty when both are at their defaults.
 */
export const toneLines = (voice: Voice, length: ReplyLength): ReadonlyArray<string> => {
  const v = voiceChoice(voice);
  const lines = [v.line, lengthChoice(length).line, v.group === "themed" ? THEMED_VOICE_GUARD : null];
  return lines.filter((line) => line !== null);
};
