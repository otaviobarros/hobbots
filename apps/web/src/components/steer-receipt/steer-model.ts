import {
  type AgentId,
  type ApprovalRequest,
  isInProgress,
  isTerminalTask,
  type Message,
  type PassedNote,
  steerReceipt,
  type TaskTree,
} from "@hobbots/domain";

/**
 * Where a note a lead passed on stands, as its hop in the receipt shows it (ADR 027):
 * - `passing`: it waits for its hob's next turn, or for the turn that runs to end.
 * - `held`: its hob's turn waits on you to decide `approval`, so the note waits too.
 * - `picked`: a turn of its hob picked it up.
 * - `unread`: the work it went to ended, or went to another hob, before any turn read it.
 */
type HopState = "passing" | "held" | "picked" | "unread";

/** One hob a note of yours reached, and the hobs it passed the note on to in turn. */
export interface ReceiptHop {
  readonly hob: AgentId;
  readonly state: HopState;
  /** The request the hob's turn waits on, while the note is held behind it. */
  readonly approval: ApprovalRequest | null;
  readonly passedOn: ReadonlyArray<ReceiptHop>;
}

/**
 * The steer receipt under a message you sent while work ran (ADR 027): the lead that reads it,
 * whether its turn on the message has read it, and the hobs it passed it on to.
 */
export interface SteerReceipt {
  readonly lead: AgentId;
  /** False while the lead's turn on your message runs and has passed nothing on yet. */
  readonly read: boolean;
  readonly hops: ReadonlyArray<ReceiptHop>;
}

const toHop = (passed: PassedNote, approvals: ReadonlyArray<ApprovalRequest>): ReceiptHop => {
  const { receipt, note } = passed;
  const approval =
    receipt._tag === "Held" && receipt.reason === "approval-pending"
      ? (approvals.find((each) => each.id === receipt.approvalId) ?? null)
      : null;
  const state: HopState =
    receipt._tag === "PickedUp"
      ? "picked"
      : receipt._tag === "Unread"
        ? "unread"
        : approval !== null
          ? "held"
          : "passing";
  return {
    hob: note.recipientId,
    state,
    approval,
    passedOn: passed.passedOn.map((each) => toHop(each, approvals)),
  };
};

/** Whether the work of `tree` was under way at `at`: its top Task had started and had not ended. */
export const runningAt = (tree: TaskTree, at: string): boolean => {
  const top = tree.tasks[0];
  if (top === undefined) return false;
  const when = Date.parse(at);
  if (Date.parse(top.createdAt) >= when) return false;
  return !isTerminalTask(top.state) || Date.parse(top.updatedAt) > when;
};

/** Whether the work of `tree` runs now. */
const runsNow = (tree: TaskTree): boolean => {
  const top = tree.tasks[0];
  return top !== undefined && !isTerminalTask(top.state);
};

/**
 * The receipt under `message`, or null when it gets none: it is not yours, it was not sent while
 * work in the thread ran, or the hub holds no record of the turn that read it, as for messages from
 * before receipts were recorded. Built from records only (#900), never from what the lead says:
 * the reply whose `promptId` names the message is the turn that read it, and the notes that trace
 * back to it are where it went next.
 */
export const steerReceiptOf = (
  message: Message,
  transcript: ReadonlyArray<Message>,
  trees: ReadonlyArray<TaskTree>,
  lead: AgentId,
): SteerReceipt | null => {
  if (message.role !== "user") return null;
  const passed = steerReceipt(trees, message.id);
  const during = trees.filter((tree) => runningAt(tree, message.createdAt));
  if (passed.length === 0 && during.length === 0) return null;
  const reply = transcript.find((each) => each.role === "assistant" && each.promptId === message.id);
  const answered = reply !== undefined && !isInProgress(reply.status);
  // With no reply on record, "reading" is true only while the work still runs.
  if (passed.length === 0 && reply === undefined && !during.some(runsNow)) return null;
  const approvals = trees.flatMap((tree) => tree.approvals);
  return { lead, read: answered || passed.length > 0, hops: passed.map((each) => toHop(each, approvals)) };
};

/**
 * One chip of your notes in a hob's lane (ADR 027):
 * - `yours`: a message you sent the lead while the work ran, in the lead's lane.
 * - `via`: a note of yours that reached this hob, passed on by `from`.
 * - `passed`: this hob passed your note on to `to`.
 */
export type NoteChip =
  | { readonly _tag: "yours"; readonly key: string; readonly at: string; readonly text: string }
  | { readonly _tag: "via"; readonly key: string; readonly at: string; readonly from: AgentId; readonly text: string }
  | { readonly _tag: "passed"; readonly key: string; readonly at: string; readonly to: ReadonlyArray<AgentId> };

/** The chips a note's hob shows, and those of the hobs it passed it on to, gathered by hob. */
const chipsFrom = (passed: PassedNote, from: AgentId, into: Map<AgentId, Array<NoteChip>>): void => {
  const { note } = passed;
  const own = into.get(note.recipientId) ?? [];
  own.push({ _tag: "via", key: `via-${note.id}`, at: note.createdAt, from, text: note.text });
  const next = passed.passedOn;
  const first = next[0];
  if (first !== undefined) {
    own.push({
      _tag: "passed",
      key: `passed-${note.id}`,
      at: first.note.createdAt,
      to: next.map((each) => each.note.recipientId),
    });
  }
  into.set(note.recipientId, own);
  for (const each of next) chipsFrom(each, note.recipientId, into);
};

/**
 * The note chips of every lane of `tree`, by hob, oldest first: each message of yours sent while
 * the work ran in the lead's lane, with whom the lead passed it to, and each note in the lane of the
 * hob it reached. Your messages are the thread's; notes come from the tree's records only.
 */
export const laneNoteChips = (
  tree: TaskTree,
  transcript: ReadonlyArray<Message>,
): ReadonlyMap<AgentId, ReadonlyArray<NoteChip>> => {
  const lead = tree.tasks[0]?.ownerId;
  const into = new Map<AgentId, Array<NoteChip>>();
  if (lead === undefined) return into;
  for (const message of transcript) {
    if (message.role !== "user") continue;
    const passed = steerReceipt([tree], message.id);
    if (passed.length === 0 && !runningAt(tree, message.createdAt)) continue;
    const own = into.get(lead) ?? [];
    own.push({ _tag: "yours", key: `yours-${message.id}`, at: message.createdAt, text: message.content });
    const first = passed[0];
    if (first !== undefined) {
      own.push({
        _tag: "passed",
        key: `passed-${message.id}`,
        at: first.note.createdAt,
        to: passed.map((each) => each.note.recipientId),
      });
    }
    into.set(lead, own);
    for (const each of passed) chipsFrom(each, lead, into);
  }
  for (const chips of into.values()) chips.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return into;
};
