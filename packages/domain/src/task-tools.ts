import { Schema } from "effect";
import { PolicyOverrides } from "./policy.ts";
import { ArtifactKind, type Quest, TaskRefusal, WaitMode } from "./quest.ts";
import { ancestorsOf, type Task } from "./task.ts";

/**
 * The Hobbots tools a hob plans, delegates, reports, asks and hands off with (ADR 018). The runtime
 * offers them over its control channel; the hub checks every call, so what a hob writes decides
 * nothing. Inputs use the names the model sees.
 */

const text = (description: string) => Schema.String.check(Schema.isNonEmpty()).annotate({ description });
const id = (description: string) => Schema.String.check(Schema.isNonEmpty()).annotate({ description });

/** Every call carries a key, so a retried call returns the first result and is done once. */
const key = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)).annotate({
  description:
    "A key you choose for this call, unique among your calls. Send the same key when you retry the same call, so it is done once.",
});

const taskId = Schema.optionalKey(id("The Task to act on. Leave it out to act on the Task you are working on."));

const milestones = Schema.optionalKey(
  Schema.Array(text("A point to report when it is reached")).annotate({
    description: "Milestones the Task's owner reports as it reaches them, in order.",
  }),
);

const Step = Schema.Struct({
  brief: text("What this step does and what it returns, in a few sentences. The step starts from this brief alone."),
  milestones,
  after: Schema.optionalKey(
    Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))).annotate({
      description: "Numbers of earlier steps in this plan (from 1) that must complete before this one.",
    }),
  ),
});

/** The authority a lead gives a member. It can only narrow what the lead has, never widen it. */
const Authority = Schema.Struct({
  decisions: Schema.optionalKey(
    PolicyOverrides.annotate({
      description: "allow, ask or deny for each operation. Each must be at least as narrow as your own.",
    }),
  ),
  folders: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: "Absolute folders the member may use, each one of yours or inside one. Leave out for all of yours.",
    }),
  ),
});

export const TaskToolInputs = {
  plan_steps: Schema.Struct({
    key,
    task_id: taskId,
    steps: Schema.Array(Step).check(Schema.isMinLength(1)),
  }),
  start_quest: Schema.Struct({
    key,
    task_id: taskId,
    goal: text("What the Quest must achieve."),
    acceptance: Schema.optionalKey(Schema.Array(text("A condition that must hold for the Quest to be done"))),
    max_depth: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "How many Quests deep its work may nest. It cannot exceed the limit above it.",
      }),
    ),
    deadline: Schema.optionalKey(
      Schema.String.annotate({
        description: "When its work must be done, ISO 8601. It cannot be later than the one above it.",
      }),
    ),
  }),
  delegate_task: Schema.Struct({
    key,
    task_id: taskId,
    hob: text("The name or id of the hob to give the Task to."),
    brief: text("What the hob must do and what it returns."),
    expected_output: Schema.optionalKey(text("What you expect back.")),
    milestones,
    depends_on: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description: "Ids of Tasks under the same Task that must complete before this one.",
      }),
    ),
    authority: Schema.optionalKey(Authority),
    timeout_minutes: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "How long the hob has. It cannot be longer than the time you were given.",
      }),
    ),
  }),
  report_checkpoint: Schema.Struct({
    key,
    task_id: taskId,
    kind: Schema.Literals(["milestone", "finding", "blocker", "progress"]).annotate({
      description:
        "milestone: a planned milestone was reached. finding: something that may change the plan. blocker: something you cannot get past. progress: routine progress.",
    }),
    summary: text("Where the Task stands, in a sentence or two."),
    milestone_id: Schema.optionalKey(id("The milestone reached, for a milestone checkpoint.")),
  }),
  ask: Schema.Struct({
    key,
    task_id: taskId,
    question: text("The question. It goes to your nearest lead, or to the user when you have none."),
  }),
  answer: Schema.Struct({
    key,
    question_id: id("The question you were asked."),
    answer: text("Your answer. It goes back to the hob that asked."),
  }),
  escalate: Schema.Struct({
    key,
    question_id: id("A question you were asked and cannot answer. It goes to the next lead up, or to the user."),
  }),
  hand_off: Schema.Struct({
    key,
    artifact_id: id("An artifact a Task in your Quest made."),
    to_task_id: id("The Task in your Quest that receives it as context."),
  }),
  wait_for: Schema.Struct({
    key,
    task_id: taskId,
    tasks: Schema.Array(Schema.String)
      .check(Schema.isMinLength(1))
      .annotate({ description: "Ids of Tasks under yours to wait for: steps or members' Tasks." }),
    mode: Schema.optionalKey(
      WaitMode.annotate({
        description: "any: until one of them ends. all: until every one has ended (the default).",
      }),
    ),
  }),
  complete_task: Schema.Struct({
    key,
    task_id: taskId,
    summary: text("The result, in a few sentences."),
    artifacts: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          kind: ArtifactKind,
          label: text("A short name for it."),
          value: text("A file's absolute path, a link, or the text itself."),
        }),
      ),
    ),
  }),
  cancel_task: Schema.Struct({
    key,
    task_id: id("A Task under one of yours to cancel, with everything under it."),
  }),
};

export type TaskToolName = keyof typeof TaskToolInputs;
export type TaskToolInput<T extends TaskToolName> = (typeof TaskToolInputs)[T]["Type"];

/** The tools, in the order a runtime offers them, with what each does as the model reads it. */
export const TASK_TOOLS: ReadonlyArray<{
  readonly name: TaskToolName;
  readonly description: string;
  /** Short words for the step a call shows in the reply. */
  readonly label: string;
}> = [
  {
    name: "plan_steps",
    description:
      "Split a Task you own into steps. Each step runs in a fresh session from its brief and returns a checkpoint and a result, so your own context stays small. Steps never bring in another hob.",
    label: "Planning steps",
  },
  {
    name: "start_quest",
    description:
      "Turn a Task you own into a Quest with a goal, acceptance and limits, before you bring in other hobs. delegate_task does this for you on its first call.",
    label: "Starting a Quest",
  },
  {
    name: "delegate_task",
    description:
      "Give another hob a Task under one you own, with a brief, milestones and dependencies. You become its lead. Its authority is yours narrowed by what you pass, never wider.",
    label: "Delegating a Task",
  },
  {
    name: "report_checkpoint",
    description:
      "Report where a Task you own stands: a planned milestone, a finding that may change the plan, a blocker, or routine progress. Routine progress never wakes your lead.",
    label: "Reporting a checkpoint",
  },
  {
    name: "ask",
    description:
      "Ask a question about a Task you own. It goes to your nearest lead, who answers or passes it up; it reaches the user only when no lead can answer.",
    label: "Asking a question",
  },
  {
    name: "answer",
    description: "Answer a question a hob under you asked. The answer goes back to the hob that asked.",
    label: "Answering a question",
  },
  {
    name: "escalate",
    description: "Pass a question you cannot answer to the next lead up, or to the user when you are the top lead.",
    label: "Escalating a question",
  },
  {
    name: "hand_off",
    description:
      "Give an artifact one Task under you made to another Task under you, as context for its brief. Members never message each other; results move only this way.",
    label: "Handing off a result",
  },
  {
    name: "wait_for",
    description:
      "Wait for any or all of the Tasks under one you own. Your Task shows as waiting; you can keep answering in the meantime.",
    label: "Waiting on Tasks",
  },
  {
    name: "complete_task",
    description:
      "Return the result of a Task you own. It completes only when everything under it has ended, its dependencies completed and its questions are answered.",
    label: "Completing the Task",
  },
  {
    name: "cancel_task",
    description: "Cancel a Task under one you own, with everything under it.",
    label: "Cancelling a Task",
  },
];

export const isTaskToolName = (name: string): name is TaskToolName => Object.hasOwn(TaskToolInputs, name);

/** The JSON Schema a runtime advertises for a tool's input. */
export const taskToolJsonSchema = (name: TaskToolName): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(TaskToolInputs[name]);
  const definitions = Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {};
  return { ...document.schema, ...definitions };
};

/** Why the hub refused a tool call, beyond the records' own invariants (`TaskRefusal`). */
export const TaskToolRefusal = Schema.Literals([
  ...TaskRefusal.literals,
  "unknown-tool",
  "invalid-input",
  "not-owner",
  "not-lead",
  "outside-subtree",
  "hob-missing",
  "own-hob",
  "cycle",
  "depth-limit",
  "concurrency-limit",
  "authority-wider",
  "deadline-passed",
  "key-reused",
  "no-attempt",
  "task-state",
]);
export type TaskToolRefusal = typeof TaskToolRefusal.Type;

/** A call the hub refused, with a reason the hob can act on. Nothing was written. */
export class TaskToolRefused extends Schema.TaggedError<TaskToolRefused>()("TaskToolRefused", {
  reason: TaskToolRefusal,
  message: Schema.String,
}) {}

/** What a call did: a sentence for the hob and the ids it made or changed. Stored, so a retry returns it again. */
export const TaskToolDone = Schema.Struct({
  message: Schema.String,
  details: Schema.Record(Schema.String, Schema.Json),
});
export type TaskToolDone = typeof TaskToolDone.Type;

/** The text a hob reads back from a call. */
export const taskToolText = (outcome: TaskToolDone | TaskToolRefused): string =>
  outcome instanceof TaskToolRefused
    ? `Refused (${outcome.reason}): ${outcome.message}`
    : Object.keys(outcome.details).length === 0
      ? outcome.message
      : `${outcome.message}\n${JSON.stringify(outcome.details)}`;

/**
 * Where a Quest on `task` would sit: the nearest Quest above it, and its depth. Steps never add
 * depth, so a Quest on its lead's own step sits at that Quest's depth.
 */
export const questPlacement = (
  task: Task,
  tree: ReadonlyArray<Task>,
  quests: ReadonlyArray<Quest>,
): { readonly outer: Quest | null; readonly depth: number } => {
  const byTask = new Map(quests.map((quest) => [quest.taskId, quest]));
  const outer = ancestorsOf(task, tree)
    .map((each) => byTask.get(each.id))
    .find((quest) => quest !== undefined);
  if (outer === undefined) return { outer: null, depth: 1 };
  return { outer, depth: outer.leadId === task.ownerId ? outer.depth : outer.depth + 1 };
};

/** The Quests from `quest` up to its top one, `quest` first. */
export const questChain = (quest: Quest, quests: ReadonlyArray<Quest>): ReadonlyArray<Quest> => {
  const byId = new Map(quests.map((each) => [each.id, each]));
  const chain: Array<Quest> = [];
  for (let at: Quest | undefined = quest; at !== undefined && !chain.includes(at); ) {
    chain.push(at);
    at = at.parentQuestId === null ? undefined : byId.get(at.parentQuestId);
  }
  return chain;
};
