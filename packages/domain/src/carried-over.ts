import { Schema } from "effect";
import { type BackpackItem, BackpackItemId } from "./backpack.ts";
import { ThreadId } from "./ids.ts";
import { type Question, QuestionId } from "./quest.ts";
import { type Task, TaskId } from "./task.ts";
import { Thread } from "./thread.ts";

/**
 * What Start fresh carries from a chat into the one that replaces it (ADR 037): the work it still
 * owes you. A Task you asked for there that is not over, a question in that work still waiting for an
 * answer, a reminder (a deadline item), and any other backpack item not yet handled.
 */
export const CarriedOverRef = Schema.Union([
  Schema.TaggedStruct("task", { taskId: TaskId }),
  Schema.TaggedStruct("question", { questionId: QuestionId }),
  Schema.TaggedStruct("reminder", { itemId: BackpackItemId }),
  Schema.TaggedStruct("backpack-item", { itemId: BackpackItemId }),
]);
export type CarriedOverRef = typeof CarriedOverRef.Type;

/** The longest label a carried item keeps. */
export const CARRIED_OVER_LABEL_MAX = 200;

/**
 * One thing Start fresh carried, written once with the change that moved it. `label` is what it
 * was about when it moved, as one line, so the new chat's first turn can name it.
 */
export class CarriedOver extends Schema.Class<CarriedOver>("CarriedOver")({
  fromThreadId: ThreadId,
  toThreadId: ThreadId,
  ref: CarriedOverRef,
  label: Schema.String,
  carriedAt: Schema.String,
}) {}

/** What Start fresh did: the chat as it left it, the new chat, and what it carried from one to the other. */
export class StartedFresh extends Schema.Class<StartedFresh>("StartedFresh")({
  superseded: Thread,
  chat: Thread,
  carried: Schema.Array(CarriedOver),
}) {}

/** The open work Start fresh finds in a chat, as it stands before it moves. */
export interface ChatWork {
  /** The Tasks you asked for in the chat that are not over yet. */
  readonly tasks: ReadonlyArray<Task>;
  /** Every Task in their trees, which an item's label names. */
  readonly trees: ReadonlyArray<Task>;
  /** The questions in their trees still waiting for an answer. */
  readonly questions: ReadonlyArray<Question>;
  /** The backpack items not resolved yet that the chat's turns carry, not a step's own session. */
  readonly items: ReadonlyArray<BackpackItem>;
}

const oneLine = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > CARRIED_OVER_LABEL_MAX ? `${line.slice(0, CARRIED_OVER_LABEL_MAX - 1).trimEnd()}…` : line;
};

const itemLabel = (item: BackpackItem, tasks: ReadonlyArray<Task>) => {
  if (item.payload._tag === "deadline") return `due ${item.payload.dueAt}`;
  const about = tasks.find((task) => task.id === item.taskId);
  return about === undefined ? item.kind : `${item.kind} about ${oneLine(about.brief)}`;
};

/**
 * A ref and its label, before Start fresh records it. A chat's Start fresh sheet lists these, so you
 * see what would come along before you choose it.
 */
export const CarriedOverEntry = Schema.Struct({ ref: CarriedOverRef, label: Schema.String });
export type CarriedOverEntry = typeof CarriedOverEntry.Type;

/**
 * What Start fresh records as carried, in a stable order: Tasks, questions, reminders, then other
 * items. Each thing appears once, however many lists name it.
 */
export const carriedOverFrom = (work: ChatWork): ReadonlyArray<CarriedOverEntry> => [
  ...work.tasks.map((task) => ({ ref: { _tag: "task", taskId: task.id } as const, label: oneLine(task.brief) })),
  ...work.questions.map((question) => ({
    ref: { _tag: "question", questionId: question.id } as const,
    label: oneLine(question.text),
  })),
  ...work.items.map((item) => ({
    ref:
      item.kind === "deadline"
        ? ({ _tag: "reminder", itemId: item.id } as const)
        : ({ _tag: "backpack-item", itemId: item.id } as const),
    label: itemLabel(item, work.trees),
  })),
];

/** The id a ref names, as the `carried_over` table keys it with its tag. */
export const carriedOverRefId = (ref: CarriedOverRef): string => {
  switch (ref._tag) {
    case "task":
      return ref.taskId;
    case "question":
      return ref.questionId;
    case "reminder":
    case "backpack-item":
      return ref.itemId;
  }
};

/**
 * What the new chat's first turn is told of what Start fresh carried, or null when nothing was.
 * Backpack items still arrive as the dispatcher delivers them; this only names them.
 */
export const carriedOverBriefing = (items: ReadonlyArray<CarriedOver>): string | null => {
  if (items.length === 0) return null;
  const line = (item: CarriedOver) => {
    switch (item.ref._tag) {
      case "task":
        return `- Open work: ${item.label} (Task ${item.ref.taskId})`;
      case "question":
        return `- A question still waiting for an answer: ${item.label}`;
      case "reminder":
        return `- A reminder, ${item.label}`;
      case "backpack-item":
        return `- Still to deal with: ${item.label}`;
    }
  };
  return [
    "This chat replaced an earlier one when the user chose Start fresh. It carries over what that chat still owed:",
    ...items.map(line),
    "What still waits for you arrives here as usual.",
  ].join("\n");
};
