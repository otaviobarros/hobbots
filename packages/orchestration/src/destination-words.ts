/**
 * How Hobbots words the choices that let a place the user asked for go (#1215, #1219). It imports
 * nothing, so the briefs and the destination checks can both read it without a cycle between them.
 */

/** The consequence of a choice that moves a file the user named to `to` instead, as they pick it. */
const deliveredInstead = (to: string, from: string) => `Not delivered at ${from}: delivered at ${to} instead.`;

/** The consequence of a choice that leaves nothing at a file the user named, as they pick it. */
const leftEmpty = (path: string) => `Not delivered at ${path}: nothing is left there.`;

export const INSTEAD = /^Not delivered at (.+): delivered at (.+) instead\.$/;
export const EMPTY = /^Not delivered at (.+): nothing is left there\.$/;

/**
 * How a question to the user about a place they asked for is worded, so the choice they pick lets it
 * go. A lead hears it before its first such question, not only once the hub refuses a completion
 * (#1219), and never recommends that the user deliver the work themselves.
 */
export const DESTINATION_WORDING =
  "Only a choice the user picks lets the place go, and only with its consequence worded exactly as Hobbots words it: " +
  `"${deliveredInstead("<new absolute path>", "<the path they asked for>")}" for another place, or "${leftEmpty("<the path they asked for>")}" when nothing should be there, ` +
  "offered beside a choice to keep the place they asked for. Never recommend a choice that leaves the delivery to the user, such as moving the file by hand: delivering it is the work.";
