import { Schema } from "effect";
import { holdsEveryTaskTool, toolInputJsonSchema } from "./task-tools.ts";

/**
 * The `pass` tool (ADR 039, One hob speaks at a time): Hobbots' own hub tool, served on every
 * runtime in every chat turn, never a Charm. A hob asked to answer that has nothing to add ends its
 * turn with no message and a reason, so two hobs never say the same thing. Its request ends
 * `passed`, and the conversation records "Pip passed: Quill covered it".
 */
export const PASS_TOOL = "pass";

export const PASS_LABEL = "Passing";

/** The longest reason a pass keeps. */
export const PASS_REASON_MAX = 200;

export const PASS_DESCRIPTION = `End your turn with no message, when you were asked to answer but have nothing to add, such as when another hob already covered it. Give a short reason, such as "Quill covered it": the conversation shows that you passed and why, and nothing else of this turn. Call it before you write anything or use any other tool, then end your turn without writing more. Never pass a question only you can answer.`;

export const PassInput = Schema.Struct({
  reason: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(PASS_REASON_MAX)).annotate({
    description: `Why you pass, in a few words, at most ${PASS_REASON_MAX} characters, such as "Quill covered it".`,
  }),
});
export type PassInput = typeof PassInput.Type;

export const passJsonSchema = (): Record<string, unknown> => toolInputJsonSchema(PassInput);

/** How a pass reads in the conversation: "Pip passed: Quill covered it". */
export const passLine = (hobName: string, reason: string): string => `${hobName} passed: ${reason}`;

/**
 * Whether a session that keeps the hub tools it started with, as Codex does (ADR 024), holds what
 * every chat turn offers: `pass`, and every Task tool when the hub offers them (#1543). One that
 * started before `pass` existed, or whose tools are not known, does not, and is not resumed.
 */
export const holdsEveryChatTool = (held: ReadonlyArray<string> | undefined, withTaskTools: boolean): boolean =>
  held?.includes(PASS_TOOL) === true && (!withTaskTools || holdsEveryTaskTool(held));
