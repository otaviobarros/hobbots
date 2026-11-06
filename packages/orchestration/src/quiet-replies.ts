import { isTerminalTask, type QuestionId, type TaskTree } from "@hobbots/domain";
import { Option } from "effect";

/**
 * What a lead's chat keeps while its Quest runs (ADR 027, #1006): the plan, a question no lead can
 * answer and the finish. A reply to work that arrived says what the room already shows, so the hub
 * keeps it out of the chat, whatever the lead wrote: the prompts ask it to stay quiet, and a real
 * run showed that a lead does not always do so.
 */

/** The questions in `tree` that climbed every lead and wait for you now. */
export const waitingForYou = (tree: Option.Option<TaskTree>): ReadonlyArray<QuestionId> =>
  Option.match(tree, {
    onNone: () => [],
    onSome: ({ questions }) =>
      questions.filter((question) => question.recipientId === null && question.state === "open").map((q) => q.id),
  });

/**
 * Whether a turn on work that arrived replied with routine progress: its Task leads a Quest that
 * still runs, and no question waits for you that did not before the turn. A Task that ended, by
 * the turn's finish or a cancel, keeps its reply, and so does a turn on work with no Quest.
 */
export const routineReply = (tree: Option.Option<TaskTree>, askedBefore: ReadonlyArray<QuestionId>): boolean => {
  if (Option.isNone(tree)) return false;
  const top = tree.value.tasks[0];
  if (top === undefined || isTerminalTask(top.state)) return false;
  const quest = tree.value.quests.find((each) => each.taskId === top.id);
  if (quest === undefined || quest.state !== "active") return false;
  const before = new Set(askedBefore);
  return waitingForYou(tree).every((id) => before.has(id));
};
