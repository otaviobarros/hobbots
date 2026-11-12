import { Schema } from "effect";
import { ClaimScope } from "./claim.ts";
import { PolicyLayer } from "./policy.ts";
import {
  ArtifactKind,
  choicesProblem,
  MAX_QUESTION_OPTIONS,
  NoteDelivery,
  type Quest,
  TaskRefusal,
  WaitMode,
} from "./quest.ts";
import { ancestorsOf, type Task } from "./task.ts";

/**
 * The Hobbots tools a hob plans, delegates, reports, asks and hands off with (ADR 018). The runtime
 * offers them over its control channel; the hub checks every call, so what a hob writes decides
 * nothing. Inputs use the names the model sees.
 */

/**
 * About how many words a checkpoint's summary should take (#901): a lane shows each one as a short
 * beat. It is a request to the model, so a lane still cuts a longer one.
 */
export const CHECKPOINT_WORDS = 8;

/**
 * What a lead writes in the user's chat (#901): the plan when the work starts, a question no lead
 * can answer, and the finish. Briefings and tool descriptions carry the same words.
 */
export const LEAN_CHAT_RULE =
  "In the chat, write only the plan, a question no lead can answer and the finish; otherwise end your turn without a message, until the user writes.";

/**
 * Who approves an action (PE-006, #1216): only the user, on the approval request Hobbots makes when
 * a hob's policy asks first. A question about permission is not a request, and a lead's answer to
 * one approves nothing, so no hob asks another for permission, gives it or reports it given.
 * Briefings and tool descriptions carry the same words.
 */
export const APPROVAL_RULE =
  "Only the user approves an action. Never ask a hob for permission to make a tool call, give it or say one gave it: make the call, and Hobbots asks the user when your policy says to.";

/** What a lead's finish says (#901). */
export const FINISH_RULE = "The finish says in short what was made, where it is and who did what.";

const text = (description: string) => Schema.String.check(Schema.isNonEmpty()).annotate({ description });
const id = (description: string) => Schema.String.check(Schema.isNonEmpty()).annotate({ description });

/** Every call carries a key, so a retried call returns the first result and is done once. */
const key = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)).annotate({
  description:
    "A key you choose for this call, unique among your calls for this Task. Send the same key when you retry the same call, so it is done once. A key you used for earlier work is free to use again.",
});

const taskId = Schema.optionalKey(id("The Task to act on. Leave it out to act on the Task you are working on."));

/** A milestone's title: a few words, since a milestone's id is the hub's and never names a new one. */
const milestoneTitle = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^(?![0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$)/i, {
    message: 'A milestone is a short title, such as "Page renders", never the id of an existing milestone.',
  }),
).annotate({ description: 'A short title for a point to report when it is reached, such as "Page renders".' });

const milestones = Schema.optionalKey(
  Schema.Array(milestoneTitle).annotate({
    description:
      "Titles of new milestones the Task's owner reports as it reaches them, in order. A milestone that already exists on another Task is reported there, not named again here.",
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
    PolicyLayer.annotate({
      description:
        "allow, ask or deny for each operation, a built-in one by name or a Charm's by its id, such as github.comment. Each must be at least as narrow as your own. Commands, Git's included, need read-files and edit-files both allow.",
    }),
  ),
  folders: Schema.optionalKey(
    Schema.Union([Schema.Array(Schema.String), Schema.Literal("all")]).annotate({
      description:
        'Absolute folders the member may use, each one of yours or inside one, or "all" for all of yours. Leave out for the folders the brief names, else the folder your Task works in.',
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
    folders: Schema.optionalKey(
      Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
        description:
          "Absolute folders the Quest's work is in, each one of yours or inside one. Leave out for the folders the Task's brief and the goal name.",
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
        description: "Ids of Tasks under the same Task that must complete before this one starts.",
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
    summary: text(
      `Where the Task stands, in about ${CHECKPOINT_WORDS} words, like "Three headlines drafted". A lane shows it as one short beat and cuts anything longer.`,
    ),
    detail: Schema.optionalKey(
      text("More about it, only when the summary cannot hold what matters. The Workbench shows it; a lane never does."),
    ),
    milestone_id: Schema.optionalKey(id("The milestone reached, for a milestone checkpoint.")),
    reached_by: Schema.optionalKey(
      text(
        "For a milestone a lead above you reached, such as your lead making a commit you could not: that lead's name or id. Leave it out when your own work reached it, and when a member you gave a Task did: that work is your Task's own.",
      ),
    ),
  }),
  ask: Schema.Struct({
    key,
    task_id: taskId,
    question: text("The question. It goes to your nearest lead, or to the user when you have none."),
    options: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          label: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(80)).annotate({
            description: 'A short label for the choice, such as "Light".',
          }),
          consequence: Schema.String.check(Schema.isTrimmed(), Schema.isMaxLength(200)).annotate({
            description: "One line on what happens if it is picked.",
          }),
        }),
      )
        .check(Schema.isMinLength(2), Schema.isMaxLength(MAX_QUESTION_OPTIONS))
        .annotate({
          description: `When the answer is a choice, 2 to ${MAX_QUESTION_OPTIONS} choices to pick from. Whoever answers can still answer in words instead.`,
        }),
    ),
    recommended: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "The number of the choice you recommend, counted from 1, if you recommend one.",
      }),
    ),
  }).check(
    Schema.makeFilter(
      (input: { readonly options?: ReadonlyArray<{ readonly label: string }>; readonly recommended?: number }) =>
        choicesProblem(input.options, input.recommended, 1),
    ),
  ),
  answer: Schema.Struct({
    key,
    question_id: id("The question you were asked."),
    answer: text(
      "Your answer. It goes back to the hob that asked. To pick one of the question's choices, give its label.",
    ),
  }),
  escalate: Schema.Struct({
    key,
    question_id: id("A question you were asked and cannot answer. It goes to the next lead up, or to the user."),
  }),
  hand_off: Schema.Struct({
    key,
    artifact_id: id(
      'The id of an artifact a Task under you returned with complete_task, as your briefing ("artifact <id>") and read_tasks list it. Not a Task\'s id: a Task that returned no artifact has nothing to hand off.',
    ),
    to_task_id: id("The Task in your Quest that receives it as context."),
  }),
  wait_for: Schema.Struct({
    key,
    task_id: taskId,
    tasks: Schema.Array(Schema.String).check(Schema.isMinLength(1)).annotate({
      description:
        "Ids of Tasks under yours to wait for: the task_id plan_steps gave each step or delegate_task gave each member's Task. Never your own Task's id or a question's id: Hobbots wakes you with an answer without a wait.",
    }),
    mode: Schema.optionalKey(
      WaitMode.annotate({
        description: "any: until one of them ends. all: until every one has ended (the default).",
      }),
    ),
  }),
  read_tasks: Schema.Struct({
    key,
    task_id: Schema.optionalKey(
      id(
        "A Task you own, or one under it, to read everything under. Leave it out for the Task you are working on. Once that request has ended, you read only the last request you led in this conversation, and the Tasks under it.",
      ),
    ),
  }),
  message_task: Schema.Struct({
    key,
    task_id: id("A member's Task directly under one of yours."),
    text: text("What the member needs to know, in a sentence or two."),
    delivery: Schema.optionalKey(
      NoteDelivery.annotate({
        description:
          "How it reaches a member whose turn is running now. steer (the default): at the member's next step in that turn, between two tool calls, never inside one. interrupt: its turn stops at once and starts again with your message first; use it when what the member is doing now is wrong. next-turn: only once that turn ends. A member with no turn running gets it with its next turn whichever you pick.",
      }),
    ),
  }),
  complete_task: Schema.Struct({
    key,
    task_id: taskId,
    summary: text("The result, in a few sentences."),
    leave_uncommitted: Schema.optionalKey(
      text(
        "Why you leave the files you changed uncommitted. Only when you mean to: completing a Quest you lead with uncommitted changes is refused without it.",
      ),
    ),
    delivered: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "For a Quest you lead: true only when the result delivers everything the user asked for, where they asked for it. A file somewhere else is not delivered. Completing the Quest is refused without true: if something is missing, finish it, or ask the user what to do, and leave the Quest open.",
      }),
    ),
    artifacts: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          kind: ArtifactKind,
          label: text("A short name for it."),
          value: text(
            "A file's absolute path inside your folders, a link, or the text itself. Never a file in $TMPDIR, which is removed when your turn ends.",
          ),
        }),
      ),
    ),
  }),
  cancel_task: Schema.Struct({
    key,
    task_id: id("A Task under one of yours to cancel, with everything under it."),
  }),
  claim: Schema.Struct({
    key,
    task_id: taskId,
    scope: ClaimScope.annotate({
      description:
        "sequence: the next free number in a folder whose files start with one, such as migrations or ADRs, unique across every hob, chat and camp. path: a file or folder your Task changes. branch: a branch your Task works on.",
    }),
    folder: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "The absolute folder of the Git repository the claim is in, one of your folders or inside one. Leave it out for your first folder.",
      }),
    ),
    directory: Schema.optionalKey(
      text(
        "For a number: the folder inside the repository whose files the numbers count, relative to its top, such as packages/persistence/src/migrations or docs/decisions.",
      ),
    ),
    number: Schema.optionalKey(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description:
          "For a number you already use in your work: Hobbots keeps it when it is free, or gives you the next free one.",
      }),
    ),
    path: Schema.optionalKey(
      text("For a path: the file or folder, relative to the repository's top, such as packages/domain/src/claim.ts."),
    ),
    branch: Schema.optionalKey(text("For a branch: its name, such as feat/claims.")),
  }).check(
    Schema.makeFilter(
      (input: {
        readonly scope: ClaimScope;
        readonly directory?: string;
        readonly number?: number;
        readonly path?: string;
        readonly branch?: string;
      }) => claimInputProblem(input),
    ),
  ),
};

/** Why a `claim` call's input does not fit its scope, or undefined when it does. */
const claimInputProblem = (input: {
  readonly scope: ClaimScope;
  readonly directory?: string;
  readonly number?: number;
  readonly path?: string;
  readonly branch?: string;
}): string | undefined => {
  const given = (["directory", "number", "path", "branch"] as const).filter((field) => input[field] !== undefined);
  const wanted: ReadonlyArray<string> =
    input.scope === "path" ? ["path"] : input.scope === "branch" ? ["branch"] : ["directory", "number"];
  const extra = given.find((field) => !wanted.includes(field));
  if (extra !== undefined) return `A ${input.scope} claim takes no ${extra}.`;
  if (input.scope === "path" && input.path === undefined) return "A path claim needs the path.";
  if (input.scope === "branch" && input.branch === undefined) return "A branch claim needs the branch.";
  if (wanted.includes("directory") && input.directory === undefined) {
    return `A ${input.scope} claim needs the directory whose files the numbers count.`;
  }
  return undefined;
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
    description: `Give another hob a Task under one you own, with a brief, milestones and dependencies. You become its lead. Its authority is yours narrowed by what you pass, never wider. Never tell it to ask you before an action: the user approves what its policy asks first. ${LEAN_CHAT_RULE}`,
    label: "Delegating a Task",
  },
  {
    name: "report_checkpoint",
    description: `Report where a Task you own stands: a planned milestone, a finding that may change the plan, a blocker, or routine progress. Keep the summary to about ${CHECKPOINT_WORDS} words, like "Three headlines drafted"; put anything more in detail. Routine progress never wakes your lead.`,
    label: "Reporting a checkpoint",
  },
  {
    name: "ask",
    description:
      "Ask a question about a Task you own. It goes to your nearest lead, who answers or passes it up; it reaches the user only when no lead can answer. When the answer is a choice, give the choices as options, with the one you recommend, so the user can pick one with a click. Never ask for permission to make a tool call: make the call, and Hobbots asks the user when your policy says to.",
    label: "Asking a question",
  },
  {
    name: "answer",
    description: `Answer a question a hob under you asked. The answer goes back to the hob that asked. ${APPROVAL_RULE} So never answer a question that asks permission for a tool call: tell the hob to make the call and wait for the user's decision.`,
    label: "Answering a question",
  },
  {
    name: "escalate",
    description:
      "Pass a question you cannot answer to the next lead up, or to the user when you are the top lead. Always pass up a question about putting the user's work anywhere other than where they asked: that is theirs to decide.",
    label: "Escalating a question",
  },
  {
    name: "hand_off",
    description:
      "Give an artifact one Task under you made to another Task under you, as context for its brief. A Task already gets what the Tasks it depends on returned when it starts, so use this for anything else, or for a Task that is already running. Members never message each other.",
    label: "Handing off a result",
  },
  {
    name: "wait_for",
    description:
      "Record that a Task you own waits for any or all of the Tasks under it, then end your turn. It does not block: Hobbots wakes you when they end, or sooner when something arrives for you, such as a question. Your Task shows as waiting once your turn ends. Its result lists the questions and blockers they have open, so answer the questions that wait for you first. Call it once per wait, never again to check.",
    label: "Waiting on Tasks",
  },
  {
    name: "read_tasks",
    description:
      "Read where every Task under one of yours stands, at any depth, nested Quests included: its owner, state, whether a turn runs on it, what it waits on, its questions with their state and answer, its latest checkpoints, its result and the artifacts it returned, by the id hand_off takes. Read it instead of guessing, and before you tell anyone a question is unanswered; it changes nothing.",
    label: "Reading the work",
  },
  {
    name: "message_task",
    description:
      "Send a short message to a member's Task directly under one of yours, such as a correction or that an obstacle is gone. A member with no turn running gets it in its next turn, which it wakes. A member in a turn gets it at its next step in that turn by default, so a correction lands before it acts on more; pick interrupt to stop that turn and restart it with your message, or next-turn to wait for it to end. The result says when it reaches them. To reach a hob further down, message the member that leads it.",
    label: "Messaging a member",
  },
  {
    name: "complete_task",
    description: `Return the result of a Task you own. It completes only when everything under it has ended, its dependencies completed and its questions are answered. For the Task of a request in the user's chat: ${FINISH_RULE}`,
    label: "Completing the Task",
  },
  {
    name: "cancel_task",
    description: "Cancel a Task under one you own, with everything under it.",
    label: "Cancelling a Task",
  },
  {
    name: "claim",
    description:
      "Claim what your Task needs that other hobs' work could take too, before you use it. For a new numbered file, such as a migration or an ADR, fetch first, then ask for the next number in its folder: Hobbots gives the next one free on main, as your clone last fetched it, and in every other chat and camp, and never gives it to anyone else, so use the number it gives. Claim the files, folders or branch your Task changes: when another Task holds an open claim on the same one, both leads hear of it and neither Task is stopped. Claims end when your Task ends. In a conversation with no Task yet, it starts one for this request.",
    label: "Claiming",
  },
];

export const isTaskToolName = (name: string): name is TaskToolName => Object.hasOwn(TaskToolInputs, name);

/** The JSON Schema a runtime advertises for a tool's input. */
export const toolInputJsonSchema = (schema: Schema.Top): Record<string, unknown> => {
  const document = Schema.toJsonSchemaDocument(schema);
  const definitions = Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {};
  return { ...document.schema, ...definitions };
};

/** The JSON Schema a runtime advertises for a Task tool's input. */
export const taskToolJsonSchema = (name: TaskToolName): Record<string, unknown> =>
  toolInputJsonSchema(TaskToolInputs[name]);

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
  "authority-unusable",
  "deadline-passed",
  "key-reused",
  "no-attempt",
  "no-task",
  "task-state",
  "claim-stale",
  "uncommitted-changes",
  // A file the Task returns that no one could open once it completes, such as one in the turn's $TMPDIR.
  "artifact-unreachable",
  // A Quest's lead completing it without saying it delivered what the user asked for (#1181).
  "not-delivered",
  // A Quest's lead saying it delivered while nothing is where the user asked for it (#1215).
  "not-at-destination",
  // A question with choices about a file the user named and is not there, none worded to let it go (#1219).
  "destination-unworded",
  // A lead's answer that puts the user's work somewhere they did not name (#1219).
  "destination-theirs",
  // A Charm call, such as `git_init` or a GitHub write, the hub refused (#664): its message says why.
  "charm-refused",
  // A claim in a folder that is in no Git repository, or outside the hob's folders (ADR 037).
  "not-a-repository",
  // A claim made where the hub keeps no claims register.
  "no-register",
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
 * The Quests on `task` and on every Task above it, nearest first. It follows the Tasks, not each
 * Quest's parent, so a Quest started above another one later still counts.
 */
export const questsAbove = (
  task: Task,
  tree: ReadonlyArray<Task>,
  quests: ReadonlyArray<Quest>,
): ReadonlyArray<Quest> => {
  const byTask = new Map(quests.map((quest) => [quest.taskId, quest]));
  return [task, ...ancestorsOf(task, tree)].flatMap((each) => {
    const quest = byTask.get(each.id);
    return quest === undefined ? [] : [quest];
  });
};

/**
 * Where a Quest on `task` would sit: the nearest Quest above it, and its depth. Depth counts each
 * change of lead on the way down, from the Tasks as they are now, so a Quest started above
 * another one later still counts. Steps never add depth, so a Quest on its lead's own step sits at
 * that Quest's depth.
 */
export const questPlacement = (
  task: Task,
  tree: ReadonlyArray<Task>,
  quests: ReadonlyArray<Quest>,
): { readonly outer: Quest | null; readonly depth: number } => {
  const above = questsAbove(task, tree, quests).filter((quest) => quest.taskId !== task.id);
  const outer = above[0];
  if (outer === undefined) return { outer: null, depth: 1 };
  let depth = 1;
  above.reduceRight<string | null>((lead, quest) => {
    if (lead !== null && quest.leadId !== lead) depth += 1;
    return quest.leadId;
  }, null);
  return { outer, depth: outer.leadId === task.ownerId ? depth : depth + 1 };
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
