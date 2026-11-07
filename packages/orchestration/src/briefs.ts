import { clip } from "@hobbots/agents";
import {
  ancestorsOf,
  answerHow,
  type BackpackItem,
  CHECKPOINT_WORDS,
  CONTINUATION_HEADER,
  checkpointText,
  FINISH_RULE,
  handedFrom,
  isTerminalTask,
  LEAN_CHAT_RULE,
  type Question,
  type Task,
  TaskReadiness,
  type TaskTree,
} from "@hobbots/domain";
import { type BriefPart, fixed, renderBrief, rule } from "./brief-parts.ts";

/**
 * What a step's fresh session and its owner's chat are told (ADR 018). A step sees only its brief
 * and what it refers to; the owner sees each step's state, checkpoints and result, never a step's
 * session.
 */

/** Longest text the owner's briefing keeps from one result, checkpoint or artifact, so its own context stays small. */
const SUMMARY_LIMIT = 600;
/** Longest brief kept when a chat prompt becomes a Task's brief. */
export const BRIEF_LIMIT = 2_000;
/**
 * Longest result the hub keeps from a step's final reply when the step did not return one itself,
 * and the longest result or artifact a later step is given to work from.
 */
export const RESULT_LIMIT = 4_000;
/** Longest text a step is given from the steps it comes after and what was handed to it, all together. */
const STEP_INPUT_LIMIT = 16_000;

/**
 * How a hob keeps its checkpoints short (#901): a lane shows each summary as one beat, and the
 * Workbench shows the detail.
 */
export const CHECKPOINT_RULE = `Keep each checkpoint's summary to about ${CHECKPOINT_WORDS} words, like "Three headlines drafted", and put anything more in its detail.`;

/**
 * What a call that starts work in the user's chat adds to its result (#901): the lead delegates
 * first, since a smaller model took "the last thing you write this turn" as the end of the work
 * (#1081), then tells the user the plan once, and stays quiet. It stays short: it is in every result. Only the Task you asked for in a chat has one: any other, as a
 * member's, gets nothing.
 */
export const planNote = (task: Task): string =>
  task.parentId !== null || task.threadId === null
    ? ""
    : " Delegate first: writing the plan starts nothing. Then tell the user the plan in a line or two, who does what, after your tool calls. Then stay quiet until a question no lead can answer, or the finish.";

/** `text` trimmed and cut to `limit` characters, marked when it was cut. */
export const cut = (text: string, limit: number): string => clip(text.trim(), limit);

export const firstLine = (text: string) => cut(text.split("\n")[0] ?? "", 160);

/** The children of `task` in `tree`, oldest first. */
const childrenOf = (task: Task, tree: TaskTree) => tree.tasks.filter((each) => each.parentId === task.id);

/** A Task with the same owner as its parent: a step (ADR 018). */
const isStep = (task: Task, tree: ReadonlyArray<Task>): boolean =>
  tree.some((each) => each.id === task.parentId && each.ownerId === task.ownerId);

/** Where `step` sits among its parent's steps, from 1, and how many there are. */
const stepPlace = (step: Task, tree: TaskTree): { readonly index: number; readonly total: number } => {
  const steps = tree.tasks.filter((each) => each.parentId === step.parentId && isStep(each, tree.tasks));
  return { index: steps.findIndex((each) => each.id === step.id) + 1, total: steps.length };
};

/** An artifact as a line, its value cut to `limit`. */
const artifactLine = (artifact: TaskTree["artifacts"][number], limit: number) =>
  `  - ${artifact.label} (${artifact.kind}, artifact ${artifact.id}): ${cut(artifact.value, limit)}`;

/** The artifacts `taskId` made, cut to `limit`: short for the owner's briefing, whole for a step that builds on them. */
const artifactLines = (tree: TaskTree, taskId: string, limit = SUMMARY_LIMIT) =>
  tree.artifacts.filter((artifact) => artifact.taskId === taskId).map((artifact) => artifactLine(artifact, limit));

/**
 * The prompt a step's fresh session starts from: its brief first, then the results of the steps it
 * comes after and anything handed to it, then how to report. Nothing else of the Task reaches it.
 * The step works from what it is given, so each result and handed value is kept up to `RESULT_LIMIT`,
 * not cut to a summary, and all of them together up to `STEP_INPUT_LIMIT`, so many cannot fill its session.
 */
export const stepPrompt = (step: Task, tree: TaskTree): string => {
  const { index, total } = stepPlace(step, tree);
  const before = returnedBefore(step, tree, (done) => `Step ${stepPlace(done, tree).index}`);
  const handed = handedTo(step, tree);
  const inputs = [
    ...(before.length === 0 ? [] : ["What the steps before it returned:", ...before]),
    ...(handed.length === 0 ? [] : ["Handed to this step:", ...handed]),
  ];
  return [
    step.brief,
    "---",
    `This is step ${index} of ${total} of a Task you own, running in a fresh session with only its brief and what it refers to.`,
    ...(inputs.length === 0 ? [] : [cut(inputs.join("\n"), STEP_INPUT_LIMIT)]),
    ...milestonesToReport(step, tree),
    `Report findings or blockers with report_checkpoint. ${CHECKPOINT_RULE} If the work is already done or you cannot do it as briefed, report a finding or blocker and end without complete_task: the step then waits for its owner. When the step is done, call complete_task with its result; otherwise your final reply becomes its result. Task id: ${step.id}.`,
  ].join("\n");
};

/**
 * What each completed Task `task` comes after returned, named by `name`: its result and its
 * artifacts, each kept whole up to `RESULT_LIMIT`, so the work that builds on them has them.
 */
const returnedBefore = (task: Task, tree: TaskTree, name: (done: Task) => string): ReadonlyArray<string> =>
  task.dependsOn.flatMap((id) => {
    const done = tree.tasks.find((each) => each.id === id);
    if (done?.result == null) return [];
    return [
      `${name(done)} returned: ${cut(done.result.summary, RESULT_LIMIT)}`,
      ...artifactLines(tree, done.id, RESULT_LIMIT),
    ];
  });

/** What was handed to `task`, each value kept whole up to `RESULT_LIMIT`. */
const handedTo = (task: Task, tree: TaskTree): ReadonlyArray<string> =>
  tree.handOffs.flatMap((handOff) => {
    if (handOff.toTaskId !== task.id) return [];
    const artifact = tree.artifacts.find((each) => each.id === handOff.artifactId);
    return artifact === undefined ? [] : [artifactLine(artifact, RESULT_LIMIT)];
  });

/** The milestones of `task` not reached yet, as its session is asked to report them. */
const milestonesToReport = (task: Task, tree: TaskTree): ReadonlyArray<string> => {
  const open = tree.milestones
    .filter((milestone) => milestone.taskId === task.id && milestone.reachedAt === null)
    .map((milestone) => `  - ${milestone.title} (milestone_id ${milestone.id})`);
  return open.length === 0 ? [] : ["Milestones to report with report_checkpoint as you reach them:", ...open];
};

/**
 * How results move between the members of a Quest (ADR 018). Its lead and its members are told the
 * same words, so a lead never answers a member with a rule the hub does not follow.
 */
export const RESULTS_RULE =
  "A Task that comes after others starts once they have completed, and the hub gives it what they returned. Members never message each other: anything else one member made reaches another only when the lead calls hand_off.";

/** What the lead of a Quest is told in each turn on its Task, after the rule itself. */
const LEAD_DUTY =
  "So never hand a Task what the Tasks it comes after returned. Call hand_off when a member needs something else, or needs a result while it is already running.";

/**
 * What a turn on `task` is told when that Task leads a Quest: the rule, then the lead's duty. Both
 * the owner's chat turns and a member's later turns carry it, so a member that leads a nested Quest
 * hears it on every turn too.
 */
const leadGuidance = (task: Task, tree: TaskTree): ReadonlyArray<string> =>
  tree.quests.some((quest) => quest.taskId === task.id)
    ? [`You lead the Quest on this Task. ${RESULTS_RULE} ${LEAD_DUTY}`]
    : [];

/**
 * The prompt a party member's session starts from (ADR 018): the lead's brief first, then what the
 * lead expects back, what each Task it comes after returned and anything handed to it, then how to
 * report. The member works with its lead only: the hub gives it what the Tasks it comes after
 * returned, and anything else another member makes reaches it as a hand-off from its lead.
 */
export const memberPrompt = (task: Task, tree: TaskTree, lead: string): string => {
  const delegation = tree.delegations.find((each) => each.childTaskId === task.id);
  const before = returnedBefore(task, tree, (done) => `Task ${done.id} (${firstLine(done.brief)})`);
  const handed = handedTo(task, tree);
  const inputs = [
    ...(before.length === 0 ? [] : ["It came after these Tasks, which have completed. What they returned:", ...before]),
    ...(handed.length === 0 ? [] : ["Handed to this Task:", ...handed]),
  ];
  return [
    task.brief,
    "---",
    `${lead} gave you this Task as part of a Quest ${lead} leads. You work on it in your own session, and you deal only with ${lead}, never with the other hobs on the Quest.`,
    RESULTS_RULE,
    ...(delegation?.expectedOutput == null ? [] : [`${lead} expects back: ${delegation.expectedOutput}`]),
    ...(inputs.length === 0 ? [] : [cut(inputs.join("\n"), STEP_INPUT_LIMIT)]),
    ...milestonesToReport(task, tree),
    `Report findings or blockers with report_checkpoint, and ask ${lead} with ask. ${CHECKPOINT_RULE} When the Task is done, call complete_task with its result. Task id: ${task.id}.`,
  ].join("\n");
};

/**
 * The Tasks a member's work builds on: those its Task comes after, then those whose artifacts were
 * handed to it, once each, in that order.
 */
const buildsOn = (task: Task, tree: TaskTree): ReadonlyArray<Task> => {
  const ids = [...new Set([...task.dependsOn, ...handedFrom(tree, task.id)])];
  return ids.flatMap((id) => tree.tasks.filter((each) => each.id === id && each.id !== task.id));
};

/** Where a Task a member's work builds on stands now, with its result once it has one. */
const standingLine = (task: Task) =>
  `  - Task ${task.id} (${firstLine(task.brief)}), ${task.state}${task.result === null ? "" : `: ${cut(task.result.summary, SUMMARY_LIMIT)}`}`;

/**
 * What a later turn of a member's session is reminded of, after the work that arrived for it: its
 * Task, the lead's guidance when it leads a nested Quest, where each Task its work builds on stands now, read when the turn starts, and how to finish.
 * A session resumed after one of them completed so tells "done, and here is its result" from
 * "still running" without asking its lead. Each result is cut to `SUMMARY_LIMIT`, and the whole list
 * to `STEP_INPUT_LIMIT`.
 */
export const memberReminder = (task: Task, tree: TaskTree, lead: string): string => {
  const standing = buildsOn(task, tree).map(standingLine);
  return [
    `You work on Task ${task.id} for ${lead}.`,
    ...leadGuidance(task, tree),
    // Every later turn carries it, so all of it together stays within the step input limit; the
    // lines around it are never cut.
    ...(standing.length === 0
      ? []
      : [cut(["Where the Tasks your work builds on stand now:", ...standing].join("\n"), STEP_INPUT_LIMIT)]),
    MEMBER_FINISH,
  ].join("\n");
};

/** How a member's Task ends, as every later turn is reminded: only `complete_task` or a blocker ends it (#1086). */
const MEMBER_FINISH =
  "When it is done, call complete_task with its result. If you cannot finish it, report a blocker with report_checkpoint. A final reply alone does not complete it.";

/**
 * What a member's session is told when its turn ended in prose with nothing open (#1086): its reply
 * does not say whether the work is done, so it goes on once to say so with a tool. A second turn that
 * ends the same way blocks the Task, with its reply as the reason its lead reads.
 */
export const sendBackPrompt = (task: Task, lead: string): string =>
  [
    CONTINUATION_HEADER,
    `Your turn on Task ${task.id} ended without complete_task, so the Task is not done yet.`,
    "If the work is done, call complete_task now with its result.",
    "If it is not done, finish it and then call complete_task, or, if you cannot, report a blocker with report_checkpoint that says what stops you.",
    `If this turn also ends without either, the Task goes back to ${lead} as blocked, with your reply as the reason.`,
  ].join("\n");

/**
 * The Tasks the owner's briefing lists under `task`, depth first, each with its place (`1`, `1.2`):
 * its children, and under each one its owner runs itself, that one's children too, since their
 * results and failures come back to the same owner (ADR 019).
 */
const briefedUnder = (task: Task, tree: TaskTree): ReadonlyArray<{ readonly task: Task; readonly place: string }> => {
  const walk = (parent: Task, prefix: string): ReadonlyArray<{ readonly task: Task; readonly place: string }> =>
    childrenOf(parent, tree).flatMap((child, index) => {
      const place = `${prefix}${index + 1}`;
      return [{ task: child, place }, ...(child.ownerId === task.ownerId ? walk(child, `${place}.`) : [])];
    });
  return walk(task, "");
};

/**
 * One line for a Task under the owner's, indented by how deep it sits: its state, then its result
 * or its latest checkpoint, a reported one before routine progress.
 */
const childLine = (child: Task, tree: TaskTree, place: string, resultLimit = SUMMARY_LIMIT) => {
  const own = tree.checkpoints.filter((checkpoint) => checkpoint.taskId === child.id);
  const latest = own.filter((checkpoint) => checkpoint.kind !== "progress").at(-1) ?? own.at(-1);
  // Held by a Task it comes after that failed, was cancelled or is blocked: it waits for its owner.
  const stuck = child.state === "queued" && TaskReadiness.of(child, tree.tasks)._tag === "Blocked";
  const outcome =
    child.result !== null
      ? ` Result: ${cut(child.result.summary, resultLimit)}`
      : latest === undefined
        ? ""
        : ` Latest: ${latest.kind}, ${cut(checkpointText(latest, SUMMARY_LIMIT), 2 * SUMMARY_LIMIT)}`;
  const kind = isStep(child, tree.tasks) ? "Step" : "Task";
  const state = stuck ? "queued, but it cannot start because a Task it comes after did not complete" : child.state;
  const indent = "  ".repeat(place.split(".").length - 1);
  return [
    `${indent}${place}. ${kind} ${child.id}, ${state}: ${firstLine(child.brief)}.${outcome}`,
    ...artifactLines(tree, child.id).map((line) => `${indent}${line}`),
  ];
};

/** The questions the owner asked about `task` that have been answered, oldest first: its briefing shows them. */
const answeredFor = (task: Task, tree: TaskTree): ReadonlyArray<Question> =>
  tree.questions.filter(
    (question) => question.taskId === task.id && question.askerId === task.ownerId && question.state === "answered",
  );

/**
 * Whether the owner's briefing on `task`, made from `tree`, shows `item`: an answer it lists, or
 * the result or failure of a Task it lists as ended, at the version the item was recorded from or
 * later. The turn carries only what this holds for, so it never settles an item that reached the
 * backpack after the tree it was briefed from was read (ADR 019).
 */
export const briefingShows = (task: Task, tree: TaskTree): ((item: BackpackItem) => boolean) => {
  const outcomes = outcomeShows(briefedUnder(task, tree).map((each) => each.task));
  const answers = new Map(answeredFor(task, tree).map((question) => [question.id as string, question]));
  return (item) => {
    const { payload } = item;
    if (payload._tag === "answer") {
      const shown = answers.get(payload.question.id);
      return shown !== undefined && shown.revision >= payload.question.revision;
    }
    return outcomes(item);
  };
};

/**
 * Whether `item` is the result or failure of one of `listed` that has ended, at the version the
 * item was recorded from or later: what a briefing, or a tool result, that shows those Tasks as
 * they are tells of them (ADR 019).
 */
export const outcomeShows = (listed: ReadonlyArray<Task>): ((item: BackpackItem) => boolean) => {
  const byId = new Map(listed.map((each) => [each.id as string, each]));
  return ({ payload }) => {
    if (payload._tag !== "result" && payload._tag !== "failure") return false;
    const shown = byId.get(payload.task.id);
    return shown !== undefined && isTerminalTask(shown.state) && shown.revision >= payload.task.revision;
  };
};

/**
 * Whether a step's prompt, made from `tree`, shows `item`: the step's own Task item, or a hand-off
 * to it that the tree holds, so the prompt lists what was handed (ADR 019).
 */
export const stepPromptShows = (step: Task, tree: TaskTree): ((item: BackpackItem) => boolean) => {
  const handed = new Set(
    tree.handOffs
      .filter((handOff) => handOff.toTaskId === step.id)
      .filter((handOff) => tree.artifacts.some((artifact) => artifact.id === handOff.artifactId))
      .map((handOff) => handOff.artifactId as string),
  );
  return ({ payload }) =>
    (payload._tag === "task" && payload.task.id === step.id) ||
    (payload._tag === "hand-off" && payload.handOff.toTaskId === step.id && handed.has(payload.handOff.artifactId));
};

/** What the owner can do about a step that stopped on a finding or blocker, which holds the steps after it (#667). */
const STOPPED_STEP =
  "A blocked step stopped on a finding or blocker, and the steps after it wait for you. To go on, call complete_task on that step with the result the steps after it should work from; to change the plan, cancel it and the steps after it with cancel_task, then plan again.";

/**
 * What the owner's chat turn is told of the open Task it works on, as parts: the Task, and for each
 * Task under it, and under its own steps, its state, result or latest checkpoint, and when it leads a
 * Quest, how results move between its members, then what it writes in the chat: the plan, a
 * question no lead can answer and the finish, nothing between (#901). Transcripts never reach it.
 * The answers and the work under it are lists, so a resumed session is told only what changed in
 * them (#1027). The rules are told once a session, and again only once they change (#1039).
 * Each result is told here only: what arrives with a turn points to it (#1040).
 */
export const ownerBriefingParts = (
  task: Task,
  tree: TaskTree,
  /**
   * The Tasks whose results arrived with the turn (#1040). What arrived points to the briefing for
   * them, so their lines keep each result up to `RESULT_LIMIT` instead of a summary.
   */
  arrived: ReadonlySet<string> = new Set(),
): ReadonlyArray<BriefPart> => {
  const under = briefedUnder(task, tree);
  const above = ancestorsOf(task, tree.tasks).length;
  const answers = answeredFor(task, tree).map((question) => ({
    key: question.id,
    lines: [
      `- ${cut(question.text, SUMMARY_LIMIT)} Answer: ${cut(question.answer ?? "", SUMMARY_LIMIT)}${answerHow(question)}`,
    ],
  }));
  return [
    fixed(
      `You are working on Task ${task.id} (${task.state}) for this conversation${above === 0 ? "" : ", under another Task"}: ${firstLine(task.brief)}`,
    ),
    rule("lead", ...leadGuidance(task, tree)),
    { _tag: "Listed", group: "answer", heading: ["Answers to the questions you asked about it:"], entries: answers },
    ...(under.length === 0
      ? []
      : [
          {
            _tag: "Listed",
            group: "task",
            heading: ["The work under it, each running in its own session, with what it reported:"],
            entries: under.map(({ task: child, place }) => ({
              key: child.id,
              lines: childLine(child, tree, place),
              ...(child.result !== null &&
                arrived.has(child.id) && { shown: childLine(child, tree, place, RESULT_LIMIT) }),
            })),
          } satisfies BriefPart,
          rule(
            "stopped-step",
            ...(under.some(({ task: child }) => child.state === "blocked" && isStep(child, tree.tasks))
              ? [STOPPED_STEP]
              : []),
          ),
          rule("complete", "Call complete_task with the Task's result once everything under it has ended."),
        ]),
    rule("chat", LEAN_CHAT_RULE, FINISH_RULE),
  ];
};

/** The whole of what the owner's chat turn is told of the open Task, as a new session hears it. */
export const ownerBriefing = (task: Task, tree: TaskTree): string =>
  renderBrief(task.id, ownerBriefingParts(task, tree), null).text;
