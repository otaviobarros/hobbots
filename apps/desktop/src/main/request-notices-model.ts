/**
 * Which system notifications the desktop app shows for requests waiting in the Inbox. Electron's
 * main process reads the hub's Inbox whenever the event stream says it changed, so this works with
 * no window open, and every read is compared with what is shown: a request decided anywhere,
 * missed events included, closes.
 */
import { exactAction, pairingDeferred } from "@hobbots/domain";
import { messages } from "./messages.ts";

const copy = messages.requestNotice;
const deviceCopy = messages.deviceNotice;
const questionCopy = messages.questionNotice;
const failedCopy = messages.failedNotice;
const finishedCopy = messages.finishedNotice;

/** A request waiting for the user, as the notification needs it. */
export interface PendingRequest {
  readonly id: string;
  readonly agentId: string;
  /** The exact action: the command, address or path the call was made with, or the step's words. */
  readonly action: string;
}

/** The pending requests in the hub's Inbox answer, or null when it is not one. */
export const pendingRequests = (body: unknown): ReadonlyArray<PendingRequest> | null => {
  if (!Array.isArray(body)) return null;
  return body.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const approval = item as Record<string, unknown>;
    if (approval.state !== "pending" || typeof approval.id !== "string" || typeof approval.agentId !== "string") {
      return [];
    }
    const args = typeof approval.arguments === "object" && approval.arguments !== null ? approval.arguments : {};
    const label = typeof approval.label === "string" ? approval.label : "";
    return [
      {
        id: approval.id,
        agentId: approval.agentId,
        action: exactAction({ arguments: args as Record<string, unknown>, label }),
      },
    ];
  });
};

export interface NoticeState {
  /** Requests already seen waiting; undefined until the first read, which announces nothing. */
  readonly known: ReadonlySet<string> | undefined;
  /** Requests with a notification showing. */
  readonly shown: ReadonlySet<string>;
}

/**
 * What one read of the Inbox changes: new requests to `show` while no Hobbots window is focused,
 * and notifications to `close` because their request no longer waits. The first read only learns
 * what already waits, so opening the app announces nothing, and a request that arrives while the
 * window is focused is never announced later.
 */
export const noticeChanges = <P extends { readonly id: string }>(
  state: NoticeState,
  pending: ReadonlyArray<P>,
  focused: boolean,
): {
  readonly show: ReadonlyArray<P>;
  readonly close: ReadonlyArray<string>;
  readonly known: ReadonlySet<string>;
} => {
  const waiting = new Set(pending.map((request) => request.id));
  const fresh = state.known === undefined ? [] : pending.filter((request) => !state.known?.has(request.id));
  return {
    show: focused ? [] : fresh,
    close: [...state.shown].filter((id) => !waiting.has(id)),
    // Only what still waits, so the set stays as small as the Inbox.
    known: waiting,
  };
};

/** Electron's notification docs say macOS truncates a notification past 256 bytes. */
const NOTICE_BYTES = 240;

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** `text` cut with an ellipsis to at most `room` bytes. */
const cutTo = (text: string, room: number) => {
  if (bytes(text) <= room) return text;
  let cut = "";
  for (const char of text) {
    if (bytes(`${cut}${char}…`) > room) break;
    cut += char;
  }
  return `${cut}…`;
};

/** A notification with `body` cut so that it and its title fit. */
const fitted = (title: string, body: string) => ({ title, body: cutTo(body, NOTICE_BYTES - bytes(title)) });

/** The notification for a request: who asks, or "A hob" while that is unknown, and the exact action, cut to fit. */
export const noticeText = (
  request: PendingRequest,
  name: string | undefined,
): { readonly title: string; readonly body: string } =>
  fitted(copy.title({ name: name ?? copy.unknownHob }), request.action);

/**
 * Where a notification about a Quest's work opens: the chat of the lead you talk to, at the Task it
 * is about, so the room opens with that lane lit (ADR 027).
 */
export interface TaskLink {
  readonly hobId: string;
  readonly threadId: string;
  readonly taskId: string;
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

const firstLine = (value: string) => value.split("\n", 1)[0]?.trim() ?? "";

/** The link to a Task in a lead's chat, or null when the work has no thread. */
const taskLink = (hobId: string | null, task: Record<string, unknown> | null): TaskLink | null => {
  const threadId = text(task?.threadId);
  const taskId = text(task?.id);
  return hobId === null || threadId === null || taskId === null ? null : { hobId, threadId, taskId };
};

/** A question that climbed every lead and waits for you, as its notification needs it. */
export interface WaitingQuestion {
  readonly id: string;
  /** The hob that asked, which the notification names, as the Inbox does. */
  readonly askerId: string;
  readonly text: string;
  readonly link: TaskLink | null;
}

/** The questions waiting for you in the hub's answer, or null when it is not one. */
export const waitingQuestions = (body: unknown): ReadonlyArray<WaitingQuestion> | null => {
  const items = record(body)?.questions;
  if (!Array.isArray(items)) return null;
  return items.flatMap((item: unknown) => {
    const question = record(record(item)?.question);
    const id = text(question?.id);
    const askerId = text(question?.askerId);
    const words = text(question?.text);
    if (id === null || askerId === null || words === null) return [];
    const chain = Array.isArray(question?.chain) ? question.chain : [];
    // The last lead it passed is the one whose chat it waits in.
    const lead = text(chain.at(-1)) ?? askerId;
    return [{ id, askerId, text: words, link: taskLink(lead, record(record(item)?.task)) }];
  });
};

/** The notification for a question: who asks, or "A hob", and the question, cut to fit. */
export const questionNoticeText = (question: WaitingQuestion, name: string | undefined) =>
  fitted(questionCopy.title({ name: name ?? copy.unknownHob }), question.text);

/** A party member's failed Task that waits on you, as its notification needs it. */
export interface FailedTask {
  readonly id: string;
  readonly ownerId: string;
  readonly brief: string;
  readonly link: TaskLink | null;
}

/** The failed Tasks in the hub's answer, or null when it is not one. */
export const failedTasks = (body: unknown): ReadonlyArray<FailedTask> | null => {
  const items = record(body)?.tasks;
  if (!Array.isArray(items)) return null;
  return items.flatMap((item: unknown) => {
    const task = record(record(item)?.task);
    const id = text(task?.id);
    const ownerId = text(task?.ownerId);
    if (id === null || ownerId === null) return [];
    return [
      { id, ownerId, brief: firstLine(text(task?.brief) ?? ""), link: taskLink(text(record(item)?.leadId), task) },
    ];
  });
};

/** The notification for a failed Task: whose it is, or "A hob", and the first line of its brief, cut to fit. */
export const failedNoticeText = (task: FailedTask, name: string | undefined) =>
  fitted(failedCopy.title({ name: name ?? copy.unknownHob }), task.brief);

/** A top Quest that finished, as its notification needs it. */
export interface FinishedQuest {
  readonly id: string;
  readonly goal: string;
  readonly leadId: string;
  readonly link: TaskLink | null;
}

/**
 * The Quest a `QuestCompleted` entry's payload ended, when it is a top Quest that completed: a
 * nested Quest's end is routine progress, and one that failed or was cancelled is not a finish.
 */
export const finishedQuest = (payload: unknown): FinishedQuest | null => {
  const quest = record(record(payload)?.quest);
  const id = text(quest?.id);
  const goal = text(quest?.goal);
  const leadId = text(quest?.leadId);
  if (id === null || goal === null || leadId === null) return null;
  if (quest?.state !== "completed" || quest.parentQuestId !== null) return null;
  return { id, goal: firstLine(goal), leadId, link: taskLink(leadId, { id: quest.taskId, threadId: quest.threadId }) };
};

/** The notification for a finished Quest: its goal is done, cut to fit, and whose chat has the finish. */
export const finishedNoticeText = (quest: FinishedQuest, name: string | undefined) => {
  const body = finishedCopy.body({ name: name ?? copy.unknownHob });
  const room = NOTICE_BYTES - bytes(body) - bytes(finishedCopy.title({ goal: "" }));
  return { title: finishedCopy.title({ goal: cutTo(quest.goal, room) }), body };
};

/** A device asking to pair, as its notification needs it (ADR 021). */
export interface PendingDevice {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  /** When the request runs out, so its notification closes then. */
  readonly expiresAt: string;
}

/**
 * The devices still waiting for an answer in the hub's pairing list, or null when it is not one. A
 * request put off with Decide later waits in Settings and is never announced.
 */
export const devicePairings = (body: unknown): ReadonlyArray<PendingDevice> | null => {
  if (!Array.isArray(body)) return null;
  return body.flatMap((item: unknown) => {
    const request = (item as { request?: Record<string, unknown> } | null)?.request;
    if (typeof request !== "object" || request === null || request.state !== "pending") return [];
    const { id, name, code, createdAt, expiresAt } = request;
    if (typeof id !== "string" || typeof name !== "string" || typeof code !== "string") return [];
    if (typeof createdAt !== "string" || typeof expiresAt !== "string") return [];
    if (pairingDeferred({ createdAt, expiresAt })) return [];
    return [{ id, name, code, expiresAt }];
  });
};

/** The notification for a device asking: its name, and the code to match, cut to fit. */
export const deviceNoticeText = (device: PendingDevice): { readonly title: string; readonly body: string } => {
  const code = device.code.length === 6 ? `${device.code.slice(0, 3)} ${device.code.slice(3)}` : device.code;
  const body = deviceCopy.body({ code });
  const room = NOTICE_BYTES - bytes(body);
  let name = "";
  for (const char of device.name) {
    if (bytes(deviceCopy.title({ name: `${name}${char}…` })) > room) {
      return { title: deviceCopy.title({ name: `${name}…` }), body };
    }
    name += char;
  }
  return { title: deviceCopy.title({ name }), body };
};
