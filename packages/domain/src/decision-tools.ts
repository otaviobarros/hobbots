import { Schema } from "effect";
import { DECISION_TEXT_MAX } from "./decision.ts";
import { toolInputJsonSchema } from "./task-tools.ts";

/**
 * `record_decision` (ADR 037, Records), a hub tool on every runtime that serves hub tools: the hob
 * records what was decided in the chat or camp, so the decision outlives the transcript. The hub
 * checks every call; a changed decision is a new one that replaces the old, which is kept crossed out.
 */

export const RECORD_DECISION_TOOL = "record_decision";

export const RecordDecisionInput = Schema.Struct({
  key: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)).annotate({
    description:
      "A key you choose for this decision, unique among your calls in this reply. Send the same key when you retry the same call, so it is recorded once.",
  }),
  text: Schema.String.check(Schema.isNonEmpty()).annotate({
    description: `What was decided, in one or two plain sentences of at most ${DECISION_TEXT_MAX} characters, such as "Launch emails go out on Tuesdays at 9:00." Its first line is its title.`,
  }),
  replaces: Schema.optionalKey(
    Schema.String.check(Schema.isNonEmpty()).annotate({
      description:
        "The id of an earlier decision in this chat or camp that this one changes. The earlier one is kept, crossed out, and no longer holds.",
    }),
  ),
});
export type RecordDecisionInput = typeof RecordDecisionInput.Type;

export const RECORD_DECISION_DESCRIPTION = `Record a decision the user and you settled in this chat or camp, as soon as it is settled: a choice, a rule or a plan you will both hold to. Recorded decisions are carried into later turns and chapters, so record each one rather than relying on the conversation. Keep it to ${DECISION_TEXT_MAX} characters; a longer one is refused. When a decision changes, record the new one with replaces set to the old one's id: never record the same decision twice.`;

export const RECORD_DECISION_LABEL = "Recording a decision";

export const recordDecisionJsonSchema = (): Record<string, unknown> => toolInputJsonSchema(RecordDecisionInput);
