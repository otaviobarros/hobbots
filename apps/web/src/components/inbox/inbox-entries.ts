import type { WaitingDevice, WaitingQuestion } from "@hobbots/api";
import {
  type AgentId,
  type ApprovalRequest,
  type BackpackBlocker,
  type BackpackItem,
  openBlocker,
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

export interface InboxGroup {
  /** The thread the group's entries are about, or null for this hub's devices. */
  readonly threadId: ThreadId | null;
  readonly entries: ReadonlyArray<InboxEntry>;
}

/** Entries grouped by thread, each group where its first entry falls, so the groups keep the list's order. */
export const groupByThread = (entries: ReadonlyArray<InboxEntry>): Array<InboxGroup> => {
  const groups = new Map<ThreadId | null, Array<InboxEntry>>();
  for (const entry of entries) {
    const threadId = entryThread(entry);
    const group = groups.get(threadId);
    if (group === undefined) groups.set(threadId, [entry]);
    else group.push(entry);
  }
  return Array.from(groups, ([threadId, grouped]) => ({ threadId, entries: grouped }));
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
  /** Who asked, as a chain from whoever started it: "You → Aldric → Ada". */
  readonly who: string;
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
    who: [copy.row.you, ...chain.map(names)].join(copy.row.arrow),
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
    who: [asker, ...question.chain.map(names), copy.row.youEnd].join(copy.row.arrow),
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
    who: chain.map(names).join(copy.row.arrow),
    kind: copy.kind.stuck,
    tag: "failed",
    what: blockerWhat(item),
    when: stuckWhen(item, blocker, name),
    tone: "stuck",
  };
};

const deviceRow = ({ request }: WaitingDevice, now: Date): InboxRow => ({
  who: [request.name, copy.row.youEnd].join(copy.row.arrow),
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
