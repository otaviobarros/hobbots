import { clip } from "@hobbots/agents";
import {
  ancestorsOf,
  type BackpackItem,
  isTerminalTask,
  type Question,
  type Task,
  type TaskTree,
} from "@hobbots/domain";

/**
 * What a step's fresh session and its owner's chat are told (ADR 018). A step sees only its brief
 * and what it refers to; the owner sees each step's state, checkpoints and result, never a step's
 * session.
 */

/** Longest text kept from one result or checkpoint, so a long one cannot fill a session. */
const SUMMARY_LIMIT = 600;
/** Longest brief kept when a chat prompt becomes a Task's brief. */
export const BRIEF_LIMIT = 2_000;
/** Longest result the hub keeps from a step's final reply when the step did not return one itself. */
export const RESULT_LIMIT = 4_000;

/** `text` trimmed and cut to `limit` characters, marked when it was cut. */
export const cut = (text: string, limit: number): string => clip(text.trim(), limit);

const firstLine = (text: string) => cut(text.split("\n")[0] ?? "", 160);

/** The children of `task` in `tree`, oldest first. */
const childrenOf = (task: Task, tree: TaskTree) => tree.tasks.filter((each) => each.parentId === task.id);

/** A Task with the same owner as its parent: a step (ADR 018). */
export const isStep = (task: Task, tree: ReadonlyArray<Task>): boolean =>
  tree.some((each) => each.id === task.parentId && each.ownerId === task.ownerId);

/** Where `step` sits among its parent's steps, from 1, and how many there are. */
const stepPlace = (step: Task, tree: TaskTree): { readonly index: number; readonly total: number } => {
  const steps = tree.tasks.filter((each) => each.parentId === step.parentId && isStep(each, tree.tasks));
  return { index: steps.findIndex((each) => each.id === step.id) + 1, total: steps.length };
};

/** The Tasks `task` comes after that ended without completing, so it can never start. */
const endedBefore = (task: Task, tree: ReadonlyArray<Task>): ReadonlyArray<Task> =>
  task.dependsOn.flatMap((id) => {
    const before = tree.find((each) => each.id === id);
    return before !== undefined && isTerminalTask(before.state) && before.state !== "completed" ? [before] : [];
  });

const artifactLines = (tree: TaskTree, taskId: string) =>
  tree.artifacts
    .filter((artifact) => artifact.taskId === taskId)
    .map((artifact) => `  - ${artifact.label} (${artifact.kind}): ${cut(artifact.value, SUMMARY_LIMIT)}`);

/**
 * The prompt a step's fresh session starts from: its brief first, then the results of the steps it
 * comes after and anything handed to it, then how to report. Nothing else of the Task reaches it.
 */
export const stepPrompt = (step: Task, tree: TaskTree): string => {
  const { index, total } = stepPlace(step, tree);
  const before = step.dependsOn.flatMap((id) => {
    const done = tree.tasks.find((each) => each.id === id);
    if (done?.result == null) return [];
    const place = stepPlace(done, tree).index;
    return [`Step ${place} returned: ${cut(done.result.summary, SUMMARY_LIMIT)}`, ...artifactLines(tree, done.id)];
  });
  const handed = tree.handOffs.flatMap((handOff) => {
    if (handOff.toTaskId !== step.id) return [];
    const artifact = tree.artifacts.find((each) => each.id === handOff.artifactId);
    return artifact === undefined
      ? []
      : [`  - ${artifact.label} (${artifact.kind}): ${cut(artifact.value, SUMMARY_LIMIT)}`];
  });
  const milestones = tree.milestones
    .filter((milestone) => milestone.taskId === step.id && milestone.reachedAt === null)
    .map((milestone) => `  - ${milestone.title} (milestone_id ${milestone.id})`);
  return [
    step.brief,
    "---",
    `This is step ${index} of ${total} of a Task you own, running in a fresh session with only its brief and what it refers to.`,
    ...(before.length === 0 ? [] : ["What the steps before it returned:", ...before]),
    ...(handed.length === 0 ? [] : ["Handed to this step:", ...handed]),
    ...(milestones.length === 0
      ? []
      : ["Milestones to report with report_checkpoint as you reach them:", ...milestones]),
    `Report findings or blockers with report_checkpoint. When the step is done, call complete_task with its result; otherwise your final reply becomes its result. Task id: ${step.id}.`,
  ].join("\n");
};

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
const childLine = (child: Task, tree: TaskTree, place: string) => {
  const own = tree.checkpoints.filter((checkpoint) => checkpoint.taskId === child.id);
  const latest = own.filter((checkpoint) => checkpoint.kind !== "progress").at(-1) ?? own.at(-1);
  const stuck = child.state === "queued" && endedBefore(child, tree.tasks).length > 0;
  const outcome =
    child.result !== null
      ? ` Result: ${cut(child.result.summary, SUMMARY_LIMIT)}`
      : latest === undefined
        ? ""
        : ` Latest: ${latest.kind}, ${cut(latest.summary, SUMMARY_LIMIT)}`;
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
  const listed = new Map(briefedUnder(task, tree).map((each) => [each.task.id as string, each.task]));
  const answers = new Map(answeredFor(task, tree).map((question) => [question.id as string, question]));
  return ({ payload }) => {
    if (payload._tag === "answer") {
      const shown = answers.get(payload.question.id);
      return shown !== undefined && shown.revision >= payload.question.revision;
    }
    if (payload._tag !== "result" && payload._tag !== "failure") return false;
    const shown = listed.get(payload.task.id);
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

/**
 * What the owner's chat turn is told of the open Task it works on: the Task, and for each Task
 * under it, and under its own steps, its state, result or latest checkpoint. Transcripts never
 * reach it.
 */
export const ownerBriefing = (task: Task, tree: TaskTree): string => {
  const under = briefedUnder(task, tree);
  const above = ancestorsOf(task, tree.tasks).length;
  const answers = answeredFor(task, tree).map(
    (question) => `- ${cut(question.text, SUMMARY_LIMIT)} Answer: ${cut(question.answer ?? "", SUMMARY_LIMIT)}`,
  );
  return [
    `You are working on Task ${task.id} (${task.state}) for this conversation${above === 0 ? "" : ", under another Task"}: ${firstLine(task.brief)}`,
    ...(answers.length === 0 ? [] : ["Answers to the questions you asked about it:", ...answers]),
    ...(under.length === 0
      ? []
      : [
          "The work under it, each running in its own session, with what it reported:",
          ...under.flatMap(({ task: child, place }) => childLine(child, tree, place)),
          "Call complete_task with the Task's result once everything under it has ended.",
        ]),
  ].join("\n");
};
