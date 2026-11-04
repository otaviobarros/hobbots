import type { ApprovalId } from "./approval.ts";
import type { MessageId } from "./ids.ts";
import { liveAttemptOn, pendingApprovalsOn, type TaskNote, type TaskTree } from "./quest.ts";
import { ancestorsOf, isTerminalTask, type Task } from "./task.ts";

/**
 * Where a note stands for the steer receipt that follows the chat message it came from (#900):
 * - `PickedUp`: a turn of its recipient picked it up, named by its reply or Attempt id.
 * - `Held`: its recipient's turn runs and reads only what it started with (ADR 019), or waits for
 *   you to decide an approval request (#701), so the note waits for that turn to end.
 * - `Sent`: it waits for its recipient's next turn, which it wakes.
 * - `Unread`: the work it went to ended before any turn picked it up.
 */
export type NoteReceipt =
  | { readonly _tag: "PickedUp"; readonly turnId: string; readonly at: string }
  | { readonly _tag: "Held"; readonly reason: "turn-running" }
  | { readonly _tag: "Held"; readonly reason: "approval-pending"; readonly approvalId: ApprovalId }
  | { readonly _tag: "Sent" }
  | { readonly _tag: "Unread" };

/** The Tasks a note's recipient holds it under: the note's own Task and those above it that the recipient owns. */
const holdersOf = (note: TaskNote, tree: TaskTree): ReadonlyArray<Task> => {
  const subject = tree.tasks.find((each) => each.id === note.taskId);
  if (subject === undefined) return [];
  return [subject, ...ancestorsOf(subject, tree.tasks)].filter((each) => each.ownerId === note.recipientId);
};

/** Where `note` stands in `tree`, the tree it was left in, as its receipt shows it. */
export const noteReceipt = (note: TaskNote, tree: TaskTree): NoteReceipt => {
  if (note.pickedUpBy !== null && note.pickedUpAt !== null) {
    return { _tag: "PickedUp", turnId: note.pickedUpBy, at: note.pickedUpAt };
  }
  const holders = holdersOf(note, tree);
  const live = holders.filter((each) => liveAttemptOn(each, tree));
  const approval = live.flatMap((each) => pendingApprovalsOn(tree, each.id))[0];
  if (approval !== undefined) return { _tag: "Held", reason: "approval-pending", approvalId: approval.id };
  if (live.length > 0) return { _tag: "Held", reason: "turn-running" };
  return holders.length > 0 && holders.every((each) => isTerminalTask(each.state))
    ? { _tag: "Unread" }
    : { _tag: "Sent" };
};

/** A note a chat message of yours was passed on as, where it stands, and the notes its recipient passed on in turn. */
export interface PassedNote {
  readonly note: TaskNote;
  readonly receipt: NoteReceipt;
  readonly passedOn: ReadonlyArray<PassedNote>;
}

/**
 * Where a chat message of yours went next (#900): the notes the lead's turn on it sent to its
 * members, oldest first, each with the notes a nested lead passed on from it. Empty when the lead
 * answered without passing anything on. The turn that read the message is the reply whose
 * `promptId` names it. `trees` are the thread's, as `readThreadTrees` gives them.
 */
export const steerReceipt = (trees: ReadonlyArray<TaskTree>, messageId: MessageId): ReadonlyArray<PassedNote> => {
  const traced = trees.flatMap((tree) =>
    tree.notes.filter((note) => note.messageId === messageId).map((note) => ({ note, tree })),
  );
  const passed = (from: TaskNote | null, seen: ReadonlySet<string>): ReadonlyArray<PassedNote> =>
    traced
      .filter(({ note }) => (from === null ? note.fromNoteId === null : note.fromNoteId === from.id))
      .filter(({ note }) => !seen.has(note.id))
      .map(({ note, tree }) => ({
        note,
        receipt: noteReceipt(note, tree),
        passedOn: passed(note, new Set([...seen, note.id])),
      }));
  return passed(null, new Set());
};
