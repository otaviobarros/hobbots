import { Schema } from "effect";
import { toolInputJsonSchema } from "./task-tools.ts";
import {
  WORK_QUEST_DONE_WHEN_MAX,
  WORK_QUEST_GOAL_MAX,
  WORK_QUEST_LINE_MAX,
  WORK_QUEST_MADE_MAX,
  WORK_QUEST_RESULT_MAX,
  WORK_QUEST_TITLE_MAX,
} from "./work-quest.ts";

/**
 * The Quest tools (ADR 041): Hobbots' own hub tools on every runtime that serves hub tools, never a
 * Charm. `start_work` starts a Quest where the hob is talking, and `finish_work` ends the hob's
 * running Quest there. The hub checks every call, so what a hob writes decides nothing.
 */
export const START_WORK_TOOL = "start_work";
export const FINISH_WORK_TOOL = "finish_work";

export const START_WORK_LABEL = "Starting a Quest";
export const FINISH_WORK_LABEL = "Finishing a Quest";

export const START_WORK_DESCRIPTION = `Start a Quest for big work you were asked to do in this conversation: work that takes many turns, makes something to review, or should be followed on its own. Small work stays a plain reply. Hobbots shows the Quest as a card here, with its goal and "Done when" lines. A conversation runs one Quest at a time. Bring another hob in by mentioning it in your reply.`;

export const FINISH_WORK_DESCRIPTION =
  'Finish the Quest you run in this conversation once its "Done when" lines hold: say in short what was delivered and list what the work made. The person who asked reviews it. Never finish a Quest whose work is not done; ask in the conversation instead.';

const text = (description: string, max: number) =>
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(max)).annotate({ description });

export const StartWorkInput = Schema.Struct({
  title: text(`What the work is, in a few words, at most ${WORK_QUEST_TITLE_MAX} characters.`, WORK_QUEST_TITLE_MAX),
  goal: text(
    `What the work is for, in one or two sentences, at most ${WORK_QUEST_GOAL_MAX} characters.`,
    WORK_QUEST_GOAL_MAX,
  ),
  done_when: Schema.Array(text("One plain line that must hold for the work to be done.", WORK_QUEST_LINE_MAX))
    .check(Schema.isMinLength(1), Schema.isMaxLength(WORK_QUEST_DONE_WHEN_MAX))
    .annotate({
      description: `The "Done when" lines: from 1 to ${WORK_QUEST_DONE_WHEN_MAX} plain lines that say when the work is done, such as "The page is live".`,
    }),
  expected_by: Schema.optionalKey(
    Schema.String.annotate({
      description: "The day the work is expected by, written YYYY-MM-DD, only when the person gave one.",
    }),
  ),
  repository: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(1_000)).annotate({
      description: "For work on code: the repository it is in, as one of your folders. Leave it out otherwise.",
    }),
  ),
});
export type StartWorkInput = typeof StartWorkInput.Type;

export const FinishWorkInput = Schema.Struct({
  result: text(`What was delivered, in short, at most ${WORK_QUEST_RESULT_MAX} characters.`, WORK_QUEST_RESULT_MAX),
  made: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(1_000)))
      .check(Schema.isMaxLength(WORK_QUEST_MADE_MAX))
      .annotate({
        description: `What the work made, such as a pull request's link or a file's path, at most ${WORK_QUEST_MADE_MAX}.`,
      }),
  ),
});
export type FinishWorkInput = typeof FinishWorkInput.Type;

export const startWorkJsonSchema = (): Record<string, unknown> => toolInputJsonSchema(StartWorkInput);
export const finishWorkJsonSchema = (): Record<string, unknown> => toolInputJsonSchema(FinishWorkInput);
