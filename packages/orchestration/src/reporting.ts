import { clip } from "@hobbots/agents";
import { descendantsOf, type Question, type Task, type TaskTree } from "@hobbots/domain";
import { type BriefPart, fixed, rule } from "./brief-parts.ts";

/** How much of a question its line in the briefing shows. */
const QUESTION_LIMIT = 300;

/** How many of the answered questions a lead passed up its briefing lists, the latest. */
const PASSED_UP_LIMIT = 10;

/** How a lead reports to the user (#569). */
const REPORT_RULE =
  "Tell the user only what your Task tools did in this turn: never say you sent, passed on, answered or started something unless a tool call here did it. Where the work stands, read it with read_tasks instead of guessing, or say you cannot see it.";

/** Who answered a question, as its line says. */
const answeredBy = (question: Question) =>
  question.answeredBy?._tag === "Lead" ? `by hob ${question.answeredBy.agentId}` : "by the user";

/**
 * What a lead's chat turn is told so it reports only what happened (#569). A lead told the user
 * "your answer is on its way" after the user's note, with no tool call and no way to pass it on.
 * So the briefing lists the questions under the Task that only the user can answer, says a note is
 * not an answer, and asks the lead to report only what its Task tools did and to read the work
 * instead of guessing. It also lists the questions the lead passed up that are answered since, so
 * it never reasons from one it believes still waits (#659). The questions passed up are a list, so a
 * resumed session is told only those answered since it was last told (#1027), and the rule on
 * reporting once, while no question waits for the user (#1039).
 */
export const reportingRules = (task: Task, tree: TaskTree): ReadonlyArray<BriefPart> => {
  const under = new Set<string>([task.id, ...descendantsOf(task, tree.tasks).map((each) => each.id)]);
  const asked = tree.questions.filter((question) => under.has(question.taskId));
  const line = (question: Question) =>
    `- Question ${question.id} from hob ${question.askerId} about Task ${question.taskId}: "${clip(question.text.trim(), QUESTION_LIMIT)}"`;
  const forTheUser = asked.filter((question) => question.state === "open" && question.recipientId === null);
  const passedUp = asked
    .filter((question) => question.state === "answered" && question.chain.includes(task.ownerId))
    .toSorted((a, b) => (a.answeredAt ?? "").localeCompare(b.answeredAt ?? ""));
  return [
    // Told on every turn, as a resumed session's too: a note from the user is no answer to them (#569).
    fixed(
      ...(forTheUser.length === 0
        ? []
        : [
            "Questions only the user can answer, waiting in the user's Inbox:",
            ...forTheUser.map(line),
            "You cannot answer these, and a note or message from the user is not an answer to them. If the user replies to one here, say it is still waiting and that they answer it in the Inbox or on its card.",
          ]),
    ),
    // A lead that passed a question up kept telling the user it was never answered (#659).
    {
      _tag: "Listed",
      group: "passed-up",
      heading: ["Questions you passed up that are answered, latest last; each answer goes back to the hob that asked:"],
      entries: passedUp.slice(-PASSED_UP_LIMIT).map((question) => ({
        key: question.id,
        lines: [
          `${line(question)} Answered ${answeredBy(question)}: "${clip((question.answer ?? "").trim(), QUESTION_LIMIT)}"`,
        ],
      })),
    },
    // A rule a resumed session told it before keeps (#1039), unless a question waits for the user:
    // then it comes with them on every turn, where a lead most needs it (#569).
    forTheUser.length === 0 ? rule("report", REPORT_RULE) : fixed(REPORT_RULE),
  ];
};
