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
  );

/** A stretch of a text, by UTF-16 offsets, `from` included and `to` not. */
export interface TextRange {
  readonly from: number;
  readonly to: number;
}

/** Which parts of a text to read for mentions, and which to skip; see `mentionsIn`. */
export interface MentionScope {
  /**
   * Read only the mentions whose name ends past this offset, for text that grew after its start was
   * parsed, such as a reply continued with Continue: what that start mentioned was decided then,
   * against the roster of then, and is never read again. Zero reads the whole text.
   */
  readonly after?: number;
  /**
   * Stretches that mention nobody, such as the text's Markdown code. Finding them is the caller's: a
   * CommonMark parser does it outside the domain, which reads no Markdown itself.
   */
  readonly skip?: ReadonlyArray<TextRange>;
}

/**
 * Whether each offset asked, in increasing order, falls in one of the ranges. The ranges are sorted
 * once and passed by moving forward, so a text with many `@` and many ranges stays linear.
 */
const insideOf = (ranges: ReadonlyArray<TextRange>) => {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  let next = 0;
  let reach = -1;
  return (at: number): boolean => {
    while (next < sorted.length && (sorted[next]?.from ?? 0) <= at) {
      reach = Math.max(reach, sorted[next]?.to ?? 0);
      next++;
    }
    return at < reach;
  };
};

/**
 * The hobs and people a message's text @mentions (ADR 039, Who answers), in the order they are first
 * mentioned, each once. The hub parses a message once, when it stores it, into `Message.mentions`, so
 * who answers and who is told read the same list.
 *
 * A mention is `@` and a roster name, matched without regard to case, where the `@` starts the text
 * or follows something other than a letter or a digit (so `ana@pip.dev` mentions nobody) and the name
 * ends at something other than a letter or a digit. Of two names that both fit, the longer wins. An
 * `@` in a range of `scope.skip` mentions nobody.
 */
export const mentionsIn = (
  text: string,
  roster: ReadonlyArray<Mentionable>,
  scope: MentionScope = {},
): ReadonlyArray<Actor> => {
  if (!text.includes("@")) return [];
  const { after = 0, skip = [] } = scope;
  const names = byLongestName(roster);
  const skipped = insideOf(skip);
  const found: Array<Actor> = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (skipped(at) || isWordChar(text[at - 1])) continue;
    const entry = namedAt(text, at, names);
    if (entry === undefined || at + 1 + entry.length <= after) continue;
    if (!found.some((seen) => sameActor(seen, entry.actor))) found.push(entry.actor);
  }
  return found;
};

/** Whether the message mentions the actor: a mention of you, which is counted for you alone. */
export const mentions = (message: { readonly mentions: ReadonlyArray<Actor> }, actor: Actor): boolean =>
  message.mentions.some((mentioned) => sameActor(mentioned, actor));
