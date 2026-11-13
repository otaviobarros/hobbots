import { type Actor, sameActor } from "./actor.ts";

/**
 * A hob or a person a message can @mention (ADR 039, Who answers): the actor and the name people
 * write after `@`. The roster holds every hob and person of the hub, not only a thread's members,
 * so a mention of a hob outside the camp is still found, and refused, rather than read as text.
 */
export interface Mentionable {
  readonly actor: Actor;
  readonly name: string;
}

/** Letters, digits and `_`: a mention never starts right after one, nor stops right before one. */
const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/**
 * The text with its Markdown code blanked out: fenced blocks and inline spans, so `@Pip` in code is
 * never a mention. Each character keeps its place, so offsets still match the text. Linear: one pass,
 * no pattern (STD-SEC-005).
 */
const withoutCode = (text: string): string => {
  let out = "";
  let fenced = false;
  let inline = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] ?? "";
    if (text.startsWith("```", i)) {
      fenced = !fenced;
      inline = false;
      out += "   ";
      i += 2;
    } else if (char === "\n") {
      // An inline span never runs past its line.
      inline = false;
      out += char;
    } else if (char === "`" && !fenced) {
      inline = !inline;
      out += " ";
    } else {
      out += fenced || inline ? " " : char;
    }
  }
  return out;
};

/**
 * The roster's names, longest first, so `@Pip Two` finds "Pip Two" before "Pip", each with the form
 * it is compared in. Blank names are left out.
 */
const byLongestName = (roster: ReadonlyArray<Mentionable>) =>
  roster
    .map((entry) => {
      const name = entry.name.trim();
      return { actor: entry.actor, length: name.length, folded: name.toLowerCase() };
    })
    .filter((entry) => entry.length > 0)
    .sort((a, b) => b.length - a.length);

/**
 * The roster entry named right after the `@` at `at`, or undefined when no name stands there whole.
 * Each name is cut from the text at its own length before the case is folded, since folding can
 * change a string's length.
 */
const namedAt = (text: string, at: number, names: ReturnType<typeof byLongestName>) =>
  names.find(
    (entry) =>
      text.slice(at + 1, at + 1 + entry.length).toLowerCase() === entry.folded &&
      !isWordChar(text[at + 1 + entry.length]),
  )?.actor;

/**
 * The hobs and people a message's text @mentions (ADR 039, Who answers), in the order they are first
 * mentioned, each once. Parsed once, when the message is stored, into `Message.mentions`, so who
 * answers and who is told read the same list.
 *
 * A mention is `@` and a roster name, matched without regard to case, where the `@` starts the text
 * or follows something other than a letter or a digit (so `ana@pip.dev` mentions nobody) and the name
 * ends at something other than a letter or a digit. Of two names that both fit, the longer wins.
 * Markdown code, fenced or inline, mentions nobody.
 */
export const mentionsIn = (text: string, roster: ReadonlyArray<Mentionable>): ReadonlyArray<Actor> => {
  if (!text.includes("@")) return [];
  const names = byLongestName(roster);
  const plain = withoutCode(text);
  const found: Array<Actor> = [];
  for (let at = plain.indexOf("@"); at !== -1; at = plain.indexOf("@", at + 1)) {
    if (isWordChar(plain[at - 1])) continue;
    const actor = namedAt(plain, at, names);
    if (actor !== undefined && !found.some((seen) => sameActor(seen, actor))) found.push(actor);
  }
  return found;
};

/** Whether the message mentions the actor: a mention of you, which is counted for you alone. */
export const mentions = (message: { readonly mentions: ReadonlyArray<Actor> }, actor: Actor): boolean =>
  message.mentions.some((mentioned) => sameActor(mentioned, actor));
