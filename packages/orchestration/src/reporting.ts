import { clip } from "@hobbots/agents";
import { descendantsOf, type Task, type TaskTree } from "@hobbots/domain";

/** How much of a question its line in the briefing shows. */
const QUESTION_LIMIT = 300;

/**
 * What a lead's chat turn is told so it reports only what happened (#569). A lead told the user
 * "your answer is on its way" after the user's note, with no tool call and no way to pass it on.
 * So the briefing lists the questions under the Task that only the user can answer, says a note is
 * not an answer, and asks the lead to report only what its Task tools did and to read the work
 * instead of guessing.
 */
export const reportingRules = (task: Task, tree: TaskTree): ReadonlyArray<string> => {
  const under = new Set<string>([task.id, ...descendantsOf(task, tree.tasks).map((each) => each.id)]);
  const forTheUser = tree.questions.filter(
    (question) => question.state === "open" && question.recipientId === null && under.has(question.taskId),
  );
  const questions =
    forTheUser.length === 0
      ? []
      : [
          "Questions only the user can answer, waiting in the user's Inbox:",
          ...forTheUser.map(
            (question) =>
              `- Question ${question.id} from hob ${question.askerId} about Task ${question.taskId}: "${clip(question.text.trim(), QUESTION_LIMIT)}"`,
          ),
          "You cannot answer these, and a note or message from the user is not an answer to them. If the user replies to one here, say it is still waiting and that they answer it in the Inbox or on its card.",
        ];
  return [
    ...questions,
    "Tell the user only what your Task tools did in this turn: never say you sent, passed on, answered or started something unless a tool call here did it. Where the work stands, read it with read_tasks instead of guessing, or say you cannot see it.",
  ];
};
