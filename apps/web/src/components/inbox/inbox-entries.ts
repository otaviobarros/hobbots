import type { WaitingDevice, WaitingQuestion } from "@hobbots/api";
import {
  type AgentId,
  type ApprovalRequest,
  type BackpackBlocker,
  type BackpackItem,
  openBlocker,
  type Quest,
  type TaskId,
  type TaskTree,
  type ThreadId,
} from "@hobbots/domain";
import { firstLine } from "../../lib/format.ts";
import { blockerTries, blockerWhat } from "../blockers/blocker-model.ts";
import { expiryText, requestTitle, statusText } from "./inbox-items.ts";
import { messages } from "./messages.ts";

const copy = messages;

/**
 * One thing in the Inbox list. Every kind shows as the same row and opens beside the list: a
 * request to approve, a question no lead could answer, work that is stuck, or a device asking to
 * pair. `key` names it in the address: a request by its own id, so links from Home and the chat
 * still open it, and the other kinds by their kind and id.
 */
export type InboxEntry =
  | { readonly kind: "approval"; readonly key: string; readonly request: ApprovalRequest }
  | { readonly kind: "question"; readonly key: string; readonly waiting: WaitingQuestion }
  | { readonly kind: "stuck"; readonly key: string; readonly item: BackpackItem }
  | { readonly kind: "device"; readonly key: string; readonly device: WaitingDevice };

export const approvalEntry = (request: ApprovalRequest): InboxEntry => ({ kind: "approval", key: request.id, request });

export const questionEntry = (waiting: WaitingQuestion): InboxEntry => ({
  kind: "question",
  key: `question:${waiting.question.id}`,
  waiting,
});

export const stuckEntry = (item: BackpackItem): InboxEntry => ({ kind: "stuck", key: `stuck:${item.id}`, item });

export const deviceEntry = (device: WaitingDevice): InboxEntry => ({
  kind: "device",
  key: `device:${device.request.id}`,
  device,
});

/** Whether a key from the address names a request, which the Inbox can read on its own. */
export const namesRequest = (key: string): boolean => !key.includes(":");

/**
 * What Needs you lists, in one list: devices asking, questions for you, stuck work, then the
 * requests.
 */
export const needsEntries = ({
  devices,
  questions,
  blockers,
  requests,
}: {
  readonly devices: ReadonlyArray<WaitingDevice>;
  readonly questions: ReadonlyArray<WaitingQuestion>;
  readonly blockers: ReadonlyArray<BackpackItem>;
  readonly requests: ReadonlyArray<ApprovalRequest>;
}): Array<InboxEntry> => [
  ...devices.map(deviceEntry),
  ...questions.map(questionEntry),
  ...blockers.filter((item) => openBlocker(item) !== undefined).map(stuckEntry),
  ...requests.map(approvalEntry),
];

/** The thread an entry is about, or null for a device, which is about this hub. */
export const entryThread = (entry: InboxEntry): ThreadId | null => {
  switch (entry.kind) {
    case "approval":
      return entry.request.threadId;
    case "question":
      return entry.waiting.task.threadId;
    case "stuck":
      return entry.item.threadId;
    default:
      return null;
  }
};

/** The hob an entry comes from: the hob that asked, or whose work is stuck. None for a device. */
export const entryAsker = (entry: InboxEntry): AgentId | undefined => {
  switch (entry.kind) {
    case "approval":
      return entry.request.agentId;
    case "question":
      return entry.waiting.question.askerId;
    case "stuck":
      return entry.item.recipientId;
    default:
      return undefined;
  }
};

/** The Task an entry is about, when it is about one. */
const entryTask = (entry: InboxEntry): TaskId | null => {
  switch (entry.kind) {
    case "approval":
      return entry.request.taskId ?? entry.request.rootTaskId;
    case "question":
      return entry.waiting.task.id;
    case "stuck":
      return entry.item.taskId;
    default:
      return null;
  }
};

/**
 * The top Quest over each Task in `trees`: the outermost Quest on the path from the Task up to its
 * tree's top, which is what the Inbox groups by.
 */
export const topQuests = (trees: ReadonlyArray<TaskTree>): Map<TaskId, Quest> => {
  const found = new Map<TaskId, Quest>();
  for (const tree of trees) {
    const parents = new Map(tree.tasks.map((task) => [task.id, task.parentId]));
    const questOn = new Map(tree.quests.map((quest) => [quest.taskId, quest]));
    for (const task of tree.tasks) {
      let top: Quest | undefined;
      for (let at: TaskId | null | undefined = task.id; at != null; at = parents.get(at)) {
        top = questOn.get(at) ?? top;
      }
      if (top !== undefined) found.set(task.id, top);
    }
  }
  return found;
};

/** Where a group of entries belongs: a quest, a thread with no quest, or this hub for devices. */
export type InboxPlace =
  | { readonly kind: "quest"; readonly quest: Quest }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | { readonly kind: "hub" };

export interface InboxGroup {
  readonly key: string;
  readonly place: InboxPlace;
  readonly entries: ReadonlyArray<InboxEntry>;
}

/** The place an entry is listed under, from the top Quest over its Task when there is one. */
export const entryPlace = (entry: InboxEntry, questOf: (taskId: TaskId) => Quest | undefined): InboxPlace => {
  const taskId = entryTask(entry);
  const quest = taskId === null ? undefined : questOf(taskId);
  if (quest !== undefined) return { kind: "quest", quest };
  const threadId = entryThread(entry);
  return threadId === null ? { kind: "hub" } : { kind: "thread", threadId };
};

const placeKey = (place: InboxPlace): string => {
  if (place.kind === "quest") return `quest:${place.quest.id}`;
  return place.kind === "thread" ? `thread:${place.threadId}` : "hub";
};

/** Facts the urgency order reads from an entry. */
const urgency = (entry: InboxEntry) => {
  switch (entry.kind) {
    case "approval": {
      const pending = entry.request.state === "pending";
      return {
        closed: !pending,
        risky: pending && entry.request.onceOnly,
        expiresAt: pending ? entry.request.expiresAt : null,
        since: entry.request.createdAt,
      };
    }
    case "question":
      return { closed: false, risky: false, expiresAt: null, since: entry.waiting.question.createdAt };
    case "stuck":
      return {
        closed: false,
        risky: false,
        expiresAt: null,
        since: openBlocker(entry.item)?.raisedAt ?? entry.item.updatedAt,
      };
    default:
      return {
        closed: false,
        risky: false,
        expiresAt: entry.device.request.expiresAt,
        since: entry.device.request.createdAt,
      };
  }
};

/**
 * Most urgent first: high-risk requests, then what expires soonest, then what has waited longest.
 * A request already decided, kept in view while you look at it, goes last.
 */
export const byUrgency = (a: InboxEntry, b: InboxEntry): number => {
  const x = urgency(a);
  const y = urgency(b);
  if (x.closed !== y.closed) return x.closed ? 1 : -1;
  if (x.risky !== y.risky) return x.risky ? -1 : 1;
  if (x.expiresAt !== y.expiresAt) {
    if (x.expiresAt === null) return 1;
    if (y.expiresAt === null) return -1;
    return x.expiresAt < y.expiresAt ? -1 : 1;
  }
  if (x.since === y.since) return 0;
  return x.since < y.since ? -1 : 1;
};

/**
 * Entries grouped by quest, or by thread outside a quest, with this hub's devices apart. The most
 * urgent entry leads each group, and the group with the most urgent entry comes first.
 */
export const groupByPlace = (
  entries: ReadonlyArray<InboxEntry>,
  questOf: (taskId: TaskId) => Quest | undefined,
): Array<InboxGroup> => {
  const groups = new Map<string, { place: InboxPlace; entries: Array<InboxEntry> }>();
  for (const entry of [...entries].sort(byUrgency)) {
    const place = entryPlace(entry, questOf);
    const key = placeKey(place);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { place, entries: [entry] });
    else group.entries.push(entry);
  }
  return Array.from(groups, ([key, group]) => ({ key, ...group }));
};

/** The entry to show beside the list: the one the address names when the list has it, otherwise the first. */
export const selectedEntry = (entries: ReadonlyArray<InboxEntry>, key: string | undefined): InboxEntry | undefined =>
  entries.find((entry) => entry.key === key) ?? entries[0];

/** Names for the hobs an entry mentions. */
export type HobName = (agentId: AgentId) => string;

/** How loud the line under a row is: under an hour to answer, stuck, or neither. */
export type RowTone = "urgent" | "stuck" | "plain";

/** One row of the list, in words: who asked, the kind, what it is about, and when. */
export interface InboxRow {
  /** Who asked, as a chain from whoever started it: You, Aldric, Ada. */
  readonly chain: ReadonlyArray<string>;
  readonly kind: string;
  /** The tag's variant: the needs-you amber, stuck rose, or muted once a request is closed. */
  readonly tag: "needs-you" | "failed" | "muted";
  readonly what: string;
  readonly when: string;
  readonly tone: RowTone;
}

const HOUR = 60 * 60_000;

/** Whether `expiresAt` is under an hour away. */
const soon = (expiresAt: string | null, now: Date) =>
  expiresAt !== null && new Date(expiresAt).getTime() - now.getTime() < HOUR;

/** Upper-cases the first letter, for an expiry that starts a line: "Expires in 3 hours". */
const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const approvalRow = (request: ApprovalRequest, names: HobName, lead: AgentId | undefined, now: Date): InboxRow => {
  const pending = request.state === "pending";
  const chain = lead !== undefined && lead !== request.agentId ? [lead, request.agentId] : [request.agentId];
  const expiry = pending ? expiryText(request.expiresAt, now) : "";
  return {
    chain: [copy.row.you, ...chain.map(names)],
    kind: request.state === "expired" ? copy.kind.expired : copy.kind.approval,
    tag: pending ? "needs-you" : "muted",
    what: requestTitle(request).what,
    when: expiry === "" ? statusText(request, now) : sentence(expiry),
    tone: pending && soon(request.expiresAt, now) ? "urgent" : "plain",
  };
};

const questionRow = ({ question }: WaitingQuestion, names: HobName): InboxRow => {
  const asker = names(question.askerId);
  return {
    chain: [asker, ...question.chain.map(names), copy.row.youEnd],
    kind: copy.kind.question,
    tag: "needs-you",
    what: firstLine(question.text),
    when: copy.row.waitingOn({ name: asker }),
    tone: "plain",
  };
};

/** How the work got stuck, in a few words: "Stuck after 3 tries", or that its hob retired. */
const stuckWhen = (item: BackpackItem, blocker: BackpackBlocker | undefined, name: string) => {
  if (blocker === undefined) return copy.kind.stuck;
  if (blocker.reason === "recipient-retired") return copy.row.retired({ name });
  return copy.row.stuckAfter({ count: blockerTries(item, blocker) });
};

const stuckRow = (item: BackpackItem, names: HobName, lead: AgentId | undefined): InboxRow => {
  const blocker = openBlocker(item);
  const name = names(item.recipientId);
  const chain = lead !== undefined && lead !== item.recipientId ? [lead, item.recipientId] : [item.recipientId];
  return {
    chain: chain.map(names),
    kind: copy.kind.stuck,
    tag: "failed",
    what: blockerWhat(item),
    when: stuckWhen(item, blocker, name),
    tone: "stuck",
  };
};

const deviceRow = ({ request }: WaitingDevice, now: Date): InboxRow => ({
  chain: [request.name, copy.row.youEnd],
  kind: copy.kind.device,
  tag: "needs-you",
  what: copy.row.deviceAsks,
  when: sentence(expiryText(request.expiresAt, now)),
  tone: soon(request.expiresAt, now) ? "urgent" : "plain",
});

/**
 * An entry's row. `lead` is the hob whose chat the entry's thread is, when that is known: a party
 * member asks in its lead's thread, so the chain starts from that lead.
 */
export const entryRow = (entry: InboxEntry, names: HobName, lead: AgentId | undefined, now: Date): InboxRow => {
  switch (entry.kind) {
    case "approval":
      return approvalRow(entry.request, names, lead, now);
    case "question":
      return questionRow(entry.waiting, names);
    case "stuck":
      return stuckRow(entry.item, names, lead);
    default:
      return deviceRow(entry.device, now);
  }
};
