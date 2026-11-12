import { type AgentId, isInProgress, isTerminalTask, type Message, type Task, type TaskTree } from "@hobbots/domain";
import { runningAt } from "../steer-receipt/steer-model.ts";

/**
 * A quest as a thread in its camp's sheet (ADR 037): what you asked, the lead's plan, the messages
 * you and the lead exchanged while it ran, the notes the lead gave its party and what each member
 * delivered or where it failed, in time order. Built from the hub's records and the thread's
 * transcript, never from what a hob says of its own state. A lead's routine progress, which the hub
 * keeps quiet (ADR 027), stays out, as it does in the chat.
 */
export type QuestEntry =
  /** A message of yours: the request that started the quest, or one you sent while it ran. */
  | { readonly kind: "yours"; readonly key: string; readonly at: string; readonly message: Message }
  /** The lead's reply: its plan, an answer to you, a question, or the finish. */
  | {
      readonly kind: "lead";
      readonly key: string;
      readonly at: string;
      readonly hob: AgentId;
      readonly message: Message;
    }
  /** A note a lead gave a member's Task. */
  | {
      readonly kind: "note";
      readonly key: string;
      readonly at: string;
      readonly from: AgentId;
      readonly to: AgentId;
      readonly text: string;
    }
  /** A member's Task delivered, with what it returned. */
  | { readonly kind: "done"; readonly key: string; readonly at: string; readonly task: Task; readonly text: string }
  /** A member's Task failed, and waits on its lead or on you. */
  | { readonly kind: "failed"; readonly key: string; readonly at: string; readonly task: Task };

/** How long after the quest ends its lead's finish may land and still be the quest's. */
const FINISH_GRACE_MS = 60_000;

/** Whether the lead's reply written at `at` belongs to the quest: under way, or its finish as it ended. */
const leadWroteIn = (tree: TaskTree, top: Task, at: string): boolean => {
  if (runningAt(tree, at)) return true;
  if (!isTerminalTask(top.state)) return false;
  const after = Date.parse(at) - Date.parse(top.updatedAt);
  return after >= 0 && after <= FINISH_GRACE_MS;
};

/** Your messages and the lead's replies that belong to the quest, from its chat's or camp's transcript. */
const fromTranscript = (tree: TaskTree, top: Task, transcript: ReadonlyArray<Message>): Array<QuestEntry> => {
  // The request that started it: your last message before its top Task, as its ticket sits under it.
  const request = transcript.findLast((message) => message.role === "user" && message.createdAt <= top.createdAt);
  const plan =
    request === undefined
      ? undefined
      : transcript.find((message) => message.role === "assistant" && message.promptId === request.id);
  const yours = (message: Message) =>
    message.role === "user" && (message === request || runningAt(tree, message.createdAt));
  // A reply still being written, with nothing in it yet, waits until it says something.
  const leads = (message: Message) =>
    message.role === "assistant" &&
    !message.quiet &&
    !(isInProgress(message.status) && message.content.trim() === "") &&
    (message === plan || leadWroteIn(tree, top, message.createdAt));
  return transcript.flatMap((message): Array<QuestEntry> => {
    if (yours(message)) return [{ kind: "yours", key: message.id, at: message.createdAt, message }];
    if (leads(message)) return [{ kind: "lead", key: message.id, at: message.createdAt, hob: top.ownerId, message }];
    return [];
  });
};

/** The notes the lead passed on, and each member Task's result or failure. */
const fromTree = (tree: TaskTree, top: Task): Array<QuestEntry> => [
  ...tree.notes.flatMap(
    (note): Array<QuestEntry> =>
      note.senderId == null
        ? []
        : [
            {
              kind: "note",
              key: note.id,
              at: note.createdAt,
              from: note.senderId,
              to: note.recipientId,
              text: note.text,
            },
          ],
  ),
  ...tree.tasks.flatMap((task): Array<QuestEntry> => {
    if (task.id === top.id) return [];
    if (task.state === "completed" && task.result !== null) {
      return [{ kind: "done", key: `done-${task.id}`, at: task.updatedAt, task, text: task.result.summary }];
    }
    return task.state === "failed" ? [{ kind: "failed", key: `failed-${task.id}`, at: task.updatedAt, task }] : [];
  }),
];

/** The quest's thread for `tree`, from the transcript of the chat or camp it belongs to. */
export const questThread = (tree: TaskTree, transcript: ReadonlyArray<Message>): ReadonlyArray<QuestEntry> => {
  const top = tree.tasks[0];
  if (top === undefined) return [];
  return [...fromTranscript(tree, top, transcript), ...fromTree(tree, top)].sort((a, b) => a.at.localeCompare(b.at));
};
